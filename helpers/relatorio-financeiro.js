// ─────────────────────────────────────────────────────────────────────
// Relatório Financeiro (Balancete Financeiro do Condomínio).
//
// Motor de cálculo, em cêntimos inteiros, sobre a estrutura financeira que já
// existe no GesCondu — NÃO inventa entidades, campos nem relações.
//
// Definições usadas (todas derivadas do código existente):
//  · RECEITAS
//      – Rubricas: "Quotas ordinárias — <ano>" (uma por ano do período) e uma
//        linha por Quota Extra processada. As quotas ordinárias não têm
//        subdivisão por rubrica de orçamento na base de dados (só quota.valor e
//        quota.valor_fcr), pelo que agrupar por rubrica de orçamento seria
//        inventar dados.
//      – Orçamentado = valor previsto para o período (ver `orcamentado…`).
//      – Lançado    = Σ quotas/parcelas emitidas e não anuladas com competência
//                     no período.
//      – Recebido   = Σ valores aplicados por Pagamento confirmado
//                     (PagamentoQuota.valor_aplicado / PagamentoExtraParcela.
//                     valor_aplicado) às quotas/parcelas do período.
//      – Em dívida  = Lançado − Recebido (da rubrica no período).
//  · DESPESAS
//      – Rubricas: as rubricas de despesa configuradas no condomínio
//        (orcamento_rubricas do(s) orçamento(s) que cobrem o período), ligadas
//        por categoria_id, mais as categorias efetivamente usadas em despesas
//        do período que não tenham rubrica correspondente. NUNCA há lista
//        fixa de rubricas.
//      – Orçamentado = valor anual da rubrica rateado pelo período, segundo a
//                      periodicidade da rubrica (mesma regra de helpers/plano.js).
//      – Faturado    = Σ Despesa.valor (estado ≠ 'anulada') com competência no
//                      período. Vários fornecedores na mesma rubrica aparecem
//                      somados numa só linha.
//      – Pago        = ver `pagoDaDespesa` (PagamentoFornecedor estado 'pago' ou
//                      despesa marcada como 'paga').
//      – Por pagar   = Faturado − Pago.
//  · SÍNTESE
//      – Saldo transitado = Orcamento.saldo_transitado do orçamento do período.
//      – Resultado = receitas lançadas − despesas faturadas (base de
//        competência). NUNCA é o saldo bancário (tesouraria).
//      – Dívida dos condóminos = dívida REAL acumulada até à data de fim
//        (transitado da fração + quotas emitidas não pagas + parcelas de quota
//        extra processadas não pagas − pagamentos confirmados), por fração e
//        com piso em zero por fração. Inclui, por isso, dívidas anteriores ao
//        período sem precisar de qualquer mecanismo paralelo.
//      – Dívida a fornecedores = saldos iniciais/transitados registados
//        (fornecedor_saldos) + faturas não pagas ≤ data de fim − pagamentos a
//        fornecedores, por fornecedor.
//      – Saldo das contas = saldo_inicial + entradas − saídas confirmadas com
//        data ≤ fim, por conta (saldo real, não a fórmula receitas−despesas).
//  · Transferências entre contas: movimentos com referencia 'TRANSF' (ou
//    tipo 'transferencia') têm efeito nulo no total e NUNCA são receita nem
//    despesa — são contabilizados apenas como informação.
//
// Isolamento multi-condomínio: todas as leituras filtram por condominio_id.
// Os movimentos bancários não têm condominio_id, pelo que são filtrados pela
// conta bancária (ContaBancaria.condominio_id).
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const {
  Quota,
  Pagamento,
  ExtraQuota,
  ExtraQuotaParcela,
  Despesa,
  Fornecedor,
  FornecedorSaldo,
  PagamentoFornecedor,
  ContaBancaria,
  MovimentoBancario,
  Fracao,
  Orcamento,
  OrcamentoRubrica,
  PlanoQuota,
} = require('../models');
const { toCents, fromCents } = require('./money');
const { pagoPorQuota } = require('./recibos');
const { pagoParcela } = require('./pagamentos');

const TIPO_SALDO_INICIAL = 'saldo_inicial';
const TIPO_SALDO_TRANSITADO = 'saldo_transitado';
const REF_TRANSFERENCIA = 'TRANSF';
const EPS_C = 1; // 1 cêntimo

// ── Utilitários de calendário (puros) ───────────────────────────────
function pad2(n) {
  return String(n).padStart(2, '0');
}
function ym(ano, mes) {
  return Number(ano) * 100 + Number(mes);
}
function ymDeISO(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m ? ym(Number(m[1]), Number(m[2])) : null;
}
function inicioMesISO(ano, mes) {
  return `${ano}-${pad2(mes)}-01`;
}
function fimMesISO(ano, mes) {
  const ultimo = new Date(Date.UTC(Number(ano), Number(mes), 0)).getUTCDate();
  return `${ano}-${pad2(mes)}-${pad2(ultimo)}`;
}
function mesesEntre(ymInicio, ymFim) {
  const lista = [];
  let a = Math.floor(ymInicio / 100);
  let m = ymInicio % 100;
  const aFim = Math.floor(ymFim / 100);
  const mFim = ymFim % 100;
  let guarda = 0;
  while ((a * 100 + m) <= ymFim && guarda < 600) {
    lista.push({ ano: a, mes: m });
    m += 1;
    if (m > 12) { m = 1; a += 1; }
    guarda += 1;
  }
  if (!lista.length) lista.push({ ano: aFim, mes: mFim });
  return lista;
}
function anosDoIntervalo(ymInicio, ymFim) {
  return [...new Set(mesesEntre(ymInicio, ymFim).map((x) => x.ano))].sort((a, b) => a - b);
}

