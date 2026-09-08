// ─────────────────────────────────────────────────────────────────────
// Conta-corrente do módulo Quotas — consulta + reconciliação financeira.
//
// FASE 1 (apenas dados existentes — sem novas tabelas):
//  · Débitos de uma fração = quotas ordinárias emitidas (não anuladas) +
//    parcelas de Quotas Extra cuja quota extra está PROCESSADA (não
//    anuladas) + valor transitado configurado em fracoes.transitado.
//  · Créditos = pagamentos CONFIRMADOS da fração (Pagamento.estado =
//    'confirmado'). Um pagamento combinado (PagamentoQuota +
//    PagamentoExtraParcela) é SEMPRE UM único crédito, com o valor total do
//    pagamento — nunca é duplicado por ter duas associações internas.
//  · Recibos NÃO são movimentos: nunca entram como débito/crédito. Quando
//    existem, aparecem apenas como contexto textual do pagamento.
//  · Saldo (positivo = dívida da fração; negativo = crédito a favor):
//        saldo = transitado + Σ quotas (não anuladas)
//                + Σ parcelas extra (extra processada, não anuladas)
//                − Σ pagamentos confirmados
//    que é o espelho da convenção do Mapa (lá saldo = pago − quotas −
//    transitado; aqui apresenta-se com o sinal invertido: dívida positiva).
//  · Pagamentos parciais são suportados naturalmente: o débito da obrigação
//    entra na totalidade e o crédito entra pelo valor efetivamente pago; o
//    saldo acumulado reflete o remanescente em cada linha.
//  · Excedente de pagamento (valor recebido acima das obrigações) fica
//    IMPLÍCITO — reduz o saldo (crédito a favor) sem entidade própria, tal
//    como o resto do CondoFy trata ("por aplicar (crédito)").
//
// Isolamento multi-condomínio: todas as queries restringem por
// condominio_id do contexto ativo e a fração é sempre validada com
// fracao.condominio_id === condominioId (nunca se confia só no browser).
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  Fracao,
  Quota,
  Pagamento,
  PagamentoQuota,
  PagamentoExtraParcela,
  ExtraQuota,
  ExtraQuotaParcela,
  Recibo,
  ReciboQuota,
  ReciboExtraParcela,
  MetodoPagamento,
} = require('../models');
const { toCents, fromCents } = require('./money');

const EPS = 1; // 1 cêntimo

const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MESES_NOME = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// Ordem estável de apresentação dentro do mesmo dia (débitos antes de créditos).
const ORDEM_TIPO = { transitado: 0, quota: 1, parcela: 2, pagamento: 3 };

function fmtDataISO(d) {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? String(d) : null;
}
function anoDeISO(dataISO) {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(String(dataISO || ''));
  return m ? parseInt(m[1], 10) : null;
}
function pad2(n) {
  return String(n).padStart(2, '0');
}

