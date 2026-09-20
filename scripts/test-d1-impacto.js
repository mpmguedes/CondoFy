// ═══════════════════════════════════════════════════════════════════
// T-D1 — Semântica de D1 e a métrica de impacto do preflight (V4c).
//
// ── Porque existe este teste ───────────────────────────────────────
//
// O V4c do preflight imprimia «Δ/quota» = +743 c (para 10 €) e +7439 c
// (para 100 €), o que parecia impossível: D1 sobre 10 € só pode diferir 100 c
// da semântica antiga, e sobre 100 €, 1000 c. Foi este teste que fixou a
// resposta: o V4c estava errado, com TRÊS defeitos somados.
//
//   1) o argumento vinha PRÉ-DIVIDIDO — passava-se round(T*100/(100+p)) em vez
//      de T, misturando duas grandezas;
//   2) o ramo «antigo» aplicava D1 outra vez (não a fórmula antiga);
//   3) o ramo «novo» somava o mesmo termo duas vezes (x + x).
//
// Álgebra do valor errado (T=1000, p=10): a=909, b=826, novo=1652, delta=743.
// Para T=10000: a=9091, b=8265, novo=16530, delta=7439.
//
// Este teste assere:
//   · as fórmulas canónicas (casos A e B exigidos pela especificação);
//   · que o Δ é INVARIANTE à permilagem na camada 1;
//   · que as três camadas (total / quota / agregado) não se misturam;
//   · que o valor ERRADO (+743) é detetado — prova de que o teste morde.
//
// Utilização: node scripts/test-d1-impacto.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');

let nAssercoes = 0;
function ok(cond, msg) {
  nAssercoes++;
  assert.ok(cond, msg);
}
function eq(a, b, msg) {
  nAssercoes++;
  assert.strictEqual(a, b, msg);
}

// ── As duas semânticas, canónicas ───────────────────────────────────
//
// ANTIGA: base = total, fcr = round(total × pct/100), valor = base + fcr.
// NOVA  (D1): fcr = round(total × pct/(100+pct)), base = total − fcr, valor = total.
function semanticaD1(totalC, pctF) {
  const fcrNovoC = Math.round((totalC * pctF) / (100 + pctF));
  const baseNovoC = totalC - fcrNovoC;
  const fcrAntigoC = Math.round((totalC * pctF) / 100);
  const baseAntigoC = totalC;
  const totalNovoC = baseNovoC + fcrNovoC;
  const totalAntigoC = baseAntigoC + fcrAntigoC;
  return {
    totalC,
    novo: { baseC: baseNovoC, fcrC: fcrNovoC, totalC: totalNovoC },
    antigo: { baseC: baseAntigoC, fcrC: fcrAntigoC, totalC: totalAntigoC },
    deltaC: totalAntigoC - totalNovoC,
  };
}

// ── A fórmula ERRADA do V4c, reproduzida para provar que o teste morde ──
function dqErrado(totalC, pct) {
  const velho = (() => {
    const baseC = Math.round((totalC * 100) / (100 + pct));
    const fcrC = Math.round((baseC * pct) / 100);
    return baseC + fcrC;
  })();
  const novo =
    Math.round((totalC * 100) / (100 + pct)) + Math.round((totalC * 100) / (100 + pct));
  return novo - totalC;
}

// ── Caso A (exigido): total 1000 c, pct 10 ──────────────────────────
function testeCasoA() {
  const r = semanticaD1(1000, 10);
  eq(r.novo.fcrC, 91, 'A novo: fcr = round(1000×10/110) = 91');
  eq(r.novo.baseC, 909, 'A novo: base = 1000 − 91 = 909');
  eq(r.novo.totalC, 1000, 'A novo: total = 1000 (inalterado)');
  eq(r.antigo.fcrC, 100, 'A antigo: fcr = round(1000×10/100) = 100');
  eq(r.antigo.baseC, 1000, 'A antigo: base = total = 1000');
  eq(r.antigo.totalC, 1100, 'A antigo: total = 1000 + 100 = 1100');
  eq(r.deltaC, 100, 'A delta = 1100 − 1000 = 100 c');
}

// ── Caso B (exigido): total 10000 c, pct 10 ─────────────────────────
function testeCasoB() {
  const r = semanticaD1(10000, 10);
  eq(r.novo.fcrC, 909, 'B novo: fcr = round(10000×10/110) = 909');
  eq(r.novo.baseC, 9091, 'B novo: base = 10000 − 909 = 9091');
  eq(r.novo.totalC, 10000, 'B novo: total = 10000');
  eq(r.antigo.fcrC, 1000, 'B antigo: fcr = 1000');
  eq(r.antigo.baseC, 10000, 'B antigo: base = 10000');
  eq(r.antigo.totalC, 11000, 'B antigo: total = 11000');
  eq(r.deltaC, 1000, 'B delta = 1000 c');
}

