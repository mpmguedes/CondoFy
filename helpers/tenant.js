// ─────────────────────────────────────────────────────────────────────
// Multi-condomínio — associações, condomínio ativo e papéis.
// O condomínio ativo vem sempre da SESSÃO e é validado contra a associação
// utilizador ↔ condomínio (nunca se confia num id enviado pelo browser).
// Papéis por condomínio: admin > gestor > leitura.
// ─────────────────────────────────────────────────────────────────────
const { UserCondominio, Condominio, User } = require('../models');

// ── Privilégio GLOBAL ──────────────────────────────────────────────
// A administração global (GesCondu) é decidida EXCLUSIVAMENTE por
// `users.role_global`. `users.role` é legado e nunca decide nada aqui.
function eSuperAdmin(utilizador) {
  return Boolean(utilizador && utilizador.role_global === 'super_admin');
}

function ativo(req) {
  return req && req.session && req.session.condominio_ativo_id ? Number(req.session.condominio_ativo_id) : null;
}

// Associação ATIVA do utilizador ao condomínio (null quando não existe).
async function associacaoAtiva(utilizadorId, condominioId) {
  if (!utilizadorId || !condominioId) return null;
  return UserCondominio.findOne({
    where: { utilizador_id: utilizadorId, condominio_id: condominioId, estado: 'ativo' },
  });
}

// Condomínios (ativos) do utilizador, com o papel da associação.
async function listarCondominios(utilizadorId) {
  if (!utilizadorId) return [];
  const linhas = await UserCondominio.findAll({
    where: { utilizador_id: utilizadorId, estado: 'ativo' },
    include: [{ model: Condominio, as: 'condominio', where: { estado: 'ativo' }, required: true }],
    order: [['id', 'ASC']],
  });
  return linhas.map((l) => ({
    id: l.condominio.id,
    designacao: l.condominio.designacao,
    morada: l.condominio.morada,
    codigo_postal: l.condominio.codigo_postal,
    localidade: l.condominio.localidade,
    role: l.role,
  }));
}

// Define o condomínio ativo na sessão — apenas se a associação for válida.
async function entrarCondominio(req, condominioId) {
  const utilizador = req.user;
  if (!utilizador) return false;
  if (eSuperAdmin(utilizador)) {
    // Super Admin pode entrar em qualquer condomínio ativo (suporte).
    const cond = await Condominio.findOne({ where: { id: condominioId, estado: 'ativo' } });
    if (!cond) return false;
    req.session.condominio_ativo_id = cond.id;
    return true;
  }
  const associacao = await associacaoAtiva(utilizador.id, condominioId);
  if (!associacao) return false;
  req.session.condominio_ativo_id = associacao.condominio_id;
  return true;
}

// Papel do utilizador no condomínio ativo (null se sem acesso).
//
// IMPORTANTE — as três noções são distintas e não se substituem:
//   1. privilégio GLOBAL  → `users.role_global` (eSuperAdmin);
//   2. papel NO CONDOMÍNIO → `utilizador_condominios.role` (admin/gestor/leitura);
//   3. modo SUPORTE        → super admin com condomínio ativo escolhido por si.
//
// No modo suporte (ponto 3) não existe associação e o papel administrativo do
// condomínio é atribuído pelo próprio ato de entrar em suporte — é essa a
// convenção que o backoffice sempre usou (`comCondominioAtivo` faz o mesmo em
// `req.papelCondominio`). Sem esta distinção, o super admin que entra em
// suporte perdia o acesso ao painel do condomínio.
async function papelNoAtivo(req) {
  const id = ativo(req);
  if (!id) return null;
  const associacao = await associacaoAtiva(req.user && req.user.id, id);
  if (associacao) return associacao.role; // papel REAL da associação (precedência)
  if (req.user && eSuperAdmin(req.user)) return 'admin'; // modo suporte
  return null;
}

// Papel EFETIVO a apresentar na interface para o contexto atual.
// Devolve `{ global, modoSuporte, papel }`:
//  - `global`      → administrador global (menu de administração global);
//  - `modoSuporte` → super admin com condomínio ativo escolhido manualmente;
//  - `papel`       → papel no condomínio ativo (associação real), quando existe.
// Nunca lê `users.role`: a UI não pode continuar a depender do legado.
async function contextoAdministrativo(req) {
  const global = eSuperAdmin(req.user);
  const associacao = req.user ? await associacaoAtiva(req.user.id, ativo(req)) : null;
  const modoSuporte = global && !associacao && Boolean(ativo(req));
  return {
    global,
    modoSuporte,
    papel: associacao ? associacao.role : modoSuporte ? 'admin' : null,
  };
}

// Permissões por papel (leitura só consulta; gestor escreve; admin tudo).
const PAPEIS = { admin: 30, gestor: 20, leitura: 10 };
function podeEscrever(papel) {
  return (PAPEIS[papel] || 0) >= 20;
}
function papelMaiorOuIgual(papel, minimo) {
  return (PAPEIS[papel] || 0) >= (PAPEIS[minimo] || 99);
}

async function eAdminCondominio(req) {
  const papel = await papelNoAtivo(req);
  return papel === 'admin';
}

