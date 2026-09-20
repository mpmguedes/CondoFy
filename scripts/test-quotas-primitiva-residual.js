// ═══════════════════════════════════════════════════════════════════
// T3 — Residual não absorvido e I-08 revisto (Fase A, C1).
//
// ── I-08 (revisão aprovada) ────────────────────────────────────────
//
//   residualC = totalC − Σ partes
//   |residualC| ≤ nGrupos + Σ(nMembrosDoGrupo − 1)
//
// O residual tem DUAS origens independentes:
//
//   · `nGrupos` cêntimos          — resto do arredondamento ENTRE grupos
//     (maior-resto: cada grupo recebe um quinhão inteiro e sobra menos de
//      1 cêntimo por grupo);
//   · `Σ(nMembrosDoGrupo − 1)`    — resto DENTRO de cada grupo, imposto por D3
//     quando o valor do grupo não é divisível pelo nº de membros. É o CUSTO de
//     manter a igualdade: como o cêntimo indivisível não pode ir para um só
//     membro, sobra. Com n membros sobram até n−1 cêntimos.
//
// O I-08 original (`≤ nGrupos`) era incompatível com D3 — medido: falhava em
// 20 977 de 40 000 casos aleatórios (52 %). Não se relaxou a D3 para caber num
// limite errado: corrigiu-se o limite. Ver docs/C1-BLOQUEIO-I08-2026-09-20.md.
//
// Utilização: node scripts/test-quotas-primitiva-residual.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const { toCents } = require('../helpers/money');
const P = require('../helpers/quotas-primitiva');

const { distribuirPorGrupos, agruparPorPermilagem, limiteResidual, calcularDistribuicaoQuotas } = P;

let nAssercoes = 0;
let nCasosStress = 0;
function ok(cond, msg) {
  nAssercoes++;
  assert.ok(cond, msg);
}
function eq(a, b, msg) {
  nAssercoes++;
  assert.strictEqual(a, b, msg);
}

// ── As duas parcelas do limite, isoladas ────────────────────────────
function testeParcelasDoLimite() {
  // Só a parcela ENTRE grupos: um membro por grupo ⇒ intra-grupo = 0.
  const umPorGrupo = agruparPorPermilagem([
    { id: 1, permilagem: '500' },
    { id: 2, permilagem: '300' },
    { id: 3, permilagem: '200' },
  ]);
  const lim1 = limiteResidual(umPorGrupo);
  eq(lim1.entreGruposC, 3, 'parcela entre-grupos = nº de grupos (3)');
  eq(lim1.intraGruposC, 0, 'parcela intra-grupo = 0 (cada grupo tem 1 membro)');
  eq(lim1.limiteC, 3, 'limite total = 3');

  // Só a parcela INTRA-grupo: um grupo de 5 membros ⇒ entre-grupos = 1.
  const cinco = agruparPorPermilagem(
    Array.from({ length: 5 }, (_, i) => ({ id: i + 1, permilagem: '200' }))
  );
  const lim2 = limiteResidual(cinco);
  eq(lim2.entreGruposC, 1, 'parcela entre-grupos = 1 (um só grupo)');
  eq(lim2.intraGruposC, 4, 'parcela intra-grupo = 4 (5 membros − 1)');
  eq(lim2.limiteC, 5, 'limite total = 5');

  // Mistura: grupos de tamanhos diferentes.
  const misto = agruparPorPermilagem([
    { id: 1, permilagem: '500' },
    { id: 2, permilagem: '250' },
    { id: 3, permilagem: '250' },
    { id: 4, permilagem: '250' },
    { id: 5, permilagem: '100' },
  ]);
  const lim3 = limiteResidual(misto);
  eq(lim3.entreGruposC, 3, 'misto: 3 grupos');
  eq(lim3.intraGruposC, 0 + 2 + 0, 'misto: intra = (1−1) + (3−1) + (1−1) = 2');
  eq(lim3.limiteC, 5, 'misto: limite = 3 + 2 = 5');
}

