// Testes offline do Relatório Financeiro (balancete do condomínio) — sem base
// de dados.
//
// Estratégia: o motor (helpers/relatorio-financeiro.js) é exercitado com as
// consultas aos modelos substituídas por dublês (dados de cenário), o que
// permite validar os cálculos e os 17 cenários funcionais exigidos sem
// MySQL. As funções puras (orçamentado do período, pago por fatura, saldo de
// conta à data, dívida a fornecedor) são testadas diretamente, o PDF é gerado
// a sério (pdfkit) e o isolamento multi-condomínio é verificado no código.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const modelos = require('../models');
const {
  balanceteFinanceiro,
  orcamentadoDoPeriodo,
  pagoDaDespesa,
  resumoDividaFornecedor,
  saldoContaNaData,
  competenciaDaDespesa,
  ocorrenciasNoPeriodo,
} = require('../helpers/relatorio-financeiro');
const { gerarRelatorioFinanceiroPDF } = require('../helpers/pdf');

const RAIZ = path.join(__dirname, '..');
const codigoMotor = fs.readFileSync(path.join(RAIZ, 'helpers', 'relatorio-financeiro.js'), 'utf8');
const codigoRotas = fs.readFileSync(path.join(RAIZ, 'routes', 'relatorios.js'), 'utf8');
const codigoPdf = fs.readFileSync(path.join(RAIZ, 'helpers', 'pdf.js'), 'utf8');
const vista = fs.readFileSync(path.join(RAIZ, 'views', 'admin', 'relatorios', 'financeiro.handlebars'), 'utf8');
const layout = fs.readFileSync(path.join(RAIZ, 'views', 'layouts', 'main.handlebars'), 'utf8');

// ── Dublês das consultas ────────────────────────────────────────────
// Cada cenário descreve apenas os dados; `comDados` instala os dublês nas
// consultas usadas pelo motor e restaura tudo no fim.
function comDados(dados, fn) {
  const originais = [];
  const substituir = (modelo, metodo, valor) => {
    originais.push([modelos[modelo], metodo, modelos[modelo][metodo]]);
    modelos[modelo][metodo] = async () => valor;
  };

  substituir('Quota', 'findAll', dados.quotas || []);
  substituir('ExtraQuota', 'findAll', dados.extras || []);
  substituir('ExtraQuotaParcela', 'findAll', dados.parcelas || []);
  substituir('ContaBancaria', 'findAll', dados.contas || []);
  substituir('MovimentoBancario', 'findAll', dados.movimentos || []);
  substituir('Fracao', 'findAll', dados.fracoes || []);
  substituir('Orcamento', 'findAll', dados.orcamentos || []);
  substituir('PlanoQuota', 'findAll', dados.planos || []);
  substituir('Despesa', 'findAll', dados.despesas || []);
  substituir('PagamentoFornecedor', 'findAll', dados.pagamentosFornecedor || []);
  substituir('FornecedorSaldo', 'findAll', dados.saldosFornecedor || []);
  substituir('Fornecedor', 'findAll', dados.fornecedores || []);
  substituir('Pagamento', 'findAll', dados.pagamentos || []);
  // Aplicações confirmadas (o dublê devolve já o resultado do join com o
  // pagamento confirmado, tal como a consulta real devolve).
  substituir('PagamentoQuota', 'findAll', (dados.aplicacoesQuota || []).map((a) => ({
    quota_id: a.quota_id,
    valor_aplicado: a.valor_aplicado,
    'pagamento.estado': 'confirmado',
  })));
  substituir('PagamentoExtraParcela', 'findAll', (dados.aplicacoesParcela || []).map((a) => ({
    extra_quota_parcela_id: a.extra_quota_parcela_id,
    valor_aplicado: a.valor_aplicado,
    'pagamento.estado': 'confirmado',
  })));

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [alvo, metodo, valor] of originais) alvo[metodo] = valor;
    });
}

const C = (v) => Math.round(Number(v) * 100); // euros → cêntimos

// ── Cenário base: 2 frações, orçamento 2026, 2 rubricas ─────────────
function cenarioBase(extra = {}) {
  return {
    fracoes: [
      { id: 1, designacao: '1.º Esq', andar: '1', porta: 'Esq', permilagem: '500', transitado: 0, estado: 'ativo' },
      { id: 2, designacao: '1.º Dto', andar: '1', porta: 'Dto', permilagem: '500', transitado: 0, estado: 'ativo' },
    ],
    orcamentos: [
      {
        id: 10,
        condominio_id: 1,
        designacao: 'Orçamento 2026',
        ano: 2026,
        data_inicio: '2026-01-01',
        data_fim: '2026-12-31',
        estado: 'aprovado',
        saldo_transitado: '1250.00',
        receita_quotas_prevista: null,
        rubricas: [
          { id: 100, descricao: 'Elevadores', categoria_id: 7, valor_anual: '2400.00', periodicidade: 'mensal', ativo: true },
          { id: 101, descricao: 'Eletricidade', categoria_id: 8, valor_anual: '1200.00', periodicidade: 'mensal', ativo: true },
        ],
      },
    ],
    contas: [
      { id: 20, nome: 'Conta principal', banco: 'CGD', iban: 'PT50000000000000000000000', tipo: 'corrente', saldo_inicial: '1000.00', ativa: true },
    ],
    quotas: [],
    extras: [],
    parcelas: [],
    movimentos: [],
    planos: [],
    despesas: [],
    pagamentos: [],
    pagamentosFornecedor: [],
    saldosFornecedor: [],
    fornecedores: [{ id: 30, nome: 'Otis' }],
    aplicacoesQuota: [],
    aplicacoesParcela: [],
    ...extra,
  };
}