// ── Motor puro do extrato (testável sem base de dados) ───────────────
// entradas: [{ tipo, dataISO, rotulo, detalhe, debito, credito }]
//  · debito/credito em euros (positivos); exatamente um dos dois por linha;
//  · tipo ∈ 'quota' | 'parcela' | 'pagamento' | 'transitado' (informação).
// Devolve { linhas, saldoC } com saldo acumulado linha a linha.
function construirExtrato({ transitado = 0, entradas = [] } = {}) {
  const itens = [];
  const transitadoC = Math.round(toCents(transitado));
  if (Math.abs(transitadoC) > EPS) {
    itens.push({
      tipo: 'transitado',
      dataISO: null,
      rotulo: 'Valor transitado (períodos anteriores)',
      detalhe: transitadoC > 0 ? 'Dívida inicial da fração' : 'Crédito inicial a favor da fração',
      debitoC: transitadoC > 0 ? transitadoC : 0,
      creditoC: transitadoC < 0 ? -transitadoC : 0,
      ordem: 0,
    });
  }
  (entradas || []).forEach((e, i) => {
    const debitoC = Math.max(0, Math.round(toCents(e.debito)));
    const creditoC = Math.max(0, Math.round(toCents(e.credito)));
    if (debitoC <= 0 && creditoC <= 0) return; // sem valor não é movimento
    itens.push({
      tipo: String(e.tipo || 'movimento'),
      dataISO: fmtDataISO(e.dataISO),
      rotulo: String(e.rotulo || 'Movimento'),
      detalhe: e.detalhe ? String(e.detalhe) : '',
      debitoC,
      creditoC,
      ordem: i,
    });
  });

  // Cronológico; sem data (valor transitado) fica sempre no início.
  itens.sort((a, b) => {
    const da = a.dataISO ? a.dataISO : '0000-00-00';
    const db = b.dataISO ? b.dataISO : '0000-00-00';
    if (da !== db) return da < db ? -1 : 1;
    const ta = ORDEM_TIPO[a.tipo] !== undefined ? ORDEM_TIPO[a.tipo] : 9;
    const tb = ORDEM_TIPO[b.tipo] !== undefined ? ORDEM_TIPO[b.tipo] : 9;
    if (ta !== tb) return ta - tb;
    return a.ordem - b.ordem;
  });

  let saldoC = 0;
  const linhas = itens.map((it) => {
    saldoC += it.debitoC - it.creditoC;
    return {
      tipo: it.tipo,
      dataISO: it.dataISO,
      ano: it.dataISO ? anoDeISO(it.dataISO) : null,
      rotulo: it.rotulo,
      detalhe: it.detalhe,
      debito: fromCents(it.debitoC),
      credito: fromCents(it.creditoC),
      saldo: fromCents(saldoC),
      saldoC,
    };
  });
  return { linhas, saldoC };
}

// Filtra o extrato já construído por ano, mantendo o saldo acumulado.
// Devolve { linhas, saldoInicialC } — a primeira linha sintética "Saldo
// inicial" carrega o saldo acumulado dos movimentos anteriores ao ano.
function filtrarExtratoPorAno(extrato, ano) {
  const todas = extrato.linhas;
  const alvo = parseInt(ano, 10);
  const linhasDoAno = todas.filter((l) => l.ano === alvo);
  if (!Number.isFinite(alvo)) {
    return { linhas: todas, saldoInicialC: 0 };
  }
  let saldoInicialC = 0;
  const primeiroIndice = todas.findIndex((l) => l.ano === alvo);
  if (primeiroIndice > 0) saldoInicialC = todas[primeiroIndice - 1].saldoC;
  else if (primeiroIndice === -1 && todas.length) saldoInicialC = todas[todas.length - 1].saldoC;
  const linhas = [
    {
      sintetico: true,
      tipo: 'saldo-inicial',
      dataISO: `${alvo}-01-01`,
      ano: alvo,
      rotulo: 'Saldo inicial',
      detalhe: 'Movimentos de anos anteriores',
      debito: null,
      credito: null,
      saldo: fromCents(saldoInicialC),
      saldoC: saldoInicialC,
    },
    ...linhasDoAno,
  ];
  return { linhas, saldoInicialC };
}

// ── Valor transitado / formatação comum ──────────────────────────────
function valorTransitado(fracao) {
  const n = fracao && fracao.transitado != null ? Number(fracao.transitado) : 0;
  return Number.isFinite(n) ? n : 0;
}

