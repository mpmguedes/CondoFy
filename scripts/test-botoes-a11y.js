// ═══════════════════════════════════════════════════════════════════
// Botões e acessibilidade (frente A7) — contrato único, estado desativado,
// anel de foco, contratos de tamanho e nome acessível dos controlos.
//
// Sem rede e sem BD: lê `public/css/styles.css`, as vistas e `public/js/app.js`.
//
// Porque existe: a auditoria de UI encontrou três blocos CSS concorrentes a
// definir os MESMOS botões (a cascata decidia por ordem de aparição), um estado
// desativado herdado do Bootstrap que atenuava por `opacity` (o texto e o fundo
// diluíam-se um contra o outro e o contraste caía abaixo de AA) e 54 controlos
// só-ícone sem nome acessível. Nada disto é visível a olho: mede-se.
//
//   · estado desativado ....... texto >= 4.5:1, atenuado por COR e não por
//                               opacidade do elemento
//   · anel de foco ............ >= 3:1 contra a superfície onde o botão assenta
//   · botões ativos ........... continuam >= 4.5:1 (não regridem)
//   · controlos só-ícone ...... têm sempre `aria-label`
//   · ícone decorativo ........ `aria-hidden` quando o controlo já tem texto
//
// Utilização: node scripts/test-botoes-a11y.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
// Leitura normalizada para LF: o clone pode ter CRLF (dívida P38) e a análise
// de regras casa seletores linha a linha.
const css = ler('public/css/styles.css').replace(/\r\n/g, '\n');

// ── Tokens do design system ─────────────────────────────────────────
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

// ── Contraste (WCAG 2.1) ────────────────────────────────────────────
const hexParaRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
function luminancia([r, g, b]) {
  const canal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}
