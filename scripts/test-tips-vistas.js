// ═══════════════════════════════════════════════════════════════════
// Tips contextuais do painel — apresentação (vista + folha de estilos).
//
// O que este teste protege:
//   · o CONTRATO com o motor: os tips de exemplo são produzidos pelo próprio
//     `helpers/tips.js` (não por um objeto escrito à mão), pelo que uma
//     alteração do motor que deixe a vista de fora falha aqui;
//   · a ESTRUTURA da apresentação: região nomeada, hierarquia de títulos,
//     cartão por tipo, X de dispensa com nome acessível, CTA;
//   · o CONTRATO de segurança: dispensa por formulário POST para a rota fixa,
//     sem `data-confirmar` (nada de modais para tips normais);
//   · a FOLHA DE ESTILOS: cantos/elevação do design system, acento por tipo,
//     alvos de toque, responsividade, movimento reduzido e a regra de que toda
//     a tipografia acompanha a escala de acessibilidade;
//   · o CONTRASTE real (WCAG 2.1 AA) nos dois temas, recalculado a partir dos
//     tokens de `public/css/styles.css` — não de valores copiados.
//
// Sem base de dados e sem rede. Utilização: node scripts/test-tips-vistas.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('../helpers/handlebars-helpers');
const tipsMotor = require('../helpers/tips');

Object.entries(helpers).forEach(([k, v]) => handlebars.registerHelper(k, v));

const RAIZ = path.join(__dirname, '..');
const PARCIAL = path.join(RAIZ, 'views', 'partials', '_tips.handlebars');
const FONTE = fs.readFileSync(PARCIAL, 'utf8');
// A folha tem bytes que não são UTF-8 válido (ver test-tipografia.js): lê-se
// byte a byte. Os marcadores usados abaixo são ASCII, pelo que não há risco.
const CSS = fs.readFileSync(path.join(RAIZ, 'public', 'css', 'styles.css')).toString('latin1');

handlebars.registerPartial('_tips', FONTE);
const render = handlebars.compile(FONTE);

let seccao = '';
function titulo(t) {
  seccao = t;
  console.log('\n── ' + t);
}
const ok = (nome) => console.log('  ✓ ' + nome);

// ── 1. Contrato com o motor ─────────────────────────────────────────
titulo('1. O motor produz os tips que a vista consome');

// Um cenário que torna elegíveis tips de tipos diferentes: risco (permilagem),
// conclusão (frações, contas, atas) e compreensão (backup sem cópia externa).
const ctxRico = {
  condominioId: 7,
  papel: 'admin',
  fracoes: { n: 4, permilagemOk: false, permilagemTotal: 875, semTitular: 2 },
  contas: { n: 2, fundoReserva: 0 },
  assembleias: { realizadasSemAta: 3 },
  backup: { temLigacoes: true, destino: null },
};
const decisao = tipsMotor.escolher(ctxRico, {});
assert.ok(decisao.apresentar.length > 0, 'o motor apresenta tips neste cenário');
assert.ok(decisao.apresentar.length <= tipsMotor.LIMITE_APRESENTACAO,
  'nunca se apresentam mais tips do que o limite do motor');
const tiposVistos = new Set(decisao.apresentar.map((t) => t.tipo));
assert.ok(tiposVistos.has('risco'), 'cenário inclui um tip de risco');
assert.ok(tiposVistos.has('conclusao'), 'cenário inclui um tip de conclusão');

// Cada campo que a vista usa tem de existir na saída do motor.
for (const t of decisao.apresentar) {
  for (const campo of ['id', 'tipo', 'rotulo', 'titulo', 'mensagem', 'acao', 'dismissivel']) {
    assert.ok(t[campo] !== undefined && t[campo] !== null,
      `o motor fornece «${campo}» (tip ${t.id})`);
  }
  assert.ok(t.acao.url && t.acao.texto, `o motor fornece a ação completa (tip ${t.id})`);
}
ok('todos os campos usados pela vista existem na saída do motor');

// ── 2. Estrutura da apresentação ────────────────────────────────────
titulo('2. Estrutura: região, hierarquia e cartão por tip');

const html = render({ tips: decisao });

