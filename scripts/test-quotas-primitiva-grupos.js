// ═══════════════════════════════════════════════════════════════════
// T2 — Grupos por igualdade exata de permilagem (Fase A, C1 / D3).
//
// Testes DB-free e puros. Cobrem:
//  · I-05  igualdade exata dentro do grupo;
//  · I-06  SEM tolerância — 142,86 e 142,87 são grupos distintos;
//  · PD-A  casos com permilagem representável em DECIMAL(7,2);
//  · o exemplo obrigatório (3 frações do mesmo grupo, total não divisível);
//  · ORDER BY id como desempate estável, SEM quebrar a igualdade.
//
// Utilização: node scripts/test-quotas-primitiva-grupos.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const { toCents } = require('../helpers/money');
const P = require('../helpers/quotas-primitiva');

const { agruparPorPermilagem, distribuirPorGrupos, calcularDistribuicaoQuotas, ESCALA_PERMILAGEM } = P;

let nAssercoes = 0;
function ok(cond, msg) {
  nAssercoes++;
  assert.ok(cond, msg);
}
function eq(a, b, msg) {
  nAssercoes++;
  assert.strictEqual(a, b, msg);
}
function deepEq(a, b, msg) {
  nAssercoes++;
  assert.deepStrictEqual(a, b, msg);
}

// ── Agrupamento: igualdade exata, sem tolerância (I-06) ─────────────
function testeAgrupamento() {
  // O exemplo da especificação.
  const g = agruparPorPermilagem([
    { id: 1, permilagem: '200' },
    { id: 2, permilagem: '200' },
    { id: 3, permilagem: '200' },
    { id: 4, permilagem: '150' },
    { id: 5, permilagem: '150' },
    { id: 6, permilagem: '100' },
  ]);
  eq(g.length, 3, 'I-05 6 frações → 3 grupos');
  deepEq(g.map((x) => x.membros.length), [3, 2, 1], 'I-05 grupos: 200×3, 150×2, 100×1');
  deepEq(g.map((x) => x.permilagem), [200, 150, 100], 'I-05 ordem: permilagem descendente');

  // I-06 — SEM tolerância: 142,86 e 142,87 são grupos DIFERENTES.
  const semTolerancia = agruparPorPermilagem([
    { id: 1, permilagem: '142.86' },
    { id: 2, permilagem: '142.86' },
    { id: 3, permilagem: '142.87' },
  ]);
  eq(semTolerancia.length, 2, 'I-06 142,86 e 142,87 → 2 grupos (sem tolerância)');
  const grupo86 = semTolerancia.find((x) => x.permilagemEscalada === 14286);
  const grupo87 = semTolerancia.find((x) => x.permilagemEscalada === 14287);
  deepEq(grupo86.membros, [1, 2], 'I-06 grupo 142,86 tem as frações 1 e 2');
  deepEq(grupo87.membros, [3], 'I-06 grupo 142,87 tem só a fração 3');

  // Uma diferença de 1 centésimo de permilagem é um grupo diferente, não
  // um arredondamento a absorver.
  const um = agruparPorPermilagem([
    { id: 1, permilagem: '142.86' },
    { id: 2, permilagem: '142.87' },
  ]);
  eq(um.length, 2, 'I-06 diferença mínima (0,01‰) → grupos distintos');

  // Representações equivalentes do MESMO valor caem no mesmo grupo.
  const mesmas = agruparPorPermilagem([
    { id: 1, permilagem: '142.86' },
    { id: 2, permilagem: 142.86 },
    { id: 3, permilagem: '142,86' },
  ]);
  eq(mesmas.length, 1, 'I-05 as três representações de 142,86‰ são o mesmo grupo');
  eq(mesmas[0].membros.length, 3, 'I-05 o grupo tem as três frações');

  // A escala é a da coluna (DECIMAL(7,2) → 2 casas).
  eq(ESCALA_PERMILAGEM, 100, 'a escala da permilagem é 100 (2 casas decimais)');
  eq(P.permilagemEscalada('142.86'), 14286, '142,86‰ → 14 286 na escala');
  eq(P.permilagemDeEscala(14286), 142.86, '14 286 na escala → 142,86‰');
}

