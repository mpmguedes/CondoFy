const express = require('express');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const {
  Fracao,
  ContaBancaria,
  ExtraQuota,
  ExtraQuotaParcela,
  MovimentoBancario,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { toCents, fromCents } = require('../helpers/money');
const { MESES } = require('../helpers/dates');
const { distribuicaoExtra, parcelar, periodosVencimento } = require('../helpers/extra-quotas');
const { criarMovimento } = require('../helpers/movimentos');

const router = express.Router();

router.use(eAdmin);

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

// Resumo agregado de uma quota extra (totais e parcelas por estado).
async function resumoExtra(extra) {
  const parcelas = await ExtraQuotaParcela.findAll({ where: { extra_quota_id: extra.id } });
  const totalC = toCents(extra.valor_total);
  const pagoC = parcelas.filter((p) => p.estado === 'paga').reduce((s, p) => s + toCents(p.valor), 0);
  const pendentes = parcelas.filter((p) => p.estado === 'pendente').length;
  const pagas = parcelas.filter((p) => p.estado === 'paga').length;
  const nFracoes = new Set(parcelas.map((p) => p.fracao_id)).size;
  return {
    total: fromCents(totalC),
    pago: fromCents(pagoC),
    emFalta: fromCents(totalC - pagoC),
    nParcelas: parcelas.length,
    pagas,
    pendentes,
    nFracoes,
  };
}

// ═══════════════════════════════════════════════════════════════════
// LISTA
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas-extra', async (req, res) => {
  const extras = await ExtraQuota.findAll({ order: [['created_at', 'DESC']] });
  const linhas = [];
  for (const e of extras) {
    const r = await resumoExtra(e);
    linhas.push({ ...e.toJSON(), ...r });
  }
  res.render('admin/quotas-extra/listar', { titulo: 'Quotas Extraordinárias', extras: linhas, periodicidadeLabel: PERIODICIDADE_LABEL });
});

