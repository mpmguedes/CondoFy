const express = require('express');
const tenant = require('../helpers/tenant');
const router = express.Router();

// Página inicial: LOGIN → (escolha/condomínio ativo) → Dashboard.
router.get('/', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/login');
  }
  try {
    const meus = await tenant.listarCondominios(req.user.id);
    let ativo = tenant.ativo(req);
    if (!meus.some((c) => c.id === ativo)) {
      ativo = null;
      delete req.session.condominio_ativo_id;
    }
    if (!ativo && meus.length) {
      ativo = meus[0].id;
      req.session.condominio_ativo_id = ativo;
    }
    if (!ativo) {
      // Sem condomínio ativo: escolher/criar (Super Admin ou primeiro).
      return res.redirect('/condominios');
    }
    // Entra na área conforme o papel (legado mantido para não quebrar fluxos).
    const global = req.user.role_global === 'super_admin';
    return res.redirect(req.user.role === 'admin' || global ? '/admin' : '/condomino');
  } catch (err) {
    console.error('[home]', err.message);
    req.flash('error_msg', 'Ocorreu um erro ao preparar a sua área.');
    return res.redirect('/login');
  }
});

module.exports = router;
