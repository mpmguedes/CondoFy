// ─────────────────────────────────────────────────────────────────────
// Recibos formais do módulo Quotas (RCP-ANO-NNNN).
//
// Um recibo cobre meses (quotas) já pagos de uma fração. Cada mês só pode
// ser emitido até ao valor ainda não coberto (pago − recibos válidos); anular
// um recibo devolve o valor dos meses ao estado "por emitir" sem eliminar o
// histórico. Pagamentos parciais de um mês são suportados.
//
// Regras garantidas aqui:
//  · nunca emitir acima do valor efetivamente pago e ainda não coberto
//    (por mês e no total — um recibo "tudo junto" distribui pelos meses);
//  · um mês sem valor disponível (pago já totalmente coberto) não é emitível;
//  · a soma dos valores aplicados aos meses (ReciboQuota) é sempre igual ao
//    valor do recibo;
//  · emissão idempotente por mês (nunca duplica cobertura);
//  · anulação apenas marca o recibo (auditoria/histórico preservados).
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Recibo, ReciboQuota, Numeracao, PagamentoQuota, Pagamento, MetodoPagamento } = require('../models');
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

// Código único do recibo (ex.: "RCP-2026-0009").
function formatarCodigo(ano, sequencia) {
  return `RCP-${ano}-${formatarNumero(sequencia)}`;
}

// Código de verificação estável e único por recibo (ex.: "2026-E8D57089").
// Deriva deterministicamente do código RCP (único por recibo) — nunca é
// regenerado ao reabrir o PDF e fica guardado na BD.
function gerarCodigoVerificacao(ano, codigo) {
  const hash = crypto.createHash('sha1').update(`gescondu:recibo:${codigo}`).digest('hex').slice(0, 8).toUpperCase();
  return `${ano}-${hash}`;
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

// Pagamentos CONFIRMADOS que aplicaram valor às quotas indicadas — para o
// recibo mostrar os métodos/datas/referências REAIS (um ou vários pagamentos).
async function pagamentosDasQuotas(quotaIds) {
  if (!quotaIds || !quotaIds.length) return [];
  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: { [Op.in]: quotaIds } },
    include: [
      {
        model: Pagamento,
        as: 'pagamento',
        required: true,
        include: [{ model: MetodoPagamento, as: 'metodo_pagamento' }],
      },
    ],
  });
  const porPagamento = new Map();
  for (const a of aplicacoes) {
    const p = a.pagamento;
    if (!p || p.estado !== 'confirmado') continue;
    const item = porPagamento.get(p.id) || {
      id: p.id,
      numero_documento: p.numero_documento,
      data_pagamento: p.data_pagamento,
      referencia: p.referencia || '',
      metodo: p.metodo_pagamento ? p.metodo_pagamento.nome : '—',
      valorC: 0,
    };
    item.valorC += toCents(a.valor_aplicado);
    porPagamento.set(p.id, item);
  }
  return [...porPagamento.values()].map((p) => ({
    id: p.id,
    numero_documento: p.numero_documento,
    data_pagamento: p.data_pagamento,
    referencia: p.referencia,
    metodo: p.metodo,
    valor: fromCents(p.valorC),
  }));
}