assert.ok(html.includes('<section class="gc-tips-bloco"'), 'a lista é uma secção');
assert.ok(/aria-labelledby="gc-tips-titulo"/.test(html), 'a secção é uma região nomeada');
assert.ok(/<h2[^>]*id="gc-tips-titulo"[^>]*>Sugestões<\/h2>/.test(html),
  'o nome da região existe e diz «Sugestões»');

// Hierarquia: um h2 (secção) e um h3 por tip — nunca um salto de nível.
const nH2 = (html.match(/<h2\b/g) || []).length;
const nH3 = (html.match(/<h3\b/g) || []).length;
assert.strictEqual(nH2, 1, 'existe exatamente um h2 (a secção)');
assert.strictEqual(nH3, decisao.apresentar.length, 'existe um h3 por tip');

// Um cartão por tip, com a classe do tipo.
const cartoes = html.match(/class="card gc-tip gc-tip-[a-z]+"/g) || [];
assert.strictEqual(cartoes.length, decisao.apresentar.length, 'um cartão por tip apresentado');
for (const t of decisao.apresentar) {
  assert.ok(html.includes(`class="card gc-tip gc-tip-${t.tipo}"`), `cartão do tipo «${t.tipo}»`);
  assert.ok(html.includes(`data-tip="${t.id}"`), `o cartão identifica o tip (${t.id})`);
}

// Ordem obrigatória: rótulo (tipo) → título → explicação → ação.
for (const t of decisao.apresentar) {
  const iRot = html.indexOf(`>${t.rotulo}<`);
  const iTit = html.indexOf(`>${t.titulo}<`);
  const iMsg = html.indexOf(t.mensagem.slice(0, 40));
  assert.ok(iRot > 0 && iTit > iRot && iMsg > iTit,
    `hierarquia rótulo → título → explicação (${t.id})`);
}
ok('rótulo → título → explicação, por esta ordem, em todos os tips');

// O rótulo diz o tipo por palavras (a cor é reforço, nunca a única informação).
for (const t of decisao.apresentar) {
  assert.ok(t.rotulo && t.rotulo.length > 3, `o tip ${t.id} tem rótulo escrito`);
  assert.ok(html.includes(`class="gc-tip-rotulo">${t.rotulo}<`), `o rótulo «${t.rotulo}» é apresentado`);
}
ok('o tipo é sempre dito por palavras (não depende da cor)');

// ── 3. X de dispensa ────────────────────────────────────────────────
titulo('3. X de dispensa: formulário real, nome acessível, sem modal');

const nX = (html.match(/class="gc-tip-x"/g) || []).length;
const dispensaveis = decisao.apresentar.filter((t) => t.dismissivel).length;
assert.strictEqual(nX, dispensaveis, 'um X por tip dispensável');

for (const t of decisao.apresentar) {
  assert.ok(html.includes(`action="/admin/tips/${t.id}/dispensar"`),
    `o X submete para a rota fixa do tip ${t.id}`);
}
assert.ok(/<form class="gc-tip-dispensar"[^>]*method="POST"/.test(html),
  'a dispensa é um formulário POST (funciona sem JavaScript)');
assert.ok(/class="gc-tip-x"[^>]*type="submit"/.test(html) || /type="submit"[^>]*class="gc-tip-x"/.test(html),
  'o X é um botão de submissão');

// Nome acessível: um ícone sozinho nunca é lido. O nome diz o que acontece e a
// que tip se refere.
for (const t of decisao.apresentar) {
  assert.ok(html.includes(`aria-label="Dispensar a sugestão «${t.titulo}»"`),
    `o X do tip ${t.id} tem nome acessível completo`);
}
assert.ok(/class="gc-tip-x"[^>]*title="Dispensar"/.test(html), 'o X tem title (rato)');
assert.ok(/class="gc-tip-x"[\s\S]{0,200}aria-hidden="true">close</.test(html),
  'o ícone do X é decorativo (aria-hidden)');

// Nada de popups agressivos: sem confirmação modal e sem alerta.
assert.ok(!html.includes('data-confirmar'), 'dispensar não abre a modal de confirmação');
assert.ok(!/role="alert"/.test(html), 'um tip não é um alerta');
assert.ok(!/alert-/.test(html), 'um tip não usa as classes de alerta do Bootstrap');
assert.ok(!html.includes('data-bs-dismiss'), 'o X não é um alerta descartável do Bootstrap');
ok('sem modal, sem alerta: o X dispensa diretamente');

