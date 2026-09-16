// Fundo Comum de Reserva (FCR) — receção e transferência entre contas.
//
// Ciclo coberto por este módulo:
//   quota com FCR → pagamento → FCR recebido → transferência para a conta FCR
//
// Distinções que este helper NUNCA confunde (nem soma):
//   · FCR EMITIDO   — FCR incluído nas quotas lançadas (Quota.valor_fcr);
//   · FCR RECEBIDO  — FCR da parte de cada quota que foi efetivamente paga
//                     (aplicações de pagamentos CONFIRMADOS, PagamentoQuota);
//   · FCR TRANSFERIDO — transferências já registadas de conta corrente para a
//                     conta do tipo `fundo_reserva` (par saída/entrada com
//                     referencia 'TRANSF');
//   · FCR DISPONÍVEL — recebido − transferido (o que ainda pode ser transferido).
//
// NÃO é dinheiro recebido: `ReciboQuota.valor_fcr` (FCR faturado) e
// `SUM(Quota.valor_fcr)` (FCR emitido). Só as aplicações de pagamentos
// confirmados provam entrada de dinheiro.
//
// A parcela de FCR de um pagamento parcial é PROPORCIONAL à parte da quota que
// foi paga: o FCR de uma quota é sempre `valor_fcr / valor × valor_pago`. É
// aritmética determinística sobre valores históricos e imutáveis da quota
// (`valor` e `valor_fcr` nunca são reescritos depois de emitida), pelo que
// NÃO é preciso inventar uma associação pagamento↔FCR nem alterar o modelo.
//
// Todas as consultas são filtradas pelo condomínio: as quotas e os pagamentos
// têm `condominio_id`; as transferências não têm (os movimentos bancários não
// têm `condominio_id`), pelo que são filtradas pela conta bancária do
// condomínio — a mesma convenção usada em helpers/relatorio-financeiro.js.
const { Op } = require('sequelize');
const {
  ContaBancaria,
  MovimentoBancario,
  Pagamento,
  PagamentoQuota,
  Quota,
} = require('../models');
const { toCents, fromCents } = require('./money');
const { registarTransferencia, saldoContaMovimentos } = require('./movimentos');

// Referência que identifica uma transferência entre contas (os dois movimentos
// — saída na origem e entrada no destino — partilham este valor).
const REF_TRANSFERENCIA = 'TRANSF';

// ── Regra pura: parcela de FCR de uma aplicação de pagamento ───────
// `valorAplicadoC` = parte da quota efetivamente paga (PagamentoQuota).
// `valorQuotaC`/`fcrQuotaC` = componentes guardados na quota (imutáveis).
// Devolve a parcela em cêntimos, arredondada ao cêntimo (nunca superior ao FCR
// da quota).
function fcrDaAplicacaoC({ valorAplicadoC, valorQuotaC, fcrQuotaC }) {
  const aplicado = Math.max(0, Math.round(Number(valorAplicadoC) || 0));
  const total = Math.round(Number(valorQuotaC) || 0);
  const fcr = Math.max(0, Math.round(Number(fcrQuotaC) || 0));
  if (aplicado <= 0 || total <= 0 || fcr <= 0) return 0;
  // Dois limites, pela ordem mais restritiva: a parcela de FCR da quota e o que
  // foi efetivamente pago (a parcela de FCR nunca pode exceder o dinheiro que
  // entrou, mesmo que a quota tenha componentes inconsistentes).
  return Math.min(fcr, aplicado, Math.round((fcr * aplicado) / total));
}

