// ═══════════════════════════════════════════════════════════════════
// Contraste da homepage pública — WCAG 2.1 AA, nos dois temas.
//
// Porque existe: a homepage é composta com os tokens do design system, mas é
// fácil combinar um token de texto claro com um fundo claro (ou o contrário).
// Este teste resolve os tokens reais de public/css/styles.css (tema claro e
// tema escuro), calcula o rácio de contraste de CADA combinação texto/fundo
// usada na homepage e falha se alguma não cumprir:
//
//   · texto normal ............................ 4.5:1
//   · títulos grandes (>= 24px, ou >= 18.66px a negrito) ... 3:1
//   · ícones e objetos não textuais ............ 3:1
//
// Fundos com gradiente são avaliados contra a parada mais desfavorável e fundos
// translúcidos são compostos sobre a base, pelo que o resultado é conservador.
//
// Utilização: node scripts/test-contraste.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(RAIZ, 'public', 'css', 'styles.css'), 'utf8');
const cssHome = fs.readFileSync(path.join(RAIZ, 'public', 'css', 'home.css'), 'utf8');

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

// ── Cálculo de contraste ────────────────────────────────────────────
const hexParaRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const rgbParaHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
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
function compor(rgba, sobre) {
  const [r, g, b, a = 1] = rgba.match(/rgba?\(([^)]+)\)/)[1].split(',').map((v) => Number(v.trim()));
  return [0, 1, 2].map((i) => [r, g, b][i] * a + sobre[i] * (1 - a));
}
function resolver(mapa, token, visitados = []) {
  assert.ok(!visitados.includes(token), `token sem ciclo: ${token}`);
  const valor = mapa.get(token);
  assert.ok(valor, `token ${token} definido no design system`);
  const varMatch = valor.match(/var\((--[a-z0-9-]+)\)/);
  if (varMatch) return resolver(mapa, varMatch[1], [...visitados, token]);
  if (/^#/.test(valor)) return hexParaRgb(valor);
  if (/^rgba?\(/.test(valor)) return compor(valor, [255, 255, 255]);
  throw new Error(`valor não suportado em ${token}: ${valor}`);
}
function fundoDe(mapa, bg) {
  // O hero usa o mesmo gradiente da folha: --c-surface → --c-bg (por isso
  // acompanha o tema claro e o tema escuro, tal como a página).
  if (bg === 'hero') return [resolver(mapa, '--c-surface'), resolver(mapa, '--c-bg')];
  if (bg.startsWith('grad:')) {
    const valor = mapa.get(bg.slice(5));
    assert.ok(valor, `gradiente ${bg.slice(5)} definido`);
    return [...valor.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => hexParaRgb(m[0]));
  }
  if (bg.startsWith('rgba:')) {
    const [token, base] = bg.slice(5).split('+');
    return [compor(mapa.get(token), fundoDe(mapa, base)[0])];
  }
  return [resolver(mapa, bg)];
}

// ── Combinações usadas na homepage (uma por regra de cor da folha) ──
// tamanho em rem do elemento (texto mínimo dos mockups ≈ 0.5rem);
// tipo: 'texto' | 'grafico' (ícones e outros objetos não textuais);
// op: opacidade aplicada ao texto (a hierarquia por opacidade também conta
//     para o contraste, pelo que é composta sobre o fundo).
const P = (nome, fg, bg, tamanho = 0.9, peso = 'normal', tipo = 'texto', op = 1) => ({ nome, fg, bg, tamanho, peso, tipo, op });
const NAVY = 'grad:--nav-bg-image';

const PARES = [
  // Estrutura
  P('Texto corrente', '--c-text', '--c-surface'),
  P('Parágrafo de apoio (.hp-lead)', '--c-text-muted', '--c-surface'),
  P('Faixa de contexto (fundo suave)', '--c-text-muted', '--c-bg', 0.87),
  P('Sobretítulo (.hp-eyebrow)', '--c-primary', '--c-surface', 0.78, 'bold'),
  P('Ligação de texto (.hp-link)', '--c-primary', '--c-surface'),
  P('Nota «acesso por convite» (fundo claro)', '--c-text-muted', '--c-surface', 0.85),
  P('Selo «Desenvolvido em Portugal»', '--c-text', '--c-surface', 0.82, 'bold'),
  P('Botão secundário (contorno)', '--c-text-muted', '--c-surface', 0.9),

  // Hero (claro)
  P('Hero: título', '--c-text', 'hero', 2.4, 'bold'),
  P('Hero: marca (GesCondu)', '--c-text', 'hero', 0.85, 'bold'),
  P('Hero: texto de apoio', '--c-text-muted', 'hero', 1.05),
  P('Hero: nota «acesso por convite»', '--c-text-muted', 'hero', 0.85),
  P('Hero: destaques (ícones)', '--c-primary', 'hero', 1.05, 'normal', 'grafico'),

  // Barra de navegação, menu e rodapé (azul-marinho)
  P('Nav: ligações', '--nav-text', NAVY, 0.92),
  P('Nav: ligação sob o rato', '--nav-text', 'rgba:--nav-hover+grad:--nav-bg-image', 0.92),
  P('Nav: marca', '--nav-text', NAVY, 0.92, 'bold'),
  P('Nav: botão «Entrar» (contorno claro)', '--nav-text', 'rgba:--nav-surface+grad:--nav-bg-image', 0.85),
  P('Nav: botão «Pedir acesso»', '--c-on-primary', '--c-primary', 0.85, 'bold'),
  P('Menu mobile: resumo', '--nav-text', 'rgba:--nav-surface+grad:--nav-bg-image', 0.85),
  P('Menu mobile: resumo aberto', '--nav-text', 'rgba:--nav-surface-strong+grad:--nav-bg-image', 0.85),
  P('Menu mobile: ligações', '--nav-text', NAVY, 0.9),
  P('Rodapé: texto', '--nav-text', NAVY, 0.87),
  P('Rodapé: títulos das colunas', '--nav-text', NAVY, 0.78, 'bold'),
  P('Rodapé: ligações', '--nav-text', NAVY, 0.87),

  // Faixas escuras e CTA final
  P('Faixa escura: título', '--nav-text', NAVY, 1.8, 'bold'),
  P('Faixa escura: texto de apoio', '--nav-text', NAVY, 1.05, 'normal', 'texto', 0.92),
  P('Faixa escura: sobretítulo', '--c-accent', NAVY, 0.78, 'bold'),
  P('Faixa escura: cartão (título)', '--c-text', '--c-surface', 0.98, 'bold'),
  P('Faixa escura: cartão (parágrafo)', '--c-text-muted', '--c-surface', 0.9),
  P('Faixa escura: ligação no cartão', '--c-primary', '--c-surface', 0.9),
  P('CTA final: título', '--nav-text', NAVY, 1.8, 'bold'),
  P('CTA final: texto de apoio', '--nav-text', NAVY, 1.05, 'normal', 'texto', 0.95),
  P('CTA final: nota «acesso por convite»', '--nav-text', NAVY, 0.85, 'normal', 'texto', 0.9),
  P('CTA final: botão «Entrar»', '--nav-text', 'rgba:--nav-surface+grad:--nav-bg-image', 0.9),

  // Aparência e acessibilidade
  P('Amostra de tema claro', '--c-text', '--c-surface', 0.9),
  P('Amostra de tema claro: rótulo', '--c-text', '--c-surface', 0.72, 'bold'),
  P('Amostra de tema escuro', '--nav-text', '--c-navy-900', 1.1, 'bold'),
  P('Amostra de tema escuro: rótulo', '--nav-text', '--c-navy-900', 0.72, 'bold'),
  P('Amostra de tema escuro: sub-rótulo', '--nav-text', '--c-navy-900', 0.76, 'normal', 'texto', 0.85),
  P('Escala de texto: amostras', '--c-text', '--c-surface', 1.3, 'bold'),
  P('Escala de texto: nome do nível', '--c-text-muted', '--c-surface', 0.76),

  // Cartões, listas e comparações
  P('Cartão: título', '--c-text', '--c-surface', 0.98, 'bold'),
  P('Cartão: parágrafo', '--c-text-muted', '--c-surface', 0.9),
  P('Cartão: lista', '--c-text-muted', '--c-surface', 0.87),
  P('Cartão: ícone', '--c-primary-dark', '--c-primary-light', 1.35, 'normal', 'grafico'),
  P('Chip de contexto', '--c-text-muted', '--c-surface', 0.83),
  P('Comparação: título da coluna', '--c-text-muted', '--c-surface', 0.78, 'bold'),
  P('Comparação: coluna «antes»', '--c-text-muted', '--c-surface-2', 0.9),
  P('Comparação: título «com o GesCondu»', '--c-success-text', '--c-surface', 0.78, 'bold'),
  P('Lista: ícone', '--c-text-subtle', '--c-surface', 1.15, 'normal', 'grafico'),
  P('Realce (barra lateral)', '--c-text-muted', '--c-surface', 0.95),

  // FAQ
  P('FAQ: pergunta', '--c-text', '--c-surface', 0.98, 'bold'),
  P('FAQ: resposta', '--c-text-muted', '--c-surface', 0.92),
  P('FAQ: sinal de abrir/fechar', '--c-primary', '--c-surface', 1, 'normal', 'grafico'),

  // Mockups
  P('Mockup: URL fictícia', '--c-text-muted', '--c-surface', 0.55),
  P('Mockup: subtítulo', '--c-text-muted', '--c-surface', 0.55),
  P('Mockup: rótulo de estatística', '--c-text-muted', '--c-surface', 0.5),
  P('Mockup: sub-rótulo', '--c-text-muted', '--c-surface', 0.48),
  P('Mockup: valor de estatística', '--c-text', '--c-surface', 0.8, 'bold'),
  P('Mockup: valor positivo', '--c-success-text', '--c-surface', 0.8, 'bold'),
  P('Mockup: valor em atraso', '--c-warning-text', '--c-surface', 0.8, 'bold'),
  P('Mockup: cabeçalho de tabela', '--c-text-muted', '--c-surface', 0.52, 'bold'),
  P('Mockup: célula de tabela', '--c-text', '--c-surface', 0.55),
  P('Mockup: linha alternada', '--c-text', '--c-surface-2', 0.55),
  P('Mockup: meta (tamanho, data)', '--c-text-muted', '--c-surface', 0.5),
  P('Mockup: legenda do gráfico', '--c-text-muted', '--c-surface', 0.44),
  P('Mockup: seta dos fluxos', '--c-text-muted', '--c-surface', 0.55),
  P('Mockup: nome do ficheiro', '--c-text', '--c-surface', 0.55, 'bold'),
  P('Mockup: ícone de linha', '--c-primary', '--c-surface', 1.2, 'normal', 'grafico'),
  P('Mockup: menu lateral', '--nav-text', NAVY, 0.55),
  P('Mockup: grupo do menu lateral', '--nav-text', NAVY, 0.72, 'normal', 'texto', 0.85),
  P('Mockup: item ativo do menu', '--nav-active', 'rgba:--nav-active-bg+grad:--nav-bg-image', 0.55, 'bold'),
  P('Mockup: saudação do telemóvel', '--nav-text', NAVY, 0.78, 'normal', 'texto', 0.9),
  P('Mockup: aba ativa do telemóvel', '--c-accent', NAVY, 0.5, 'bold'),
  P('Mockup: rodapé do telemóvel', '--c-text-muted', '--c-surface', 0.44),
  P('Mockup: botão principal', '--c-on-primary', '--c-primary', 0.55, 'bold'),
  P('Mockup: botão suave', '--c-primary-dark', '--c-primary-light', 0.55, 'bold'),
  P('Etiqueta: sucesso', '--c-success-text', '--c-success-bg', 0.5, 'bold'),
  P('Etiqueta: aviso', '--c-warning-text', '--c-warning-bg', 0.5, 'bold'),
  P('Etiqueta: informação', '--c-info-text', '--c-info-bg', 0.5, 'bold'),
  P('Etiqueta: neutra', '--c-text', '--c-surface-2', 0.5, 'bold'),
  P('Etiqueta: erro', '--c-error-text', '--c-error-bg', 0.5, 'bold'),
];

function minimo(par) {
  if (par.tipo === 'grafico') return 3;
  const px = par.tamanho * 16;
  const grande = px >= 24 || (px >= 18.66 && par.peso === 'bold');
  return grande ? 3 : 4.5;
}

function auditar() {
  const falhas = [];
  for (const [nomeTema, mapa] of [['claro', claro], ['escuro', escuro]]) {
    console.log(`\n===== TEMA ${nomeTema.toUpperCase()} =====`);
    for (const par of PARES) {
      const fgBase = par.fg.startsWith('--') ? resolver(mapa, par.fg) : hexParaRgb(par.fg);
      const pior = fundoDe(mapa, par.bg)
        .map((fundo) => {
          // A opacidade faz parte da cor efetivamente vista: compõe-se sobre o fundo.
          const fg = compor(`rgba(${fgBase.join(',')},${par.op})`, fundo);
          return { fundo, valor: racio(fg, fundo) };
        })
        .sort((a, b) => a.valor - b.valor)[0];
      const exigido = minimo(par);
      const ok = pior.valor >= exigido;
      if (!ok) falhas.push(`${nomeTema}: ${par.nome} — ${pior.valor.toFixed(2)}:1 (mínimo ${exigido})`);
      console.log(
        `${ok ? 'OK   ' : 'FALHA'} ${pior.valor.toFixed(2).padStart(6)}:1 (mín ${exigido}) ${par.nome}`
        + `  [${par.fg}${par.op < 1 ? ` @${par.op}` : ''} ${rgbParaHex(fgBase)} sobre ${rgbParaHex(pior.fundo)}]`
      );
    }
  }
  return falhas;
}

const falhas = auditar();
assert.deepStrictEqual(falhas, [], `combinações com contraste insuficiente:\n  - ${falhas.join('\n  - ')}`);
assert.ok(PARES.length >= 60, `combinações auditadas (${PARES.length})`);

// As cores da homepage vêm todas dos tokens: nenhuma cor própria na folha.
const hexNaFolha = [...cssHome.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
assert.deepStrictEqual([...new Set(hexNaFolha)], [], `home.css sem cores próprias: ${hexNaFolha.join(' ')}`);

// Meta-verificação: nenhum token usado como cor de texto na folha pode ficar
// fora da auditoria (senão o teste passaria apenas por esquecimento).
const tokensTexto = new Set(
  [...cssHome.matchAll(/(?<!-)color:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])
);
const auditados = new Set(PARES.map((p) => p.fg));
const naoAuditados = [...tokensTexto].filter((t) => !auditados.has(t));
assert.deepStrictEqual(
  naoAuditados, [],
  `tokens de texto usados na homepage e não auditados: ${naoAuditados.join(' ')}`
);
assert.ok(tokensTexto.size >= 12, `tokens de texto cobertos pela auditoria (${tokensTexto.size})`);

// Os fundos da folha também têm de estar cobertos (por token ou por gradiente),
// com uma exceção documentada: os fundos usados apenas em gráficos (barras,
// pontos e barras de progresso), que nunca têm texto por cima.
const FUNDOS_GRAFICOS = ['--c-border-strong', '--c-accent', '--c-success', '--c-warning'];
const SELECTORES_GRAFICOS = [
  '.mk-pontos span', '.mk-barra i', '.mk-barra-suave i', '.mk-barra-dupla i', '.mk-barra-dupla i + i',
  '.mk-progresso i', '.mk-progresso-ok i', '.mk-progresso-aviso i',
];
const tokenFundo = new Set([...cssHome.matchAll(/background:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
const tokensFundo = new Set([...tokenFundo].filter((t) => !FUNDOS_GRAFICOS.includes(t)));
const fundosAuditados = new Set(
  PARES.flatMap((p) => [p.bg, ...p.bg.replace(/^grad:|^rgba:/, '').split('+').map((x) => x.replace(/^grad:/, ''))])
);
const fundosNaoAuditados = [...tokensFundo].filter((t) => !fundosAuditados.has(t));
assert.deepStrictEqual(
  fundosNaoAuditados, [],
  `fundos usados na homepage e não auditados: ${fundosNaoAuditados.join(' ')}`
);
// A exceção tem de ser mesmo só para gráficos: se um destes tokens for usado
// como fundo de um elemento com texto, o teste falha.
for (const regra of cssHome.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const seletor = regra[1].trim().split('\n').pop().trim();
  const corpo = regra[2];
  for (const token of FUNDOS_GRAFICOS) {
    if (!new RegExp(`background:\\s*var\\(${token}\\)`).test(corpo)) continue;
    assert.ok(
      SELECTORES_GRAFICOS.includes(seletor),
      `${token} usado como fundo em «${seletor}»: só é permitido em elementos gráficos`
    );
  }
}

// ── Guardas contra o erro que motivou este teste ─────────────────────
// O layout público define `body.blank-page { color: var(--nav-text) }` (texto
// claro) num <style> que vem DEPOIS desta folha: tudo o que não definisse cor
// própria herdava branco e desaparecia sobre fundo claro. Estas verificações
// impedem que o problema volte.
const cssSemComentarios = cssHome.replace(/\/\*[\s\S]*?\*\//g, '');
const regras = [...cssSemComentarios.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((m) => ({ seletor: m[1].trim().replace(/\s+/g, ' '), corpo: m[2] }))
  .filter((r) => r.seletor && !/@media/.test(r.seletor));

// 1. A regra base da homepage tem de ganhar à regra do layout público.
const base = regras.find((r) => r.seletor === 'body.blank-page.home-publica');
assert.ok(base, 'existe uma regra base com especificidade reforçada (body.blank-page.home-publica)');
assert.ok(/color:\s*var\(--c-text\)/.test(base.corpo), 'a regra base define a cor de texto da página');

// 2. Texto claro (--nav-text) só em contextos de fundo escuro, com lista
//    explícita e documentada.
const CONTEXTOS_ESCUROS = [
  '.hp-sec-dark', '.hp-nav', '.hp-nav-link', '.hp-menu-mobile summary',
  '.mk-lateral', '.mk-lateral-grupo', '.mk-item', '.mk-telemovel-topo',
  '.mk-telemovel-saudacao', '.mk-telemovel-aba', '.hp-cta-final',
  '.hp-rodape', '.hp-tema-escuro',
];
const claroOndeEscuro = regras
  .filter((r) => /color:\s*var\(--nav-text\)/.test(r.corpo))
  .filter((r) => !CONTEXTOS_ESCUROS.some((permitido) => r.seletor.split(',').some((s) => s.trim().startsWith(permitido))))
  .map((r) => r.seletor);
assert.deepStrictEqual(claroOndeEscuro, [], `texto claro só sobre fundo escuro: ${claroOndeEscuro.join(' | ')}`);

// 3. Os componentes de texto da página clara definem a cor explicitamente (não
//    dependem de herança, que é o que falhou).
const COM_COR_EXPLICITA = [
  '.hp-h1, .hp-h2, .hp-h3', '.hp-h4', '.hp-lista li', '.hp-faixa-item strong',
  '.hp-card', '.mk', '.mk-fluxo-passo', '.hp-faq summary',
  '.hp-tema-claro', '.hp-escala-linha', '.mk-telemovel', '.mk-telemovel-ecra',
];
const semCor = COM_COR_EXPLICITA.filter((seletor) => {
  const regra = regras.find((r) => r.seletor === seletor && /color:\s*var\(/.test(r.corpo));
  return !regra;
});
assert.deepStrictEqual(semCor, [], `componentes com cor de texto explícita: ${semCor.join(' | ')}`);

console.log(`\n✓ Contraste da homepage conforme WCAG AA nos dois temas (${PARES.length} combinações auditadas).`);
console.log(`✓ Texto claro apenas em fundos escuros (${CONTEXTOS_ESCUROS.length} contextos verificados) e cor explícita em ${COM_COR_EXPLICITA.length} componentes.`);