// ── Orçamentado do período (puro) ───────────────────────────────────
// Reproduz a regra de helpers/plano.js: o valor anual é dividido pelo número
// de cobranças da periodicidade e cada cobrança ocorre num mês determinado a
// partir do início do orçamento (mensal = todos; trimestral = meses 0,3,6,9;
// semestral = 0,6; anual/única = 0). O orçamentado do período é a soma das
// cobranças cujo mês cai dentro do período.
const OFFSETS_PERIODICIDADE = {
  mensal: null, // todos os meses
  trimestral: [0, 3, 6, 9],
  semestral: [0, 6],
  anual: [0],
  unica: [0],
};
function ocorrenciasNoPeriodo({ periodicidade, inicioOrcamentoYM, ymInicio, ymFim }) {
  const offsets = OFFSETS_PERIODICIDADE[periodicidade];
  const inicioAno = Math.floor(inicioOrcamentoYM / 100);
  const inicioMes = inicioOrcamentoYM % 100;
  const anoDe = (i) => inicioAno + Math.floor((inicioMes - 1 + i) / 12);
  const mesDe = (i) => ((inicioMes - 1 + i) % 12) + 1;
  const pertence = (chave) => chave >= ymInicio && chave <= ymFim;

  if (!offsets) {
    // Mensal (ou desconhecida): todas as cobranças do período, a partir do
    // início do orçamento.
    let n = 0;
    for (const { ano, mes } of mesesEntre(ymInicio, ymFim)) {
      const chave = ym(ano, mes);
      if (pertence(chave) && chave >= inicioOrcamentoYM) n += 1;
    }
    return n;
  }

  let n = 0;
  for (let ciclo = 0; ciclo < 50; ciclo += 1) {
    let ultrapassou = false;
    for (const o of offsets) {
      const i = ciclo * 12 + o;
      const chave = ym(anoDe(i), mesDe(i));
      if (chave > ymFim) { ultrapassou = true; continue; }
      if (pertence(chave)) n += 1;
    }
    if (ultrapassou) break;
  }
  return n;
}
function orcamentadoDoPeriodo({ valorAnualC, periodicidade, inicioOrcamentoYM, ymInicio, ymFim }) {
  const offsets = OFFSETS_PERIODICIDADE[periodicidade];
  const nCobrancas = !offsets ? 12 : offsets.length;
  const ocorrencias = ocorrenciasNoPeriodo({ periodicidade, inicioOrcamentoYM, ymInicio, ymFim });
  if (ocorrencias <= 0) return 0;
  const parte = Math.round(valorAnualC / nCobrancas);
  return parte * ocorrencias;
}

// ── Pago a fornecedores por fatura (puro) ───────────────────────────
// Regra: quando a despesa está marcada como 'paga' no GesCondu, considera-se
// liquidada pelo seu valor total (é o sinal autoritativo dessa fatura);
// caso contrário, o pago é o que estiver registado em pagamentos_fornecedores
// (permite pagamentos parciais). Nunca excede o valor faturado.
function pagoDaDespesa({ valorC, estado, pagamentosC = 0 }) {
  if (estado === 'anulada') return 0;
  const valor = Math.max(0, Math.round(valorC || 0));
  const registado = Math.max(0, Math.round(pagamentosC || 0));
  const pago = estado === 'paga' ? valor : registado;
  return Math.min(valor, pago);
}

// ── Dívida a um fornecedor (puro) ───────────────────────────────────
// saldo = saldos iniciais/transitados + faturado − pago (faturas e pagamentos
// sem fatura). Positivo = dívida do condomínio; negativo = crédito a favor.
function resumoDividaFornecedor({ saldoInicialC = 0, faturadoC = 0, pagoC = 0, pagamentosSemFaturaC = 0 } = {}) {
  const saldoC = Math.round(saldoInicialC) + Math.round(faturadoC) - Math.round(pagoC) - Math.round(pagamentosSemFaturaC);
  return { saldoC, dividaC: Math.max(0, saldoC), creditoC: Math.max(0, -saldoC) };
}

// ── Saldo de conta à data de corte (puro) ───────────────────────────
function saldoContaNaData({ saldoInicialC, movimentos = [], dataCorte }) {
  const base = Math.round(saldoInicialC || 0);
  let entradas = 0;
  let saidas = 0;
  let transferencias = 0;
  for (const m of movimentos) {
    if (!m || m.estado !== 'confirmado') continue;
    if (dataCorte && m.data && String(m.data).slice(0, 10) > dataCorte) continue;
    const v = Math.max(0, Math.round(toCents(m.valor)));
    if (m.tipo === 'entrada') entradas += v;
    else if (m.tipo === 'saida') saidas += v;
    else transferencias += v; // 'transferencia' não altera o saldo (efeito nulo)
  }
  return { saldoC: base + entradas - saidas, entradasC: entradas, saidasC: saidas, transferenciasC: transferencias };
}

// ── Competência de uma despesa (puro) ───────────────────────────────
function competenciaDaDespesa(despesa) {
  const ano = despesa && despesa.competencia_ano;
  const mes = despesa && despesa.competencia_mes;
  if (ano && mes) return ym(ano, mes);
  const porData = ymDeISO(despesa && despesa.data);
  if (porData) return porData;
  const porCriacao = ymDeISO(despesa && despesa.created_at);
  return porCriacao || null;
}

