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
  // D1: `valorPor1000` é o TOTAL por 1000‰ (já com FCR). A fração de 500‰ a
  // 110 €/1000‰ paga 55 € no total, decomposto em 50 € de base + 5 € de FCR.
  // A 500‰ de 110 €/1000‰ a 10%, a fórmula LEGADA (base = total; fcr =
  // base × pct/100; total = base + fcr) daria 55 € de base, 5,50 € de FCR e
  // 60,50 € a pagar — inflacionava. Aqui prova-se que tal NÃO acontece.
  const q = calcularQuota('500', '110', '10');
  assert.strictEqual(q.base, 50, 'base = 50 € (parte das despesas correntes)');
  assert.strictEqual(q.fcr, 5, 'FCR = 5 € (componente do total)');
  assert.strictEqual(q.total, 55, 'total = 55 €');
  assert.ok(q.total < q.base * 1.1,
    'o total NÃO é inflacionado: 55 € < 55 € × 1,1 = 60,50 € (o que a fórmula legada daria)');
  // Caso em que as duas semânticas divergem de forma visível (total 55 € @ 10%).
  const d = calcularQuota('1000', '55', '10');
  assert.strictEqual(d.totalC, 5500, 'total 55 € = 5500 cêntimos (o total manda)');
  assert.strictEqual(d.fcrC, 500, 'FCR como componente = 500 cêntimos (5 €)');
  assert.strictEqual(d.baseC, 5000, 'base = 5000 cêntimos (50 €)');
  // Fórmula LEGADA: base = total (5500); fcr = round(base × pct/100) = 550;
  // total = base + fcr = 6050. D1 nunca produz 6050 a partir de um total 5500.
  const totalLegadoC = 5500 + Math.round((5500 * 10) / 100);
  assert.strictEqual(totalLegadoC, 6050, 'a fórmula antiga daria 6050 cêntimos (inflado)');
  assert.notStrictEqual(d.totalC, totalLegadoC,
    'o total NÃO é inflacionado: D1 dá 5500, nunca 6050');
  console.log('  ✓ método permilagem: base + FCR = total em todas as combinações');
}