// ── ORDER BY id: desempate estável, sem quebrar a igualdade ─────────
function testeTieBreakId() {
  // Membros fora de ordem: o grupo tem de os ordenar por id.
  const g = agruparPorPermilagem([
    { id: 9, permilagem: '500' },
    { id: 3, permilagem: '500' },
    { id: 7, permilagem: '500' },
  ]);
  eq(g.length, 1, 'um só grupo');
  deepEq(g[0].membros, [3, 7, 9], 'D3 os membros do grupo ficam ordenados por id');

  // O resultado NÃO depende da ordem de entrada.
  const ordemA = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 1, permilagem: '500' },
      { id: 2, permilagem: '300' },
      { id: 3, permilagem: '200' },
    ],
    fcrPercentagem: 0,
    totalC: 100000,
  });
  const ordemB = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 3, permilagem: '200' },
      { id: 1, permilagem: '500' },
      { id: 2, permilagem: '300' },
    ],
    fcrPercentagem: 0,
    totalC: 100000,
  });

  for (const id of [1, 2, 3]) {
    eq(
      ordemA.porFracao.get(id).totalC,
      ordemB.porFracao.get(id).totalC,
      `determinismo: fração ${id} recebe o mesmo em ordens diferentes`
    );
  }
  eq(ordemA.diferencaArredondamento.totalC, ordemB.diferencaArredondamento.totalC, 'determinismo: R1 igual');

  // ⛔ E o essencial: o desempate NUNCA dá valores diferentes a membros do
  // mesmo grupo.
  const mesmoGrupo = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 5, permilagem: '333.34' },
      { id: 1, permilagem: '333.33' },
      { id: 9, permilagem: '333.33' },
    ],
    fcrPercentagem: 0,
    totalC: 100000,
  });
  eq(
    mesmoGrupo.porFracao.get(1).totalC,
    mesmoGrupo.porFracao.get(9).totalC,
    '⛔ o ORDER BY id NÃO quebra a igualdade dentro do grupo 333,33'
  );
}

// ── PD-A caso 1: 7 × 142,86‰ (Σ = 1000,02‰) ────────────────────────
function testePDA1() {
  const fracoes = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, permilagem: '142.86' }));

  // Soma da permilagem: 7 × 142,86 = 1000,02‰
  const soma = 7 * 142.86;
  ok(Math.abs(soma - 1000.02) < 1e-9, `PD-A-1 Σ permilagem = 1000,02‰ (obtido ${soma.toFixed(2)})`);

  const valorPor1000C = toCents('1000.00'); // 100 000 c
  const totalTeoricoC = P.totalTeoricoDoModoPreco(fracoes, valorPor1000C);
  // D4: round(100000 × 1000,02 / 1000) = round(100002) = 100002
  eq(totalTeoricoC, 100002, 'PD-A-1 D4: total teórico = 1 000,02 € (respeita a permilagem real)');

  const r = calcularDistribuicaoQuotas({
    fracoes,
    fcrPercentagem: 0,
    totalC: totalTeoricoC,
    valorPor1000C,
  });

  eq(r.grupos.length, 1, 'PD-A-1: um só grupo (as 7 têm a mesma permilagem)');

  const valores = [...r.porFracao.values()].map((v) => v.totalC);
  ok(valores.every((v) => v === valores[0]), 'I-05 PD-A-1: as 7 frações recebem exatamente o mesmo');
  // 100002 / 7 = 14286 (floor); 14286 × 7 = 100002 → divide certo
  eq(valores[0], 14286, 'PD-A-1: cada fração recebe 142,86 € (14 286 c)');
  eq(r.totais.totalC, 100002, 'PD-A-1: Σ = 1 000,02 €');
  eq(r.diferencaArredondamento.totalC, 0, 'PD-A-1: R1 = 0 (o grupo divide exatamente)');

  // E1: a diferença ESTRUTURAL face ao valor nominal por 1000‰.
  eq(r.diferencaArredondamento.estruturalC, 2, 'PD-A-1 E1 = +2 cêntimos (estrutural, não residual)');
  eq(r.totalTeoricoC - valorPor1000C, 2, 'PD-A-1 E1 = totalTeórico − valorPor1000');

  // Prova da separação D4: E1 não é R1.
  ok(r.diferencaArredondamento.estruturalC !== r.diferencaArredondamento.totalC,
    'PD-A-1: E1 e R1 são independentes (2 ≠ 0)');
}