// ── 4. CTA ──────────────────────────────────────────────────────────
titulo('4. CTA: destino e texto vêm da definição do tip');

const nCta = (html.match(/class="btn btn-primary gc-tip-cta"/g) || []).length;
assert.strictEqual(nCta, decisao.apresentar.length, 'um CTA por tip');
for (const t of decisao.apresentar) {
  assert.ok(html.includes(`href="${t.acao.url}"`), `o CTA aponta para ${t.acao.url}`);
  assert.ok(html.includes(`>${t.acao.texto}</a>`), `o CTA diz «${t.acao.texto}»`);
}
ok('a ação apresentada é a da definição (nunca vem do browser)');

// ── 5. Vários tips e ids únicos ─────────────────────────────────────
titulo('5. Vários tips, ids únicos');

const ids = html.match(/id="gc-tip-[a-z_]+-titulo"/g) || [];
assert.strictEqual(ids.length, decisao.apresentar.length, 'um id de título por tip');
assert.strictEqual(new Set(ids).size, ids.length, 'os ids dos títulos são únicos');
assert.ok((html.match(/class="gc-tip-dispensar"/g) || []).length === nX,
  'cada tip tem o seu próprio formulário (sem formulários aninhados)');
ok(`${decisao.apresentar.length} tips na mesma lista, sem colisão de ids`);

// Sem tips não se apresenta nada — nem o cartão, nem o script.
const vazio = render({ tips: { apresentar: [], total: 0, outras: [], limite: 3 } });
assert.strictEqual(vazio.trim(), '', 'sem tips elegíveis não se renderiza nada');
const semTips = render({});
assert.strictEqual(semTips.trim(), '', 'sem contexto de tips a vista não rebenta nem inventa');
ok('sem tips elegíveis: nada é apresentado');

// Tipos que o motor ainda não usa continuam a ser apresentados corretamente
// (o catálogo pode crescer sem se tocar na vista).
const sintetico = render({
  tips: {
    apresentar: [{
      id: 'exemplo_descoberta', tipo: 'descoberta', rotulo: 'Funcionalidade pouco óbvia',
      titulo: 'Título de exemplo', mensagem: 'Explicação de exemplo.',
      icone: 'lightbulb', acao: { texto: 'Ver', url: '/admin/exemplo' }, dismissivel: true,
    }],
    total: 1, outras: [], limite: 3,
  },
});
assert.ok(sintetico.includes('class="card gc-tip gc-tip-descoberta"'), 'tipo «descoberta» é suportado');
assert.ok(sintetico.includes('Funcionalidade pouco óbvia'), 'o rótulo do tipo é apresentado');
ok('tipos previstos mas ainda sem catálogo são suportados');

// O ícone é do motor (é ele que conhece cada tip).
const comIcone = render({
  tips: {
    apresentar: [{
      id: 'com_icone', tipo: 'risco', rotulo: 'Atenção ao cálculo', titulo: 'T', mensagem: 'M.',
      icone: 'priority_high', acao: { texto: 'Ver', url: '/x' }, dismissivel: true,
    }],
    total: 1, outras: [], limite: 3,
  },
});
assert.ok(comIcone.includes('>priority_high<'), 'o ícone do motor é respeitado');
const semIcone = render({
  tips: {
    apresentar: [{
      id: 'sem_icone', tipo: 'risco', rotulo: 'Atenção ao cálculo', titulo: 'T', mensagem: 'M.',
      acao: { texto: 'Ver', url: '/x' }, dismissivel: true,
    }],
    total: 1, outras: [], limite: 3,
  },
});
assert.ok(semIcone.includes('>lightbulb<'), 'sem ícone definido usa-se o ícone por omissão');
ok('o ícone vem do motor, com um valor por omissão sensato');

// ── 6. Sem framework novo, sem estilos em linha ─────────────────────
titulo('6. Sem framework novo, sem estilos em linha');

assert.ok(!/<style[\s>]/.test(FONTE), 'a vista não injeta uma folha de estilos');
assert.ok(!/style="[^"]*font-size/.test(FONTE), 'a vista não fixa tipografia em linha');
assert.ok(!/@import/.test(CSS.slice(CSS.indexOf('Tips contextuais do painel'), CSS.indexOf('faixas horizontais agrupadas'))),
  'a zona dos tips não importa folhas externas');
