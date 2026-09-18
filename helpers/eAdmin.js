// Middlewares de proteção de rotas — AUTENTICAÇÃO apenas.
//
// Este ficheiro tinha também `eAdmin`, que decidia por `users.role` (coluna
// LEGADO) e por isso autorizava/negava consoante um papel que não corresponde
// ao do condomínio ativo. Foi removido; a autorização passa a usar, por âmbito:
//
//   GLOBAL (GesCondu)  → `tenant.eSuperAdmin`  (`users.role_global`)
//   CONDOMÍNIO         → `tenant.comCondominioAtivo` + `tenant.comPapel(...)`
//                        (`utilizador_condominios.role`, com o modo suporte do
//                        Super Admin resolvido dentro de `comCondominioAtivo`)
//   AUTENTICAÇÃO       → `eAutenticado` (abaixo)

module.exports = {
  eAutenticado(req, res, next) {
    if (req.isAuthenticated()) {
      return next();
    }
    req.flash('error_msg', 'Inicie sessão para continuar.');
    return res.redirect('/login');
  },
};
