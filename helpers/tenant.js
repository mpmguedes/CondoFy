// ─────────────────────────────────────────────────────────────────────
// Multi-condomínio — associações, condomínio ativo e papéis.
// O condomínio ativo vem sempre da SESSÃO e é validado contra a associação
// utilizador ↔ condomínio (nunca se confia num id enviado pelo browser).
// Papéis por condomínio: admin > gestor > leitura.
// ─────────────────────────────────────────────────────────────────────
const { UserCondominio, Condominio, User } = require('../models');

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
async function papelNoAtivo(req) {
  const id = ativo(req);
  if (!id) return null;
  if (req.user && eSuperAdmin(req.user)) return 'admin';
  const associacao = await associacaoAtiva(req.user && req.user.id, id);
  return associacao ? associacao.role : null;
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

// Permite apenas papéis ≥ mínimo (usa req.papelCondominio definido antes).
function comPapel(minimo) {
  return (req, res, next) => {
    const papel = req.papelCondominio || (req.user && eSuperAdmin(req.user) ? 'admin' : null);
    if (!papel || !papelMaiorOuIgual(papel, minimo)) {
      req.flash('error_msg', 'Não tem permissões para esta ação.');
      return res.redirect('/');
    }
    return next();
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