// ── PD-A caso 3: 3 × 333,33‰ (Σ = 999,99‰) ─────────────────────────
function testePDA3() {
  const fracoes = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, permilagem: '333.33' }));

  const soma = 3 * 333.33;
  ok(Math.abs(soma - 999.99) < 1e-9, `PD-A-3 Σ permilagem = 999,99‰ (obtido ${soma.toFixed(2)})`);

  const valorPor1000C = toCents('1000.00');
  const totalTeoricoC = P.totalTeoricoDoModoPreco(fracoes, valorPor1000C);
  // round(100000 × 999,99 / 1000) = round(99999) = 99999
  eq(totalTeoricoC, 99999, 'PD-A-3 D4: total teórico = 999,99 € (respeita a permilagem real)');

  const r = calcularDistribuicaoQuotas({
    fracoes,
    fcrPercentagem: 0,
    totalC: totalTeoricoC,
    valorPor1000C,
  });

  eq(r.grupos.length, 1, 'PD-A-3: um só grupo');
  const valores = [...r.porFracao.values()].map((v) => v.totalC);
  ok(valores.every((v) => v === valores[0]), 'I-05 PD-A-3: as 3 frações recebem exatamente o mesmo');
  eq(valores[0], 33333, 'PD-A-3: cada fração recebe 333,33 € (33 333 c)');
  eq(r.totais.totalC, 99999, 'PD-A-3: Σ = 999,99 €');
  eq(r.diferencaArredondamento.totalC, 0, 'PD-A-3: R1 = 0');

  // E1 negativo: a permilagem está abaixo de 1000‰.
  eq(r.diferencaArredondamento.estruturalC, -1, 'PD-A-3 E1 = −1 cêntimo (permilagem < 1000‰)');

  // Contraste com o caso da especificação: com o total NOMINAL (100 000 c) em
  // vez do total teórico, o grupo não divide e o cêntimo sobra para R1.
  const nominal = calcularDistribuicaoQuotas({ fracoes, fcrPercentagem: 0, totalC: 100000 });
  eq(nominal.diferencaArredondamento.totalC, 1, 'PD-A-3 contraste: com o total nominal, R1 = 1');
  deepEq(
    [...nominal.porFracao.values()].map((v) => v.totalC),
    [33333, 33333, 33333],
    'PD-A-3 contraste: mesmo assim, as três iguais — o cêntimo NÃO vai para uma'
  );
}

// ── Exemplo obrigatório: grupo grande, valor indivisível ────────────
function testeGrupoIndivisivel() {
  // 3 frações do mesmo grupo; total que não divide por 3.
  const r = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 1, permilagem: '333.33' },
      { id: 2, permilagem: '333.33' },
      { id: 3, permilagem: '333.33' },
    ],
    fcrPercentagem: 0,
    totalC: toCents('1000.00'),
  });

  const v = [...r.porFracao.values()].map((x) => x.totalC);
  deepEq(v, [33333, 33333, 33333], 'grupo indivisível: quinhão exato para todos');
  eq(r.totais.totalC, 99999, 'grupo indivisível: Σ = 999,99 €');
  eq(r.diferencaArredondamento.totalC, 1, 'grupo indivisível: 1 cêntimo para R1');
  ok(!v.includes(33334), 'grupo indivisível: ninguém recebeu o cêntimo (era o defeito antigo)');
}

