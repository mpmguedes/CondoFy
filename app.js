require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const { engine } = require('express-handlebars');
const flash = require('connect-flash');
const passport = require('passport');
const methodOverride = require('method-override');

const sequelize = require('./config/database');
const handlebarsHelpers = require('./helpers/handlebars-helpers');
const { getCondominio } = require('./helpers/condominio');
const tenant = require('./helpers/tenant');
const drive = require('./helpers/drive');
// Fachada de armazenamento (rótulo do serviço principal usado nas vistas).
const storage = require('./helpers/storage');
const mailer = require('./helpers/mailer');
const background = require('./helpers/background-jobs');
const sessao = require('./helpers/sessao');
const { protegerOrigem } = require('./helpers/seguranca');
require('./config/passport')(passport);

const app = express();

// Atrás do Cloudflare Tunnel (proxy), confiar nos cabeçalhos X-Forwarded-*
// para que req.protocol/req.secure reflitam corretamente o HTTPS.
app.set('trust proxy', 1);

// ── Motor de vistas (Handlebars) ───────────────────────────────────
app.engine(
  'handlebars',
  engine({
    defaultLayout: 'main',
    helpers: handlebarsHelpers,
    runtimeOptions: {
      allowProtoPropertiesByDefault: true,
      allowProtoMethodsByDefault: true,
    },
  })
);
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

// ── Sessão ─────────────────────────────────────────────────────────
// Cookie com a mesma duração da inatividade permitida e renovação a cada
// pedido (rolling): a sessão acompanha a atividade do utilizador e expira
// sozinha ao fim de SESSION_IDLE_MINUTOS sem pedidos (defeito 2 h).
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'condofy-dev-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: sessao.IDLE_MS,
    },
  })
);

// ── Body parsing + method override ─────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// ── CSRF (origem) ──────────────────────────────────────────────────
// Bloqueia pedidos de escrita com origem diferente da aplicação.
app.use(protegerOrigem);

// ── Passport + flash ───────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// ── Bloqueio automático por inatividade ────────────────────────────
// Encerra a sessão (e obriga a novo login) quando passam SESSION_IDLE_MINUTOS
// sem atividade. Corre antes das rotas e dos ficheiros estáticos não conta.
app.use(sessao.middlewareSessao);

// ── Variáveis globais nas views ────────────────────────────────────
app.use(async (req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.error = req.flash('error');
  res.locals.user = req.user || null;
  res.locals.isAdmin = !!(req.user && (req.user.role === 'admin' || req.user.role_global === 'super_admin'));
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = null;
  let condominio = await getCondominio();
  if (req.user) {
    // Multi-condomínio: condomínios do utilizador + ativo (por sessão).
    try {
      const meus = await tenant.listarCondominios(req.user.id);
      res.locals.meusCondominios = meus;
      const ativoId = tenant.ativo(req);
      // Só o condomínio ESCOLHIDO explicitamente (sessão) é o ativo — nunca se
      // escolhe automaticamente o primeiro/último usado.
      let escolhido = meus.find((c) => c.id === ativoId) || null;
      if (!escolhido && ativoId && !tenant.eSuperAdmin(req.user)) {
        delete req.session.condominio_ativo_id; // sessão com ativo que já não é válido
      }
      // Super Admin em modo suporte: o condomínio ativo pode não ter associação
      // (entrou via "Entrar (suporte)") — mostra-o mesmo assim no seletor.
      if (!escolhido && tenant.eSuperAdmin(req.user) && ativoId) {
        const suporte = await tenant.Condominio.findOne({ where: { id: ativoId, estado: 'ativo' } });
        if (suporte) {
          escolhido = { id: suporte.id, designacao: suporte.designacao, morada: suporte.morada, localidade: suporte.localidade, role: 'admin' };
          res.locals.meusCondominios = [escolhido, ...meus];
        } else {
          delete req.session.condominio_ativo_id;
        }
      }
      res.locals.condominioAtivo = escolhido;
      // Interface conforme o papel no condomínio ativo (admin/gestor vêm a
      // navegação de gestão; leitura usa a área do condómino).
      if (escolhido) {
        const papel = await tenant.papelNoAtivo(req).catch(() => null);
        if (papel === 'admin' || papel === 'gestor') res.locals.isAdmin = true;
      }
      if (escolhido) {
        req.session.condominio_ativo_id = escolhido.id;
        if (!condominio || condominio.id !== escolhido.id) {
          condominio = await getCondominio({ id: escolhido.id });
        }
      }
    } catch (err) {
      console.error('[multi-condominio]', err.message);
    }
  }
  res.locals.condominio = condominio ? condominio.toJSON() : null;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = new Date().getFullYear();
  res.locals.currentPath = req.path || '';
  // Nome do serviço de armazenamento principal do condomínio ativo: as vistas
  // mostram o serviço realmente em uso (Google Drive, Dropbox, OneDrive…) em
  // vez de escreverem "Drive" fixo. Fica global, num único ponto.
  res.locals.armazenamentoRotulo = storage.rotuloPrincipal(res.locals.condominioAtivo && res.locals.condominioAtivo.id);
  res.locals.armazenamentoAbrePasta = storage.abrePastaNoFornecedor(res.locals.condominioAtivo && res.locals.condominioAtivo.id);
  res.locals.armazenamentoIcone = storage.iconePrincipal(res.locals.condominioAtivo && res.locals.condominioAtivo.id);
  res.locals.tarefas = background.resumo();
  // Dados para o aviso de expiração da sessão no cliente (só quando autenticado).
  res.locals.sessaoExpiraEm = req.user ? sessao.expiraEm(req.session) : null;
  res.locals.sessaoAvisoMs = sessao.AVISO_MS;
  res.locals.sessaoIdleMs = sessao.IDLE_MS;
  next();
});

