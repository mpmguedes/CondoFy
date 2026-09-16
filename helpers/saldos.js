const { Op } = require('sequelize');
const {
  Quota,
  Pagamento,
  Despesa,
  ContaBancaria,
  Orcamento,
  OrcamentoRubrica,
  Fracao,
} = require('../models');
const { toCents, fromCents } = require('./money');
const { saldoContaMovimentos } = require('./movimentos');
// Cálculo canónico do valor aplicado a cada quota (o mesmo do módulo de
// recibos) — evita uma segunda definição de «quota paga» no sistema.
const { pagoPorQuota } = require('./recibos');

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

// ── Situação financeira do condomínio, num ano ──────────────────────
//
// Duas partes, de propósito:
//  · `carregarSituacao` faz as consultas (só o condomínio ativo);
//  · `agregarSituacao` é PURA — recebe o que foi consultado e devolve os
//    números que a página «Situação financeira» mostra. Assim a aritmética
//    fica testável sem base de dados (scripts/test-situacao-financeira.js).
//
// Nada é inventado: cada valor sai de um modelo existente e de um cálculo já
// usado noutras áreas do sistema.
//
// - saldoContas: saldo inicial + pagamentos confirmados − despesas não
//   anuladas = posição de caixa ATUAL (não é o saldo do ano);
// - contas: saldo por conta (por movimentos bancários, via saldoConta);
// - receitasAno / despesasAno: do ano indicado;
// - totalQuotas / pagoQuotas / emDivida / cobrancaPct: quotas emitidas do ano
//   (não anuladas) e o que está efetivamente aplicado a cada uma (pagoPorQuota);
// - nFracoesEmAtraso: apenas uma CONTAGEM de frações com quota vencida por
//   pagar — nunca nomes nem valores de terceiros;
// - executadoC: despesas por competência do ano, para a execução orçamental.
function agregarSituacao({
  ano,
  contas = [],
  saldosContas = [],
  receitas = [],
  despesas = [],
  quotasAno = [],
  pagamentos = [],
  despesasComData = [],
  despesasCompetencia = 0,
  orcamento = null,
  nFracoes = 0,
  pagoPorQuotaMapa = new Map(),
  estadoEfetivoQuota = estadoEfetivo,
} = {}) {
  const centavos = (linhas) => linhas.reduce((s, r) => s + toCents(r.valor), 0);
  const receitasC = centavos(receitas);
  const despesasC = centavos(despesas);

  // Saldo de cada conta, já calculado, e o fundo de reserva (contas desse tipo).
  let fundoReservaC = 0;
  const contasComSaldo = contas.map((c, i) => {
    const saldoC = toCents(saldosContas[i]);
    if (c.tipo === 'fundo_reserva') fundoReservaC += saldoC;
    return { id: c.id, nome: c.nome, banco: c.banco, iban: c.iban, tipo: c.tipo, saldo: fromCents(saldoC) };
  });

  const totalQuotasC = quotasAno.reduce((s, q) => s + toCents(q.valor), 0);
  let pagoQuotasC = 0;
  for (const q of quotasAno) pagoQuotasC += pagoPorQuotaMapa.get(q.id) || 0;

  // Frações com quota vencida e ainda por pagar: só a contagem.
  const emAtraso = new Set();
  for (const q of quotasAno) {
    if (estadoEfetivoQuota(q) !== 'vencida') continue;
    if (toCents(q.valor) - (pagoPorQuotaMapa.get(q.id) || 0) > 0) emAtraso.add(q.fracao_id);
  }

  // Evolução do ano: movimentos reais mês a mês, agregados em memória.
  const contasPorMes = Array(12).fill(0);
  const despesasPorMes = Array(12).fill(0);
  for (const p of pagamentos) {
    const mes = Number(String(p.data_pagamento || '').slice(5, 7));
    if (mes >= 1 && mes <= 12) contasPorMes[mes - 1] += toCents(p.valor);
  }
  for (const d of despesasComData) {
    const mes = Number(String(d.data || '').slice(5, 7));
    if (mes >= 1 && mes <= 12) despesasPorMes[mes - 1] += toCents(d.valor);
  }

  const orcamentadoC = (orcamento ? orcamento.rubricas || [] : []).reduce((s, r) => s + toCents(r.valor_anual), 0);
  // Posição de caixa atual: o que as contas tinham no início + o que entrou
  // (pagamentos confirmados) − o que saiu (despesas não anuladas). É o mesmo
  // critério de `resumoCondominio`, agora com as contas do condomínio ativo.
  const saldoInicialC = contas.reduce((s, c) => s + toCents(c.saldo_inicial), 0);

  return {
    ano,
    saldoContas: fromCents(saldoInicialC + receitasC - despesasC),
    receitasAno: fromCents(receitasC),
    despesasAno: fromCents(despesasC),
    saldoAno: fromCents(receitasC - despesasC),
    totalQuotas: fromCents(totalQuotasC),
    pagoQuotas: fromCents(pagoQuotasC),
    emDivida: fromCents(totalQuotasC - pagoQuotasC),
    cobrancaPct: totalQuotasC > 0 ? Math.round((pagoQuotasC / totalQuotasC) * 100) : 0,
    nFracoesEmAtraso: emAtraso.size,
    nFracoes,
    contas: contasComSaldo,
    fundoReserva: fromCents(fundoReservaC),
    orcamentado: fromCents(orcamentadoC),
    executadoC: toCents(despesasCompetencia),
    contasPorMes,
    despesasPorMes,
  };
}