function racio(a, b) {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function resolver(mapa, token) {
  const valor = mapa.get(token);
  assert.ok(valor, `token ${token} definido no design system`);
  const varMatch = valor.match(/var\((--[a-z0-9-]+)\)/);
  if (varMatch) return resolver(mapa, varMatch[1]);
  if (/^#/.test(valor)) return hexParaRgb(valor);
  throw new Error(`valor de cor não suportado em ${token}: ${valor}`);
}
// Valor de uma cor escrita numa regra: `var(--token)` ou `#hex`.
function corNaRegra(mapa, valor) {
  const v = valor.trim();
  const varMatch = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (varMatch) return resolver(mapa, varMatch[1]);
  if (/^#/.test(v)) return hexParaRgb(v);
  throw new Error(`cor não suportada na regra: ${valor}`);
}

// ── Regras CSS: contexto real (o `@media` fecha onde fecha) ─────────
// Um `awk` que guarda o último `@media` visto mente: estas regras estão em
// blocos de topo e a cascata depende disso. Remove-se o `@media` por emparelha-
// mento de chavetas, para contar só as definições globais.
function semMedia(texto) {
  let saida = '';
  let i = 0;
  while (i < texto.length) {
    const j = texto.indexOf('@media', i);
    if (j === -1) { saida += texto.slice(i); break; }
    saida += texto.slice(i, j);
    const abre = texto.indexOf('{', j);
    if (abre === -1) { saida += texto.slice(j); break; }
    let profundidade = 1;
    let p = abre + 1;
    while (p < texto.length && profundidade > 0) {
      if (texto[p] === '{') profundidade += 1;
      else if (texto[p] === '}') profundidade -= 1;
      p += 1;
    }
    i = p;
  }
  return saida;
}
const global = semMedia(css.replace(/\/\*[\s\S]*?\*\//g, ''));

// Regras de topo. Uma regra pode ter VÁRIOS seletores — o estado desativado é
// `.btn:disabled, .btn.disabled, fieldset:disabled .btn` —, pelo que comparar
// a linha inteira falharia precisamente nas regras que interessam. Compara-se
// por elemento da lista de seletores.
const regras = [...global.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ seletor: m[1].trim().replace(/\s+/g, ' '), corpo: m[2] }))
  .filter((r) => r.seletor.length > 0);
const partes = (r) => r.seletor.split(',').map((s) => s.trim());
const regrasCom = (seletor) => regras.filter((r) => partes(r).includes(seletor));
const ocorrencias = (seletor) => regrasCom(seletor).length;
function corpoDe(seletor) {
  const encontradas = regrasCom(seletor);
  assert.ok(encontradas.length >= 1, `regra ${seletor} existe`);
  return encontradas.map((r) => r.corpo).join('\n');
}
function declaracao(corpo, prop) {
  const m = corpo.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };
const medir = (nome, a, b, minimo) => {
  const r = racio(a, b);
  exigir(r >= minimo, `${nome}: ${r.toFixed(2)}:1 (mínimo ${minimo})`);
  console.log(`${r >= minimo ? 'OK   ' : 'FALHA'} ${r.toFixed(2).padStart(6)}:1 (mín ${minimo}) ${nome}`);
  return r;
};

// ═══════════════════════════════════════════════════════════════════
// FASE 1 — contrato único: cada seletor de botão definido UMA só vez
// ═══════════════════════════════════════════════════════════════════
console.log('\n── FASE 1: contrato único (uma definição global por seletor) ──');
const SELETORES = [
  '.btn', '.btn-sm', '.btn-lg', '.btn-primary', '.btn-outline-primary',
  '.btn-outline-secondary', '.btn-outline-danger', '.btn-success', '.btn-outline-light',
  '.btn:disabled',
];
for (const s of SELETORES) {
  const n = ocorrencias(s);
  exigir(n === 1, `${s}: ${n} definições globais (esperado 1)`);
  console.log(`${n === 1 ? 'OK   ' : 'FALHA'} ${String(n).padStart(2)}× ${s}`);
}
// O contrato tem de cobrir as três formas de "desativado" que o produto usa.
for (const forma of ['.btn.disabled', 'fieldset:disabled .btn']) {
  const n = ocorrencias(forma);
  exigir(n === 1, `o contrato desativado cobre ${forma} (${n} definições)`);
}
console.log('OK   contrato desativado cobre .btn:disabled, .btn.disabled e fieldset:disabled .btn');

// As regras responsivas continuam a existir (não se perdeu o comportamento).
const btnSmTotal = (css.match(/^\s*\.btn-sm\s*[,{]/gm) || []).length;
exigir(btnSmTotal >= 2, `.btn-sm responsivo mantido (${btnSmTotal} definições no ficheiro)`);
console.log(`OK   .btn-sm mantém a variante responsiva (${btnSmTotal} definições no ficheiro)`);

// ═══════════════════════════════════════════════════════════════════
// FASE 3 — estado desativado: atenuado pela COR, nunca por opacidade
// ═══════════════════════════════════════════════════════════════════
console.log('\n── FASE 3: estado desativado ──');
const corpoDesativado = corpoDe('.btn:disabled');
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  for (const t of ['--c-disabled-bg', '--c-disabled-text', '--c-disabled-border']) {
    exigir(mapa.has(t), `${nome}: token ${t} definido`);
  }
  console.log(`OK   ${nome}: tokens do estado desativado definidos`);
}
exigir(/opacity:\s*1\b/.test(corpoDesativado), 'o estado desativado repõe opacity: 1');
exigir(!/opacity:\s*0?\.\d/.test(corpoDesativado), 'o estado desativado não usa opacidade fracionária');
console.log('OK   .btn:disabled fixa opacity: 1 (atenua pela cor)');
for (const prop of ['background', 'color', 'border-color']) {
  exigir(new RegExp(`${prop}\\s*:\\s*var\\(--c-disabled`).test(corpoDesativado),
    `o estado desativado define ${prop} por token`);
}
console.log('OK   fundo, texto e contorno do estado desativado vêm de tokens');

// Nenhuma regra de botão pode voltar a atenuar por opacidade fracionária
// (`.btn-close` é o X do Bootstrap, não um botão do produto).
const opacidadeFraca = regras.filter((r) => /opacity:\s*0?\.\d/.test(r.corpo)
  && r.seletor.split(',').some((s) => /^\.btn(\b|[-.:])/.test(s.trim()) && !s.trim().startsWith('.btn-close')));
assert.deepStrictEqual(opacidadeFraca.map((r) => r.seletor), [],
  `botões atenuados por opacity (a diluir texto e fundo): ${opacidadeFraca.map((r) => r.seletor).join(' | ')}`);
console.log('OK   nenhuma regra de botão usa opacity fracionária');

// O contraste do texto desativado tem de passar AA nos DOIS temas.
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  medir(`desativado (${nome}): --c-disabled-text sobre --c-disabled-bg`,
    resolver(mapa, '--c-disabled-text'), resolver(mapa, '--c-disabled-bg'), 4.5);
}
// O estado desativado tem de se distinguir do ativo. Não basta «não ser igual»:
// tem de ser PERCEPTIVELMENTE diferente. Mede-se o passo de luminância relativa
// entre o fundo desativado e a superfície onde o botão ativo assenta (o tema
// claro tem 0.145). Um valor colado à superfície torna o estado desativado
// indistinguível do ativo — medido em 0.012 no tema escuro antes desta correção.
const PASSO_MINIMO = 0.05;
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  const fundo = resolver(mapa, '--c-disabled-bg');
  const superficie = resolver(mapa, '--c-surface');
  exigir(fundo.join() !== resolver(mapa, '--c-primary').join(), `${nome}: o fundo desativado não é a cor primária`);
  const passo = Math.abs(luminancia(fundo) - luminancia(superficie));
  exigir(passo >= PASSO_MINIMO,
    `${nome}: o fundo desativado distingue-se do ativo (passo de luminância ${passo.toFixed(4)} < ${PASSO_MINIMO})`);
  console.log(`OK   ${nome}: passo de luminância desativado↔ativo = ${passo.toFixed(4)} (mínimo ${PASSO_MINIMO})`);
}

// Uma ligação com aspeto de botão continua a navegar: a inatividade é
// funcional e tem de cortar os eventos de ponteiro.
exigir(/a\.btn\.disabled[^{]*\{[^}]*pointer-events:\s*none/.test(global),
  'a.btn.disabled corta os eventos de ponteiro (não navega)');
console.log('OK   a.btn.disabled não navega (pointer-events: none)');

// ═══════════════════════════════════════════════════════════════════
// FASE 3B — anel de foco visível sobre a superfície onde o botão assenta
// ═══════════════════════════════════════════════════════════════════
console.log('\n── FASE 3B: anel de foco ──');
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  exigir(mapa.has('--c-focus-ring'), `${nome}: token --c-focus-ring definido`);
}
console.log('OK   token do anel de foco definido nos dois temas');
const corpoFocoBtn = corpoDe('.btn:focus-visible');
// ⛔ O anel tem de ser DESENHADO, não só colorido. O Bootstrap 5.3 define
// `.btn:focus-visible { outline: 0 }` com a MESMA especificidade (0,2,0) e é
// carregado antes desta folha: declarar só `outline-color` deixa a largura a 0
// e o anel não aparece. Medido no browser: `outline-width: 0px; outline-style:
// none` — uma declaração decorativa que o teste tem de recusar.
exigir(/outline:\s*2px solid var\(--c-focus-ring\)/.test(corpoFocoBtn),
  '.btn:focus-visible desenha o anel com o atalho `outline` COMPLETO (largura + estilo + token), '
  + 'e não apenas outline-color');
console.log('OK   .btn:focus-visible desenha o anel (atalho `outline` completo)');
exigir(/outline-color:\s*var\(--nav-focus\)/.test(corpoDe('.btn-outline-light:focus-visible')),
  '.btn-outline-light:focus-visible usa o anel da navegação sobre a topbar navy');
exigir(/outline:\s*2px solid var\(--nav-focus\)/.test(corpoDe('.icon-btn:focus-visible')),
  '.icon-btn:focus-visible usa o anel claro da navegação (a bolinha vive no topo navy)');
console.log('OK   .btn-outline-light e .icon-btn têm anel de foco próprio (superfícies navy)');
// O indicador global de foco não pode desaparecer.
const focoGlobal = global.match(/:focus-visible\s*\{([^}]*)\}/);
assert.ok(focoGlobal, 'existe a regra global de :focus-visible');
exigir(/outline:\s*2px solid/.test(focoGlobal[1]), 'o anel de foco global mantém-se (não foi removido)');
console.log('OK   o indicador de foco global mantém-se');

