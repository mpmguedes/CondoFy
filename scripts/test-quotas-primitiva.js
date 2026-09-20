// ═══════════════════════════════════════════════════════════════════
// T1 — Primitiva matemática das quotas (Fase A, C1).
//
// Testes DB-free, puros: exercitam `helpers/quotas-primitiva.js` sem base de
// dados, sem sessão e sem pedido HTTP.
//
// Cobre os invariantes fundamentais (I-01 … I-04, I-07, I-09) e os casos
// obrigatórios da especificação. Os grupos de permilagem são o T2 e o residual
// é o T3.
//
// Utilização: node scripts/test-quotas-primitiva.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const { toCents, fromCents } = require('../helpers/money');
const P = require('../helpers/quotas-primitiva');

const { calcularDistribuicaoQuotas, dividirComponentesQuota, fcrTeoricoC } = P;

let nAssercoes = 0;
function ok(cond, msg) {
  nAssercoes++;
  assert.ok(cond, msg);
}
function eq(a, b, msg) {
  nAssercoes++;
  assert.strictEqual(a, b, msg);
}

// Frações de conveniência: n frações com a mesma permilagem.
function fracoesIguais(n, permilagem) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, permilagem: String(permilagem) }));
}

// ── I-01: aritmética exclusivamente em cêntimos inteiros ────────────
function testeInteiros() {
  const r = calcularDistribuicaoQuotas({
    fracoes: fracoesIguais(3, '333.33'),
    fcrPercentagem: 10,
    totalC: 100000,
  });

  for (const [id, v] of r.porFracao) {
    ok(Number.isInteger(v.baseC), `I-01 fração ${id}: baseC é inteiro (${v.baseC})`);
    ok(Number.isInteger(v.fcrC), `I-01 fração ${id}: fcrC é inteiro (${v.fcrC})`);
    ok(Number.isInteger(v.totalC), `I-01 fração ${id}: totalC é inteiro (${v.totalC})`);
  }
  ok(Number.isInteger(r.totalTeoricoC), 'I-01 totalTeoricoC é inteiro');
  ok(Number.isInteger(r.totais.baseC), 'I-01 totais.baseC é inteiro');
  ok(Number.isInteger(r.totais.fcrC), 'I-01 totais.fcrC é inteiro');
  ok(Number.isInteger(r.totais.totalC), 'I-01 totais.totalC é inteiro');
  ok(Number.isInteger(r.diferencaArredondamento.totalC), 'I-01 R1 é inteiro');
  ok(Number.isInteger(r.diferencaArredondamento.fcrC), 'I-01 R2 é inteiro');
  ok(
    r.diferencaArredondamento.estruturalC === null ||
      Number.isInteger(r.diferencaArredondamento.estruturalC),
    'I-01 E1 é inteiro ou null'
  );

  // Nenhum valor do retorno é fracionário em cêntimos.
  const todosInteiros = [...r.porFracao.values()].every(
    (v) => Number.isInteger(v.baseC) && Number.isInteger(v.fcrC) && Number.isInteger(v.totalC)
  );
  ok(todosInteiros, 'I-01 nenhuma componente fracionária');
}

// ── I-02 / I-03 / I-04: componentes base/FCR (D1) ───────────────────
function testeComponentes() {
  // I-02: base + FCR = total, para um varrimento amplo.
  const totais = [0, 1, 2, 99, 100, 101, 333, 5500, 12345, 33333, 100000, 100001];
  const percentagens = [0, 10, 12.5, 15, 20, 50, 100, '10', '12,5'];

  for (const t of totais) {
    for (const p of percentagens) {
      const c = dividirComponentesQuota(t, p);
      eq(c.baseC + c.fcrC, c.totalC, `I-02 total=${t} pct=${p}: base + FCR = total`);
      ok(c.baseC >= 0, `I-03 total=${t} pct=${p}: baseC ≥ 0`);
      ok(c.fcrC >= 0, `I-03 total=${t} pct=${p}: fcrC ≥ 0`);
      eq(c.totalC, t, `total preservado (total=${t} pct=${p})`);

      const pctNum = P.normalizarPercentagem(p);
      const esperado = pctNum > 0 ? Math.round((t * pctNum) / (100 + pctNum)) : 0;
      eq(c.fcrC, esperado, `I-04 total=${t} pct=${p}: fcr = round(total × pct / (100 + pct))`);
    }
  }
}

