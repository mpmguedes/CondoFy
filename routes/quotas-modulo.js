// ─────────────────────────────────────────────────────────────────────
// Módulo Quotas — Mapa de Quotas | Comprovativos | Recibos.
//
// Concentra no menu Quotas o ciclo de vida completo: mapa anual das quotas
// (estado mês a mês), comprovativos/pagamentos (com anexo + validação) e
// recibos formais (emissão, PDF, envio por email e anulação com histórico).
//
// Reutiliza integralmente as tabelas quotas/pagamentos/pagamento_quotas e os
// helpers existentes (saldos, pdf, email-fila, avisos/contactos, numeracao).
// Nenhuma segunda implementação paralela de pagamentos/quotas foi criada.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  Fracao,
  Pessoa,
  FracaoPessoa,
  MetodoPagamento,
  ContaBancaria,
  Quota,
  Pagamento,
  PagamentoQuota,
  Recibo,
  ReciboQuota,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { toCents, fromCents, toNumber } = require('../helpers/money');
const { resumoFracao } = require('../helpers/saldos');
const { getQuotaConfig } = require('../helpers/quotas-config');
const { calcularQuota } = require('../helpers/quotas-calc');
const { validarPermilagem } = require('../helpers/permilagem');
const { getCondominio } = require('../helpers/condominio');
const { gerarReciboPDF } = require('../helpers/pdf');
const { compor: comporEmail, nomeFicheiro: nomeFicheiroEmail } = require('../helpers/email-templates');
const { resolverDestinatarios } = require('../helpers/avisos');
const { enfileirarEmail } = require('../helpers/email-fila');
const comprovativos = require('../helpers/comprovativos');
const recibosHelper = require('../helpers/recibos');

const router = express.Router();
router.use(eAdmin);

// Abreviaturas PT-PT de meses.
const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// ── Utilidades locais ───────────────────────────────────────────────

function nomeCurto(nome) {
  if (!nome) return '';
  const partes = String(nome).trim().split(/\s+/).filter(Boolean);
  if (partes.length <= 2) return partes.join(' ');
  return `${partes[0]} ${partes[partes.length - 1]}`;
}

async function pessoasDaFracao(fracaoId) {
  const vinculos = await FracaoPessoa.findAll({
    where: { fracao_id: fracaoId },
    include: [{ model: Pessoa, as: 'pessoa', required: true }],
  });
  return vinculos.map((v) => v.pessoa);
}

// Morador a apresentar nos recibos (primeiro proprietário encontrado).
async function nomeMorador(fracaoId) {
  const vinculos = await FracaoPessoa.findAll({
    where: { fracao_id: fracaoId },
    order: [['vinculo', 'ASC'], ['id', 'ASC']],
    include: [{ model: Pessoa, as: 'pessoa', required: true }],
  });
  const comProprietario =
    vinculos.find((v) => v.vinculo === 'proprietario') || vinculos[0];
  return comProprietario && comProprietario.pessoa ? nomeCurto(comProprietario.pessoa.nome) : '';
}

// "Fração A — 3.º · Esq." (anda/porta quando existirem).
function descricaoFracao(fracao) {
  if (!fracao) return '—';
  const localizacao = [fracao.andar, fracao.porta].filter(Boolean).join(' · ');
  return localizacao ? `${fracao.designacao} — ${localizacao}` : fracao.designacao;
}

