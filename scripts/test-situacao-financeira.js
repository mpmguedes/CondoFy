// ═══════════════════════════════════════════════════════════════════
// Situação financeira do condómino — aritmética dos valores apresentados.
//
// O que a página mostra é calculado por `helpers/saldos.js`: aqui exercita-se a
// parte PURA desse código (agregação em cêntimos, fundo de reserva, dívida,
// contagem de frações em atraso e evolução mensal) com dados de exemplo, sem
// base de dados e sem rede.
//
// Regressão coberta: a agregação nova é código que corre DENTRO do ajudante —
// um duplo do ajudante no teste das rotas não a executa. A separação entre
// consultas e aritmética existe precisamente para esta bateria a poder correr.
//
// Utilização: node scripts/test-situacao-financeira.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const { agregarSituacao, evolucaoMensal, estadoEfetivo, resumoFinanceiro } = require('../helpers/saldos');

const ANO = 2026;

// ── 1. Soma em cêntimos (sem erros de vírgula flutuante) ────────────
function testeSomasEmCentimos() {
  const r = agregarSituacao({
    ano: ANO,
    contas: [],
    saldosContas: [],
    receitas: [{ valor: 0.1 }, { valor: 0.2 }],
    despesas: [{ valor: 0.3 }],
    quotasAno: [],
    despesasCompetencia: 0.1 + 0.2,
  });

  assert.strictEqual(r.receitasAno, 0.3, 'receitas somadas em cêntimos (0,10 + 0,20 = 0,30)');
  assert.strictEqual(r.despesasAno, 0.3, 'despesas somadas em cêntimos');
  assert.strictEqual(r.saldoAno, 0, 'saldo do ano exato (sem resíduo de vírgula flutuante)');
  assert.strictEqual(r.executadoC, 30, 'despesas por competência convertidas em cêntimos');
  console.log('  ✓ soma em cêntimos');
}

// ── 2. Saldo das contas, saldo por conta e fundo de reserva ─────────
function testeContasEFundo() {
  const contas = [
    { id: 1, nome: 'Conta principal', banco: 'Banco A', iban: 'PT50...', tipo: 'corrente', saldo_inicial: 1000 },
    { id: 2, nome: 'Fundo de reserva', banco: 'Banco A', tipo: 'fundo_reserva', saldo_inicial: 4800 },
    { id: 3, nome: 'Poupança', banco: 'Banco B', tipo: 'poupanca', saldo_inicial: 200 },
  ];
  const r = agregarSituacao({
    ano: ANO,
    contas,
    saldosContas: [1240.5, 4800, 200],
    receitas: [{ valor: 500 }],
    despesas: [{ valor: 259.5 }],
  });

  // Saldo das contas = saldo inicial (6000) + receitas (500) − despesas (259,50).
  assert.strictEqual(r.saldoContas, 6240.5, 'saldo das contas = inicial + receitas − despesas');
  assert.strictEqual(r.contas.length, 3, 'uma linha por conta ativa');
  assert.strictEqual(r.contas[0].saldo, 1240.5, 'saldo por conta vem dos movimentos (saldoConta)');
  assert.strictEqual(r.contas[0].nome, 'Conta principal', 'a conta é identificada pelo nome');
  assert.strictEqual(r.fundoReserva, 4800, 'fundo de reserva = soma das contas desse tipo');
  assert.strictEqual(r.contas[1].tipo, 'fundo_reserva', 'o tipo da conta é preservado para a vista');
  console.log('  ✓ contas e fundo de reserva');
}

// ── 3. Quotas do ano: dívida, percentagem de cobrança ──────────────
function testeQuotasEDivida() {
  const quotasAno = [
    { id: 1, fracao_id: 5, valor: 75, estado: 'paga' },
    { id: 2, fracao_id: 5, valor: 75, estado: 'pendente' },
    { id: 3, fracao_id: 6, valor: 42.5, estado: 'parcialmente_paga' },
  ];
  const pago = new Map([[1, 7500], [3, 2000]]);
  const r = agregarSituacao({ ano: ANO, quotasAno, pagoPorQuotaMapa: pago });

  assert.strictEqual(r.totalQuotas, 192.5, 'total de quotas emitidas no ano');
  assert.strictEqual(r.pagoQuotas, 95, 'cobrado = valor efetivamente aplicado às quotas');
  assert.strictEqual(r.emDivida, 97.5, 'em dívida = emitido − cobrado');
  assert.strictEqual(r.cobrancaPct, 49, 'percentagem de cobrança arredondada (95/192,50)');
  console.log('  ✓ quotas, dívida e cobrança');
}

// ── 4. Percentagem sem denominador: nunca dividir por zero ─────────
function testeSemOrcamentoNemQuotas() {
  const r = agregarSituacao({ ano: ANO });

  assert.strictEqual(r.totalQuotas, 0, 'sem quotas emitidas o total é zero');
  assert.strictEqual(r.cobrancaPct, 0, 'sem quotas não há percentagem de cobrança');
  assert.strictEqual(r.orcamentado, 0, 'sem orçamento não há valor orçamentado');
  assert.strictEqual(r.fundoReserva, 0, 'sem contas de fundo de reserva o valor é zero');
  assert.strictEqual(r.emDivida, 0, 'sem quotas não há dívida');
  assert.deepStrictEqual(r.contas, [], 'sem contas ativas a lista fica vazia');
  assert.strictEqual(r.contasPorMes.length, 12, 'a evolução tem sempre 12 meses');
  assert.strictEqual(r.despesasPorMes.length, 12, 'a evolução de despesas tem sempre 12 meses');

  const evolucao = evolucaoMensal(r);
  assert.strictEqual(evolucao.temMovimentos, false, 'sem movimentos a evolução fica vazia');
  assert.strictEqual(evolucao.mesesComMovimentos, 0, 'nenhum mês com registos');
  console.log('  ✓ sem orçamento nem quotas (sem divisões por zero)');
}