assert.ok(FONTE.includes('btn btn-primary'), 'o CTA reutiliza o botão da aplicação');
assert.ok(FONTE.includes('class="card gc-tip'), 'o tip reutiliza o cartão da aplicação');
assert.ok(!/cdn\.jsdelivr|bootstrap\.min\.css/.test(FONTE), 'a vista não carrega CSS de terceiros');
assert.ok(FONTE.includes('material-symbols-outlined'), 'os ícones usam o conjunto já incluído no layout');
ok('reutiliza os componentes e os ícones existentes');

// Auto-contido: o parcial usa APENAS construções nativas do Handlebars, pelo que
// renderiza numa instância «nua», sem os helpers da aplicação. Isto mantém o
// componente testável de forma isolada e evita acoplar a apresentação ao
// registo de helpers (há testes que compilam esta vista sem os registar).
const hbNu = handlebars.create();
hbNu.registerPartial('_tips', FONTE);
assert.strictEqual(hbNu.compile(FONTE)({ tips: decisao }), html,
  'renderiza de forma idêntica numa instância de Handlebars sem helpers da aplicação');
ok('sem dependência de helpers da aplicação (renderiza isolado)');

// O script do comportamento é carregado uma só vez, com defer, e o componente
// traz o seu próprio comportamento (o layout não é tocado).
assert.strictEqual((html.match(/\/js\/tips\.js/g) || []).length, 1, 'o script do tip é incluído uma vez');
assert.ok(/<script src="\/js\/tips\.js\?v=[^"]+" defer><\/script>/.test(html),
  'o script é carregado com defer e cache-busting');
assert.ok(!vazio.includes('tips.js'), 'sem tips não se carrega o script');
ok('comportamento próprio, carregado só quando há tips');

// ── 7. Folha de estilos: design system, responsivo, movimento ───────
titulo('7. Folha de estilos: cantos, elevação, alvos e movimento');

const inicioZona = CSS.indexOf('Tips contextuais do painel');
const fimZona = CSS.indexOf('faixas horizontais agrupadas');
assert.ok(inicioZona > 0 && fimZona > inicioZona, 'a zona dos tips está localizada na folha');
const ZONA = CSS.slice(inicioZona, fimZona);

function regra(seletor) {
  const i = ZONA.indexOf(seletor);
  assert.ok(i !== -1, `a regra «${seletor}» existe`);
  const inicio = ZONA.indexOf('{', i);
  const fim = ZONA.indexOf('}', inicio);
  return ZONA.slice(inicio + 1, fim);
}
const props = (seletor) => {
  const mapa = new Map();
  for (const m of regra(seletor).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) mapa.set(m[1], m[2].trim());
  return mapa;
};

const blocoTip = regra('.gc-tip {');
assert.ok(/border-radius:\s*var\(--radius\)/.test(blocoTip), 'o cartão usa o raio do design system');
assert.ok(/box-shadow:\s*var\(--elev-1\)/.test(blocoTip), 'o cartão usa a elevação do design system');
assert.ok(/border-left:\s*4px solid var\(--tip-accent\)/.test(blocoTip), 'o acento é um filete à esquerda');
assert.ok(/background:\s*var\(--c-surface\)/.test(blocoTip), 'o fundo é a superfície do tema');
assert.ok(/animation:\s*gc-tip-entrada/.test(blocoTip), 'o tip tem uma entrada discreta');
assert.ok(/transition:\s*box-shadow/.test(blocoTip), 'o tip tem transição de elevação');

assert.ok(/box-shadow:\s*var\(--elev-2\)/.test(regra('.gc-tip:hover')), 'o hover eleva o cartão');
assert.ok(/:focus-within/.test(ZONA), 'o cartão destaca-se com o foco dentro (teclado)');
assert.ok(/@keyframes gc-tip-entrada/.test(ZONA), 'a animação de entrada está definida');

// Alvos de toque: X com 44×44 e CTA com altura mínima de 44px.
const blocoX = regra('.gc-tip-x {');
assert.ok(/width:\s*44px/.test(blocoX) && /height:\s*44px/.test(blocoX),
  'o X tem um alvo de toque de 44×44px');