// O anel é desenhado FORA da caixa (outline-offset 2px): a referência de
// contraste é a superfície, não a cor do próprio botão.
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  const anel = resolver(mapa, '--c-focus-ring');
  medir(`anel (${nome}) sobre a página (--c-bg)`, anel, resolver(mapa, '--c-bg'), 3);
  medir(`anel (${nome}) sobre o cartão (--c-surface)`, anel, resolver(mapa, '--c-surface'), 3);
}
// Superfícies navy (topbar/rodapé): o anel da navegação tem de ser visível
// contra todas as paragens do gradiente.
const paragens = [...(claro.get('--nav-bg-image') || '').matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => hexParaRgb(m[0]));
assert.ok(paragens.length >= 2, 'o gradiente da navegação tem paragens identificáveis');
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  const anel = resolver(mapa, '--nav-focus');
  for (const paragem of paragens) {
    medir(`anel da navegação (${nome}) sobre ${'#' + paragem.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
      anel, paragem, 3);
  }
}

// Os NÚMEROS escritos no comentário de cada token de anel têm de conferir com a
// medição. Um número documentado errado é uma afirmação, não uma prova — e
// envelhece em silêncio quando a cor muda. (Foi o que aconteceu: o comentário
// do anel claro dizia 14,98:1 quando a medição dá 15,29:1.)
const corteEscuro = css.indexOf('[data-theme="dark"]');
for (const [nome, mapa, trecho] of [
  ['claro', claro, css.slice(0, corteEscuro)],
  ['escuro', escuro, css.slice(corteEscuro)],
]) {
  const m = trecho.match(/--c-focus-ring:\s*#[0-9A-Fa-f]{6};\s*\/\*\s*(\d+),(\d+):1/);
  exigir(m, `o token do anel (${nome}) tem o número medido escrito no comentário`);
  if (!m) continue;
  const dito = Number(`${m[1]}.${m[2]}`);
  const real = racio(resolver(mapa, '--c-focus-ring'), resolver(mapa, '--c-bg'));
  exigir(Math.abs(dito - real) <= 0.005,
    `o comentário do anel (${nome}) diz ${dito}:1 mas a medição dá ${real.toFixed(2)}:1`);
  console.log(`OK   número do comentário do anel (${nome}) confere: ${dito}:1 = medido ${real.toFixed(2)}:1`);
}

// ═══════════════════════════════════════════════════════════════════
// Não-regressão: os botões ATIVOS continuam legíveis
// ═══════════════════════════════════════════════════════════════════
console.log('\n── Não-regressão: botões ativos (>= 4.5:1) ──');
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  const secundario = corpoDe('.btn-outline-secondary');
  medir(`.btn-outline-secondary ativo (${nome})`,
    corNaRegra(mapa, declaracao(secundario, 'color')),
    corNaRegra(mapa, declaracao(secundario, 'background')), 4.5);

  const primario = corpoDe('.btn-primary');
  medir(`.btn-primary ativo (${nome})`,
    corNaRegra(mapa, declaracao(primario, 'color')),
    corNaRegra(mapa, declaracao(primario, 'background')), 4.5);

  // Dívida registada (fora do âmbito desta fase): `.btn-outline-danger` ativo
  // fica em 4.22:1 no tema claro. Fica com um PISO, para uma troca de token
  // não passar em claro; corrigi-lo é uma frente de cores semânticas.
  const perigo = corpoDe('.btn-outline-danger');
  medir(`.btn-outline-danger ativo (${nome}) [dívida registada]`,
    corNaRegra(mapa, declaracao(perigo, 'color')),
    corNaRegra(mapa, declaracao(perigo, 'background')), 4.0);
}

// ═══════════════════════════════════════════════════════════════════
// FASE 4 — contratos de tamanho DECLARADOS **e APLICADOS**
// ═══════════════════════════════════════════════════════════════════
// ⛔ O que faltava: os tokens estavam declarados e fixados por teste, mas
// NENHUM componente os usava (medido no browser: `.btn` = 33,1px, não 36px).
// Um teste que só verifique a DECLARAÇÃO do token é um falso verde: o contrato
// tem de estar ligado ao componente.
console.log('\n── FASE 4: contratos de tamanho ──');
for (const [token, valor] of [['--ctl-h-sm', '32px'], ['--ctl-h', '36px'], ['--ctl-h-lg', '44px'], ['--ctl-h-touch', '48px']]) {
  exigir(claro.get(token) === valor, `${token} declarado com ${valor} (obtido: ${claro.get(token)})`);
  console.log(`OK   ${token} = ${valor}`);
}
// Resolve `var(--token)` para o valor declarado, para poder asserir a ligação.
function medidaDoToken(corpo, prop) {
  const v = declaracao(corpo, prop);
  if (v === null) return null;
  const m = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (!m) return v;
  const t = claro.get(m[1]);
  return t === undefined ? null : `var(${m[1]})`;
}
for (const [seletor, token, valor] of [
  ['.btn', '--ctl-h', '36px'],
  ['.btn-sm', '--ctl-h-sm', '32px'],
  ['.btn-lg', '--ctl-h-lg', '44px'],
  ['.portal-btn', '--ctl-h-touch', '48px'],
  ['.portal-atalho', '--ctl-h-touch', '48px'],
  ['.quick-action', '--ctl-h', '36px'],
]) {
  const ligado = medidaDoToken(corpoDe(seletor), 'min-height');
  exigir(ligado === `var(${token})`,
    `${seletor}: min-height tem de vir do token ${token} (obtido: ${ligado ?? 'nenhum'})`);
  exigir(claro.get(token) === valor, `${token} = ${valor}`);
  console.log(`OK   ${seletor} min-height = var(${token}) → ${valor}`);
}
// ⛔ `.btn` NÃO pode ter `height` fixa: tem `overflow: hidden` (ripple) e um
// rótulo que quebre linha seria TRUNCADO em silêncio. Medido no browser: um
// rótulo de 37 caracteres ocupa 51,7px. A altura é um PISO (`min-height`).
exigir(!/(?:^|;)\s*height\s*:/.test(corpoDe('.btn')),
  '.btn não pode fixar `height` (truncaria rótulos de duas linhas — usar min-height)');
console.log('OK   .btn usa min-height (um rótulo longo cresce em vez de ser truncado)');

// A caixa do ícone tem de ser fixa: sem isso o ícone (font-size escalado,
// 19,44px a 108%) inflaciona a linha do flex e o botão COM ícone fica mais alto
// do que o mesmo botão sem ícone (medido: 37,4px vs 36px; tabs 42,4 vs 40px).
for (const seletor of [
  '.btn .material-symbols-outlined',
  '.btn-sm .material-symbols-outlined',
  '.btn-lg .material-symbols-outlined',
  '.quotas-tab .material-symbols-outlined',
]) {
  const corpo = corpoDe(seletor);
  exigir(/height:\s*18px/.test(corpo), `${seletor}: caixa fixa de 18px (não infla a altura do controlo)`);
  exigir(/font-size:\s*calc\(\d+px \* var\(--font-scale\)\)/.test(corpo),
    `${seletor}: o glifo escala com --font-scale`);
}
console.log('OK   a caixa do ícone é fixa (18px) e o glifo escala — a altura não é inflacionada');
// O gap ícone↔texto é 6px: o `me-1` do markup somava-se ao `gap` (10px).
exigir(/gap:\s*6px/.test(corpoDe('.btn')), '.btn: gap ícone-texto de 6px');
exigir(/margin-right:\s*0\s*!important/.test(corpoDe('.btn > .material-symbols-outlined')),
  'a margem do ícone dentro do .btn é neutralizada (o me-1 não se soma ao gap)');
console.log('OK   gap ícone↔texto de 6px (o me-1 do markup deixou de se somar)');

// As "bolinhas" continuam redondas e do tamanho aprovado, no desktop e no telemóvel.
const bolinha = corpoDe('.icon-btn');
exigir(declaracao(bolinha, 'width') === '40px', '.icon-btn mantém 40px de largura');
exigir(declaracao(bolinha, 'height') === '40px', '.icon-btn mantém 40px de altura');
exigir(declaracao(bolinha, 'border-radius') === '50%', '.icon-btn mantém-se circular (não vira retângulo)');
console.log('OK   .icon-btn circular 40x40 preservada');
exigir((css.match(/\.icon-btn\s*\{\s*width:\s*44px;\s*height:\s*44px/g) || []).length >= 2,
  '.icon-btn mantém 44x44 nos contextos de toque (telemóvel)');
console.log('OK   .icon-btn 44x44 nos contextos de toque');
// Componentes com requisitos próprios: geometria própria preservada.
exigir(/line-height:\s*1\.5/.test(corpoDe('.mes-btn')),
  'o .mes-btn preserva o ritmo vertical próprio (o line-height do contrato .btn encurtava-o)');
console.log('OK   .mes-btn preserva a geometria própria (cartão de duas linhas)');

// ═══════════════════════════════════════════════════════════════════
// FASE 5 — tabs: bloco único, estado ativo pelo contrato, aria-current
// ═══════════════════════════════════════════════════════════════════
console.log('\n── FASE 5: tabs ──');
const FAMILIAS_TAB = ['.quotas-tab', '.assembleias-tab', '.config-tab', '.fracoes-tab'];
for (const f of FAMILIAS_TAB) {
  const n = ocorrencias(f);
  exigir(n === 1, `${f}: ${n} definições globais (esperado 1 — bloco único com seletores agrupados)`);
  console.log(`${n === 1 ? 'OK   ' : 'FALHA'} ${String(n).padStart(2)}× ${f}`);
}
// ⛔ O 4.º sistema (Bootstrap) foi eliminado: era o único com raio 0, padding 16px
// e SEM ícone. Uma regra `.nav-tabs` que reste é a porta para a divergência voltar.
exigir(!/\.nav-tabs/.test(global), 'nenhuma regra .nav-tabs resta em styles.css (4.º sistema eliminado)');
exigir(ocorrencias('.nav-tabs .nav-link') === 0, 'nenhuma regra .nav-tabs .nav-link resta');
console.log('OK   o sistema Bootstrap .nav-tabs/.nav-link foi eliminado do CSS');

const itemTab = corpoDe('.quotas-tab');
exigir(/padding:\s*10px 14px/.test(itemTab), 'as tabs partilham um padding único (10px 14px)');
exigir(/border-radius:\s*var\(--radius-sm\) var\(--radius-sm\) 0 0/.test(itemTab),
  'as tabs partilham o raio 8px 8px 0 0');
console.log('OK   geometria única das tabs (padding 10px 14px, raio 8px 8px 0 0)');
// O alvo tátil de 48px aplicava-se SÓ a `.quotas-tab`; passa às QUATRO famílias.
exigir(/\.quotas-tab, \.assembleias-tab, \.config-tab, \.fracoes-tab \{ min-height: var\(--ctl-h-touch\)/.test(css),
  'o alvo tátil de 48px aplica-se às QUATRO famílias de tabs em telemóvel');
console.log('OK   alvo tátil de 48px nas quatro famílias de tabs (antes só em .quotas-tab)');

// Estado ativo: fundo primário + texto `--c-on-primary` — a linguagem do
// `.btn-primary`. ⛔ Nunca branco hardcoded: no tema escuro `--c-on-primary` é
// `#06213F` e impor `#FFF` baixaria o contraste de 8,77:1 para ~1,5:1.
for (const f of FAMILIAS_TAB) {
  const ativo = corpoDe(`${f}.active`);
  exigir(/background:\s*var\(--c-primary\)/.test(ativo), `${f}.active: fundo var(--c-primary)`);
  exigir(/color:\s*var\(--c-on-primary\)/.test(ativo), `${f}.active: texto var(--c-on-primary)`);
  exigir(!/#fff|#ffffff|:\s*white/i.test(ativo), `${f}.active: nunca branco hardcoded`);
}
console.log('OK   estado ativo das tabs pelo contrato (fundo primário + texto on-primary)');
for (const [nome, mapa] of [['claro', claro], ['escuro', escuro]]) {
  medir(`tab ativa (${nome}): --c-on-primary sobre --c-primary`,
    resolver(mapa, '--c-on-primary'), resolver(mapa, '--c-primary'), 4.5);
}

// As tabs vivem em `<a href>` (URLs preservados) e em `<button>` (fracoes):
// em nenhum caso o estado ativo pode depender só da cor.
const TABS_PARCIAIS = ['_quotas-tabs', '_assembleias-tabs', '_config-tabs', '_condomino-quotas-tabs'];
for (const p of TABS_PARCIAIS) {
  const src = ler(`views/partials/${p}.handlebars`);
  const abas = (src.match(/<a class="/g) || []).length;
  const current = (src.match(/aria-current="page"\{\{\/if\}\}/g) || []).length;
  exigir(abas > 0, `${p}: tem abas`);
  exigir(current >= abas, `${p}: ${current} aria-current para ${abas} abas (o estado ativo é invisível para leitores de ecrã)`);
  console.log(`OK   ${p}: ${current}/${abas} abas com aria-current="page"`);
}
// A vista migrada: sem as classes Bootstrap, com a linguagem única, e com os
// atributos de que o JS do Bootstrap precisa (senão as tabs deixam de trocar).
const vistaFracoes = ler('views/admin/fracoes/detalhe.handlebars');
exigir(!/class="nav nav-tabs"/.test(vistaFracoes), 'fracoes/detalhe já não usa a classe Bootstrap .nav-tabs');
exigir(!/class="nav-link/.test(vistaFracoes), 'fracoes/detalhe já não usa a classe Bootstrap .nav-link');
exigir(/class="fracoes-tabs"/.test(vistaFracoes), 'fracoes/detalhe usa a linguagem única (.fracoes-tabs)');
exigir(/data-bs-toggle="tab"/.test(vistaFracoes), 'os gatilhos data-bs-toggle mantêm-se (o JS das tabs funciona)');
exigir(/role="tab"/.test(vistaFracoes), 'os gatilhos mantêm role="tab" (o Tab do Bootstrap procura por ele)');
exigir((vistaFracoes.match(/material-symbols-outlined/g) || []).length >= 6,
  'as tabs de fracoes passaram a ter ícone (o sistema antigo não tinha)');
console.log('OK   fracoes/detalhe migrada para a linguagem única, com os gatilhos do Bootstrap intactos');

// ── F14 / F15 — blocos duplicados consolidados, com o VENCEDOR preservado ──
// ⛔ Consolidar não é escolher o primeiro bloco: é preservar o resultado
// CALCULADO (o último da cascata). O `.page-heading` dizia `--sp-5` (24px) no
// primeiro bloco e o valor efetivo era 14px, do segundo — uma divergência
// silenciosa entre o ficheiro e o que se via.
for (const seletor of ['.page-heading', '.page-heading h1', '.page-heading .subtitle', '.card-header']) {
  const n = ocorrencias(seletor);
  exigir(n === 1, `${seletor}: ${n} definições globais (esperado 1)`);
  console.log(`${n === 1 ? 'OK   ' : 'FALHA'} ${String(n).padStart(2)}× ${seletor}`);
}
exigir(declaracao(corpoDe('.page-heading'), 'margin-bottom') === '14px',
  'o .page-heading preserva o margin-bottom EFETIVO (14px), não os --sp-5 do bloco perdedor');
console.log('OK   .page-heading preserva o valor efetivo (14px), não o do bloco perdedor');
const corpoCardHeader = corpoDe('.card-header');
for (const [prop, esperado] of [
  ['background', 'var(--c-surface)'],
  ['color', 'var(--c-text)'],
  ['font-weight', '600'],
  ['padding', '8px 14px'],
  ['border-radius', 'var(--radius) var(--radius) 0 0 !important'],
]) {
  exigir(declaracao(corpoCardHeader, prop) === esperado,
    `.card-header: ${prop} devia ser ${esperado} (vencedor da cascata)`);
}
console.log('OK   .card-header consolidado preserva o vencedor de cada propriedade');

// ═══════════════════════════════════════════════════════════════════
// FASE 6 — F27 (.mes-btn desativado) e F28 (.quick-action canónico)
// ═══════════════════════════════════════════════════════════════════
console.log('\n── FASE 6: F27 e F28 ──');
const mesDesativado = corpoDe('.mes-btn:disabled');
exigir(/opacity:\s*1\b/.test(mesDesativado), '.mes-btn desativado repõe opacity: 1 (F27)');
exigir(!/opacity:\s*0?\.\d/.test(mesDesativado), '.mes-btn desativado não usa opacidade fracionária');
for (const prop of ['background', 'border-color']) {
  exigir(new RegExp(`${prop}\\s*:\\s*var\\(--c-disabled`).test(mesDesativado),
    `.mes-btn desativado define ${prop} por token (F27)`);
}
// As linhas internas têm cor PRÓPRIA e venceriam a cascata do elemento pai.
for (const linha of ['.mes-btn-mes', '.mes-btn-valor']) {
  exigir(new RegExp(`color:\\s*var\\(--c-disabled-text\\)`).test(corpoDe(`.mes-btn:disabled ${linha}`)),
    `${linha} desativado recebe --c-disabled-text (tem cor própria e vencia o pai)`);
}
console.log('OK   F27 — .mes-btn desativado por COR (tokens), com as linhas internas cobertas');
// Nenhuma regra de controlo pode voltar a atenuar por opacidade fracionária.
const fraca = regras.filter((r) => /opacity:\s*0?\.\d/.test(r.corpo)
  && r.seletor.split(',').some((s) => /^\.(btn|mes-btn)(\b|[-.:])/.test(s.trim())
    && !s.trim().startsWith('.btn-close')));
assert.deepStrictEqual(fraca.map((r) => r.seletor), [],
  `controlos atenuados por opacity (a diluir texto e fundo): ${fraca.map((r) => r.seletor).join(' | ')}`);
console.log('OK   nenhuma regra de botão ou .mes-btn usa opacity fracionária');

// F28 — `.quick-action` tinha 3 definições (mais uma no @media) e a cascata
// decidia por ordem de aparição.
exigir(ocorrencias('.quick-action') === 1,
  `.quick-action: ${ocorrencias('.quick-action')} definições globais (esperado 1 — canónica)`);
console.log('OK   F28 — .quick-action com uma só definição');
// A hierarquia intencional face ao `.btn` mantém-se (peso 400, não 500).
exigir(declaracao(corpoDe('.quick-action'), 'font-weight') === '400',
  '.quick-action mantém font-weight: 400 (hierarquia intencional face ao .btn)');
console.log('OK   .quick-action mantém o peso 400 (hierarquia face ao .btn preservada)');


// ═══════════════════════════════════════════════════════════════════
// FASE 2 — nome acessível dos controlos e ícones decorativos
// ═══════════════════════════════════════════════════════════════════
console.log('\n── FASE 2: acessibilidade das vistas ──');
const vistas = [];
(function percorrer(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) percorrer(p);
    else if (/\.handlebars$/.test(e.name)) vistas.push(p);
  }
})(path.join(RAIZ, 'views'));

const textoVisivel = (html) =>
  html
    .replace(/<span class="material-symbols-outlined[^"]*"[^>]*>[\s\S]*?<\/span>/g, '')
    .replace(/<i\b[^>]*>[\s\S]*?<\/i>/g, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/g, '')
    .replace(/\{\{!--[\s\S]*?--\}\}/g, '')
    .replace(/\{\{![\s\S]*?\}\}/g, '')
    .replace(/\{\{[#/][^}]*\}\}/g, '')
    .replace(/\{\{else\}\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

const semNome = [];
const semOcultar = [];
let soIcone = 0;
let decorativos = 0;
for (const abs of vistas) {
  const rel = path.relative(RAIZ, abs).replace(/\\/g, '/');
  const src = fs.readFileSync(abs, 'utf8');
  const linha = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs, corpo] = m;
    if (!/material-symbols-outlined/.test(corpo)) continue;
    if (textoVisivel(corpo).length === 0) {
      soIcone += 1;
      if (!/\baria-label="[^"]+"/.test(attrs)) semNome.push(`${rel}:${linha(m.index)}`);
    } else {
      // O "texto" pode vir só de {{…}} (partial que pode não produzir nada):
      // nesse caso esconder o ícone deixaria o controlo sem nome nenhum.
      if (textoVisivel(corpo).replace(/\{\{[^}]*\}\}/g, '').trim().length === 0) continue;
      decorativos += 1;
      for (const i of corpo.matchAll(/<span class="material-symbols-outlined[^"]*"([^>]*)>/g)) {
        if (!/aria-hidden="true"/.test(i[1])) semOcultar.push(`${rel}:${linha(m.index)}`);
      }
    }
  }
}
exigir(soIcone >= 90, `controlos só-ícone analisados (${soIcone})`);
assert.deepStrictEqual(semNome, [], `controlos só-ícone sem nome acessível: ${semNome.join(' | ')}`);
console.log(`OK   ${soIcone} controlos só-ícone (botões e ligações) têm aria-label`);
assert.deepStrictEqual(semOcultar, [],
  `ícones decorativos sem aria-hidden dentro de controlos com texto: ${semOcultar.join(' | ')}`);
console.log(`OK   ${decorativos} ícones decorativos marcados com aria-hidden`);

// `data-ajuda` é COMPLEMENTAR: nunca pode ser a origem do nome acessível.
// Quem injeta `title` no toque é o app.js; se um dia passar a escrever
// `aria-label`, o nome acessível deixaria de ser explícito e passaria a
// depender de um atributo de ajuda.
const app = ler('public/js/app.js');
assert.ok(!/setAttribute\('aria-label'/.test(app),
  'app.js não deriva o nome acessível de data-ajuda (aria-label é explícito nas vistas)');
console.log('OK   app.js não escreve aria-label a partir de data-ajuda');
assert.ok(/setAttribute\('title'/.test(app), 'app.js mantém o title no toque (não regrediu)');
console.log('OK   app.js mantém o title no toque');

// Os dois controlos que a auditoria encontrou sem nome nenhum.
assert.ok(/<button aria-label="Criar condomínio"/.test(ler('views/admin/global/condominios.handlebars')),
  'o botão «add» de criar condomínio tem nome acessível');
assert.ok(/<button aria-label="Mais opções"/.test(ler('views/admin/documentos/recibos.handlebars')),
  'o botão «more_vert» dos recibos tem nome acessível');
console.log('OK   os dois controlos sem nome da auditoria foram corrigidos');

// Um ícone NUNCA é escondido num controlo que depende dele para ter nome.
for (const abs of vistas) {
  const src = fs.readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, , attrs, corpo] = m;
    if (!/material-symbols-outlined/.test(corpo)) continue;
    if (textoVisivel(corpo).length > 0) continue;
    if (/\baria-label="[^"]+"/.test(attrs)) continue;
    const todosOcultos = [...corpo.matchAll(/<span class="material-symbols-outlined[^"]*"([^>]*)>/g)]
      .every((i) => /aria-hidden="true"/.test(i[1]));
    exigir(!todosOcultos,
      `${path.relative(RAIZ, abs)}: controlo só-ícone ficou sem nome (todos os ícones escondidos)`);
  }
}
console.log('OK   nenhum controlo só-ícone ficou sem nome por esconder o ícone');

// ── Resultado ───────────────────────────────────────────────────────
if (falhas.length) {
  assert.fail(`invariantes de botões/acessibilidade violadas:\n  - ${falhas.join('\n  - ')}`);
}
console.log(`\n✓ Botões e acessibilidade conformes (${SELETORES.length} seletores com contrato único,`
  + ` ${soIcone} controlos só-ícone com nome, ${decorativos} ícones decorativos).`);
