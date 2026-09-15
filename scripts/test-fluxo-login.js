// ═══════════════════════════════════════════════════════════════════
// Fluxo de entrada — ordem dos passos e neutralidade das páginas públicas.
//
// Monta os routers REAIS (routes/auth.js, routes/index.js e
// routes/condominios.js) com o mesmo motor de vistas do app.js e duplos de
// base de dados (sem BD e sem rede externa), e percorre o fluxo com um cliente
// HTTP que guarda o cookie de sessão.
//
// Fixa dois invariantes que estavam quebrados:
//
//  1. A ENTRADA é a última fronteira: o workspace e o condomínio selecionado
//     nunca são apresentados antes de o segundo fator estar validado. O
//     percurso é
//         credenciais → verificação em duas etapas → autenticação concluída
//         → escolha de condomínio → área de trabalho
//     e não «entrada → workspace parcialmente carregado → 2.º fator → voltar
//     atrás». Quando o browser já tinha uma sessão autenticada (outra conta
//     aberta), a página do 2.º fator era servida DENTRO do workspace dessa
//     sessão — barra lateral, seletor de condomínio, barra mobile e nome do
//     utilizador — e o código validado trocava a identidade, devolvendo o
//     utilizador à escolha de condomínio.
//
//  2. Neutralidade da entrada: título, conteúdo e metadados referem a aplicação
//     (GesCondu) e nunca um condomínio concreto. O contexto de condomínio só
//     existe depois de haver sessão autenticada.
//
// O mecanismo de segurança não é tocado por este teste além de o verificar:
// o TOTP, os códigos de recuperação, o limite de tentativas, o rate limiting e
// as auditorias continuam exatamente os mesmos (asserções no fim).
//
// Utilização: node scripts/test-fluxo-login.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const { engine } = require('express-handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const doisFatores = require('../helpers/doisfatores');

// ── Dados de teste ─────────────────────────────────────────────────
const SENHA = 'palavra-passe-de-teste';
const HASH = bcrypt.hashSync(SENHA, 10);
const SEGREDO = doisFatores.gerarSegredoTOTP();
const COND = {
  id: 1,
  designacao: 'Condomínio Exemplo — Rua das Flores',
  morada: 'Rua das Flores 1',
  localidade: 'Lisboa',
  estado: 'ativo',
};
// Como uma instância do Sequelize, o duplo expõe toJSON() (o middleware de
// app.js converte o condomínio com toJSON antes de o entregar às vistas).
COND.toJSON = function toJSON() {
  return { id: this.id, designacao: this.designacao, morada: this.morada, localidade: this.localidade, estado: this.estado };
};

const utilizador = {
  id: 42,
  nome: 'Ana Teste',
  email: 'ana@exemplo.pt',
  password_hash: HASH,
  ativo: true,
  email_confirmado: true,
  role: 'leitura',
  role_global: null,
  two_fa_ativo: false,
  two_fa_metodo: 'totp',
  two_fa_totp_secret: SEGREDO,
  two_fa_email_tentativas: 0,
  async update(dados) { Object.assign(this, dados); return this; },
  toJSON() { return { ...this }; },
};

// ── Duplos de base de dados e auditoria ────────────────────────────
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    User: {
      findByPk: async (id) => (Number(id) === utilizador.id ? utilizador : null),
      findOne: async ({ where }) => (where.email === utilizador.email ? utilizador : null),
    },
    UserCondominio: {
      findAll: async () => [{ id: 1, utilizador_id: utilizador.id, condominio_id: COND.id, role: 'leitura', estado: 'ativo', condominio: COND }],
      findOne: async ({ where }) => (Number(where.condominio_id) === COND.id ? { id: 1, role: 'leitura', condominio_id: COND.id } : null),
    },
    Condominio: { findOne: async () => COND, findByPk: async () => COND },
    Fracao: { findAll: async () => [], count: async () => 3 },
    Aviso: { count: async () => 0 },
  },
};
const auditPath = require.resolve('../helpers/audit');
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true, children: [], paths: [],
  exports: { audit: async () => ({}), auditSafe: async () => ({}) },
};

const { getCondominio } = require('../helpers/condominio');
const tenant = require('../helpers/tenant');
require('../config/passport')(passport);