function quota(id, fracaoId, mes, valor, extra = {}) {
  return {
    id,
    fracao_id: fracaoId,
    ano: 2026,
    mes,
    periodo: `2026-${String(mes).padStart(2, '0')}-01`,
    valor: valor.toFixed(2),
    valor_fcr: extra.valor_fcr || '0.00',
    data_vencimento: `2026-${String(mes).padStart(2, '0')}-08`,
    estado: extra.estado || 'pendente',
  };
}

// ── 1. Condomínio sem movimentos ────────────────────────────────────
async function cenarioSemMovimentos() {
  await comDados(cenarioBase(), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.receitas.totais.lancadoC, 0, 'sem quotas lançadas');
    assert.strictEqual(r.receitas.totais.recebidoC, 0, 'sem recebimentos');
    assert.strictEqual(r.despesas.totais.faturadoC, 0, 'sem despesas faturadas');
    assert.strictEqual(r.sintese.resultadoC, 0, 'resultado zero');
    assert.strictEqual(r.sintese.dividaCondominosC, 0, 'sem dívidas de condóminos');
    assert.strictEqual(r.sintese.dividaFornecedoresC, 0, 'sem dívidas a fornecedores');
    assert.strictEqual(r.sintese.saldoContasC, C(1000), 'saldo das contas = saldo inicial');
    // As rubricas orçamentadas do condomínio aparecem com execução a zero.
    assert.strictEqual(r.despesas.rubricas.length, 2, 'rubricas do orçamento presentes');
    const elevadores = r.despesas.rubricas.find((x) => x.designacao === 'Elevadores');
    assert.strictEqual(elevadores.orcamentadoC, C(2400), 'orçamentado anual completo');
    assert.strictEqual(elevadores.faturadoC, 0, 'sem execução');
    assert.strictEqual(r.receitas.rubricas.length, 1, 'linha de quotas ordinárias prevista');
    assert.strictEqual(r.receitas.rubricas[0].orcamentadoC, C(3600), 'previsão = soma das rubricas');
  });
}

// ── 2. Saldo transitado do orçamento ────────────────────────────────
async function cenarioSaldoTransitado() {
  await comDados(cenarioBase(), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.sintese.saldoTransitadoC, C(1250), 'saldo transitado do orçamento');
    assert.ok(r.orcamento && r.orcamento.id === 10, 'orçamento de referência identificado');
  });
  // Sem orçamento: transitado zero e aviso explícito.
  await comDados(cenarioBase({ orcamentos: [] }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.sintese.saldoTransitadoC, 0, 'sem orçamento → transitado 0');
    assert.ok(r.avisos.some((a) => a.includes('orçamento')), 'aviso de ausência de orçamento');
  });
}

// ── 3. Todas as quotas recebidas ────────────────────────────────────
async function cenarioTudoRecebido() {
  const quotas = [quota(1, 1, 1, 100), quota(2, 2, 1, 100)];
  await comDados(cenarioBase({
    quotas,
    aplicacoesQuota: [{ quota_id: 1, valor_aplicado: '100.00' }, { quota_id: 2, valor_aplicado: '100.00' }],
    pagamentos: [
      { id: 40, fracao_id: 1, valor: '100.00', data_pagamento: '2026-01-10', estado: 'confirmado' },
      { id: 41, fracao_id: 2, valor: '100.00', data_pagamento: '2026-01-11', estado: 'confirmado' },
    ],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.receitas.totais.lancadoC, C(200), 'lançado');
    assert.strictEqual(r.receitas.totais.recebidoC, C(200), 'recebido');
    assert.strictEqual(r.receitas.totais.emDividaC, 0, 'nada em dívida');
    assert.strictEqual(r.sintese.dividaCondominosC, 0, 'sem dívida de condóminos');
    assert.strictEqual(r.dividasCondominos.nFracoesEmDivida, 0, 'nenhuma fração em dívida');
  });
}

// ── 4. Quotas parcialmente recebidas ────────────────────────────────
async function cenarioParcialmenteRecebido() {
  const quotas = [quota(1, 1, 1, 100), quota(2, 2, 1, 100)];
  await comDados(cenarioBase({
    quotas,
    aplicacoesQuota: [{ quota_id: 1, valor_aplicado: '40.00' }],
    pagamentos: [{ id: 40, fracao_id: 1, valor: '40.00', data_pagamento: '2026-01-10', estado: 'confirmado' }],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.receitas.totais.recebidoC, C(40), 'recebido parcial');
    assert.strictEqual(r.receitas.totais.emDividaC, C(160), 'em dívida = lançado − recebido');
    assert.strictEqual(r.sintese.dividaCondominosC, C(160), 'dívida acumulada das frações');
    const fracao1 = r.dividasCondominos.fracoes.find((f) => f.fracaoId === 1);
    assert.strictEqual(fracao1.emDividaC, C(60), 'fração 1 deve 60');
    assert.strictEqual(fracao1.creditoC, 0, 'sem crédito');
  });
}

