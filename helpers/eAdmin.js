// Middlewares de proteção de rotas.
// eAutenticado  → qualquer utilizador com sessão iniciada
// eAdmin        → apenas administradores

module.exports = {
  eAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user && req.user.role === 'admin') {
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