// ── O residual é exatamente o que sobra, e nunca entra numa fração ──
function testeResidualExato() {
  // Grupo de 5, quinhão não divisível: 5049 / 5 = 1009.8
  const grupos = agruparPorPermilagem(
    Array.from({ length: 5 }, (_, i) => ({ id: i + 1, permilagem: '200' }))
  );
  const r = distribuirPorGrupos(5049, grupos);
  const valores = [...r.porFracao.values()];
  eq(valores.length, 5, 'cinco frações receberam valor');
  ok(valores.every((v) => v === 1009), 'I-05 todas recebem 1009 cêntimos');
  eq(r.residualC, 5049 - 5 * 1009, 'residualC = total − Σ partes');
  eq(r.residualC, 4, 'residualC = 4 (5 × 1009 = 5045)');
  ok(!valores.includes(1010), 'nenhuma fração recebeu o cêntimo a mais');

  // Σ + residual = total (I-07).
  eq(valores.reduce((s, v) => s + v, 0) + r.residualC, 5049, 'I-07 conservação');
}

// ── O I-08 ANTIGO falharia; o revisto não ───────────────────────────
function testeLimiteAntigoVsRevisto() {
  // Grupo único de 50 membros, total 5049: residual 49.
  const grupos = agruparPorPermilagem(
    Array.from({ length: 50 }, (_, i) => ({ id: i + 1, permilagem: '20' }))
  );
  const r = distribuirPorGrupos(5049, grupos);
  const lim = limiteResidual(grupos);

  eq(r.residualC, 49, 'o residual é 49 cêntimos');
  eq(grupos.length, 1, 'um só grupo');
  // I-08 ANTIGO: |residual| ≤ nGrupos = 1  → 49 > 1, VIOLADO.
  ok(r.residualC > grupos.length, 'o limite ANTIGO (≤ nGrupos = 1) seria violado por 49 > 1');
  // I-08 REVISTO: ≤ 1 + (50−1) = 50  → 49 ≤ 50, respeitado.
  eq(lim.limiteC, 50, 'o limite REVISTO é 50');
  ok(r.residualC <= lim.limiteC, 'I-08 revisto: 49 ≤ 50 — respeitado');

  // E o valor por membro mantém-se igual para todos (D3).
  const valores = [...r.porFracao.values()];
  ok(valores.every((v) => v === 100), 'D3: as 50 frações recebem exatamente 100 cêntimos');
  eq(valores.reduce((s, v) => s + v, 0), 5000, 'Σ partes = 5000');
  eq(5000 + 49, 5049, 'Σ + residual = total');
}

// ── O residual nunca é negativo ─────────────────────────────────────
function testeResidualNaoNegativo() {
  const casos = [
    { n: 3, total: 100 },
    { n: 7, total: 1000 },
    { n: 50, total: 5049 },
    { n: 137, total: 13700 },
    { n: 1, total: 1 },
    { n: 5, total: 0 },
  ];
  for (const c of casos) {
    const grupos = agruparPorPermilagem(
      Array.from({ length: c.n }, (_, i) => ({ id: i + 1, permilagem: '20' }))
    );
    const r = distribuirPorGrupos(c.total, grupos);
    ok(r.residualC >= 0, `n=${c.n} total=${c.total}: residual nunca negativo (${r.residualC})`);
  }
}

