const express = require('express');
const router = express.Router();

// Página inicial: encaminha conforme o papel do utilizador.
router.get('/', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/login');
  }
  if (req.user.role === 'admin') {
    return res.redirect('/admin');
  }
  return res.redirect('/condomino');
});

module.exports = router;
