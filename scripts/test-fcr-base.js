// ═══════════════════════════════════════════════════════════════════
// Base do Fundo Comum de Reserva (Fase 2H.3a).
//
// Cobre o que esta fase altera:
//  · a percentagem do FCR aceita 10% (mínimo legal) e qualquer valor acima;
//    abaixo de 10% é recusada, com mensagem clara;
//  · o método «orçamento» calcula o FCR com a percentagem configurada;
//  · invariante em todas as vias: `valor_base + valor_fcr = valor total`;
//  · a pré-visualização e o cálculo final usam a MESMA regra (a função de
//    divisão é a mesma, injetada na vista).
//
// Utilização: node scripts/test-fcr-base.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// `helpers/quotas-config.js` importa `helpers/config` (que fala com a BD):
// substitui-se por um duplo, para o teste correr sem base de dados.
const { toCents } = require('../helpers/money');
const configPath = require.resolve(path.join(RAIZ, 'helpers', 'config'));
const valores = {};
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, defeito = null) => (chave in valores ? valores[chave] : defeito),
    setConfig: async (chave, valor) => { valores[chave] = String(valor); },
  },
};

const { calcularQuota, calcularQuotasOrcamento, dividirComponentesQuota } = require('../helpers/quotas-calc');
const { validarFcrPercentagem, getQuotaConfig, setQuotaConfig, FCR_MINIMO_LEGAL } = require('../helpers/quotas-config');

const FRACOES = [
  { id: 1, permilagem: '500' },
  { id: 2, permilagem: '300' },
  { id: 3, permilagem: '200' },
];

// ── 1. O mínimo legal existe e é 10% ──────────────────────────────
function testeMinimoLegal() {
  assert.strictEqual(FCR_MINIMO_LEGAL, 10, 'o mínimo legal usado é 10%');
  // O default da configuração é o mínimo legal, não um valor inventado.
  const vazio = validarFcrPercentagem('');
  assert.strictEqual(vazio.ok, false, 'percentagem em branco é recusada');
  assert.ok(/10%/.test(vazio.mensagem), 'a mensagem do erro em branco refere o mínimo de 10%');
  console.log('  ✓ mínimo legal definido (10%)');
}

// ── 2. Valores aceites e recusados ────────────────────────────────
function testeValidacao() {
  const aceites = [
    ['10', 10], ['10,0', 10], ['10.00', 10], ['15', 15], ['20', 20], ['12,5', 12.5], ['100', 100],
  ];
  for (const [entrada, esperado] of aceites) {
    const r = validarFcrPercentagem(entrada);
    assert.strictEqual(r.ok, true, `FCR ${entrada}% é aceite`);
    assert.strictEqual(r.valor, esperado, `FCR ${entrada}% é interpretado como ${esperado}`);
  }
  const recusados = ['', '   ', 'abc', '-1', '0', '5', '9', '9,99', '0,5'];
  for (const entrada of recusados) {
    const r = validarFcrPercentagem(entrada);
    assert.strictEqual(r.ok, false, `FCR «${entrada}» é recusado`);
    assert.ok(r.mensagem && r.mensagem.length > 20, `FCR «${entrada}»: mensagem explicativa`);
  }
  // O caso-limite dos 9,99% tem de ser recusado com a razão certa.
  const limite = validarFcrPercentagem('9,99');
  assert.strictEqual(limite.motivo, 'abaixo_do_minimo', '9,99% é recusado por estar abaixo do mínimo');
  assert.ok(/inferior a 10%/.test(limite.mensagem), 'a mensagem explica que é inferior ao mínimo legal');
  const acima = validarFcrPercentagem('101');
  assert.strictEqual(acima.motivo, 'acima_do_maximo', 'acima de 100% é recusado');
  const naoNumerico = validarFcrPercentagem('dez');
  assert.strictEqual(naoNumerico.motivo, 'nao_numerico', 'texto não numérico é recusado como tal');
  console.log('  ✓ 10%, 15%, 20% e 12,5% aceites; 9,99% e abaixo recusados');
}

// ── 3. Invariante base + FCR = total (método permilagem) ──────────
function testeInvarianteMetodoPermilagem() {
  for (const pct of ['10', '15', '20', '33,3', '100']) {
    for (const perm of ['125', '95', '500', '1000', '7,5']) {
      const q = calcularQuota(perm, '123,45', pct);
      assert.strictEqual(q.baseC + q.fcrC, q.totalC,
        `permilagem: base + FCR = total (${perm}‰ a ${pct}%)`);
      assert.ok(q.fcrC >= 0 && q.baseC >= 0, `permilagem ${perm}‰ a ${pct}%: componentes não negativas`);
    }
  }
  // Valores de referência (especificação): 500‰, 100 €/1000‰, FCR 10%.
  const q = calcularQuota('500', '100', '10');
  assert.deepStrictEqual([q.base, q.fcr, q.total], [50, 5, 55], 'caso de referência: 50 + 5 = 55 €');
  console.log('  ✓ método permilagem: base + FCR = total em todas as combinações');
}