// Anos disponíveis nas quotas.
async function anosDisponiveis() {
  const linhas = await Quota.findAll({
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('ano')), 'ano']],
    order: [['ano', 'DESC']],
    raw: true,
  });
  return linhas.map((a) => a.ano);
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// ═══════════════════════════════════════════════════════════════════
// TAB 1 — MAPA DE QUOTAS (página principal do módulo)
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas', async (req, res) => {
  const ano = parseInt(req.query.ano, 10) || new Date().getFullYear();
  const [fracoes, quotasAno, anos, quotaConfig] = await Promise.all([
    Fracao.findAll({ order: [['designacao', 'ASC']] }),
    Quota.findAll({ where: { ano } }),
    anosDisponiveis(),
    getQuotaConfig(),
  ]);

  // Pagamentos aplicados e cobertura de recibos nas quotas do ano.
  const idsAno = quotasAno.map((q) => q.id);
  const [pagoAnoMap, cobertoAnoMap] = await Promise.all([
    recibosHelper.pagoPorQuota(idsAno),
    recibosHelper.cobertoPorQuota(idsAno),
  ]);

  const porFracaoMes = {};
  const ESTADO_CELULA = {
    paga: { key: 'paga', sim: '✓', rot: 'Pago' },
    vencida: { key: 'incumprimento', sim: '✗', rot: 'Em incumprimento' },
    pendente: { key: 'pendente', sim: '•', rot: 'Pendente' },
    parcialmente_paga: { key: 'seminfo', sim: '?', rot: 'Parcialmente paga' },
    anulada: { key: 'semquota', sim: '*', rot: 'Anulada' },
  };
  // Estado do mês DERIVADO dos pagamentos confirmados (aplicações reais) —
  // nunca do estado guardado da quota, que pode ficar desatualizado quando
  // pagamentos são anulados.
  const estadoMapa = (q, pagoC) => {
    if (q.estado === 'anulada') return 'anulada';
    const valorC = toCents(q.valor);
    if (pagoC >= valorC) return 'paga';
    if (pagoC > 0) return 'parcialmente_paga';
    if (q.data_vencimento) {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const vencimento = new Date(q.data_vencimento);
      vencimento.setHours(0, 0, 0, 0);
      if (hoje > vencimento) return 'vencida';
    }
    return 'pendente';
  };
  for (const q of quotasAno) {
    if (!porFracaoMes[q.fracao_id]) porFracaoMes[q.fracao_id] = {};
    const pagoC = pagoAnoMap.get(q.id) || 0;
    const cobertoC = cobertoAnoMap.get(q.id) || 0;
    const celula = ESTADO_CELULA[estadoMapa(q, pagoC)] || ESTADO_CELULA.pendente;
    porFracaoMes[q.fracao_id][q.mes] = {
      id: q.id,
      numero_documento: q.numero_documento,
      key: celula.key,
      sim: celula.sim,
      rot: celula.rot,
      valor: q.valor,
      pago: fromCents(pagoC),
      coberto: fromCents(cobertoC),
      porEmitirMeses: pagoC > 0 && cobertoC <= 1,
    };
  }

  // Saldo por fração (todas as quotas vs. pagamentos confirmados + transitado).
  const [totalQuotaPorFracao, totalPagoPorFracao] = await Promise.all([
    Quota.findAll({
      attributes: ['fracao_id', [sequelize.fn('SUM', sequelize.col('valor')), 'total']],
      where: { estado: { [Op.ne]: 'anulada' } },
      group: ['fracao_id'],
      raw: true,
    }),
    Pagamento.findAll({
      attributes: ['fracao_id', [sequelize.fn('SUM', sequelize.col('valor')), 'total']],
      where: { estado: 'confirmado' },
      group: ['fracao_id'],
      raw: true,
    }),
  ]);
  const dividaC = new Map(totalQuotaPorFracao.map((r) => [r.fracao_id, toCents(Number(r.total) || 0)]));
  const pagoFracaoC = new Map(totalPagoPorFracao.map((r) => [r.fracao_id, toCents(Number(r.total) || 0)]));

  // Meses do ano por emitir (para a coluna "Por emitir" — valor real + meses).
  const linhasDetalhe = await recibosHelper.detalhePorEmitir({ ano });
  const porEmitirAno = new Map();
  for (const grupo of linhasDetalhe) {
    const disponiveis = grupo.meses.filter((m) => m.pode);
    if (!disponiveis.length) continue;
    const valorC = disponiveis.reduce((s, m) => s + toCents(m.disponivel), 0);
    porEmitirAno.set(grupo.fracaoId, { meses: disponiveis.length, valor: fromCents(valorC) });
  }

  const linhas = fracoes.map((f) => {
    const quotaC = dividaC.get(f.id) || 0;
    const pagoC = pagoFracaoC.get(f.id) || 0;
    const transitadoC = toCents(Number(f.transitado) || 0);
    const transitadoNum = Number(f.transitado) || 0;
    const saldoC = pagoC - quotaC - transitadoC; // negativo = dívida
    const meses = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const celula = porFracaoMes[f.id] ? porFracaoMes[f.id][m] : null;
      if (!celula) {
        return { key: 'semquota', sim: '*', rot: 'Sem quota', temQuota: false };
      }
      return { ...celula, temQuota: true };
    });
    return {
      id: f.id,
      designacao: f.designacao,
      andar: f.andar,
      porta: f.porta,
      permilagem: f.permilagem,
      estado: f.estado,
      transitado: transitadoNum,
      transitadoTxt: transitadoNum.toFixed(2).replace('.', ','),
      meses,
      saldo: fromCents(saldoC),
      absSaldo: fromCents(Math.abs(saldoC)),
      emDivida: saldoC < 0,
      porEmitirInfo: porEmitirAno.get(f.id) || null,
    };
  });

  // Resumo compacto do topo.
  const totalQuotasAnoC = quotasAno.reduce((s, q) => s + toCents(q.valor), 0);
  const totalPagoAplicadoAnoC = idsAno.reduce((s, id) => s + (pagoAnoMap.get(id) || 0), 0);
  const permilagemTotal = fracoes.reduce((s, f) => s + (Number(f.permilagem) || 0), 0);
  const fcrMensalPrevistoC = fracoes.reduce((s, f) => {
    const calc = calcularQuota(f.permilagem, quotaConfig.valorPor1000, quotaConfig.fcrPercentagem);
    return s + toCents(calc.fcr);
  }, 0);

  const anoInicio = `${ano}-01-01`;
  const anoFim = `${ano}-12-31`;
  const recebidoAnoC = toCents(
    await Pagamento.sum('valor', {
      where: { estado: 'confirmado', data_pagamento: { [Op.between]: [anoInicio, anoFim] } },
    })
  );
  const totalQuotasGlobalC = [...dividaC.values()].reduce((s, v) => s + v, 0);
  const totalPagoGlobalC = [...pagoFracaoC.values()].reduce((s, v) => s + v, 0);

  res.render('admin/quotas/mapa', {
    titulo: 'Quotas',
    secao: 'mapa',
    ano,
    anos,
    linhas,
    quotaConfig,
    permilagemTotal,
    fcrMensalPrevisto: fromCents(fcrMensalPrevistoC),
    permilagem: validarPermilagem(fracoes),
    resumo: {
      quotasAno: fromCents(totalQuotasAnoC),
      recebidoAno: fromCents(recebidoAnoC),
      emDivida: fromCents(Math.max(0, totalQuotasGlobalC - totalPagoGlobalC)),
      pendenteAno: fromCents(Math.max(0, totalQuotasAnoC - totalPagoAplicadoAnoC)),
    },
    nFracoes: fracoes.length,
    meses: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
    driveLigado: false,
  });
});