// ── R1, R2 e E1 são independentes ───────────────────────────────────
function testeR1R2E1Independentes() {
  // Cenário: total não divisível E com FCR ⇒ R1 e R2 ambos ≠ 0.
  const r = calcularDistribuicaoQuotas({
    fracoes: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, permilagem: '125' })),
    fcrPercentagem: 10,
    totalC: 100001,
  });
  eq(r.diferencaArredondamento.totalC, 1, 'R1 = 1 cêntimo');
  eq(r.diferencaArredondamento.fcrC, 3, 'R2 = 3 cêntimos');
  eq(r.diferencaArredondamento.estruturalC, null, 'E1 = null (não foi dado valorPor1000)');
  ok(
    r.diferencaArredondamento.totalC !== r.diferencaArredondamento.fcrC,
    'R1 e R2 são valores independentes'
  );

  // Cenário: R2 ≠ 0 mesmo com R1 = 0 (total exato, FCR derivado).
  // 10 000,00 € = 1 000 000 cêntimos, FCR 10 %, 5 frações de 200‰.
  //
  //   R1 = 0  — cada fração recebe exatamente 200 000 c (2 000,00 €), o total
  //             divide-se sem sobra, logo não há residual de total.
  //   R2 = −1 — mas o FCR NÃO fica de fora do arredondamento:
  //             fcrTeorico = round(1000000 × 10/110) = round(90909,09…) = 90909
  //             por fração = round( 200000 × 10/110) = round(18181,81…) = 18182
  //             Σ fcrC = 5 × 18182 = 90910
  //             R2 = 90909 − 90910 = −1
  //
  // O sinal negativo é o ponto do teste: 18181,81… arredonda PARA CIMA cinco
  // vezes (5 × +0,19), enquanto 90909,09… arredonda PARA BAIXO uma vez
  // (−0,09). O resultado agregado fica 1 cêntimo acima do teórico. Não se
  // corrige o fcrC de nenhuma fração para o esconder — reporta-se como R2.
  // (Tal como R1, R2 nunca é absorvido por uma fração, nunca aumenta dívida
  //  nem receita.)
  const r2 = calcularDistribuicaoQuotas({
    fracoes: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, permilagem: '200' })),
    fcrPercentagem: 10,
    totalC: toCents('10000.00'),
  });
  eq(r2.diferencaArredondamento.totalC, 0, 'R1 = 0 (o total divide exatamente)');
  eq(r2.totais.fcrC, 90910, 'Σ fcrC = 90 910 (5 × 18 182 — cada fração arredonda por excesso)');
  eq(r2.totais.baseC, 909090, 'Σ baseC = 909 090');
  eq(r2.totais.totalC, 1000000, 'Σ totalC = 1 000 000 (nenhum cêntimo perdido)');
  eq(
    P.fcrTeoricoC(toCents('10000.00'), 10),
    90909,
    'fcrTeoricoC = 90 909 (arredonda por defeito, ao contrário das frações)'
  );
  eq(
    r2.diferencaArredondamento.fcrC,
    -1,
    'R2 = −1 cêntimo: o FCR por fração excede o teórico, mesmo com R1 = 0'
  );
  ok(
    r2.diferencaArredondamento.fcrC !== 0,
    'R2 existe independentemente de R1 (R1 = 0 e R2 ≠ 0)'
  );
  ok(
    r2.diferencaArredondamento.fcrC !== r2.diferencaArredondamento.totalC,
    'R1 e R2 não são o mesmo número'
  );

  // E1 só aparece quando o chamador fornece o valor por 1000‰.
  const comE1 = calcularDistribuicaoQuotas({
    fracoes: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, permilagem: '333.33' })),
    fcrPercentagem: 0,
    totalC: 99999,
    valorPor1000C: 100000,
  });
  eq(comE1.diferencaArredondamento.estruturalC, -1, 'E1 = −1 cêntimo');
  eq(comE1.diferencaArredondamento.totalC, 0, 'R1 = 0 — E1 e R1 separados');
  ok(
    comE1.diferencaArredondamento.estruturalC !== comE1.diferencaArredondamento.totalC,
    'E1 ≠ R1: a diferença estrutural não é residual de arredondamento'
  );
}

