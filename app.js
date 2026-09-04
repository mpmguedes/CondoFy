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
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'condofy-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 dias
    },
  })
);

// ── Body parsing + method override ─────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// ── Passport + flash ───────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// ── Variáveis globais nas views ────────────────────────────────────
app.use(async (req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.error = req.flash('error');
  res.locals.user = req.user || null;
  res.locals.isAdmin = !!(req.user && req.user.role === 'admin');
  const condominio = await getCondominio();
  res.locals.condominio = condominio ? condominio.toJSON() : null;
  res.locals.appName = 'Condofy';
  res.locals.currentYear = new Date().getFullYear();
  res.locals.currentPath = req.path || '';
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
app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/admin', require('./routes/financeiro'));
app.use('/admin', require('./routes/orcamento'));
app.use('/admin', require('./routes/assembleias'));
app.use('/admin', require('./routes/documentos'));
app.use('/admin', require('./routes/avisos'));
app.use('/admin', require('./routes/configuracao'));
app.use('/admin', require('./routes/sistema'));
app.use('/condomino', require('./routes/condomino'));

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
  .then(() => {
    console.log('Ligação à base de dados (MariaDB) estabelecida.');
    app.listen(PORT, () => {
      console.log(`Condofy a correr em http://localhost:${PORT}`);
      require('./jobs/scheduler').iniciar();
    });
  })
  .catch((err) => {
    console.error('Não foi possível ligar à base de dados:', err.message);
    process.exit(1);
  });

module.exports = app;