// ── Regra pura: FCR recebido a partir das aplicações confirmadas ───
// `aplicacoes`: [{ quota_id, valor_aplicado }] de pagamentos CONFIRMADOS, já
// restringidas ao condomínio. `quotasPorId`: Map/objeto id → { valor, valor_fcr }.
// Devolve { totalC, porQuotaC: Map<quotaId, cents>, detalhe: [...] }.
function calcularFcrRecebidoC({ aplicacoes = [], quotasPorId = new Map() } = {}) {
  const obter = (id) => (quotasPorId instanceof Map ? quotasPorId.get(Number(id)) : quotasPorId[Number(id)]);
  const porQuotaC = new Map();
  const detalhe = [];
  let totalC = 0;
  for (const a of aplicacoes) {
    const quota = obter(a.quota_id);
    if (!quota) continue;
    const valorAplicadoC = toCents(a.valor_aplicado);
    const fcrC = fcrDaAplicacaoC({
      valorAplicadoC,
      valorQuotaC: toCents(quota.valor),
      fcrQuotaC: toCents(quota.valor_fcr),
    });
    if (fcrC <= 0) continue;
    const quotaId = Number(a.quota_id);
    porQuotaC.set(quotaId, (porQuotaC.get(quotaId) || 0) + fcrC);
    totalC += fcrC;
    detalhe.push({ quotaId, valorAplicadoC, fcrC });
  }
  return { totalC, porQuotaC, detalhe };
}

// ── FCR emitido (informativo): FCR das quotas lançadas do condomínio ──
async function fcrEmitidoC(condominioId, { transaction } = {}) {
  const total = await Quota.sum('valor_fcr', {
    where: { condominio_id: condominioId, estado: { [Op.ne]: 'anulada' } },
    transaction,
  });
  return toCents(total);
}

// ── FCR transferido: transferências já registadas para contas FCR ──
// Uma transferência interna gera SEMPRE uma entrada na conta de destino e uma
// saída com o mesmo valor e data (mesma referência 'TRANSF'). A contagem é
// feita pelas ENTRADAS nas contas do tipo `fundo_reserva` — a conta de destino
// é a única que identifica inequivocamente a operação —, com a saída
// correspondente marcada como consumida para nunca contar o mesmo dinheiro duas
// vezes (nem em dados antigos, nem se existir mais do que uma conta FCR).
async function fcrTransferidoC(condominioId, { transaction, incluirDetalhe = false } = {}) {
  const contas = await ContaBancaria.findAll({
    where: { condominio_id: condominioId },
    attributes: ['id', 'nome', 'tipo'],
    transaction,
  });
  const contasPorId = new Map(contas.map((c) => [Number(c.id), c]));
  const fundoIds = contas.filter((c) => c.tipo === 'fundo_reserva').map((c) => Number(c.id));

  const movimentos = await MovimentoBancario.findAll({
    where: { referencia: REF_TRANSFERENCIA, estado: 'confirmado' },
    attributes: ['id', 'conta_bancaria_id', 'data', 'tipo', 'valor', 'descricao'],
    include: [{ model: ContaBancaria, as: 'conta_bancaria', attributes: ['id', 'condominio_id', 'nome', 'tipo'], where: { condominio_id: condominioId }, required: true }],
    order: [['data', 'ASC'], ['id', 'ASC']],
    transaction,
  });

  const dataISO = (m) => String(m.data || '').slice(0, 10);
  const entradasFcr = movimentos.filter((m) => fundoIds.includes(Number(m.conta_bancaria_id)) && m.tipo !== 'saida');
  const saidas = movimentos.filter((m) => m.tipo !== 'entrada');
  const consumidas = new Set();

  const transferencias = entradasFcr.map((entrada) => {
    // Saída correspondente: mesmo valor e data, preferindo outra conta do
    // condomínio (a origem real da transferência); se não existir, é uma
    // entrada antiga/solta e não é contada como transferência interna.
    const candidatas = saidas.filter(
      (s) => !consumidas.has(s.id) && toCents(s.valor) === toCents(entrada.valor) && dataISO(s) === dataISO(entrada)
    );
    const par =
      candidatas.find((s) => Number(s.conta_bancaria_id) !== Number(entrada.conta_bancaria_id)) ||
      candidatas[0] ||
      null;
    if (par) consumidas.add(par.id);
    return {
      id: entrada.id,
      data: entrada.data,
      valorC: toCents(entrada.valor),
      descricao: entrada.descricao,
      origem: par && contasPorId.get(Number(par.conta_bancaria_id)) ? contasPorId.get(Number(par.conta_bancaria_id)).nome : null,
      contaOrigemId: par ? Number(par.conta_bancaria_id) : null,
      destino: entrada.conta_bancaria ? entrada.conta_bancaria.nome : null,
      contaDestinoId: Number(entrada.conta_bancaria_id),
      registada: Boolean(par),
    };
  });

  const registadas = transferencias.filter((t) => t.registada);
  const totalC = registadas.reduce((s, t) => s + t.valorC, 0);
  // `valor` em euros para as vistas (as vistas formatam com o helper `eur`).
  const comVista = (t) => ({ ...t, valor: fromCents(t.valorC) });
  const ordenadas = transferencias.map(comVista).sort((a, b) => String(b.data).localeCompare(String(a.data)) || b.id - a.id);
  if (!incluirDetalhe) return { totalC, contasFcr: fundoIds, nTransferencias: registadas.length };
  return { totalC, contasFcr: fundoIds, nTransferencias: registadas.length, transferencias: ordenadas };
}

