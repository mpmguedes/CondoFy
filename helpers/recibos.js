// ─────────────────────────────────────────────────────────────────────
// Recibos formais do módulo Quotas (RCP-ANO-NNNN).
//
// Um recibo cobre meses (quotas) já pagos de uma fração. Cada mês só pode
// estar coberto por recibos válidos (estado='emitido'); anular um recibo
// devolve os meses ao estado "por emitir" sem eliminar o histórico.
//
// Regras garantidas aqui:
//  · nunca emitir acima do valor efetivamente pago (por mês e no total);
//  · um mês já coberto por recibo válido não volta a ser emitível;
//  · emissão idempotente por mês (substituição nunca duplica cobertura);
//  · anulação apenas marca o recibo (auditoria/histórico preservados).
// ─────────────────────────────────────────────────────────────────────
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Recibo, ReciboQuota, Numeracao, PagamentoQuota, Pagamento } = require('../models');
const { toCents, fromCents } = require('./money');

const EPS = 1; // 1 cêntimo

// Abreviaturas PT-PT de 3 letras para os meses.
const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// ── Formatação (pura, testável) ─────────────────────────────────────

// Rótulo compacto de período: "Jan 2026", "Jan–Mar 2026" ou
// "Dez 2025 – Fev 2026" quando abrange vários meses contíguos.
function periodoLabel(meses) {
  const lista = (meses || [])
    .filter((m) => m && m.ano && m.mes)
    .sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
  if (!lista.length) return '—';
  const curto = (m) => `${MESES_CURTO[(m.mes || 1) - 1]} ${m.ano}`;
  if (lista.length === 1) return curto(lista[0]);

  let contiguo = true;
  for (let i = 1; i < lista.length; i++) {
    const anterior = lista[i - 1].ano * 12 + lista[i - 1].mes;
    const atual = lista[i].ano * 12 + lista[i].mes;
    if (atual !== anterior + 1) {
      contiguo = false;
      break;
    }
  }
  if (contiguo) {
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    if (primeiro.ano === ultimo.ano) {
      return `${MESES_CURTO[primeiro.mes - 1]}–${MESES_CURTO[ultimo.mes - 1]} ${ultimo.ano}`;
    }
    return `${curto(primeiro)} – ${curto(ultimo)}`;
  }
  return lista.map(curto).join(', ');
}

// Número sequencial legível (ex.: 0006).
function formatarNumero(sequencia) {
  return String(sequencia || 0).padStart(4, '0');
}

// Código único (ex.: RCP-2026-0006).
function formatarCodigo(ano, sequencia) {
  return `RCP-${ano}-${formatarNumero(sequencia)}`;
}

// Proporção base/FCR de um valor parcial de um mês (regra de três simples).
function partilharValor(mes, valorC) {
  const totalC = toCents(mes.valor);
  if (totalC <= 0) return { baseC: 0, fcrC: 0 };
  const fracao = valorC / totalC;
  return {
    baseC: Math.round(toCents(mes.valor_base) * fracao),
    fcrC: Math.round(toCents(mes.valor_fcr) * fracao),
  };
}

// Distribui um valor global pelos meses selecionados (ordem cronológica):
//  · modo 'mes'  — um recibo por mês: cada mês fica com todo o seu valor
//                  disponível (limite), um recibo por mês;
//  · modo 'unico' — um único recibo: preenche meses completos por ordem até
//                  esgotar o valor; o último mês pode ficar parcial.
// Devolve [{ quotaId, valorC }] com valorC>0.
function alocarMeses({ modo, meses, valorGlobalC = 0 }) {
  const ordenados = [...meses].sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
  const resultado = [];
  if (modo === 'unico') {
    let restanteC = Math.max(0, valorGlobalC);
    for (const m of ordenados) {
      if (restanteC <= 0) break;
      const aplicarC = Math.min(m.limiteC, restanteC);
      if (aplicarC > 0) {
        resultado.push({ quotaId: m.quotaId, valorC: aplicarC });
        restanteC -= aplicarC;
      }
    }
    return resultado;
  }
  // modo 'mes' (ou 'plano'): um recibo por mês selecionado, com o valor total
  // disponível desse mês.
  for (const m of ordenados) {
    if (m.limiteC > 0) resultado.push({ quotaId: m.quotaId, valorC: m.limiteC });
  }
  return resultado;
}

