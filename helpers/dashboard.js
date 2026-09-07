const { Op } = require('sequelize');
const {
  Quota,
  Pagamento,
  PagamentoQuota,
  ExtraQuotaParcela,
  Orcamento,
  OrcamentoRubrica,
  PlanoQuota,
} = require('../models');
const { toCents, fromCents } = require('./money');
const { estadoEfetivo } = require('./saldos');

function rangeMes(ano, mes) {
  const m = String(mes).padStart(2, '0');
  return [`${ano}-${m}-01`, `${ano}-${m}-31`];
}

// Resumo financeiro de um mês: quotas previstas (incl. FCR), parcelas extra
// previstas e recebidas (pagamentos confirmados no mês).
// condominioId (opcional, multi-condomínio): restringe ao condomínio ativo.
async function resumoFinanceiroMes(ano, mes, condominioId) {
  const [ini, fim] = rangeMes(ano, mes);
  const onde = condominioId ? { condominio_id: condominioId } : {};

  const [quotasMes, extraMes, recebidas] = await Promise.all([
    Quota.findAll({ where: { ano, mes, estado: { [Op.ne]: 'anulada' }, ...onde } }),
    ExtraQuotaParcela.findAll({
      where: { data_vencimento: { [Op.gte]: ini, [Op.lte]: fim }, estado: { [Op.ne]: 'anulada' } },
      include: condominioId
        ? [{ model: require('../models').ExtraQuota, as: 'extra_quota', attributes: [], where: { condominio_id: condominioId }, required: true }]
        : [],
    }),
    Pagamento.sum('valor', {
      where: { estado: 'confirmado', data_pagamento: { [Op.gte]: ini, [Op.lte]: fim }, ...onde },
    }),
  ]);

  const previstasC = quotasMes.reduce((s, q) => s + toCents(q.valor), 0);
  const extraC = extraMes.reduce((s, p) => s + toCents(p.valor), 0);

  return {
    previstas: fromCents(previstasC),
    extra: fromCents(extraC),
    recebidas: fromCents(toCents(recebidas)),
  };
}

// Total e contagem de quotas vencidas (em atraso), considerando apenas o que
// ainda está por pagar.
async function resumoEmAtraso(condominioId) {
  const onde = condominioId ? { condominio_id: condominioId } : {};
  const quotas = await Quota.findAll({
    where: { estado: { [Op.in]: ['pendente', 'parcialmente_paga', 'vencida'] }, ...onde },
  });

  const ids = quotas.map((q) => q.id);
  const aplicacoes = ids.length
    ? await PagamentoQuota.findAll({
        where: { quota_id: ids },
        include: [
          { model: Pagamento, as: 'pagamento', attributes: [], where: { estado: 'confirmado' }, required: true },
        ],
        raw: true,
      })
    : [];

  const pagoC = {};
  aplicacoes.forEach((a) => {
    pagoC[a.quota_id] = (pagoC[a.quota_id] || 0) + toCents(a.valor_aplicado);
  });

  let totalC = 0;
  let count = 0;
  for (const q of quotas) {
    if (estadoEfetivo(q) === 'vencida') {
      const emAberto = toCents(q.valor) - (pagoC[q.id] || 0);
      if (emAberto > 0) {
        totalC += emAberto;
        count += 1;
      }
    }
  }

  return { total: fromCents(totalC), count };
}

// Orçamento cujo ano de início corresponde ao ano indicado (ou null), com os
// totais previstos: despesas (rubricas), receitas (plano emitido/planeado) e saldo.
// Orçamentos ANULADOS nunca são apresentados como o orçamento corrente do ano.
async function orcamentoDoAno(ano, condominioId) {
  const onde = condominioId
    ? { condominio_id: condominioId, estado: { [Op.ne]: 'anulado' } }
    : { estado: { [Op.ne]: 'anulado' } };
  const orcamentos = await Orcamento.findAll({
    where: onde,
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
    order: [['data_inicio', 'ASC']],
  });
  const orcamento = orcamentos.find((o) => new Date(o.data_inicio).getFullYear() === ano) || null;
  if (!orcamento) return null;

  const despesasC = orcamento.rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
  const plano = await PlanoQuota.findAll({
    where: { orcamento_id: orcamento.id, estado: { [Op.ne]: 'cancelada' } },
    raw: true,
  });
  const receitasC = plano.reduce((s, p) => s + toCents(p.valor), 0);

  return {
    ...orcamento.toJSON(),
    despesasPrevistas: fromCents(despesasC),
    receitasPrevistas: fromCents(receitasC),
    saldoPrevisto: fromCents(receitasC - despesasC),
  };
}

module.exports = { resumoFinanceiroMes, resumoEmAtraso, orcamentoDoAno };
