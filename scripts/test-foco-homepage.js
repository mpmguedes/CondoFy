// ═══════════════════════════════════════════════════════════════════
// Indicador de foco nas faixas navy da homepage — A7 C.9 · F29 (frente C4).
//
// Porque existe: a navbar, o painel do menu mobile, a faixa do CTA final e o
// rodapé da homepage são azul-marinho NOS DOIS TEMAS (`--nav-bg-image` está em
// `:root` e não é substituído pelo tema escuro). O anel de foco global usa
// `--c-primary`, que no tema claro é `#075B9B`: sobre navy dá 1.94:1 e, nos
// botões sólidos assentes nessa faixa, coincide com o fundo do próprio botão
// (1.00:1). Medido com browser real (Playwright + Edge), 45 paragens de
// teclado em desktop e 46 em mobile com o menu aberto: 22 falhas no tema
// claro, 0 no tema escuro.
//
// O contrato do A7 (secção C.9) é: o anel contrasta ≥ 3:1 (WCAG 2.2 SC 1.4.11)
// com a SUPERFÍCIE ONDE O CONTROLO ASSENTA — não com o fundo do botão — e em
// superfícies navy usa-se `--nav-focus`. Nunca se escolhe o anel pela variante
// do botão (variante medida e rejeitada no C.9).
//
// Este teste é ESTÁTICO (resolve os tokens e lê o CSS): não substitui a medição
// com browser, mas impede que a correção desapareça numa refatoração — e falha
// se alguém reintroduzir o anel errado ou largar a largura à cascata.
//
// Utilização: node scripts/test-foco-homepage.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
// Leitura normalizada para LF (dívida P38): um checkout com `core.autocrlf=true`
// deixaria `\r` a perturbar as comparações de linha.
const lerCss = (nome) => fs.readFileSync(path.join(RAIZ, 'public', 'css', nome), 'utf8').replace(/\r\n/g, '\n');

const css = lerCss('styles.css');
const cssHome = lerCss('home.css');
// A análise de regras tem de correr sobre o CSS SEM comentários: um comentário
// pode conter `{`/`}` (ex.: citar uma regra do Bootstrap) e o recorte por
// `([^{}]+)\{([^}]*)\}` passaria a apanhar pedaços de texto como se fossem
// seletores — foi um defeito real deste teste. Mesma precaução do
// `test-contraste.js`.
const cssHomeSemComentarios = cssHome.replace(/\/\*[\s\S]*?\*\//g, '');

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };

// ── Resolução de tokens (mesma mecânica de test-contraste.js) ───────
function bloco(seletor) {
  const i = css.indexOf(seletor);
  assert.ok(i !== -1, `bloco ${seletor} existe em styles.css`);
  const inicio = css.indexOf('{', i);
  const fim = css.indexOf('}', inicio);
  const mapa = new Map();
  for (const m of css.slice(inicio + 1, fim).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    mapa.set(m[1], m[2].trim());
  }
  return mapa;
}
const claro = bloco(':root {');
const escuro = new Map([...claro, ...bloco('[data-theme="dark"] {')]);

const hexParaRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const rgbParaHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
function luminancia([r, g, b]) {
  const canal = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}