// ── Aplicação de teste (mesmo motor de vistas do app.js) ───────────
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
app.use(session({ secret: 'teste', resave: false, saveUninitialized: false, rolling: true }));
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Locais globais: réplica do middleware de app.js para as chaves que as páginas
// de entrada usam. A linha decisiva (o contexto de condomínio só é lido com
// sessão) é verificada no fim, diretamente no app.js, para não haver deriva.
app.use(async (req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.user = req.user || null;
  res.locals.isAdmin = !!(req.user && (req.user.role === 'admin' || req.user.role_global === 'super_admin'));
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = null;
  let condominio = req.user ? await getCondominio() : null;
  if (req.user) {
    const meus = await tenant.listarCondominios(req.user.id);
    res.locals.meusCondominios = meus;
    const ativoId = tenant.ativo(req);
    const escolhido = meus.find((c) => c.id === ativoId) || null;
    if (!escolhido && ativoId) delete req.session.condominio_ativo_id;
    res.locals.condominioAtivo = escolhido;
    if (escolhido) {
      req.session.condominio_ativo_id = escolhido.id;
      condominio = await getCondominio({ id: escolhido.id });
    }
  }
  res.locals.condominio = condominio ? condominio.toJSON() : null;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = 2026;
  res.locals.currentPath = req.path;
  res.locals.avisosRecentes = 0;
  res.locals.tarefas = { ativas: 0, emErro: 0 };
  next();
});

// Página usada para provar o título do layout com um objeto de condomínio
// presente nos locais (nunca deve aparecer sem condomínio ativo).
app.get('/__titulo', (req, res) => {
  res.render('auth/login', {
    titulo: 'Entrar',
    expirada: false,
    user: null,
    condominio: { designacao: COND.designacao },
    condominioAtivo: null,
  });
});
app.get('/__titulo-ativo', (req, res) => {
  res.render('auth/login', {
    titulo: 'Entrar',
    expirada: false,
    user: { nome: 'Ana Teste' },
    condominio: { designacao: COND.designacao },
    condominioAtivo: { id: COND.id, designacao: COND.designacao, role: 'leitura' },
  });
});
// Área de trabalho (marcador): só é alcançável depois de tudo validado.
app.get('/condomino', (req, res) => res.status(200).send('<p id="area-trabalho">área do condómino</p>'));

app.use('/', require('../routes/index'));
app.use('/', require('../routes/condominios'));
app.use('/', require('../routes/auth'));

// ── Cliente HTTP com cookie de sessão ──────────────────────────────
let cookie = null;
function pedir(metodo, url, corpo) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const dados = corpo ? new URLSearchParams(corpo).toString() : null;
      const cabecalhos = {};
      if (cookie) cabecalhos.Cookie = cookie;
      if (dados) {
        cabecalhos['Content-Type'] = 'application/x-www-form-urlencoded';
        cabecalhos['Content-Length'] = Buffer.byteLength(dados);
      }
      const req = http.request(
        { host: '127.0.0.1', port: servidor.address().port, path: url, method: metodo, headers: cabecalhos },
        (res) => {
          const set = res.headers['set-cookie'];
            if (set && set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
            let html = '';
            res.on('data', (d) => { html += d; });
            res.on('end', () => {
              servidor.close();
              resolve({ status: res.statusCode, local: res.headers.location || null, html });
            });
        }
      );
      req.on('error', (e) => { servidor.close(); reject(e); });
      if (dados) req.write(dados);
      req.end();
    });
  });
}

function titulo(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1] : null;
}

// Marcadores da casca de autenticação: as duas páginas do fluxo (entrada e
// verificação em duas etapas) têm de apresentar exatamente os mesmos.
function casca(html) {
  return {
    shell: /class="auth-body auth-shell"/.test(html),
    pagina: /class="auth-page"/.test(html),
    etapa: /class="auth-stage"/.test(html),
    mensagem: /class="auth-message"/.test(html),
    slogan: /class="auth-message-apoio"/.test(html),
    logotipo: /class="auth-logo"[\s\S]{0,160}?src="\/img\/gescondu-logo-ativo\.png"/.test(html),
    cartao: /class="auth-panel"/.test(html),
    cartaoInterior: /class="auth-panel-inner auth-panel-center"/.test(html),
    tituloCartao: /class="auth-titulo"/.test(html),
    subCartao: /class="auth-sub"/.test(html),
    indicacao: /class="auth-hint"/.test(html),
    formulario: /class="auth-form"/.test(html),
    botao: /class="btn btn-primary w-100 auth-btn"/.test(html),
    divisor: /class="auth-divisor"/.test(html),
    opcao: /class="auth-opcao"/.test(html),
    colapso: /class="auth-colapso"/.test(html),
    rodape: /class="auth-foot"/.test(html),
  };
}

