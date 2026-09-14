const { Op } = require('sequelize');
const {
  Quota,
  Pagamento,
  Despesa,
  ContaBancaria,
  Orcamento,
  OrcamentoRubrica,
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
// condominioId (opcional, multi-condomínio): restringe contas/pagamentos/
// despesas/quotas ao condomínio ativo; sem ele mantém o comportamento
// legado de instalação com um único condomínio.
async function resumoCondominio(condominioId) {
  const onde = condominioId ? { condominio_id: condominioId } : {};
  const contas = await ContaBancaria.findAll({ where: { ativa: true, ...onde } });
  const saldosContas = await Promise.all(contas.map((c) => saldoConta(c)));

  const totalInicialC = contas.reduce((s, c) => s + toCents(c.saldo_inicial), 0);
  const totalReceitasC = toCents(
    await Pagamento.sum('valor', { where: { estado: 'confirmado', ...onde } })
  );
  const totalDespesasC = toCents(
    await Despesa.sum('valor', { where: { estado: { [Op.ne]: 'anulada' }, ...onde } })
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
    await Quota.sum('valor', { where: { estado: { [Op.ne]: 'anulada' }, ...onde } })
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

// Execução do orçamento de um ano.
//
// MULTI-CONDOMÍNIO: `condominioId` é obrigatório na prática — o orçamento
// orçamentado é lido do modelo ATUAL (`orcamentos` + `orcamento_rubricas`), que
// tem `condominio_id`, e as despesas são filtradas pelo mesmo condomínio. Sem
// âmbito definido devolvem-se zeros em vez de somar todos os condomínios (a
// versão anterior somava `orcamento_itens` — tabela legada, sem condomínio, já
// migrada para o modelo novo e partilhada por todos os condomínios).
async function resumoOrcamento(ano = new Date().getFullYear(), condominioId = null) {
  if (!condominioId) {
    return { ano, orcamentado: 0, executado: 0, percentagem: 0 };
  }
  const [orcamento, executado] = await Promise.all([
    Orcamento.findOne({
      where: { condominio_id: condominioId, ano, estado: { [Op.ne]: 'anulado' } },
      include: [{ model: OrcamentoRubrica, as: 'rubricas', where: { ativo: true }, required: false }],
      order: [['data_inicio', 'DESC']],
    }),
    Despesa.sum('valor', { where: { condominio_id: condominioId, competencia_ano: ano, estado: { [Op.ne]: 'anulada' } } }),
  ]);
  const orcamentadoC = (orcamento ? orcamento.rubricas || [] : []).reduce((s, r) => s + toCents(r.valor_anual), 0);
  const executadoC = toCents(executado);
  const eC = orcamentadoC ? Math.round((executadoC / orcamentadoC) * 100) : 0;
  return {
    ano,
    orcamentado: fromCents(orcamentadoC),
    executado: fromCents(executadoC),
    percentagem: orcamentadoC > 0 ? eC : 0,
  };
}

module.exports = { estadoEfetivo, resumoFracao, saldoConta, resumoCondominio, resumoOrcamento, ESTADOS_PENDENTES };
