// A14 §14 — Acessibilidade das vistas da APLICAÇÃO (sem BD, sem rede).
//
// ── Porque é que este teste existe ──────────────────────────────────────
// O §14 não é «correr um validador e ver o que sai». As regras que aqui se
// fixam são as que um leitor de ecrã sente:
//
//   1. ÍCONE DECORATIVO NÃO TEM NOME. `<span class="material-symbols-outlined">
//      visibility</span>` dentro de um botão faz o nome acessível ser
//      «visibility Visualizar comprovativo» — o utilizador ouve a LIGADURA do
//      ícone antes do rótulo. Todos os ícones da app têm de levar
//      `aria-hidden="true"`.
//
//   2. CONTROLO SÓ-ÍCONE TEM NOME PRÓPRIO. Se não há texto visível, o
//      `aria-label` é a única coisa que o leitor de ecrã lê.
//
//   3. O ESTADO ATIVO NÃO É SÓ COR. `aria-current` é o que o leitor de ecrã
//      anuncia; a cor sozinha não chega (A14 §2).
//
//   4. AS REGIÕES DE ESTADO SÃO ANUNCIADAS. Um estado vazio que aparece
//      depois de um filtro tem de ter `role="status"` para ser lido.
//
// Âmbito: `views/**` EXCETO `views/publicas/**` (landing de marketing, outra
// frente) e os parciais `_home-*` da mesma landing. Medido, não presumido.
//
// Utilização: node scripts/test-a11y-a14.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'views');

// ── Âmbito ───────────────────────────────────────────────────────────────
const EXCL_DIRS = [path.join(ROOT, 'publicas')];
function naApp(caminho) {
  if (EXCL_DIRS.some((d) => caminho.startsWith(d))) return false;
  if (path.basename(caminho).startsWith('_home-')) return false;
  return caminho.endsWith('.handlebars');
}
function vistas(dir, saida = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) vistas(p, saida);
    else if (naApp(p)) saida.push(p);
  }
  return saida;
}
const FICHEIROS = vistas(ROOT).sort();
assert.ok(FICHEIROS.length > 100,
  `o âmbito da app tem de ser largo (encontrados: ${FICHEIROS.length})`);

const rel = (p) => path.relative(ROOT, p);
let verificacoes = 0;
const falhas = [];

// ── 1. Ícones decorativos têm de estar ocultos ───────────────────────────
// Percorre o TAG de abertura (não a linha): `aria-hidden` pode vir depois da
// classe, e um grep por linha dar-nos-ia falsos negativos — foi exatamente o
// que aconteceu na primeira medição deste trabalho.
const RE_ICONE = /<(?:span class="material-symbols-outlined[^"]*"|i class="bi bi-[a-z0-9-]+")([^>]*)>/g;
let totalIcones = 0;
for (const f of FICHEIROS) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(RE_ICONE)) {
    totalIcones += 1;
    verificacoes += 1;
    if (!/aria-hidden="true"/.test(m[1])) {
      falhas.push(`${rel(f)}:${s.slice(0, m.index).split('\n').length} — `
        + `ícone sem aria-hidden (o nome acessível herda a ligadura): ${m[0].slice(0, 70)}`);
    }
  }
}
assert.ok(totalIcones > 300,
  `há ícones suficientes para a verificação valer (encontrados: ${totalIcones})`);

// ── 2. Controlo só-ícone tem de ter nome acessível ───────────────────────
// Um `<button>`/`<a>` cujo conteúdo é APENAS um ícone precisa de um nome que
// o leitor de ecrã LEIA. Aceitar `title` seria um FALSO VERDE: o `title` não é
// anunciado de forma fiável (e o projeto tem `data-ajuda` para a ajuda
// visual). Exige-se `aria-label` — foi o que a mutação demonstrou: retirar o
// `aria-label` deixando o `title` NÃO fazia o teste morder.
const RE_CTRL_SO_ICONE = /<(a|button)\b([^>]*)>\s*<(?:span class="material-symbols-outlined[^"]*"|i class="bi bi-[a-z0-9-]+")[^>]*>[a-z_0-9-]*<\/(?:span|i)>\s*<\/(?:a|button)>/g;
let totalSoIcone = 0;
for (const f of FICHEIROS) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(RE_CTRL_SO_ICONE)) {
    totalSoIcone += 1;
    verificacoes += 1;
    const tag = m[0];
    if (!/aria-label="[^"]+"/.test(tag)) {
      falhas.push(`${rel(f)}:${s.slice(0, m.index).split('\n').length} — `
        + `controlo só-ícone sem aria-label (o «title» não é um nome fiável): ${tag.slice(0, 90)}`);
    }
  }
}
assert.ok(totalSoIcone > 20,
  `há controlos só-ícone que cheguem (encontrados: ${totalSoIcone})`);

