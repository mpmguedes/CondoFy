// ═══════════════════════════════════════════════════════════════════
// Tipografia e escala de texto (acessibilidade) — sem rede/BD.
//
// Verifica:
//  · a tipografia global (Inter com pilha de reserva) e a escala Normal ·
//    Grande · Muito grande (--font-scale + <html data-font>);
//  · que TODA a tipografia escalável acompanha a escala (nenhum font-size em
//    px fica de fora, exceto a folha do documento — pré-visualização A4, que
//    mantém a tipografia do PDF);
//  · que as dimensões de layout (sidebar, cabeçalho, espaçamentos) não mudam;
//  · o comportamento de public/js/tema.js com um DOM mínimo (preferência
//    guardada, tema e tamanho independentes);
//  · o controlo na interface (parcial _tema-toggle), com os três níveis em
//    PT-PT e acessível (aria-checked + marca visual, não só cor);
//  · o aviso de documento numa caixa da aplicação (sem nova janela).
// Utilização: node scripts/test-tipografia.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
// styles.css tem bytes que não são UTF-8 válido: lê-se byte a byte (latin1).
const lerCss = () => fs.readFileSync(path.join(RAIZ, 'public/css/styles.css')).toString('latin1');

// ── 1. Escala de texto no CSS ───────────────────────────────────────
function testarEscalaNoCss() {
  const css = lerCss();
  assert.ok(/--font-scale:\s*1;/.test(css), 'token --font-scale definido (Normal = 1)');
  assert.ok(
    /html\[data-font="large"\]\s*\{\s*--font-scale:\s*1\.08;\s*\}/.test(css),
    'Grande = +8% (1.08)'
  );
  assert.ok(
    /html\[data-font="xlarge"\]\s*\{\s*--font-scale:\s*1\.16;\s*\}/.test(css),
    'Muito grande = +16% (1.16)'
  );
  assert.ok(
    /html\s*\{\s*font-size:\s*calc\(100%\s*\*\s*var\(--font-scale\)\);\s*\}/.test(css),
    'o tamanho de referência (rem) acompanha a escala'
  );
  // Os tokens tipográficos são rem: escalam com a raiz, mantendo a hierarquia.
  for (const token of ['xs', 'sm', 'md', 'lg', 'xl']) {
    const m = css.match(new RegExp(`--font-size-${token}:\\s*([\\d.]+)(rem|px)`));
    assert.ok(m, `token --font-size-${token} presente`);
    assert.strictEqual(m[2], 'rem', `--font-size-${token} em rem (escala com o utilizador)`);
  }
  assert.ok(/body \{[^}]*font-size:\s*0?\.95rem/.test(css), 'o texto base continua relativo (0.95rem)');
}

