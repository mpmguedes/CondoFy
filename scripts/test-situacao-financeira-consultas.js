// ═══════════════════════════════════════════════════════════════════
// Situação financeira do condómino — CONSULTAS do resumo.
//
// O teste das rotas substitui os ajudantes (para executar o handler); o teste
// da aritmética cobre a parte pura. Ficava de fora o meio: as consultas de
// `resumoFinanceiro`. É aqui que esse caminho corre, com duplos dos modelos
// (sem base de dados). Cobre também os campos que o ajudante lê dos modelos —
// um nome mal escrito (variável ou modelo inexistente) falha este teste.
//
// Utilização: node scripts/test-situacao-financeira-consultas.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const ANO = 2026;

// ── Dados de exemplo (linhas cruas, como as consultas as devolvem) ──
const CONTAS = [
  { id: 1, condominio_id: 1, nome: 'Conta principal', banco: 'Banco A', iban: 'PT50 0002 0123 1234 5678 9015 4', tipo: 'corrente', saldo_inicial: 1000, ativa: true },
  { id: 2, condominio_id: 1, nome: 'Fundo de reserva', banco: 'Banco A', iban: null, tipo: 'fundo_reserva', saldo_inicial: 500, ativa: true },
];
const PAGAMENTOS = [
  { id: 1, valor: 75, data_pagamento: `${ANO}-07-05`, estado: 'confirmado', condominio_id: 1 },
  { id: 2, valor: 50, data_pagamento: `${ANO}-09-01`, estado: 'confirmado', condominio_id: 1 },
  { id: 3, valor: 200, data_pagamento: `${ANO}-09-15`, estado: 'anulado', condominio_id: 1 },
];
const DESPESAS = [
  { id: 1, valor: 300, data: `${ANO}-03-10`, estado: 'paga', competencia_ano: ANO, condominio_id: 1 },
  { id: 2, valor: 100, data: `${ANO}-07-20`, estado: 'pendente', competencia_ano: ANO, condominio_id: 1 },
  { id: 3, valor: 800, data: `${ANO}-09-05`, estado: 'anulada', competencia_ano: ANO, condominio_id: 1 },
];
const QUOTAS = [
  { id: 101, condominio_id: 1, fracao_id: 5, ano: ANO, mes: 7, valor: 75, estado: 'paga', data_vencimento: `${ANO}-07-10` },
  { id: 102, condominio_id: 1, fracao_id: 5, ano: ANO, mes: 8, valor: 75, estado: 'pendente', data_vencimento: `${ANO}-08-10` },
  { id: 103, condominio_id: 1, fracao_id: 6, ano: ANO, mes: 9, valor: 100, estado: 'parcialmente_paga', data_vencimento: `${ANO}-09-05` },
  { id: 104, condominio_id: 1, fracao_id: 6, ano: ANO, mes: 5, valor: 42.5, estado: 'anulada', data_vencimento: `${ANO}-05-05` },
];
const APLICACOES = [
  { quota_id: 101, valor_aplicado: 75, pagamento: { id: 1, estado: 'confirmado' } },
  { quota_id: 103, valor_aplicado: 50, pagamento: { id: 2, estado: 'confirmado' } },
  { quota_id: 102, valor_aplicado: 75, pagamento: { id: 3, estado: 'anulado' } },
];
const MOVIMENTOS = {
  1: [{ tipo: 'entrada', valor: 300, estado: 'confirmado' }, { tipo: 'saida', valor: 120, estado: 'confirmado' }],
  2: [{ tipo: 'entrada', valor: 60, estado: 'confirmado' }],
};
const ORCAMENTO = {
  id: 1, condominio_id: 1, ano: ANO, estado: 'em_execucao',
  rubricas: [{ id: 1, valor_anual: 4200, ativo: true }, { id: 2, valor_anual: 6600, ativo: true }],
};

// ── Duplos dos modelos (antes de carregar o ajudante) ──────────────
const consultas = [];
function registar(nome, onde) {
  consultas.push({ nome, onde });
}