// ── Leitura de dados (sempre filtrada por condominio_id) ────────────
async function carregarDados({ condominioId, dataInicio, dataFim, ymInicio, ymFim }) {
  const ondeCond = { condominio_id: condominioId };

  const [
    quotas,
    extras,
    parcelas,
    contas,
    movimentos,
    fracoes,
    orcamentos,
    planos,
    despesas,
    pagamentosFornecedor,
    saldosFornecedor,
    fornecedores,
  ] = await Promise.all([
    Quota.findAll({
      // Só o que já foi emitido até ao ano de fim: as quotas de anos seguintes
      // não são dívida à data do relatório (evita trazer histórico inútil).
      where: {
        ...ondeCond,
        estado: { [Op.ne]: 'anulada' },
        ano: { [Op.lte]: Math.floor(ymFim / 100) },
      },
      attributes: ['id', 'fracao_id', 'ano', 'mes', 'periodo', 'valor', 'valor_fcr', 'data_vencimento', 'estado'],
    }),
    ExtraQuota.findAll({
      where: { ...ondeCond, estado: 'processada' },
      attributes: ['id', 'designacao', 'valor_total', 'ano_inicio', 'mes_inicio', 'numero_parcelas', 'periodicidade', 'estado'],
    }),
    ExtraQuotaParcela.findAll({
      where: { estado: { [Op.ne]: 'anulada' } },
      attributes: ['id', 'extra_quota_id', 'fracao_id', 'parcela_numero', 'valor', 'data_vencimento', 'estado'],
      include: [{ model: ExtraQuota, as: 'extra_quota', attributes: ['id', 'condominio_id', 'designacao'], where: { condominio_id: condominioId, estado: 'processada' }, required: true }],
    }),
    ContaBancaria.findAll({ where: ondeCond, order: [['nome', 'ASC'], ['id', 'ASC']] }),
    MovimentoBancario.findAll({
      where: { estado: 'confirmado' },
      attributes: ['id', 'conta_bancaria_id', 'data', 'tipo', 'valor', 'referencia', 'estado'],
      include: [{ model: ContaBancaria, as: 'conta_bancaria', attributes: ['id', 'condominio_id'], where: ondeCond, required: true }],
    }),
    Fracao.findAll({ where: ondeCond, attributes: ['id', 'designacao', 'andar', 'porta', 'permilagem', 'transitado', 'estado'] }),
    Orcamento.findAll({
      where: { ...ondeCond, estado: { [Op.ne]: 'anulado' } },
      include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
      order: [['data_inicio', 'ASC']],
    }),
    PlanoQuota.findAll({
      where: { estado: { [Op.ne]: 'cancelada' } },
      attributes: ['id', 'orcamento_id', 'fracao_id', 'ano', 'mes', 'valor'],
      include: [{ model: Orcamento, as: 'orcamento', attributes: ['id', 'condominio_id'], where: ondeCond, required: true }],
      required: true,
    }),
    Despesa.findAll({
      where: { ...ondeCond, estado: { [Op.ne]: 'anulada' } },
      attributes: ['id', 'descricao', 'categoria_id', 'valor', 'data', 'competencia_ano', 'competencia_mes', 'fornecedor', 'fornecedor_id', 'estado', 'created_at'],
      include: [
        { model: require('../models').Categoria, as: 'categoria', attributes: ['id', 'nome', 'tipo'], required: false },
        { model: Fornecedor, as: 'fornecedorReg', attributes: ['id', 'nome'], required: false },
      ],
    }),
    PagamentoFornecedor.findAll({
      where: { ...ondeCond, estado: 'pago' },
      attributes: ['id', 'fornecedor_id', 'despesa_id', 'valor', 'data_pagamento'],
    }),
    FornecedorSaldo.findAll({
      where: ondeCond,
      attributes: ['id', 'fornecedor_id', 'data', 'valor', 'tipo', 'descricao'],
      order: [['data', 'ASC'], ['id', 'ASC']],
    }),
    Fornecedor.findAll({ where: ondeCond, attributes: ['id', 'nome'] }),
  ]);

  // Pagamentos recebidos (confirmados) das frações — um único crédito por pagamento.
  const pagamentosRecebidos = await Pagamento.findAll({
    where: { ...ondeCond, estado: 'confirmado' },
    attributes: ['id', 'fracao_id', 'valor', 'data_pagamento', 'created_at'],
  });

  // Valor confirmado aplicado por quota / por parcela (fonte das métricas).
  const [pagoQ, pagoP] = await Promise.all([
    pagoPorQuota(quotas.map((q) => q.id)),
    pagoParcela(parcelas.map((p) => p.id)),
  ]);

  return {
    quotas, extras, parcelas, contas, movimentos, fracoes, orcamentos, planos,
    despesas, pagamentosFornecedor, saldosFornecedor, fornecedores,
    pagamentosRecebidos, pagoQ, pagoP,
    intervalo: { dataInicio, dataFim, ymInicio, ymFim },
  };
}

// ── Orçamento do período: rubricas e previsão de receita ────────────
function orcamentosDoPeriodo(orcamentos, ymInicio, ymFim) {
  return (orcamentos || []).filter((o) => {
    const inicio = ymDeISO(o.data_inicio);
    const fim = ymDeISO(o.data_fim);
    if (inicio === null && fim === null) return false;
    const i = inicio === null ? fim : inicio;
    const f = fim === null ? inicio : fim;
    return i <= ymFim && f >= ymInicio;
  });
}

function orcamentoDeReferencia(orcamentosPeriodo, ymInicio) {
  if (!orcamentosPeriodo.length) return null;
  const anoInicio = Math.floor(ymInicio / 100);
  return (
    orcamentosPeriodo.find((o) => ymDeISO(o.data_inicio) && Math.floor(ymDeISO(o.data_inicio) / 100) === anoInicio)
    || orcamentosPeriodo[0]
  );
}

// Mapa de rubricas de despesa configuradas no condomínio (por categoria_id e,
// quando não há categoria, pela própria descrição).
function rubricasConfiguradas(orcamentosPeriodo, ymInicio, ymFim) {
  const porCategoria = new Map();
  const soltas = new Map();
  for (const o of orcamentosPeriodo) {
    const inicioOrcamentoYM = ymDeISO(o.data_inicio) || ymInicio;
    for (const r of o.rubricas || []) {
      // Rubricas desativadas não contam como orçamento (podem, ainda assim,
      // aparecer com execução, se houver despesas na categoria).
      if (r.ativo === false) continue;
      const valorAnualC = toCents(r.valor_anual);
      const orcamentadoC = orcamentadoDoPeriodo({
        valorAnualC,
        periodicidade: r.periodicidade,
        inicioOrcamentoYM,
        ymInicio,
        ymFim,
      });
      const entrada = {
        rubricaId: r.id,
        designacao: r.descricao,
        categoriaId: r.categoria_id || null,
        orcamentoId: o.id,
        orcamentoDesignacao: o.designacao,
        orcamentadoC,
      };
      if (r.categoria_id) {
        const atual = porCategoria.get(r.categoria_id) || { ...entrada, orcamentadoC: 0 };
        atual.orcamentadoC += orcamentadoC;
        porCategoria.set(r.categoria_id, atual);
      } else {
        const chave = String(r.descricao || '').trim().toLowerCase();
        const atual = soltas.get(chave) || { ...entrada, orcamentadoC: 0 };
        atual.orcamentadoC += orcamentadoC;
        soltas.set(chave, atual);
      }
    }
  }
  return { porCategoria, soltas };
}

