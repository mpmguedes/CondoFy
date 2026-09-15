// ═══════════════════════════════════════════════════════════════════
// Homepage pública e pedido de acesso — testes offline.
//
// Monta os routers reais (routes/index.js e routes/publicas.js) com o mesmo
// motor de vistas do app.js e SEM autenticação: é assim que se prova que a
// homepage é pública e que o login continua a funcionar à parte.
//
// Verifica:
//  · GET / responde 200 sem sessão, sem redirecionar para o login;
//  · título, descrição, canónica, Open Graph e dados estruturados (JSON-LD);
//  · o nome GesCondu está visível (requisito da verificação de marca Google);
//  · as secções e os mockups exigidos existem;
//  · TODAS as ligações internas resolvem (rota conhecida ou âncora existente);
//  · TODOS os recursos referidos (css/js/img) existem em public/;
//  · o acesso é apresentado como sendo por convite, no hero, no CTA e no rodapé;
//  · NÃO há preços, testemunhos, estatísticas, promessas absolutas nem
//    funcionalidades por implementar (módulos que são apenas placeholders);
//  · a página funciona sem JavaScript (conteúdo no HTML, menu em <details>);
//  · a identidade visual é só de tokens (a folha da homepage não inventa cores);
//  · o percurso de quem tem sessão e o convite para novos utilizadores ficam
//    intactos (routes/index.js e routes/auth.js).
// Utilização: node scripts/test-homepage.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const routerIndex = require('../routes/index');
const routerPublicas = require('../routes/publicas');

// ── App de teste: mesmo motor de vistas, visitante anónimo ──────────
function criarApp() {
  const app = express();
  app.engine('handlebars', engine({
    defaultLayout: 'main',
    helpers: require('../helpers/handlebars-helpers'),
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use((req, res, next) => {
    req.isAuthenticated = () => false;
    req.user = null;
    req.flash = () => req;
    res.locals.user = null;
    res.locals.isAdmin = false;
    res.locals.meusCondominios = [];
    res.locals.condominioAtivo = null;
    res.locals.condominio = null;
    res.locals.currentPath = req.path;
    res.locals.appName = 'GesCondu';
    res.locals.currentYear = new Date().getFullYear();
    next();
  });
  app.use('/', routerPublicas);
  app.use('/', routerIndex);
  return app;
}

const app = criarApp();

const pedir = (url) => new Promise((resolve, reject) => {
  const servidor = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: servidor.address().port, path: url }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        servidor.close();
        resolve({ status: res.statusCode, corpo, cabecalhos: res.headers });
      });
    }).on('error', (e) => { servidor.close(); reject(e); });
  });
});

// ── Utilitários de análise do HTML ─────────────────────────────────
const ESTATICO = /^\/(css|js|img)\//;
const ROTAS_CONHECIDAS = new Set(['/', '/login', '/pedir-acesso', '/politica-privacidade', '/termos']);