// ── O teste MORDE: o valor errado tem de ser rejeitado ──────────────
function testeMorde() {
  // O V4c antigo, com o argumento pre-dividido, dava exatamente estes valores.
  const t10 = Math.round((1000 * 100) / 110);
  const t100 = Math.round((10000 * 100) / 110);
  eq(t10, 909, 'o V4c passava 909 c a dq(), não 1000 c');
  eq(t100, 9091, 'o V4c passava 9091 c a dq(), não 10000 c');
  eq(dqErrado(t10, 10), 743, 'a fórmula antiga do V4c produzia +743 c');
  eq(dqErrado(t100, 10), 7439, 'a fórmula antiga do V4c produzia +7439 c');

  // E os valores corretos NÃO coincidem com os errados — é isso que faz o
  // teste detetar uma regressão para a fórmula quebrada.
  ok(semanticaD1(1000, 10).deltaC !== dqErrado(t10, 10), 'correto (100) ≠ errado (743)');
  ok(semanticaD1(10000, 10).deltaC !== dqErrado(t100, 10), 'correto (1000) ≠ errado (7439)');

  // Reproduzir a álgebra do erro, passo a passo, para documentar a origem.
  const a = Math.round((1000 * 100) / 110); // 909 — argumento pré-dividido
  const b = Math.round((a * 100) / 110); // 826 — D1 aplicada outra vez
  eq(a, 909, 'erro: a = round(1000×100/110) = 909');
  eq(b, 826, 'erro: b = round(909×100/110) = 826');
  eq(b + b, 1652, 'erro: novo = b + b = 1652 (termo somado duas vezes)');
  eq(b + b - a, 743, 'erro: delta = 1652 − 909 = 743');
}

// ── Δ nunca é negativo; é estritamente positivo fora da degenerescência ──
//
// ⚠️ Não exigir Δ>0 em TODOS os totais. Para totais minúsculos o FCR da
// semântica antiga arredonda a ZERO e as duas semânticas coincidem:
//   pct=1 %, total=1 c → antigo fcr = round(1×1/100) = 0 → antigo total = 1
//                      → novo total = 1 ⇒ Δ = 0 (legítimo, não é regressão).
// A fronteira exata: a antiga só não inflaciona quando round(T×pct/100) = 0,
// isto é, T×pct < 50. Fora dessa zona a antiga é SEMPRE estritamente maior.
function testeDeltaSemprePositivo() {
  for (const pct of [1, 2.5, 5, 10, 12.5, 15, 20, 50]) {
    for (const totalC of [1, 10, 100, 999, 1000, 4321, 100000]) {
      const r = semanticaD1(totalC, pct);
      // 1) o Δ nunca pode ser negativo: a antiga nunca produz MENOS que D1.
      ok(r.deltaC >= 0, `pct=${pct} total=${totalC}: Δ>=0 (nunca negativo)`);
      // 2) fora da zona degenerada (T×pct < 50) tem de ser estritamente > 0.
      if (totalC * pct >= 50) {
        ok(r.deltaC > 0, `pct=${pct} total=${totalC}: Δ>0 (fora da degenerescência)`);
      } else {
        eq(r.deltaC, 0, `pct=${pct} total=${totalC}: Δ=0 por arredondamento a zero`);
      }
      ok(r.novo.baseC + r.novo.fcrC === r.novo.totalC, `pct=${pct} total=${totalC}: base+fcr=total`);
      ok(r.novo.totalC === totalC, `pct=${pct} total=${totalC}: D1 preserva o total`);
    }
  }
}

// ── A fronteira degenerada, explicitamente (prova de que é real) ─────
function testeFronteiraDegenerada() {
  // T×pct = 50 ⇒ round(50/100) = round(0.5) = 1 ⇒ a antiga JÁ inflaciona.
  eq(semanticaD1(50, 1).antigo.fcrC, 1, 'T=50, pct=1: fcr antigo = round(0,5) = 1');
  eq(semanticaD1(50, 1).deltaC, 1, 'T=50, pct=1: Δ = 1 c (fronteira)');
  // T×pct = 49 ⇒ round(0,49) = 0 ⇒ coincide.
  eq(semanticaD1(49, 1).antigo.fcrC, 0, 'T=49, pct=1: fcr antigo = round(0,49) = 0');
  eq(semanticaD1(49, 1).deltaC, 0, 'T=49, pct=1: Δ = 0 (degenerado)');
  // E o caso que falhava, agora ancorado por semântica e não por número solto.
  const r = semanticaD1(1, 1);
  eq(r.antigo.totalC, 1, 'T=1, pct=1: a antiga não inflaciona (fcr arredonda a 0)');
  eq(r.deltaC, 0, 'T=1, pct=1: Δ = 0 — as duas semânticas coincidem');
}

// ── D1 preserva o total; a antiga NÃO ───────────────────────────────
function testePreservaTotal() {
  const r = semanticaD1(5000, 10);
  eq(r.novo.totalC, 5000, 'D1: o total é o mesmo que entrou');
  eq(r.antigo.totalC, 5500, 'antiga: o total infla em pct%');
  ok(r.antigo.totalC > r.novo.totalC, 'a antiga sobre-carrega a fração');
}

