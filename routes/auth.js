const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User } = require('../models');
const { sendMail } = require('../helpers/mailer');
const { audit } = require('../helpers/audit');

const router = express.Router();

// ── Login ──────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.render('auth/login');
});

router.post(
  '/login',
  passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash: true,
  })
);

router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.flash('success_msg', 'Sessão terminada com sucesso.');
    res.redirect('/login');
  });
});

// ── Recuperação de palavra-passe ───────────────────────────────────
router.get('/recuperar', (req, res) => {
  res.render('auth/recuperar');
});

router.post('/recuperar', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ where: { email } });
    // Resposta genérica para não revelar se o email existe.
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hora
      await user.update({ reset_token: token, reset_token_expires: expires });

      const link = `${req.protocol}://${req.get('host')}/redefinir/${token}`;
      await sendMail({
        to: user.email,
        subject: 'Recuperação de palavra-passe',
        text: `Olá ${user.nome},\n\nPara redefinir a sua palavra-passe, abra o link:\n${link}\n\nEste link é válido durante 1 hora.`,
        html: `<p>Olá ${user.nome},</p><p>Para redefinir a sua palavra-passe, clique em:</p><p><a href="${link}">${link}</a></p><p>Este link é válido durante 1 hora.</p>`,
      });
      await audit({
        userId: user.id,
        acao: 'pedido_recuperacao_password',
        entidade: 'User',
        entidadeId: user.id,
      });
    }
    req.flash('success_msg', 'Se o email existir, receberá instruções para recuperar a palavra-passe.');
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Ocorreu um erro ao processar o pedido.');
    res.redirect('/recuperar');
  }
});

router.get('/redefinir/:token', async (req, res) => {
  const user = await User.findOne({ where: { reset_token: req.params.token } });
  if (!user || !user.reset_token_expires || user.reset_token_expires < new Date()) {
    req.flash('error_msg', 'O link de recuperação é inválido ou expirou.');
    return res.redirect('/login');
  }
  res.render('auth/redefinir', { token: req.params.token });
});

router.post('/redefinir/:token', async (req, res) => {
  const { password, password2 } = req.body;
  if (!password || password.length < 8) {
    req.flash('error_msg', 'A palavra-passe deve ter pelo menos 8 caracteres.');
    return res.redirect(`/redefinir/${req.params.token}`);
  }
  if (password !== password2) {
    req.flash('error_msg', 'As palavras-passe não coincidem.');
    return res.redirect(`/redefinir/${req.params.token}`);
  }
  const user = await User.findOne({ where: { reset_token: req.params.token } });
  if (!user || !user.reset_token_expires || user.reset_token_expires < new Date()) {
    req.flash('error_msg', 'O link de recuperação é inválido ou expirou.');
    return res.redirect('/login');
  }
  const hash = await bcrypt.hash(password, 10);
  await user.update({ password_hash: hash, reset_token: null, reset_token_expires: null });
  await audit({ userId: user.id, acao: 'redefinicao_password', entidade: 'User', entidadeId: user.id });
  req.flash('success_msg', 'Palavra-passe redefinida. Inicie sessão.');
  res.redirect('/login');
});

module.exports = router;
