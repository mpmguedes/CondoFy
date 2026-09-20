// ═══════════════════════════════════════════════════════════════════
// C3 — distribuição mensal / consistência anual das quotas orçamentadas.
//
// Cobre o defeito corrigido: o modo orçamento dividia o valor ANUAL de cada
// fração por 12 com `Math.floor` POR FRAÇÃO e atirava a SOMA dos restos para o
// último mês da ÚLTIMA fração. Resultado: `Σ 12 × mensal > totalC` (a quota
// anual emitida ficava inflacionada) e frações de permilagem igual recebiam
// mensalidades diferentes.
//
// Aqui fixam-se os invariantes que a correção garante:
//   I-1  Σ de todos os meses de todas as frações === totalC  (fecho anual)
//   I-2  Σ meses(f) === anual(f)  e  Σ fcrMês(f) === fcrAno(f)
//   I-3  frações de permilagem igual → mesma sequência de meses
//   I-4  base + FCR === total, em CADA mês
//   I-5  meses consecutivos nunca diferem mais de 1 cêntimo
//   I-6  base + FCR === total, no ANO da fração
//
// O FCR é repartido a partir do ANO (fcrAno = round(anual × pct/(100+pct))),
// nunca arredondado mês a mês — isso somaria 12 erros de arredondamento e
// afastaria o FCR anual do valor exato (ex.: 499,92 € em vez de 500,00 €).
//
// Nota de âmbito: a igualdade entre frações com permilagem textualmente
// diferente (ex.: 333,33 vs 333,34) pode divergir 1 cêntimo no ANO — isso é
// matéria de D3 (grupos de permilagem da primitiva C1,
// `helpers/quotas-primitiva.js`) e NÃO é alterado nesta tarefa.
//
// Utilização: node scripts/test-quotas-mensal.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const { toCents, fromCents } = require('../helpers/money');
const { calcularQuotasOrcamento, acrescentarFcrAoTotal } = require('../helpers/quotas-calc');
const { distribuirPorPesos } = require('../helpers/distribuicao');

const euro = (c) => (c / 100).toFixed(2);

// ── Frações de teste ──────────────────────────────────────────────
const PARES = [{ id: 1, permilagem: '500' }, { id: 2, permilagem: '500' }];
const TERCOS = [
  { id: 1, permilagem: '500' },
  { id: 2, permilagem: '300' },
  { id: 3, permilagem: '200' },
];
const IGUAIS4 = [1, 2, 3, 4].map((i) => ({ id: i, permilagem: '250' }));
const SEED7 = [1, 2, 3, 4, 5, 6]
  .map((i) => ({ id: i, permilagem: '142.86' }))
  .concat([{ id: 7, permilagem: '142.84' }]);

// ── Leitura de um resultado da agregação ──────────────────────────
function somaAnoC(mapa) {
  let s = 0;
  for (const [, v] of mapa) s += v.totalC;
  return s;
}
function somaTodosOsMesesC(mapa) {
  let s = 0;
  for (const [, v] of mapa) for (const m of v.porMes) s += m.totalC;
  return s;
}