// Estilos da casca partilhada, lidos da folha de estilos (fonte única).
function cssAuth() {
  const css = ler('public/css/styles.css');
  return css.slice(css.indexOf('.auth-body.auth-shell'), css.indexOf('.auth-codigo'));
}

// Vestígios de workspace numa página: nenhum pode existir antes do 2.º fator.
const VESTIGIOS_WORKSPACE = [
  ['barra lateral', /class="sidebar"/],
  ['shell da aplicação', /class="app-shell"/],
  ['seletor de condomínio', /id="condominioPill"/],
  ['barra inferior mobile', /mobile-bottom-bar/],
];

function semWorkspace(html, contexto) {
  for (const [nome, re] of VESTIGIOS_WORKSPACE) {
    assert.ok(!re.test(html), `${contexto}: sem ${nome} (nada do workspace antes do 2.º fator)`);
  }
  assert.ok(!html.includes(COND.designacao), `${contexto}: sem o nome do condomínio`);
  assert.ok(!html.includes(utilizador.nome), `${contexto}: sem o nome do utilizador`);
}

const codigoAtual = () => doisFatores.totpParaContador(SEGREDO, Math.floor(Date.now() / 1000 / 30));

// ── 1. Página de entrada: neutra e referente ao GesCondu ───────────
async function testarPaginaDeEntrada() {
  const r = await pedir('GET', '/login');
  assert.strictEqual(r.status, 200, 'GET /login responde 200');
  assert.strictEqual(titulo(r.html), 'Entrar · GesCondu', 'título da entrada: neutro, sem condomínio concreto');
  assert.ok(r.html.includes('Bem-vindo ao GesCondu'), 'a entrada identifica a aplicação (GesCondu)');
  assert.ok(!r.html.includes('ao seu serviço de condomínio'), 'sem referência genérica a "serviço de condomínio"');
  assert.ok(!/condominio|designacao/i.test(r.html), 'a entrada não menciona qualquer condomínio');
  assert.ok(/<meta name="description" content="[^"]*GesCondu/.test(r.html), 'descrição refere o GesCondu');
  assert.ok(r.html.includes('<meta name="robots" content="noindex, nofollow" />'), 'a entrada não deve ser indexada');
  assert.ok(r.html.includes('<html lang="pt-PT">'), 'português de Portugal no documento');
  semWorkspace(r.html, 'entrada');
}

// ── 2. O título nunca mostra um condomínio sem condomínio ativo ────
async function testarTituloDoLayout() {
  const anon = await pedir('GET', '/__titulo');
  assert.strictEqual(titulo(anon.html), 'Entrar · GesCondu', 'sem condomínio ativo, o título refere a aplicação');
  assert.ok(!anon.html.includes(`<title>Entrar · ${COND.designacao}`), 'o condomínio não entra no título sem sessão');

  const ativo = await pedir('GET', '/__titulo-ativo');
  assert.strictEqual(titulo(ativo.html), `Entrar · ${COND.designacao}`, 'com condomínio ativo, o título mantém-se como antes');
}