// Valores transitados por fração — geridos na modal do Mapa (POST apenas).
// Regras: o valor é persistido em fracoes.transitado (única fonte); campos
// vazios NÃO substituem valores existentes por zero (só um "0" explícito o
// faz); aceita vírgula ou ponto decimais e mantém 2 casas.
function parseTransitado(value) {
  const bruto = String(value ?? '').trim();
  if (bruto === '') return null; // vazio → sem alteração
  const limpo = bruto.replace(/\s/g, '');
  // Aceita "150", "150,50", "150.50", "1.500,00", "-25,50"; rejeita texto/duplos pontos.
  const valido = /^-?\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(limpo) || /^-?\d+(\.\d{1,2})?$/.test(limpo);
  if (!valido) return null;
  const num = toNumber(limpo); // vírgula/ponto decimais + milhares PT
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

router.post('/quotas/transitados', async (req, res) => {
  const { transitados, importar } = req.body;
  let atualizados = 0;
  try {
    const fracaoPorDesignacao = new Map((await Fracao.findAll()).map((f) => [String(f.designacao).trim().toLowerCase(), f]));

    // Importação em bloco: uma linha por fração — "Designação;valor" (valor em €).
    if (importar && String(importar).trim()) {
      for (const linha of String(importar).split(/\r?\n/)) {
        const limpa = String(linha).trim();
        if (!limpa) continue;
        const [desig, valor] = limpa.split(/[;,]/).map((x) => String(x || '').trim());
        if (!desig) continue;
        const fracao = fracaoPorDesignacao.get(String(desig).toLowerCase());
        if (!fracao) continue;
        const num = parseTransitado(valor);
        if (num === null) continue;
        await fracao.update({ transitado: num });
        atualizados++;
      }
    }

    if (transitados && typeof transitados === 'object') {
      for (const [id, valor] of Object.entries(transitados)) {
        const fracao = await Fracao.findByPk(id);
        if (!fracao) continue;
        const num = parseTransitado(valor);
        if (num === null) continue; // vazio/inválido → não toca no valor guardado
        await fracao.update({ transitado: num });
        atualizados++;
      }
    }

    await audit({ userId: req.user.id, acao: 'definir_transitados', entidade: 'Fracao', detalhes: { atualizados } }).catch(() => {});
    req.flash('success_msg', `Valores transitados guardados (${atualizados} fração(ões)).`);
  } catch (err) {
    console.error('[transitados]', err);
    req.flash('error_msg', 'Erro ao guardar os valores transitados.');
  }
  res.redirect(`/admin/quotas${req.query.ano ? `?ano=${req.query.ano}` : ''}`);
});

// ═══════════════════════════════════════════════════════════════════
// TAB 2 — COMPROVATIVOS (pagamentos + anexo + validação)
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas/comprovativos', async (req, res) => {
  const pagamentos = await Pagamento.findAll({
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: ContaBancaria, as: 'conta_bancaria' },
    ],
    order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
  });

  const linhas = [];
  for (const p of pagamentos) {
    const pessoas = await pessoasDaFracao(p.fracao_id);
    linhas.push({
      id: p.id,
      numero_documento: p.numero_documento,
      data_pagamento: p.data_pagamento,
      valor: p.valor,
      metodo: p.metodo_pagamento ? p.metodo_pagamento.nome : null,
      conta: p.conta_bancaria ? p.conta_bancaria.nome : null,
      estado: p.estado,
      referencia: p.referencia,
      observacoes: p.observacoes,
      fracao: p.fracao ? p.fracao.designacao : '—',
      condominos: pessoas.map((x) => x.nome).join(', ') || '—',
      comprovativo_estado: p.comprovativo_estado,
      comprovativo_nome: p.comprovativo_nome,
      comprovativo_ficheiro: p.comprovativo_ficheiro,
      comprovativo_motivo: p.comprovativo_motivo,
      comprovativo_data: p.comprovativo_data,
    });
  }

  const confirmados = linhas.filter((l) => l.estado === 'confirmado');
  const contagem = {
    validados: confirmados.filter((l) => l.comprovativo_estado === 'validado').length,
    pendentes: confirmados.filter((l) => !l.comprovativo_ficheiro || l.comprovativo_estado === 'pendente').length,
    rejeitados: confirmados.filter((l) => l.comprovativo_estado === 'rejeitado').length,
  };

  res.render('admin/quotas/comprovativos', {
    titulo: 'Quotas · Comprovativos',
    secao: 'comprovativos',
    pagamentos: linhas,
    contagem,
  });
});