// Verifica TODOS os invariantes de fecho de um mapa, devolvendo as falhas.
function falhasDeFecho(mapa, totalAnoC, nMeses) {
  const falhas = [];

  // I-1 / I-1b — fecho anual do condomínio
  const somaAno = somaAnoC(mapa);
  if (somaAno !== totalAnoC) falhas.push(`I-1: Σ anual ${euro(somaAno)} ≠ total ${euro(totalAnoC)}`);
  const somaMeses = somaTodosOsMesesC(mapa);
  if (somaMeses !== totalAnoC) falhas.push(`I-1b: Σ meses ${euro(somaMeses)} ≠ total ${euro(totalAnoC)}`);

  for (const [id, v] of mapa) {
    // I-2 — fecho anual POR fração
    const somaMesFracao = v.porMes.reduce((s, m) => s + m.totalC, 0);
    if (somaMesFracao !== v.totalC) {
      falhas.push(`I-2: fração ${id} meses=${euro(somaMesFracao)} ≠ anual=${euro(v.totalC)}`);
    }
    // I-2 — o FCR do ano é a soma exata da repartição mensal
    const somaFcr = v.porMes.reduce((s, m) => s + m.fcrC, 0);
    if (somaFcr !== v.fcrC) {
      falhas.push(`I-2: fração ${id} ΣFCR mês=${euro(somaFcr)} ≠ FCR ano=${euro(v.fcrC)}`);
    }
    if (v.porMes.length !== nMeses) {
      falhas.push(`I-2: fração ${id} tem ${v.porMes.length} meses, esperados ${nMeses}`);
    }
    // I-4 — base + FCR = total em CADA mês, sem valores negativos
    for (let i = 0; i < v.porMes.length; i++) {
      const m = v.porMes[i];
      if (m.baseC + m.fcrC !== m.totalC) {
        falhas.push(`I-4: fração ${id} mês ${i + 1} base+fcr ${euro(m.baseC + m.fcrC)} ≠ total ${euro(m.totalC)}`);
      }
      if (m.baseC < 0 || m.fcrC < 0) {
        falhas.push(`I-4: fração ${id} mês ${i + 1} componente negativa (base=${m.baseC}, fcr=${m.fcrC})`);
      }
    }
    // I-5 — meses consecutivos nunca diferem mais de 1 cêntimo
    const vals = v.porMes.map((m) => m.totalC);
    if (Math.max(...vals) - Math.min(...vals) > 1) {
      falhas.push(`I-5: fração ${id} meses ${vals.map(euro).join('/')} divergem > 1 cêntimo`);
    }
    // I-6 — base + FCR = total no ANO
    if (v.baseC + v.fcrC !== v.totalC) {
      falhas.push(`I-6: fração ${id} anual base+fcr ${euro(v.baseC + v.fcrC)} ≠ total ${euro(v.totalC)}`);
    }
  }
  return falhas;
}

function exigirFecho(nome, mapa, totalAnoC, nMeses) {
  const falhas = falhasDeFecho(mapa, totalAnoC, nMeses);
  assert.strictEqual(falhas.length, 0, `${nome}: ${falhas.join(' | ')}`);
}

// ── 1. Fecho anual do orçamento, 12 meses ─────────────────────────
function testeFechoAnual() {
  const casos = [
    ['500/500 de 5.000 €', PARES, '5000.00', 10],
    ['500/300/200 de 5.000 €', TERCOS, '5000.00', 10],
    ['4×250 de 5.000 €', IGUAIS4, '5000.00', 10],
    ['7 frações de 12.000 €', SEED7, '12000.00', 10],
    ['500/300/200 de 100.000 € a 15%', TERCOS, '100000.00', 15],
    ['500/500 SEM FCR', PARES, '5000.00', 0],
  ];
  for (const [nome, fracoes, despesas, pct] of casos) {
    const totalAnoC = acrescentarFcrAoTotal(toCents(despesas), pct);
    const mapa = calcularQuotasOrcamento({
      fracoes, totalAnual: despesas, metodo: 'permilagem', meses: 12, fcrPercentagem: pct,
    });
    exigirFecho(nome, mapa, totalAnoC, 12);
    // E o total a distribuir é mesmo despesas + FCR (não as despesas).
    assert.strictEqual(somaAnoC(mapa), totalAnoC, `${nome}: Σ anual = despesas + FCR`);
  }
  console.log('  ✓ 1. o total dos 12 meses fecha exatamente com o orçamento anual');
}