assert.ok(/min-height:\s*44px/.test(regra('.gc-tip-cta {')), 'o CTA tem altura mínima de 44px');
assert.ok(/focus-visible/.test(ZONA), 'o X tem foco visível próprio');

// Estado de carregamento (melhoria progressiva).
assert.ok(/\[aria-busy="true"\]/.test(ZONA), 'existe um estado de carregamento ligado a aria-busy');
assert.ok(/opacity:\s*0?\.\d+/.test(regra('.gc-tip[aria-busy="true"] {')),
  'o cartão fica esbatido enquanto a dispensa é enviada');
assert.ok(/@keyframes gc-tip-girar/.test(ZONA), 'o indicador de carregamento tem animação própria');
assert.ok(/visibility:\s*hidden/.test(ZONA), 'o X é substituído pelo indicador enquanto carrega');
assert.ok(/\.gc-tip\[aria-busy="true"\] \.gc-tip-x::after/.test(ZONA),
  'o indicador é desenhado no lugar do X');

// Responsivo: no telemóvel a ação ocupa a largura.
assert.ok(/@media \(max-width: 575\.98px\)/.test(ZONA), 'há um breakpoint de telemóvel para os tips');
assert.ok(/\.gc-tip-acoes \.gc-tip-cta \{ flex: 1 1 100%; \}/.test(ZONA),
  'no telemóvel o CTA ocupa a largura do cartão');

// Movimento reduzido: explicitamente desligado (além da regra global).
const blocoMovimento = ZONA.slice(ZONA.indexOf('@media (prefers-reduced-motion: reduce)'));
assert.ok(/\.gc-tip \{ animation: none; \}/.test(blocoMovimento),
  'com movimento reduzido a entrada é desligada');
assert.ok(/animation: none/.test(blocoMovimento), 'o indicador também para com movimento reduzido');
ok('cantos, elevação, alvos de 44px, responsivo e movimento reduzido');

// A reformulação substituiu o desenho antigo (um cartão único com divisórias).
assert.ok(!/\.gc-tips \{/.test(ZONA), 'o invólucro antigo de acento único desapareceu');
assert.ok(!/\.gc-tip-texto/.test(ZONA), 'a classe antiga do texto desapareceu');
assert.ok(!/\.gc-tip-corpo/.test(ZONA), 'a classe antiga do corpo desapareceu');
ok('o desenho anterior foi substituído, sem regras órfãs');

// Toda a tipografia da zona acompanha a escala de acessibilidade.
const semEscala = ZONA.split('\n').filter((l) => /font-size\s*:\s*[\d.]+(px|pt)/.test(l));
assert.deepStrictEqual(semEscala, [], `toda a tipografia dos tips usa var(--font-scale): ${semEscala.join(' | ')}`);
ok('a tipografia acompanha Normal · Grande · Muito grande');

// Nenhum HEX solto: as cores vêm dos tokens (é isso que faz o tema escuro funcionar).
const hexSoltos = ZONA.split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l));
assert.deepStrictEqual(hexSoltos, [], `nenhuma cor literal na zona dos tips: ${hexSoltos.join(' | ')}`);
ok('nenhuma cor literal: tudo por tokens (light/dark acompanham)');

// ── 8. Contraste real nos dois temas (WCAG 2.1 AA) ──────────────────
titulo('8. Contraste WCAG AA nos dois temas');

function blocoDe(seletor) {
  const i = CSS.indexOf(seletor);
  assert.ok(i !== -1, `bloco ${seletor} existe`);
  const inicio = CSS.indexOf('{', i);
  const fim = CSS.indexOf('}', inicio);
  const mapa = new Map();
  for (const m of CSS.slice(inicio + 1, fim).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) mapa.set(m[1], m[2].trim());
  return mapa;
}
const hexParaRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
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
  assert.ok(valor, `token ${token} definido`);
  const vm = valor.match(/var\((--[a-z0-9-]+)\)/);
  if (vm) return resolver(mapa, vm[1], [...visitados, token]);
  assert.ok(/^#/.test(valor), `token ${token} resolve para uma cor: ${valor}`);
  return hexParaRgb(valor);
}
const r2 = (n) => Math.round(n * 100) / 100;