// Anexar / substituir comprovativo de um pagamento.
router.post('/pagamentos/:id/comprovativo', (req, res) => {
  comprovativos.uploadComprovativo(req, res, async (err) => {
    try {
      const pagamento = await Pagamento.findByPk(req.params.id);
      if (!pagamento) {
        req.flash('error_msg', 'Pagamento não encontrado.');
        return res.redirect('/admin/quotas/comprovativos');
      }
      if (err) {
        req.flash('error_msg', err.message || 'Erro ao carregar o comprovativo.');
        return res.redirect('/admin/quotas/comprovativos');
      }
      if (!req.file) {
        req.flash('error_msg', 'Selecione um ficheiro.');
        return res.redirect('/admin/quotas/comprovativos');
      }
      // Substituição: apaga o ficheiro anterior.
      comprovativos.apagarComprovativo(pagamento.comprovativo_ficheiro);
      await pagamento.update({
        comprovativo_ficheiro: req.file.filename,
        comprovativo_nome: req.file.originalname,
        comprovativo_mime: req.file.mimetype,
        comprovativo_estado: 'pendente',
        comprovativo_motivo: null,
        comprovativo_data: new Date(),
      });
      await audit({ userId: req.user.id, acao: 'anexar_comprovativo', entidade: 'Pagamento', entidadeId: pagamento.id }).catch(() => {});
      req.flash('success_msg', 'Comprovativo anexado (aguarda validação).');
      return res.redirect('/admin/quotas/comprovativos');
    } catch (erro) {
      console.error('[comprovativo]', erro);
      req.flash('error_msg', 'Erro ao anexar o comprovativo.');
      return res.redirect('/admin/quotas/comprovativos');
    }
  });
});