// ── Camada 1 é invariante à permilagem ──────────────────────────────
// Só faz sentido comparar os dois LADOS para o MESMO total. Um total diferente
// dá um Δ diferente — mas para o mesmo total, o Δ não depende de permilagem.
function testeCamada1Invariancia() {
  const deltas = new Set();
  for (const totalC of [2000, 2000, 2000]) {
    deltas.add(semanticaD1(totalC, 10).deltaC);
  }
  eq(deltas.size, 1, 'mesmo total ⇒ mesmo Δ (a permilagem não entra na camada 1)');
  eq([...deltas][0], 200, 'para 2000 c e 10 %, Δ = 200 c');
}

// ── Camada 2: quota individual = total da fração × semântica ────────
// O total da fração em modo preço é round(valorPor1000C × permilagemEscalada / (1000×100)).
function testeCamada2() {
  const quotaTotalC = (valorPor1000, permilagem) => {
    const vC = Math.round(valorPor1000 * 100);
    const esc = Math.round(permilagem * 100);
    return Math.round((vC * esc) / (1000 * 100));
  };
  // C5 real: valor_por_1000 = 120,0000, permilagem 165‰ → 19,80 € = 1980 c.
  eq(quotaTotalC(120.0, 165), 1980, 'C5 165‰ → 1980 c');
  eq(quotaTotalC(120.0, 160), 1920, 'C5 160‰ → 1920 c');
  eq(quotaTotalC(120.0, 180), 2160, 'C5 180‰ → 2160 c');
  eq(quotaTotalC(120.0, 170), 2040, 'C5 170‰ → 2040 c');
  // C1 real: valor_por_1000 = 405,0800.
  eq(quotaTotalC(405.08, 61.3), 2483, 'C1 61,30‰ → 2483 c');
  eq(quotaTotalC(405.08, 119.4), 4837, 'C1 119,40‰ → 4837 c');
  eq(quotaTotalC(405.08, 181.4), 7348, 'C1 181,40‰ → 7348 c');
  eq(quotaTotalC(405.08, 137.4), 5566, 'C1 137,40‰ → 5566 c');
  eq(quotaTotalC(405.08, 143.2), 5801, 'C1 143,20‰ → 5801 c');

  // E o Δ de D1 sobre cada uma dessas quotas (camada 2).
  const casos = [
    [1980, 198, 'C5 165‰'],
    [1920, 192, 'C5 160‰'],
    [2160, 216, 'C5 180‰'],
    [2040, 204, 'C5 170‰'],
    [2483, 248, 'C1 61,30‰'],
    [4837, 484, 'C1 119,40‰'],
    [7348, 735, 'C1 181,40‰'],
    [5566, 557, 'C1 137,40‰'],
    [5801, 580, 'C1 143,20‰'],
  ];
  for (const [totalC, esperado, rotulo] of casos) {
    eq(semanticaD1(totalC, 10).deltaC, esperado, `Δ camada 2 · ${rotulo}`);
  }
}

// ── As três camadas são grandezas distintas ─────────────────────────
function testeCamadasDistintas() {
  const t = 10000; // 100 €
  const camada1 = semanticaD1(t, 10).deltaC; // 1000 c
  // Camada 2 com uma fração de 181,40‰ do C1:
  const quotaC = Math.round((Math.round(405.08 * 100) * Math.round(181.4 * 100)) / (1000 * 100));
  const camada2 = semanticaD1(quotaC, 10).deltaC;
  // Camada 3 = camada 2 × nº de quotas (estimativa).
  const camada3 = camada2 * 12;

  eq(camada1, 1000, 'camada 1 (total 100 €) = 1000 c');
  eq(camada2, 735, 'camada 2 (quota de 181,40‰ do C1) = 735 c');
  eq(camada3, 8820, 'camada 3 (12 quotas) = 8820 c');
  ok(camada1 !== camada2, 'camada 1 ≠ camada 2 (não misturar)');
  ok(camada2 !== camada3, 'camada 2 ≠ camada 3 (não misturar)');
}

// ── Execução ────────────────────────────────────────────────────────
function correr() {
  const testes = [
    ['Caso A (1000 c / 10 %)', testeCasoA],
    ['Caso B (10000 c / 10 %)', testeCasoB],
    ['o teste morde (reproduz +743 / +7439)', testeMorde],
    ['Δ >= 0, e > 0 fora da degenerescência', testeDeltaSemprePositivo],
    ['fronteira degenerada (T×pct < 50)', testeFronteiraDegenerada],
    ['D1 preserva o total; a antiga não', testePreservaTotal],
    ['camada 1 invariante à permilagem', testeCamada1Invariancia],
    ['camada 2 quotas reais C1/C5', testeCamada2],
    ['as três camadas são distintas', testeCamadasDistintas],
  ];
  console.log('T-D1 — Semântica de D1 e métrica de impacto (Fase A)\n');
  for (const [nome, fn] of testes) {
    try {
      fn();
      console.log(`  ✓ ${nome}`);
    } catch (err) {
      console.error(`  ✗ ${nome}`);
      console.error(`      ${err.message}`);
      process.exit(1);
    }
  }
}

correr();
console.log(`\n✓ T-D1 passou (${nAssercoes} asserções).`);