// Quotas de uma (ou todas as) fração(ões) com saldo de emissão:
//  · pago      — valor confirmado aplicado (PagamentoQuota → Pagamento confirmado);
//  · coberto   — valor já coberto por recibos VÁLIDOS (anulados não contam);
//  · disponível— pago − coberto (nunca negativo);
//  · pode      — disponível > 0 (pode ser emitido; parciais suportados).
// Devolve sempre TODAS as quotas (meses sem pagamento incluídos) para a
// interface mostrar a situação completa; a seleção só é permitida quando pode.
async function quotasComSaldo({ fracaoId, ano, condominioId } = {}) {
  const where = { estado: { [Op.ne]: 'anulada' } };
  if (fracaoId) where.fracao_id = fracaoId;
  if (ano) where.ano = ano;
  if (condominioId) where.condominio_id = condominioId; // isolamento por condomínio
  const quotas = await Quota.findAll({ where, order: [['ano', 'ASC'], ['mes', 'ASC']] });
  if (!quotas.length) return [];
  const ids = quotas.map((q) => q.id);
  const [pagoMap, cobertoMap] = await Promise.all([pagoPorQuota(ids), cobertoPorQuota(ids)]);

  return quotas.map((q) => {
    const pagoC = pagoMap.get(q.id) || 0;
    const cobertoC = cobertoMap.get(q.id) || 0;
    const disponivelC = Math.max(0, pagoC - cobertoC);
    return {
      fracaoId: q.fracao_id,
      quotaId: q.id,
      ano: q.ano,
      mes: q.mes,
      valor: fromCents(toCents(q.valor)),
      valor_base: fromCents(toCents(q.valor_base)),
      valor_fcr: fromCents(toCents(q.valor_fcr)),
      pago: fromCents(pagoC),
      coberto: fromCents(cobertoC),
      disponivel: fromCents(disponivelC),
      pode: disponivelC > EPS,
    };
  });
}

// Meses com valor disponível (para emissão) de uma fração.
async function mesesPorEmitir(fracaoId, { ano } = {}) {
  const linhas = await quotasComSaldo({ fracaoId, ano });
  return linhas.filter((l) => l.pode);
}

// Resumo "por emitir" por fração (tabela Fração | Pago | Enviado | Por emitir).
//  · Pago / Enviado: totais confirmados (e parcela já enviada em recibos);
//  · Por emitir: soma do valor disponível (pago − coberto por recibos válidos);
//  · meses: número de meses com valor disponível.
async function porEmitirPorFracao({ ano, condominioId } = {}) {
  const linhas = await quotasComSaldo({ ano, condominioId });
  if (!linhas.length) return [];
  const ids = [...new Set(linhas.map((l) => l.quotaId))];
  const enviadoMap = await coberturaPorQuota(ids, { apenasEnviados: true });

  const porFracao = new Map();
  for (const l of linhas) {
    const agg = porFracao.get(l.fracaoId) || { fracaoId: l.fracaoId, pagoC: 0, cobertoC: 0, enviadoC: 0, disponivelC: 0, meses: 0 };
    agg.pagoC += toCents(l.pago);
    agg.cobertoC += toCents(l.coberto);
    agg.enviadoC += enviadoMap.get(l.quotaId) || 0;
    agg.disponivelC += toCents(l.disponivel);
    if (l.pode) agg.meses += 1;
    porFracao.set(l.fracaoId, agg);
  }
  return [...porFracao.values()]
    .filter((a) => a.disponivelC > EPS)
    .map((a) => ({
      fracaoId: a.fracaoId,
      pago: fromCents(a.pagoC),
      coberto: fromCents(a.cobertoC),
      enviado: fromCents(a.enviadoC),
      porEmitir: fromCents(a.disponivelC),
      meses: a.meses,
    }));
}

// Detalhe por fração: TODOS os meses (com quota) com pago/coberto/disponível —
// para a modal mostrar a situação completa (meses sem disponível visíveis e
// não selecionáveis).
async function detalhePorEmitir({ ano, condominioId } = {}) {
  const linhas = await quotasComSaldo({ ano, condominioId });
  const mapa = new Map();
  for (const l of linhas) {
    if (!mapa.has(l.fracaoId)) mapa.set(l.fracaoId, []);
    mapa.get(l.fracaoId).push(l);
  }
  return [...mapa.entries()].map(([fracaoId, meses]) => ({ fracaoId, meses }));
}

// ── Emissão ─────────────────────────────────────────────────────────

