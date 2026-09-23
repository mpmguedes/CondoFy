// ═══════════════════════════════════════════════════════════════════
// Menu lateral em mobile — o último item tem de ser alcançável (sem BD/rede).
//
// Porque existe: a barra inferior móvel (`.mobile-bottom-bar`) é `position:
// fixed`, `z-index: 1050` — ACIMA do drawer (`.sidebar`, `z-index: 1040`). O
// drawer ocupava `top: 0; bottom: 0`, ou seja, ia até ao fundo do ecrã, e a
// área de scroll do menu (`.sidebar-nav`) terminava DEBAIXO da barra. O último
// item ficava tapado: em 320x568, 390x844 e 430x932 media 31px de interseção
// com a barra e não recebia o clique (medido com browser real, CDP).
//
// A correção tem duas partes, ambas verificadas aqui:
//   (a) o drawer termina ANTES da barra — `calc(100vh - var(--bottom-bar-h)
//       - env(safe-area-inset-bottom, 0px))`;
//   (b) a área de scroll reserva a safe-area no fundo.
//
// Este teste é ESTÁTICO (lê o CSS e os templates): não substitui a medição com
// browser, mas impede que a correção desapareça numa refatoração. Roda no
// `test:offline` junto de `test-tipografia.js`/`test-contraste.js`.
//
// Utilização: node scripts/test-menu-mobile-altura.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// Leitura normalizada para LF (dívida P38): um checkout com `core.autocrlf=true`
// deixaria `\r` a perturbar as comparações de linha.
const lerCss = () => fs.readFileSync(path.join(RAIZ, 'public', 'css', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const css = lerCss();

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };

// ── 1. O token da altura da barra existe e é coerente com o layout ──
console.log('\n── Altura da barra inferior (token)');
const declToken = css.match(/--bottom-bar-h:\s*([\d.]+)px;/);
assert.ok(declToken, 'existe o token `--bottom-bar-h` (a altura da barra móvel é uma só, nomeada)');
const alturaToken = Number(declToken[1]);
assert.ok(alturaToken > 0 && alturaToken <= 120, `--bottom-bar-h com valor plausível (${alturaToken}px)`);
feito(`token --bottom-bar-h = ${alturaToken}px`);

// A altura REAL declarada para a barra (min-height do item, em mobile) tem de
// caber no token — senão o offset do drawer volta a ser curto.
const minItem = css.match(/\.mobile-bottom-bar \.mb-item\s*\{[^}]*min-height:\s*(\d+)px/);
assert.ok(minItem, 'a barra inferior declara `min-height` no item (móvel)');
assert.ok(alturaToken >= Number(minItem[1]),
  `o token (${alturaToken}px) cobre a altura mínima do item da barra (${minItem[1]}px)`);
feito(`token cobre a altura real do item (min-height ${minItem[1]}px ≤ ${alturaToken}px)`);

// ── 2. O drawer em mobile termina antes da barra ─────────────────────
console.log('\n── Drawer em mobile: reserva da barra');
// Só interessa o bloco `@media (max-width: 991.98px)` que contém a regra do
// drawer (`.sidebar {`) — não a regra base, que é do desktop.
const inicioBloco = css.indexOf('/* ── Responsive ──');
assert.ok(inicioBloco > 0, 'bloco «Responsive» localizado');
// O bloco acaba onde começa a cauda de ecrãs baixos (a seguir vem o de 575px).
const fimBloco = css.indexOf('@media (max-width: 991.98px) and (max-height: 520px)');
assert.ok(fimBloco > inicioBloco, 'cauda de ecrãs baixos depois do bloco principal');
const bloco991 = css.slice(inicioBloco, fimBloco);
assert.ok(bloco991.length > 0, 'bloco de 991.98px localizado');

// A reserva tem de estar na regra `.sidebar` que acrescenta o offset.
const todasSidebar = [...bloco991.matchAll(/\.sidebar\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(todasSidebar.length >= 2, 'o bloco mobile tem as regras `.sidebar` esperadas');
const corpoSidebar = todasSidebar[todasSidebar.length - 1];
assert.ok(/--bottom-bar-h/.test(corpoSidebar),
  'o `.sidebar` mobile desconta `--bottom-bar-h` (sem isto o último item fica sob a barra)');
assert.ok(/env\(safe-area-inset-bottom/.test(corpoSidebar),
  'o `.sidebar` mobile desconta também `env(safe-area-inset-bottom)` (telemóveis com barra gestual)');
assert.ok(/100dvh/.test(corpoSidebar),
  'há uma linha `100dvh` (fallback moderno: acompanha a barra do browser ao aparecer/desaparecer)');
// A ordem importa: `100dvh` primeiro, o `calc(100vh …)` (compatibilidade) depois.
const posDvh = corpoSidebar.indexOf('100dvh');
const posCalc = corpoSidebar.indexOf('calc(100vh');
assert.ok(posCalc > posDvh, 'o `calc(100vh …)` vem DEPOIS do `100dvh` (é o fallback de browsers antigos)');
feito('`.sidebar` mobile: `100dvh` com fallback `calc(100vh − barra − safe-area)`');

// A largura não pode exceder o ecrã (em ecrãs com menos de 244px de largura o
// drawer era mais largo do que a janela).
assert.ok(/width:\s*min\(var\(--sidebar-w\),\s*100vw\)/.test(corpoSidebar),
  'o `.sidebar` mobile não é mais largo do que a janela (`min(--sidebar-w, 100vw)`)');
feito('largura do drawer limitada por `min(--sidebar-w, 100vw)`');

// ── 3. A área de scroll reserva o fundo ──────────────────────────────
console.log('\n── Área de scroll do menu');
const regraNav993 = bloco991.match(/\.sidebar-nav\s*\{([\s\S]*?)\n\s*\}/);
assert.ok(regraNav993, 'existe uma regra `.sidebar-nav` no bloco de 991.98px');
assert.ok(/padding-bottom:\s*calc\([^;]*env\(safe-area-inset-bottom/.test(regraNav993[1]),
  'o `.sidebar-nav` mobile reserva `env(safe-area-inset-bottom)` no `padding-bottom`');
feito('`.sidebar-nav` mobile reserva a safe-area no `padding-bottom`');

// ── 4. Ecrãs muito baixos: o drawer volta a ocupar a janela ──────────
console.log('\n── Cauda de ecrãs baixos (paisagem)');
assert.ok(/@media \(max-width: 991\.98px\) and \(max-height: 520px\)\s*\{/.test(css),
  'existe a cauda `(max-height: 520px)`: em ecrãs muito baixos o menu cola ao fundo');
const cauda = css.slice(css.indexOf('and (max-height: 520px)'));
assert.ok(/\.sidebar\s*\{[^}]*100dvh/.test(cauda.slice(0, 400)),
  'nessa cauda o `.sidebar` volta a `100dvh` (o menu não pode desaparecer atrás da barra)');
feito('cauda para ecrãs < 520px de altura (paisagem) definida');

// ── 5. A barra continua com z-index acima do drawer ──────────────────
console.log('\n── Sobreposição: a barra manda acima do drawer');
const zSidebar = Number((css.match(/\.sidebar\s*\{[^}]*z-index:\s*(\d+)/) || [])[1]);
const zBottom = Number((css.match(/\.mobile-bottom-bar\s*\{[^}]*z-index:\s*(\d+)/) || [])[1]);
assert.ok(zSidebar > 0 && zBottom > 0, 'ambos declaram `z-index`');
assert.ok(zBottom > zSidebar,
  `a barra inferior (${zBottom}) fica acima do drawer (${zSidebar}) — é a razão de o offset ser obrigatório`);
feito(`barra (z ${zBottom}) acima do drawer (z ${zSidebar})`);

// ── 6. Desktop intocado ──────────────────────────────────────────────
console.log('\n── Desktop inalterado');
const regraSidebarBase = css.match(/\n\.sidebar\s*\{([^}]*)\}/);
assert.ok(regraSidebarBase, 'existe a regra base `.sidebar` (desktop)');
assert.ok(/position:\s*fixed/.test(regraSidebarBase[1]), 'no desktop o `.sidebar` continua `position: fixed`');
assert.ok(/top:\s*0/.test(regraSidebarBase[1]) && /bottom:\s*0/.test(regraSidebarBase[1]),
  'no desktop o `.sidebar` continua colado ao topo E ao fundo (sem reserva de barra — não existe barra)');
assert.ok(!/--bottom-bar-h/.test(regraSidebarBase[1]),
  'o desktop NÃO desconta a barra inferior (a barra não existe aí)');
// O desktop continua a usar `--sidebar-w` e a margem do corpo correspondente.
assert.ok(/--sidebar-w:\s*244px;/.test(css), 'largura da sidebar inalterada (244px)');
feito('desktop: `top: 0; bottom: 0`, sem reserva de barra');

// ── 7. Cache do CSS renovado nos DOIS layouts ────────────────────────
console.log('\n── Invalidação de cache');
const layouts = ['views/layouts/main.handlebars', 'views/layouts/blank.handlebars'];
const versoes = layouts.map((f) => {
  const m = ler(f).match(/styles\.css\?v=(\d{8}[a-z])/);
  assert.ok(m, `${f}: a folha de estilos é pedida com versão`);
  return m[1];
});
assert.strictEqual(versoes[0], versoes[1], 'a mesma versão da folha nos dois layouts');
feito(`versão do CSS igual nos dois layouts (${versoes[0]})`);

console.log(`\n✓ Menu mobile: o último item fica fora da barra inferior e clicável (${n} verificações, sem rede/BD).`);