// Previsão de receita do período (ordem de preferência):
//  1) plano de quotas emitido/planeado do orçamento, dentro do período;
//  2) receita_quotas_prevista rateada pelos meses do período;
//  3) soma das rubricas ativas do orçamento rateada pela periodicidade.
function receitaPrevistaDoPeriodo({ orcamentosPeriodo, planos, ymInicio, ymFim }) {
  const idsOrcamentos = orcamentosPeriodo.map((o) => o.id);
  const planoNoPeriodo = (planos || []).filter(
    (p) => idsOrcamentos.includes(p.orcamento_id) && p.ano && p.mes && ym(p.ano, p.mes) >= ymInicio && ym(p.ano, p.mes) <= ymFim
  );
  if (planoNoPeriodo.length) {
    return {
      valorC: planoNoPeriodo.reduce((s, p) => s + toCents(p.valor), 0),
      origem: 'plano_quotas',
    };
  }
  let valorC = 0;
  let origem = null;
  for (const o of orcamentosPeriodo) {
    const inicioOrcamentoYM = ymDeISO(o.data_inicio) || ymInicio;
    const rubricas = (o.rubricas || []).filter((r) => r.ativo);
    if (o.receita_quotas_prevista !== null && o.receita_quotas_prevista !== undefined) {
      const mesesPeriodo = mesesEntre(ymInicio, ymFim).length;
      const mesesOrcamento = mesesEntre(inicioOrcamentoYM, ymDeISO(o.data_fim) || inicioOrcamentoYM).length || 12;
      valorC += Math.round((toCents(o.receita_quotas_prevista) * Math.min(mesesPeriodo, mesesOrcamento)) / mesesOrcamento);
      origem = origem || 'receita_quotas_prevista';
    } else if (rubricas.length) {
      valorC += rubricas.reduce(
        (s, r) => s + orcamentadoDoPeriodo({
          valorAnualC: toCents(r.valor_anual),
          periodicidade: r.periodicidade,
          inicioOrcamentoYM,
          ymInicio,
          ymFim,
        }),
        0
      );
      origem = origem || 'rubricas_orcamento';
    }
  }
  return { valorC, origem };
}

// ── Receitas ────────────────────────────────────────────────────────
function construirReceitas({ dados, receitaPrevista }) {
  const { quotas, extras, parcelas, pagoQ, pagoP, intervalo } = dados;
  const { ymInicio, ymFim } = intervalo;

  const quotasDoPeriodo = quotas.filter((q) => {
    const chave = ym(q.ano, q.mes);
    return chave >= ymInicio && chave <= ymFim;
  });
  const parcelasDoPeriodo = parcelas.filter((p) => {
    const porVencimento = ymDeISO(p.data_vencimento);
    if (porVencimento !== null) return porVencimento >= ymInicio && porVencimento <= ymFim;
    const e = p.extra_quota;
    const extra = extras.find((x) => x.id === Number(p.extra_quota_id));
    if (!extra && !e) return false;
    const base = extra || e;
    return ym(base.ano_inicio, base.mes_inicio) >= ymInicio && ym(base.ano_inicio, base.mes_inicio) <= ymFim;
  });

  const linhas = [];

  // 1) Quotas ordinárias, agrupadas por ano de competência.
  const porAno = new Map();
  const parcelasPorExtra = new Map();
  for (const p of parcelasDoPeriodo) {
    const chave = Number(p.extra_quota_id);
    if (!parcelasPorExtra.has(chave)) parcelasPorExtra.set(chave, []);
    parcelasPorExtra.get(chave).push(p);
  }
  for (const q of quotasDoPeriodo) {
    const atual = porAno.get(q.ano) || { lancadoC: 0, recebidoC: 0, n: 0, fcrC: 0 };
    atual.lancadoC += toCents(q.valor);
    atual.recebidoC += pagoQ.get(q.id) || 0;
    atual.fcrC += toCents(q.valor_fcr);
    atual.n += 1;
    porAno.set(q.ano, atual);
  }
  const anos = [...porAno.keys()].sort((a, b) => a - b);
  // A previsão de receita do período é distribuída pelos anos do período em
  // proporção dos meses que cada ano tem dentro do período (o resto fica no
  // último ano, para o total bater certo ao cêntimo).
  const mesesTotal = mesesEntre(ymInicio, ymFim);
  const mesesPorAno = new Map();
  for (const { ano } of mesesTotal) mesesPorAno.set(ano, (mesesPorAno.get(ano) || 0) + 1);
  let previstoAcumulado = 0;
  anos.forEach((ano, idx) => {
    const v = porAno.get(ano);
    const previsto = idx === anos.length - 1
      ? receitaPrevista.valorC - previstoAcumulado
      : Math.round((receitaPrevista.valorC * (mesesPorAno.get(ano) || 0)) / (mesesTotal.length || 1));
    previstoAcumulado += previsto;
    linhas.push({
      designacao: `Quotas ordinárias — ${ano}`,
      tipo: 'quotas_ordinarias',
      orcamentadoC: previsto,
      lancadoC: v.lancadoC,
      recebidoC: v.recebidoC,
      emDividaC: v.lancadoC - v.recebidoC,
      fcrC: v.fcrC,
      nDocumentos: v.n,
    });
  });
  // Período sem quotas emitidas: a previsão continua a ser apresentada, para o
  // balancete comparar orçamento e execução mesmo sem lançamentos.
  if (!anos.length && receitaPrevista.valorC !== 0) {
    linhas.push({
      designacao: `Quotas ordinárias — ${anosDoIntervalo(ymInicio, ymFim).join('/')}`,
      tipo: 'quotas_ordinarias',
      orcamentadoC: receitaPrevista.valorC,
      lancadoC: 0,
      recebidoC: 0,
      emDividaC: 0,
      fcrC: 0,
      nDocumentos: 0,
    });
  }

  // 2) Quotas extraordinárias processadas com parcelas no período.
  for (const extra of extras) {
    const lista = parcelasPorExtra.get(extra.id) || [];
    if (!lista.length) continue;
    const todasDoExtra = parcelas.filter((p) => Number(p.extra_quota_id) === Number(extra.id));
    const lancadoC = lista.reduce((s, p) => s + toCents(p.valor), 0);
    const recebidoC = lista.reduce((s, p) => s + (pagoP.get(p.id) || 0), 0);
    // Orçamentado: o valor aprovado da quota extra, rateado pelas parcelas que
    // vencem dentro do período (no ano completo é o valor total).
    const orcamentadoC = todasDoExtra.length
      ? Math.round((toCents(extra.valor_total) * lista.length) / todasDoExtra.length)
      : toCents(extra.valor_total);
    linhas.push({
      designacao: `Quota extraordinária — ${extra.designacao}`,
      tipo: 'quota_extra',
      orcamentadoC,
      lancadoC,
      recebidoC,
      emDividaC: lancadoC - recebidoC,
      fcrC: 0,
      nDocumentos: lista.length,
    });
  }

  // 3) Quotas extraordinárias processadas mas sem parcelas no período: o valor
  //    anual comprometido não entra no balancete (não foi lançado no período).

  const totais = linhas.reduce(
    (t, l) => ({
      orcamentadoC: t.orcamentadoC + l.orcamentadoC,
      lancadoC: t.lancadoC + l.lancadoC,
      recebidoC: t.recebidoC + l.recebidoC,
      emDividaC: t.emDividaC + l.emDividaC,
      fcrC: t.fcrC + l.fcrC,
    }),
    { orcamentadoC: 0, lancadoC: 0, recebidoC: 0, emDividaC: 0, fcrC: 0 }
  );

  return {
    rubricas: linhas,
    totais,
    origemPrevisao: receitaPrevista.origem || (anos.length ? 'sem_orcamento' : null),
    quotasDoPeriodo,
    parcelasDoPeriodo,
  };
}