function filtro(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].includes(l[k]);
    // `Op.ne` (excluir) e `Op.between` (intervalo) usam os mesmos símbolos que a
    // aplicação porque este teste importa a MESMA instância do Sequelize.
    if (v && typeof v === 'object' && v[Op.ne] !== undefined) return l[k] !== v[Op.ne];
    if (v && typeof v === 'object' && v[Op.between]) return String(l[k] || '') >= v[Op.between][0] && String(l[k] || '') <= v[Op.between][1];
    return l[k] === v;
  }));
}

const modelos = {
  ContaBancaria: {
    findAll: async (o = {}) => { registar('ContaBancaria.findAll', o.where); return filtro(CONTAS, o.where); },
  },
  MovimentoBancario: {
    sum: async (campo, o = {}) => {
      registar('MovimentoBancario.sum', o.where);
      const linhas = MOVIMENTOS[o.where.conta_bancaria_id] || [];
      return linhas
        .filter((m) => m.tipo === o.where.tipo && m.estado === o.where.estado)
        .reduce((s, m) => s + m.valor, 0);
    },
    // `saldoContaMovimentos` lê os movimentos da conta e soma entradas/saídas
    // (mesma regra, agora numa única consulta).
    findAll: async (o = {}) => {
      registar('MovimentoBancario.findAll', o.where);
      const linhas = MOVIMENTOS[o.where.conta_bancaria_id] || [];
      return linhas.filter((m) => m.estado === o.where.estado);
    },
  },
  Pagamento: {
    findAll: async (o = {}) => { registar('Pagamento.findAll', o.where); return filtro(PAGAMENTOS, o.where); },
  },
  Despesa: {
    findAll: async (o = {}) => { registar('Despesa.findAll', o.where); return filtro(DESPESAS, o.where); },
    sum: async (campo, o = {}) => {
      registar('Despesa.sum', o.where);
      return filtro(DESPESAS, o.where).reduce((s, d) => s + d.valor, 0);
    },
  },
  Quota: {
    findAll: async (o = {}) => { registar('Quota.findAll', o.where); return filtro(QUOTAS, o.where); },
  },
  Orcamento: {
    findOne: async (o = {}) => { registar('Orcamento.findOne', o.where); return ORCAMENTO; },
  },
  OrcamentoRubrica: {},
  Fracao: {
    // Um nome errado daqui para baixo parte logo este teste.
    count: async (o = {}) => { registar('Fracao.count', o.where); return 12; },
  },
  PagamentoQuota: {
    // `pagoPorQuota` só conta aplicações de pagamentos CONFIRMADOS (o `include`
    // filtra no lado da base de dados) — o duplo reproduz isso.
    findAll: async (o = {}) => {
      registar('PagamentoQuota.findAll', o.where);
      return filtro(APLICACOES, o.where).filter((a) => a.pagamento.estado === 'confirmado');
    },
  },
  PagamentoExtraParcela: { findAll: async () => [] },
  Recibo: { findAll: async () => [] },
  ReciboQuota: { findAll: async () => [] },
  ReciboExtraParcela: { findAll: async () => [] },
  ExtraQuota: { findAll: async () => [] },
  ExtraQuotaParcela: { findAll: async () => [] },
  MetodoPagamento: {},
  Numeracao: {},
};

const modelsPath = require.resolve(path.join(RAIZ, 'models'));
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [], exports: modelos };

const { resumoFinanceiro } = require(path.join(RAIZ, 'helpers', 'saldos'));