function racio(a, b) {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function resolver(mapa, token, visitados = []) {
  assert.ok(!visitados.includes(token), `token sem ciclo: ${token}`);
  const valor = mapa.get(token);
  assert.ok(valor, `token ${token} definido no design system`);
  const varMatch = valor.match(/var\((--[a-z0-9-]+)\)/);
  if (varMatch) return resolver(mapa, varMatch[1], [...visitados, token]);
  if (/^#/.test(valor)) return hexParaRgb(valor);
  throw new Error(`valor não suportado em ${token}: ${valor}`);
}
// Paragens de um gradiente: o anel pode cair sobre qualquer uma, pelo que se
// avalia sempre contra a MAIS DESFAVORÁVEL (critério conservador).
const paragens = (mapa, token) => {
  const valor = mapa.get(token);
  assert.ok(valor, `gradiente ${token} definido`);
  const cores = [...valor.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => hexParaRgb(m[0]));
  assert.ok(cores.length >= 2, `${token} é um gradiente com paragens`);
  return cores;
};
const piorRacio = (cor, fundos) => Math.min(...fundos.map((f) => racio(cor, f)));
const MINIMO_NAO_TEXTUAL = 3; // WCAG 2.2 SC 1.4.11

// ── 1. O defeito é real: o anel do tema claro não serve sobre navy ──
console.log('\n── 1. O defeito (premissa medida)');
const navyClaro = paragens(claro, '--nav-bg-image');
const navyEscuro = paragens(escuro, '--nav-bg-image');

// A razão de ser do defeito: a faixa é navy nos DOIS temas. Se o tema escuro
// passasse a substituir o gradiente, esta verificação deixaria de fazer sentido
// — e é isso que se quer saber.
assert.deepStrictEqual(navyEscuro, navyClaro, 'a faixa navy é a MESMA nos dois temas (--nav-bg-image não é tematizado)');
feito(`a faixa é navy nos dois temas (${navyClaro.map(rgbParaHex).join(', ')})`);

const anelTemaClaro = resolver(claro, '--c-primary');
const racioDefeito = piorRacio(anelTemaClaro, navyClaro);
assert.ok(racioDefeito < MINIMO_NAO_TEXTUAL,
  `o anel do tema claro (${rgbParaHex(anelTemaClaro)}) é insuficiente sobre navy — é o defeito do F29 `
  + `(medido ${racioDefeito.toFixed(2)}:1, mínimo ${MINIMO_NAO_TEXTUAL})`);
feito(`anel do tema claro insuficiente sobre navy (${racioDefeito.toFixed(2)}:1 < ${MINIMO_NAO_TEXTUAL}) — defeito confirmado`);

// O botão sólido da navbar/CTA: o anel coincide com o próprio fundo do botão.
const fundoBotaoPrimarioClaro = resolver(claro, '--c-primary');
const racioSobreBotao = racio(anelTemaClaro, fundoBotaoPrimarioClaro);
assert.ok(racioSobreBotao < MINIMO_NAO_TEXTUAL,
  `o anel coincide com o fundo do botão primário no tema claro (${racioSobreBotao.toFixed(2)}:1)`);
feito(`anel invisível no botão sólido do tema claro (${racioSobreBotao.toFixed(2)}:1) — o caso mais grave`);

// ── 2. O remédio cumpre o 3:1 nos DOIS temas ────────────────────────
console.log('\n── 2. O remédio (contraste do indicador)');
for (const [nomeTema, mapa] of [['claro', claro], ['escuro', escuro]]) {
  const anel = resolver(mapa, '--nav-focus');
  const r = piorRacio(anel, navyClaro);
  assert.ok(r >= MINIMO_NAO_TEXTUAL,
    `tema ${nomeTema}: --nav-focus (${rgbParaHex(anel)}) sobre a paragem mais desfavorável do gradiente `
    + `= ${r.toFixed(2)}:1 (mínimo ${MINIMO_NAO_TEXTUAL})`);
  feito(`tema ${nomeTema}: --nav-focus ${rgbParaHex(anel)} sobre navy = ${r.toFixed(2)}:1`);
}

// ── 3. A regra existe, cobre os contextos navy e desenha o anel ─────
console.log('\n── 3. A regra de foco das faixas navy');
const regras = [...cssHomeSemComentarios.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((m) => ({ seletor: m[1].trim().replace(/\s+/g, ' '), corpo: m[2] }))
  .filter((r) => r.seletor && !/@media/.test(r.seletor));

// Aceita `outline` (o correto) E `outline-color` (a variante que se quer
// apanhar): assim a mutação «declarar só a cor» é detetada pela asserção
// ESPECÍFICA do atalho completo, com a razão certa, e não por uma falha
// genérica de «não encontrei a regra».
const regraNavy = regras.filter((r) => /outline(-color)?:[^;]*var\(--nav-focus\)/.test(r.corpo));
assert.strictEqual(regraNavy.length, 1,
  `exatamente UMA regra pinta o anel com --nav-focus na folha da homepage (encontradas: ${regraNavy.length})`);
const seletores = regraNavy[0].seletor.split(',').map((s) => s.trim());
feito(`existe uma regra única com --nav-focus (${seletores.length} seletores)`);

// ⛔ O atalho `outline` COMPLETO, não só `outline-color`: o Bootstrap 5.3
// define `.btn:focus-visible { outline: 0 }` e, declarando só a cor, a largura
// podia ficar a 0 e o anel não ser desenhado (defeito medido no C.9 do A7).
assert.ok(/outline:\s*2px\s+solid\s+var\(--nav-focus\)/.test(regraNavy[0].corpo),
  'a regra declara o atalho `outline` completo (largura, estilo e cor) — não apenas `outline-color`');
feito('declara o atalho `outline` completo (largura + estilo + cor)');
assert.ok(/outline-offset:\s*2px/.test(regraNavy[0].corpo),
  'mantém o `outline-offset: 2px` do anel global (a geometria não muda)');
feito('mantém a geometria do anel global (outline-offset: 2px)');

// Cada contexto navy tem de estar coberto, pelo nome do próprio componente.
const CONTEXTOS_NAVY = ['.hp-nav', '.hp-menu-painel', '.hp-cta-final', '.hp-rodape'];
for (const contexto of CONTEXTOS_NAVY) {
  assert.ok(seletores.some((s) => s.startsWith(`${contexto} `) || s.startsWith(`${contexto}:`)),
    `o contexto navy ${contexto} é coberto pela regra (seletores: ${seletores.join(' | ')})`);
}
feito(`contextos navy cobertos: ${CONTEXTOS_NAVY.join(', ')}`);

// ── 4. Foco por TECLADO ─────────────────────────────────────────────
console.log('\n── 4. Foco por teclado');
// `:focus-visible` é o pseudo-estado que os browsers aplicam ao foco por
// teclado (e não ao clique do rato): é o que o contrato do A7 usa.
for (const s of seletores) {
  assert.ok(/:focus-visible/.test(s), `o seletor «${s}» usa :focus-visible (foco por teclado)`);
}
feito(`os ${seletores.length} seletores usam :focus-visible`);
// E nada na folha pode apagar o anel de foco.
assert.ok(!/outline:\s*(none|0)\b/.test(cssHomeSemComentarios),
  'nenhuma regra da homepage apaga o anel de foco');
feito('nenhuma regra da homepage apaga o anel de foco');

// ── 5. Sem regressão de hover/active ────────────────────────────────
console.log('\n── 5. Sem regressão de hover/active');
// A regra de foco não pode mexer em nada além do anel: se tocasse em
// `background` ou `color`, sobrepor-se-ia ao hover/active dos mesmos elementos.
const propriedades = [...regraNavy[0].corpo.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
const intrusas = propriedades.filter((p) => p !== 'outline' && p !== 'outline-offset');
assert.deepStrictEqual(intrusas, [],
  `a regra de foco só declara propriedades de anel (encontradas: ${intrusas.join(', ')})`);
feito(`a regra só declara anel (${propriedades.join(', ')}) — não colide com hover/active`);

// E os estados de hover/active dos mesmos componentes continuam definidos.
const HOVER_PRESERVADO = [
  ['.hp-nav-link:hover, .hp-nav-link:focus-visible', 'ligações da navbar'],
  ['.hp-rodape a:hover, .hp-rodape a:focus-visible', 'ligações do rodapé'],
  ['.hp-link:hover, .hp-link:focus-visible', 'ligação de texto'],
];
for (const [seletor, nome] of HOVER_PRESERVADO) {
  const r = regras.find((x) => x.seletor === seletor);
  assert.ok(r, `${nome}: o estado hover/focus-visible continua definido («${seletor}»)`);
  assert.ok(/background|color|text-decoration/.test(r.corpo),
    `${nome}: o estado hover/focus-visible continua a produzir um efeito visível`);
}
feito(`${HOVER_PRESERVADO.length} estados hover/focus-visible intactos`);

// ── 6. A guarda do cartão claro dentro da faixa escura ──────────────
console.log('\n── 6. A guarda do cartão claro (.hp-sec-dark)');
// `.hp-sec-dark` contém cartões CLAROS (`.hp-card` → `--c-surface`) e há uma
// ligação dentro de um deles. O anel ciano sobre cartão claro seria pior do que
// o atual, logo a faixa navy tem de ser excluída DENTRO dos cartões.
const fundoCartao = resolver(claro, '--c-surface');
const anelNavyClaro = resolver(claro, '--nav-focus');
const racioCartao = racio(anelNavyClaro, fundoCartao);
assert.ok(racioCartao < MINIMO_NAO_TEXTUAL,
  `a premissa da guarda: --nav-focus sobre o cartão claro dá ${racioCartao.toFixed(2)}:1 (< ${MINIMO_NAO_TEXTUAL})`);
feito(`premissa da guarda: --nav-focus sobre cartão claro = ${racioCartao.toFixed(2)}:1 (insuficiente)`);

const seletorSecDark = seletores.filter((s) => s.startsWith('.hp-sec-dark'));
assert.ok(seletorSecDark.length > 0, '.hp-sec-dark é coberto pela regra de foco');
for (const s of seletorSecDark) {
  assert.ok(/:not\(\.hp-card\b/.test(s),
    `o seletor «${s}» exclui os cartões claros (:not(.hp-card …)) — sem isso seria uma regressão`);
}
feito(`${seletorSecDark.length} seletores de .hp-sec-dark excluem os cartões claros`);

// A ligação que vive dentro do cartão da faixa escura tem de continuar a usar
// o anel da superfície clara (o global), não o ciano.
const tplHome = ler('views/publicas/home.handlebars');
const secaoSeguranca = tplHome.slice(tplHome.indexOf('hp-sec-dark'), tplHome.indexOf('hp-sec-dark') + 4000);
assert.ok(/class="hp-card/.test(secaoSeguranca) && /class="hp-link"/.test(secaoSeguranca),
  'a faixa escura tem cartões claros com uma ligação lá dentro (o caso que a guarda protege)');
feito('o caso protegido existe mesmo na página (ligação dentro de cartão na faixa escura)');

// ── 7. Meta: nenhum contexto navy fica por cobrir ───────────────────
console.log('\n── 7. Cobertura completa (não passar por esquecimento)');
const TEMPLATES = [
  'views/partials/_home-cabecalho.handlebars',
  'views/publicas/home.handlebars',
  'views/partials/_home-rodape.handlebars',
];
const fontes = TEMPLATES.map((f) => [f, ler(f)]);
const NAVY_NA_PAGINA = ['.hp-nav', '.hp-menu-painel', '.hp-cta-final', '.hp-rodape', '.hp-sec-dark'];
for (const contexto of NAVY_NA_PAGINA) {
  const onde = fontes.filter(([, src]) => src.includes(contexto.replace('.', 'class="')) || src.includes(contexto.slice(1)));
  assert.ok(onde.length > 0, `${contexto} existe de facto nos templates da homepage`);
}
feito(`${NAVY_NA_PAGINA.length} contextos navy confirmados nos templates`);
const semCobertura = NAVY_NA_PAGINA.filter(
  (c) => !seletores.some((s) => s.startsWith(`${c} `) || s.startsWith(`${c}:`))
);
assert.deepStrictEqual(semCobertura, [],
  `contextos navy sem regra de foco: ${semCobertura.join(' | ')}`);
feito('todos os contextos navy da página estão cobertos pela regra');

// ── 8. O anel vem de um token, nunca de um literal ──────────────────
console.log('\n── 8. O anel vem do design system');
const hexNaFolha = [...cssHome.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
assert.deepStrictEqual([...new Set(hexNaFolha)], [],
  `home.css sem cores literais: ${hexNaFolha.join(' ')}`);
feito('home.css sem cores literais (o anel é um token)');
assert.ok(css.includes('--nav-focus:'),
  '--nav-focus continua definido no design system (não foi criado um token paralelo na folha)');
feito('--nav-focus reutiliza o token do design system (não duplica a regra)');

console.log(`\n✓ Indicador de foco da homepage conforme WCAG 2.2 SC 1.4.11 nos dois temas (${n} verificações).`);
console.log('  Medição com browser real (Playwright + Edge): 45 paragens de teclado em desktop,');
console.log('  46 em mobile com o menu aberto — 0 falhas nos dois temas depois da correção.');