function validarComprovativoRedirect(req, res) {
  return res.redirect('/admin/quotas/comprovativos');
}

router.post('/pagamentos/:id/comprovativo/validar', async (req, res) => {
  const pagamento = await Pagamento.findByPk(req.params.id);
  if (!pagamento) return validarComprovativoRedirect(req, res);
  await pagamento.update({ comprovativo_estado: 'validado', comprovativo_motivo: null, comprovativo_data: new Date() });
  await audit({ userId: req.user.id, acao: 'validar_comprovativo', entidade: 'Pagamento', entidadeId: pagamento.id }).catch(() => {});
  req.flash('success_msg', 'Comprovativo validado.');
  return validarComprovativoRedirect(req, res);
});

router.post('/pagamentos/:id/comprovativo/rejeitar', async (req, res) => {
  const pagamento = await Pagamento.findByPk(req.params.id);
  if (!pagamento) return validarComprovativoRedirect(req, res);
  await pagamento.update({
    comprovativo_estado: 'rejeitado',
    comprovativo_motivo: String(req.body.motivo || '').trim() || null,
    comprovativo_data: new Date(),
  });
  await audit({ userId: req.user.id, acao: 'rejeitar_comprovativo', entidade: 'Pagamento', entidadeId: pagamento.id }).catch(() => {});
  req.flash('success_msg', 'Comprovativo rejeitado.');
  return validarComprovativoRedirect(req, res);
});