// ── Grupos mistos: cada grupo coerente, entre grupos pode divergir ──
function testeGruposMistos() {
  const r = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 1, permilagem: '142.86' },
      { id: 2, permilagem: '142.86' },
      { id: 3, permilagem: '142.87' },
      { id: 4, permilagem: '142.87' },
      { id: 5, permilagem: '142.87' },
    ],
    fcrPercentagem: 0,
    totalC: toCents('1000.00'),
  });

  eq(r.grupos.length, 2, 'grupos mistos: 2 grupos');

  const g86 = [...r.grupos].find((g) => g.permilagemEscalada === 14286);
  const g87 = [...r.grupos].find((g) => g.permilagemEscalada === 14287);

  const v86 = g86.membros.map((id) => r.porFracao.get(id).totalC);
  const v87 = g87.membros.map((id) => r.porFracao.get(id).totalC);

  ok(v86.every((x) => x === v86[0]), 'grupos mistos: todas as 142,86 recebem o mesmo');
  ok(v87.every((x) => x === v87[0]), 'grupos mistos: todas as 142,87 recebem o mesmo');

  // O quinhão do GRUPO é proporcional à permilagem do grupo (não ao produto
  // permilagem × membros). Com 14286 e 14287, os quinhões são
  // round(100000 × 14286/28573) = 49998 e round(100000 × 14287/28573) = 50001.
  // O valor POR MEMBRO depende então do nº de membros — é a leitura correta:
  // o peso é do grupo, e dentro do grupo há igualdade.
  const totalGrupo86 = v86.reduce((s, x) => s + x, 0);
  const totalGrupo87 = v87.reduce((s, x) => s + x, 0);

  const esperado86 = Math.round((100000 * 14286) / (14286 + 14287));
  const esperado87 = Math.round((100000 * 14287) / (14286 + 14287));
  ok(
    Math.abs(totalGrupo86 - esperado86) <= 1,
    `grupos mistos: quinhão 142,86 proporcional à permilagem (${totalGrupo86} ≈ ${esperado86})`
  );
  ok(
    Math.abs(totalGrupo87 - esperado87) <= 1,
    `grupos mistos: quinhão 142,87 proporcional à permilagem (${totalGrupo87} ≈ ${esperado87})`
  );
  ok(
    totalGrupo87 >= totalGrupo86,
    'grupos mistos: o grupo com mais permilagem não recebe menos'
  );
  ok(
    v86[0] > v87[0],
    'grupos mistos: menos membros ⇒ mais por membro, com o mesmo quinhão de grupo'
  );

  eq(
    r.totais.totalC + r.diferencaArredondamento.totalC,
    100000,
    'grupos mistos: conservação do total'
  );

  // Com o MESMO nº de membros em cada grupo, a diferença de permilagem
  // traduz-se diretamente no valor por membro — aí sim, mais permilagem = mais.
  const simetrico = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 1, permilagem: '142.86' },
      { id: 2, permilagem: '142.87' },
    ],
    fcrPercentagem: 0,
    totalC: toCents('1000.00'),
  });
  const v86b = simetrico.porFracao.get(1).totalC;
  const v87b = simetrico.porFracao.get(2).totalC;
  ok(v87b >= v86b, `permilagem maior ⇒ valor não inferior (${v87b} ≥ ${v86b})`);
  eq(simetrico.grupos.length, 2, 'permilagens diferentes são grupos diferentes');
}