// ── Despesas ────────────────────────────────────────────────────────
function construirDespesas({ dados, rubricasOrcamento }) {
  const { despesas, pagamentosFornecedor, intervalo } = dados;
  const { ymInicio, ymFim } = intervalo;

  const pagamentosPorDespesa = new Map();
  for (const pg of pagamentosFornecedor) {
    if (!pg.despesa_id) continue;
    const chave = Number(pg.despesa_id);
    pagamentosPorDespesa.set(chave, (pagamentosPorDespesa.get(chave) || 0) + toCents(pg.valor));
  }

  const avaliar = (d) => {
    const valorC = toCents(d.valor);
    const pagoC = pagoDaDespesa({
      valorC,
      estado: d.estado,
      pagamentosC: pagamentosPorDespesa.get(Number(d.id)) || 0,
    });
    return { valorC, pagoC, porPagarC: Math.max(0, valorC - pagoC) };
  };

  const doPeriodo = despesas.filter((d) => {
    const chave = competenciaDaDespesa(d);
    return chave !== null && chave >= ymInicio && chave <= ymFim;
  });

  const linhas = new Map();
  const fornecedorNome = (d) => (d.fornecedorReg && d.fornecedorReg.nome) || d.fornecedor || null;

  for (const d of doPeriodo) {
    const cat = d.categoria;
    const nomeCategoria = cat && cat.nome ? cat.nome : null;
    const chave = cat && cat.id ? `cat:${cat.id}` : `txt:${String(nomeCategoria || 'sem rubrica').toLowerCase()}`;
    const rubrica = (cat && cat.id && rubricasOrcamento.porCategoria.get(cat.id))
      || rubricasOrcamento.soltas.get(String(nomeCategoria || '').trim().toLowerCase())
      || null;
    if (!linhas.has(chave)) {
      linhas.set(chave, {
        designacao: nomeCategoria || (rubrica && rubrica.designacao) || 'Sem rubrica',
        categoriaId: cat ? cat.id : null,
        rubricaId: rubrica ? rubrica.rubricaId : null,
        orcamentadoC: rubrica ? rubrica.orcamentadoC : 0,
        faturadoC: 0,
        pagoC: 0,
        porPagarC: 0,
        nFaturas: 0,
        fornecedores: new Map(),
      });
    }
    const linha = linhas.get(chave);
    const av = avaliar(d);
    linha.faturadoC += av.valorC;
    linha.pagoC += av.pagoC;
    linha.porPagarC += av.porPagarC;
    linha.nFaturas += 1;
    const fNome = fornecedorNome(d) || 'Sem fornecedor identificado';
    const fAtual = linha.fornecedores.get(fNome) || { faturadoC: 0, pagoC: 0, porPagarC: 0, nFaturas: 0 };
    fAtual.faturadoC += av.valorC;
    fAtual.pagoC += av.pagoC;
    fAtual.porPagarC += av.porPagarC;
    fAtual.nFaturas += 1;
    linha.fornecedores.set(fNome, fAtual);
  }

  // Rubricas configuradas no condomínio sem execução no período continuam a
  // aparecer (orçamentado vs 0), para o balancete ser comparável ao orçamento.
  for (const r of rubricasOrcamento.porCategoria.values()) {
    const chave = `cat:${r.categoriaId}`;
    if (!linhas.has(chave)) {
      linhas.set(chave, {
        designacao: r.designacao,
        categoriaId: r.categoriaId,
        rubricaId: r.rubricaId,
        orcamentadoC: r.orcamentadoC,
        faturadoC: 0,
        pagoC: 0,
        porPagarC: 0,
        nFaturas: 0,
        fornecedores: new Map(),
      });
    }
  }
  // Rubricas configuradas sem categoria associada (não casam com nenhuma
  // despesa): apresentadas pelo nome configurado, com execução a zero.
  for (const r of rubricasOrcamento.soltas.values()) {
    if (!r.orcamentadoC) continue;
    const chave = `rub:${r.rubricaId}`;
    if (!linhas.has(chave)) {
      linhas.set(chave, {
        designacao: r.designacao,
        categoriaId: null,
        rubricaId: r.rubricaId,
        orcamentadoC: r.orcamentadoC,
        faturadoC: 0,
        pagoC: 0,
        porPagarC: 0,
        nFaturas: 0,
        fornecedores: new Map(),
      });
    }
  }

  const lista = [...linhas.values()]
    .map((l) => ({ ...l, fornecedores: [...l.fornecedores.entries()].map(([nome, v]) => ({ nome, ...v })) }))
    .sort((a, b) => {
      if (b.faturadoC !== a.faturadoC) return b.faturadoC - a.faturadoC;
      return String(a.designacao).localeCompare(String(b.designacao), 'pt');
    });

  const totais = lista.reduce(
    (t, l) => ({
      orcamentadoC: t.orcamentadoC + l.orcamentadoC,
      faturadoC: t.faturadoC + l.faturadoC,
      pagoC: t.pagoC + l.pagoC,
      porPagarC: t.porPagarC + l.porPagarC,
      nFaturas: t.nFaturas + l.nFaturas,
    }),
    { orcamentadoC: 0, faturadoC: 0, pagoC: 0, porPagarC: 0, nFaturas: 0 }
  );

  return { rubricas: lista, totais, doPeriodo };
}