// ── Stress: I-07 e I-08 em milhares de casos ────────────────────────
function testeStress() {
  // Gerador determinístico (xorshift) — sem dependência de Math.random, para o
  // teste ser reprodutível. Uma falha futura reproduz-se com os mesmos números.
  let semente = 0x2f6e2b1;
  function rnd(n) {
    semente ^= semente << 13;
    semente ^= semente >>> 17;
    semente ^= semente << 5;
    semente >>>= 0;
    return semente % n;
  }

  let falhas7 = 0;
  let falhas8 = 0;
  let residMax = 0;
  let margemMax = -Infinity;
  let igualdadeQuebrada = 0;

  const N = 20000;
  for (let t = 0; t < N; t++) {
    const nGrupos = 1 + rnd(8);
    const grupos = [];
    const fracoes = [];
    let idSeq = 1;
    for (let g = 0; g < nGrupos; g++) {
      const perm = 1 + rnd(400); // ‰
      const nMembros = 1 + rnd(8);
      const membros = [];
      for (let m = 0; m < nMembros; m++) {
        const id = idSeq++;
        membros.push(id);
        fracoes.push({ id, permilagem: String(perm) });
      }
      grupos.push({ chave: String(perm * 100), membros, permilagemEscalada: perm * 100 });
    }

    const total = rnd(5000000);

    const r = distribuirPorGrupos(total, grupos);
    const lim = limiteResidual(grupos);
    nCasosStress++;

    // I-07
    let soma = 0;
    for (const v of r.porFracao.values()) soma += v;
    if (soma + r.residualC !== total) falhas7++;

    // I-08 revisto
    if (!(r.residualC >= 0 && r.residualC <= lim.limiteC)) {
      falhas8++;
      if (falhas8 <= 3) {
        console.error(
          `      falha I-08: total=${total} resid=${r.residualC} limite=${lim.limiteC}`
        );
      }
    }
    residMax = Math.max(residMax, r.residualC);
    margemMax = Math.max(margemMax, r.residualC - lim.limiteC);

    // D3: igualdade dentro de cada grupo.
    for (const g of grupos) {
      const vals = g.membros.map((id) => r.porFracao.get(id));
      if (!vals.every((v) => v === vals[0])) igualdadeQuebrada++;
    }
  }

  eq(falhas7, 0, `I-07 (Σ + residual = total): ${N} casos, 0 falhas`);
  eq(falhas8, 0, `I-08 revisto: ${N} casos, 0 falhas`);
  eq(igualdadeQuebrada, 0, `D3 (igualdade dentro do grupo): ${N} casos, 0 quebras`);
  ok(margemMax <= 0, `o limite revisto é folgado o suficiente (margem ${margemMax} ≤ 0)`);
  ok(residMax > 0, 'o stress gerou residuais > 0 (o teste não passou por vacuidade)');

  console.log(
    `      stress: ${nCasosStress} casos · residual máx. ${residMax} · margem máx. vs limite ${margemMax}`
  );
}

// ── O stress não passa por vacuidade ────────────────────────────────
function testeNaoVacuidade() {
  // Prova de que o cenário de stress realmente exercita residuais grandes:
  // o caso pior tem de exceder o limite ANTIGO.
  const grupos = agruparPorPermilagem(
    Array.from({ length: 50 }, (_, i) => ({ id: i + 1, permilagem: '20' }))
  );
  const r = distribuirPorGrupos(5049, grupos);
  ok(
    r.residualC > grupos.length,
    'não vacuididade: existe um caso real em que o limite antigo falharia'
  );
  ok(r.residualC <= limiteResidual(grupos).limiteC, 'e o limite revisto apanha-o');
}

// ── Execução ───────────────────────────────────────────────────────
function correr() {
  const testes = [
    ['as duas parcelas do limite I-08', testeParcelasDoLimite],
    ['residual exato, não absorvido', testeResidualExato],
    ['limite antigo vs revisto (50 membros)', testeLimiteAntigoVsRevisto],
    ['residual nunca negativo', testeResidualNaoNegativo],
    ['R1 / R2 / E1 independentes', testeR1R2E1Independentes],
    ['não vacuidade do stress', testeNaoVacuidade],
    ['stress I-07 / I-08 / D3', testeStress],
  ];

  console.log('T3 — Residual não absorvido e I-08 revisto (Fase A)\n');
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
console.log(`\n✓ T3 passou (${nAssercoes} asserções · ${nCasosStress} casos de stress).`);