// ── 3. Percurso completo num browser limpo ─────────────────────────
async function testarPercursoLimpo() {
  cookie = null;
  utilizador.two_fa_ativo = true;

  const cred = await pedir('POST', '/login', { email: utilizador.email, password: SENHA });
  assert.strictEqual(cred.status, 302, 'credenciais válidas → redireciona');
  assert.strictEqual(cred.local, '/2fa/entrar', 'credenciais válidas com 2FA → verificação em duas etapas (nunca o workspace)');
  assert.notStrictEqual(cred.local, '/', 'nunca segue direto para a raiz');

  const pagina = await pedir('GET', '/2fa/entrar');
  assert.strictEqual(pagina.status, 200, 'a página do 2.º fator é servida');
  assert.strictEqual(titulo(pagina.html), 'Verificação em duas etapas · GesCondu', 'título neutro na verificação');
  assert.ok(pagina.html.includes('Verificação em duas etapas'), 'título visível da verificação');
  assert.ok(/Código de verificação/.test(pagina.html), 'campo do código de verificação');
  assert.ok(pagina.html.includes('name="codigo"'), 'campo do código');
  semWorkspace(pagina.html, 'verificação em duas etapas');

  // Antes de o código ser validado não há sessão autenticada: nada de workspace.
  const raiz = await pedir('GET', '/');
  assert.strictEqual(raiz.status, 200, 'a raiz, sem 2.º fator validado, continua a homepage pública');
  assert.ok(!raiz.html.includes('id="area-trabalho"'), 'sem área de trabalho antes da validação');
  const area = await pedir('GET', '/condominios');
  assert.strictEqual(area.status, 302, 'a escolha de condomínio exige autenticação');
  assert.strictEqual(area.local, '/login', 'sem 2.º fator validado, a escolha de condomínio remete para a entrada');

  // Código errado: continua pendente, sem sessão autenticada.
  const errado = await pedir('POST', '/2fa/entrar', { codigo: '000000' });
  assert.strictEqual(errado.status, 302, 'código errado → redireciona de volta');
  assert.strictEqual(errado.local, '/2fa/entrar', 'código errado mantém a verificação pendente');
  const pendente = await pedir('GET', '/condominios');
  assert.strictEqual(pendente.local, '/login', 'código errado não autentica');

  // Código correto: autenticação concluída → escolha de condomínio.
  const ok = await pedir('POST', '/2fa/entrar', { codigo: codigoAtual() });
  assert.strictEqual(ok.status, 302, 'código correto → redireciona');
  assert.strictEqual(ok.local, '/', 'código correto conclui a autenticação');
  const depois = await pedir('GET', '/');
  assert.strictEqual(depois.local, '/condominios', 'autenticação concluída → escolha explícita de condomínio');

  const selecao = await pedir('GET', '/condominios');
  assert.strictEqual(selecao.status, 200, 'a escolha de condomínio é apresentada');
  assert.strictEqual(titulo(selecao.html), 'Os meus condomínios · GesCondu', 'título da escolha de condomínio');
  for (const [, re] of VESTIGIOS_WORKSPACE) {
    assert.ok(!re.test(selecao.html), 'a escolha de condomínio é uma página própria, sem workspace');
  }

  // Só depois da escolha é que a área de trabalho existe.
  const entrar = await pedir('POST', '/condominios/1/entrar');
  assert.strictEqual(entrar.local, '/', 'entrar no condomínio regressa à raiz');
  const workspace = await pedir('GET', '/');
  assert.strictEqual(workspace.local, '/condomino', 'com o condomínio escolhido, segue para a área de trabalho');
  const dentro = await pedir('GET', '/condomino');
  assert.strictEqual(dentro.status, 200, 'a área de trabalho está acessível depois da escolha');
}

// ── 4. Sessão anterior no mesmo browser (o defeito corrigido) ──────
async function testarSessaoAnterior() {
  cookie = null;
  utilizador.two_fa_ativo = false;

  // 1.ª sessão: sem 2FA, com condomínio escolhido → workspace acessível.
  const cred = await pedir('POST', '/login', { email: utilizador.email, password: SENHA });
  assert.strictEqual(cred.local, '/', 'sem 2FA, a autenticação conclui de imediato');
  await pedir('POST', '/condominios/1/entrar');
  const antes = await pedir('GET', '/');
  assert.strictEqual(antes.local, '/condomino', 'sessão anterior: workspace acessível');

  // Nesse browser, a mesma conta (agora com 2FA ativo) inicia sessão de novo.
  utilizador.two_fa_ativo = true;
  const cred2 = await pedir('POST', '/login', { email: utilizador.email, password: SENHA });
  assert.strictEqual(cred2.local, '/2fa/entrar', 'nova entrada com 2FA → verificação');

  const pagina = await pedir('GET', '/2fa/entrar');
  assert.strictEqual(pagina.status, 200, 'verificação servida');
  // O essencial: a sessão anterior não é reaproveitada para apresentar o workspace.
  semWorkspace(pagina.html, '2.º fator com sessão anterior no browser');
  assert.strictEqual(titulo(pagina.html), 'Verificação em duas etapas · GesCondu', 'título neutro na fase pendente');

  // A sessão anterior deixou de existir: nem a escolha de condomínio responde.
  const selecao = await pedir('GET', '/condominios');
  assert.strictEqual(selecao.status, 302, 'a sessão anterior foi encerrada antes do 2.º fator');
  assert.strictEqual(selecao.local, '/login', 'sem identidade durante a fase pendente');

  // Validação do 2.º fator → autenticação concluída → escolha de condomínio.
  const ok = await pedir('POST', '/2fa/entrar', { codigo: codigoAtual() });
  assert.strictEqual(ok.local, '/', 'código correto conclui a autenticação');
  const raiz = await pedir('GET', '/');
  assert.strictEqual(raiz.local, '/condominios', 'volta a pedir a escolha de condomínio (sem saltar para o workspace)');
}