// ── PD-B: o caso que DISTINGUE a fórmula nova da antiga ─────────────
// `[50,5,55]` é coincidente (as duas semânticas dão o mesmo) e por isso não
// deteta uma regressão. Este caso, sim: total 101 cêntimos a 10 %.
function testePDB() {
  const c = dividirComponentesQuota(101, 10);

  // Fórmula NOVA (D1): o FCR é componente do total.
  const fcrNovo = Math.round((101 * 10) / 110); // = 9
  const baseNovo = 101 - fcrNovo; // = 92
  eq(fcrNovo, 9, 'PD-B: fcr novo = round(101 × 10 / 110) = 9');
  eq(baseNovo, 92, 'PD-B: base novo = 101 − 9 = 92');
  eq(c.fcrC, 9, 'PD-B: o FCR devolvido é 9 (fórmula nova)');
  eq(c.baseC, 92, 'PD-B: a base devolvida é 92');
  eq(c.totalC, 101, 'PD-B: o total devolvido é 101');

  // Fórmula ANTIGA (a que a Fase A elimina): FCR somado à base.
  const baseAntigo = 101;
  const fcrAntigo = Math.round(baseAntigo * 0.1); // = 10
  const totalAntigo = baseAntigo + fcrAntigo; // = 111

  // Prova de que o teste MORDE: os dois resultados são diferentes.
  ok(fcrAntigo !== c.fcrC, `PD-B morde: fcr antigo ${fcrAntigo} ≠ novo ${c.fcrC}`);
  ok(totalAntigo !== c.totalC, `PD-B morde: total antigo ${totalAntigo} ≠ novo ${c.totalC}`);
  eq(totalAntigo, 111, 'PD-B: a fórmula antiga daria 111 — é esta regressão que o teste deteta');

  // Documenta o caso coincidente, para ninguém o usar como prova de D1.
  const coincidente = dividirComponentesQuota(5500, 10);
  const fcrCoincidenteAntigo = Math.round(5000 * 0.1);
  eq(coincidente.fcrC, fcrCoincidenteAntigo, '[50,5,55] é coincidente: as duas fórmulas dão 5 € — não prova D1');
}

// ── I-07: conservação do total ──────────────────────────────────────
function testeConservacao() {
  const casos = [
    { fracoes: fracoesIguais(3, '333.33'), totalC: 100000, pct: 0 },
    { fracoes: fracoesIguais(3, '333.33'), totalC: 100000, pct: 10 },
    { fracoes: fracoesIguais(7, '142.86'), totalC: 100002, pct: 0 },
    { fracoes: fracoesIguais(8, '125'), totalC: 100001, pct: 10 },
    { fracoes: fracoesIguais(2, '500'), totalC: 1, pct: 0 },
    { fracoes: [], totalC: 12345, pct: 10 },
  ];

  for (const c of casos) {
    const r = calcularDistribuicaoQuotas({
      fracoes: c.fracoes,
      fcrPercentagem: c.pct,
      totalC: c.totalC,
    });
    eq(
      r.totais.totalC + r.diferencaArredondamento.totalC,
      c.totalC,
      `I-07 Σ emitido + R1 = total teórico (n=${c.fracoes.length}, total=${c.totalC})`
    );
  }
}