// ── FCR recebido: aplicações de pagamentos CONFIRMADOS do condomínio ──
async function fcrRecebidoC(condominioId, { transaction } = {}) {
  const quotas = await Quota.findAll({
    where: { condominio_id: condominioId },
    attributes: ['id', 'valor', 'valor_fcr'],
    transaction,
  });
  if (!quotas.length) return { totalC: 0, porQuotaC: new Map(), detalhe: [], nQuotas: 0 };
  const quotasPorId = new Map(quotas.map((q) => [Number(q.id), { valor: q.valor, valor_fcr: q.valor_fcr }]));
  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: { [Op.in]: [...quotasPorId.keys()] } },
    attributes: ['quota_id', 'valor_aplicado'],
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['id', 'estado', 'condominio_id'], where: { estado: 'confirmado', condominio_id: condominioId }, required: true }],
    transaction,
  });
  const calculado = calcularFcrRecebidoC({ aplicacoes, quotasPorId });
  return { ...calculado, nQuotas: quotas.length, nAplicacoes: aplicacoes.length };
}

// ── Resumo completo do ciclo do FCR (alimenta a interface) ─────────
// Devolve sempre: emitidoC / recebidoC / transferidoC / disponivelC. Nada aqui
// inventa valores: cada parcela vem de um pagamento confirmado ou de uma
// transferência registada.
async function resumoFcr(condominioId, { transaction, incluirDetalhe = false } = {}) {
  const [emitidoC, recebido, transferido] = await Promise.all([
    fcrEmitidoC(condominioId, { transaction }),
    fcrRecebidoC(condominioId, { transaction }),
    fcrTransferidoC(condominioId, { transaction, incluirDetalhe }),
  ]);
  const disponivelC = Math.max(0, recebido.totalC - transferido.totalC);
  return {
    emitidoC,
    recebidoC: recebido.totalC,
    transferidoC: transferido.totalC,
    disponivelC,
    emitido: fromCents(emitidoC),
    recebido: fromCents(recebido.totalC),
    transferido: fromCents(transferido.totalC),
    disponivel: fromCents(disponivelC),
    nTransferencias: transferido.nTransferencias,
    transferencias: transferido.transferencias || [],
    contasFcrIds: transferido.contasFcr,
    porQuotaC: recebido.porQuotaC,
  };
}