// ── Lista de frações com saldo (coluna esquerda) ────────────────────
async function listaFracoes({ condominioId } = {}) {
  if (!condominioId) return [];
  const [fracoes, totQuotas, parcelasExtra, totPagos] = await Promise.all([
    Fracao.findAll({ where: { condominio_id: condominioId }, order: [['designacao', 'ASC']] }),
    Quota.findAll({
      attributes: ['fracao_id', [sequelize.fn('SUM', sequelize.col('valor')), 'total']],
      where: { condominio_id: condominioId, estado: { [Op.ne]: 'anulada' } },
      group: ['fracao_id'],
      raw: true,
    }),
    ExtraQuotaParcela.findAll({
      attributes: ['id', 'fracao_id', 'valor'],
      where: { estado: { [Op.ne]: 'anulada' } },
      include: [
        {
          model: ExtraQuota,
          as: 'extra_quota',
          attributes: [],
          where: { condominio_id: condominioId, estado: 'processada' },
          required: true,
        },
      ],
      raw: true,
    }),
    Pagamento.findAll({
      attributes: ['fracao_id', [sequelize.fn('SUM', sequelize.col('valor')), 'total']],
      where: { condominio_id: condominioId, estado: 'confirmado' },
      group: ['fracao_id'],
      raw: true,
    }),
  ]);

  const mapa = (rows, campoId, campoValor) => {
    const m = new Map();
    for (const r of rows || []) {
      const key = r[campoId] != null ? Number(r[campoId]) : null;
      if (key === null) continue;
      m.set(key, (m.get(key) || 0) + Math.round(toCents(Number(r[campoValor]) || 0)));
    }
    return m;
  };
  const quotaC = mapa(totQuotas, 'fracao_id', 'total');
  const pagoC = mapa(totPagos, 'fracao_id', 'total');
  const parcelaC = new Map();
  for (const p of parcelasExtra || []) {
    const key = Number(p.fracao_id);
    parcelaC.set(key, (parcelaC.get(key) || 0) + Math.round(toCents(Number(p.valor) || 0)));
  }

  const linhas = fracoes
    .map((f) => {
      const transitadoC = Math.round(toCents(valorTransitado(f)));
      const saldoC = transitadoC + (quotaC.get(f.id) || 0) + (parcelaC.get(f.id) || 0) - (pagoC.get(f.id) || 0);
      return {
        id: f.id,
        designacao: f.designacao,
        andar: f.andar,
        porta: f.porta,
        estado: f.estado,
        transitado: fromCents(transitadoC),
        saldoC,
        saldo: fromCents(saldoC),
        emDivida: saldoC > EPS,
        temCredito: saldoC < -EPS,
      };
    })
    .sort((a, b) => String(a.designacao).localeCompare(String(b.designacao), 'pt'));
  return linhas;
}