// ── 5. Dívidas de períodos anteriores ao período ────────────────────
async function cenarioDividasAnteriores() {
  const quotas = [
    { ...quota(1, 1, 11, 100), ano: 2025, periodo: '2025-11-01', data_vencimento: '2025-11-08' },
    { ...quota(2, 2, 11, 100), ano: 2025, periodo: '2025-11-01', data_vencimento: '2025-11-08' },
    quota(3, 1, 1, 100),
    quota(4, 2, 1, 100),
  ];
  await comDados(cenarioBase({
    quotas,
    fracoes: [
      { id: 1, designacao: '1.º Esq', permilagem: '500', transitado: '25.00', estado: 'ativo' },
      { id: 2, designacao: '1.º Dto', permilagem: '500', transitado: 0, estado: 'ativo' },
    ],
    aplicacoesQuota: [
      { quota_id: 2, valor_aplicado: '100.00' }, // paga a quota de 2025 da fração 2
      { quota_id: 3, valor_aplicado: '100.00' }, // paga a quota de 2026 da fração 1
    ],
    pagamentos: [
      { id: 40, fracao_id: 2, valor: '100.00', data_pagamento: '2026-01-05', estado: 'confirmado' },
      { id: 41, fracao_id: 1, valor: '100.00', data_pagamento: '2026-01-20', estado: 'confirmado' },
    ],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-03-31' });
    // Só as quotas de 2026 entram no período do relatório.
    assert.strictEqual(r.receitas.totais.lancadoC, C(200), 'lançado apenas do período');
    assert.strictEqual(r.receitas.totais.recebidoC, C(100), 'recebido do período (a quota de 2025 não conta)');
    // A dívida acumulada inclui o que vem de trás: fração 1 deve a quota de 2025
    // (100) mais o transitado (25); fração 2 deve a quota de 2026 (100).
    assert.strictEqual(r.sintese.dividaCondominosC, C(225), 'dívida acumulada = 125 (fração 1) + 100 (fração 2)');
    assert.strictEqual(r.sintese.dividaCondominosTransitadaC, C(25), 'transitado das frações identificado');
    const f1 = r.dividasCondominos.fracoes.find((f) => f.fracaoId === 1);
    assert.strictEqual(f1.emDividaC, C(125), 'fração 1: 100 de 2025 + 25 transitado');
    assert.strictEqual(f1.lancadoPeriodoC, C(100), 'lançado no período apenas a quota de 2026');
    assert.strictEqual(f1.recebidoPeriodoC, C(100), 'recebido no período');
  });
}

// ── 6/7. Faturas pagas e parcialmente pagas ─────────────────────────
async function cenarioFaturasPagas() {
  const despesas = [
    { id: 50, descricao: 'Elevador — assistência', categoria_id: 7, valor: '200.00', data: '2026-02-10', competencia_ano: 2026, competencia_mes: 2, fornecedor_id: 30, estado: 'paga', categoria: { id: 7, nome: 'Elevadores', tipo: 'despesa' }, fornecedorReg: { id: 30, nome: 'Otis' } },
    { id: 51, descricao: 'Elevador — peças', categoria_id: 7, valor: '100.00', data: '2026-03-10', competencia_ano: 2026, competencia_mes: 3, fornecedor_id: 30, estado: 'registada', categoria: { id: 7, nome: 'Elevadores', tipo: 'despesa' }, fornecedorReg: { id: 30, nome: 'Otis' } },
  ];
  await comDados(cenarioBase({
    despesas,
    pagamentosFornecedor: [{ id: 60, fornecedor_id: 30, despesa_id: 51, valor: '40.00', data_pagamento: '2026-03-20', estado: 'pago' }],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    const elevadores = r.despesas.rubricas.find((x) => x.designacao === 'Elevadores');
    assert.ok(elevadores, 'rubrica Elevadores presente');
    assert.strictEqual(elevadores.faturadoC, C(300), 'faturado 300');
    assert.strictEqual(elevadores.pagoC, C(240), 'pago = 200 (fatura paga) + 40 (pagamento parcial)');
    assert.strictEqual(elevadores.porPagarC, C(60), 'por pagar 60');
    assert.strictEqual(r.despesas.totais.porPagarC, C(60), 'total por pagar');
    assert.strictEqual(r.sintese.dividaFornecedoresC, C(60), 'dívida ao fornecedor 60');
  });
}

// ── 8. Dívida a fornecedor transitada (saldo inicial) ───────────────
async function cenarioFornecedorTransitado() {
  const despesas = [
    { id: 50, descricao: 'Limpeza — janeiro', categoria_id: 8, valor: '80.00', data: '2026-01-15', competencia_ano: 2026, competencia_mes: 1, fornecedor_id: 31, estado: 'registada', categoria: { id: 8, nome: 'Eletricidade', tipo: 'despesa' }, fornecedorReg: { id: 31, nome: 'Limpezas Lda' } },
  ];
  await comDados(cenarioBase({
    despesas,
    fornecedores: [{ id: 31, nome: 'Limpezas Lda' }],
    saldosFornecedor: [{ id: 70, fornecedor_id: 31, data: '2025-12-31', valor: '150.00', tipo: 'saldo_transitado', descricao: 'Dívida de 2025' }],
    pagamentosFornecedor: [{ id: 60, fornecedor_id: 31, despesa_id: null, valor: '50.00', data_pagamento: '2026-01-31', estado: 'pago' }],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    const forn = r.dividasFornecedores.fornecedores.find((f) => f.fornecedorId === 31);
    assert.strictEqual(forn.saldoInicialC, C(150), 'saldo inicial/transitado registado');
    assert.strictEqual(forn.dividaC, C(180), 'dívida = 150 + 80 − 50');
    assert.strictEqual(r.sintese.dividaFornecedoresC, C(180), 'dívida total a fornecedores');
  });
  // Saldo inicial datado DEPOIS da data de fim não conta no relatório.
  await comDados(cenarioBase({
    fornecedores: [{ id: 31, nome: 'Limpezas Lda' }],
    saldosFornecedor: [{ id: 70, fornecedor_id: 31, data: '2027-01-01', valor: '150.00', tipo: 'saldo_inicial', descricao: '' }],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.sintese.dividaFornecedoresC, 0, 'saldo posterior à data de fim fica de fora');
  });
}

// ── 9. Vários fornecedores na mesma rubrica (uma só linha) ──────────
async function cenarioVariosFornecedoresMesmaRubrica() {
  const despesas = [1, 2, 3, 4, 5].map((n) => ({
    id: 50 + n,
    descricao: `Elevadores — fornecedor ${n}`,
    categoria_id: 7,
    valor: '470.00',
    data: `2026-0${n}-10`,
    competencia_ano: 2026,
    competencia_mes: n,
    fornecedor_id: 30 + n,
    estado: 'paga',
    categoria: { id: 7, nome: 'Elevadores', tipo: 'despesa' },
    fornecedorReg: { id: 30 + n, nome: `Fornecedor ${n}` },
  }));
  await comDados(cenarioBase({
    despesas,
    fornecedores: [1, 2, 3, 4, 5].map((n) => ({ id: 30 + n, nome: `Fornecedor ${n}` })),
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' , opcoes: { despesas_por_fornecedor: true } });
    assert.strictEqual(r.despesas.rubricas.length, 2, 'apenas as rubricas (Elevadores + Eletricidade)');
    const elevadores = r.despesas.rubricas.find((x) => x.designacao === 'Elevadores');
    // 5 × 470,00 € = 2.350,00 € numa única linha (nenhum fornecedor na tabela principal).
    assert.strictEqual(elevadores.faturadoC, C(2350), 'soma dos 5 fornecedores numa linha');
    assert.strictEqual(elevadores.nFaturas, 5, '5 faturas agregadas');
    assert.ok(!('fornecedor' in elevadores) || elevadores.fornecedor === undefined, 'a rubrica não expõe fornecedor na tabela principal');
    assert.strictEqual(r.detalhe.despesasPorFornecedor[0].fornecedores.length, 5, 'detalhe por fornecedor tem os 5');
  });
}

// ── 10. Várias rubricas + rubrica sem execução ──────────────────────
async function cenarioVariasRubricas() {
  const despesas = [
    { id: 50, descricao: 'Luz', categoria_id: 8, valor: '90.00', data: '2026-02-01', competencia_ano: 2026, competencia_mes: 2, estado: 'registada', categoria: { id: 8, nome: 'Eletricidade', tipo: 'despesa' }, fornecedorReg: null },
    { id: 51, descricao: 'Sem rubrica', categoria_id: null, valor: '10.00', data: '2026-02-05', competencia_ano: 2026, competencia_mes: 2, estado: 'registada', categoria: null, fornecedorReg: null },
  ];
  await comDados(cenarioBase({ despesas }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-06-30' });
    const nomes = r.despesas.rubricas.map((x) => x.designacao);
    assert.ok(nomes.includes('Elevadores'), 'rubrica orçamentada sem execução aparece');
    assert.ok(nomes.includes('Eletricidade'), 'rubrica com execução');
    assert.ok(nomes.includes('Sem rubrica'), 'despesa sem categoria tem linha própria');
    const elevadores = r.despesas.rubricas.find((x) => x.designacao === 'Elevadores');
    assert.strictEqual(elevadores.orcamentadoC, C(1200), 'orçamentado do semestre (6 meses de 200 €/mês)');
    const semRubrica = r.despesas.rubricas.find((x) => x.designacao === 'Sem rubrica');
    assert.strictEqual(semRubrica.faturadoC, C(10), 'valor sem rubrica visível');
    assert.strictEqual(r.despesas.totais.faturadoC, C(100), 'total faturado');
  });
}

// ── 11. Várias contas bancárias + 12. transferências ────────────────
async function cenarioContasETransferencias() {
  await comDados(cenarioBase({
    contas: [
      { id: 20, nome: 'Corrente', banco: 'CGD', iban: 'PT50', tipo: 'corrente', saldo_inicial: '1000.00', ativa: true },
      { id: 21, nome: 'Fundo de reserva', banco: 'CGD', iban: 'PT51', tipo: 'fundo_reserva', saldo_inicial: '500.00', ativa: true },
    ],
    movimentos: [
      { id: 1, conta_bancaria_id: 20, data: '2026-02-01', tipo: 'entrada', valor: '300.00', referencia: 'PAG-1', estado: 'confirmado' },
      { id: 2, conta_bancaria_id: 20, data: '2026-02-10', tipo: 'saida', valor: '500.00', referencia: 'TRANSF', estado: 'confirmado' },
      { id: 3, conta_bancaria_id: 21, data: '2026-02-10', tipo: 'entrada', valor: '500.00', referencia: 'TRANSF', estado: 'confirmado' },
      { id: 4, conta_bancaria_id: 20, data: '2026-06-01', tipo: 'saida', valor: '999.00', referencia: 'X', estado: 'anulado' },
      { id: 5, conta_bancaria_id: 20, data: '2027-01-05', tipo: 'saida', valor: '111.00', referencia: 'FUT', estado: 'confirmado' },
    ],
    quotas: [quota(1, 1, 2, 300)],
    aplicacoesQuota: [{ quota_id: 1, valor_aplicado: '300.00' }],
    pagamentos: [{ id: 40, fracao_id: 1, valor: '300.00', data_pagamento: '2026-02-01', estado: 'confirmado' }],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    const corrente = r.contas.contas.find((c) => c.id === 20);
    const reserva = r.contas.contas.find((c) => c.id === 21);
    assert.strictEqual(corrente.saldoC, C(800), 'corrente: 1000 + 300 − 500 (transferência)');
    assert.strictEqual(reserva.saldoC, C(1000), 'reserva: 500 + 500 (transferência)');
    assert.strictEqual(r.contas.totalC, C(1800), 'total; o movimento anulado e o futuro ficam fora');
    assert.strictEqual(r.sintese.fundoReservaC, C(1000), 'fundo de reserva = saldo da conta de FCR');
    assert.strictEqual(r.contas.transferencias.n, 2, 'transferências detetadas');
    // Transferência não é receita nem despesa: receitas = só a quota recebida.
    assert.strictEqual(r.sintese.totalReceitasRecebidasC, C(300), 'transferência não é receita');
    assert.strictEqual(r.sintese.totalDespesasFaturadasC, 0, 'transferência não é despesa');
  });
}

// ── 13. Período parcial ─────────────────────────────────────────────
async function cenarioPeriodoParcial() {
  const quotas = [quota(1, 1, 1, 100), quota(2, 1, 2, 100), quota(3, 1, 3, 100), quota(4, 1, 4, 100)];
  await comDados(cenarioBase({ quotas }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-03-31' });
    assert.strictEqual(r.receitas.totais.lancadoC, C(300), 'apenas janeiro a março');
    assert.strictEqual(r.periodo.meses, 3, '3 meses');
    const elevadores = r.despesas.rubricas.find((x) => x.designacao === 'Elevadores');
    assert.strictEqual(elevadores.orcamentadoC, C(600), 'orçamentado proporcional (3 × 200)');
    assert.strictEqual(r.periodo.anos[0], 2026, 'ano do período');
  });
}

// ── 14/15/16. Detalhe e observações ─────────────────────────────────
async function cenarioDetalheEObservacoes() {
  const quotas = [quota(1, 1, 1, 100), quota(2, 2, 1, 100)];
  const base = cenarioBase({
    quotas,
    aplicacoesQuota: [{ quota_id: 1, valor_aplicado: '100.00' }],
    pagamentos: [{ id: 40, fracao_id: 1, valor: '100.00', data_pagamento: '2026-01-10', estado: 'confirmado' }],
    saldosFornecedor: [{ id: 70, fornecedor_id: 30, data: '2025-12-31', valor: '25.00', tipo: 'saldo_inicial', descricao: 'obra 2025' }],
  });

  await comDados(base, async () => {
    const semDetalhe = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.deepStrictEqual(semDetalhe.detalhe, {}, 'sem opções → sem detalhe');
    assert.strictEqual(semDetalhe.observacoes, '', 'sem observações');

    const comDetalhe = await balanceteFinanceiro({
      condominioId: 1,
      dataInicio: '2026-01-01',
      dataFim: '2026-12-31',
      opcoes: {
        notas: true,
        dividas_condominos: true,
        dividas_fornecedores: true,
        despesas_por_fornecedor: true,
        receitas_por_fracao: true,
        observacoes: 'Balancete aprovado em assembleia.',
      },
    });
    assert.ok(comDetalhe.detalhe.notas, 'notas detalhadas');
    assert.ok(comDetalhe.detalhe.dividasCondominos.length >= 1, 'discriminação das dívidas dos condóminos');
    assert.ok(comDetalhe.detalhe.dividasFornecedores.length >= 1, 'discriminação das dívidas a fornecedores');
    assert.ok(Array.isArray(comDetalhe.detalhe.receitasPorFracao), 'receitas por fração');
    assert.strictEqual(comDetalhe.observacoes, 'Balancete aprovado em assembleia.', 'observações preservadas');
    // As opções NÃO alteram os cálculos.
    assert.deepStrictEqual(comDetalhe.sintese, semDetalhe.sintese, 'síntese igual com e sem detalhe');
    assert.deepStrictEqual(comDetalhe.receitas.totais, semDetalhe.receitas.totais, 'receitas iguais');
    assert.deepStrictEqual(comDetalhe.despesas.rubricas.map((x) => x.faturadoC), semDetalhe.despesas.rubricas.map((x) => x.faturadoC), 'despesas iguais');
  });
}

// ── Quotas extraordinárias (lançado/recebido/em dívida por rubrica) ──
async function cenarioQuotaExtra() {
  await comDados(cenarioBase({
    extras: [{ id: 80, condominio_id: 1, designacao: 'Obras de fachada', valor_total: '600.00', ano_inicio: 2026, mes_inicio: 3, numero_parcelas: 2, periodicidade: 'mensal', estado: 'processada' }],
    parcelas: [
      { id: 90, extra_quota_id: 80, fracao_id: 1, parcela_numero: 1, valor: '300.00', data_vencimento: '2026-03-08', estado: 'paga', extra_quota: { id: 80, condominio_id: 1, designacao: 'Obras de fachada' } },
      { id: 91, extra_quota_id: 80, fracao_id: 1, parcela_numero: 2, valor: '300.00', data_vencimento: '2026-09-08', estado: 'pendente', extra_quota: { id: 80, condominio_id: 1, designacao: 'Obras de fachada' } },
    ],
    aplicacoesParcela: [{ extra_quota_parcela_id: 90, valor_aplicado: '300.00' }],
    pagamentos: [{ id: 41, fracao_id: 1, valor: '300.00', data_pagamento: '2026-03-08', estado: 'confirmado' }],
  }), async () => {
    // Período só até junho: apenas a 1.ª parcela está lançada.
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-06-30' });
    const linhaExtra = r.receitas.rubricas.find((x) => x.tipo === 'quota_extra');
    assert.ok(linhaExtra, 'linha da quota extraordinária presente');
    assert.strictEqual(linhaExtra.designacao, 'Quota extraordinária — Obras de fachada', 'designação da rubrica');
    assert.strictEqual(linhaExtra.orcamentadoC, C(300), 'orçamentado rateado pela parcela do período (1 de 2)');
    assert.strictEqual(linhaExtra.lancadoC, C(300), 'só a parcela vencida no período');
    assert.strictEqual(linhaExtra.recebidoC, C(300), 'parcela paga');
    assert.strictEqual(linhaExtra.emDividaC, 0, 'sem dívida nesta rubrica');
    assert.strictEqual(r.receitas.totais.lancadoC, C(300), 'total de receitas do período');
    // A 2.ª parcela ainda não venceu à data de fim (setembro > junho): não é
    // dívida à data do relatório.
    assert.strictEqual(r.sintese.dividaCondominosC, 0, 'parcela com vencimento posterior à data de fim não é dívida');
    // Período até dezembro: as duas parcelas entram.
    const anual = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    const linhaAnual = anual.receitas.rubricas.find((x) => x.tipo === 'quota_extra');
    assert.strictEqual(linhaAnual.lancadoC, C(600), 'as duas parcelas no ano');
    assert.strictEqual(linhaAnual.orcamentadoC, C(600), 'no ano completo o orçamentado é o valor total aprovado');
    assert.strictEqual(linhaAnual.emDividaC, C(300), 'em dívida = 600 − 300');
    assert.strictEqual(anual.sintese.dividaCondominosC, C(300), 'dívida acumulada igual');
  });
}

// ── 17. Dois condomínios independentes ──────────────────────────────
async function cenarioDoisCondominios() {
  // O motor recebe apenas as linhas do condomínio ativo (é o que as consultas
  // filtradas devolvem); aqui garante-se que os totais não se misturam.
  await comDados(cenarioBase({
    quotas: [quota(1, 1, 1, 100)],
    aplicacoesQuota: [{ quota_id: 1, valor_aplicado: '100.00' }],
    pagamentos: [{ id: 40, fracao_id: 1, valor: '100.00', data_pagamento: '2026-01-10', estado: 'confirmado' }],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.condominioId, 1, 'condomínio identificado no resultado');
    assert.strictEqual(r.receitas.totais.lancadoC, C(100), 'apenas o condomínio ativo');
    assert.strictEqual(r.sintese.dividaCondominosC, 0, 'sem dívidas');
  });
  await comDados(cenarioBase({
    quotas: [quota(1, 1, 1, 999)],
  }), async () => {
    const r = await balanceteFinanceiro({ condominioId: 2, dataInicio: '2026-01-01', dataFim: '2026-12-31' });
    assert.strictEqual(r.receitas.totais.lancadoC, C(999), 'outro condomínio tem os seus próprios valores');
    assert.strictEqual(r.sintese.dividaCondominosC, C(999), 'dívida do outro condomínio');
  });
}

// ── Funções puras ───────────────────────────────────────────────────
function testesPuros() {
  // Orçamentado proporcional à periodicidade.
  assert.strictEqual(orcamentadoDoPeriodo({ valorAnualC: C(1200), periodicidade: 'mensal', inicioOrcamentoYM: 202601, ymInicio: 202601, ymFim: 202603 }), C(300));
  assert.strictEqual(orcamentadoDoPeriodo({ valorAnualC: C(1200), periodicidade: 'trimestral', inicioOrcamentoYM: 202601, ymInicio: 202601, ymFim: 202612 }), C(1200));
  assert.strictEqual(orcamentadoDoPeriodo({ valorAnualC: C(1200), periodicidade: 'anual', inicioOrcamentoYM: 202601, ymInicio: 202607, ymFim: 202612 }), 0);
  assert.strictEqual(ocorrenciasNoPeriodo({ periodicidade: 'semestral', inicioOrcamentoYM: 202601, ymInicio: 202607, ymFim: 202612 }), 1);

  // Pago por fatura: "paga" vale o total; parcial vem dos pagamentos; nunca excede o valor.
  assert.strictEqual(pagoDaDespesa({ valorC: C(100), estado: 'paga' }), C(100));
  assert.strictEqual(pagoDaDespesa({ valorC: C(100), estado: 'registada', pagamentosC: C(30) }), C(30));
  assert.strictEqual(pagoDaDespesa({ valorC: C(100), estado: 'registada', pagamentosC: C(130) }), C(100));
  assert.strictEqual(pagoDaDespesa({ valorC: C(100), estado: 'anulada', pagamentosC: C(30) }), 0);

  // Dívida a fornecedor com sinal.
  assert.deepStrictEqual(resumoDividaFornecedor({ saldoInicialC: C(100), faturadoC: C(50), pagoC: C(30) }), { saldoC: C(120), dividaC: C(120), creditoC: 0 });
  assert.strictEqual(resumoDividaFornecedor({ faturadoC: C(10), pagoC: C(40) }).creditoC, C(30));

  // Saldo de conta à data, ignorando anulados e movimentos posteriores.
  const s = saldoContaNaData({
    saldoInicialC: C(100),
    movimentos: [
      { tipo: 'entrada', valor: '50.00', estado: 'confirmado', data: '2026-01-10' },
      { tipo: 'saida', valor: '20.00', estado: 'anulado', data: '2026-02-10' },
      { tipo: 'saida', valor: '30.00', estado: 'confirmado', data: '2026-09-10' },
    ],
    dataCorte: '2026-06-30',
  });
  assert.strictEqual(s.saldoC, C(150), 'saldo à data de corte');

  // Competência: competência declarada > data > registo.
  assert.strictEqual(competenciaDaDespesa({ competencia_ano: 2026, competencia_mes: 4, data: '2026-07-01' }), 202604);
  assert.strictEqual(competenciaDaDespesa({ data: '2026-07-01' }), 202607);
}

// ── PDF ─────────────────────────────────────────────────────────────
function textoDoPdf(buffer) {
  const bruto = buffer.toString('latin1');
  let conteudo = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(bruto)) !== null) {
    try { conteudo += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (e) { conteudo += m[1]; }
  }
  let texto = '';
  const reHex = /<([0-9A-Fa-f\s]+)>/g;
  let h;
  while ((h = reHex.exec(conteudo)) !== null) {
    const hex = h[1].replace(/\s+/g, '');
    if (hex.length % 2 !== 0) continue;
    texto += Buffer.from(hex, 'hex').toString('latin1');
  }
  const reLiteral = /\(((?:\\.|[^\\()])*)\)/g;
  let l;
  while ((l = reLiteral.exec(conteudo)) !== null) texto += l[1].replace(/\\([()\\])/g, '$1');
  return texto;
}

async function testesPdf() {
  const quotas = [quota(1, 1, 1, 100), quota(2, 2, 1, 100)];
  await comDados(cenarioBase({
    quotas,
    aplicacoesQuota: [{ quota_id: 1, valor_aplicado: '40.00' }],
    pagamentos: [{ id: 40, fracao_id: 1, valor: '40.00', data_pagamento: '2026-01-10', estado: 'confirmado' }],
    despesas: [
      { id: 50, descricao: 'Elevador', categoria_id: 7, valor: '60.00', data: '2026-01-20', competencia_ano: 2026, competencia_mes: 1, fornecedor_id: 30, estado: 'registada', categoria: { id: 7, nome: 'Elevadores', tipo: 'despesa' }, fornecedorReg: { id: 30, nome: 'Otis' } },
    ],
    saldosFornecedor: [{ id: 70, fornecedor_id: 30, data: '2025-12-31', valor: '150.00', tipo: 'saldo_transitado', descricao: 'Dívida de 2025' }],
  }), async () => {
    const dados = await balanceteFinanceiro({
      condominioId: 1,
      dataInicio: '2026-01-01',
      dataFim: '2026-12-31',
      opcoes: { notas: true, dividas_condominos: true, dividas_fornecedores: true, observacoes: 'Nota de teste com acentuação: ç, ã, õ.' },
    });
    const buffer = await gerarRelatorioFinanceiroPDF(
      { designacao: 'Condomínio Teste', nif: '509999999', identidade_visual: 'designacao' },
      { ...dados, emitidoEm: new Date('2026-12-31'), observacoes: 'Nota de teste com acentuação: ç, ã, õ.' }
    );
    assert.ok(buffer.length > 2000, 'PDF gerado com conteúdo');
    assert.strictEqual(buffer.slice(0, 5).toString('latin1'), '%PDF-', 'assinatura PDF');

    const texto = textoDoPdf(buffer);
    const plano = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const alvo of [
      'Relat', 'RECEITAS', 'DESPESAS', 'RUBRICA', 'ORCAMENTADO', 'LANCADO', 'RECEBIDO', 'EM DIVIDA',
      'FATURADO', 'PAGO', 'POR PAGAR', 'SINTESE FINANCEIRA', 'CONTAS BANCARIAS', 'OBSERVACOES',
      'DETALHE', 'Condominio Teste', 'Documento processado atraves da plataforma GesCondu', 'Pagina 1 de',
      'Nota de teste com acentuacao: c, a, o.', 'Elevadores', 'Otis',
    ]) {
      assert.ok(plano.includes(alvo), `PDF deve conter «${alvo}»`);
    }
    // Resultado: 200 lançado − 60 faturado = 140,00 €
    assert.ok(plano.includes('140,00'), 'resultado do período no PDF');
    // Sem rubricas de fornecedor na tabela principal de despesas nem frações nas receitas.
    assert.ok(!plano.includes('1.o Esq'), 'a tabela principal de receitas não lista frações');
  });

  // Relatório mínimo (sem orçamento, sem movimentos, sem detalhe) — não pode falhar.
  await comDados({ quotas: [], extras: [], parcelas: [], contas: [], movimentos: [], fracoes: [], orcamentos: [], planos: [], despesas: [], pagamentos: [], pagamentosFornecedor: [], saldosFornecedor: [], fornecedores: [], aplicacoesQuota: [], aplicacoesParcela: [] }, async () => {
    const dados = await balanceteFinanceiro({ condominioId: 1, dataInicio: '2026-01-01', dataFim: '2026-01-31' });
    const buffer = await gerarRelatorioFinanceiroPDF({ designacao: 'Sem dados' }, { ...dados, emitidoEm: new Date('2026-01-31') });
    const texto = textoDoPdf(buffer);
    assert.ok(texto.includes('RECEITAS') && texto.includes('DESPESAS'), 'relatório vazio continua estruturado');
    assert.ok(!texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes('OBSERVACOES'), 'sem observações quando o campo está vazio');
  });
}

// ── Isolamento e integração (estrutura do código) ───────────────────
function testesIsolamentoEIntegracao() {
  // Todas as consultas de negócio filtram pelo condomínio ativo.
  const consultas = codigoMotor.match(/findAll\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(consultas.length >= 8, 'o motor faz várias consultas');
  assert.ok(/ondeCond\s*=\s*\{\s*condominio_id:\s*condominioId\s*\}/.test(codigoMotor), 'escopo por condominio_id definido uma só vez');
  assert.ok(/condominio_id:\s*condominioId/.test(codigoMotor), 'consultas filtram por condominio_id');
  // Movimentos bancários não têm condominio_id: filtro pela conta (associação).
  assert.ok(/MovimentoBancario[\s\S]{0,400}ContaBancaria[\s\S]{0,200}where:\s*ondeCond/.test(codigoMotor), 'movimentos filtrados pela conta do condomínio');
  assert.ok(/parcelas[\s\S]{0,600}condominio_id:\s*condominioId/.test(codigoMotor), 'parcelas de quota extra filtradas pela quota extra do condomínio');

  // Rotas: condomínio ativo + papel, e PDF pela via dos recibos.
  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(codigoRotas), 'rotas exigem condomínio ativo');
  assert.ok(/router\.use\(tenant\.comPapel\('gestor'\)\)/.test(codigoRotas), 'rotas exigem papel gestor');
  assert.ok(/gerarRelatorioFinanceiroPDF/.test(codigoRotas), 'rota do PDF usa o gerador partilhado');
  assert.ok(/cabecalhos\.disposicao/.test(codigoRotas), 'nome do ficheiro saneado como nos recibos');
  assert.ok(/condominioId:\s*req\.condominioId/.test(codigoRotas), 'motor chamado com o condomínio ativo');

  // O gerador do PDF vive em helpers/pdf.js (reutiliza o Layout do recibo).
  assert.ok(/async function gerarRelatorioFinanceiroPDF/.test(codigoPdf), 'gerador do relatório em helpers/pdf.js');
  assert.ok(/module\.exports\s*=\s*\{[^}]*gerarRelatorioFinanceiroPDF/.test(codigoPdf), 'gerador exportado');
  assert.ok(/finalizarPaginacao\(doc, condominio\)/.test(codigoPdf), 'rodapé/paginação partilhados');

  // A vista: período, opções de detalhe, observações e botão de PDF.
  for (const alvo of ['name="inicio"', 'name="fim"', 'name="d_notas"', 'name="d_dividas_condominos"',
    'name="d_dividas_fornecedores"', 'name="d_despesas_fornecedor"', 'name="d_receitas_fracao"',
    'name="observacoes"', '/admin/relatorios/financeiro/pdf', 'Gerar relatório PDF']) {
    assert.ok(vista.includes(alvo), `vista deve conter «${alvo}»`);
  }
  // Navegação: grupo Relatórios com o Relatório financeiro.
  assert.ok(layout.includes('>Relatórios<'), 'grupo Relatórios na navegação');
  assert.ok(layout.includes('href="/admin/relatorios/financeiro"'), 'ligação para o relatório financeiro');
}

// ── Execução ────────────────────────────────────────────────────────
(async () => {
  await cenarioSemMovimentos();
  await cenarioSaldoTransitado();
  await cenarioTudoRecebido();
  await cenarioParcialmenteRecebido();
  await cenarioDividasAnteriores();
  await cenarioFaturasPagas();
  await cenarioFornecedorTransitado();
  await cenarioVariosFornecedoresMesmaRubrica();
  await cenarioVariasRubricas();
  await cenarioContasETransferencias();
  await cenarioPeriodoParcial();
  await cenarioDetalheEObservacoes();
  await cenarioQuotaExtra();
  await cenarioDoisCondominios();
  testesPuros();
  await testesPdf();
  testesIsolamentoEIntegracao();
  console.log('✓ Testes do Relatório Financeiro passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ Testes do Relatório Financeiro falharam:', err.message);
  console.error(err.stack);
  process.exit(1);
});
