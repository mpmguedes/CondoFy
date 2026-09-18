const express = require('express');
const tenant = require('../helpers/tenant');
const homePublica = require('../helpers/home-publica');
const router = express.Router();

// Decisão pura do destino após autenticação (testável offline).
// Delega a decisão no tenant (`tenant.destinoInicial`) — a autorização e o
// contexto são decididos num só sítio, a partir do papel no CONDOMÍNIO ATIVO.
// `users.role` é legado e já não decide o destino (era a origem do ciclo
// `/ → /admin → /` em contas cujo papel de condomínio não era administrativo).
function destinoAposLogin({ meus = [], ativo = null, user = {} } = {}) {
  return tenant.destinoInicial({ meus, ativo, user });
}

// Página inicial: LOGIN → "Os meus condomínios" → escolha → dashboard.
// Sem sessão, a raiz serve a HOMEPAGE PÚBLICA (nome da aplicação visível) em vez
// de redirecionar para a entrada: era essa a única razão da verificação da
// marca na Google Auth Platform («o nome do app não corresponde ao nome na
// página inicial»). A homepage não exige sessão nem condomínio: apresenta o
// produto, explica que o acesso é por convite e mantém o caminho para /login.
// O percurso de quem tem sessão fica exatamente igual.
router.get('/', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.render('publicas/home', { layout: 'blank', ...homePublica.dadosHome(req) });
  }
  try {
    const meus = await tenant.listarCondominios(req.user.id);
    const decisao = destinoAposLogin({ meus, ativo: tenant.ativo(req), user: req.user });
    if (decisao.limparAtivo) {
      delete req.session.condominio_ativo_id;
    }
    return res.redirect(decisao.redirecionar);
  } catch (err) {
    console.error('[home]', err.message);
    req.flash('error_msg', 'Ocorreu um erro ao preparar a sua área.');
    return res.redirect('/login');
  }
});

module.exports = router;
module.exports.destinoAposLogin = destinoAposLogin;