// ═══════════════════════════════════════════════════════════════════
// NOVA
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas-extra/nova', async (req, res) => {
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' }, order: [['designacao', 'ASC']] });
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

  const fracoes = await Fracao.findAll({ where: { id: { [Op.in]: fracaoIds }, estado: 'ativo' } });
  if (fracoes.length === 0) {
    req.flash('error_msg', 'Nenhuma fração selecionada está ativa.');
    return res.redirect('/admin/quotas-extra/nova');
  }

  const t = await sequelize.transaction();
  try {
    const extra = await ExtraQuota.create(
      {
        designacao,
        valor_total: valorTotal,
        metodo_divisao: metodo,
        mes_inicio: mesInicio,
        ano_inicio: anoInicio,
        numero_parcelas: numeroParcelas,
        periodicidade,
        estado: 'ativa',
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
    req.flash('success_msg', 'Quota extraordinária criada com sucesso.');
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
  const extra = await ExtraQuota.findByPk(req.params.id);
  if (!extra) return res.redirect('/admin/quotas-extra');

  const parcelas = await ExtraQuotaParcela.findAll({
    where: { extra_quota_id: extra.id },
    include: [{ model: Fracao, as: 'fracao' }],
    order: [['fracao_id', 'ASC'], ['parcela_numero', 'ASC']],
  });
  const contas = await ContaBancaria.findAll({ where: { ativa: true }, order: [['nome', 'ASC']] });

  // Agrupa parcelas por fração para a vista.
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

  res.render('admin/quotas-extra/detalhe', {
    titulo: extra.designacao,
    extra,
    grupos,
    contas,
    resumo,
    periodicidadeLabel: PERIODICIDADE_LABEL,
  });
});

// Anula a quota extra e todas as suas parcelas (não apaga dados).
router.post('/quotas-extra/:id/anular', async (req, res) => {
  const extra = await ExtraQuota.findByPk(req.params.id);
  if (!extra) return res.redirect('/admin/quotas-extra');

  const t = await sequelize.transaction();
  try {
    await ExtraQuotaParcela.update({ estado: 'anulada' }, { where: { extra_quota_id: extra.id, estado: { [Op.ne]: 'paga' } }, transaction: t });
    await extra.update({ estado: 'anulada' }, { transaction: t });
    await audit({ userId: req.user.id, acao: 'anular_quota_extra', entidade: 'ExtraQuota', entidadeId: extra.id });
    await t.commit();
    req.flash('success_msg', 'Quota extraordinária anulada.');
  } catch (err) {
    await t.rollback();
    req.flash('error_msg', 'Erro ao anular a quota extraordinária.');
  }
  return res.redirect(`/admin/quotas-extra/${extra.id}`);
});

// Marca uma parcela como paga e cria o movimento bancário de entrada.
router.post('/quotas-extra/parcelas/:id/pagar', async (req, res) => {
  const parcela = await ExtraQuotaParcela.findByPk(req.params.id, { include: [{ model: ExtraQuota, as: 'extra_quota' }] });
  if (!parcela) return res.redirect('/admin/quotas-extra');
  const contaId = parseInt(req.body.conta_bancaria_id, 10) || null;

  if (parcela.estado === 'anulada') {
    req.flash('error_msg', 'Parcela anulada não pode ser paga.');
    return res.redirect(`/admin/quotas-extra/${parcela.extra_quota_id}`);
  }
  if (parcela.estado === 'paga') {
    req.flash('error_msg', 'Parcela já está paga.');
    return res.redirect(`/admin/quotas-extra/${parcela.extra_quota_id}`);
  }

  const t = await sequelize.transaction();
  try {
    await parcela.update({ estado: 'paga', valor_pago: parcela.valor }, { transaction: t });
    if (contaId) {
      await criarMovimento({
        contaBancariaId: contaId,
        data: new Date(),
        tipo: 'entrada',
        valor: parcela.valor,
        descricao: `Quota extra "${parcela.extra_quota.designacao}" — parcela ${parcela.parcela_numero}`,
        referencia: `QE-${parcela.extra_quota_id}`,
        extraQuotaParcelaId: parcela.id,
        userId: req.user.id,
        transaction: t,
      });
    }
    await audit({ userId: req.user.id, acao: 'pagar_parcela_quota_extra', entidade: 'ExtraQuotaParcela', entidadeId: parcela.id });
    await t.commit();
    req.flash('success_msg', 'Parcela marcada como paga.');
  } catch (err) {
    await t.rollback();
    req.flash('error_msg', 'Erro ao registar o pagamento.');
  }
  return res.redirect(`/admin/quotas-extra/${parcela.extra_quota_id}`);
});

// Reverte o pagamento de uma parcela e anula o movimento associado.
router.post('/quotas-extra/parcelas/:id/desfazer', async (req, res) => {
  const parcela = await ExtraQuotaParcela.findByPk(req.params.id);
  if (!parcela) return res.redirect('/admin/quotas-extra');
  if (parcela.estado !== 'paga') {
    return res.redirect(`/admin/quotas-extra/${parcela.extra_quota_id}`);
  }

  const t = await sequelize.transaction();
  try {
    await parcela.update({ estado: 'pendente', valor_pago: 0 }, { transaction: t });
    await MovimentoBancario.update(
      { estado: 'anulado' },
      { where: { extra_quota_parcela_id: parcela.id, estado: 'confirmado' }, transaction: t }
    );
    await audit({ userId: req.user.id, acao: 'desfazer_parcela_quota_extra', entidade: 'ExtraQuotaParcela', entidadeId: parcela.id });
    await t.commit();
    req.flash('success_msg', 'Pagamento revertido.');
  } catch (err) {
    await t.rollback();
    req.flash('error_msg', 'Erro ao reverter o pagamento.');
  }
  return res.redirect(`/admin/quotas-extra/${parcela.extra_quota_id}`);
});

module.exports = router;