// ── 5. Frações em atraso: só a contagem, nunca a identificação ─────
function testeFracoesEmAtraso() {
  const ontem = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const futuro = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const quotasAno = [
    // Vencida e por pagar → conta.
    { id: 1, fracao_id: 5, valor: 75, estado: 'pendente', data_vencimento: ontem },
    // Vencida mas PAGA → não conta.
    { id: 2, fracao_id: 6, valor: 42.5, estado: 'paga', data_vencimento: ontem },
    // Vencida e paga em parte, com saldo em aberto → conta.
    { id: 3, fracao_id: 7, valor: 100, estado: 'parcialmente_paga', data_vencimento: ontem },
    // Por vencer → não conta.
    { id: 4, fracao_id: 8, valor: 75, estado: 'pendente', data_vencimento: futuro },
    // Anulada → não conta.
    { id: 5, fracao_id: 9, valor: 75, estado: 'anulada', data_vencimento: ontem },
  ];
  const pago = new Map([[2, 4250], [3, 5000]]);
  const r = agregarSituacao({ ano: ANO, quotasAno, pagoPorQuotaMapa: pago, nFracoes: 12 });

  assert.strictEqual(r.nFracoesEmAtraso, 2, 'contam-se as frações com quota vencida e saldo em aberto');
  assert.strictEqual(r.nFracoes, 12, 'o total de frações do condomínio é apresentado');
  assert.strictEqual(estadoEfetivo({ estado: 'paga', data_vencimento: ontem }), 'paga', 'uma quota paga nunca é «vencida»');
  assert.strictEqual(estadoEfetivo({ estado: 'pendente', data_vencimento: ontem }), 'vencida', 'quota pendente com vencimento passado é «vencida»');
  assert.strictEqual(estadoEfetivo({ estado: 'anulada', data_vencimento: ontem }), 'anulada', 'quota anulada mantém-se anulada');
  // A contagem é um número: a vista não recebe identificação de terceiros.
  assert.ok(!JSON.stringify(r).includes('"5"') && !('fracoesEmAtraso' in r),
    'o resultado não transporta a identificação das frações em atraso');
  console.log('  ✓ frações em atraso (apenas a contagem)');
}

// ── 6. Evolução mensal: soma por mês e saldo de cada mês ───────────
function testeEvolucaoMensal() {
  const r = agregarSituacao({
    ano: ANO,
    pagamentos: [
      { valor: 100, data_pagamento: `${ANO}-01-15` },
      { valor: 50, data_pagamento: `${ANO}-01-28` },
      { valor: 25.5, data_pagamento: `${ANO}-03-02` },
      { valor: 999, data_pagamento: '' },
    ],
    despesasComData: [
      { valor: 80, data: `${ANO}-01-20` },
      { valor: 30.5, data: `${ANO}-03-11` },
    ],
  });

  assert.strictEqual(r.contasPorMes[0], 15000, 'janeiro soma os pagamentos confirmados do mês');
  assert.strictEqual(r.contasPorMes[2], 2550, 'março soma o respetivo pagamento');
  assert.strictEqual(r.despesasPorMes[0], 8000, 'janeiro soma as despesas do mês');
  assert.strictEqual(r.contasPorMes.reduce((s, v) => s + v, 0), 17550,
    'o pagamento sem data não entra em nenhum mês (não é inventado)');

  const evolucao = evolucaoMensal(r);
  assert.strictEqual(evolucao.meses.length, 12, 'a evolução tem os 12 meses do ano');
  assert.strictEqual(evolucao.temMovimentos, true, 'há meses com movimento');
  assert.strictEqual(evolucao.mesesComMovimentos, 2, 'janeiro e março são os meses com registos');
  assert.strictEqual(evolucao.meses[0].contas, 150, 'janeiro: receitas em euros');
  assert.strictEqual(evolucao.meses[0].despesas, 80, 'janeiro: despesas em euros');
  assert.strictEqual(evolucao.meses[0].saldo, 70, 'janeiro: saldo do mês = receitas − despesas');
  assert.strictEqual(evolucao.meses[0].temMovimentos, true, 'janeiro marcado com movimento');
  assert.strictEqual(evolucao.meses[1].temMovimentos, false, 'fevereiro sem movimento');
  assert.strictEqual(evolucao.meses[2].saldo, -5, 'março: saldo negativo quando as despesas superam as receitas');
  assert.strictEqual(evolucao.totalContas, 175.5, 'total de receitas do ano');
  assert.strictEqual(evolucao.totalDespesas, 110.5, 'total de despesas do ano');
  console.log('  ✓ evolução mensal');
}

// ── 7. Sem condomínio ativo não se soma nada ───────────────────────
async function testeSemCondominio() {
  const r = await resumoFinanceiro(ANO, null);
  assert.strictEqual(r.saldoContas, 0, 'sem condomínio ativo não há saldo');
  assert.strictEqual(r.nFracoes, 0, 'sem condomínio ativo não há frações');
  assert.deepStrictEqual(r.contas, [], 'sem condomínio ativo não há contas');
  assert.deepStrictEqual(r.contasPorMes, Array(12).fill(0), 'sem condomínio ativo não há evolução');
  console.log('  ✓ sem condomínio ativo devolve zeros (nunca a soma de todos)');
}

(async () => {
  testeSomasEmCentimos();
  testeContasEFundo();
  testeQuotasEDivida();
  testeSemOrcamentoNemQuotas();
  testeFracoesEmAtraso();
  testeEvolucaoMensal();
  await testeSemCondominio();
  console.log('✓ Testes da situação financeira do condómino passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