// ── Dívida dos condóminos (acumulada até à data de fim) ─────────────
function construirDividasCondominos({ dados, dataFim }) {
  const { fracoes, quotas, parcelas, extras, pagamentosRecebidos, pagoQ, pagoP, intervalo } = dados;
  const { ymInicio, ymFim } = intervalo;
  const mapa = new Map();
  for (const f of fracoes) {
    mapa.set(f.id, {
      fracaoId: f.id,
      designacao: f.designacao,
      andar: f.andar,
      porta: f.porta,
      permilagem: f.permilagem,
      transitadoC: Math.round(toCents(f.transitado)),
      lancadoC: 0,
      lancadoPeriodoC: 0,
      recebidoC: 0,
      recebidoPeriodoC: 0,
      extrasC: 0,
      extrasPeriodoC: 0,
      nQuotas: 0,
    });
  }

  const dataISO = (v) => (v ? String(v).slice(0, 10) : null);
  const dentroDoPeriodo = (chave) => chave !== null && chave >= ymInicio && chave <= ymFim;

  for (const q of quotas) {
    const linha = mapa.get(q.fracao_id);
    if (!linha) continue;
    const chave = ym(q.ano, q.mes);
    if (chave > ymFim) continue; // emitido depois da data de fim
    const valorC = toCents(q.valor);
    linha.lancadoC += valorC;
    linha.nQuotas += 1;
    if (dentroDoPeriodo(chave)) linha.lancadoPeriodoC += valorC;
  }
  for (const p of parcelas) {
    const linha = mapa.get(p.fracao_id);
    if (!linha) continue;
    const extra = extras.find((x) => x.id === Number(p.extra_quota_id));
    const chave = ymDeISO(p.data_vencimento) || (extra ? ym(extra.ano_inicio, extra.mes_inicio) : null);
    if (chave !== null && chave > ymFim) continue;
    const valorC = toCents(p.valor);
    linha.extrasC += valorC;
    if (dentroDoPeriodo(chave)) linha.extrasPeriodoC += valorC;
  }
  for (const q of quotas) {
    const linha = mapa.get(q.fracao_id);
    if (!linha) continue;
    const pago = pagoQ.get(q.id) || 0;
    linha.recebidoC += pago;
    if (dentroDoPeriodo(ym(q.ano, q.mes))) linha.recebidoPeriodoC += pago;
  }
  for (const p of parcelas) {
    const linha = mapa.get(p.fracao_id);
    if (!linha) continue;
    const extra = extras.find((x) => x.id === Number(p.extra_quota_id));
    const chave = ymDeISO(p.data_vencimento) || (extra ? ym(extra.ano_inicio, extra.mes_inicio) : null);
    if (chave !== null && chave > ymFim) continue; // parcela vencida depois da data de fim
    const pago = pagoP.get(p.id) || 0;
    linha.recebidoC += pago;
    if (dentroDoPeriodo(chave)) linha.recebidoPeriodoC += pago;
  }
  // Pagamentos recebidos fora das aplicações acima (crédito a favor da fração)
  // reduzem a dívida global da fração, tal como na conta-corrente.
  const recebimentosPorFracao = new Map();
  for (const pg of pagamentosRecebidos) {
    const d = dataISO(pg.data_pagamento) || dataISO(pg.created_at);
    if (d && d > dataFim) continue;
    const chave = Number(pg.fracao_id);
    recebimentosPorFracao.set(chave, (recebimentosPorFracao.get(chave) || 0) + toCents(pg.valor));
  }

  const lista = [];
  let dividaC = 0;
  let creditoC = 0;
  for (const linha of mapa.values()) {
    const aplicadoC = linha.recebidoC; // Σ valor_aplicado confirmado (quotas + parcelas)
    const pagoTotalC = recebimentosPorFracao.get(Number(linha.fracaoId)) || 0;
    // Excedente de pagamento (recebido acima do aplicado) fica como crédito a
    // favor da fração, tal como a conta-corrente do módulo de Quotas.
    const creditoFracaoC = Math.max(0, pagoTotalC - aplicadoC);
    const saldoFinalC = linha.transitadoC + linha.lancadoC + linha.extrasC - aplicadoC - creditoFracaoC;
    const linhaFinal = {
      ...linha,
      pagoTotalC,
      creditoFracaoC,
      saldoC: saldoFinalC,
      emDivida: saldoFinalC > EPS_C,
      emDividaC: Math.max(0, saldoFinalC),
      creditoC: Math.max(0, -saldoFinalC),
    };
    if (linhaFinal.emDividaC > 0) dividaC += linhaFinal.emDividaC;
    if (linhaFinal.creditoC > 0) creditoC += linhaFinal.creditoC;
    lista.push(linhaFinal);
  }
  lista.sort((a, b) => (b.emDividaC - a.emDividaC) || String(a.designacao).localeCompare(String(b.designacao), 'pt'));
  const transitadoC = lista.reduce((s, l) => s + Math.max(0, l.transitadoC), 0);
  const lancadoTotalC = lista.reduce((s, l) => s + l.lancadoC, 0);
  const extrasTotalC = lista.reduce((s, l) => s + l.extrasC, 0);
  const recebidoTotalC = lista.reduce((s, l) => s + l.recebidoC, 0);
  const lancadoPeriodoC = lista.reduce((s, l) => s + l.lancadoPeriodoC, 0);
  const extrasPeriodoC = lista.reduce((s, l) => s + l.extrasPeriodoC, 0);
  const recebidoPeriodoC = lista.reduce((s, l) => s + l.recebidoPeriodoC, 0);

  return {
    fracoes: lista,
    dividaC,
    creditoC,
    transitadoC,
    lancadoTotalC,
    extrasTotalC,
    recebidoTotalC,
    lancadoPeriodoC,
    extrasPeriodoC,
    recebidoPeriodoC,
    nFracoesEmDivida: lista.filter((l) => l.emDivida).length,
  };
}

