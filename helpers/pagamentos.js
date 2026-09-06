const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Pagamento, PagamentoQuota, MovimentoBancario } = require('../models');
const { toCents, fromCents } = require('./money');
const { proximoNumero } = require('./numeracao');
const { criarMovimento } = require('./movimentos');

// Recalcula o estado de uma quota a partir dos pagamentos confirmados.
async function recalcularEstadoQuota(quotaId, transaction) {
  const quota = await Quota.findByPk(quotaId, { transaction });
  if (!quota || quota.estado === 'anulada') return;

  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: quotaId },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
    transaction,
  });
  const pagoC = aplicacoes
    .filter((a) => a.pagamento && a.pagamento.estado === 'confirmado')
    .reduce((s, a) => s + toCents(a.valor_aplicado), 0);

  const valorC = toCents(quota.valor);
  let estado;
  if (pagoC >= valorC) estado = 'paga';
  else if (pagoC > 0) estado = 'parcialmente_paga';
  else estado = 'pendente';

  await quota.update({ estado }, { transaction });
}

// Pura, testável: soma por quota apenas aplicações cujo pagamento está
// confirmado. Aplicações de pagamentos anulados ficam no histórico mas nunca
// contam para saldos/estados/disponibilidade.
function somarAplicacoesConfirmadas(aplicacoes) {
  const mapa = new Map();
  for (const a of aplicacoes || []) {
    if (!a || !a.pagamento || a.pagamento.estado !== 'confirmado') continue;
    mapa.set(a.quota_id, (mapa.get(a.quota_id) || 0) + toCents(a.valor_aplicado));
  }
  return mapa;
}

// Distribuição FIFO (pura, testável): quotas já ordenadas por ano/mês.
// pagoConfirmadoC: Map quota_id → cêntimos já pagos (APENAS pagamentos
// confirmados — aplicações de pagamentos anulados não contam).
// Devolve { alocacoes: [{quotaId, jaPagoC, aplicarC, novoPagoC}], restanteC }.
function alocarFIFO({ quotas, pagoConfirmadoC = new Map(), valorC }) {
  const alocacoes = [];
  let restanteC = Math.max(0, Number(valorC) || 0); // já em cêntimos
  for (const quota of quotas) {
    if (restanteC <= 0) break;
    const jaPagoC = pagoConfirmadoC.get(quota.id) || 0;
    const emAbertoC = toCents(quota.valor) - jaPagoC;
    if (emAbertoC <= 0) continue; // quota sem saldo real em aberto (confirmado)
    const aplicarC = Math.min(emAbertoC, restanteC);
    if (aplicarC > 0) {
      alocacoes.push({ quotaId: quota.id, jaPagoC, aplicarC, novoPagoC: jaPagoC + aplicarC });
      restanteC -= aplicarC;
    }
  }
  return { alocacoes, restanteC };
}

// Regista um pagamento e distribui-o pelas quotas em aberto (FIFO).
// Cria o movimento bancário de entrada quando há conta bancária.
// comprovativo (opcional): { ficheiro, nome, mime } — ficheiro já gravado em
// storage/comprovativos pelo upload; fica associado com estado 'pendente'.
// Devolve { pagamento, excedente } (excedente = valor não aplicado, crédito).
async function registarPagamento({
  fracaoId,
  valor,
  dataPagamento,
  metodoPagamentoId,
  contaBancariaId,
  referencia,
  observacoes,
  userId,
  comprovativo,
}) {
  const t = await sequelize.transaction();
  try {
    const valorC = toCents(valor);
    const numero = await proximoNumero('recibo', { transaction: t });

    const pagamento = await Pagamento.create(
      {
        numero_documento: numero,
        fracao_id: fracaoId,
        conta_bancaria_id: contaBancariaId || null,
        metodo_pagamento_id: metodoPagamentoId || null,
        valor: fromCents(valorC),
        data_pagamento: dataPagamento || new Date(),
        referencia,
        observacoes,
        estado: 'confirmado',
        ...(comprovativo
          ? {
              comprovativo_ficheiro: comprovativo.ficheiro,
              comprovativo_nome: comprovativo.nome,
              comprovativo_mime: comprovativo.mime,
              comprovativo_estado: 'pendente',
              comprovativo_motivo: null,
              comprovativo_data: new Date(),
            }
          : {}),
      },
      { transaction: t }
    );

    if (contaBancariaId) {
      await criarMovimento({
        contaBancariaId,
        data: dataPagamento || new Date(),
        tipo: 'entrada',
        valor: fromCents(valorC),
        descricao: `Pagamento ${numero}`,
        referencia,
        pagamentoId: pagamento.id,
        userId,
        transaction: t,
      });
    }

    // Todas as quotas da fração (não anuladas), por ordem cronológica — a
    // distribuição é FIFO sobre o SALDO REAL em aberto (confirmado), nunca
    // sobre o estado guardado (que pode estar desatualizado/artificial).
    const quotas = await Quota.findAll({
      where: { fracao_id: fracaoId, estado: { [Op.ne]: 'anulada' } },
      order: [['ano', 'ASC'], ['mes', 'ASC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!quotas.length) {
      await t.commit();
      return { pagamento, excedente: fromCents(valorC) };
    }

    // Valor efetivamente pago por quota — só aplicações de pagamentos
    // CONFIRMADOS (anulados mantêm-se no histórico mas nunca contam).
    const ids = quotas.map((q) => q.id);
    const aplicacoes = await PagamentoQuota.findAll({
      where: { quota_id: { [Op.in]: ids } },
      include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
      transaction: t,
    });
    const pagoConfirmadoC = somarAplicacoesConfirmadas(aplicacoes);

    const { alocacoes, restanteC } = alocarFIFO({ quotas, pagoConfirmadoC, valorC });
    for (const aloc of alocacoes) {
      await PagamentoQuota.create(
        {
          pagamento_id: pagamento.id,
          quota_id: aloc.quotaId,
          valor_aplicado: fromCents(aloc.aplicarC),
        },
        { transaction: t }
      );
      const quota = quotas.find((q) => q.id === aloc.quotaId);
      if (quota) {
        await quota.update(
          { estado: aloc.novoPagoC >= toCents(quota.valor) ? 'paga' : 'parcialmente_paga' },
          { transaction: t }
        );
      }
    }

    await t.commit();
    return { pagamento, excedente: fromCents(restanteC) };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// Anula um pagamento (mantém o número do documento) e recalcula as quotas afetadas.
// Anula também o movimento bancário de entrada associado.
async function anularPagamento(pagamentoId) {
  const t = await sequelize.transaction();
  try {
    const pagamento = await Pagamento.findByPk(pagamentoId, { transaction: t });
    if (!pagamento || pagamento.estado === 'anulado') {
      await t.rollback();
      return false;
    }
    await pagamento.update({ estado: 'anulado' }, { transaction: t });

    const movimento = await MovimentoBancario.findOne({
      where: { pagamento_id: pagamento.id, estado: 'confirmado' },
      transaction: t,
    });
    if (movimento) {
      await movimento.update({ estado: 'anulado' }, { transaction: t });
    }

    const aplicacoes = await PagamentoQuota.findAll({
      where: { pagamento_id: pagamento.id },
      transaction: t,
    });
    const quotaIds = [...new Set(aplicacoes.map((a) => a.quota_id))];
    for (const qid of quotaIds) {
      await recalcularEstadoQuota(qid, t);
    }
    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = { registarPagamento, anularPagamento, recalcularEstadoQuota, alocarFIFO, somarAplicacoesConfirmadas };