function ligacoes(html) {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}
function recursos(html) {
  const lista = [];
  for (const m of html.matchAll(/(?:href|src)="(\/(?:css|js|img)\/[^"]+)"/g)) lista.push(m[1]);
  return [...new Set(lista)];
}
function ids(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}
function semAcentos(texto) {
  return String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
// O Handlebars escapa caracteres dentro de atributos (por exemplo «=» fica
// «&#x3D;»): para comparar links pelo que o browser vê, descodifica-se.
function descodificarHtml(texto) {
  return String(texto)
    .replace(/&#x3D;/g, '=')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ── 1. Conteúdo proibido (honestidade) ─────────────────────────────
const PROIBIDO = [
  [/\bgr[áa]tis\b/i, 'nada é apresentado como gratuito'],
  [/criar conta/i, 'não há criação pública de conta'],
  [/criar uma conta(?! por convite)/i, 'não há criação pública de conta'],
  [/come[çc]ar agora|comece agora|come[çc]ar j[áa]/i, 'sem CTA de registo imediato'],
  [/registe-se|registo aberto|sign[- ]?up/i, 'sem registo público'],
  [/revolucion[áa]ri/i, 'sem linguagem exagerada'],
  [/game[- ]?changer/i, 'sem linguagem exagerada'],
  [/n[ºo]\s?1\b|n[úu]mero um\b|a plataforma n[ºo]1/i, 'sem afirmações de liderança'],
  [/a mais completa|a melhor do|a solu[çc][ãa]o definitiva/i, 'sem afirmações absolutas'],
  [/milhares de|centenas de condom[íi]nios|mais de \d+ (condom[íi]nios|utilizadores)/i, 'sem estatísticas inventadas'],
  [/testemunh|depoimento|«[^»]{20,}»\s*—/i, 'sem testemunhos'],
  [/\bpre[çc]os?\b|\d+\s*€\s*\/\s*(m[êe]s|ano)|\/\s*m[êe]s|planos? (de pre[çc]os|a partir de)|tabela de pre[çc]os/i, 'sem preços'],
  [/100\s*%\s*(seguro|garantido)|military grade|inviol[áa]vel/i, 'sem garantias absolutas de segurança'],
  [/intelig[êe]ncia artificial|\bIA\b|machine learning/i, 'sem vender IA'],
  [/\bvota[çc][ãa]o (online|eletr[óo]nica)|votar na plataforma/i, 'não existe módulo de votações'],
  [/ocorr[êe]ncias|tickets/i, 'o módulo de ocorrências/tickets não está implementado'],
  [/m[óo]dulo de seguros|ap[óo]lice na plataforma de seguros/i, 'não existe módulo de seguros'],
  [/aplica[çc][ãa]o (para|m[óo]vel) (ios|android)|app store|play store/i, 'não existe aplicação nativa'],
  [/conformidade legal garantida|cumpre toda a legisla[çc][ãa]o|substitui (o|um) (contabilista|advogado|administrador profissional)/i, 'sem afirmações legais não comprovadas'],
  [/adm-?condom[íi]nio|o meu pr[ée]dio|ticas\s?360|condie\b|gestcondo|cond[ōo]\b/i, 'sem referências a outras plataformas'],
];

// ── 2. Termos de Portugal que devem aparecer ──────────────────────
const TERMOS_PT = [
  'condomínio', 'condómino', 'fração', 'permilagem', 'quota', 'quota extraordinária',
  'assembleia', 'ata', 'recibo', 'comprovativo', 'orçamento', 'fornecedor',
  'prestação de contas', 'convocatória', 'contas do condomínio',
];

// ── 3. Secções e mockups obrigatórios ─────────────────────────────
const SECOES = [
  'problema', 'para-quem', 'plataforma', 'funcionalidades', 'em-utilizacao', 'demonstracoes',
  'administrador', 'condomino', 'transparencia', 'automacao', 'documentos', 'relatorios',
  'acessibilidade', 'seguranca', 'portugal', 'titularidade', 'faq', 'conteudo',
];

async function main() {
  const home = await pedir('/');
  const html = home.corpo;

  // ── Página pública ────────────────────────────────────────────────
  assert.strictEqual(home.status, 200, 'GET / responde 200 sem sessão');
  assert.strictEqual(home.cabecalhos.location, undefined, 'não redireciona para o login');

  // ── SEO ───────────────────────────────────────────────────────────
  assert.ok(
    html.includes('<title>GesCondu — Gestão de condomínios simples, organizada e transparente</title>'),
    'título de SEO presente e começado pelo nome do produto'
  );
  const helperSeo = require('../helpers/home-publica');
  assert.ok(html.includes(`<meta name="description" content="${helperSeo.DESCRICAO_HOME}" />`), 'meta description presente');
  assert.ok(/<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/" \/>/.test(html), 'canónica com o domínio do pedido');
  assert.ok(html.includes('<meta property="og:title"'), 'Open Graph: título');
  assert.ok(html.includes('<meta property="og:description"'), 'Open Graph: descrição');
  assert.ok(html.includes('<meta property="og:site_name" content="GesCondu" />'), 'Open Graph: nome do site');
  assert.ok(html.includes('<meta property="og:locale" content="pt_PT" />'), 'Open Graph: idioma pt_PT');
  assert.ok(html.includes('<html lang="pt-PT">'), 'documento declarado em português de Portugal');

  // Dados estruturados: válidos e sem nada inventado.
  const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(jsonLd, 'dados estruturados presentes');
  const dados = JSON.parse(jsonLd[1]);
  const tipos = dados['@graph'].map((n) => n['@type']);
  for (const tipo of ['WebSite', 'SoftwareApplication', 'FAQPage']) {
    assert.ok(tipos.includes(tipo), `dados estruturados incluem ${tipo}`);
  }
  assert.ok(!/offers|aggregateRating|review|price/i.test(jsonLd[1]), 'dados estruturados sem preços nem avaliações');
  const faqLd = dados['@graph'].find((n) => n['@type'] === 'FAQPage');
  assert.strictEqual(faqLd.mainEntity.length, helperSeo.FAQ.length, 'a FAQ declarada é a mesma que a apresentada');

  // ── Nome da aplicação visível (verificação de marca Google) ───────
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) || [];
  assert.strictEqual(h1.length, 1, 'exatamente um título principal');
  assert.ok(/<p class="hp-hero-marca">[\s\S]{0,120}<strong>GesCondu<\/strong>/.test(html), 'nome GesCondu em destaque no hero');
  assert.ok(html.includes('alt="GesCondu"'), 'logótipo com o nome acessível');
  assert.ok(html.includes('© ' + new Date().getFullYear() + ' GesCondu'), 'rodapé com o nome e o ano');

  // ── Acessibilidade dos ícones ─────────────────────────────────────
  // Os mockups são anunciados como uma única imagem (role="img" + aria-label),
  // pelo que os ícones que estão dentro deles não precisam de ser marcados. Nos
  // restantes componentes da página, todos os ícones são decorativos e ficam
  // fora da leitura em voz alta.
  const vistasComIcones = [
    'views/publicas/home.handlebars',
    'views/publicas/pedir-acesso.handlebars',
    'views/partials/_home-cabecalho.handlebars',
    'views/partials/_home-rodape.handlebars',
  ];
  // Um ícone pode ser decorativo por si (aria-hidden no próprio) ou por estar
  // dentro de um contentor já escondido (aria-hidden ou role="img").
  const ancestralOculto = (src, index) => {
    const anteriores = [...src.slice(0, index).matchAll(/<(span|div|a|p|li|section|header|footer|nav)\b[^>]*>/g)];
    if (!anteriores.length) return false;
    const ultimo = anteriores[anteriores.length - 1][0];
    return ultimo.includes('aria-hidden') || ultimo.includes('role="img"');
  };
  const iconesSemOcultar = [];
  for (const ficheiro of vistasComIcones) {
    const src = ler(ficheiro);
    for (const m of src.matchAll(/<span class="material-symbols-outlined"[^>]*>/g)) {
      if (m[0].includes('aria-hidden')) continue;
      if (ancestralOculto(src, m.index)) continue;
      iconesSemOcultar.push(`${ficheiro}: linha ${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepStrictEqual(iconesSemOcultar, [], `ícones decorativos fora dos mockups sem aria-hidden: ${iconesSemOcultar.join(' | ')}`);
  for (const mockup of ['dashboard', 'quotas', 'relatorio', 'documentos', 'assembleia', 'mobile']) {
    const src = ler(`views/partials/_home-mock-${mockup}.handlebars`);
    assert.ok(/role="img"\s+aria-label="[^"]{40,}"/.test(src), `mockup ${mockup}: descrito para leitores de ecrã`);
  }
  assert.ok(/<a class="hp-skip" href="#conteudo">/.test(html), 'ligação para saltar para o conteúdo');
  assert.ok(ids(html).has('conteudo'), 'o destino da ligação de salto existe');
  assert.ok(/<nav[^>]*aria-label="Navegação principal"/.test(html), 'navegação principal identificada');

  // ── Acesso por convite, em vários pontos ──────────────────────────
  const ocorrenciasConvite = (html.match(/acesso (atualmente )?(dispon[íi]vel )?por convite/gi) || []).length;
  assert.ok(ocorrenciasConvite >= 3, `o acesso por convite é dito no hero, no CTA e no rodapé (${ocorrenciasConvite} menções)`);
  assert.ok(html.includes('href="/pedir-acesso"'), 'CTA para pedir acesso');
  assert.ok(html.includes('href="/login"'), 'CTA para entrar (login mantido)');
  assert.ok(!/href="\/registar|href="\/signup|href="\/registo/.test(html), 'sem ligação para registo público');

  // ── Secções ───────────────────────────────────────────────────────
  const listaIds = ids(html);
  for (const id of SECOES) assert.ok(listaIds.has(id), `secção #${id} presente`);

  // ── Mockups da própria interface ──────────────────────────────────
  const mockups = [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(mockups.length >= 6, `pelo menos 6 mockups com descrição acessível (${mockups.length})`);
  for (const pedaco of ['Painel do administrador', 'mapa de quotas', 'relatório financeiro', 'documentos', 'assembleia', 'portal do condómino']) {
    assert.ok(mockups.some((m) => semAcentos(m).toLowerCase().includes(semAcentos(pedaco).toLowerCase())), `mockup descrito: ${pedaco}`);
  }
  assert.ok(html.includes('class="mk-telemovel"'), 'mockup do telemóvel (portal do condómino) presente');
  assert.ok(html.includes('class="mk-lateral"'), 'mockup com a barra lateral da aplicação');

  // Tabelas dos mockups: cada uma define as larguras das colunas no <colgroup>,
  // para que os valores fiquem alinhados com os títulos (e as tabelas do mesmo
  // mockup alinhem entre si). Uma coluna por cabeçalho, sem exceções.
  const tabelas = html.split('<table class="mk-tabela">').slice(1);
  assert.ok(tabelas.length >= 4, `tabelas de mockup presentes (${tabelas.length})`);
  tabelas.forEach((tabela, indice) => {
    const colgroup = tabela.slice(tabela.indexOf('<colgroup>'), tabela.indexOf('</colgroup>'));
    const cols = (colgroup.match(/<col\b/g) || []).length;
    const cabecalhos = (tabela.slice(0, tabela.indexOf('</thead>')).match(/<th\b/g) || []).length;
    assert.strictEqual(cols, cabecalhos, `tabela de mockup ${indice + 1}: uma coluna por cabeçalho (${cols}/${cabecalhos})`);
    assert.ok(/<col class="(num|estreita|estado|data)" \/>/.test(colgroup), `tabela de mockup ${indice + 1}: colunas com largura definida`);
  });
  // As duas tabelas do relatório financeiro têm de ter colunas de valores com a
  // mesma largura (é o que faz os números alinharem entre elas).
  const relatorio = ler('views/partials/_home-mock-relatorio.handlebars');
  const colgroups = [...relatorio.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  assert.strictEqual(colgroups.length, 2, 'relatório: duas tabelas de valores');
  assert.strictEqual(colgroups[0], colgroups[1], 'relatório: as duas tabelas partilham as mesmas larguras de coluna');

  // ── Ligação internas e recursos ───────────────────────────────────
  const quebradas = [];
  for (const href of ligacoes(html)) {
    if (href.startsWith('mailto:') || href.startsWith('http')) continue;
    if (href.startsWith('#')) {
      if (!listaIds.has(href.slice(1))) quebradas.push(href);
      continue;
    }
    if (href.startsWith('/#')) {
      if (!listaIds.has(href.slice(2))) quebradas.push(href);
      continue;
    }
    if (ESTATICO.test(href)) continue;
    if (!ROTAS_CONHECIDAS.has(href.split('?')[0])) quebradas.push(href);
  }
  assert.deepStrictEqual(quebradas, [], `sem ligações internas quebradas: ${quebradas.join(' | ')}`);

  const emFalta = recursos(html).filter((r) => !fs.existsSync(path.join(RAIZ, 'public', r.replace(/^\//, '').split('?')[0])));
  assert.deepStrictEqual(emFalta, [], `todos os recursos existem: ${emFalta.join(' | ')}`);
  assert.ok(recursos(html).includes('/css/home.css?v=20260910b'), 'folha de estilos própria da homepage carregada');
  assert.ok(html.includes('src="/js/home.js?v=20260910b"'), 'script próprio da homepage carregado');
  assert.ok(html.includes('loading="lazy"'), 'imagens abaixo do hero com carregamento diferido');

  // ── Funciona sem JavaScript + menu mobile ─────────────────────────
  assert.ok(html.includes('<details class="hp-menu-mobile"'), 'menu mobile em <details> (funciona sem JavaScript)');
  assert.ok(html.includes('<details class="hp-reveal">'), 'perguntas frequentes em <details> (funcionam sem JavaScript)');
  assert.ok(!/_tema-toggle|data-fonte-opcao/.test(html), 'página pública sem controlos de aparência');
  for (const ficheiro of ['views/publicas/home.handlebars', 'views/publicas/pedir-acesso.handlebars', 'views/partials/_home-cabecalho.handlebars', 'views/partials/_home-rodape.handlebars']) {
    assert.ok(!ler(ficheiro).includes('_tema-toggle'), `${ficheiro}: sem controlos de aparência`);
  }

  // ── Mudança de proprietário: as mensagens de confiança ────────────
  // A funcionalidade existe e está validada; a homepage comunica-a sem entrar em
  // detalhes técnicos e sem prometer nada que a aplicação não faça. O texto é
  // comparado com os espaços normalizados (no HTML vem partido por linhas).
  const htmlSeguido = html.replace(/\s+/g, ' ');
  for (const mensagem of [
    'O condomínio continua. As pessoas mudam.',
    'o histórico do condomínio mantém-se — mas o acesso de cada pessoa continua separado',
    'O novo proprietário recebe o seu próprio acesso.',
    'não recebe a conta, as credenciais ou os dados privados do proprietário anterior',
    'Antes de encerrar o acesso, o anterior titular pode preparar a sua saída',
    'Cada pessoa tem o seu próprio acesso',
    'O histórico do condomínio não desaparece porque as pessoas mudam.',
    'Vai deixar o condomínio?',
    'as mudanças de proprietário não interrompem a continuidade do condomínio',
  ]) {
    assert.ok(htmlSeguido.includes(mensagem), `titularidade: mensagem presente na homepage (${mensagem})`);
  }
  assert.ok(/id="hpTitularidadeTitulo">O condomínio continua\. As pessoas mudam\.<\/h2>/.test(html), 'titularidade: título exato');
  for (const proibido of ['fracao_titularidades', 'utilizador_condominio', 'middleware', 'user_id', 'tenant', 'sessão antiga']) {
    assert.ok(!html.includes(proibido), `titularidade: sem detalhes de implementação (${proibido})`);
  }
  assert.ok(!/votar na plataforma|vota[çc][ãa]o eletr[óo]nica/i.test(html), 'titularidade: sem promessa de votações online');
  assert.ok(/sujeitos a vota[çc][ãa]o|assinalados como sujeitos a vota[çc][ãa]o/.test(html),
    'assembleias: os pontos sujeitos a votação são apresentados como marcação na ordem de trabalhos');
  // A demonstração da mudança de proprietário é um mockup real descrito.
  assert.ok(mockups.some((m) => semAcentos(m).toLowerCase().includes('mudanca de proprietario')),
    'titularidade: visual descrito para leitores de ecrã');

  // ── Honestidade ───────────────────────────────────────────────────
  for (const [regex, motivo] of PROIBIDO) {
    assert.ok(!regex.test(html), `homepage: ${motivo} (encontrado: ${(html.match(regex) || [])[0]})`);
  }

  // ── Português de Portugal ─────────────────────────────────────────
  const texto = semAcentos(html).toLowerCase();
  for (const termo of TERMOS_PT) {
    assert.ok(texto.includes(semAcentos(termo).toLowerCase()), `terminologia portuguesa presente: ${termo}`);
  }
  assert.ok(!/\bvoc[êe] (pode|vai)|a gente\b|celular|conta de luz\b/i.test(html), 'sem português do Brasil');

  // ── Identidade visual (só tokens) ─────────────────────────────────
  const css = ler('public/css/home.css');
  const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepStrictEqual([...new Set(hex)], [], `a folha da homepage não inventa cores: ${hex.join(' ')}`);
  for (const token of ['var(--c-primary)', 'var(--nav-bg-image)', 'var(--radius)', 'var(--elev-1)']) {
    assert.ok(css.includes(token), `a homepage usa os tokens da aplicação (${token})`);
  }
  assert.ok(!/--c-[a-z-]+\s*:/.test(css), 'a folha da homepage não redefine tokens do tema');
  // Não se esconde overflow no <body>: se algo transbordar no telemóvel, tem de
  // ser visível no teste (o halo do hero é contido por .hp-hero { overflow:hidden }).
  assert.ok(!/overflow-x:\s*hidden/.test(css), 'sem esconder o overflow horizontal na página');
  assert.ok(/\.hp-hero \{[^}]*overflow:\s*hidden/.test(css), 'o halo decorativo é contido dentro do hero');
  // Nada com largura fixa superior a 360px (telemóveis estreitos não devem poder
  // provocar scroll horizontal): só o contentor usa max-width.
  const largurasFixas = [...css.matchAll(/(?<!max-)width:\s*(\d{3,})px/g)].map((m) => Number(m[1])).filter((n) => n > 360);
  assert.deepStrictEqual(largurasFixas, [], `sem larguras fixas grandes na folha da homepage: ${largurasFixas.join(' ')}`);
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'animações desligadas com prefers-reduced-motion');
  assert.ok(!/@import|https?:\/\//.test(css), 'sem pedidos externos na folha da homepage');
  // Todos os tokens usados existem no design system: um token inventado daria
  // texto invisível ou cores erradas (foi assim que se detetou, por exemplo,
  // texto claro sobre cartão claro nas faixas escuras).
  const folha = ler('public/css/styles.css');
  const definidos = new Set([...folha.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  // Propriedade LOCAL dos mockups (altura das barras do gráfico): é definida em
  // linha no HTML, pelo que não pertence ao design system. (Sem outras: a folha
  // não deve trazer CSS morto.)
  const locais = ['--v'];
  const usados = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const inexistentes = usados.filter((t) => !definidos.has(t) && !locais.includes(t));
  assert.deepStrictEqual(inexistentes, [], `a homepage só usa tokens definidos: ${inexistentes.join(' ')}`);
  assert.ok(usados.length > 20, 'a homepage é composta com os tokens da aplicação');
  const htmlMockups = ['views/publicas/home.handlebars',
    'views/partials/_home-mock-dashboard.handlebars', 'views/partials/_home-mock-quotas.handlebars']
    .map(ler).join('\n');
  for (const local of locais.filter((l) => usados.includes(l))) {
    assert.ok(htmlMockups.includes(`${local}:`), `a propriedade local ${local} é definida no HTML dos mockups`);
  }
  const js = ler('public/js/home.js');
  assert.ok(!/https?:\/\//.test(js), 'sem pedidos externos no script da homepage');
  assert.ok(/prefers-reduced-motion/.test(js), 'o script respeita prefers-reduced-motion');
  assert.ok(js.length < 6000, 'script pequeno (sem bibliotecas)');

  // ── Pedir acesso ──────────────────────────────────────────────────
  const antes = process.env.ACESSO_EMAIL;
  try {
    delete process.env.ACESSO_EMAIL;
    delete process.env.LEGAL_EMAIL;
    let acesso = await pedir('/pedir-acesso');
    assert.strictEqual(acesso.status, 200, 'GET /pedir-acesso responde 200 sem sessão');
    assert.ok(acesso.corpo.includes('<title>Pedir acesso ao GesCondu — acesso por convite</title>'), 'título próprio do pedido de acesso');
    assert.ok(semAcentos(acesso.corpo).toLowerCase().includes('por convite'), 'explica que o acesso é por convite');
    assert.ok(acesso.corpo.includes('Canal de contacto por configurar'), 'sem endereço configurado: di-lo claramente');
    assert.ok(!/mailto:[^"]+/.test(acesso.corpo), 'sem endereço de contacto inventado');
    assert.ok(acesso.corpo.includes('href="/login"'), 'continua a haver caminho para entrar');
    // As ligações «/#secção» desta página apontam para secções da homepage
    // (que é o destino real), por isso são validadas contra os ids da homepage.
    const secoesHome = listaIds;
    const quebradasAcesso = ligacoes(acesso.corpo)
      .filter((h) => !h.startsWith('mailto:') && !h.startsWith('http'))
      .filter((h) => !(h.startsWith('#') && ids(acesso.corpo).has(h.slice(1))))
      .filter((h) => !(h.startsWith('/#') && secoesHome.has(h.slice(2))))
      .filter((h) => !ESTATICO.test(h))
      .filter((h) => !ROTAS_CONHECIDAS.has(h.split('?')[0]));
    assert.deepStrictEqual(quebradasAcesso, [], `pedido de acesso: ligações resolvem (${quebradasAcesso.join(' | ')})`);

    process.env.ACESSO_EMAIL = 'acesso@exemplo.pt';
    acesso = await pedir('/pedir-acesso');
    const acessoDescodificado = descodificarHtml(acesso.corpo);
    assert.ok(
      acessoDescodificado.includes('mailto:acesso@exemplo.pt?subject=Pedido%20de%20acesso%20ao%20GesCondu'),
      'com configuração: liga o pedido ao email definido (com assunto já preparado)'
    );
    assert.ok(/mailto:acesso@exemplo\.pt\?subject=[^"]*body=/.test(acessoDescodificado), 'com configuração: mensagem pré-preenchida');
    assert.ok(acesso.corpo.includes('Escrever para acesso@exemplo.pt'), 'com configuração: mostra o endereço');
    assert.ok(!acesso.corpo.includes('Canal de contacto por configurar'), 'com configuração: sem avisos de configuração');

    // O LEGAL_EMAIL serve de alternativa quando não há ACESSO_EMAIL próprio.
    delete process.env.ACESSO_EMAIL;
    process.env.LEGAL_EMAIL = 'privacidade@exemplo.pt';
    acesso = await pedir('/pedir-acesso');
    assert.ok(descodificarHtml(acesso.corpo).includes('mailto:privacidade@exemplo.pt'), 'usa o LEGAL_EMAIL como alternativa');
  } finally {
    if (antes === undefined) delete process.env.ACESSO_EMAIL;
    else process.env.ACESSO_EMAIL = antes;
    delete process.env.LEGAL_EMAIL;
  }

  // ── SEO técnico: robots.txt e sitemap.xml ─────────────────────────
  const robots = await pedir('/robots.txt');
  assert.strictEqual(robots.status, 200, 'GET /robots.txt responde 200');
  assert.ok(/text\/plain/.test(robots.cabecalhos['content-type'] || ''), 'robots.txt servido como texto simples');
  assert.ok(/^User-agent: \*/m.test(robots.corpo), 'robots.txt com regra para todos os agentes');
  assert.ok(/^Allow: \/$/m.test(robots.corpo), 'robots.txt permite a página inicial');
  for (const privado of ['/admin', '/condomino', '/conta']) {
    assert.ok(robots.corpo.includes(`Disallow: ${privado}`), `robots.txt exclui a área ${privado}`);
  }
  assert.ok(/^Sitemap: http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml$/m.test(robots.corpo), 'robots.txt aponta para o sitemap no domínio do pedido');

  const sitemap = await pedir('/sitemap.xml');
  assert.strictEqual(sitemap.status, 200, 'GET /sitemap.xml responde 200');
  assert.ok(/xml/.test(sitemap.cabecalhos['content-type'] || ''), 'sitemap servido como XML');
  assert.ok(sitemap.corpo.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'sitemap com declaração XML');
  assert.ok(sitemap.corpo.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), 'sitemap com o namespace correto');
  for (const pagina of ['/', '/pedir-acesso', '/politica-privacidade', '/termos']) {
    assert.ok(sitemap.corpo.includes(`<loc>http://127.0.0.1:${sitemap.corpo.match(/127\.0\.0\.1:(\d+)/)[1]}${pagina}</loc>`), `sitemap inclui ${pagina}`);
  }
  assert.ok(!/admin|condomino|conta/.test(sitemap.corpo), 'sitemap sem áreas privadas');

  // ── A aplicação interna não foi alterada ──────────────────────────
  const auth = ler('routes/auth.js');
  assert.ok(/router\.get\('\/login'/.test(auth), 'a rota /login continua registada');
  assert.ok(/router\.get\('\/aceitar-convite\/:token'/.test(auth), 'o convite para novos utilizadores continua disponível');
  assert.ok(/router\.post\('\/aceitar-convite\/:token'/.test(auth), 'a aceitação do convite continua a funcionar');

  const fonteIndex = ler('routes/index.js');
  assert.ok(/if \(!req\.isAuthenticated\(\)\)/.test(fonteIndex), 'a raiz distingue visitante de utilizador com sessão');
  assert.ok(/return res\.redirect\(decisao\.redirecionar\)/.test(fonteIndex), 'quem tem sessão continua a ser encaminhado para a sua área');
  assert.strictEqual(typeof routerIndex.destinoAposLogin, 'function', 'destinoAposLogin continua exportado');
  assert.deepStrictEqual(
    routerIndex.destinoAposLogin({ meus: [], ativo: null, user: {} }),
    { redirecionar: '/condominios', limparAtivo: false },
    'sem condomínio escolhido, o destino após login é o mesmo de antes'
  );
  assert.deepStrictEqual(
    routerIndex.destinoAposLogin({ meus: [{ id: 7 }], ativo: 7, user: { role: 'admin' } }),
    { redirecionar: '/admin', limparAtivo: false },
    'com condomínio escolhido, administrador vai para o painel'
  );
  assert.ok(ler('app.js').includes("app.use('/', require('./routes'));"), 'router da raiz montado no app.js');

  // ── A página de pedido de acesso não expõe dados sensíveis ────────
  assert.ok(!/password|palavra-passe:|\$2[aby]\$/.test(html), 'sem credenciais no HTML');
  assert.ok(!/no[_\s]?index|sequelize|datasource/i.test(html), 'sem detalhes de implementação no HTML');

  console.log('✓ Testes da homepage pública passaram (sem BD, visitante anónimo).');
}

main().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