// ── Numeração RCP (sequência própria, nunca reutilizada) ───────────
// Incrementa a sequência do ano (linha numeracoes tipo 'recibo_mensal') e
// devolve { codigo, numero }. Padrão idêntico ao helpers/numeracao.js
// (row lock FOR UPDATE + criação quando a linha do ano não existe).
async function proximoReciboNumero({ ano, transaction } = {}) {
  const anoNum = ano || new Date().getFullYear();
  const t = transaction || (await sequelize.transaction());
  let own = false;
  if (!transaction) {
    own = true;
  }
  try {
    let numeracao = await Numeracao.findOne({
      where: { tipo_documento: 'recibo_mensal', ano: anoNum },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!numeracao) {
      numeracao = await Numeracao.create(
        { tipo_documento: 'recibo_mensal', ano: anoNum, sequencia: 0, formato: 'RCP-{ano}-{sequencia}' },
        { transaction: t }
      );
    }
    const sequencia = numeracao.sequencia + 1;
    await numeracao.update({ sequencia }, { transaction: t });
    if (own) await t.commit();
    return { ano: anoNum, numero: formatarNumero(sequencia), codigo: formatarCodigo(anoNum, sequencia) };
  } catch (err) {
    if (own) await t.rollback();
    throw err;
  }
}

// ── Pagamentos aplicados / cobertura por mês (quota) ────────────────

// Valor confirmado aplicado por quota (PagamentoQuota → Pagamento confirmado).
async function pagoPorQuota(quotaIds) {
  const mapa = new Map();
  if (!quotaIds.length) return mapa;
  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: { [Op.in]: quotaIds } },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'], where: { estado: 'confirmado' }, required: true }],
    raw: true,
  });
  for (const a of aplicacoes) {
    mapa.set(a.quota_id, (mapa.get(a.quota_id) || 0) + toCents(a.valor_aplicado));
  }
  return mapa;
}

// Valor coberto por recibos VÁLIDOS por quota (anulados não contam).
// com apenasEnviados=true, conta apenas a cobertura de recibos já enviados.
async function coberturaPorQuota(quotaIds, { apenasEnviados = false } = {}) {
  const mapa = new Map();
  if (!quotaIds.length) return mapa;
  const whereRecibo = { estado: 'emitido' };
  if (apenasEnviados) whereRecibo.enviado_at = { [Op.ne]: null };
  const coberturas = await ReciboQuota.findAll({
    where: { quota_id: { [Op.in]: quotaIds } },
    include: [{ model: Recibo, as: 'recibo', attributes: ['estado', 'enviado_at'], where: whereRecibo, required: true }],
    raw: true,
  });
  for (const c of coberturas) {
    mapa.set(c.quota_id, (mapa.get(c.quota_id) || 0) + toCents(c.valor));
  }
  return mapa;
}

// Valor coberto por recibos válidos (export público).
async function cobertoPorQuota(quotaIds) {
  return coberturaPorQuota(quotaIds);
}

// Varredura única das quotas pagas mas ainda não cobertas (por emitir).
async function varreduraPorEmitir({ fracaoId, ano } = {}) {
  const where = { estado: { [Op.ne]: 'anulada' } };
  if (fracaoId) where.fracao_id = fracaoId;
  if (ano) where.ano = ano;
  const quotas = await Quota.findAll({ where, order: [['ano', 'ASC'], ['mes', 'ASC']] });
  if (!quotas.length) return [];
  const ids = quotas.map((q) => q.id);
  const [pagoMap, cobertoMap] = await Promise.all([pagoPorQuota(ids), cobertoPorQuota(ids)]);

  const resultado = [];
  for (const q of quotas) {
    const pagoC = pagoMap.get(q.id) || 0;
    const cobertoC = cobertoMap.get(q.id) || 0;
    // Um mês já coberto por qualquer recibo válido não volta a ser emitível.
    if (pagoC <= 0 || cobertoC > EPS) continue;
    resultado.push({
      fracaoId: q.fracao_id,
      quotaId: q.id,
      ano: q.ano,
      mes: q.mes,
      valor: fromCents(toCents(q.valor)),
      valor_base: fromCents(toCents(q.valor_base)),
      valor_fcr: fromCents(toCents(q.valor_fcr)),
      pago: fromCents(pagoC),
      coberto: fromCents(cobertoC),
      porEmitir: fromCents(pagoC),
    });
  }
  return resultado;
}