// ── 2. O defeito concreto: o desvio deixou de existir ─────────────
function testeSemDesvioDeArredondamento() {
  // Caso que reproduzia o defeito: 2 frações de 500‰ sobre 5.500 €.
  //   errado: 12 × (229,16 + 229,32) = 5.501,76 € (+1,76 €)
  //   certo:  2750,00 + 2750,00      = 5.500,00 €
  const totalAnoC = acrescentarFcrAoTotal(toCents('5000.00'), 10);
  const mapa = calcularQuotasOrcamento({
    fracoes: PARES, totalAnual: '5000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });

  const valorEmitido = somaTodosOsMesesC(mapa);
  assert.strictEqual(valorEmitido, totalAnoC, 'o valor efetivamente emitido no ano é o total do orçamento');
  assert.notStrictEqual(valorEmitido, toCents('5501.76'), 'o valor inflacionado antigo já não é produzido');

  // Valores mensais pequenos: o defeito era de ordem de grandeza.
  // 3 frações sobre 5,00 € → antes 7,92 € emitidos para 5,50 € orçamentados.
  const pequeno = calcularQuotasOrcamento({
    fracoes: TERCOS, totalAnual: '5.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  const totalPequeno = acrescentarFcrAoTotal(toCents('5.00'), 10);
  assert.strictEqual(somaTodosOsMesesC(pequeno), totalPequeno,
    'com valores mensais mínimos o ano continua a fechar (antes inflava 2,42 €)');
  assert.notStrictEqual(somaTodosOsMesesC(pequeno), toCents('7.92'), 'o antigo 7,92 € deixou de ocorrer');
  console.log('  ✓ 2. não há desvio de arredondamento entre o emitido e o orçamentado');
}

// ── 3. Igualdade entre frações de permilagem igual ────────────────
function testeIgualdadeEntreFracoesIguais() {
  const totalAnoC = acrescentarFcrAoTotal(toCents('5000.00'), 10);
  const mapa = calcularQuotasOrcamento({
    fracoes: PARES, totalAnual: '5000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });

  const a = mapa.get(1);
  const b = mapa.get(2);
  assert.deepStrictEqual(
    [a.totalC, a.baseC, a.fcrC],
    [b.totalC, b.baseC, b.fcrC],
    'duas frações de permilagem igual recebem o MESMO valor anual (base e FCR incluídos)'
  );
  assert.deepStrictEqual(
    a.porMes.map((m) => m.totalC),
    b.porMes.map((m) => m.totalC),
    'duas frações de permilagem igual recebem a MESMA sequência de meses'
  );

  // 4 frações iguais: três com o mês menor, uma com o mês maior (1 cêntimo) —
  // mas todas com o mesmo ANUAL. É o que torna a igualdade visível ao condómino.
  const q = calcularQuotasOrcamento({
    fracoes: IGUAIS4, totalAnual: '5000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  const anuais = [...q.values()].map((v) => v.totalC);
  assert.ok(anuais.every((v) => v === anuais[0]), '4 frações iguais → 4 anuais iguais');
  assert.strictEqual(anuais[0], toCents('1375.00'), 'cada uma paga 1.375,00 € no ano');
  console.log('  ✓ 3. frações de permilagem igual recebem o mesmo valor anual');
}

// ── 4. Restos: o cêntimo que sobra é distribuído, não atirado ─────
function testeRestosDistribuidos() {
  // 7 frações, total que não divide por 12: o resto tem de ficar DENTRO do ano
  // e nunca criar uma mensalidade arbitrariamente maior.
  const totalAnoC = acrescentarFcrAoTotal(toCents('12000.00'), 10);
  const mapa = calcularQuotasOrcamento({
    fracoes: SEED7, totalAnual: '12000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  exigirFecho('7 frações / 12.000 €', mapa, totalAnoC, 12);

  // Nenhum mês de nenhuma fração pode saltar mais de 1 cêntimo do mínimo.
  for (const [id, v] of mapa) {
    assert.ok(v.porMes.length === 12, `fração ${id}: 12 meses`);
  }

  // Total que não divide exatamente por mês: 1.000 € → 83,33 € × 12 = 999,96 €.
  // O ano tem de fechar em 1.000 €, com um mês a absorver os 4 cêntimos.
  const total1000 = acrescentarFcrAoTotal(toCents('1000.00'), 0);
  const m1000 = calcularQuotasOrcamento({
    fracoes: [{ id: 1, permilagem: '1000' }], totalAnual: '1000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 0,
  });
  const unica = m1000.get(1);
  assert.strictEqual(unica.totalC, total1000, 'fração única com 1000‰ recebe 1.000 € no ano');
  assert.strictEqual(unica.porMes.reduce((s, m) => s + m.totalC, 0), toCents('1000.00'), 'soma dos meses = 1.000 €');
  const vals = unica.porMes.map((m) => m.totalC);
  assert.strictEqual(Math.max(...vals) - Math.min(...vals), 1,
    'os 4 cêntimos de resto ficam repartidos por 4 meses, não concentrados num só');
  assert.strictEqual(vals.filter((v) => v === Math.max(...vals)).length, 4, '4 meses com o valor maior');
  console.log('  ✓ 4. os restos de arredondamento são repartidos, não acumulados no último mês');
}

// ── 5. O FCR interage corretamente com a divisão mensal ───────────
function testeFcrNaDivisaoMensal() {
  const totalAnoC = acrescentarFcrAoTotal(toCents('5000.00'), 10);
  const mapa = calcularQuotasOrcamento({
    fracoes: TERCOS, totalAnual: '5000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });

  // O FCR no ANO fecha no valor exato de D1 e o seu somatório é o FCR do
  // orçamento (10% de 5.000 € = 500 €) — não uma soma de 12 arredondamentos.
  let somaFcrAnoC = 0;
  let somaBaseAnoC = 0;
  for (const [id, v] of mapa) {
    somaFcrAnoC += v.fcrC;
    somaBaseAnoC += v.baseC;
    assert.strictEqual(v.fcrC, Math.round((v.totalC * 10) / 110),
      `fração ${id}: FCR anual = total × 10/110 (componente, não soma)`);
    // O FCR do ano é a soma exata da repartição mensal (sem deriva de arredondamento).
    assert.strictEqual(v.porMes.reduce((s, m) => s + m.fcrC, 0), v.fcrC,
      `fração ${id}: Σ FCR mensal = FCR anual (sem acumular erro de arredondamento)`);
  }
  assert.strictEqual(somaBaseAnoC + somaFcrAnoC, totalAnoC, 'base + FCR = total no agregado');
  assert.strictEqual(somaBaseAnoC, toCents('5000.00'), 'a componente de despesas correntes é o orçamento (5.000 €)');
  assert.strictEqual(somaFcrAnoC, toCents('500.00'), 'a componente FCR é 500 € (10% de 5.000 €)');

  // Cada MÊS também decompõe: base + FCR = total DO MÊS (a base absorve o
  // arredondamento, para o FCR anual não derrapar).
  for (const [id, v] of mapa) {
    for (let i = 0; i < v.porMes.length; i++) {
      const m = v.porMes[i];
      assert.strictEqual(m.baseC + m.fcrC, m.totalC,
        `fração ${id} mês ${i + 1}: base + FCR = total do mês`);
      assert.ok(m.baseC >= 0 && m.fcrC >= 0, `fração ${id} mês ${i + 1}: componentes não negativas`);
    }
  }

  // Sem FCR, o total anual é exactamente as despesas e não há FCR nenhum.
  const semFcr = calcularQuotasOrcamento({
    fracoes: TERCOS, totalAnual: '5000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 0,
  });
  assert.strictEqual(somaAnoC(semFcr), toCents('5000.00'), 'sem FCR o ano fecha nas despesas');
  for (const [, v] of semFcr) {
    assert.strictEqual(v.fcrC, 0, 'sem FCR não há componente de fundo');
    assert.ok(v.porMes.every((m) => m.fcrC === 0), 'nem ao nível do mês');
  }
  console.log('  ✓ 5. o FCR é componente (não acréscimo) em cada mês e no ano');
}

// ── 6. Escopos de poucos meses e método igual ─────────────────────
function testeOutrosEscoposEMetodos() {
  // 3 meses
  const totalAnoC3m = acrescentarFcrAoTotal(toCents('5000.00'), 10);
  const m3 = calcularQuotasOrcamento({
    fracoes: PARES, totalAnual: '5000.00', metodo: 'permilagem', meses: 3, fcrPercentagem: 10,
  });
  exigirFecho('3 meses', m3, totalAnoC3m, 3);

  // 1 mês — o valor do mês é o próprio valor anual.
  const m1 = calcularQuotasOrcamento({
    fracoes: PARES, totalAnual: '5000.00', metodo: 'permilagem', meses: 1, fcrPercentagem: 10,
  });
  exigirFecho('1 mês', m1, totalAnoC3m, 1);
  assert.strictEqual(m1.get(1).porMes.length, 1, 'com 1 mês há exatamente 1 entrada');

  // método 'igual' — reparte por cabeça, sem permilagem.
  const igual = calcularQuotasOrcamento({
    fracoes: TERCOS, totalAnual: '5000.00', metodo: 'igual', meses: 12, fcrPercentagem: 10,
  });
  exigirFecho('método igual', igual, totalAnoC3m, 12);
  const anuais = [...igual.values()].map((v) => v.totalC);
  assert.ok(Math.max(...anuais) - Math.min(...anuais) <= 2,
    'no método igual as frações recebem valores equivalentes (diferença de 1-2 cêntimos do resto)');
  console.log('  ✓ 6. escopos de 3 e 1 meses e o método igual mantêm os invariantes');
}

// ── 7. A distribuição anual continua a ser a referência (D3) ──────
function testeDistribuicaoAnualIntacta() {
  // A soma anual por fração tem de coincidir com a distribuição por permilagem
  // do total — a divisão mensal só reparte o que a anual já atribuiu.
  const totalAnoC = acrescentarFcrAoTotal(toCents('5000.00'), 10);
  const mapa = calcularQuotasOrcamento({
    fracoes: TERCOS, totalAnual: '5000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  const esperado = distribuirPorPesos(totalAnoC, TERCOS.map((f) => ({ fracaoId: f.id, peso: Number(f.permilagem) })));
  for (const e of esperado) {
    assert.strictEqual(mapa.get(e.fracaoId).totalC, e.valorC,
      `fração ${e.fracaoId}: o ano da fração é o que a distribuição por permilagem lhe deu`);
  }

  // Caso conhecido: 500/300/200 de 5.500 € → 2.750 / 1.650 / 1.100 €.
  assert.strictEqual(mapa.get(1).totalC, toCents('2750.00'));
  assert.strictEqual(mapa.get(2).totalC, toCents('1650.00'));
  assert.strictEqual(mapa.get(3).totalC, toCents('1100.00'));
  console.log('  ✓ 7. o valor anual de cada fração é o da distribuição por permilagem');
}

// ── 8. A rota grava o mês correto, não o anual repetido ───────────
function testeRotaGravaMesCorreto() {
  const rota = ler('routes/financeiro.js');
  // A escrita no modo orçamento tem de usar `porMes[m-1]`, senão o valor ANUAL
  // seria repetido nos 12 meses (inflação de 12×).
  assert.ok(/v\.porMes\s*&&\s*v\.porMes\[m\s*-\s*1\]/.test(rota),
    'a rota usa o valor do mês concreto (`porMes[m-1]`) ao criar a quota');
  assert.ok(!/valor:\s*v\.total,\s*\n\s*valor_base:\s*v\.base,\s*\n\s*valor_fcr:\s*v\.fcr,/.test(rota),
    'a rota deixou de escrever o total ANUAL repetido em cada mês');
  console.log('  ✓ 8. a criação de quotas usa o valor do mês, não o anual repetido');
}

// ── 9. A pré-visualização fecha o ano com o orçamento ─────────────
function testePreviewFechaOAno() {
  const vista = ler('views/admin/quotas/gerar.handlebars');
  // O total anual mostrado não pode ser `mensal × 12` (soma de mensais
  // arredondados, que volta a introduzir o desvio que C3 corrigiu).
  assert.ok(/totalAno\s*\+=/.test(vista), 'a pré-visualização acumula o total ANUAL');
  assert.ok(/ehAno\(\)\s*\?\s*totalAno\s*:\s*totalMes/.test(vista),
    'no escopo anual mostra o total anual exato, não `totalMes * 12`');
  assert.ok(!/totalMes\s*\*\s*12/.test(vista),
    'deixou de multiplicar o mensal por 12 para mostrar o ano');
  console.log('  ✓ 9. a pré-visualização mostra o total anual exato');
}

// ── 10. Caso negativo: o teste morde ──────────────────────────────
function testeCasoNegativo() {
  // Demonstrar que o defeito, se voltasse, seria detetado: reproduz-se a
  // fórmula antiga e confirma-se que ela NÃO fecha o ano.
  const totalAnoC = toCents('5500.00');
  const nMeses = 12;
  const anuais = [toCents('2750.00'), toCents('2750.00')];
  const mensalAntigo = anuais.map((v) => Math.floor(v / nMeses));
  const restoAntigo = totalAnoC - mensalAntigo.reduce((s, v) => s + v, 0) * nMeses;
  if (restoAntigo > 0) mensalAntigo[mensalAntigo.length - 1] += restoAntigo;
  const emitidoAntigo = mensalAntigo.reduce((s, v) => s + v, 0) * nMeses;
  assert.notStrictEqual(emitidoAntigo, totalAnoC, 'a fórmula antiga NÃO fechava o ano (é este o defeito)');
  assert.strictEqual(emitidoAntigo, toCents('5501.76'), 'a fórmula antiga inflacionava para 5.501,76 €');

  // E a fórmula nova, no mesmo caso, fecha.
  const mapa = calcularQuotasOrcamento({
    fracoes: PARES, totalAnual: '5000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  assert.strictEqual(somaTodosOsMesesC(mapa), totalAnoC, 'a fórmula nova fecha exatamente');
  console.log('  ✓ 10. caso negativo: a fórmula antiga é detetada como não fechando o ano');
}

// ── 11. Isolamento: o motor não vê outros condomínios ────────────
function testeIsolamentoPorFracaoId() {
  // O motor é puro e trabalha só com as frações que recebe. Duas frações com o
  // MESMO id em condomínios diferentes não existem no mesmo mapa — mas garantir
  // que a chave do resultado é o `id` da fração recebida é o que permite ao
  // chamador cruzar com o condomínio ativo.
  const mapa = calcularQuotasOrcamento({
    fracoes: [{ id: 77, permilagem: '1000' }], totalAnual: '1000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  assert.deepStrictEqual([...mapa.keys()], [77], 'a chave do resultado é o id da fração recebida');
  assert.strictEqual(mapa.size, 1, 'não aparecem frações que não foram passadas');

  // Fração sem permilagem (peso 0) não recebe nada, e o total continua a fechar
  // com o que foi distribuído pelas restantes.
  const comZero = calcularQuotasOrcamento({
    fracoes: [{ id: 1, permilagem: '1000' }, { id: 2, permilagem: '0' }],
    totalAnual: '1000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  assert.strictEqual(comZero.get(1).totalC, toCents('1100.00'), 'peso 0 não tira valor a quem tem permilagem');
  console.log('  ✓ 11. o motor só distribui pelas frações recebidas, sem contaminar outras');
}

// ── Execução ──────────────────────────────────────────────────────
console.log('C3 — distribuição mensal e consistência anual das quotas orçamentadas\n');
testeFechoAnual();
testeSemDesvioDeArredondamento();
testeIgualdadeEntreFracoesIguais();
testeRestosDistribuidos();
testeFcrNaDivisaoMensal();
testeOutrosEscoposEMetodos();
testeDistribuicaoAnualIntacta();
testeRotaGravaMesCorreto();
testePreviewFechaOAno();
testeCasoNegativo();
testeIsolamentoPorFracaoId();
console.log('\n✓ Testes da distribuição mensal passaram (sem base de dados).');
