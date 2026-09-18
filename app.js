require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const { engine } = require('express-handlebars');
const flash = require('connect-flash');
const passport = require('passport');
const methodOverride = require('method-override');

const sequelize = require('./config/database');
const { Op } = require('sequelize');
const { Aviso } = require('./models');
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

// A conta continua válida? O estado da conta e a confirmação de email eram
// verificados apenas no login; esta passagem garante que desativar uma conta
// corta de imediato uma sessão já aberta (a autorização por condomínio e por
// fração já é revalidada em cada pedido).
app.use(sessao.verificarContaAtiva);

// ── Variáveis globais nas views ────────────────────────────────────
app.use(async (req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.error = req.flash('error');
  res.locals.user = req.user || null;
  // `isAdmin` = «esta conta tem interface de GESTÃO no contexto atual?».
  // NÃO vem de `users.role` (legado): o que decide é o papel no CONDOMÍNIO
  // ATIVO (`utilizador_condominios.role`), resolvido mais abaixo quando o
  // contexto é carregado — admin e gestor usam o backoffice. O Super Admin
  // mantém a interface de gestão porque pode entrar em suporte em qualquer
  // condomínio ativo. Sem contexto de condomínio fica false: quem não tem
  // condomínio ativo só pode ver a escolha de condomínio.
  res.locals.isAdmin = false;
  // `isSuperAdmin` (privilégio GLOBAL, só para o menu de administração global)
  // é distinto de `isAdmin` (gestão de um condomínio): nunca se usa um como
  // substituto do outro.
  res.locals.isSuperAdmin = Boolean(req.user && tenant.eSuperAdmin(req.user));
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = null;
  // Contexto de condomínio: só existe para quem tem sessão. Num pedido sem
  // autenticação (entrada, verificação em duas etapas, recuperação de
  // palavra-passe, página de erro…) não se lê sequer o primeiro condomínio da
  // base de dados: as páginas públicas são neutras e nunca apresentam o nome de
  // um condomínio concreto — nem o workspace — antes de a sessão estar validada.
  let condominio = req.user ? await getCondominio() : null;
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
      // Interface conforme o papel no condomínio ATIVO (admin/gestor vêm a
      // navegação de gestão; leitura usa a área do condómino). O papel é
      // resolvido pelo tenant (associação real; modo suporte do Super Admin
      // quando não há associação) e substitui a promoção que existia antes por
      // `users.role` — legado que não corresponde ao condomínio ativo.
      if (escolhido) {
        const papel = await tenant.papelNoAtivo(req).catch(() => null);
        if (papel === 'admin' || papel === 'gestor') res.locals.isAdmin = true;
        res.locals.eSuperAdmin = tenant.eSuperAdmin(req.user);
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
  // Área do condómino: número de avisos RECENTES do condomínio ativo (últimos
  // 14 dias), para o atalho de avisos no cabeçalho. Não existe estado de
  // «lido/não lido» no sistema, por isso conta-se o que é factual: avisos
  // criados recentemente. Uma consulta leve, só para quem usa o portal.
  res.locals.avisosRecentes = 0;
  if (req.user && res.locals.condominioAtivo && !res.locals.isAdmin) {
    try {
      const desde = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      res.locals.avisosRecentes = await Aviso.count({
        where: { condominio_id: res.locals.condominioAtivo.id, createdAt: { [Op.gte]: desde } },
      });
    } catch (err) {
      res.locals.avisosRecentes = 0;
    }
  }
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
// Páginas legais públicas (Política de Privacidade e Termos de Utilização):
// sem sessão, sem condomínio ativo e sem permissões — ver routes/publicas.js.
app.use('/', require('./routes/publicas'));
// ── Administração GLOBAL (GesCondu) — namespace PRÓPRIO: /global ────
// Antes estava montado em `/admin`, o que colidia com o backoffice do
// condomínio: o router global declara a sua guarda com `router.use`, que corre
// em TODOS os pedidos que entram no router (mesmo sem correspondência de rota),
// pelo que `GET /admin` de um admin/gestor de condomínio era interceptado e
// devolvia `302 /` — e `routes/admin.js`, montado depois, nunca era alcançado.
// Causa do ciclo `/ → /admin → / → …`.
// Agora `/admin` é EXCLUSIVAMENTE o backoffice do condomínio.
app.use('/global', require('./routes/global-admin'));
// Compatibilidade: os URLs antigos `/admin/global*` continuam a responder,
// redirecionados (302, para não ser cacheado como permanente por browsers ou
// pelo proxy) para o equivalente em `/global*`. Preserva o resto do caminho e
// a query string. Fica ANTES dos routers de `/admin` e é montado por prefixo
// exato de subárvore (`/admin/global`), pelo que não captura `/admin` nem
// `/admin/global-outra-coisa`.
app.use('/admin/global', (req, res) => {
  const resto = req.originalUrl.slice('/admin/global'.length);
  return res.redirect(302, '/global' + resto);
});
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
// Relatórios do condomínio (Relatório Financeiro / balancete) — ver
// routes/relatorios.js. Montado antes dos placeholders.
app.use('/admin', require('./routes/relatorios'));
app.use('/admin', require('./routes/placeholders'));
app.use('/condomino', require('./routes/condomino'));
// Área pessoal do portal (perfil, condomínios e a única ação de sessão do
// portal — trocar o condomínio ativo). Router próprio e montado ANTES do
// router da área do condomínio: `routes/condomino.js` é a consulta do
// condomínio ativo e mantém-se estritamente só de leitura.
app.use('/condomino', require('./routes/condomino-conta'));
// Recomendações contextuais do portal (Fase 2G): dispensa/reposição de uma
// recomendação. Router próprio — a condição de elegibilidade vive no motor
// (helpers/recomendacoes.js) e a área de consulta do condomínio continua a não
// ter escrita nenhuma.
app.use('/condomino', require('./routes/condomino-recomendacoes'));
// "Preparar saída do condomínio" (fluxo próprio do condómino, distinto de
// terminar sessão) — ver routes/saida-condominio.js.
// O router usa caminhos relativos ao prefixo /condomino.
app.use('/condomino', require('./routes/saida-condominio'));
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