// ── Dívida a fornecedores (acumulada até à data de fim) ─────────────
function construirDividasFornecedores({ dados, dataFim }) {
  const { despesas, pagamentosFornecedor, saldosFornecedor, fornecedores, intervalo } = dados;
  const { ymInicio, ymFim } = intervalo;
  const dataISO = (v) => (v ? String(v).slice(0, 10) : null);
  const mapa = new Map();
  for (const f of fornecedores) {
    mapa.set(f.id, {
      fornecedorId: f.id,
      nome: f.nome,
      saldoInicialC: 0,
      saldos: [],
      faturadoC: 0,
      faturadoPeriodoC: 0,
      pagoC: 0,
      pagoPeriodoC: 0,
      pagamentosSemFaturaC: 0,
      nFaturas: 0,
    });
  }
  for (const s of saldosFornecedor) {
    const d = dataISO(s.data);
    if (d && d > dataFim) continue;
    let linha = mapa.get(s.fornecedor_id);
    if (!linha) {
      linha = {
        fornecedorId: s.fornecedor_id, nome: 'Fornecedor removido', saldoInicialC: 0, saldos: [],
        faturadoC: 0, faturadoPeriodoC: 0, pagoC: 0, pagoPeriodoC: 0, pagamentosSemFaturaC: 0, nFaturas: 0,
      };
      mapa.set(s.fornecedor_id, linha);
    }
    linha.saldoInicialC += toCents(s.valor);
    linha.saldos.push({ id: s.id, data: s.data, valorC: toCents(s.valor), tipo: s.tipo, descricao: s.descricao });
  }

  const pagamentosPorDespesa = new Map();
  for (const pg of pagamentosFornecedor) {
    if (!pg.despesa_id) continue;
    const chave = Number(pg.despesa_id);
    pagamentosPorDespesa.set(chave, (pagamentosPorDespesa.get(chave) || 0) + toCents(pg.valor));
  }

  for (const d of despesas) {
    if (!d.fornecedor_id) continue;
    const chave = competenciaDaDespesa(d);
    const dISO = dataISO(d.data);
    if (dISO && dISO > dataFim) continue;
    if (!dISO && chave !== null && chave > ymFim) continue;
    let linha = mapa.get(d.fornecedor_id);
    if (!linha) {
      linha = {
        fornecedorId: d.fornecedor_id, nome: 'Fornecedor removido', saldoInicialC: 0, saldos: [],
        faturadoC: 0, faturadoPeriodoC: 0, pagoC: 0, pagoPeriodoC: 0, pagamentosSemFaturaC: 0, nFaturas: 0,
      };
      mapa.set(d.fornecedor_id, linha);
    }
    const valorC = toCents(d.valor);
    const pagoC = pagoDaDespesa({
      valorC,
      estado: d.estado,
      pagamentosC: pagamentosPorDespesa.get(Number(d.id)) || 0,
    });
    linha.faturadoC += valorC;
    linha.pagoC += pagoC;
    linha.nFaturas += 1;
    if (chave !== null && chave >= ymInicio && chave <= ymFim) {
      linha.faturadoPeriodoC += valorC;
      linha.pagoPeriodoC += pagoC;
    }
  }

  // Pagamentos a fornecedores sem fatura associada (abates diretos à dívida).
  for (const pg of pagamentosFornecedor) {
    if (pg.despesa_id) continue;
    const linha = mapa.get(pg.fornecedor_id);
    if (!linha) continue;
    const dISO = dataISO(pg.data_pagamento);
    if (dISO && dISO > dataFim) continue;
    linha.pagamentosSemFaturaC += toCents(pg.valor);
  }

  const lista = [];
  let dividaC = 0;
  let creditoC = 0;
  for (const linha of mapa.values()) {
    const r = resumoDividaFornecedor({
      saldoInicialC: linha.saldoInicialC,
      faturadoC: linha.faturadoC,
      pagoC: linha.pagoC,
      pagamentosSemFaturaC: linha.pagamentosSemFaturaC,
    });
    if (r.dividaC > 0) dividaC += r.dividaC;
    if (r.creditoC > 0) creditoC += r.creditoC;
    lista.push({ ...linha, saldoC: r.saldoC, dividaC: r.dividaC, creditoC: r.creditoC });
  }
  lista.sort((a, b) => (b.dividaC - a.dividaC) || String(a.nome).localeCompare(String(b.nome), 'pt'));

  // Despesas por pagar sem fornecedor identificado não podem ser atribuídas a
  // ninguém: são reportadas em separado (nunca escondidas).
  let semFornecedorC = 0;
  for (const d of despesas) {
    if (d.fornecedor_id) continue;
    const chave = competenciaDaDespesa(d);
    if (chave === null || chave > ymFim || chave < ymInicio) continue;
    const valorC = toCents(d.valor);
    const pagoC = pagoDaDespesa({ valorC, estado: d.estado, pagamentosC: pagamentosPorDespesa.get(Number(d.id)) || 0 });
    semFornecedorC += Math.max(0, valorC - pagoC);
  }

  return { fornecedores: lista, dividaC, creditoC, semFornecedorC };
}

// ── Contas bancárias ────────────────────────────────────────────────
function construirContas({ dados, dataFim }) {
  const { contas, movimentos, intervalo } = dados;
  const { ymInicio, ymFim } = intervalo;
  const porConta = new Map();
  for (const m of movimentos) {
    const chave = Number(m.conta_bancaria_id);
    if (!porConta.has(chave)) porConta.set(chave, []);
    porConta.get(chave).push(m);
  }
  let totalC = 0;
  let totalInicialC = 0;
  let totalEntradasC = 0;
  let totalSaidasC = 0;
  let nTransferencias = 0;
  let valorTransferenciasC = 0;
  const lista = contas.map((c) => {
    const movs = porConta.get(c.id) || [];
    const r = saldoContaNaData({ saldoInicialC: toCents(c.saldo_inicial), movimentos: movs, dataCorte: dataFim });
    totalC += r.saldoC;
    totalInicialC += toCents(c.saldo_inicial);
    totalEntradasC += r.entradasC;
    totalSaidasC += r.saidasC;
    const transf = movs.filter((m) => m.tipo === 'transferencia' || String(m.referencia || '') === REF_TRANSFERENCIA);
    nTransferencias += transf.length;
    valorTransferenciasC += transf.reduce((s, m) => s + toCents(m.valor), 0);
    return {
      id: c.id,
      nome: c.nome,
      banco: c.banco,
      iban: c.iban,
      tipo: c.tipo,
      ativa: c.ativa,
      saldoInicialC: toCents(c.saldo_inicial),
      entradasC: r.entradasC,
      saidasC: r.saidasC,
      saldoC: r.saldoC,
      fundoReserva: c.tipo === 'fundo_reserva',
    };
  });
  const fundoReservaC = lista.filter((c) => c.fundoReserva).reduce((s, c) => s + c.saldoC, 0);
  return {
    contas: lista,
    totalC,
    totalInicialC,
    totalEntradasC,
    totalSaidasC,
    fundoReservaC,
    transferencias: { n: nTransferencias, valorC: valorTransferenciasC, ymInicio, ymFim },
  };
}