// ── 5. Entrada e 2FA: uma só casca de autenticação ─────────────────
async function testarCascaPartilhada() {
  // Estado pendente: as duas páginas do fluxo disponíveis para comparação.
  cookie = null;
  utilizador.two_fa_ativo = true;
  const cred = await pedir('POST', '/login', { email: utilizador.email, password: SENHA });
  assert.strictEqual(cred.local, '/2fa/entrar', 'estado pendente para comparar as duas páginas');

  const entrada = await pedir('GET', '/login');
  const doisFatores = await pedir('GET', '/2fa/entrar');
  assert.strictEqual(entrada.status, 200, 'entrada servida');
  assert.strictEqual(doisFatores.status, 200, 'página do 2.º fator servida');

  // A mesma composição, marcador a marcador.
  assert.deepStrictEqual(casca(doisFatores.html), casca(entrada.html), 'a entrada e o 2.º fator usam a mesma casca');
  assert.deepStrictEqual(casca(entrada.html), {
    shell: true, pagina: true, etapa: true, mensagem: true, slogan: true, logotipo: true,
    cartao: true, cartaoInterior: true, tituloCartao: true, subCartao: true, indicacao: true,
    formulario: true, botao: true, divisor: true, opcao: true, colapso: true, rodape: true,
  }, 'a casca da entrada é a casca documentada');

  // Nenhuma das duas usa a casca antiga (auth-wrap/auth-card) do 2FA anterior.
  for (const [nome, html] of [['entrada', entrada.html], ['2.º fator', doisFatores.html]]) {
    assert.ok(!/auth-wrap|auth-card/.test(html), `${nome}: sem a casca antiga`);
    assert.ok(!/<style>/.test(html), `${nome}: sem CSS próprio na vista (fonte única na folha de estilos)`);
    assert.ok(html.includes('href="/politica-privacidade"') && html.includes('href="/termos"'), `${nome}: rodapé legal`);
  }

  // O código do 2.º fator tem de ser fácil de introduzir no telemóvel.
  assert.ok(/class="form-control auth-codigo"[\s\S]{0,200}?inputmode="numeric"/.test(doisFatores.html), 'teclado numérico no código');
  assert.ok(/class="form-control auth-codigo"[\s\S]{0,200}?maxlength="6"/.test(doisFatores.html), 'código de 6 dígitos');
  assert.ok(/class="form-control auth-codigo"[\s\S]{0,240}?autocomplete="one-time-code"/.test(doisFatores.html), 'preenchimento do código do sistema');
  assert.ok(/class="form-control auth-codigo"[\s\S]{0,300}?aria-describedby="codigoAjuda"/.test(doisFatores.html), 'ajuda associada ao campo (acessibilidade)');
  // Recuperação: formulário próprio com tipo=recovery (mecanismo inalterado).
  assert.ok(/<input type="hidden" name="tipo" value="recovery" \/>/.test(doisFatores.html), 'código de recuperação envia tipo=recovery');
  assert.ok(/action="\/2fa\/entrar" method="POST"/.test(doisFatores.html), 'os dois formulários usam a mesma rota');
  assert.ok(doisFatores.html.includes('metodoTotp') === false, 'sem variáveis por resolver na vista');

  // Folha de estilos: uma só definição da casca partilhada.
  const bloco = cssAuth();
  assert.ok(bloco.includes('.auth-body.auth-shell { background: var(--auth-bg); padding: 0; }'), 'fundo da casca definido uma vez');
  assert.ok(bloco.includes('.auth-shell .auth-logo img { height: clamp(96px, 9vw, 144px);'), 'logótipo da casca definido uma vez');
  assert.ok(bloco.includes('.auth-shell .auth-message {'), 'coluna do slogan definida uma vez');
  assert.ok(bloco.includes('@media (max-width: 575.98px)'), 'logótipo redimensionado no telemóvel');
  assert.ok(bloco.includes('@media (max-height: 860px)'), 'cartão não é cortado em janelas baixas');
  assert.ok(!/text-overflow|white-space:\s*nowrap/.test(bloco), 'nenhum texto cortado na casca');
  // A vista da entrada deixou de duplicar estas regras.
  const login = ler('views/auth/login.handlebars');
  for (const regra of ['.auth-body { background', '.auth-flash {', '.auth-logo img', '@media (max-height: 860px)']) {
    assert.ok(!login.includes(regra), `views/auth/login.handlebars: regra movida para a folha de estilos (${regra})`);
  }
}

