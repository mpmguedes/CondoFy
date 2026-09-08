const express = require('express');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const {
  Fracao,
  ContaBancaria,
  ExtraQuota,
  ExtraQuotaParcela,
  PagamentoExtraParcela,
  Pagamento,
  MovimentoBancario,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { toCents, fromCents } = require('../helpers/money');
const { MESES } = require('../helpers/dates');
const { distribuicaoExtra, parcelar, periodosVencimento } = require('../helpers/extra-quotas');
const extraEstado = require('../helpers/extra-quota-estado');
const pagamentosHelper = require('../helpers/pagamentos');
const recibosHelper = require('../helpers/recibos');

const router = express.Router();

// Isolamento: condomínio ativo (sessão validada) em todas as operações.
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('gestor'));

function parseDecimal(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function toDateInput(d) {
  const date = d instanceof Date ? d : new Date(d);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

const PERIODICIDADE_LABEL = {
  mensal: 'Mensal',
  bimestral: 'Bimestral',
  trimestral: 'Trimestral',
  semestral: 'Semestral',
  anual: 'Anual',
};

// Guarda uma quota extra do condomínio ativo (bloqueia IDOR).
function carregarExtra(req) {
  return ExtraQuota.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
}

// Guarda uma parcela cuja quota extra pertence ao condomínio ativo.
async function carregarParcela(req) {
  const parcela = await ExtraQuotaParcela.findByPk(req.params.id, {
    include: [{ model: ExtraQuota, as: 'extra_quota', where: { condominio_id: req.condominioId }, required: true }],
  });
  return parcela;
}

// Resumo agregado de uma quota extra (totais e parcelas por estado).
async function resumoExtra(extra) {
  const parcelas = await ExtraQuotaParcela.findAll({ where: { extra_quota_id: extra.id } });
  const totalC = toCents(extra.valor_total);
  const pagoC = parcelas.filter((p) => p.estado === 'paga').reduce((s, p) => s + toCents(p.valor), 0);
  const pendentes = parcelas.filter((p) => p.estado === 'pendente').length;
  const cobradas = parcelas.filter((p) => p.estado === 'cobrada').length;
  const pagas = parcelas.filter((p) => p.estado === 'paga').length;
  const anuladas = parcelas.filter((p) => p.estado === 'anulada').length;
  const nFracoes = new Set(parcelas.map((p) => p.fracao_id)).size;
  const ativas = parcelas.length - anuladas;
  return {
    total: fromCents(totalC),
    pago: fromCents(pagoC),
    emFalta: fromCents(totalC - pagoC),
    nParcelas: parcelas.length,
    pagas,
    cobradas,
    pendentes,
    anuladas,
    nFracoes,
    // Derivado: "Paga" quando existem parcelas e todas estão pagas.
    tudoPago: ativas > 0 && pagas === ativas,
  };
}

// ═══════════════════════════════════════════════════════════════════
// LISTA
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas-extra', async (req, res) => {
  const extras = await ExtraQuota.findAll({ where: { condominio_id: req.condominioId }, order: [['created_at', 'DESC']] });
  const linhas = [];
  for (const e of extras) {
    const r = await resumoExtra(e);
    linhas.push({ ...e.toJSON(), ...r, estadoLabel: extraEstado.ESTADOS_EXTRA[e.estado] || e.estado });
  }
  res.render('admin/quotas-extra/listar', {
    titulo: 'Quotas Extraordinárias',
    extras: linhas,
    periodicidadeLabel: PERIODICIDADE_LABEL,
    estadosLabel: extraEstado.ESTADOS_EXTRA,
  });
});

// ═══════════════════════════════════════════════════════════════════
// NOVA (estado inicial: pendente de aprovação)
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas-extra/nova', async (req, res) => {
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId }, order: [['designacao', 'ASC']] });
  const ano = new Date().getFullYear();
  res.render('admin/quotas-extra/form', {
    titulo: 'Nova quota extraordinária',
    extra: null,
    fracoes,
    meses: MESES,
    anoAtual: ano,
    mesAtual: new Date().getMonth() + 1,
    periodicidadeLabel: PERIODICIDADE_LABEL,
  });
});

