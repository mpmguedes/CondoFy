// Testes do modelo financeiro (sem base de dados).
// Utilização: node scripts/test-financeiro.js
const assert = require('assert');
const { distribuirValorAnual } = require('../helpers/distribuicao');
const { calcularPlano } = require('../helpers/plano');
const { toCents, fromCents } = require('../helpers/money');
const { calcularQuota } = require('../helpers/quotas-calc');
const { distribuicaoExtra, parcelar, periodosVencimento } = require('../helpers/extra-quotas');
const pdf = require('../helpers/pdf');

const FRAÇÕES = [
  { id: 1, permilagem: '125' },
  { id: 2, permilagem: '125' },
  { id: 3, permilagem: '100' },
  { id: 4, permilagem: '100' },
  { id: 5, permilagem: '110' },
  { id: 6, permilagem: '110' },
  { id: 7, permilagem: '110' },
  { id: 8, permilagem: '110' },
  { id: 9, permilagem: '110' },
];

const COND = {
  designacao: 'Condomínio do Edifício Residencial Vista Mar e Jardins de Lisboa',
  nif: '500000000',
  morada: 'Rua Doutor António José de Almeida, Número Muito Comprido 1234, Bloco B',
  codigo_postal: '1000-000',
  localidade: 'Lisboa',
  iban_principal: 'PT50 0000 0000 0000 0000 0000 0',
  identidade_visual: 'designacao',
};

function somaCentes(partes) {
  return partes.reduce((s, p) => s + toCents(p.valor), 0);
}