// ── 4. Invariante e receita no método orçamento ───────────────────
function testeMetodoOrcamento() {
  for (const pct of [10, 15, 20]) {
    const mapa = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00', meses: 12, fcrPercentagem: pct });
    let somaMensalC = 0;
    let somaFcrAnualC = 0;
    for (const [, v] of mapa) {
      assert.strictEqual(v.baseC + v.fcrC, v.totalC, `orçamento a ${pct}%: base + FCR = total`);
      assert.ok(v.fcrC > 0, `orçamento a ${pct}%: o FCR é registado (não fica a zero)`);
      assert.strictEqual(v.fcrPercentagem, pct, `orçamento a ${pct}%: a percentagem fica na quota`);
      somaMensalC += v.totalC;
      somaFcrAnualC += v.fcrC * 12;
    }
    // O total anual é exatamente a receita definida pelo orçamento (o FCR é
    // componente, não acréscimo).
    assert.strictEqual(somaMensalC * 12, toCents('12000.00'),
      `orçamento a ${pct}%: 12 × soma mensal = total anual`);
    // FCR devido no ano = base anual × pct/100 (tolerância de arredondamento).
    const baseAnualC = toCents('12000.00') - somaFcrAnualC;
    const esperadoC = Math.round((baseAnualC * pct) / 100);
    assert.ok(Math.abs(somaFcrAnualC - esperadoC) <= 12,
      `orçamento a ${pct}%: FCR anual coerente (${somaFcrAnualC} vs ${esperadoC})`);
  }
  // A percentagem NÃO pode ser perdida quando é passada como texto («12,5»).
  const comTexto = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00', fcrPercentagem: '12,5' });
  assert.strictEqual([...comTexto.values()][0].fcrPercentagem, 12.5, 'percentagem em texto («12,5») é respeitada');
  assert.ok([...comTexto.values()].every((v) => v.fcrC > 0), 'percentagem em texto: FCR registado');
  // Sem percentagem o FCR fica a zero, mas o TOTAL mantém-se (nunca altera o
  // valor a pagar pelo condómino).
  const semPct = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00' });
  assert.ok([...semPct.values()].every((v) => v.fcrC === 0), 'sem percentagem: FCR a zero');
  let somaSem = 0;
  for (const [, v] of semPct) somaSem += v.totalC;
  assert.strictEqual(somaSem * 12, toCents('12000.00'), 'sem percentagem: o total anual continua correto');
  console.log('  ✓ método orçamento: FCR calculado e total anual preservado (10%, 15%, 20%, 12,5% e sem percentagem)');
}

// ── 5. Divisão de componentes (função única da regra) ─────────────
function testeDivisaoComponentes() {
  assert.deepStrictEqual(dividirComponentesQuota(10000, 10), { baseC: 9091, fcrC: 909, totalC: 10000, fcrPercentagem: 10 },
    'total 100 € a 10%: 90,91 € + 9,09 €');
  assert.deepStrictEqual(dividirComponentesQuota(5500, 10), { baseC: 5000, fcrC: 500, totalC: 5500, fcrPercentagem: 10 },
    'total 55 € a 10%: 50 € + 5 € (coerente com o método permilagem)');
  assert.deepStrictEqual(dividirComponentesQuota(10000, 0), { baseC: 10000, fcrC: 0, totalC: 10000, fcrPercentagem: 0 },
    'sem percentagem: tudo em despesas correntes');
  // Arredondamento: a soma nunca fica a 1 cêntimo do valor a pagar.
  for (const total of [1, 7, 333, 3333, 99999, 123456]) {
    for (const pct of [10, 15, 20, 33.3]) {
      const r = dividirComponentesQuota(total, pct);
      assert.strictEqual(r.baseC + r.fcrC, total, `total ${total}c a ${pct}%: base + FCR = total exato`);
    }
  }
  // Entradas estranhas não rebentam nem inventam FCR.
  assert.strictEqual(dividirComponentesQuota(null, 10).fcrC, 0, 'total inválido → FCR zero');
  assert.strictEqual(dividirComponentesQuota(1000, 'x').fcrC, 0, 'percentagem inválida → FCR zero');
  console.log('  ✓ divisão de componentes exata (sem cêntimos perdidos)');
}