// ── 3. Estado ativo com sinal não cromático ──────────────────────────────
// Os parciais de tabs do admin e do portal: a tab ativa leva `aria-current`.
const TABS = [
  'partials/_quotas-tabs.handlebars',
  'partials/_assembleias-tabs.handlebars',
  'partials/_condomino-quotas-tabs.handlebars',
  'partials/_config-tabs.handlebars',
];
for (const t of TABS) {
  const s = fs.readFileSync(path.join(ROOT, t), 'utf8');
  assert.ok(s.includes('aria-current="page"'),
    `${t}: a tab ativa tem de levar aria-current="page"`);
  // E o ativo NÃO pode ser dado SÓ por uma classe de cor: tem de haver
  // também a classe semântica `active` (que o CSS trata com três sinais).
  assert.ok(/aria-current="page"/.test(s) && /active/.test(s),
    `${t}: o ativo leva aria-current E a classe active`);
  verificacoes += 1;
}

// ── 3b. NAVEGAÇÃO: o item ativo tem de ser anunciado ─────────────────────
// O sidebar e a barra inferior marcam o item ativo com uma CLASSE
// (`active`/`mb-item-ativo`). A cor não chega: um leitor de ecrã precisa de
// `aria-current`. Tinha 31 itens no sidebar sem ele.
//
// ⛔ ARMADILHA PROVADA: o helper `ariaCurrent` devolve HTML, por isso
// `{{ariaCurrent …}}` (chaveta dupla) ESCAPA-o — o browser recebe um atributo
// com o NOME `aria-current&#x3D;&quot;page&quot;` e valor vazio, e
// `getAttribute('aria-current')` devolve `null`. Tem de ser `{{{ }}}`.
// Este teste morde nas duas pontas: falta de aria-current E chaveta dupla.
const NAV = ['layouts/main.handlebars', 'partials/_bottom-bar.handlebars'];
for (const t of NAV) {
  const s = fs.readFileSync(path.join(ROOT, t), 'utf8');
  // Conta os itens que PODEM ficar ativos: cada um tem de ter, no mesmo
  // elemento, a forma de o ANUNCIAR. Não basta o ficheiro conter a string:
  // tê-la uma só vez com 31 itens ativos é precisamente o defeito.
  const marcasAtivas = (s.match(/class="(?:sidebar-item|mb-item) /g) || []).length;
  assert.ok(marcasAtivas > 0, `${t}: tem itens de navegação`);
  // Formas de anunciar: `{{{ariaCurrent …}}}` (helper) + `{{#if …}}aria-current="page"{{/if}}` (inline)
  // + o caso em que o PRÓPRIO elemento é incondicionalmente ativo (o ramo
  // `{{#if}}` de um par mutuamente exclusivo, em que o ramo `{{else}}` fica sem
  // `aria-current` por construção — não pode estar ativo).
  const porHelper = (s.match(/\{\{\{ariaCurrent /g) || []).length;
  const porInline = (s.match(/\{\{#if [^}]*\}\}aria-current="page"\{\{\/if\}\}/g) || []).length;
  const incondicionais = (s.match(/aria-current="page"/g) || []).length - porInline;
  // Itens que, por construção, NUNCA podem estar ativos: o ramo `{{else}}` de um
  // par mutuamente exclusivo. Contam-se à parte para que a soma feche sem que a
  // regra fique mais fraca (um item ativo sem anúncio continua a falhar).
  const sempreInativos = (s.match(/class="(?:sidebar-item|mb-item)"(?![^>]*aria-current)/g) || []).length;
  assert.strictEqual(porHelper + porInline + incondicionais + sempreInativos, marcasAtivas,
    `${t}: cada um dos ${marcasAtivas} itens de navegação tem de anunciar o ativo `
    + `ou ser inativo por construção (encontrados: ${porHelper} helper + ${porInline} inline `
    + `+ ${incondicionais} fixo + ${sempreInativos} inativo-por-construção)`);
  verificacoes += marcasAtivas;
  // ⛔ Armadilha provada: `{{ariaCurrent }}` (dupla) ESCAPA o valor e o browser
  // cria um atributo com o NOME escapado — `getAttribute('aria-current')` = null.
  // `(?<!\{)` é essencial: sem ele o padrão também apanha `{{{ariaCurrent`.
  const duplas = s.match(/(?<!\{)\{\{ariaCurrent /g) || [];
  assert.strictEqual(duplas.length, 0,
    `${t}: \`{{ariaCurrent }}\` escapa o atributo — usar \`{{{ariaCurrent }}}\``);
  // Cada chaveta tripla tem de fechar com tripla.
  const triplasFechadas = s.match(/\{\{\{ariaCurrent[^}]*\}\}\}/g) || [];
  assert.strictEqual(triplasFechadas.length, porHelper,
    `${t}: uma chamada ariaCurrent com chaveta tripla ficou mal fechada`);
}

// ── 4. Regiões de estado dos estados vazios ──────────────────────────────
// Os três casos do §13 têm de ser anunciados como região de estado. Um
// `role="status"` num bloco que muda depois de um filtro é o que faz o leitor
// de ecrã dizer «Sem quotas com estes filtros» em vez de ficar em silêncio.
{
  const s = fs.readFileSync(path.join(ROOT, 'partials/_empty-state.handlebars'), 'utf8');
  const regioes = (s.match(/role="status"/g) || []).length;
  assert.strictEqual(regioes, 3,
    `_empty-state: os TRÊS casos do §13 têm de ser role="status" (encontrados: ${regioes})`);
  verificacoes += 1;
}

// ── 5. O ícone do estado vazio é decorativo ──────────────────────────────
// O título já diz o que é; o ícone é reforço visual. Se não estivesse
// escondido, ouvia-se a ligadura («filter_alt_off») antes do título.
{
  const s = fs.readFileSync(path.join(ROOT, 'partials/_empty-state.handlebars'), 'utf8');
  const spans = [...s.matchAll(/<span class="material-symbols-outlined[^"]*"([^>]*)>/g)];
  assert.ok(spans.length >= 3, '_empty-state: tem os ícones dos três casos');
  for (const sp of spans) {
    assert.ok(/aria-hidden="true"/.test(sp[1]),
      '_empty-state: o ícone do estado vazio tem de ser decorativo');
    verificacoes += 1;
  }
}

// ── 6. Escalas de acessibilidade: os três valores continuam a existir ────
// O §14 inclui a escala tipográfica determinada pelo utilizador. Se alguém
// remover um dos passos (ou o atributo que o motor lê), a escala parte-se em
// silêncio — é o tipo de regressão que este teste apanha.
{
  const layout = fs.readFileSync(path.join(ROOT, 'layouts/main.handlebars'), 'utf8');
  // A escala é aplicada por JS antes do CSS (evita «flash» de texto no
  // tamanho errado). O contrato: o motor lê `data-font` e aceita exatamente
  // três valores, com `large` por omissão.
  assert.ok(/setAttribute\('data-font'/.test(layout),
    'layout: a escala é aplicada como atributo `data-font` na raiz');
  assert.ok(/'normal'/.test(layout) && /'xlarge'/.test(layout) && /'large'/.test(layout),
    'layout: o motor da escala conhece os três níveis (normal · large · xlarge)');
  verificacoes += 1;
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/styles.css'), 'utf8');
  const escalas = { normal: '1', large: '1.08', xlarge: '1.16' };
  for (const [escala, fator] of Object.entries(escalas)) {
    const re = new RegExp(
      `html\\[data-font="${escala}"\\]\\s*\\{\\s*--font-scale:\\s*${fator.replace('.', '\\.')}\\s*;`);
    assert.ok(re.test(css),
      `styles.css: a escala «${escala}» tem de definir --font-scale: ${fator}`);
    verificacoes += 1;
  }
  assert.ok(/font-size:\s*calc\(100%\s*\*\s*var\(--font-scale\)\)/.test(css),
    'styles.css: a raiz escala por --font-scale');
  verificacoes += 1;
  // E o preço da escala: um tamanho FIXO em px não acompanha. O `rem` sim,
  // porque o `font-size` da raiz já está escalado. Esta asserção liga o §14
  // à convenção que a cadeia impõe (test-tipografia.js).
  assert.ok(/\.estado\b[^}]*font-size:\s*var\(--font-size-xs\)/.test(css),
    'styles.css: o componente .estado usa uma variável de escala, não um px fixo');
  verificacoes += 1;
}

// ── Resultado ────────────────────────────────────────────────────────────
if (falhas.length) {
  console.error(`✗ A14 §14 — acessibilidade: ${falhas.length} falha(s)\n`);
  for (const f of falhas.slice(0, 40)) console.error('   ' + f);
  if (falhas.length > 40) console.error(`   … e mais ${falhas.length - 40}`);
  process.exit(1);
}
console.log(`✓ A14 §14 — acessibilidade: ${verificacoes} verificações passaram `
  + `(ícones: ${totalIcones}, controlos só-ícone: ${totalSoIcone}, sem BD)`);