// ── Motor principal ─────────────────────────────────────────────────
async function balanceteFinanceiro({ condominioId, dataInicio, dataFim, opcoes = {} } = {}) {
  if (!condominioId) throw new Error('condominioId é obrigatório.');
  const inicio = String(dataInicio || '').slice(0, 10);
  const fim = String(dataFim || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
    throw new Error('Datas do período inválidas (use AAAA-MM-DD).');
  }
  if (inicio > fim) throw new Error('A data de início não pode ser posterior à data de fim.');

  const ymInicio = ymDeISO(inicio);
  const ymFim = ymDeISO(fim);
  const dados = await carregarDados({ condominioId, dataInicio: inicio, dataFim: fim, ymInicio, ymFim });

  const orcamentosPeriodo = orcamentosDoPeriodo(dados.orcamentos, ymInicio, ymFim);
  const orcamentoReferencia = orcamentoDeReferencia(orcamentosPeriodo, ymInicio);
  const rubricasOrcamento = rubricasConfiguradas(orcamentosPeriodo, ymInicio, ymFim);
  const receitaPrevista = receitaPrevistaDoPeriodo({ orcamentosPeriodo, planos: dados.planos, ymInicio, ymFim });

  const receitas = construirReceitas({ dados, receitaPrevista });
  const despesas = construirDespesas({ dados, rubricasOrcamento });
  const dividasCondominos = construirDividasCondominos({ dados, dataFim: fim });
  const dividasFornecedores = construirDividasFornecedores({ dados, dataFim: fim });
  const contas = construirContas({ dados, dataFim: fim });

  const saldoTransitadoC = orcamentoReferencia ? toCents(orcamentoReferencia.saldo_transitado) : 0;
  const resultadoC = receitas.totais.lancadoC - despesas.totais.faturadoC;

  const avisos = [];
  if (!orcamentosPeriodo.length) {
    avisos.push('Não existe orçamento (não anulado) para o período: os valores orçamentados ficam a zero.');
  }
  if (dividasFornecedores.semFornecedorC > 0) {
    avisos.push('Existem despesas por pagar sem fornecedor identificado; são apresentadas em linha própria.');
  }
  if (contas.transferencias.n > 0) {
    avisos.push(`Foram detetados ${contas.transferencias.n} movimentos de transferência entre contas — não contam como receita nem como despesa.`);
  }

  const detalhe = {};
  if (opcoes.dividas_condominos) {
    detalhe.dividasCondominos = dividasCondominos.fracoes.filter((f) => f.emDividaC > 0 || f.creditoC > 0);
  }
  if (opcoes.dividas_fornecedores) {
    detalhe.dividasFornecedores = dividasFornecedores.fornecedores.filter((f) => f.dividaC > 0 || f.saldoInicialC !== 0);
  }
  if (opcoes.despesas_por_fornecedor) {
    detalhe.despesasPorFornecedor = despesas.rubricas
      .filter((r) => r.fornecedores.length)
      .map((r) => ({ rubrica: r.designacao, fornecedores: r.fornecedores }));
  }
  if (opcoes.receitas_por_fracao) {
    detalhe.receitasPorFracao = dividasCondominos.fracoes
      .filter((f) => f.lancadoPeriodoC !== 0 || f.recebidoPeriodoC !== 0)
      .map((f) => ({
        designacao: f.designacao,
        lancadoC: f.lancadoPeriodoC + f.extrasPeriodoC,
        recebidoC: f.recebidoPeriodoC,
        emDividaC: Math.max(0, f.lancadoPeriodoC + f.extrasPeriodoC - f.recebidoPeriodoC),
      }));
  }
  if (opcoes.notas) {
    detalhe.notas = {
      receitas: receitas.rubricas.map((r) => ({
        designacao: r.designacao,
        nDocumentos: r.nDocumentos,
        orcamentadoC: r.orcamentadoC,
        executadoC: r.lancadoC,
        percentagem: r.orcamentadoC > 0 ? Math.round((r.lancadoC / r.orcamentadoC) * 100) : null,
      })),
      despesas: despesas.rubricas.map((r) => ({
        designacao: r.designacao,
        nFaturas: r.nFaturas,
        orcamentadoC: r.orcamentadoC,
        executadoC: r.faturadoC,
        percentagem: r.orcamentadoC > 0 ? Math.round((r.faturadoC / r.orcamentadoC) * 100) : null,
      })),
    };
  }

  return {
    condominioId,
    periodo: {
      inicio,
      fim,
      ymInicio,
      ymFim,
      meses: mesesEntre(ymInicio, ymFim).length,
      anos: anosDoIntervalo(ymInicio, ymFim),
    },
    opcoes: {
      notas: !!opcoes.notas,
      dividas_condominos: !!opcoes.dividas_condominos,
      dividas_fornecedores: !!opcoes.dividas_fornecedores,
      despesas_por_fornecedor: !!opcoes.despesas_por_fornecedor,
      receitas_por_fracao: !!opcoes.receitas_por_fracao,
    },
    observacoes: typeof opcoes.observacoes === 'string' ? opcoes.observacoes : '',
    orcamento: orcamentoReferencia
      ? {
        id: orcamentoReferencia.id,
        designacao: orcamentoReferencia.designacao,
        ano: orcamentoReferencia.ano,
        estado: orcamentoReferencia.estado,
        saldoTransitadoC: toCents(orcamentoReferencia.saldo_transitado),
      }
      : null,
    receitas,
    despesas,
    sintese: {
      saldoTransitadoC,
      totalReceitasLancadasC: receitas.totais.lancadoC,
      totalReceitasRecebidasC: receitas.totais.recebidoC,
      totalDespesasFaturadasC: despesas.totais.faturadoC,
      totalDespesasPagasC: despesas.totais.pagoC,
      resultadoC,
      dividaCondominosC: dividasCondominos.dividaC,
      dividaCondominosTransitadaC: dividasCondominos.transitadoC,
      creditoCondominosC: dividasCondominos.creditoC,
      dividaFornecedoresC: dividasFornecedores.dividaC,
      dividaFornecedoresSemFornecedorC: dividasFornecedores.semFornecedorC,
      creditoFornecedoresC: dividasFornecedores.creditoC,
      saldoContasC: contas.totalC,
      fundoReservaC: contas.fundoReservaC,
      tesourariaResultadoC: contas.totalC - saldoTransitadoC,
    },
    contas,
    dividasCondominos,
    dividasFornecedores,
    detalhe,
    avisos,
    dados: {
      nQuotas: dados.quotas.length,
      nFracoes: dados.fracoes.length,
      nDespesas: dados.despesas.length,
      nContas: dados.contas.length,
    },
  };
}

module.exports = {
  balanceteFinanceiro,
  // puros (testáveis sem base de dados)
  ym,
  ymDeISO,
  mesesEntre,
  anosDoIntervalo,
  ocorrenciasNoPeriodo,
  orcamentadoDoPeriodo,
  pagoDaDespesa,
  resumoDividaFornecedor,
  saldoContaNaData,
  competenciaDaDespesa,
  rubricasConfiguradas,
  receitaPrevistaDoPeriodo,
  orcamentosDoPeriodo,
  orcamentoDeReferencia,
  REF_TRANSFERENCIA,
  TIPO_SALDO_INICIAL,
  TIPO_SALDO_TRANSITADO,
  fromCents,
};