// ── I-09: o residual nunca é somado a uma parte ─────────────────────
function testeResidualNaoAbsorvido() {
  // Caso em que o total não divide igualmente pelo grupo.
  const r = calcularDistribuicaoQuotas({
    fracoes: fracoesIguais(3, '333.33'),
    fcrPercentagem: 0,
    totalC: 100000,
  });

  const valores = [...r.porFracao.values()].map((v) => v.totalC);
  // Nenhuma fração tem "o resto": todas recebem o quociente exato.
  eq(valores[0], 33333, 'I-09 fração 1: quociente exato, sem o cêntimo do resto');
  eq(valores[1], 33333, 'I-09 fração 2: quociente exato');
  eq(valores[2], 33333, 'I-09 fração 3: quociente exato');

  const soma = valores.reduce((s, v) => s + v, 0);
  eq(soma, 99999, 'I-09 Σ das frações = 99 999 (não 100 000)');
  eq(r.diferencaArredondamento.totalC, 1, 'I-09 o cêntimo está em R1, não numa fração');
  ok(
    !valores.includes(33334),
    'I-09 nenhuma fração recebeu o cêntimo residual (era o defeito antigo)'
  );

  // O residual não entra no FCR de nenhuma fração.
  eq(
    r.diferencaArredondamento.fcrC,
    fcrTeoricoC(100000, 0) - r.totais.fcrC,
    'I-09/I-10 R2 é reportado à parte'
  );
  for (const [id, v] of r.porFracao) {
    eq(v.fcrC, 0, `I-09 fração ${id}: sem FCR com pct=0`);
  }
}

// ── Casos obrigatórios da especificação ─────────────────────────────
function testeCasosObrigatorios() {
  // 10 000 € distribuídos por 3 frações iguais.
  const r1 = calcularDistribuicaoQuotas({
    fracoes: fracoesIguais(3, '500'),
    fcrPercentagem: 0,
    totalC: toCents('10000.00'),
  });
  const v1 = [...r1.porFracao.values()].map((v) => v.totalC);
  eq(v1[0], 333333, '10 000 € / 3: cada fração recebe 3 333,33 € (333 333 c)');
  ok(v1.every((v) => v === v1[0]), '10 000 € / 3: as três frações recebem exatamente o mesmo');
  eq(r1.diferencaArredondamento.totalC, 1, '10 000 € / 3: R1 = 1 cêntimo');
  eq(r1.totais.totalC + r1.diferencaArredondamento.totalC, 1000000, '10 000 € / 3: fecha');

  // FCR a 10 %.
  const r2 = calcularDistribuicaoQuotas({
    fracoes: fracoesIguais(1, '1000'),
    fcrPercentagem: 10,
    totalC: 5500,
  });
  const c2 = r2.porFracao.get(1);
  eq(c2.totalC, 5500, 'FCR 10%: total 55 €');
  eq(c2.fcrC, 500, 'FCR 10%: FCR = 5 € (componente, não soma)');
  eq(c2.baseC, 5000, 'FCR 10%: base = 50 €');
  eq(c2.baseC + c2.fcrC, c2.totalC, 'FCR 10%: base + FCR = total');

  // Sem FCR.
  const r3 = calcularDistribuicaoQuotas({
    fracoes: fracoesIguais(1, '1000'),
    fcrPercentagem: 0,
    totalC: 5500,
  });
  eq(r3.porFracao.get(1).fcrC, 0, 'pct=0: FCR a zero');
  eq(r3.porFracao.get(1).totalC, 5500, 'pct=0: o total não muda com o FCR');
}

// ── Compatibilidade: valores em euros e em cêntimos ─────────────────
function testeEurosECentimos() {
  const r = calcularDistribuicaoQuotas({
    fracoes: fracoesIguais(1, '500'),
    fcrPercentagem: 10,
    totalC: 5500,
  });
  const v = r.porFracao.get(1);
  eq(v.base, 50, 'euros: base = 50 €');
  eq(v.fcr, 5, 'euros: fcr = 5 €');
  eq(v.total, 55, 'euros: total = 55 €');
  eq(fromCents(v.totalC), v.total, 'euros e cêntimos coerentes');
}