// ── Verificações ───────────────────────────────────────────────────
(async () => {
  const r = await resumoFinanceiro(ANO, 1);

  // 1. Isolamento: todas as consultas do condomínio levam o condomínio ativo.
  // `PagamentoQuota` é a exceção legítima: não tem `condominio_id` no modelo e
  // é sempre consultado pelos IDs das quotas já filtradas pelo condomínio.
  // `MovimentoBancario` segue a mesma regra: é lido por conta, e as contas já
  // foram carregadas dentro do condomínio ativo.
  const porQuotaIds = ['PagamentoQuota.findAll'];
  const porContaId = ['MovimentoBancario.sum', 'MovimentoBancario.findAll'];
  for (const c of consultas) {
    if (porQuotaIds.includes(c.nome)) {
      assert.ok(c.onde && c.onde.quota_id && c.onde.quota_id[Op.in],
        'PagamentoQuota: consulta sempre limitada a IDs de quotas concretos');
      continue;
    }
    if (porContaId.includes(c.nome)) {
      assert.ok(c.onde && [1, 2].includes(c.onde.conta_bancaria_id),
        'MovimentoBancario: consulta sempre limitada a uma conta do condomínio ativo');
      continue;
    }
    assert.ok(c.onde && c.onde.condominio_id === 1,
      `${c.nome}: consulta filtrada pelo condomínio ativo (recebido ${JSON.stringify(c.onde)})`);
  }
  const idsConsultados = consultas.find((c) => c.nome === 'PagamentoQuota.findAll').onde.quota_id[Op.in];
  assert.deepStrictEqual(idsConsultados.slice().sort((a, b) => a - b), [101, 102, 103],
    'PagamentoQuota: só as quotas NÃO anuladas do ano entram no cálculo do cobrado');
  assert.ok(consultas.some((c) => c.nome === 'Fracao.count'), 'a contagem de frações foi consultada');
  assert.ok(consultas.some((c) => c.nome === 'ContaBancaria.findAll'), 'as contas bancárias foram consultadas');
  assert.ok(consultas.some((c) => c.nome === 'PagamentoQuota.findAll'), 'o valor aplicado às quotas foi consultado');

  // 2. Contas: saldo por conta pelos movimentos, fundo de reserva separado.
  assert.deepStrictEqual(r.contas.map((c) => c.nome), ['Conta principal', 'Fundo de reserva'], 'uma linha por conta ativa');
  assert.strictEqual(r.contas[0].saldo, 1180, 'conta corrente: 1000 + 300 − 120');
  assert.strictEqual(r.contas[1].saldo, 560, 'fundo de reserva: 500 + 60');
  assert.strictEqual(r.fundoReserva, 560, 'fundo de reserva = soma das contas desse tipo');

  // 3. Posição de caixa atual (saldo inicial + pagamentos confirmados − despesas).
  assert.strictEqual(r.saldoContas, 1225, 'saldo das contas: 1500 + 125 (só confirmados) − 400 (sem anulada)');

  // 4. Receitas e despesas do ano.
  assert.strictEqual(r.receitasAno, 125, 'receitas: 125, os 200 anulados não contam');
  assert.strictEqual(r.despesasAno, 400, 'despesas: do ano, sem a anulada');
  assert.strictEqual(r.saldoAno, -275, 'saldo do ano = receitas − despesas');

  // 5. Quotas do ano: emitido, cobrado, em dívida, cobrança.
  assert.strictEqual(r.totalQuotas, 250, 'quotas emitidas: sem a anulada');
  assert.strictEqual(r.pagoQuotas, 125, 'cobrado: 75 + 50 (o pagamento anulado não conta)');
  assert.strictEqual(r.emDivida, 125, 'em dívida = emitido − cobrado');
  assert.strictEqual(r.cobrancaPct, 50, 'percentagem de cobrança = 125/250');

  // 6. Frações: total e as que estão em atraso (contagem).
  assert.strictEqual(r.nFracoes, 12, 'total de frações do condomínio');
  assert.ok(r.nFracoesEmAtraso >= 1, 'há frações com quota vencida por pagar');
  assert.ok(r.nFracoesEmAtraso <= 12, 'a contagem nunca excede o número de frações');

  // 7. Orçamento e execução.
  assert.strictEqual(r.orcamentado, 10800, 'orçamentado = soma das rubricas ativas');
  assert.strictEqual(r.executadoC, 40000, 'executado em cêntimos: despesas por competência, sem a anulada');

  // 8. Evolução mensal: só meses com pagamentos/despesas reais.
  assert.strictEqual(r.contasPorMes[6], 7500, 'julho: pagamento confirmado do mês');
  assert.strictEqual(r.contasPorMes[8], 5000, 'setembro: pagamento confirmado do mês');
  assert.strictEqual(r.contasPorMes[8] >= 5000, true, 'o pagamento anulado não entra na evolução');
  assert.strictEqual(r.despesasPorMes[2], 30000, 'março: despesa do mês');
  assert.strictEqual(r.despesasPorMes[6], 10000, 'julho: despesa do mês');
  assert.strictEqual(r.despesasPorMes[8], 0, 'setembro: a despesa anulada não conta');

  console.log('✓ Testes das consultas da situação financeira passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