// ── Validação da transferência (pura, sem BD) ──────────────────────
// Ordem das regras: contas existentes (no condomínio) → distintas → destino FCR
// → valor positivo → valor ≤ disponível. Devolve sempre { ok } ou
// { ok:false, motivo, mensagem }.
function validarTransferenciaFcr({
  contaOrigem,
  contaDestino,
  valorC,
  disponivelC = 0,
  saldoOrigemC = null,
}) {
  if (!contaOrigem || !contaDestino) {
    return { ok: false, motivo: 'conta_invalida', mensagem: 'Selecione a conta de origem e a conta do Fundo de Reserva.' };
  }
  if (Number(contaOrigem.id) === Number(contaDestino.id)) {
    return { ok: false, motivo: 'contas_iguais', mensagem: 'A conta de origem e a conta de destino não podem ser a mesma.' };
  }
  if (contaDestino.tipo !== 'fundo_reserva') {
    return { ok: false, motivo: 'destino_nao_fcr', mensagem: 'A conta de destino tem de ser uma conta do tipo Fundo de Reserva.' };
  }
  const valor = Math.round(Number(valorC) || 0);
  if (valor <= 0) {
    return { ok: false, motivo: 'valor_invalido', mensagem: 'Indique um valor positivo para transferir.' };
  }
  if (valor > disponivelC) {
    return {
      ok: false,
      motivo: 'acima_do_disponivel',
      valorC: valor,
      disponivelC,
      mensagem: `O valor excede o FCR recebido e ainda não transferido (${fromCents(disponivelC).toFixed(2).replace('.', ',')} €).`,
    };
  }
  if (saldoOrigemC !== null && valor > saldoOrigemC) {
    return {
      ok: false,
      motivo: 'saldo_origem_insuficiente',
      valorC: valor,
      saldoOrigemC,
      mensagem: 'O valor excede o saldo disponível na conta de origem.',
    };
  }
  return { ok: true, valorC: valor };
}

// ── Transferência corrente → conta FCR (operação atómica) ──────────
// Cria os dois movimentos (saída na origem, entrada no destino) na MESMA
// transação e valida tudo antes de escrever: contas do condomínio, destino
// fundo_reserva, origem ≠ destino, valor positivo e valor ≤ FCR disponível.
// Devolve { saidaId, entradaId, valorC, disponivelC }.
async function transferirFcr({ condominioId, contaOrigemId, contaDestinoId, valorC, data, descricao, userId }) {
  const t = await sequelizeTransaction();
  try {
    const [contaOrigem, contaDestino] = await Promise.all([
      ContaBancaria.findOne({ where: { id: contaOrigemId, condominio_id: condominioId }, transaction: t }),
      ContaBancaria.findOne({ where: { id: contaDestinoId, condominio_id: condominioId }, transaction: t }),
    ]);
    const { totalC: recebidoC } = await fcrRecebidoC(condominioId, { transaction: t });
    const { totalC: transferidoC } = await fcrTransferidoC(condominioId, { transaction: t });
    const disponivelC = Math.max(0, recebidoC - transferidoC);
    // O valor também não pode exceder o que existe na conta de origem (a
    // transferência não pode deixar a conta de origem a descoberto).
    const saldoOrigemC = contaOrigem ? toCents(await saldoContaMovimentos(contaOrigem, { transaction: t })) : 0;

    const decisao = validarTransferenciaFcr({ contaOrigem, contaDestino, valorC, disponivelC, saldoOrigemC });
    if (!decisao.ok) {
      await t.rollback();
      return decisao;
    }

    const ida = await registarTransferencia({
      contaOrigemId: contaOrigem.id,
      contaDestinoId: contaDestino.id,
      valor: fromCents(decisao.valorC),
      data: data || new Date(),
      descricao: descricao || `Transferência de Fundo de Reserva: ${contaOrigem.nome} → ${contaDestino.nome}`,
      userId,
      transaction: t,
    });
    await t.commit();
    return {
      ok: true,
      valorC: decisao.valorC,
      disponivelC: Math.max(0, disponivelC - decisao.valorC),
      saidaId: ida.saidaId,
      entradaId: ida.entradaId,
      contaOrigem: contaOrigem.nome,
      contaDestino: contaDestino.nome,
    };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// A transação vive em config/database; mantida numa função para os testes
// poderem injetar um duplo sem tocar no resto do módulo.
function sequelizeTransaction() {
  return require('../config/database').transaction();
}

module.exports = {
  REF_TRANSFERENCIA,
  fcrDaAplicacaoC,
  calcularFcrRecebidoC,
  validarTransferenciaFcr,
  fcrEmitidoC,
  fcrRecebidoC,
  fcrTransferidoC,
  resumoFcr,
  transferirFcr,
};
