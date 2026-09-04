const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Pagamento, PagamentoQuota } = require('../models');
const { toCents, fromCents } = require('./money');
const { proximoNumero } = require('./numeracao');

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

// Regista um pagamento e distribui-o pelas quotas em aberto (FIFO).
// Devolve { pagamento, excedente } (excedente = valor não aplicado, crédito).
async function registarPagamento({
  fracaoId,
  valor,
  dataPagamento,
  metodoPagamentoId,
  contaBancariaId,
  referencia,
  observacoes,
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
      },
      { transaction: t }
    );

    const quotas = await Quota.findAll({
      where: {
        fracao_id: fracaoId,
        estado: { [Op.in]: ['pendente', 'parcialmente_paga', 'vencida'] },
      },
      order: [['ano', 'ASC'], ['mes', 'ASC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    let restanteC = valorC;
    for (const quota of quotas) {
      if (restanteC <= 0) break;
      const jaPagoC = toCents(
        await PagamentoQuota.sum('valor_aplicado', {
          where: { quota_id: quota.id },
          transaction: t,
        })
      );
      const emAbertoC = toCents(quota.valor) - jaPagoC;
      if (emAbertoC <= 0) continue;

      const aplicarC = Math.min(emAbertoC, restanteC);
      await PagamentoQuota.create(
        {
          pagamento_id: pagamento.id,
          quota_id: quota.id,
          valor_aplicado: fromCents(aplicarC),
        },
        { transaction: t }
      );

      const novoPagoC = jaPagoC + aplicarC;
      await quota.update(
        { estado: novoPagoC >= toCents(quota.valor) ? 'paga' : 'parcialmente_paga' },
        { transaction: t }
      );
      restanteC -= aplicarC;
    }

    await t.commit();
    return { pagamento, excedente: fromCents(restanteC) };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// Anula um pagamento (mantém o número do documento) e recalcula as quotas afetadas.
async function anularPagamento(pagamentoId) {
  const t = await sequelize.transaction();
  try {
    const pagamento = await Pagamento.findByPk(pagamentoId, { transaction: t });
    if (!pagamento || pagamento.estado === 'anulado') {
      await t.rollback();
      return false;
    }
    await pagamento.update({ estado: 'anulado' }, { transaction: t });

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

module.exports = { registarPagamento, anularPagamento, recalcularEstadoQuota };