// ── Detalhe da Conta-corrente de uma fração ─────────────────────────
async function contaCorrenteFracao({ condominioId, fracaoId } = {}) {
  if (!condominioId || !fracaoId) throw new Error('condominioId e fracaoId são obrigatórios.');
  const fracao = await Fracao.findOne({ where: { id: fracaoId, condominio_id: condominioId } });
  if (!fracao) throw new Error('Fração não encontrada neste condomínio.');

  const [quotas, parcelas, pagamentos] = await Promise.all([
    // Quotas ordinárias emitidas (não anuladas) — débitos.
    Quota.findAll({
      where: { condominio_id: condominioId, fracao_id: fracaoId, estado: { [Op.ne]: 'anulada' } },
      order: [['ano', 'ASC'], ['mes', 'ASC']],
    }),
    // Parcelas de Quota Extra da fração cuja quota extra está processada
    // (imputadas/cobráveis) e não anuladas — débitos.
    ExtraQuotaParcela.findAll({
      where: { fracao_id: fracaoId, estado: { [Op.ne]: 'anulada' } },
      include: [
        {
          model: ExtraQuota,
          as: 'extra_quota',
          required: true,
          attributes: ['id', 'designacao', 'estado', 'condominio_id', 'processado_em', 'numero_parcelas'],
          where: { condominio_id: condominioId, estado: 'processada' },
        },
      ],
      order: [['data_vencimento', 'ASC'], ['id', 'ASC']],
    }),
    // Pagamentos CONFIRMADOS da fração — créditos (um por pagamento).
    Pagamento.findAll({
      where: { condominio_id: condominioId, fracao_id: fracaoId, estado: 'confirmado' },
      order: [['data_pagamento', 'ASC'], ['id', 'ASC']],
      include: [{ model: MetodoPagamento, as: 'metodo_pagamento', attributes: ['nome'], required: false }],
    }),
  ]);

  const quotaIds = quotas.map((q) => q.id);
  const parcelaIds = parcelas.map((p) => p.id);

  // Valor confirmado aplicado por quota/parcela (distribuição real via
  // PagamentoQuota / PagamentoExtraParcela — a base das métricas "em dívida").
  const { pagoPorQuota, pagoPorParcela } = require('./recibos');
  const [pagoQ, pagoP] = await Promise.all([pagoPorQuota(quotaIds), pagoPorParcela(parcelaIds)]);

  // Composição de cada pagamento (quotas/parcelas a que foi aplicado) e
  // recibos que o documentam (contexto textual — nunca movimentos).
  const pagIds = pagamentos.map((p) => p.id);
  const [alq, alx] = await Promise.all([
    pagIds.length
      ? PagamentoQuota.findAll({ where: { pagamento_id: { [Op.in]: pagIds } }, attributes: ['pagamento_id', 'quota_id'], raw: true })
      : [],
    pagIds.length
      ? PagamentoExtraParcela.findAll({ where: { pagamento_id: { [Op.in]: pagIds } }, attributes: ['pagamento_id', 'extra_quota_parcela_id'], raw: true })
      : [],
  ]);
  const porQuota = new Map(quotas.map((q) => [q.id, q]));
  const porParcela = new Map(parcelas.map((p) => [p.id, p]));
  const porPagQuotas = new Map();
  for (const a of alq) {
    const q = porQuota.get(Number(a.quota_id));
    if (!q) continue;
    if (!porPagQuotas.has(Number(a.pagamento_id))) porPagQuotas.set(Number(a.pagamento_id), []);
    porPagQuotas.get(Number(a.pagamento_id)).push(`Quota ${MESES_CURTO[(q.mes || 1) - 1]} ${q.ano}`);
  }
  const porPagParcelas = new Map();
  for (const a of alx) {
    const p = porParcela.get(Number(a.extra_quota_parcela_id));
    if (!p) continue;
    if (!porPagParcelas.has(Number(a.pagamento_id))) porPagParcelas.set(Number(a.pagamento_id), []);
    const e = p.extra_quota;
    porPagParcelas.get(Number(a.pagamento_id)).push(`${e ? e.designacao : 'Quota extraordinária'} (Parcela ${p.parcela_numero})`);
  }

  // Recibos (RCP) que cobrem quotas/parcelas pagas deste histórico — só texto.
  let recibosPorPagamento = new Map();
  try {
    const qCob = quotaIds.length
      ? await ReciboQuota.findAll({ where: { quota_id: { [Op.in]: quotaIds } }, attributes: ['quota_id', 'recibo_id'], raw: true })
      : [];
    const pCob = parcelaIds.length
      ? await ReciboExtraParcela.findAll({ where: { extra_quota_parcela_id: { [Op.in]: parcelaIds } }, attributes: ['extra_quota_parcela_id', 'recibo_id'], raw: true })
      : [];
    const idsRec = [...new Set([...qCob.map((c) => Number(c.recibo_id)), ...pCob.map((c) => Number(c.recibo_id))])];
    const recibos = idsRec.length
      ? await Recibo.findAll({ where: { id: { [Op.in]: idsRec }, condominio_id: condominioId, fracao_id: fracaoId, estado: 'emitido' }, attributes: ['id', 'codigo'], raw: true })
      : [];
    const reciboPorId = new Map(recibos.map((r) => [Number(r.id), r.codigo]));
    const quotasDeRecibo = new Map();
    for (const c of qCob) {
      if (!quotasDeRecibo.has(Number(c.quota_id))) quotasDeRecibo.set(Number(c.quota_id), []);
      const cod = reciboPorId.get(Number(c.recibo_id));
      if (cod) quotasDeRecibo.get(Number(c.quota_id)).push(cod);
    }
    const parcelasDeRecibo = new Map();
    for (const c of pCob) {
      if (!parcelasDeRecibo.has(Number(c.extra_quota_parcela_id))) parcelasDeRecibo.set(Number(c.extra_quota_parcela_id), []);
      const cod = reciboPorId.get(Number(c.recibo_id));
      if (cod) parcelasDeRecibo.get(Number(c.extra_quota_parcela_id)).push(cod);
    }
    // Mapa pagamento_id → códigos de recibo que documentam as suas aplicações.
    const pidsParaCodigos = new Map();
    for (const a of alq) {
      const cods = quotasDeRecibo.get(Number(a.quota_id)) || [];
      for (const c of cods) {
        if (!pidsParaCodigos.has(Number(a.pagamento_id))) pidsParaCodigos.set(Number(a.pagamento_id), new Set());
        pidsParaCodigos.get(Number(a.pagamento_id)).add(c);
      }
    }
    for (const a of alx) {
      const cods = parcelasDeRecibo.get(Number(a.extra_quota_parcela_id)) || [];
      for (const c of cods) {
        if (!pidsParaCodigos.has(Number(a.pagamento_id))) pidsParaCodigos.set(Number(a.pagamento_id), new Set());
        pidsParaCodigos.get(Number(a.pagamento_id)).add(c);
      }
    }
    recibosPorPagamento = pidsParaCodigos;
  } catch (err) {
    // Contexto de recibos é best-effort — nunca bloqueia a Conta-corrente.
    recibosPorPagamento = new Map();
  }

  // ── Entradas do extrato ───────────────────────────────────────────
  const entradas = [];
  for (const q of quotas) {
    const data =
      fmtDataISO(q.data_vencimento) ||
      fmtDataISO(q.data_emissao) ||
      `${q.ano}-${pad2(q.mes)}-01`;
    entradas.push({
      tipo: 'quota',
      dataISO: data,
      rotulo: `Quota de ${MESES_NOME[(q.mes || 1) - 1]} ${q.ano}`,
      detalhe: [q.numero_documento ? `Doc. ${q.numero_documento}` : '', q.data_vencimento ? `Venc. ${String(q.data_vencimento).slice(0, 10)}` : '']
        .filter(Boolean)
        .join(' · '),
      debito: Number(q.valor) || 0,
      credito: 0,
    });
  }
  for (const p of parcelas) {
    const extra = p.extra_quota;
    const data = fmtDataISO(p.data_vencimento) || fmtDataISO(extra.processado_em) || null;
    entradas.push({
      tipo: 'parcela',
      dataISO: data,
      rotulo: `Quota extraordinária — ${extra.designacao}`,
      detalhe: `Parcela ${p.parcela_numero}${extra.numero_parcelas ? ` de ${extra.numero_parcelas}` : ''}${p.data_vencimento ? ` · Venc. ${String(p.data_vencimento).slice(0, 10)}` : ''}`,
      debito: Number(p.valor) || 0,
      credito: 0,
    });
  }
  for (const pag of pagamentos) {
    const aplicado = [
      ...(porPagQuotas.get(pag.id) || []).slice(0, 3),
      ...(porPagParcelas.get(pag.id) || []).slice(0, 3),
    ];
    const mais = (porPagQuotas.get(pag.id) || []).length + (porPagParcelas.get(pag.id) || []).length - aplicado.length;
    const cods = [...(recibosPorPagamento.get(pag.id) || [])];
    const detalhePartes = [
      pag.metodo_pagamento && pag.metodo_pagamento.nome ? `Via ${pag.metodo_pagamento.nome}` : '',
      aplicado.length ? `Aplicado: ${aplicado.join('; ')}${mais > 0 ? ` (+${mais})` : ''}` : '',
      cods.length ? `Recibo ${cods.slice(0, 2).join(', ')}${cods.length > 2 ? ` (+${cods.length - 2})` : ''}` : '',
    ].filter(Boolean);
    entradas.push({
      tipo: 'pagamento',
      dataISO: fmtDataISO(pag.data_pagamento),
      rotulo: `Pagamento — ${pag.numero_documento || `PAG-${pag.id}`}`,
      detalhe: detalhePartes.join(' · '),
      debito: 0,
      credito: Number(pag.valor) || 0,
    });
  }

  const extrato = construirExtrato({ transitado: valorTransitado(fracao), entradas });

  // ── Métricas ───────────────────────────────────────────────────────
  const quotasEmDividaC = quotas.reduce((s, q) => s + Math.max(0, toCents(q.valor) - (pagoQ.get(q.id) || 0)), 0);
  const extrasEmDividaC = parcelas.reduce((s, p) => s + Math.max(0, toCents(p.valor) - (pagoP.get(p.id) || 0)), 0);
  const totalPagoC = pagamentos.reduce((s, p) => s + toCents(p.valor), 0);
  const totalQuotasC = quotas.reduce((s, q) => s + toCents(q.valor), 0);
  const totalExtrasC = parcelas.reduce((s, p) => s + toCents(p.valor), 0);
  const transitadoC = Math.round(toCents(valorTransitado(fracao)));

  const anos = new Set();
  for (const q of quotas) anos.add(q.ano);
  for (const p of parcelas) if (p.data_vencimento) anos.add(anoDeISO(String(p.data_vencimento).slice(0, 10)));
  for (const pag of pagamentos) if (pag.data_pagamento) anos.add(anoDeISO(String(pag.data_pagamento).slice(0, 10)));
  if (transitadoC !== 0 && !anos.size) anos.add(new Date().getFullYear());

  return {
    fracao: {
      id: fracao.id,
      designacao: fracao.designacao,
      andar: fracao.andar,
      porta: fracao.porta,
      estado: fracao.estado,
    },
    transitado: fromCents(transitadoC),
    saldo: fromCents(extrato.saldoC),
    saldoC: extrato.saldoC,
    emDivida: extrato.saldoC > EPS,
    temCredito: extrato.saldoC < -EPS,
    quotasEmDivida: fromCents(quotasEmDividaC),
    quotasEmDividaC,
    extrasEmDivida: fromCents(extrasEmDividaC),
    extrasEmDividaC,
    totalQuotas: fromCents(totalQuotasC),
    totalExtras: fromCents(totalExtrasC),
    totalPago: fromCents(totalPagoC),
    totalPagoC,
    nQuotas: quotas.length,
    nParcelas: parcelas.length,
    nPagamentos: pagamentos.length,
    extrato,
    anos: [...anos].sort((a, b) => b - a),
  };
}