const raiz = blocoDe(':root {');
const escuro = blocoDe('[data-theme="dark"] {');
const propsTip = props('.gc-tip {');
const propsRisco = props('.gc-tip-risco {');

const temas = [
  ['claro', new Map([...raiz, ...propsTip])],
  ['escuro', new Map([...raiz, ...escuro, ...propsTip])],
];
const variantes = [
  ['tip comum', new Map()],
  ['tip de risco', propsRisco],
];

const falhas = [];
for (const [nomeTema, base] of temas) {
  for (const [nomeVariante, extra] of variantes) {
    const mapa = new Map([...base, ...extra]);
    const superficie = resolver(mapa, '--c-surface');
    const fundoPagina = resolver(mapa, '--c-bg');
    const alvo = `${nomeVariante} (${nomeTema})`;

    // Texto: 4.5:1 (WCAG 1.4.3).
    const textos = [
      ['título', resolver(mapa, '--c-text'), superficie],
      ['rótulo do tipo', resolver(mapa, '--c-text-muted'), superficie],
      ['explicação', resolver(mapa, '--c-text-muted'), superficie],
      ['texto do CTA', resolver(mapa, '--c-on-primary'), resolver(mapa, '--c-primary')],
    ];
    for (const [nome, fg, bg] of textos) {
      const v = racio(fg, bg);
      if (v < 4.5) falhas.push(`${alvo}: ${nome} = ${r2(v)}:1 (mínimo 4.5)`);
    }

    // Objetos não textuais: 3:1 (WCAG 1.4.11) — o X identifica o botão.
    const naoTextuais = [
      ['ícone do X', resolver(mapa, '--c-text-muted'), superficie],
      ['símbolo no círculo', resolver(mapa, '--tip-accent-forte'), resolver(mapa, '--tip-accent-soft')],
      ['filete de acento', resolver(mapa, '--tip-accent'), superficie],
      ['filete sobre o fundo da página', resolver(mapa, '--tip-accent'), fundoPagina],
    ];
    for (const [nome, fg, bg] of naoTextuais) {
      const v = racio(fg, bg);
      if (v < 3) falhas.push(`${alvo}: ${nome} = ${r2(v)}:1 (mínimo 3)`);
    }
  }
}
assert.deepStrictEqual(falhas, [], 'todas as combinações cumprem WCAG AA:\n    ' + falhas.join('\n    '));

// O acento por omissão não pode voltar a ser o ciano: em tema claro dava 1.85:1.
const acentoClaro = resolver(new Map([...raiz, ...propsTip]), '--tip-accent');
assert.ok(racio(acentoClaro, resolver(raiz, '--c-surface')) >= 3,
  'o acento por omissão cumpre 3:1 sobre o cartão em tema claro');
ok('texto ≥ 4.5:1 e objetos não textuais ≥ 3:1, nos dois temas e nas duas variantes');

// ── 9. Não quebrar o que já existia ─────────────────────────────────
titulo('9. Compatibilidade com o que já existia');

const painel = fs.readFileSync(path.join(RAIZ, 'views', 'admin', 'dashboard.handlebars'), 'utf8');
assert.ok(painel.includes('{{> _tips}}'), 'o painel continua a incluir os tips');
assert.ok(painel.includes('<h1>'), 'o painel mantém o título principal');
assert.ok(CSS.includes('--sidebar-w: 244px'), 'a largura da sidebar não mudou');
assert.ok(/@media \(max-width: 991\.98px\)/.test(CSS), 'o drawer do telemóvel (sidebar offcanvas) mantém-se');
assert.ok(/html\[data-font="xlarge"\] \{ --font-scale: 1\.16; \}/.test(CSS),
  'os três níveis de texto continuam definidos');
assert.ok(/\[data-theme="dark"\] \{/.test(CSS), 'o tema escuro continua definido por data-theme');
assert.ok(/<script src="\/js\/app\.js/.test(fs.readFileSync(path.join(RAIZ, 'views', 'layouts', 'main.handlebars'), 'utf8')),
  'o layout não foi alterado: continua a carregar os scripts de sempre');
ok('painel, sidebar/drawer, escala de texto, temas e layout intactos');

console.log('\n✓ Testes da apresentação dos Tips passaram (vista + folha de estilos, sem BD).');