router.post('/quotas-extra', async (req, res) => {
  const designacao = String(req.body.designacao || '').trim();
  const valorTotal = parseDecimal(req.body.valor_total);
  const metodo = req.body.metodo_divisao === 'igual' ? 'igual' : 'permilagem';
  const mesInicio = parseInt(req.body.mes_inicio, 10);
  const anoInicio = parseInt(req.body.ano_inicio, 10);
  const numeroParcelas = parseInt(req.body.numero_parcelas, 10);
  const periodicidade = ['mensal', 'bimestral', 'trimestral', 'semestral', 'anual'].includes(req.body.periodicidade)
    ? req.body.periodicidade
    : 'mensal';
  const fracaoIds = Array.isArray(req.body.fracoes) ? req.body.fracoes.map((x) => parseInt(x, 10)).filter(Number.isFinite) : [];

  if (!designacao) {
    req.flash('error_msg', 'Indique a designação da quota extraordinária.');
    return res.redirect('/admin/quotas-extra/nova');
  }
  if (valorTotal <= 0) {
    req.flash('error_msg', 'O valor total deve ser superior a zero.');
    return res.redirect('/admin/quotas-extra/nova');
  }
  if (!mesInicio || mesInicio < 1 || mesInicio > 12) {
    req.flash('error_msg', 'Indique um mês de início válido (1 a 12).');
    return res.redirect('/admin/quotas-extra/nova');
  }
  if (!anoInicio || anoInicio < 2000 || anoInicio > 2100) {
    req.flash('error_msg', 'Indique um ano de início válido.');
    return res.redirect('/admin/quotas-extra/nova');
  }
  if (!numeroParcelas || numeroParcelas < 1 || numeroParcelas > 60) {
    req.flash('error_msg', 'O número de parcelas deve estar entre 1 e 60.');
    return res.redirect('/admin/quotas-extra/nova');
  }
  if (fracaoIds.length === 0) {
    req.flash('error_msg', 'Selecione pelo menos uma fração.');
    return res.redirect('/admin/quotas-extra/nova');
  }

  const fracoes = await Fracao.findAll({ where: { id: { [Op.in]: fracaoIds }, estado: 'ativo', condominio_id: req.condominioId } });
  if (fracoes.length === 0) {
    req.flash('error_msg', 'Nenhuma fração selecionada está ativa neste condomínio.');
    return res.redirect('/admin/quotas-extra/nova');
  }

  const t = await sequelize.transaction();
  try {
    const extra = await ExtraQuota.create(
      {
        condominio_id: req.condominioId,
        designacao,
        valor_total: valorTotal,
        metodo_divisao: metodo,
        mes_inicio: mesInicio,
        ano_inicio: anoInicio,
        numero_parcelas: numeroParcelas,
        periodicidade,
        // Criada → fica PENDENTE de aprovação (nunca cobrável de imediato).
        estado: 'pendente',
      },
      { transaction: t }
    );

    // Distribui o total pelas frações e divide cada fração em parcelas iguais.
    const distribuicao = distribuicaoExtra(valorTotal, fracoes, metodo);
    const periodos = periodosVencimento(mesInicio, anoInicio, numeroParcelas, periodicidade);

    for (const d of distribuicao) {
      const valoresParcela = parcelar(d.valorC, numeroParcelas);
      for (let i = 0; i < numeroParcelas; i++) {
        await ExtraQuotaParcela.create(
          {
            extra_quota_id: extra.id,
            fracao_id: d.fracaoId,
            parcela_numero: i + 1,
            valor: fromCents(valoresParcela[i]),
            data_vencimento: toDateInput(periodos[i].dataVencimento),
            estado: 'pendente',
            valor_pago: 0,
          },
          { transaction: t }
        );
      }
    }

    await audit({
      userId: req.user.id,
      acao: 'criar_quota_extra',
      entidade: 'ExtraQuota',
      entidadeId: extra.id,
      detalhes: { designacao, valorTotal, metodo, numeroParcelas, nFracoes: fracoes.length },
    });

    await t.commit();
    req.flash('success_msg', 'Quota extraordinária criada — fica pendente de aprovação antes de poder ser cobrada.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  } catch (err) {
    await t.rollback();
    req.flash('error_msg', 'Erro ao criar a quota extraordinária.');
    return res.redirect('/admin/quotas-extra/nova');
  }
});

// ═══════════════════════════════════════════════════════════════════
// DETALHE
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas-extra/:id', async (req, res) => {
  const extra = await carregarExtra(req);
  if (!extra) return res.redirect('/admin/quotas-extra');

  const parcelas = await ExtraQuotaParcela.findAll({
    where: { extra_quota_id: extra.id },
    include: [{ model: Fracao, as: 'fracao' }],
    order: [['fracao_id', 'ASC'], ['parcela_numero', 'ASC']],
  });
  const contas = await ContaBancaria.findAll({ where: { ativa: true, condominio_id: req.condominioId }, order: [['nome', 'ASC']] });

  const porFracao = new Map();
  for (const p of parcelas) {
    const key = p.fracao_id;
    if (!porFracao.has(key)) {
      porFracao.set(key, { fracao: p.fracao, parcelas: [], total: 0, pago: 0 });
    }
    const grupo = porFracao.get(key);
    grupo.parcelas.push(p);
    grupo.total += toCents(p.valor);
    grupo.pago += p.estado === 'paga' ? toCents(p.valor) : 0;
  }

  const grupos = [...porFracao.values()].map((g) => ({
    ...g,
    total: fromCents(g.total),
    pago: fromCents(g.pago),
    emFalta: fromCents(g.total - g.pago),
  }));

  const resumo = await resumoExtra(extra);
  const hoje = new Date().toISOString().slice(0, 10);

  res.render('admin/quotas-extra/detalhe', {
    titulo: extra.designacao,
    extra,
    grupos,
    contas,
    resumo,
    periodicidadeLabel: PERIODICIDADE_LABEL,
    estadosLabel: extraEstado.ESTADOS_EXTRA,
    estadoLabel: extraEstado.ESTADOS_EXTRA[extra.estado] || extra.estado,
    // Regras de ação (backend/UI) — derivadas do estado atual.
    acoes: {
      podeEditar: extraEstado.podeEditar(extra.estado),
      podeAprovar: extraEstado.podeAprovar(extra.estado),
      podeProcessar: extraEstado.podeProcessar(extra.estado),
      podeAnular: extraEstado.podeAnular(extra.estado),
    },
    hoje,
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDITAR (apenas pendente — sem relevância financeira ainda)
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas-extra/:id/editar', async (req, res) => {
  const extra = await carregarExtra(req);
  if (!extra) return res.redirect('/admin/quotas-extra');
  if (!extraEstado.podeEditar(extra.estado)) {
    req.flash('error_msg', 'Apenas quotas extraordinárias pendentes de aprovação podem ser editadas.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }
  res.render('admin/quotas-extra/editar', {
    titulo: 'Editar quota extraordinária',
    extra,
    periodicidadeLabel: PERIODICIDADE_LABEL,
  });
});

router.post('/quotas-extra/:id', async (req, res) => {
  const extra = await carregarExtra(req);
  if (!extra) return res.redirect('/admin/quotas-extra');
  if (!extraEstado.podeEditar(extra.estado)) {
    req.flash('error_msg', 'Apenas quotas extraordinárias pendentes de aprovação podem ser editadas.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }
  const designacao = String(req.body.designacao || '').trim();
  if (!designacao) {
    req.flash('error_msg', 'Indique a designação da quota extraordinária.');
    return res.redirect(`/admin/quotas-extra/${extra.id}/editar`);
  }
  await extra.update({ designacao });
  await audit({ userId: req.user.id, acao: 'editar_quota_extra', entidade: 'ExtraQuota', entidadeId: extra.id });
  req.flash('success_msg', 'Quota extraordinária atualizada.');
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

// ═══════════════════════════════════════════════════════════════════
// APROVAR (pendente → aprovada) — registo de quem/quando
// ═══════════════════════════════════════════════════════════════════
router.post('/quotas-extra/:id/aprovar', async (req, res) => {
  const extra = await carregarExtra(req);
  if (!extra) return res.redirect('/admin/quotas-extra');
  if (!extraEstado.podeAprovar(extra.estado)) {
    req.flash('error_msg', 'Apenas quotas extraordinárias pendentes de aprovação podem ser aprovadas.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }
  await extra.update({
    estado: 'aprovada',
    aprovado_por: req.user.id,
    aprovado_em: new Date().toISOString().slice(0, 10),
  });
  await audit({ userId: req.user.id, acao: 'aprovar_quota_extra', entidade: 'ExtraQuota', entidadeId: extra.id });
  req.flash('success_msg', 'Quota extraordinária aprovada — agora pode ser processada para cobrança.');
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

// ═══════════════════════════════════════════════════════════════════
// PROCESSAR (aprovada → processada) — disponível para cobrança
// ═══════════════════════════════════════════════════════════════════
router.post('/quotas-extra/:id/processar', async (req, res) => {
  const extra = await carregarExtra(req);
  if (!extra) return res.redirect('/admin/quotas-extra');
  if (!extraEstado.podeProcessar(extra.estado)) {
    req.flash('error_msg', 'Apenas quotas extraordinárias aprovadas podem ser processadas.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }
  await extra.update({
    estado: 'processada',
    processado_por: req.user.id,
    processado_em: new Date().toISOString().slice(0, 10),
  });
  await audit({ userId: req.user.id, acao: 'processar_quota_extra', entidade: 'ExtraQuota', entidadeId: extra.id });
  req.flash('success_msg', 'Quota extraordinária processada — parcelas disponíveis para inclusão em avisos/pagamento.');
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

// ═══════════════════════════════════════════════════════════════════
// ANULAR — guardas: não anula o que já está anulado; parcelas pagas mantêm-se.
// ═══════════════════════════════════════════════════════════════════
router.post('/quotas-extra/:id/anular', async (req, res) => {
  const extra = await carregarExtra(req);
  if (!extra) return res.redirect('/admin/quotas-extra');
  if (!extraEstado.podeAnular(extra.estado)) {
    req.flash('error_msg', 'Esta quota extraordinária já está anulada.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }

  const t = await sequelize.transaction();
  try {
    await ExtraQuotaParcela.update(
      { estado: 'anulada' },
      { where: { extra_quota_id: extra.id, estado: { [Op.ne]: 'paga' } }, transaction: t }
    );
    await extra.update({ estado: 'anulada' }, { transaction: t });
    await audit({ userId: req.user.id, acao: 'anular_quota_extra', entidade: 'ExtraQuota', entidadeId: extra.id });
    await t.commit();
    req.flash('success_msg', 'Quota extraordinária anulada (parcelas pagas permanecem no histórico).');
  } catch (err) {
    await t.rollback();
    req.flash('error_msg', 'Erro ao anular a quota extraordinária.');
  }
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

// ═══════════════════════════════════════════════════════════════════
// PAGAR PARCELA — pagamento REAL (Pagamento + PagamentoExtraParcela)
// Regra: quota extra 'processada' e parcela 'pendente'/'cobrada'.
// ═══════════════════════════════════════════════════════════════════
router.post('/quotas-extra/parcelas/:id/pagar', async (req, res) => {
  const parcela = await carregarParcela(req);
  if (!parcela || !parcela.extra_quota) return res.redirect('/admin/quotas-extra');
  const extra = parcela.extra_quota;

  if (extra.estado !== 'processada') {
    req.flash('error_msg', 'A quota extra tem de estar aprovada e processada para poder ser paga.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }
  if (!['pendente', 'cobrada'].includes(parcela.estado)) {
    req.flash('error_msg', parcela.estado === 'paga' ? 'Parcela já está paga.' : 'Parcela anulada não pode ser paga.');
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }

  // Conta bancária tem de pertencer ao condomínio ativo (IDOR).
  const contaIdRaw = parseInt(req.body.conta_bancaria_id, 10) || null;
  let contaId = null;
  if (contaIdRaw) {
    const conta = await ContaBancaria.findOne({ where: { id: contaIdRaw, condominio_id: req.condominioId, ativa: true } });
    contaId = conta ? conta.id : null;
  }

  try {
    const { pagamento } = await pagamentosHelper.registarPagamentoExtraParcela({
      parcelaId: parcela.id,
      dataPagamento: new Date(),
      metodoPagamentoId: null,
      contaBancariaId: contaId,
      referencia: null,
      observacoes: null,
      userId: req.user.id,
      condominioId: req.condominioId,
    });
    await audit({
      userId: req.user.id,
      acao: 'pagar_parcela_quota_extra',
      entidade: 'PagamentoExtraParcela',
      entidadeId: pagamento.id,
      detalhes: { parcelaId: parcela.id },
    });
    req.flash('success_msg', 'Parcela paga (pagamento registado no sistema de pagamentos).');
  } catch (err) {
    console.error('[pagar-parcela-extra]', err.message);
    req.flash('error_msg', err.message || 'Erro ao registar o pagamento.');
  }
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

// ═══════════════════════════════════════════════════════════════════
// DESFAZER PAGAMENTO — anula o Pagamento real e restaura o estado anterior
// ═══════════════════════════════════════════════════════════════════
router.post('/quotas-extra/parcelas/:id/desfazer', async (req, res) => {
  const parcela = await carregarParcela(req);
  if (!parcela || !parcela.extra_quota) return res.redirect('/admin/quotas-extra');
  const extra = parcela.extra_quota;
  if (parcela.estado !== 'paga') {
    return res.redirect(`/admin/quotas-extra/${extra.id}`);
  }

  // Novo fluxo: encontra o Pagamento real associado à parcela e anula-o
  // (a reposição do estado anterior é feita pelo helper).
  const link = await PagamentoExtraParcela.findOne({
    where: { extra_quota_parcela_id: parcela.id },
    include: [{ model: Pagamento, as: 'pagamento', where: { estado: 'confirmado' }, required: true }],
    order: [['id', 'DESC']],
  });

  try {
    if (link) {
      await pagamentosHelper.anularPagamento(link.pagamento.id);
      req.flash('success_msg', 'Pagamento revertido — a parcela voltou ao estado anterior.');
    } else {
      // Fluxo legado (parcelas pagas antes da migração 069): reverter apenas o
      // movimento direto e repor 'pendente'.
      const t = await sequelize.transaction();
      try {
        await parcela.update({ estado: 'pendente', valor_pago: 0 }, { transaction: t });
        await MovimentoBancario.update(
          { estado: 'anulado' },
          { where: { extra_quota_parcela_id: parcela.id, estado: 'confirmado' }, transaction: t }
        );
        await t.commit();
        req.flash('success_msg', 'Pagamento revertido (fluxo legado).');
      } catch (err2) {
        await t.rollback();
        throw err2;
      }
    }
    await audit({ userId: req.user.id, acao: 'desfazer_parcela_quota_extra', entidade: 'ExtraQuotaParcela', entidadeId: parcela.id });
  } catch (err) {
    console.error('[desfazer-parcela-extra]', err.message);
    req.flash('error_msg', 'Erro ao reverter o pagamento.');
  }
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

// ═══════════════════════════════════════════════════════════════════
// RECIBO POR PARCELA — parcela paga → RCP (ReciboExtraParcela)
// ═══════════════════════════════════════════════════════════════════
router.post('/quotas-extra/parcelas/:id/recibo', async (req, res) => {
  const parcela = await carregarParcela(req);
  if (!parcela || !parcela.extra_quota) return res.redirect('/admin/quotas-extra');
  const extra = parcela.extra_quota;
  try {
    if (parcela.estado !== 'paga') {
      throw new Error('A parcela tem de estar paga para emitir o recibo.');
    }
    const { recibo } = await recibosHelper.emitirReciboParcela({
      parcelaId: parcela.id,
      condominioId: req.condominioId,
      userId: req.user.id,
    });
    await audit({ userId: req.user.id, acao: 'emitir_recibo_quota_extra', entidade: 'Recibo', entidadeId: recibo.id });
    req.flash('success_msg', `Recibo ${recibo.codigo} emitido para a parcela.`);
    return res.redirect(`/admin/quotas/recibos/${recibo.id}/pdf`);
  } catch (err) {
    console.error('[recibo-parcela-extra]', err.message);
    req.flash('error_msg', err.message || 'Erro ao emitir o recibo.');
  }
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

module.exports = router;