// ── 6. Responsive estrutural (sem browser) ─────────────────────────
function testarResponsiveEstrutural() {
  const css = ler('public/css/styles.css');
  // Campos e botões com área útil confortável (≥48px) nas duas páginas.
  assert.ok(/\.auth-form \.form-control \{ min-height: 48px;/.test(css), 'campos com 48px úteis');
  assert.ok(/\.auth-btn \{ min-height: 48px;/.test(css), 'botões com 48px úteis');
  // O cartão nunca ultrapassa o viewport no telemóvel.
  assert.ok(/@media \(max-width: 575\.98px\) \{\s*\.auth-logo img \{ height: 54px; \}\s*\.auth-panel-inner \{ min-height: 0; padding: 1\.6rem 1\.3rem; \}\s*\.auth-panel \{ max-width: 100%; \}/.test(css), 'cartão a 100% no telemóvel');
  // Largura e proporção do cartão: 480px por omissão, nunca fixa.
  assert.ok(css.includes('--auth-panel-w: 480px;'), 'largura do cartão num único token');
  assert.ok(/\.auth-panel \{\s*width: 100%; max-width: var\(--auth-panel-w, 480px\);/.test(css), 'cartão fluido até 480px');
  // Duas colunas só a partir de 992px (abaixo disso é uma coluna: não é um
  // desktop comprimido).
  assert.ok(/@media \(min-width: 992px\) \{\s*\.auth-stage \{ grid-template-columns: minmax\(0, 1\.3fr\) minmax\(0, 1fr\); \}/.test(css), 'duas colunas apenas a partir de 992px');
  assert.ok(/grid-template-columns: minmax\(0, 1fr\);/.test(css), 'uma coluna por omissão');
  // Altura: viewport dinâmico no telemóvel (sem barra cortada pelo browser).
  assert.ok(/\.auth-page \{ min-height: 100vh; min-height: 100dvh;/.test(css), 'altura com 100dvh no telemóvel');
  // Código do 2.º fator legível e centrado.
  assert.ok(/\.auth-codigo \{\s*font-size: 1\.35rem;\s*letter-spacing: 0\.3em;\s*text-align: center;/.test(css), 'código grande, espaçado e centrado');
}

// ── 7. O mecanismo de segurança não foi alterado ───────────────────
function testarMecanismoIntacto() {
  const auth = ler('routes/auth.js');

  // Mesmo rate limiting e mesmo limite de tentativas.
  assert.ok(auth.includes('const limite2fa = createLimiter({'), 'rate limiting do 2.º fator mantido');
  assert.ok(/router\.post\('\/2fa\/entrar', limite2fa,/.test(auth), 'limite aplicado à verificação');
  assert.ok(auth.includes('user.two_fa_email_tentativas >= 5'), 'limite de 5 tentativas mantido');
  assert.ok(auth.includes('two_fa_email_tentativas: (user.two_fa_email_tentativas || 0) + 1'), 'tentativas continuam a contar');

  // Mesmas primitivas de verificação.
  assert.ok(auth.includes('doisFatores.verificarTOTP(user.two_fa_totp_secret, codigo)'), 'TOTP inalterado');
  assert.ok(auth.includes('doisFatores.consumirRecovery(user.two_fa_recovery_hash, codigo)'), 'códigos de recuperação inalterados');
  assert.ok(auth.includes('doisFatores.hashCodigo(codigo)'), 'código por email inalterado');

  // Mesmas auditorias.
  for (const acao of ['2fa_pedido', '2fa_codigo_enviado', '2fa_falhou', '2fa_verificado', 'inicio_sessao']) {
    assert.ok(auth.includes(`acao: '${acao}'`), `auditoria mantida: ${acao}`);
  }

  // A sessão só passa a autenticada depois do 2.º fator: req.login aparece
  // apenas no ramo sem 2FA e no fim da verificação.
  assert.strictEqual((auth.match(/req\.login\(/g) || []).length, 2, 'req.login apenas nos dois pontos de conclusão');
  const inicioPendente = auth.indexOf('if (user.two_fa_ativo) {');
  const fimPendente = auth.indexOf('req.login(user, (e) => {');
  assert.ok(inicioPendente > -1 && fimPendente > inicioPendente, 'ramo pendente do 2.º fator localizado');
  const ramoPendente = auth.slice(inicioPendente, fimPendente);
  assert.ok(!ramoPendente.includes('req.login('), 'no ramo pendente do 2.º fator nunca se inicia sessão');
  assert.ok(ramoPendente.includes('await limparSessaoAntesDo2fa(req, user.id)'), 'a sessão anterior é encerrada ao entrar na fase pendente');

  // Limpeza estrutural: nada de identidade nem de condomínio herdados.
  const limpeza = auth.slice(auth.indexOf('async function limparSessaoAntesDo2fa'), auth.indexOf('// ── Estado da sessão'));
  assert.ok(limpeza.includes('req.logout('), 'termina a sessão anterior');
  assert.ok(limpeza.includes('delete req.session.condominio_ativo_id'), 'remove o condomínio selecionado');
  assert.ok(limpeza.includes('req.session.pendente2faLogin = pendente'), 'mantém apenas o identificador pendente');
  for (const rota of ["router.get('/2fa/entrar'", "router.post('/2fa/entrar'"]) {
    const trecho = auth.slice(auth.indexOf(rota));
    assert.ok(trecho.slice(0, 700).includes('limparSessaoAntesDo2fa'), `${rota}: garantia aplicada`);
  }
  assert.ok(auth.includes('if (!user || !user.two_fa_ativo)'), 'a verificação pendente exige um utilizador com 2FA ativo');

  // Contexto de condomínio só com sessão (a fuga original vinha daqui).
  assert.ok(
    ler('app.js').includes('let condominio = req.user ? await getCondominio() : null;'),
    'app.js não lê o condomínio em pedidos sem sessão'
  );
  assert.ok(
    !ler('views/layouts/main.handlebars').includes('{{#if titulo}}{{titulo}} · {{/if}}{{condominio.designacao}}'),
    'o título do layout não usa o condomínio lido sem sessão'
  );
}

// Trecho de uma rota num ficheiro: do seu início até ao início da rota seguinte.
function trechoDaRota(fonte, marca) {
  const inicio = fonte.indexOf(marca);
  if (inicio === -1) return '';
  const seguinte = fonte.indexOf('router.get(', inicio + marca.length);
  return fonte.slice(inicio, seguinte > -1 ? seguinte : fonte.length);
}

// ── 8. Páginas de conta na mesma casca e fora do índice ────────────
// Recuperação, redefinição e convite são passos do mesmo fluxo de entrada: usam
// a composição .auth-* (não a antiga .auth-wrap/.auth-card clara), não devem ser
// indexadas e não podem aparecer dentro do workspace.
function testarPaginasDeConta() {
  const auth = ler('routes/auth.js');
  const layout = ler('views/layouts/main.handlebars');

  const vistas = [
    ['views/auth/recuperar.handlebars', 'Recuperar palavra-passe'],
    ['views/auth/redefinir.handlebars', 'Definir nova palavra-passe'],
    ['views/auth/aceitar-convite.handlebars', 'Aceitar convite'],
  ];
  for (const [ficheiro, titulo] of vistas) {
    const v = ler(ficheiro);
    // Mesma composição marcador a marcador da entrada e do 2.º fator.
    for (const classe of ['class="auth-page"', 'class="auth-stage"', 'class="auth-message"', 'class="auth-logo"',
      'class="auth-panel"', 'class="auth-panel-inner auth-panel-center"', 'class="auth-titulo"',
      'class="auth-sub"', 'class="auth-hint"', 'class="auth-form"', 'class="auth-foot"']) {
      assert.ok(v.includes(classe), `${ficheiro}: usa a casca de autenticação (${classe})`);
    }
    assert.ok(v.includes('btn btn-primary w-100 auth-btn'), `${ficheiro}: botão principal da casca`);
    assert.ok(v.includes('src="/img/gescondu-logo-ativo.png"'), `${ficheiro}: logótipo sobre fundo escuro (o mesmo da entrada)`);
    assert.ok(v.includes('<footer class="auth-foot">') && v.includes('href="/politica-privacidade"'), `${ficheiro}: rodapé legal`);
    assert.ok(/<h1 class="auth-titulo">/.test(v), `${ficheiro}: um só título principal do cartão`);
    // Nada da casca antiga clara, nem CSS próprio na vista.
    assert.ok(!/auth-wrap|auth-card|login-logo/.test(v), `${ficheiro}: sem a casca antiga (.auth-wrap/.auth-card)`);
    assert.ok(!/<style>/.test(v), `${ficheiro}: sem CSS próprio na vista (fonte única na folha de estilos)`);
    assert.ok(!/\{\{.*condominio/i.test(v), `${ficheiro}: não mostra qualquer condomínio`);
    assert.ok(v.includes(titulo), `${ficheiro}: mantém o título funcional`);
  }

  // A rota passa a casca e as metas neutras — pelo mecanismo existente.
  for (const marca of ["router.get('/recuperar',", "router.get('/redefinir/:token',", "router.get('/aceitar-convite/:token',"]) {
    const trecho = trechoDaRota(auth, marca);
    assert.ok(trecho.length > 0, `${marca}: rota existe`);
    assert.ok(trecho.includes("corpoClass: 'auth-shell'"), `${marca}: marcada como casca de autenticação`);
    assert.ok(trecho.includes("metaRobots: 'noindex, nofollow'"), `${marca}: não indexável`);
    assert.ok(trecho.includes('titulo:'), `${marca}: título próprio`);
  }
  // Com sessão, estas páginas não são apresentadas sobre o workspace: a rota
  // encaminha para a área (como /login). Verificado no trecho completo da rota.
  assert.ok(trechoDaRota(auth, "router.get('/recuperar',").includes('isAuthenticated()'),
    'recuperação: com sessão, segue para a área (não mostra a página de conta sobre o workspace)');
  assert.ok(trechoDaRota(auth, "router.get('/redefinir/:token',").includes('isAuthenticated()'),
    'redefinição: com sessão, segue para a área');
  assert.ok(trechoDaRota(auth, "router.get('/aceitar-convite/:token',").includes('isAuthenticated()'),
    'convite: com sessão, segue para a área');

  // O layout não mistura as duas cascas: a área autenticada exige sessão E não
  // ser uma página de entrada.
  assert.ok(/\{\{#if \(and user \(not corpoClass\)\)\}\}/.test(layout),
    'layout: o workspace não é apresentado numa página da casca de autenticação');
  assert.ok(/\{\{#if corpoClass\}\} \{\{corpoClass\}\}\{\{\/if\}\}/.test(layout),
    'layout: a casca `auth-shell` continua a ser aplicada ao <main>');

  // Conta inativa: a rota lê `?conta=inativa` e a entrada explica o estado.
  assert.ok(/contaInativa: req\.query\.conta === 'inativa'/.test(auth), 'entrada: lê o indicador de conta inativa');
  const login = ler('views/auth/login.handlebars');
  assert.ok(/\{\{#if contaInativa\}\}/.test(login), 'entrada: mostra a mensagem de conta inativa');
  assert.ok(/A sua conta encontra-se inativa\. Contacte um administrador para voltar a ter acesso\./.test(login),
    'entrada: mensagem clara e neutra para conta inativa');
  assert.ok(/conta=inativa/.test(ler('helpers/sessao.js')), 'a origem do indicador mantém-se em helpers/sessao.js');
}

// ── Execução ───────────────────────────────────────────────────────
(async () => {
  await testarPaginaDeEntrada();
  await testarTituloDoLayout();
  await testarPercursoLimpo();
  await testarSessaoAnterior();
  await testarCascaPartilhada();
  testarResponsiveEstrutural();
  testarMecanismoIntacto();
  testarPaginasDeConta();
  console.log('✓ Testes do fluxo de entrada (login → 2FA → condomínio) passaram, sem base de dados.');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