// Meses pagos mas ainda não totalmente cobertos por recibo (por emitir).
// Devolve [{ quotaId, ano, mes, valor, valor_base, valor_fcr, pago, coberto, porEmitir, periodo }].
async function mesesPorEmitir(fracaoId, { ano } = {}) {
  const linhas = await varreduraPorEmitir({ fracaoId, ano });
  return linhas.map((l) => ({ ...l, periodo: new Date(l.ano, l.mes - 1, 1) }));
}

// Resumo "por emitir" por fração (tabela Fração | Pago | Enviado | Por emitir).
//  · Pago: total confirmado pago pela fração;
//  · Enviado: parcela já coberta por recibos válidos e enviados;
//  · Por emitir: parcela paga ainda sem recibo (recibos válidos não contam).
async function porEmitirPorFracao({ ano } = {}) {
  const where = { estado: { [Op.ne]: 'anulada' } };
  if (ano) where.ano = ano;
  const quotas = await Quota.findAll({ where, attributes: ['id', 'fracao_id'] });
  if (!quotas.length) return [];
  const ids = quotas.map((q) => q.id);
  const [pagoMap, cobertoMap, enviadoMap] = await Promise.all([
    pagoPorQuota(ids),
    cobertoPorQuota(ids),
    coberturaPorQuota(ids, { apenasEnviados: true }),
  ]);

  const porFracao = new Map();
  for (const q of quotas) {
    const pagoC = pagoMap.get(q.id) || 0;
    const cobertoC = cobertoMap.get(q.id) || 0;
    const enviadoC = enviadoMap.get(q.id) || 0;
    const agg = porFracao.get(q.fracao_id) || { fracaoId: q.fracao_id, pagoC: 0, cobertoC: 0, enviadoC: 0, porEmitirC: 0 };
    agg.pagoC += pagoC;
    agg.cobertoC += cobertoC;
    agg.enviadoC += enviadoC;
    agg.porEmitirC += pagoC - cobertoC;
    porFracao.set(q.fracao_id, agg);
  }
  return [...porFracao.values()]
    .filter((a) => a.porEmitirC > EPS)
    .map((a) => ({
      fracaoId: a.fracaoId,
      pago: fromCents(a.pagoC),
      coberto: fromCents(a.cobertoC),
      enviado: fromCents(a.enviadoC),
      porEmitir: fromCents(a.porEmitirC),
    }));
}

// Por emitir com detalhe por fração (meses disponíveis para a modal).
async function detalhePorEmitir({ ano } = {}) {
  const linhas = await varreduraPorEmitir({ ano });
  const mapa = new Map();
  for (const l of linhas) {
    if (!mapa.has(l.fracaoId)) mapa.set(l.fracaoId, []);
    mapa.get(l.fracaoId).push({ ...l, periodo: new Date(l.ano, l.mes - 1, 1) });
  }
  return [...mapa.entries()].map(([fracaoId, meses]) => ({ fracaoId, meses }));
}

// ── Emissão ─────────────────────────────────────────────────────────