async function main() {
  // 1. Distribuição por permilagem — soma exata
  const permilagem = distribuirValorAnual('8500.00', FRAÇÕES, 'permilagem');
  assert.strictEqual(somaCentes(permilagem), toCents('8500.00'), 'permilagem: soma = total');

  // 2. Distribuição igual — soma exata
  const igual = distribuirValorAnual('1000.00', FRAÇÕES, 'igual');
  assert.strictEqual(somaCentes(igual), toCents('1000.00'), 'igual: soma = total');
  assert.strictEqual(igual.length, FRAÇÕES.length);

  // 3. Plano de quotas — periodicidades e soma anual
  const plano = calcularPlano({
    orcamento: { data_inicio: '2027-01-01', data_fim: '2027-12-31' },
    rubricas: [
      { id: 1, periodicidade: 'mensal' },
      { id: 2, periodicidade: 'anual' },
      { id: 3, periodicidade: 'trimestral' },
    ],
    distribuicoes: [
      { rubrica_id: 1, fracao_id: 1, valor_anual: '1200.00' },
      { rubrica_id: 2, fracao_id: 1, valor_anual: '600.00' },
      { rubrica_id: 3, fracao_id: 1, valor_anual: '400.00' },
    ],
    fracoes: [{ id: 1 }],
  });
  assert.strictEqual(plano.length, 12, 'plano agregado por mês');
  assert.strictEqual(plano.reduce((s, p) => s + toCents(p.valor), 0), toCents('2200.00'), 'plano: soma anual correta');

  // 4. PDFs com dados extremos — nunca falham e são PDFs válidos
  const aviso = await pdf.gerarAvisoQuotaPDF(COND, {
    numero: '2027/0001',
    periodo: 'Janeiro 2027',
    dataEmissao: new Date(),
    dataVencimento: new Date(),
    valor: '99999.99',
    destinatarioNome: 'Maria da Assunção e Silva Rodrigues de Albuquerque Pereira Coutinho',
    fracaoDesignacao: 'Fração A',
    fracaoMorada: 'Rua Doutor António José de Almeida, Número Muito Comprido 1234, Bloco B, 5.º Esquerdo, 1000-000 Lisboa',
    saldoAnterior: 1234.56,
    ultimoPagamento: true,
    ultimoPagamentoValor: 9999.99,
    ultimoPagamentoData: new Date(),
    emDivida: 9999.99,
    totalAPagar: 99999.99,
    iban: COND.iban_principal,
    outrosMeiosPagamento: 'MB Way 912345678 · Transferência bancária · Multibanco',
    referencia: 'Entidade 12345 Referência 678 901 234',
    instrucoesPagamento: 'Indicar no descritivo o número da fração. Obrigado.',
  });

  const recibo = await pdf.gerarReciboPDF(COND, {
    numero: '2027/0001',
    data: new Date(),
    dataPagamento: new Date(),
    valor: '99999.99',
    condominoNome: 'Maria da Assunção e Silva Rodrigues de Albuquerque Pereira Coutinho',
    fracaoDesignacao: 'Fração A',
    metodoPagamento: 'Transferência bancária',
    referencia: 'REF muito comprida 123456789',
    quotas: [
      { numero: '2027/0001', periodo: 'Janeiro 2027', valorAplicado: 9999.99 },
      { numero: '2027/0002', periodo: 'Fevereiro 2027', valorAplicado: 9999.99 },
    ],
    saldoAposPagamento: 0,
  });

  const ata = await pdf.gerarAtaPDF(COND, {
    data: new Date(),
    hora: '21:00',
    local: 'Hall de entrada do edifício, piso 0',
    presentes: 'Fração A (125‰), Fração B (125‰)',
    ordemTrabalhos: ['Ponto um muito comprido para testar wrapping', 'Ponto dois', 'Ponto três'],
    ataTexto: 'Deliberações aprovadas por unanimidade. '.repeat(200),
  });

  for (const [nome, buf] of [['aviso', aviso], ['recibo', recibo], ['ata', ata]]) {
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', `${nome}: PDF válido`);
  }

  // 5. Cálculo de quota: permilagem × valor/‰ + FCR
  const q = calcularQuota('500', '0.1000', '10');
  assert.strictEqual(q.base, 50, 'base = 500‰ × 0,10 € = 50 €');
  assert.strictEqual(q.fcr, 5, 'fcr = 10% de 50 € = 5 €');
  assert.strictEqual(q.total, 55, 'total = 55 €');
  assert.strictEqual(q.totalC, 5500, 'total em cêntimos');

  // 6. Parcelamento: soma exata e resto na última parcela
  const p1 = parcelar(10000, 3);
  assert.deepStrictEqual(p1, [3333, 3333, 3334], 'resto na última parcela');
  assert.strictEqual(p1.reduce((a, b) => a + b, 0), 10000, 'soma das parcelas = valor');
  const p2 = parcelar(1, 3);
  assert.strictEqual(p2.reduce((a, b) => a + b, 0), 1, '1 cêntimo dividido por 3 soma 1');

  // 7. Quota extra: distribuição permilagem e igual com soma exata
  const fracoesExtra = [
    { id: 1, permilagem: '500' },
    { id: 2, permilagem: '300' },
    { id: 3, permilagem: '200' },
  ];
  const extraPerm = distribuicaoExtra('1000.00', fracoesExtra, 'permilagem');
  assert.strictEqual(extraPerm.reduce((s, p) => s + p.valorC, 0), toCents('1000.00'), 'extra permilagem soma exata');
  const extraIgual = distribuicaoExtra('1000.00', fracoesExtra, 'igual');
  assert.strictEqual(extraIgual.reduce((s, p) => s + p.valorC, 0), toCents('1000.00'), 'extra igual soma exata');

  // 8. Períodos de vencimento com periodicidade
  const periodos = periodosVencimento(11, 2025, 4, 'bimestral');
  assert.strictEqual(periodos.length, 4);
  assert.strictEqual(periodos[0].ano, 2025);
  assert.strictEqual(periodos[0].mes, 11);
  assert.strictEqual(periodos[3].ano, 2026);
  assert.strictEqual(periodos[3].mes, 5);

  console.log('✓ Todos os testes financeiros passaram.');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