// Emite recibos para uma fração sobre os meses indicados.
// Parâmetros:
//  · meses: [{ quotaId, ano, mes, valor, valor_base, valor_fcr, limite (valor pago disponível) }]
//  · modo: 'plano' | 'mes' | 'selecionar' (um recibo por cada mês selecionado)
//          ou 'unico' (um único recibo com os meses selecionados)
//  · valorGlobal: valor do recibo único (≤ soma dos limites)
//  · tipo: 'ordinario' | 'extraordinario'
// Devolve os recibos criados (já com as coberturas).
async function emitirRecibos({ fracaoId, meses, modo = 'mes', valorGlobal, tipo = 'ordinario', userId, ano, condominioId }) {
  const MODOS_VALIDOS = ['plano', 'unico', 'mes', 'selecionar'];
  if (!MODOS_VALIDOS.includes(modo)) {
    throw new Error('Modo de distribuição inválido.');
  }
  // Multi-condomínio: o condomínio vem SEMPRE do contexto ativo da rota
  // (req.condominioId) — nunca é opcional nem inferido de outro contexto.
  if (!condominioId) {
    throw new Error('condominioId é obrigatório para emitir recibos.');
  }
  const reciboUnico = modo === 'unico';
  const t = await sequelize.transaction();
  try {
    // Validações dentro da transação: os meses continuam disponíveis?
    const quotaIds = meses.map((m) => m.quotaId);
    if (!quotaIds.length) throw new Error('Selecione pelo menos um mês.');

    const quotas = await Quota.findAll({
      // Só quotas do condomínio ATIVO (bloqueia IDs de outro condomínio).
      where: { id: { [Op.in]: quotaIds }, fracao_id: fracaoId, condominio_id: condominioId, estado: { [Op.ne]: 'anulada' } },
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
      const disponivelC = Math.max(0, pagoC - cobertoC);
      return {
        quotaId: q.id,
        ano: q.ano,
        mes: q.mes,
        valor: fromCents(toCents(q.valor)),
        valor_base: fromCents(toCents(q.valor_base)),
        valor_fcr: fromCents(toCents(q.valor_fcr)),
        pagoC,
        cobertoC,
        limiteC: disponivelC,
      };
    });

    // Segurança: um mês só pode ser emitido até ao valor disponível (pago − já
    // coberto por recibos válidos); parciais são suportados.
    if (disponiveis.some((m) => m.limiteC <= EPS)) {
      throw new Error('Um ou mais meses selecionados já estão sem valor disponível (cobertos por recibo ou sem pagamento). Atualize a página e tente novamente.');
    }

    let alocacoes;
    if (reciboUnico) {
      const valorC = toCents(valorGlobal);
      const totalLimiteC = disponiveis.reduce((s, m) => s + m.limiteC, 0);
      if (valorC <= 0) throw new Error('Indique o valor a emitir.');
      if (valorC > totalLimiteC + EPS) throw new Error('O recibo não pode ser emitido acima do valor pago disponível.');
      alocacoes = alocarMeses({ modo: 'unico', meses: disponiveis, valorGlobalC: valorC });
      if (!alocacoes.length) throw new Error('Valor a emitir insuficiente para qualquer mês.');
    } else {
      alocacoes = alocarMeses({ modo: 'mes', meses: disponiveis });
    }

    const anoNum = ano || new Date().getFullYear();
    const criados = [];
    const hoje = new Date().toISOString().slice(0, 10);

    if (reciboUnico) {
      const { codigo, numero } = await proximoReciboNumero({ ano: anoNum, transaction: t });
      const totalC = alocacoes.reduce((s, a) => s + a.valorC, 0);
      const recibo = await Recibo.create(
        {
          condominio_id: condominioId,
          fracao_id: fracaoId,
          codigo,
          codigo_verificacao: gerarCodigoVerificacao(anoNum, codigo),
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
            condominio_id: condominioId,
            fracao_id: fracaoId,
            codigo,
            codigo_verificacao: gerarCodigoVerificacao(anoNum, codigo),
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
  gerarCodigoVerificacao,
  periodoLabel,
  partilharValor,
  alocarMeses,
  pagoPorQuota,
  cobertoPorQuota,
  pagamentosDasQuotas,
  mesesPorEmitir,
  porEmitirPorFracao,
  detalhePorEmitir,
  emitirRecibos,
  anularRecibo,
};