// ── Entradas degeneradas não rebentam ───────────────────────────────
function testeDegenerados() {
  const vazios = [
    { fracoes: [], fcrPercentagem: 0, totalC: 0 },
    { fracoes: null, fcrPercentagem: 10, totalC: 100 },
    { fracoes: [{ id: 1, permilagem: null }], fcrPercentagem: 10, totalC: 100 },
    { fracoes: [{ id: 1, permilagem: '0' }], fcrPercentagem: 10, totalC: 100 },
    { fracoes: fracoesIguais(2, '500'), fcrPercentagem: 'abc', totalC: 100 },
    { fracoes: fracoesIguais(2, '500'), fcrPercentagem: -5, totalC: 100 },
    { fracoes: fracoesIguais(2, '500'), fcrPercentagem: 10, totalC: -100 },
  ];

  for (const c of vazios) {
    const r = calcularDistribuicaoQuotas(c);
    ok(r && r.porFracao instanceof Map, `degenerado ${JSON.stringify(c).slice(0, 60)}: devolve Map`);
    for (const [id, v] of r.porFracao) {
      ok(v.baseC >= 0 && v.fcrC >= 0 && v.totalC >= 0, `degenerado: fração ${id} sem negativos`);
      eq(v.baseC + v.fcrC, v.totalC, `degenerado: fração ${id} base + FCR = total`);
    }
  }
  // Total negativo é tratado como zero (não se cobra negativo).
  const neg = calcularDistribuicaoQuotas({ fracoes: fracoesIguais(2, '500'), fcrPercentagem: 0, totalC: -100 });
  eq(neg.totalTeoricoC, 0, 'total negativo → 0');
  eq(neg.totais.totalC, 0, 'total negativo → nada atribuído');
}

// ── I-04 estendido: o FCR como componente (não soma) ────────────────
function testeFcrComponente() {
  // A diferença semântica: com a fórmula antiga o total subiria acima do
  // orçamento. Com D1, o total É o orçamento e o FCR é uma fatia dele.
  const total = 1200000; // 12 000 €
  const c = dividirComponentesQuota(total, 10);
  eq(c.totalC, total, 'D1: o total não é inflacionado pelo FCR');
  eq(c.fcrC + c.baseC, total, 'D1: FCR + base = total exatamente');
  ok(c.fcrC < total, 'D1: o FCR é uma fatia do total, não um valor a somar');

  // A soma dos FCR das frações pode derivar do FCR teórico — é o R2.
  const r = calcularDistribuicaoQuotas({
    fracoes: fracoesIguais(8, '125'),
    fcrPercentagem: 10,
    totalC: 100001,
  });
  eq(r.totais.fcrC, 9088, 'R2 cenário: Σ FCR emitido = 90,88 €');
  eq(fcrTeoricoC(100001, 10), 9091, 'R2 cenário: FCR teórico = 90,91 €');
  eq(r.diferencaArredondamento.fcrC, 3, 'R2 cenário: R2 = 3 cêntimos, reportado à parte');
  ok(r.diferencaArredondamento.fcrC !== 0, 'R2 pode ser ≠ 0 mesmo quando R1 é pequeno');
}

// ── Execução ───────────────────────────────────────────────────────
function correr() {
  const testes = [
    ['I-01 inteiros em cêntimos', testeInteiros],
    ['I-02/I-03/I-04 componentes base/FCR', testeComponentes],
    ['PD-B teste que distingue D1', testePDB],
    ['I-07 conservação do total', testeConservacao],
    ['I-09 residual não absorvido', testeResidualNaoAbsorvido],
    ['casos obrigatórios', testeCasosObrigatorios],
    ['euros e cêntimos', testeEurosECentimos],
    ['entradas degeneradas', testeDegenerados],
    ['I-04 FCR como componente', testeFcrComponente],
  ];

  console.log('T1 — Primitiva matemática das quotas (Fase A)\n');
  for (const [nome, fn] of testes) {
    try {
      fn();
      console.log(`  ✓ ${nome}`);
    } catch (err) {
      console.error(`  ✗ ${nome}`);
      console.error(`      ${err.message}`);
      process.exitCode = 1;
      throw err;
    }
  }
}

correr();
console.log(`\n✓ T1 passou (${nAssercoes} asserções).`);