// Consultar / descarregar o comprovativo (inline para visualizar).
router.get('/pagamentos/:id/comprovativo', async (req, res) => {
  const pagamento = await Pagamento.findByPk(req.params.id);
  if (!pagamento || !pagamento.comprovativo_ficheiro) {
    req.flash('error_msg', 'Sem comprovativo associado.');
    return res.redirect('/admin/quotas/comprovativos');
  }
  if (!comprovativos.existeComprovativo(pagamento)) {
    req.flash('error_msg', 'Ficheiro do comprovativo não encontrado.');
    return res.redirect('/admin/quotas/comprovativos');
  }
  const caminho = comprovativos.caminhoComprovativo(pagamento);
  const descarregar = req.query.download === '1';
  res.setHeader('Content-Type', pagamento.comprovativo_mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${descarregar ? 'attachment' : 'inline'}; filename="${comprovativos.nomeSeguro(pagamento.comprovativo_nome || 'comprovativo.pdf')}"`
  );
  return res.sendFile(caminho);
});

// ═══════════════════════════════════════════════════════════════════
// TAB 3 — RECIBOS (por emitir + emitidos + envio + anulação)
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas/recibos', async (req, res) => {
  const emitirFracaoId = parseInt(req.query.emitir, 10) || null;

  // Recibos emitidos (com histórico de anulados).
  const recibos = await Recibo.findAll({
    include: [
      { model: Fracao, as: 'fracao' },
      {
        model: Quota,
        as: 'quotas',
        through: { attributes: ['valor', 'valor_base', 'valor_fcr'] },
      },
    ],
    order: [['ano', 'DESC'], ['id', 'DESC']],
  });
  const moradores = new Map();
  for (const r of recibos) {
    if (!moradores.has(r.fracao_id)) moradores.set(r.fracao_id, await nomeMorador(r.fracao_id));
  }
  const linhasRecibos = recibos.map((r) => {
    const meses = (r.quotas || []).map((q) => ({ ano: q.ano, mes: q.mes }));
    const morador = moradores.get(r.fracao_id) || '';
    return {
      id: r.id,
      codigo: r.codigo,
      codigo_verificacao: r.codigo_verificacao,
      numero: r.numero,
      ano: r.ano,
      tipo: r.tipo,
      valor: r.valor,
      data_emissao: r.data_emissao,
      estado: r.estado,
      enviado_at: r.enviado_at,
      motivo_anulacao: r.motivo_anulacao,
      fracao: r.fracao ? r.fracao.designacao : '—',
      fracao_id: r.fracao_id,
      andar: r.fracao ? r.fracao.andar : null,
      porta: r.fracao ? r.fracao.porta : null,
      morador,
      periodo: recibosHelper.periodoLabel(meses),
    };
  });

  // Resumo dos recibos.
  const emitidos = linhasRecibos.filter((l) => l.estado === 'emitido');
  const resumoRecibos = {
    emitidos: emitidos.length,
    enviados: emitidos.filter((l) => l.enviado_at).length,
    porEnviar: emitidos.filter((l) => !l.enviado_at).length,
  };

  // "Por emitir": frações com valor pago ainda não coberto (valor real + meses).
  const detalhe = await recibosHelper.detalhePorEmitir();
  const detalhePorFracao = new Map(detalhe.map((d) => [d.fracaoId, d.meses]));
  const mapaFracao = new Map((await Fracao.findAll()).map((f) => [f.id, f]));

  // Cada mês com quota: quota/pago/já-em-recibo/disponível (€) + pode.
  const enriquecerMes = (m) => ({
    quotaId: m.quotaId,
    mes: m.mes,
    ano: m.ano,
    rotulo: `${MESES_CURTO[m.mes - 1]} ${m.ano}`,
    quota: m.valor,
    pago: m.pago,
    coberto: m.coberto,
    disponivel: m.disponivel,
    fcr: m.valor_fcr,
    pode: m.pode,
  });

  const porEmitir = (await recibosHelper.porEmitirPorFracao())
    .map((l) => {
      const f = mapaFracao.get(l.fracaoId);
      const meses = (detalhePorFracao.get(l.fracaoId) || []).map(enriquecerMes);
      return {
        ...l,
        mesesN: l.meses,
        designacao: f ? f.designacao : '—',
        andar: f ? f.andar : null,
        porta: f ? f.porta : null,
        meses,
      };
    })
    .sort((a, b) => String(a.designacao).localeCompare(String(b.designacao), 'pt'));

  const porEmitirJson = porEmitir.map((l) => ({ fracaoId: l.fracaoId, meses: l.meses }));

  res.render('admin/quotas/recibos', {
    titulo: 'Quotas · Recibos',
    secao: 'recibos',
    porEmitir,
    porEmitirJson,
    recibos: linhasRecibos,
    resumo: resumoRecibos,
    abrirEmitirFracaoId: emitirFracaoId,
  });
});

// Emissão de recibos (modal).
router.post('/quotas/recibos/emitir', async (req, res) => {
  try {
    const fracaoId = parseInt(req.body.fracao_id, 10);
    const modosValidos = ['plano', 'unico', 'mes', 'selecionar'];
    const modo = String(req.body.modo || 'plano');
    if (!modosValidos.includes(modo)) throw new Error('Modo de distribuição inválido.');
    const quotaIds = toArray(req.body.meses).map(Number).filter(Boolean);
    if (!fracaoId) throw new Error('Fração em falta.');
    if (!quotaIds.length) throw new Error('Selecione pelo menos um mês.');

    const mesesCompletos = [];
    const quotas = await Quota.findAll({ where: { id: { [Op.in]: quotaIds }, fracao_id: fracaoId } });
    const porId = new Map(quotas.map((q) => [q.id, q]));
    for (const qid of quotaIds) {
      const q = porId.get(qid);
      if (q) {
        mesesCompletos.push({
          quotaId: q.id,
          ano: q.ano,
          mes: q.mes,
          valor: q.valor,
          valor_base: q.valor_base,
          valor_fcr: q.valor_fcr,
        });
      }
    }
    if (mesesCompletos.length !== quotaIds.length) {
      throw new Error('Um dos meses selecionados não pertence a esta fração.');
    }

    const valorGlobal = parseFloat(String(req.body.valor_global || '').replace(',', '.'));
    const criados = await recibosHelper.emitirRecibos({
      fracaoId,
      meses: mesesCompletos,
      modo,
      valorGlobal: Number.isFinite(valorGlobal) ? valorGlobal : 0,
      tipo: req.body.tipo === 'extraordinario' ? 'extraordinario' : 'ordinario',
      userId: req.user.id,
    });
    await audit({
      userId: req.user.id,
      acao: 'emitir_recibo',
      entidade: 'Recibo',
      detalhes: { codigos: criados.map((r) => r.codigo), modo },
    }).catch(() => {});

    // Envio imediato por email (opcional) — usa os contactos do condómino.
    const enviarEmail = req.body.enviar_email === 'on' || req.body.enviar_email === '1';
    let enviados = 0;
    if (enviarEmail) {
      for (const recibo of criados) {
        try {
          await enfileirarReciboPorEmail(recibo.id, {
            protocol: req.protocol,
            host: req.get('host'),
            userId: req.user.id,
          });
          enviados++;
        } catch (erroEnvio) {
          console.error('[emitir-recibo-email]', erroEnvio.message);
        }
      }
    }

    const msg = `${criados.length} recibo(s) emitido(s): ${criados.map((r) => r.codigo).join(', ')}.`;
    req.flash('success_msg', enviarEmail ? `${msg} ${enviados} enviado(s) para a fila de email.` : msg);
  } catch (err) {
    console.error('[emitir-recibo]', err.message);
    req.flash('error_msg', err.message || 'Erro ao emitir o recibo.');
  }
  res.redirect('/admin/quotas/recibos');
});

// Anulação de recibo (mantém histórico; devolve os meses a "por emitir").
router.post('/quotas/recibos/:id/anular', async (req, res) => {
  try {
    const anulado = await recibosHelper.anularRecibo(req.params.id, {
      motivo: String(req.body.motivo || '').trim(),
    });
    await audit({
      userId: req.user.id,
      acao: 'anular_recibo',
      entidade: 'Recibo',
      entidadeId: req.params.id,
      detalhes: { motivo: String(req.body.motivo || '').trim() || null },
    }).catch(() => {});
    req.flash('success_msg', anulado ? 'Recibo anulado. Os meses abrangidos voltaram a estar disponíveis para emissão.' : 'O recibo já se encontrava anulado.');
  } catch (err) {
    console.error('[anular-recibo]', err.message);
    req.flash('error_msg', err.message || 'Erro ao anular o recibo.');
  }
  res.redirect('/admin/quotas/recibos');
});

// Formata permilagem PT-PT (ex.: 125 → "125,000 ‰").
function formatarPermilagem(valor) {
  const n = Number(valor) || 0;
  const partes = n.toFixed(3).split('.');
  partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${partes.join(',')} ‰`;
}

// Constrói (uma única vez, para qualquer vista/ação) os dados reais do recibo
// para o PDF: método/data/referência vêm dos PAGAMENTOS confirmados que
// cobrem as quotas do recibo (um ou vários), nunca são pedidos ao utilizador.
async function pdfDeRecibo(recibo, condRow) {
  const morador = await nomeMorador(recibo.fracao_id);
  const resumo = await resumoFracao(recibo.fracao_id);
  const fracao = recibo.fracao || null;
  const quotas = (recibo.quotas || []).sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
  const pagamentos = await recibosHelper.pagamentosDasQuotas(quotas.map((q) => q.id));

  // Zona do destinatário: morador + identificação da fração + morada/CP do
  // edifício (o sistema não guarda morada própria do condómino).
  const cpLocalidade = [condRow.codigo_postal, condRow.localidade].filter(Boolean).join(' ');
  const destinatario = {
    nome: morador || null,
    fracao: fracao ? fracao.designacao : null,
    morada: condRow.morada || null,
    codigoPostalLocalidade: cpLocalidade || null,
  };

  return gerarReciboPDF(condRow, {
    numero: recibo.codigo,
    codigoVerificacao: recibo.codigo_verificacao,
    data: recibo.data_emissao || new Date(),
    condominoNome: morador || 'Condómino',
    destinatario,
    fracaoDesignacao: fracao ? descricaoFracao(fracao) : '—',
    fracaoPermilagem:
      fracao && fracao.permilagem !== null && fracao.permilagem !== undefined && String(fracao.permilagem).trim() !== ''
        ? formatarPermilagem(fracao.permilagem)
        : null,
    valor: recibo.valor,
    saldoAposPagamento: resumo ? resumo.emDivida : 0,
    anulado: recibo.estado === 'anulado',
    pagamentos,
    quotas: quotas.map((q) => ({
      numero: q.numero_documento || '',
      periodo: recibosHelper.periodoLabel([{ ano: q.ano, mes: q.mes }]),
      valorAplicado: q.ReciboQuota ? q.ReciboQuota.valor : q.valor,
    })),
  });
}

// Ver PDF do recibo.
router.get('/quotas/recibos/:id/pdf', async (req, res) => {
  try {
    const recibo = await Recibo.findByPk(req.params.id, {
      include: [
        { model: Fracao, as: 'fracao' },
        {
          model: Quota,
          as: 'quotas',
          through: { attributes: ['valor', 'valor_base', 'valor_fcr'] },
        },
      ],
    });
    if (!recibo) {
      req.flash('error_msg', 'Recibo não encontrado.');
      return res.redirect('/admin/quotas/recibos');
    }
    const condominio = await getCondominio();
    const condRow = condominio && condominio.toJSON ? condominio.toJSON() : condominio || {};
    const buffer = await pdfDeRecibo(recibo, condRow);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo_${recibo.codigo}.pdf"`);
    return res.send(buffer);
  } catch (err) {
    console.error('[recibo-pdf]', err.message);
    req.flash('error_msg', 'Erro ao gerar o PDF do recibo.');
    return res.redirect('/admin/quotas/recibos');
  }
});

// Envia (enfileira) o recibo por email usando os contactos do condómino.
// Devolve { destinatarios: n } quando enfileirado; lança erro se sem email.
async function enfileirarReciboPorEmail(reciboId, { protocol, host, userId }) {
  const recibo = await Recibo.findByPk(reciboId, {
    include: [
      { model: Fracao, as: 'fracao' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor'] } },
    ],
  });
  if (!recibo) throw new Error('Recibo não encontrado.');
  if (recibo.estado !== 'emitido') throw new Error('Recibos anulados não podem ser enviados.');

  const dest = await resolverDestinatarios({ modo: 'fracoes', fracoes: [recibo.fracao_id] });
  if (!dest.length) throw new Error('O condómino não tem email de contacto registado.');

  const baseUrl = `${protocol}://${host}`;
  const urlOnline = `${baseUrl}/admin/quotas/recibos/${recibo.id}/pdf`;
  const condEm = await getCondominio();
  const condNome = condEm && condEm.designacao ? String(condEm.designacao) : '';
  const adminNome = condEm && condEm.administracao_nome ? String(condEm.administracao_nome) : '';
  const condRow = condEm && condEm.toJSON ? condEm.toJSON() : condEm || {};
  const fracaoDesig = recibo.fracao ? recibo.fracao.designacao : '—';
  const buffer = await pdfDeRecibo(recibo, condRow); // método/data/ref reais do pagamento
  const anexoNome = nomeFicheiroEmail('recibo', { numero: recibo.codigo });

  for (const d of dest) {
    const tpl = comporEmail('recibo', {
      destinatarioNome: d.nome,
      condominio: condNome,
      administracao: adminNome,
      valor: `${recibo.valor} €`,
      fração: fracaoDesig,
      referencia: recibo.codigo,
      data: String(recibo.data_emissao || ''),
      urlOnline,
    });
    await enfileirarEmail({
      destinatario_email: d.email,
      destinatario_nome: d.nome,
      assunto: tpl.assunto,
      corpo: tpl.text,
      corpo_html: tpl.html,
      entidade_tipo: 'Recibo',
      entidade_id: recibo.id,
      userId,
      anexoNome,
      anexoBuffer: buffer,
    });
  }
  await recibo.update({ enviado_at: new Date() });
  return { destinatarios: dest.length, codigo: recibo.codigo };
}

// Envio do recibo por email (contactos existentes do condómino).
router.post('/quotas/recibos/:id/enviar', async (req, res) => {
  try {
    const r = await enfileirarReciboPorEmail(req.params.id, {
      protocol: req.protocol,
      host: req.get('host'),
      userId: req.user.id,
    });
    await audit({
      userId: req.user.id,
      acao: 'enviar_recibo_email',
      entidade: 'Recibo',
      entidadeId: req.params.id,
      detalhes: { destinatarios: r.destinatarios },
    }).catch(() => {});
    req.flash('success_msg', `Recibo ${r.codigo} enviado para ${r.destinatarios} destinatário(s) (fila de email).`);
  } catch (err) {
    console.error('[enviar-recibo]', err.message);
    req.flash('error_msg', err.message || 'Erro ao enviar o recibo.');
  }
  res.redirect('/admin/quotas/recibos');
});

// Redirecionamentos de compatibilidade (as páginas antigas passaram a ser
// separadores do módulo Quotas).
router.get('/pagamentos', (req, res) => res.redirect('/admin/quotas/comprovativos'));
router.get('/pagamentos/enviar-recibos', (req, res) => res.redirect('/admin/quotas/recibos'));
router.get('/quotas/grelha', (req, res) => res.redirect(`/admin/quotas${req.query.ano ? `?ano=${req.query.ano}` : ''}`));

module.exports = router;
// Exposição para testes (parser de valores transitados).
module.exports.parseTransitado = parseTransitado;