// ── Ficheiros estáticos ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Cabeçalhos de segurança básicos ────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ── Rotas ──────────────────────────────────────────────────────────
app.use('/', require('./routes'));
app.use('/', require('./routes/condominios'));
app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/global-admin'));
app.use('/admin', require('./routes/admin'));
const rotasQuotasModulo = require('./routes/quotas-modulo');
app.use('/admin', rotasQuotasModulo);
const rotasFinanceiro = require('./routes/financeiro');
app.use('/admin', rotasFinanceiro);
background.registar('quotas_pos_processamento', rotasFinanceiro.processarPosGeracaoQuotas);
app.use('/admin', require('./routes/extra-quotas'));
app.use('/admin', require('./routes/orcamento'));
app.use('/admin', require('./routes/assembleias'));
app.use('/admin', require('./routes/convocatorias'));
app.use('/admin', require('./routes/documentos'));
app.use('/admin', require('./routes/avisos'));
app.use('/admin', require('./routes/emails'));
app.use('/admin', require('./routes/configuracao'));
app.use('/admin', require('./routes/sistema'));
app.use('/admin', require('./routes/fornecedores'));
app.use('/admin', require('./routes/placeholders'));
app.use('/condomino', require('./routes/condomino'));
// Link temporário de documento (destinatários sem conta) — rota pública
// protegida por token assinado e com validade limitada; ver o cabeçalho de
// routes/documentos-link.js. Nunca serve documentos sem token válido.
app.use('/', require('./routes/documentos-link'));

// ── Tratamento de erros ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', {
    titulo: 'Página não encontrada',
    mensagem: 'O endereço pedido não existe.',
  });
});

app.use((err, req, res, next) => {
  console.error('[erro]', err);
  res.status(500).render('error', {
    titulo: 'Erro interno',
    mensagem: 'Ocorreu um erro inesperado. Tente novamente.',
  });
});

// ── Arranque ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

sequelize
  .authenticate()
  .then(async () => {
    console.log('Ligação à base de dados (MariaDB) estabelecida.');
    await drive.inicializar(); // carrega o estado do Google Drive (tokens na BD)
    await mailer.inicializar(); // carrega a configuração SMTP (BD/.env)
    app.listen(PORT, () => {
      console.log(`GesCondu a correr em http://localhost:${PORT}`);
      require('./jobs/scheduler').iniciar();
    });
  })
  .catch((err) => {
    console.error('Não foi possível ligar à base de dados:', err.message);
    process.exit(1);
  });

module.exports = app;
