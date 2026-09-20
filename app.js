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
const suporte = require('./helpers/suporte');
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
  // contexto é carregado — admin e gestor usam o backoffice.
  //
  // Um Super Admin NÃO ganha aqui interface de gestão: sem associação ao
  // condomínio ativo fica `false`. O acesso de suporte é um contexto à parte,
  // com interface própria, resolvido por `comCondominioAtivo` (via
  // `req.suporte`) — nunca por uma promoção em `isAdmin`.
  res.locals.isAdmin = false;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = null;
  // Pedidos de acesso de suporte à espera de decisão do administrador do
  // condomínio ativo. Alimenta o aviso na navegação (`main.handlebars`) — sem
  // ele, um pedido pendente expirava sem ninguém dar por isso. Zero por omissão:
  // só é consultado quando há condomínio escolhido e interface de gestão.
  res.locals.pedidosSuportePendentes = 0;
  // Contexto de SUPORTE (nível diagnóstico) — `null` para a esmagadora maioria
  // dos pedidos. Preenchido em baixo apenas quando o condomínio ativo NÃO tem
  // associação para o utilizador mas existe um acesso de suporte vigente. A
  // casca usa-o para mostrar a faixa de «só leitura»; a autorização continua a
  // ser revalidada em cada rota por `tenant.comCondominioAtivo`.
  res.locals.suporteAtivo = null;
  // Indicador para as VISTAS: `true` quando o pedido é de suporte de nível
  // `diagnostico`. As vistas de módulos abertos ao suporte (frações, quotas,
  // condóminos…) escolhem por ele a apresentação DESPERSONALIZADA (iniciais em
  // vez de nomes, IBAN/NIF/contacto mascarados, sem ações de escrita). Não
  // concede nada: é apresentação. A admissão e o isolamento são decididos por
  // `helpers/suporte-allowlist.js` e pela consulta de cada handler.
  res.locals.suporteDiagnostico = false;
  // Contexto de condomínio: só existe para quem tem sessão. Num pedido sem
  // autenticação (entrada, verificação em duas etapas, recuperação de
  // palavra-passe, página de erro…) não se lê sequer o primeiro condomínio da
  // base de dados: as páginas públicas são neutras e nunca apresentam o nome de
  // um condomínio concreto — nem o workspace — antes de a sessão estar validada.
  //
  // `condominio` é preenchido MAIS ABAIXO, e só quando existe um condomínio
  // ESCOLHIDO na sessão: sem escolha não há contexto e a consulta ao primeiro
  // condomínio da base de dados seria desperdiçada.
  let condominio = null;
  if (req.user) {
    // Multi-condomínio: condomínios do utilizador + ativo (por sessão).
    try {
      const meus = await tenant.listarCondominios(req.user.id);
      res.locals.meusCondominios = meus;
      const ativoId = tenant.ativo(req);
      // Só o condomínio ESCOLHIDO explicitamente (sessão) é o ativo — nunca se
      // escolhe automaticamente o primeiro/último usado.
      let escolhido = meus.find((c) => c.id === ativoId) || null;
      if (!escolhido && ativoId) {
        delete req.session.condominio_ativo_id; // sessão com ativo que já não é válido
      }
      res.locals.condominioAtivo = escolhido;
      // Interface conforme o papel no condomínio ATIVO (admin/gestor vêm a
      // navegação de gestão; leitura usa a área do condómino). O papel é
      // resolvido pelo tenant (associação real) e substitui a promoção que
      // existia antes por `users.role` — legado que não corresponde ao
      // condomínio ativo.
      //
      // Um Super Admin NÃO aparece aqui com um condomínio «fabricado»: o acesso
      // de suporte é resolvido por `comCondominioAtivo` (via `req.suporte`), no
      // momento em que a rota o exige. Sem associação, `escolhido` é `null` e
      // `isAdmin` fica `false` — o menu de gestão não é oferecido.
      if (escolhido) {
        const papel = await tenant.papelNoAtivo(req).catch(() => null);
        if (papel === 'admin' || papel === 'gestor') res.locals.isAdmin = true;
        req.session.condominio_ativo_id = escolhido.id;
        // Única leitura do condomínio: o ESCOLHIDO. Sem escolha, `condominio`
        // fica `null` e não há consulta nenhuma (antes lia-se o primeiro
        // condomínio da base de dados para o descartar de seguida).
        condominio = await getCondominio({ id: escolhido.id });
      } else if (ativoId) {
        // Sem associação ao ativo: pode ser um ACESSO DE SUPORTE. Aqui só se
        // resolve o que a CASCA precisa de saber — nome do condomínio e faixa de
        // contexto. A autorização em si continua a ser decidida em cada rota por
        // `tenant.comCondominioAtivo`; esta leitura não concede nada e é
        // revalidada (âmbito, estado, prazo) tal como lá.
        const acesso = await suporte.vigente(req, ativoId).catch(() => null);
        if (acesso) {
          res.locals.suporteAtivo = suporte.paraContexto(acesso);
          // As vistas de suporte decidem por este indicador (e só por ele).
          res.locals.suporteDiagnostico = acesso.nivel === 'diagnostico';
          condominio = await getCondominio({ id: ativoId }).catch(() => null);
          // A casca (cabeçalho, título, seletor) lê SEMPRE `condominioAtivo`.
          // Em contexto de suporte não há associação, mas o utilizador precisa de
          // saber ONDE está — sem isto o cabeçalho mostrava a aplicação e não o
          // condomínio concedido. `role` fica deliberadamente a `null`: a vista
          // do seletor e a navegação de gestão decidem por ele, e é exatamente
          // essa ausência que impede o menu de administração de aparecer.
          if (condominio) {
            res.locals.condominioAtivo = { ...condominio.toJSON(), role: null };
          }
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
  // Pedidos de suporte pendentes do condomínio ATIVO, para o administrador
  // decidir sem ter de abrir a página. Só faz sentido com interface de gestão
  // (`isAdmin`) — quem não administra não decide nada e não precisa do aviso.
  // Falha em silêncio: é um contador informativo e não pode derrubar a página.
  if (res.locals.isAdmin && res.locals.condominioAtivo) {
    res.locals.pedidosSuportePendentes = await suporte
      .contagemPendentes(res.locals.condominioAtivo.id)
      .catch(() => 0);
  }
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
// Calendário do condomínio (agrega assembleias + avisos programados) — ver
// routes/calendario.js. Tem de ser montado ANTES de `placeholders`: caso
// contrário, a rota genérica `/:modulo` de placeholders capturaria
// `/admin/calendario` e serviria o placeholder «em desenvolvimento».
app.use('/admin', require('./routes/calendario'));
// Eventos ad-hoc do calendário (CRUD em `/admin/calendario/eventos/*`) — ver
// routes/eventos.js. Mesma razão de ordem que acima: a rota genérica
// `/:modulo` de placeholders capturaria `/admin/calendario/...` se este
// router viesse depois.
app.use('/admin', require('./routes/eventos'));
app.use('/admin', require('./routes/placeholders'));
// ── Defesa estrutural do portal do condómino ───────────────────────
// O suporte diagnóstico NUNCA entra no portal do condómino. Esta guarda é
// GLOBAL e montada ANTES de todos os routers de `/condomino`, de modo a
// sobreviver a uma reordenação das montagens: mesmo que a ordem mude, o
// suporte não passa. Lê a marca da SESSÃO (`suporte_ativo_id`), porque
// `req.suporte` só existe depois de um router montar `comCondominioAtivo` —
// e uma guarda global corre antes disso. Os quatro routers declaram também
// `tenant.semSuporte` (defesa em profundidade), mas nenhum deles é a
// primeira linha.
app.use('/condomino', tenant.bloqueioSuporteNaSessao);
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