// ── Grupos grandes: I-08 revisto em escala ──────────────────────────
function testeGruposGrandes() {
  for (const n of [3, 7, 20, 50, 137]) {
    const fracoes = Array.from({ length: n }, (_, i) => ({ id: i + 1, permilagem: '20.00' }));
    // Total escolhido para forçar resto intra-grupo: n×100 + (n−1) cêntimos.
    const totalC = n * 100 + (n - 1);

    const r = calcularDistribuicaoQuotas({ fracoes, fcrPercentagem: 0, totalC });
    const lim = P.limiteResidual(r.grupos);

    const valores = [...r.porFracao.values()].map((v) => v.totalC);
    ok(valores.every((v) => v === valores[0]), `grupo de ${n}: todas iguais`);

    eq(r.grupos.length, 1, `grupo de ${n}: um só grupo`);
    eq(lim.entreGruposC, 1, `grupo de ${n}: componente entre-grupos = 1`);
    eq(lim.intraGruposC, n - 1, `grupo de ${n}: componente intra-grupo = ${n - 1}`);
    eq(lim.limiteC, n, `grupo de ${n}: limite I-08 = ${n}`);

    ok(
      r.diferencaArredondamento.totalC >= 0 && r.diferencaArredondamento.totalC <= lim.limiteC,
      `I-08 grupo de ${n}: residual ${r.diferencaArredondamento.totalC} ≤ limite ${lim.limiteC}`
    );
    eq(
      r.totais.totalC + r.diferencaArredondamento.totalC,
      totalC,
      `I-07 grupo de ${n}: conservação`
    );
  }

  // O caso extremo que expõe a contradição antiga: 50 frações, 49 cêntimos.
  const extremo = calcularDistribuicaoQuotas({
    fracoes: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, permilagem: '20.00' })),
    fcrPercentagem: 0,
    totalC: 5049,
  });
  eq(extremo.diferencaArredondamento.totalC, 49, 'grupo de 50: residual = 49 cêntimos');
  eq(P.limiteResidual(extremo.grupos).limiteC, 50, 'grupo de 50: limite = 50 (o antigo diria 1)');
  ok(
    extremo.diferencaArredondamento.totalC <= P.limiteResidual(extremo.grupos).limiteC,
    'I-08 revisto: 49 ≤ 50 — o limite antigo (≤1) seria violado'
  );
  eq(
    [...extremo.porFracao.values()].every((v) => v.totalC === 100),
    true,
    'grupo de 50: as 50 recebem exatamente 100 cêntimos cada'
  );
}

// ── Permilagem zero / em falta não colapsa o cálculo ────────────────
function testePermilagemZero() {
  const r = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 1, permilagem: '0' },
      { id: 2, permilagem: null },
    ],
    fcrPercentagem: 0,
    totalC: 1000,
  });
  eq(r.grupos.length, 1, 'permilagem 0 e null caem no mesmo grupo (ambos 0‰)');
  eq(r.totais.totalC, 1000, 'sem critério de peso, o total é dividido igualmente');
  eq(r.porFracao.get(1).totalC, 500, 'fração 1 recebe 5 €');
  eq(r.porFracao.get(2).totalC, 500, 'fração 2 recebe 5 €');
  eq(r.diferencaArredondamento.totalC, 0, 'sem residual');

  // Só uma fração a zero e outra com peso → distribuição proporcional.
  const misto = calcularDistribuicaoQuotas({
    fracoes: [
      { id: 1, permilagem: '0' },
      { id: 2, permilagem: '1000' },
    ],
    fcrPercentagem: 0,
    totalC: 1000,
  });
  eq(misto.porFracao.get(1).totalC, 0, 'peso 0 recebe 0');
  eq(misto.porFracao.get(2).totalC, 1000, 'peso 1000 recebe tudo');
}

// ── Execução ───────────────────────────────────────────────────────
function correr() {
  const testes = [
    ['I-05/I-06 agrupamento exato sem tolerância', testeAgrupamento],
    ['ORDER BY id: desempate sem quebrar igualdade', testeTieBreakId],
    ['PD-A caso 1: 7 × 142,86‰ (Σ 1000,02‰)', testePDA1],
    ['PD-A caso 3: 3 × 333,33‰ (Σ 999,99‰)', testePDA3],
    ['exemplo obrigatório: grupo indivisível', testeGrupoIndivisivel],
    ['grupos mistos', testeGruposMistos],
    ['grupos grandes: I-08 revisto', testeGruposGrandes],
    ['permilagem zero / em falta', testePermilagemZero],
  ];

  console.log('T2 — Grupos por igualdade exata de permilagem (Fase A)\n');
  for (const [nome, fn] of testes) {
    try {
      fn();
      console.log(`  ✓ ${nome}`);
    } catch (err) {
      console.error(`  ✗ ${nome}`);
      console.error(`      ${err.message}`);
      throw err;
    }
  }
}

correr();
console.log(`\n✓ T2 passou (${nAssercoes} asserções).`);