// ── Middlewares de isolamento por condomínio ativo ─────────────────
// Valida que o utilizador tem condomínio ativo na sessão (associação real)
// e expõe req.condominioId + req.papelCondominio.
function comCondominioAtivo(req, res, next) {
  return (async () => {
    if (!req.isAuthenticated()) {
      req.flash('error_msg', 'Inicie sessão para continuar.');
      return res.redirect('/login');
    }
    const id = ativo(req);
    if (!id) {
      req.flash('error_msg', 'Selecione um condomínio para continuar.');
      return res.redirect('/condominios');
    }
    if (eSuperAdmin(req.user)) {
      // Super Admin em modo suporte — o condomínio tem de existir e estar ativo.
      const cond = await Condominio.findOne({ where: { id, estado: 'ativo' } });
      if (!cond) {
        req.flash('error_msg', 'O condomínio selecionado não está disponível.');
        return res.redirect('/condominios');
      }
      req.condominioId = id;
      req.papelCondominio = 'admin';
      return next();
    }
    const associacao = await associacaoAtiva(req.user.id, id);
    if (!associacao) {
      delete req.session.condominio_ativo_id;
      req.flash('error_msg', 'Não tem acesso a este condomínio.');
      return res.redirect('/condominios');
    }
    req.condominioId = id;
    req.papelCondominio = associacao.role;
    return next();
  })();
}

// Permite apenas papéis ≥ mínimo.
// O papel vem de `req.papelCondominio`, definido por `comCondominioAtivo` — é
// esse middleware que materializa o modo suporte do super admin (a associação
// real tem precedência). Não se volta a promover o super admin aqui: se este
// middleware fosse usado sem `comCondominioAtivo` antes, a promoção implícita
// mascararia a ausência de contexto de condomínio.
function comPapel(minimo) {
  return (req, res, next) => {
    const papel = req.papelCondominio || null;
    if (!papel || !papelMaiorOuIgual(papel, minimo)) {
      req.flash('error_msg', 'Não tem permissões para esta ação.');
      return res.redirect('/');
    }
    return next();
  };
}

// Destinos canónicos do contexto autenticado.
const DESTINO_PAINEL = '/admin'; // backoffice do condomínio (admin e gestor)
const DESTINO_GLOBAL = '/admin/global'; // administração global (super admin)
const DESTINO_PORTAL = '/condomino'; // área do condómino

// ── Destino inicial (pós-login / entrada na raiz) ──────────────────
// Decisão ÚNICA do contexto e do destino. Todas as entradas (`GET /`, depois
// do login, depois de escolher condomínio) passam por aqui — não existe
// lógica paralela em `routes/index.js`.
//
// Regras (por ordem):
//   1. super admin sem condomínio ativo      → painel de administração global;
//   2. super admin com condomínio ativo      → modo suporte: painel do
//      condomínio. Vale mesmo sem associação (entrou por "Entrar (suporte)").
//      O modo suporte nunca aponta para o painel global, para não criar
//      `/admin → / → /admin/global` (ciclo novo);
//   3. sem condomínio ativo válido           → "Os meus condomínios";
//   4. papel no condomínio ativo admin/gestor → painel do condomínio;
//   5. qualquer outro papel                   → área do condómino.
//
// O papel vem SEMPRE do condomínio ativo (associação real, ou modo suporte) e
// NUNCA de `users.role` — é essa a correção estrutural: `users.role` deixa de
// decidir o destino pós-login.
function destinoInicial({ meus = [], ativo = null, user = null } = {}) {
  const ids = (meus || []).map((c) => Number(c && c.id));
  const ativoValido = ativo != null && ids.includes(Number(ativo));
  const escolhido = ativoValido ? meus.find((c) => Number(c.id) === Number(ativo)) : null;
  const global = eSuperAdmin(user);
  // Modo SUPORTE: o Super Admin pode ter um condomínio ativo SEM associação
  // (entrou via "Entrar (suporte)", que aceita qualquer condomínio ativo).
  // Nesse caso o condomínio não aparece em `meus` — é o próprio id ativo que
  // identifica o contexto, e o papel administrativo é o do modo suporte.
  // Com associação real, o contexto NÃO é suporte: o papel é o da associação.
  const suporte = global && !escolhido && ativo != null;

  // 1. Administrador global, sem condomínio escolhido: vai para a sua área.
  if (global && !escolhido && !suporte) {
    return { redirecionar: DESTINO_GLOBAL, limparAtivo: false, modoSuporte: false };
  }
  // 2/4. Com condomínio em contexto (associação real OU suporte), o destino é
  //      o painel do condomínio: é para lá que aponta o modo suporte e é o
  //      papel da associação que decide nos restantes casos (abaixo).
  if (global && (escolhido || suporte)) {
    return { redirecionar: DESTINO_PAINEL, limparAtivo: false, modoSuporte: suporte };
  }
  // 3. Sem condomínio escolhido: escolha explícita (mesmo com um só).
  if (!escolhido) {
    return { redirecionar: '/condominios', limparAtivo: Boolean(ativo), modoSuporte: false };
  }
  // 4/5. Papel do condomínio ATIVO decide entre painel e portal.
  const papel = escolhido.role;
  return {
    redirecionar: papel === 'admin' || papel === 'gestor' ? DESTINO_PAINEL : DESTINO_PORTAL,
    limparAtivo: false,
    modoSuporte: false,
  };
}

// true quando o registo pertence ao condomínio ativo (proteção IDOR).
function pertenceAoAtivo(condominioIdRegisto, req) {
  return Number(condominioIdRegisto) === Number(req.condominioId || ativo(req));
}

module.exports = {
  eSuperAdmin,
  ativo,
  associacaoAtiva,
  listarCondominios,
  entrarCondominio,
  papelNoAtivo,
  contextoAdministrativo,
  destinoInicial,
  DESTINO_PAINEL,
  DESTINO_GLOBAL,
  DESTINO_PORTAL,
  podeEscrever,
  papelMaiorOuIgual,
  eAdminCondominio,
  comCondominioAtivo,
  comPapel,
  pertenceAoAtivo,
  PAPEIS,
  UserCondominio,
  User,
  Condominio,
};
