// Middlewares de proteção de rotas.
// eAutenticado  → qualquer utilizador com sessão iniciada
// eAdmin        → administrador (papel 'admin' OU Super Admin global)

module.exports = {
  eAdmin(req, res, next) {
    const global = req.user && req.user.role_global === 'super_admin';
    if (req.isAuthenticated() && req.user && (req.user.role === 'admin' || global)) {
      return next();
    }
    req.flash('error_msg', 'Precisa de permissões de administrador.');
    return res.redirect('/');
  },

  eAutenticado(req, res, next) {
    if (req.isAuthenticated()) {
      return next();
    }
    req.flash('error_msg', 'Inicie sessão para continuar.');
    return res.redirect('/login');
  },
};