// Sem condomínio ativo não se soma nada: zeros em vez dos dados de todos.
function situacaoVazia(ano) {
  return {
    ano,
    saldoContas: 0,
    receitasAno: 0,
    despesasAno: 0,
    saldoAno: 0,
    totalQuotas: 0,
    pagoQuotas: 0,
    emDivida: 0,
    cobrancaPct: 0,
    nFracoesEmAtraso: 0,
    nFracoes: 0,
    contas: [],
    fundoReserva: 0,
    orcamentado: 0,
    executadoC: 0,
    contasPorMes: Array(12).fill(0),
    despesasPorMes: Array(12).fill(0),
  };
}

// MULTI-CONDOMÍNIO: `condominioId` entra em todas as consultas (incluindo as
// contas bancárias, que só são lidas dentro do condomínio ativo).
async function resumoFinanceiro(ano = new Date().getFullYear(), condominioId = null) {
  if (!condominioId) return situacaoVazia(ano);

  const inicio = `${ano}-01-01`;
  const fim = `${ano}-12-31`;
  const onde = { condominio_id: condominioId };

  const contas = await ContaBancaria.findAll({ where: { ativa: true, ...onde }, order: [['id', 'ASC']] });
  const saldosContas = await Promise.all(contas.map((c) => saldoConta(c)));

  const [receitas, despesas, quotasAno, pagamentos, despesasComData, despesasCompetencia, orcamento, nFracoes] =
    await Promise.all([
      Pagamento.findAll({
        where: { condominio_id: condominioId, estado: 'confirmado', data_pagamento: { [Op.between]: [inicio, fim] } },
        attributes: ['valor'],
        raw: true,
      }),
      Despesa.findAll({
        where: { condominio_id: condominioId, estado: { [Op.ne]: 'anulada' }, data: { [Op.between]: [inicio, fim] } },
        attributes: ['valor'],
        raw: true,
      }),
      Quota.findAll({ where: { ...onde, ano, estado: { [Op.ne]: 'anulada' } }, raw: true }),
      Pagamento.findAll({
        where: { condominio_id: condominioId, estado: 'confirmado', data_pagamento: { [Op.between]: [inicio, fim] } },
        attributes: ['valor', 'data_pagamento'],
        raw: true,
      }),
      Despesa.findAll({
        where: { condominio_id: condominioId, estado: { [Op.ne]: 'anulada' }, data: { [Op.between]: [inicio, fim] } },
        attributes: ['valor', 'data'],
        raw: true,
      }),
      Despesa.sum('valor', { where: { condominio_id: condominioId, competencia_ano: ano, estado: { [Op.ne]: 'anulada' } } }),
      Orcamento.findOne({
        where: { condominio_id: condominioId, ano, estado: { [Op.ne]: 'anulado' } },
        include: [{ model: OrcamentoRubrica, as: 'rubricas', where: { ativo: true }, required: false }],
        order: [['data_inicio', 'DESC']],
      }),
      Fracao.count({ where: onde }),
    ]);

  // O que está aplicado a cada quota do ano (base das métricas de dívida).
  const pagoPorQuotaMapa = await pagoPorQuota(quotasAno.map((q) => q.id));

  return agregarSituacao({
    ano,
    contas,
    saldosContas,
    receitas,
    despesas,
    quotasAno,
    pagamentos,
    despesasComData,
    despesasCompetencia,
    orcamento,
    nFracoes,
    pagoPorQuotaMapa,
  });
}

// Evolução mensal a partir dos totais já apurados (não faz consultas).
function evolucaoMensal({ contasPorMes = [], despesasPorMes = [] } = {}) {
  const meses = [];
  let totalContasC = 0;
  let totalDespesasC = 0;
  for (let i = 0; i < 12; i += 1) {
    const entradasC = contasPorMes[i] || 0;
    const saidasC = despesasPorMes[i] || 0;
    totalContasC += entradasC;
    totalDespesasC += saidasC;
    meses.push({
      mes: i + 1,
      contas: fromCents(entradasC),
      despesas: fromCents(saidasC),
      saldo: fromCents(entradasC - saidasC),
      temMovimentos: entradasC !== 0 || saidasC !== 0,
    });
  }
  return {
    meses,
    temMovimentos: meses.some((m) => m.temMovimentos),
    mesesComMovimentos: meses.filter((m) => m.temMovimentos).length,
    totalContas: fromCents(totalContasC),
    totalDespesas: fromCents(totalDespesasC),
  };
}

module.exports = {
  estadoEfetivo,
  resumoFracao,
  saldoConta,
  resumoCondominio,
  resumoOrcamento,
  resumoFinanceiro,
  agregarSituacao,
  evolucaoMensal,
  ESTADOS_PENDENTES,
};