// ── 4. Invariante e receita no método orçamento ───────────────────
function testeMetodoOrcamento() {
  // `totalAnual` são as DESPESAS PREVISTAS. O total distribuído é
  // despesas + FCR (o FCR entra ANTES da distribuição, regra C2).
  const DESPESAS = '12000.00';
  for (const pct of [10, 15, 20]) {
    const mapa = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: DESPESAS, meses: 12, fcrPercentagem: pct });
    let somaAnualC = 0;
    let somaFcrAnualC = 0;
    let somaTodosOsMesesC = 0;
    for (const [, v] of mapa) {
      assert.strictEqual(v.baseC + v.fcrC, v.totalC, `orçamento a ${pct}%: base + FCR = total (ano)`);
      assert.ok(v.fcrC > 0, `orçamento a ${pct}%: o FCR é registado (não fica a zero)`);
      assert.strictEqual(v.fcrPercentagem, pct, `orçamento a ${pct}%: a percentagem fica na quota`);
      // C3: `totalC`/`baseC`/`fcrC` são valores ANUAIS; `porMes` tem os 12 meses.
      somaAnualC += v.totalC;
      somaFcrAnualC += v.fcrC;
      for (const m of v.porMes) somaTodosOsMesesC += m.totalC;
      assert.strictEqual(v.porMes.reduce((s, m) => s + m.totalC, 0), v.totalC,
        `orçamento a ${pct}%: Σ meses = anual (fecho por fração)`);
    }
    // O total distribuído é despesas + FCR (arredondado ao cêntimo).
    const totalDistribuidoC = Math.round(toCents(DESPESAS) * (100 + pct) / 100);
    assert.strictEqual(somaAnualC, totalDistribuidoC,
      `orçamento a ${pct}%: Σ anual = despesas + FCR`);
    assert.strictEqual(somaTodosOsMesesC, totalDistribuidoC,
      `orçamento a ${pct}%: Σ de todos os meses = despesas + FCR (fecho anual exato)`);
    assert.ok(somaAnualC > toCents(DESPESAS),
      `orçamento a ${pct}%: o total distribuído excede as despesas (FCR acrescentado)`);
    // FCR devido no ano = total × pct/(100+pct) — D1, componente do total
    // (já não `base × pct/100`: a semântica antiga inflacionava).
    const fcrTeoricoC = Math.round((totalDistribuidoC * pct) / (100 + pct));
    assert.strictEqual(somaFcrAnualC, fcrTeoricoC,
      `orçamento a ${pct}%: FCR anual = total × pct/(100+pct) (componente, sem dupla aplicação)`);
  }
  // A percentagem NÃO pode ser perdida quando é passada como texto («12,5»).
  const comTexto = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: DESPESAS, fcrPercentagem: '12,5' });
  assert.strictEqual([...comTexto.values()][0].fcrPercentagem, 12.5, 'percentagem em texto («12,5») é respeitada');
  assert.ok([...comTexto.values()].every((v) => v.fcrC > 0), 'percentagem em texto: FCR registado');
  // Sem percentagem o FCR fica a zero e o total distribuído são as despesas
  // exatas (nada é acrescentado por um FCR inexistente).
  const semPct = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: DESPESAS });
  assert.ok([...semPct.values()].every((v) => v.fcrC === 0), 'sem percentagem: FCR a zero');
  let somaSem = 0;
  for (const [, v] of semPct) somaSem += v.totalC;
  assert.strictEqual(somaSem, toCents(DESPESAS), 'sem percentagem: o total ANUAL distribuído = despesas');
  console.log('  ✓ método orçamento: despesas + FCR distribuídas (10%, 15%, 20%, 12,5% e sem percentagem)');
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

  // P20 — a pré-visualização deixou de reimplementar a fórmula: os valores são
  // calculados no SERVIDOR, com os motores reais, e injetados já prontos.
  const iPrevisao = rota.indexOf('const previsao = { permilagem: {}, orcamento: {} };');
  const blocoPrevisao = iPrevisao === -1 ? '' : rota.slice(iPrevisao, rota.indexOf('res.render(', iPrevisao));
  assert.ok(blocoPrevisao, 'a rota constrói a pré-visualização (bloco `previsao`)');
  assert.ok(/calcularQuota\(/.test(blocoPrevisao),
    'pré-visualização (método permilagem): usa o motor real `calcularQuota`');
  assert.ok(/calcularQuotasOrcamento\(/.test(blocoPrevisao),
    'pré-visualização (método orçamento): usa o motor real `calcularQuotasOrcamento`');
  assert.ok(/fcrPercentagem: quotaConfig\.fcrPercentagem/.test(blocoPrevisao),
    'pré-visualização: usa a MESMA percentagem de FCR do cálculo final');
  assert.ok(rota.includes('previsaoJson'), 'a rota injeta a pré-visualização já calculada');

  assert.ok(/PREVISAO/.test(vista), 'a vista lê a pré-visualização injetada');
  assert.ok(/PREVISAO\.orcamento\[/.test(vista),
    'a vista usa o bloco do ORÇAMENTO quando o método é o orçamento');
  assert.ok(/bloco\.meses\[mes - 1\]/.test(vista),
    'a vista mostra o valor do MÊS calculado pelo servidor');
  // A vista NÃO pode voltar a ter fórmula de cálculo (P20).
  assert.ok(!/totalComFcr\(/.test(vista), 'a vista não tem o acréscimo do FCR reimplementado');
  assert.ok(!/__GESCONDU_DIVIDIR_FCR/.test(vista), 'a vista não tem a decomposição reimplementada');
  assert.ok(!/despesas \* \(100 \+ p\)/.test(vista), 'a vista não reimplementa `acrescentarFcrAoTotal`');
  assert.ok(!/valorPor1000C|totalPerm|anualC/.test(vista), 'a vista não reimplementa o cálculo da quota');
  assert.ok(!/pctFcr\(\)/.test(vista), 'a vista não recalcula a percentagem do FCR');
  assert.ok(!/return \{ base: mensal, fcr: 0, total: mensal/.test(vista),
    'pré-visualização: nunca apresenta FCR a zero no método orçamento');
  assert.ok(/CFG\.fcrPercentagem/.test(vista), 'a vista mostra a percentagem em vigor');
  // A percentagem do formulário respeita o mínimo legal.
  const listar = ler('views/admin/quotas/listar.handlebars');
  assert.ok(/name="fcr_percentagem"[^>]*min="10"/.test(listar), 'formulário: o FCR tem mínimo 10');
  assert.ok(/Mínimo legal/.test(listar), 'formulário: explica o mínimo legal');
  console.log('  ✓ pré-visualização e cálculo final usam a mesma percentagem (o servidor calcula, a vista apresenta)');
}

// ── 9. Regra de negócio C2 — despesas + FCR ⇒ total a distribuir ──
// Demonstra, com números, a regra fechada:
//   despesas 5.000 € + FCR 10% = 5.500 € a distribuir;
//   100‰ de 5.500 € = 550 € → 500 € base + 50 € FCR;
//   o FCR nunca é aplicado duas vezes; base + FCR = total sempre.
function testeRegraNegocioC2() {
  const { acrescentarFcrAoTotal } = require('../helpers/quotas-calc');

  // (1) 5.000 € de despesas + 10% de FCR → 5.500 € a distribuir.
  assert.strictEqual(acrescentarFcrAoTotal(toCents('5000.00'), 10), toCents('5500.00'),
    '5.000 € de despesas + 10% = 5.500 € a distribuir');
  assert.strictEqual(acrescentarFcrAoTotal(toCents('5000.00'), 0), toCents('5000.00'),
    'sem FCR, o total a distribuir são as despesas exatas');

  // (2) 100‰ de 5.500 € → 550 € de total. (3) 550 € → 500 € base + 50 € FCR.
  const q = calcularQuota('100', '5500.0000', '10');
  assert.strictEqual(q.totalC, toCents('550.00'), '100‰ de 5.500 € = 550 € (total)');
  assert.strictEqual(q.base, 500, 'base = 500 €');
  assert.strictEqual(q.fcr, 50, 'FCR = 50 € (10% de 500 €)');

  // (4) + (5) O FCR nunca é aplicado duas vezes: o total já o contém.
  //     base + FCR = total, e o total é exatamente o valor distribuído.
  assert.strictEqual(q.baseC + q.fcrC, q.totalC, 'base + FCR = total');
  assert.strictEqual(q.total, 550, 'o total NÃO volta a crescer (não é 500 + 50 + 5,50)');
  // Comparação explícita com o que um duplo acréscimo daria (550 → 605).
  const comDuploAcrescimo = 500 + Math.round(500 * 0.1) === 550
    ? Math.round(550 * 1.1)
    : null;
  assert.notStrictEqual(q.total, comDuploAcrescimo, 'não há um segundo acréscimo de 10% (550, nunca 605)');

  // (6) Valores sem FCR continuam corretos (pct 0 → tudo na base).
  const semFcr = calcularQuota('100', '5500.0000', 0);
  assert.strictEqual(semFcr.total, 550, 'sem FCR: total = 550 €');
  assert.strictEqual(semFcr.base, 550, 'sem FCR: base = 550 €');
  assert.strictEqual(semFcr.fcr, 0, 'sem FCR: FCR = 0 €');

  // (7) Igual permilagem continua a produzir valores iguais.
  const a = calcularQuota('250', '5500.0000', '10');
  const b = calcularQuota('250', '5500.0000', '10');
  assert.deepStrictEqual(
    { base: a.base, fcr: a.fcr, total: a.total },
    { base: b.base, fcr: b.fcr, total: b.total },
    'permilagem igual → mesma base, mesmo FCR, mesmo total'
  );

  // Método orçamento, ponta a ponta: 5.000 € de despesas a 10% distribuídos por
  // 1000‰ em DUAS frações de 500‰ → o ANO distribui exatamente 5.500 €
  // (2.750 € por fração) e nenhuma dupla aplicação do FCR.
  //
  // Nota: `v.totalC`/`v.baseC`/`v.fcrC` são valores ANUAIS (C3); os 12 meses
  // estão em `v.porMes`, e `Σ meses === anual` por fração. A igualdade entre
  // frações de permilagem igual é garantida ao ANO (a repartição mensal pode
  // dar 1 cêntimo a mais num mês a uma delas, sem alterar o ano).
  const { distribuirPorPesos } = require('../helpers/distribuicao');
  const totalAnoC = acrescentarFcrAoTotal(toCents('5000.00'), 10);
  assert.strictEqual(totalAnoC, toCents('5500.00'), 'total anual a distribuir = despesas + FCR');
  const partes = distribuirPorPesos(totalAnoC, [
    { fracaoId: 1, peso: 500 },
    { fracaoId: 2, peso: 500 },
  ]);
  assert.strictEqual(partes.reduce((s, p) => s + p.valorC, 0), toCents('5500.00'),
    'a soma das partes = despesas + FCR (o total é distribuído por inteiro)');
  assert.strictEqual(partes[0].valorC, toCents('2750.00'), '500‰ → 2.750 €/ano');
  assert.strictEqual(partes[1].valorC, toCents('2750.00'), '500‰ → 2.750 €/ano');
  // Prova de ausência de dupla aplicação: o total distribuído é despesas×1,1,
  // nunca despesas×1,1×1,1 (= 6.050 €).
  assert.notStrictEqual(totalAnoC, toCents('6050.00'),
    'o FCR não é aplicado duas vezes (5.500 €, nunca 6.050 €)');

  const mapa = calcularQuotasOrcamento({
    fracoes: [{ id: 1, permilagem: '500' }, { id: 2, permilagem: '500' }],
    totalAnual: '5000.00',
    metodo: 'permilagem',
    meses: 12,
    fcrPercentagem: 10,
  });
  let somaMesesC = 0;
  for (const [, v] of mapa) {
    assert.strictEqual(v.baseC + v.fcrC, v.totalC, 'orçamento: base + FCR = total (ano)');
    assert.strictEqual(v.fcrC, Math.round((v.totalC * 10) / 110), 'orçamento: FCR como componente do total');
    somaMesesC += v.porMes.reduce((s, m) => s + m.totalC, 0);
  }
  // C3: o fecho do ANO é exato — Σ de todos os meses de todas as frações é o
  // total a distribuir (ao cêntimo).
  assert.strictEqual(somaMesesC, totalAnoC,
    'orçamento: Σ de todos os meses = despesas + FCR (fecho anual exato, C3)');
  // Igual permilagem → igual QUOTA ANUAL.
  for (const [, v] of mapa) {
    assert.strictEqual(v.totalC, toCents('2750.00'), 'permilagem 500‰ → 2.750 €/ano');
    assert.strictEqual(v.porMes.reduce((s, m) => s + m.totalC, 0), toCents('2750.00'),
      'permilagem 500‰ → Σ meses = 2.750 € (fecho por fração)');
  }
  assert.strictEqual(partes[0].valorC, partes[1].valorC,
    'permilagem igual → mesma quota ANUAL (2.750 € cada a 500‰)');
  // D1 é determinística: a mesma fração dá sempre o mesmo trio base/FCR/total.
  const repetido = calcularQuota('500', '110', '10');
  assert.deepStrictEqual(
    [repetido.base, repetido.fcr, repetido.total],
    [calcularQuota('500', '110', '10').base, calcularQuota('500', '110', '10').fcr, calcularQuota('500', '110', '10').total],
    'mesma permilagem e mesma percentagem → mesmo resultado (determinístico)'
  );
  console.log('  ✓ regra C2: despesas + FCR = total a distribuir; D1 decompõe sem dupla aplicação');
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
  testeRegraNegocioC2();
  console.log('✓ Testes da base do FCR passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
