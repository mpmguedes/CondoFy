const { Op } = require('sequelize');
const {
  Quota,
  Pagamento,
  Despesa,
  ContaBancaria,
  OrcamentoItem,
} = require('../models');
const { toCents, fromCents } = require('./money');
const { saldoContaMovimentos } = require('./movimentos');

// Estado efetivo de uma quota: 'vencida' quando passa o vencimento sem estar paga.
function estadoEfetivo(quota) {
  if (!quota) return null;
  if (quota.estado === 'anulada' || quota.estado === 'paga') return quota.estado;
  if (quota.data_vencimento) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const vencimento = new Date(quota.data_vencimento);
    vencimento.setHours(0, 0, 0, 0);
    if (hoje > vencimento) return 'vencida';
  }
  return quota.estado;
}

const ESTADOS_PENDENTES = ['pendente', 'parcialmente_paga', 'vencida'];

// Resumo financeiro de uma fração (valores em euros).
async function resumoFracao(fracaoId) {
  const [totalQuotas, totalPago] = await Promise.all([
    Quota.sum('valor', { where: { fracao_id: fracaoId, estado: { [Op.ne]: 'anulada' } } }),
    Pagamento.sum('valor', { where: { fracao_id: fracaoId, estado: 'confirmado' } }),
  ]);
  const quotas = await Quota.findAll({
    where: { fracao_id: fracaoId, estado: { [Op.ne]: 'anulada' } },
    order: [['ano', 'DESC'], ['mes', 'DESC']],
  });
  const ultimoPagamento = await Pagamento.findOne({
    where: { fracao_id: fracaoId, estado: 'confirmado' },
    order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
  });

  const totalQuotasC = toCents(totalQuotas);
  const totalPagoC = toCents(totalPago);
  return {
    totalQuotas: fromCents(totalQuotasC),
    totalPago: fromCents(totalPagoC),
    emDivida: fromCents(totalQuotasC - totalPagoC),
    quotasPagas: quotas.filter((q) => q.estado === 'paga').length,
    quotasPendentes: quotas.filter((q) => ESTADOS_PENDENTES.includes(estadoEfetivo(q))).length,
    quotasVencidas: quotas.filter((q) => estadoEfetivo(q) === 'vencida').length,
    ultimoPagamento: ultimoPagamento
      ? { valor: fromCents(toCents(ultimoPagamento.valor)), data: ultimoPagamento.data_pagamento }
      : null,
  };
}

// Saldo de uma conta bancária calculado pelos movimentos (saldo inicial + entradas − saídas).
async function saldoConta(conta) {
  return saldoContaMovimentos(conta);
}

// Resumo financeiro global do condomínio.
async function resumoCondominio() {
  const contas = await ContaBancaria.findAll({ where: { ativa: true } });
  const saldosContas = await Promise.all(contas.map((c) => saldoConta(c)));

  const totalInicialC = contas.reduce((s, c) => s + toCents(c.saldo_inicial), 0);
  const totalReceitasC = toCents(
    await Pagamento.sum('valor', { where: { estado: 'confirmado' } })
  );
  const totalDespesasC = toCents(
    await Despesa.sum('valor', { where: { estado: { [Op.ne]: 'anulada' } } })
  );

  let fundoReservaC = 0;
  const contasComSaldo = contas.map((c, i) => {
    if (c.tipo === 'fundo_reserva') {
      fundoReservaC += toCents(String(saldosContas[i]));
    }
    return {
      id: c.id,
      nome: c.nome,
      banco: c.banco,
      iban: c.iban,
      tipo: c.tipo,
      saldo: saldosContas[i],
    };
  });

  const totalQuotasC = toCents(
    await Quota.sum('valor', { where: { estado: { [Op.ne]: 'anulada' } } })
  );
  const emDividaGlobalC = totalQuotasC - totalReceitasC;

  return {
    saldoContas: fromCents(totalInicialC + totalReceitasC - totalDespesasC),
    fundoReserva: fromCents(fundoReservaC),
    receitas: fromCents(totalReceitasC),
    despesas: fromCents(totalDespesasC),
    emDividaGlobal: fromCents(emDividaGlobalC),
    contas: contasComSaldo,
  };
}

// Execução global do orçamento de um ano.
async function resumoOrcamento(ano = new Date().getFullYear()) {
  const [orcamentado, executado] = await Promise.all([
    OrcamentoItem.sum('valor_orcamentado', { where: { ano } }),
    Despesa.sum('valor', { where: { competencia_ano: ano, estado: { [Op.ne]: 'anulada' } } }),
  ]);
  const oC = toCents(orcamentado);
  const eC = toCents(executado);
  return {
    ano,
    orcamentado: fromCents(oC),
    executado: fromCents(eC),
    percentagem: oC > 0 ? Math.round((eC / oC) * 100) : 0,
  };
}

module.exports = { estadoEfetivo, resumoFracao, saldoConta, resumoCondominio, resumoOrcamento, ESTADOS_PENDENTES };