// Emite recibos para uma fração sobre os meses indicados.
// Parâmetros:
//  · meses: [{ quotaId, ano, mes, valor, valor_base, valor_fcr, limite (valor pago disponível) }]
//  · modo: 'mes' (um recibo por mês) | 'unico' (um recibo com tudo)
//  · valorGlobal: valor do recibo único (≤ soma dos limites)
//  · tipo: 'ordinario' | 'extraordinario'
// Devolve os recibos criados (já com as coberturas).
async function emitirRecibos({ fracaoId, meses, modo = 'mes', valorGlobal, tipo = 'ordinario', userId, ano }) {
  const t = await sequelize.transaction();
  try {
    // Validações dentro da transação: os meses continuam disponíveis?
    const quotaIds = meses.map((m) => m.quotaId);
    if (!quotaIds.length) throw new Error('Selecione pelo menos um mês.');

    const quotas = await Quota.findAll({
      where: { id: { [Op.in]: quotaIds }, fracao_id: fracaoId, estado: { [Op.ne]: 'anulada' } },
      order: [['ano', 'ASC'], ['mes', 'ASC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (quotas.length !== quotaIds.length) throw new Error('Um dos meses selecionados já não está disponível.');

    const [pagoMap, cobertoMap] = await Promise.all([
      pagoPorQuota(quotaIds),
      cobertoPorQuota(quotaIds),
    ]);

    const disponiveis = quotas.map((q) => {
      const pagoC = pagoMap.get(q.id) || 0;
      const cobertoC = cobertoMap.get(q.id) || 0;
      return {
        quotaId: q.id,
        ano: q.ano,
        mes: q.mes,
        valor: fromCents(toCents(q.valor)),
        valor_base: fromCents(toCents(q.valor_base)),
        valor_fcr: fromCents(toCents(q.valor_fcr)),
        pagoC,
        cobertoC,
        limiteC: pagoC,
      };
    });

    if (disponiveis.some((m) => m.cobertoC > EPS)) {
      throw new Error('Um dos meses selecionados já está coberto por um recibo válido.');
    }
    if (disponiveis.some((m) => m.limiteC <= EPS)) {
      throw new Error('Um dos meses selecionados não tem valor pago disponível.');
    }

    let alocacoes;
    if (modo === 'unico') {
      const valorC = toCents(valorGlobal);
      const totalLimiteC = disponiveis.reduce((s, m) => s + m.limiteC, 0);
      if (valorC <= 0) throw new Error('Indique o valor a emitir.');
      if (valorC > totalLimiteC + EPS) throw new Error('O recibo não pode ser emitido acima do valor pago.');
      alocacoes = alocarMeses({ modo: 'unico', meses: disponiveis, valorGlobalC: valorC });
      if (!alocacoes.length) throw new Error('Valor a emitir insuficiente para qualquer mês.');
    } else {
      alocacoes = alocarMeses({ modo: 'mes', meses: disponiveis });
    }

    const anoNum = ano || new Date().getFullYear();
    const criados = [];
    const hoje = new Date().toISOString().slice(0, 10);

    if (modo === 'unico') {
      const { codigo, numero } = await proximoReciboNumero({ ano: anoNum, transaction: t });
      const totalC = alocacoes.reduce((s, a) => s + a.valorC, 0);
      const recibo = await Recibo.create(
        {
          fracao_id: fracaoId,
          codigo,
          numero,
          ano: anoNum,
          tipo,
          valor: fromCents(totalC),
          data_emissao: hoje,
          estado: 'emitido',
          created_by: userId || null,
        },
        { transaction: t }
      );
      for (const a of alocacoes) {
        const mes = disponiveis.find((m) => m.quotaId === a.quotaId);
        const { baseC, fcrC } = partilharValor(mes, a.valorC);
        await ReciboQuota.create(
          {
            recibo_id: recibo.id,
            quota_id: a.quotaId,
            valor: fromCents(a.valorC),
            valor_base: fromCents(baseC),
            valor_fcr: fromCents(fcrC),
          },
          { transaction: t }
        );
      }
      criados.push(recibo);
    } else {
      for (const a of alocacoes) {
        const mes = disponiveis.find((m) => m.quotaId === a.quotaId);
        const { codigo, numero } = await proximoReciboNumero({ ano: anoNum, transaction: t });
        const recibo = await Recibo.create(
          {
            fracao_id: fracaoId,
            codigo,
            numero,
            ano: anoNum,
            tipo,
            valor: fromCents(a.valorC),
            data_emissao: hoje,
            estado: 'emitido',
            created_by: userId || null,
          },
          { transaction: t }
        );
        const { baseC, fcrC } = partilharValor(mes, a.valorC);
        await ReciboQuota.create(
          {
            recibo_id: recibo.id,
            quota_id: a.quotaId,
            valor: fromCents(a.valorC),
            valor_base: fromCents(baseC),
            valor_fcr: fromCents(fcrC),
          },
          { transaction: t }
        );
        criados.push(recibo);
      }
    }

    await t.commit();
    return criados;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// Anula um recibo: devolve os meses a "por emitir" e mantém o histórico.
async function anularRecibo(reciboId, { motivo, userId } = {}) {
  const t = await sequelize.transaction();
  try {
    const recibo = await Recibo.findByPk(reciboId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!recibo) throw new Error('Recibo não encontrado.');
    if (recibo.estado === 'anulado') return false;
    await recibo.update(
      {
        estado: 'anulado',
        motivo_anulacao: (motivo && String(motivo).trim()) || null,
      },
      { transaction: t }
    );
    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = {
  formatarNumero,
  formatarCodigo,
  periodoLabel,
  partilharValor,
  alocarMeses,
  pagoPorQuota,
  cobertoPorQuota,
  mesesPorEmitir,
  porEmitirPorFracao,
  detalhePorEmitir,
  emitirRecibos,
  anularRecibo,
};