// ── 6. Configuração por condomínio: ler, guardar e recusar ────────
async function testeConfiguracao() {
  // Estado inicial: sem configuração gravada, o default é o mínimo legal.
  // (O âmbito é sempre explícito — o helper nunca lê sessão nem pedido.)
  const inicial = await getQuotaConfig(1);
  assert.strictEqual(inicial.fcrPercentagem, '10', 'sem configuração, o FCR é o mínimo legal (10%)');
  assert.strictEqual(inicial.valorPor1000, '100.0000', 'sem configuração, o valor por 1000‰ tem default');

  // A configuração guarda o valor aprovado pelo condomínio (acima do mínimo).
  await setQuotaConfig(1, { valorPor1000: '120.0000', fcrPercentagem: 15 });
  const depois = await getQuotaConfig(1);
  assert.strictEqual(depois.fcrPercentagem, '15', 'a percentagem guardada é a do condomínio (15%)');
  assert.strictEqual(depois.valorPor1000, '120.0000', 'o valor por 1000‰ é guardado');

  // E é essa que o cálculo usa.
  const mapa = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00', fcrPercentagem: depois.fcrPercentagem });
  assert.strictEqual([...mapa.values()][0].fcrPercentagem, 15, 'o cálculo usa a percentagem configurada');

  // Configuração inválida não deve sequer chegar a ser gravada (a rota valida
  // antes); aqui confirma-se que a validação recusa o valor.
  assert.strictEqual(validarFcrPercentagem('5').ok, false, '5% (abaixo do mínimo) é recusado');
  console.log('  ✓ percentagem configurável por condomínio (default 10%, guarda 15%)');
}

// ── 7. A mesma percentagem na pré-visualização e no cálculo final ─
function testePrevisualizacaoUsaAMesmaRegra() {
  const rota = ler('routes/financeiro.js');
  const vista = ler('views/admin/quotas/gerar.handlebars');

  // O cálculo final passa a percentagem configurada no método orçamento.
  const blocoOrcamento = rota.slice(rota.indexOf("if (metodo === 'orcamento')"), rota.indexOf('} else {', rota.indexOf("if (metodo === 'orcamento')")));
  assert.ok(/getQuotaConfig\(req\.condominioId\)/.test(blocoOrcamento),
    'cálculo final: lê a configuração do condomínio ATIVO (âmbito explícito)');
  assert.ok(/calcularQuotasOrcamento\(\{[\s\S]{0,300}fcrPercentagem/.test(blocoOrcamento),
    'cálculo final: passa fcrPercentagem a calcularQuotasOrcamento (regressão corrigida)');
  assert.ok(!/calcularQuotasOrcamento\(\{[\s\S]{0,200}metodo: 'permilagem',\s*meses: 12,\s*\}\)/.test(blocoOrcamento),
    'cálculo final: não há chamada sem percentagem');

  // A pré-visualização recebe a MESMA função de divisão e usa-a no método
  // orçamento (deixou de devolver `fcr: 0`).
  assert.ok(rota.includes('fcrSplitterJs'), 'a rota injeta a função de divisão na vista');
  assert.ok(/window\.__GESCONDU_DIVIDIR_FCR/.test(vista), 'a vista usa a função de divisão injetada');
  assert.ok(/dividir\(anual \/ 12, pctFcr\(\)\)/.test(vista),
    'pré-visualização do método orçamento: usa o total com o FCR separado');
  assert.ok(!/return \{ base: mensal, fcr: 0, total: mensal/.test(vista),
    'pré-visualização: já não apresenta FCR a zero no método orçamento');
  assert.ok(/pctFcr\(\)/.test(vista) && /CFG\.fcrPercentagem/.test(vista),
    'pré-visualização: a percentagem vem da configuração');
  // A percentagem do formulário respeita o mínimo legal.
  const listar = ler('views/admin/quotas/listar.handlebars');
  assert.ok(/name="fcr_percentagem"[^>]*min="10"/.test(listar), 'formulário: o FCR tem mínimo 10');
  assert.ok(/Mínimo legal/.test(listar), 'formulário: explica o mínimo legal');
  console.log('  ✓ pré-visualização e cálculo final usam a mesma percentagem e a mesma função');
}

// ── 8. A validação é aplicada na rota ─────────────────────────────
function testeRotaValida() {
  const rota = ler('routes/financeiro.js');
  assert.ok(/validarFcrPercentagem\(req\.body\.fcr_percentagem\)/.test(rota), 'a rota valida a percentagem recebida');
  assert.ok(/if \(!fcrValidado\.ok\)[\s\S]{0,120}req\.flash\('error_msg', fcrValidado\.mensagem\)/.test(rota),
    'a rota recusa e explica o motivo');
  assert.ok(!/isNaN\(fcrPercentagem\) \|\| fcrPercentagem < 0/.test(rota),
    'a validação antiga (que aceitava 0%) foi substituída');
  console.log('  ✓ a configuração valida o mínimo legal antes de gravar');
}

(async () => {
  testeMinimoLegal();
  testeValidacao();
  testeInvarianteMetodoPermilagem();
  testeMetodoOrcamento();
  testeDivisaoComponentes();
  await testeConfiguracao();
  testePrevisualizacaoUsaAMesmaRegra();
  testeRotaValida();
  console.log('✓ Testes da base do FCR passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