// ── 2. Toda a tipografia escalável acompanha a escala ───────────────
function testarCoberturaDaEscala() {
  const css = lerCss();
  // A folha do documento (.cv-sheet) é a pré-visualização fiel do PDF (794px
  // fixos, Helvetica/Arial): mantém a sua tipografia de propósito.
  const inicio = css.indexOf('.cv-sheet {');
  const fim = css.indexOf('.sidebar-nav { padding-top: 6px; }');
  assert.ok(inicio > 0 && fim > inicio, 'bloco da folha do documento localizado');

  const semEscala = [];
  const linhas = css.split('\n');
  let posicao = 0;
  linhas.forEach((linha) => {
    const dentroDaFolha = posicao >= inicio && posicao <= fim;
    posicao += linha.length + 1;
    const m = linha.match(/font-size\s*:\s*[\d.]+(px|pt)/);
    if (m && !dentroDaFolha) semEscala.push(linha.trim());
  });
  assert.deepStrictEqual(semEscala, [], `todo o font-size em px/pt usa var(--font-scale): ${semEscala.join(' | ')}`);

  // Dentro da folha nada foi alterado (tipografia do documento intacta).
  const folha = css.slice(inicio, fim);
  assert.ok(!/var\(--font-scale\)/.test(folha), 'a folha do documento não é escalada');
  assert.ok(/font-size: 21px/.test(folha), 'tipografia da folha intacta (ex.: título 21px)');

  // Dimensões de layout continuam fixas: só a tipografia cresce.
  assert.ok(/--sidebar-w:\s*244px;/.test(css), 'largura da sidebar inalterada');
  assert.ok(/--header-h:\s*56px;/.test(css), 'altura do cabeçalho inalterada');
  assert.ok(/--sp-1:\s*4px;/.test(css), 'escala de espaçamento inalterada (px)');
  // As cores (tema claro/escuro) não são tocadas por esta funcionalidade.
  assert.ok(/html\[data-theme="dark"\]|\[data-theme="dark"\]/.test(css), 'tema escuro continua definido por data-theme');
  assert.ok(
    !/^[^\n{]*data-font[^\n{]*\{[^\n}]*--c-/m.test(css),
    'a escala de texto não redefine nenhuma cor'
  );
}

// ── 3. Tipografia global (Inter, com reserva) ───────────────────────
function testarTipografiaGlobal() {
  const css = lerCss();
  const familia = css.match(/font-family:\s*"Inter"[^;]+;/)[0];
  assert.ok(/^font-family: "Inter",/.test(familia), 'Inter é a primeira da pilha');
  for (const reserva of ['-apple-system', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif']) {
    assert.ok(familia.includes(reserva), `reserva ${reserva} mantida`);
  }
  assert.strictEqual((css.match(/"Inter"/g) || []).length, 1, 'uma única declaração de família global');

  for (const ficheiro of ['views/layouts/main.handlebars', 'views/layouts/blank.handlebars']) {
    const html = ler(ficheiro);
    assert.ok(html.includes('family=Inter:wght@400;500;600;700'), `${ficheiro}: Inter com os pesos usados no CSS`);
    assert.ok(!html.includes('family=Roboto'), `${ficheiro}: Roboto substituído (sem pedido duplicado)`);
    assert.ok(html.includes('Material+Symbols+Outlined'), `${ficheiro}: ícones mantidos`);
    assert.ok(html.includes('/css/styles.css?v=20260910a'), `${ficheiro}: cache da folha de estilos renovado`);
  }
}

// ── 4. Preferência aplicada antes do CSS (sem flash) ────────────────
function testarAplicacaoAntecipada() {
  for (const ficheiro of ['views/layouts/main.handlebars', 'views/layouts/blank.handlebars']) {
    const html = ler(ficheiro);
    const script = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    assert.ok(script.includes("localStorage.getItem('gescondu-fonte')"), `${ficheiro}: lê a preferência de tamanho no <head>`);
    assert.ok(
      /setAttribute\('data-font', f === 'large' \|\| f === 'xlarge' \? f : 'normal'\)/.test(script),
      `${ficheiro}: aplica data-font antes do CSS (evita flash)`
    );
    assert.ok(script.includes("localStorage.getItem('gescondu-tema')"), `${ficheiro}: mantém a aplicação do tema`);
    assert.ok(
      script.indexOf('data-font') < html.indexOf('/css/styles.css'),
      `${ficheiro}: a escala é definida antes da folha de estilos`
    );
  }
}

// ── 5. Comportamento de public/js/tema.js (DOM mínimo) ──────────────
function elemento(attrs) {
  const dados = Object.assign({}, attrs);
  const classes = new Set(String(dados.className || '').split(' ').filter(Boolean));
  const el = {
    dataset: dados.dataset || {},
    textContent: dados.textContent || '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, ligar) => (ligar ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    getAttribute: (n) => (n in dados ? String(dados[n]) : null),
    setAttribute: (n, v) => {
      dados[n] = v;
    },
    querySelector: () => dados.filho || null,
    addEventListener: (tipo, fn) => {
      el._handlers = el._handlers || {};
      el._handlers[tipo] = fn;
    },
    clique: () => el._handlers && el._handlers.click && el._handlers.click({ currentTarget: el }),
    atributos: () => dados,
  };
  return el;
}

function testarComportamentoDaFonte() {
  const guardado = new Map();
  const iconeTema = elemento({ textContent: 'dark_mode' });
  const botaoTema = elemento({ filho: iconeTema });
  const iconeFonte = elemento({ className: 'material-symbols-outlined' });
  const botaoFonte = elemento({ filho: iconeFonte });
  const marcas = [elemento({}), elemento({ className: 'material-symbols-outlined invisible' }), elemento({ className: 'material-symbols-outlined invisible' })];
  const opcoes = ['normal', 'large', 'xlarge'].map((valor, i) =>
    elemento({ 'data-fonte-opcao': valor, filho: marcas[i] })
  );
  const tudo = { '[data-tema-toggle]': [botaoTema], '[data-fonte-opcao]': opcoes, '[data-fonte-toggle]': [botaoFonte] };
  const raiz = elemento({});

  const armazenamento = {
    getItem: (k) => (guardado.has(k) ? guardado.get(k) : null),
    setItem: (k, v) => guardado.set(k, v),
    removeItem: (k) => guardado.delete(k),
  };
  global.window = {
    localStorage: armazenamento,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  };
  // No browser `localStorage` é um global; aqui replica-se.
  global.localStorage = armazenamento;
  global.document = {
    documentElement: raiz,
    readyState: 'complete',
    addEventListener: () => {},
    querySelector: (sel) => (tudo[sel] ? tudo[sel][0] : null),
    querySelectorAll: (sel) => tudo[sel] || [],
  };
  delete require.cache[require.resolve('../public/js/tema.js')];
  require('../public/js/tema.js');

  // Estado inicial: Normal + tema claro (o sistema não prefere escuro).
  assert.strictEqual(raiz.getAttribute('data-font'), 'normal', 'arranca em Normal');
  assert.strictEqual(raiz.getAttribute('data-theme'), 'light', 'tema claro por omissão');

  // Escolha do tamanho: guardada e aplicada; marca/aria-checked coerentes.
  assert.strictEqual(window.GesConduFonte.definir('xlarge'), 'xlarge', 'define Muito grande');
  assert.strictEqual(raiz.getAttribute('data-font'), 'xlarge', 'data-font aplicado');
  assert.strictEqual(guardado.get('gescondu-fonte'), 'xlarge', 'preferência guardada no browser');
  assert.strictEqual(opcoes[2].getAttribute('aria-checked'), 'true', 'opção escolhida assinalada por aria-checked');
  assert.strictEqual(marcas[2].classList.contains('invisible'), false, 'marca visual visível na opção escolhida');
  assert.strictEqual(marcas[0].classList.contains('invisible'), true, 'marca visual escondida nas restantes');
  assert.strictEqual(opcoes[0].getAttribute('aria-checked'), 'false', 'opções não escolhidas com aria-checked=false');
  assert.strictEqual(botaoFonte.getAttribute('aria-label'), 'Tamanho do texto: Muito grande', 'o botão anuncia o nível atual');

  // Trocar o tema NÃO altera o tamanho (e vice-versa).
  window.GesConduTema.definir('escuro');
  assert.strictEqual(raiz.getAttribute('data-theme'), 'dark', 'tema escuro aplicado');
  assert.strictEqual(raiz.getAttribute('data-font'), 'xlarge', 'tema não altera o tamanho do texto');
  window.GesConduFonte.definir('large');
  assert.strictEqual(raiz.getAttribute('data-theme'), 'dark', 'tamanho não altera o tema');
  assert.strictEqual(raiz.getAttribute('data-font'), 'large', 'nível Grande aplicado');

  // Preferência inválida (localStorage adulterado) cai em Normal.
  window.GesConduFonte.definir('gigante');
  assert.strictEqual(raiz.getAttribute('data-font'), 'normal', 'nível desconhecido → Normal');
  assert.deepStrictEqual(
    window.GesConduFonte.OPCOES.map((o) => o.rotulo),
    ['Normal', 'Grande', 'Muito grande'],
    'rótulos em PT-PT'
  );

  // O clique numa opção aplica o nível (o menu é o mesmo nas três páginas).
  opcoes[1].clique();
  assert.strictEqual(raiz.getAttribute('data-font'), 'large', 'clique em "Grande" aplica o nível');
  assert.strictEqual(guardado.get('gescondu-fonte'), 'large', 'clique guarda a preferência');

  delete global.window;
  delete global.localStorage;
  delete global.document;
}

// ── 6. Controlo na interface (parcial) ──────────────────────────────
function testarControloNaInterface() {
  const fonte = ler('views/partials/_tema-toggle.handlebars');
  const html = handlebars.compile(fonte)({});
  assert.ok(html.includes('data-tema-toggle'), 'o botão de claro/escuro mantém-se');
  assert.ok(html.includes('format_size'), 'novo botão com ícone de tamanho de texto');
  assert.ok(html.includes('data-fonte-toggle'), 'botão do tamanho identificável');
  assert.ok(html.includes('data-bs-toggle="dropdown"'), 'usa o dropdown existente da aplicação (Bootstrap)');
  assert.ok(html.includes('dropdown-menu-end'), 'menu alinhado à direita, como o do utilizador');
  assert.ok(html.includes('aria-haspopup="true"'), 'botão anuncia que abre um menu');
  for (const nivel of ['normal', 'large', 'xlarge']) {
    assert.ok(html.includes(`data-fonte-opcao="${nivel}"`), `opção ${nivel} presente`);
  }
  for (const rotulo of ['Normal', 'Grande', 'Muito grande']) {
    assert.ok(html.includes(`>${rotulo}<`) || html.includes(`>${rotulo}</`), `rótulo PT-PT "${rotulo}"`);
  }
  assert.ok(!/Grande \(/.test(html), 'sem terminologia brasileira');
  assert.strictEqual((html.match(/role="menuitemradio"/g) || []).length, 3, 'as três opções são opções de rádio acessíveis');
  assert.strictEqual((html.match(/aria-checked=/g) || []).length, 3, 'estado selecionado exposto em aria-checked');
  assert.strictEqual((html.match(/data-fonte-marca/g) || []).length, 3, 'marca visual por opção (não depende da cor)');
  assert.ok(html.includes('invisible'), 'marcas não escolhidas ficam invisíveis (não removidas: sem saltos de layout)');
  assert.ok(html.includes('aria-label="Tamanho do texto: Normal"'), 'estado inicial anunciado no botão');
  assert.ok(!/\sstyle=/.test(html), 'sem estilos em linha (a escala vem do CSS global)');

  // O controlo aparece onde já existia o de claro/escuro (cabeçalho, login e
  // seleção de condomínios) — sem criar páginas nem painéis novos.
  for (const ficheiro of ['views/layouts/main.handlebars', 'views/auth/login.handlebars', 'views/condominios/meus.handlebars']) {
    assert.ok(ler(ficheiro).includes('{{> _tema-toggle}}'), `${ficheiro}: controlo de aparência incluído`);
  }
  // No cabeçalho fica exatamente ao lado do botão de claro/escuro.
  assert.ok(
    /\{\{> _tema-toggle\}\}[\s\S]{0,200}?title="Notificações"/.test(ler('views/layouts/main.handlebars')),
    'o botão do tamanho fica na mesma zona do cabeçalho que o do tema'
  );
}

// ── 7. Aviso de documento na aplicação (sem nova janela) ────────────
function testarAvisoDeDocumento() {
  const app = ler('public/js/app.js');
  assert.ok(app.includes('window.GesConduAviso'), 'existe a caixa de aviso na aplicação');
  assert.ok(/modo:\s*'aviso'/.test(app), 'a mesma caixa funciona em modo aviso (só "Fechar")');
  assert.ok(app.includes('modalConfirmarCancelar'), 'o botão Cancelar é escondido no modo aviso');
  assert.ok(app.includes('data-fonte') === false, 'app.js não trata da escala (é do tema.js)');

  // Interceção dos links de documento: verifica antes de abrir.
  assert.ok(/a\[href\*="\/documentos\/"\]\[href\*="\/ficheiro"\]/.test(app), 'interceta os links de documentos');
  assert.ok(/\/documentos\\\/\\d\+\\\/ficheiro|documentos\\\/\\d\+\\\/ficheiro/.test(app), 'só documentos com id (não o link temporário)');
  assert.ok(app.includes("verificacao=1"), 'pede a verificação prévia ao servidor');

  const modal = ler('views/partials/_modal-confirmar.handlebars');
  assert.ok(modal.includes('id="modalConfirmarCancelar"'), 'a modal identifica o botão Cancelar');
  assert.ok(modal.includes('GesConduAviso'), 'a modal documenta o modo aviso');

  // Rotas: verificação responde JSON e não entrega o ficheiro.
  for (const ficheiro of ['routes/documentos.js', 'routes/condomino.js']) {
    const rota = ler(ficheiro);
    assert.ok(rota.includes("req.query.verificacao === '1'"), `${ficheiro}: aceita a verificação prévia`);
    assert.ok(rota.includes('verificarDocumento('), `${ficheiro}: usa a verificação da camada de acesso`);
  }
  const acesso = ler('helpers/documentos-acesso.js');
  assert.ok(/async function verificarDocumento/.test(acesso), 'verificarDocumento existe');
  assert.ok(acesso.includes('abertura.fluxo.destroy()'), 'a verificação fecha o fluxo (não descarrega o ficheiro)');
}

console.log('');
// ── 8. Estilos em linha das vistas ──────────────────────────────────
// Um font-size em px dentro de um style="…" não acompanha a escala (e vence a
// folha de estilos). Todas as vistas usam rem nesses casos.
function testarEstilosEmLinha() {
  const raiz = path.join(RAIZ, 'views');
  const ficheiros = [];
  (function percorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) percorrer(p);
      else if (/\.handlebars$/.test(e.name)) ficheiros.push(p);
    }
  })(raiz);

  const problemas = [];
  let comFonte = 0;
  for (const f of ficheiros) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/style="([^"]*)"/g)) {
      if (!/font-size/.test(m[1])) continue;
      comFonte += 1;
      if (!/font-size\s*:\s*[\d.]+rem/.test(m[1])) {
        problemas.push(`${path.relative(RAIZ, f)}: ${m[1]}`);
      }
    }
  }
  assert.ok(ficheiros.length > 90, `vistas analisadas (${ficheiros.length})`);
  assert.ok(comFonte > 20, `estilos em linha com font-size analisados (${comFonte})`);
  assert.deepStrictEqual(problemas, [], `font-size em linha fora da escala: ${problemas.join(' | ')}`);
}

testarEscalaNoCss();
console.log('✓ escala de texto: tokens, níveis e tamanho de referência');
testarCoberturaDaEscala();
console.log('✓ cobertura: toda a tipografia escalável acompanha a escala (folha do PDF intacta)');
testarTipografiaGlobal();
console.log('✓ tipografia global: Inter com pilha de reserva e pesos 400/500/600/700');
testarAplicacaoAntecipada();
console.log('✓ preferência aplicada antes do CSS (sem flash), nos dois layouts');
testarComportamentoDaFonte();
console.log('✓ preferência persistente em localStorage e independente do tema');
testarControloNaInterface();
console.log('✓ controlo junto do claro/escuro, acessível e em PT-PT');
testarAvisoDeDocumento();
console.log('✓ aviso de documento numa caixa da aplicação (sem nova janela)');
testarEstilosEmLinha();
console.log('✓ estilos em linha das vistas acompanham a escala (rem, nunca px)');
console.log('✓ Testes de tipografia e acessibilidade passaram (sem rede/BD).');