// Anos disponíveis para o seletor do extrato (quotas, parcelas e pagamentos
// do condomínio ativo).
async function anosContaCorrente({ condominioId } = {}) {
  if (!condominioId) return [];
  const anos = new Set();
  const [qAnos, pAnos] = await Promise.all([
    Quota.findAll({
      attributes: [[sequelize.fn('DISTINCT', sequelize.col('ano')), 'ano']],
      where: { condominio_id: condominioId, estado: { [Op.ne]: 'anulada' } },
      raw: true,
    }),
    ExtraQuotaParcela.findAll({
      attributes: [[sequelize.fn('YEAR', sequelize.col('data_vencimento')), 'ano']],
      where: { data_vencimento: { [Op.ne]: null } },
      include: [
        {
          model: ExtraQuota,
          as: 'extra_quota',
          attributes: [],
          where: { condominio_id: condominioId, estado: 'processada' },
          required: true,
        },
      ],
      raw: true,
    }),
  ]);
  for (const r of qAnos) if (r.ano != null) anos.add(Number(r.ano));
  for (const r of pAnos) if (r.ano != null) anos.add(Number(r.ano));
  const pgAnos = await Pagamento.findAll({
    attributes: [[sequelize.fn('YEAR', sequelize.col('data_pagamento')), 'ano']],
    where: { condominio_id: condominioId, estado: 'confirmado', data_pagamento: { [Op.ne]: null } },
    raw: true,
  });
  for (const r of pgAnos) if (r.ano != null) anos.add(Number(r.ano));
  return [...anos].sort((a, b) => b - a);
}

module.exports = {
  construirExtrato,
  filtrarExtratoPorAno,
  listaFracoes,
  contaCorrenteFracao,
  anosContaCorrente,
  valorTransitado,
  MESES_NOME,
};
