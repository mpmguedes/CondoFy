const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User } = require('../models');
const { sendMail } = require('../helpers/mailer');
const { audit } = require('../helpers/audit');
const { createLimiter } = require('../helpers/seguranca');
const convites = require('../helpers/convites');
const doisFatores = require('../helpers/doisfatores');
const { eAutenticado } = require('../helpers/eAdmin');

const router = express.Router();

// Rate limiting (autenticação) — proteção simples contra força bruta.
const limiteLogin = createLimiter({
  rotulo: 'login',
  max: 10,
  janelaMs: 10 * 60 * 1000,
  msg: 'Demasiadas tentativas de início de sessão. Aguarde 10 minutos.',
});
const limiteRecuperar = createLimiter({
  rotulo: 'recuperar',
  max: 5,
  janelaMs: 15 * 60 * 1000,
  msg: 'Demasiados pedidos de recuperação. Aguarde 15 minutos.',
});
const limiteRedefinir = createLimiter({
  rotulo: 'redefinir',
  max: 10,
  janelaMs: 60 * 60 * 1000,
  msg: 'Demasiadas tentativas de redefinição. Aguarde 1 hora.',
});
const limite2fa = createLimiter({
  rotulo: '2fa',
  max: 8,
  janelaMs: 15 * 60 * 1000,
  msg: 'Demasiadas tentativas de verificação. Aguarde 15 minutos.',
});

// ── Login ──────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.render('auth/login');
});

// Envia o código 2FA por email (best-effort). Devolve { ok, erro? }.
async function enviarCodigo2fa(user, req) {
  const codigo = doisFatores.gerarCodigo();
  const hash = doisFatores.hashCodigo(codigo);
  await user.update({
    two_fa_email_codigo_hash: hash,
    two_fa_email_codigo_expira: doisFatores.codigoExpiracao(),
    two_fa_email_tentativas: 0,
  });
  try {
    await sendMail({
      to: user.email,
      subject: 'Código de verificação — GesCondu',
      text: `Olá ${user.nome},\n\nO seu código de verificação é:\n\n${codigo}\n\nÉ válido durante 10 minutos.`,
      html: `<p>Olá ${user.nome},</p><p>O seu código de verificação é:</p><p style="font-size:1.4rem;font-weight:bold;letter-spacing:2px">${codigo}</p><p>É válido durante 10 minutos.</p>`,
    });
    return { ok: true };
  } catch (err) {
    console.error('[2fa-email]', err.message);
    return { ok: false, erro: err.message };
  }
}

router.post(
  '/login',
  limiteLogin,
  (req, res, next) => {
    passport.authenticate('local', async (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        req.flash('error_msg', (info && info.message) || 'Credenciais inválidas.');
        return res.redirect('/login');
      }
      // 2FA ativo → segundo fator antes de iniciar sessão.
      if (user.two_fa_ativo) {
        req.session.pendente2faLogin = user.id;
        if (user.two_fa_metodo === 'totp') {
          // Aplicação autenticadora: código pedido na página seguinte.
          await audit({ userId: user.id, acao: '2fa_pedido', entidade: 'User', entidadeId: user.id, detalhes: { metodo: 'totp' } }).catch(() => {});
          return res.redirect('/2fa/entrar');
        }
        const envio = await enviarCodigo2fa(user, req).catch((e) => ({ ok: false, erro: e.message }));
        await audit({ userId: user.id, acao: '2fa_codigo_enviado', entidade: 'User', entidadeId: user.id, detalhes: { fase: 'login' } }).catch(() => {});
        if (!envio.ok) {
          req.flash('error_msg', 'Palavra-passe correta. Não foi possível enviar o código por email (verifique o SMTP) — tente novamente mais tarde.');
          delete req.session.pendente2faLogin;
          return res.redirect('/login');
        }
        return res.redirect('/2fa/entrar');
      }
      req.login(user, (e) => {
        if (e) return next(e);
        // Login completo → obrigar a escolha explícita do condomínio.
        delete req.session.condominio_ativo_id;
        return res.redirect('/');
      });
    })(req, res, next);
  }
);

// ── 2FA — segundo fator do login ────────────────────────────────────
router.get('/2fa/entrar', async (req, res) => {
  if (!req.session.pendente2faLogin) return res.redirect('/login');
  const user = await User.findByPk(req.session.pendente2faLogin).catch(() => null);
  res.render('auth/2fa-entrar', {
    titulo: 'Verificação em duas etapas',
    metodoTotp: Boolean(user && user.two_fa_metodo === 'totp'),
  });
});

router.post('/2fa/entrar', limite2fa, async (req, res, next) => {
  const userId = req.session.pendente2faLogin;
  if (!userId) return res.redirect('/login');
  const user = await User.findByPk(userId);
  if (!user || !user.two_fa_ativo) {
    delete req.session.pendente2faLogin;
    return res.redirect('/login');
  }
  const codigo = String(req.body.codigo || '').trim();
  const ehRecovery = String(req.body.tipo || '') === 'recovery';

  // Limite de tentativas por código (5); excede → pedir novo código.
  if (user.two_fa_email_tentativas >= 5) {
    req.flash('error_msg', 'Demasiadas tentativas. Volte a iniciar sessão para receber um novo código.');
    delete req.session.pendente2faLogin;
    return res.redirect('/login');
  }

  let valido = false;
  if (ehRecovery) {
    const restante = doisFatores.consumirRecovery(user.two_fa_recovery_hash, codigo);
    if (restante !== null) {
      valido = true;
      await user.update({ two_fa_recovery_hash: restante, two_fa_email_codigo_hash: null, two_fa_email_codigo_expira: null, two_fa_email_tentativas: 0 });
    }
  } else if (user.two_fa_metodo === 'totp') {
    // Código da aplicação autenticadora (TOTP, janela ±1 período).
    if (doisFatores.verificarTOTP(user.two_fa_totp_secret, codigo)) {
      valido = true;
      await user.update({ two_fa_email_tentativas: 0 });
    }
  } else {
    const hash = doisFatores.hashCodigo(codigo);
    const okCodigo = user.two_fa_email_codigo_hash && hash === user.two_fa_email_codigo_hash;
    const naoExpirado = user.two_fa_email_codigo_expira && new Date(user.two_fa_email_codigo_expira) > new Date();
    if (okCodigo && naoExpirado) {
      valido = true;
      await user.update({ two_fa_email_codigo_hash: null, two_fa_email_codigo_expira: null, two_fa_email_tentativas: 0 });
    }
  }

  if (!valido) {
    await user.update({ two_fa_email_tentativas: (user.two_fa_email_tentativas || 0) + 1 });
    await audit({ userId: user.id, acao: '2fa_falhou', entidade: 'User', entidadeId: user.id, detalhes: { viaRecovery: ehRecovery } }).catch(() => {});
    req.flash('error_msg', 'Código inválido ou expirado.');
    return res.redirect('/2fa/entrar');
  }

  delete req.session.pendente2faLogin;
  await user.update({ last_login_at: new Date() });
  await audit({ userId: user.id, acao: 'inicio_sessao', entidade: 'User', entidadeId: user.id, detalhes: { email: user.email } }).catch(() => {});
  await audit({ userId: user.id, acao: '2fa_verificado', entidade: 'User', entidadeId: user.id, detalhes: { viaRecovery: ehRecovery } }).catch(() => {});
  req.login(user, (e) => {
    if (e) return next(e);
    // Login completo (2FA verificado) → obrigar a escolha explícita do condomínio.
    delete req.session.condominio_ativo_id;
    req.flash('success_msg', 'Sessão iniciada com verificação em duas etapas.');
    return res.redirect('/');
  });
});

// ── Conta / Segurança (2FA email + códigos de recuperação) ─────────
router.get('/conta/seguranca', eAutenticado, async (req, res) => {
  const user = await User.findByPk(req.user.id);
  res.render('conta/seguranca', {
    titulo: 'Segurança da conta',
    doisFatoresAtivo: Boolean(user && user.two_fa_ativo),
    doisFatoresMetodo: user ? user.two_fa_metodo : 'email',
    temRecovery: Boolean(user && user.two_fa_recovery_hash),
  });
});

// Passo 1 da ativação — envia código e prepara a confirmação.
router.post('/conta/2fa/ativar', eAutenticado, async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.redirect('/login');
  const envio = await enviarCodigo2fa(user, req);
  if (!envio.ok) {
    req.flash('error_msg', 'Não foi possível enviar o código de verificação (verifique o SMTP em Emails).');
    return res.redirect('/conta/seguranca');
  }
  req.session.pendente2faAtivar = user.id;
  await audit({ userId: user.id, acao: '2fa_codigo_enviado', entidade: 'User', entidadeId: user.id, detalhes: { fase: 'ativar' } }).catch(() => {});
  req.flash('success_msg', 'Enviámos um código para o seu email. Introduza-o para ativar a verificação em duas etapas.');
  return res.redirect('/conta/2fa/ativar/codigo');
});

router.get('/conta/2fa/ativar/codigo', eAutenticado, (req, res) => {
  if (req.session.pendente2faAtivar !== req.user.id) return res.redirect('/conta/seguranca');
  res.render('auth/2fa-ativar', { titulo: 'Ativar verificação em duas etapas' });
});

// Passo 2 — confirma o código e guarda os códigos de recuperação.
router.post('/conta/2fa/ativar/codigo', eAutenticado, limite2fa, async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user || req.session.pendente2faAtivar !== user.id) return res.redirect('/conta/seguranca');
  const codigo = String(req.body.codigo || '').trim();
  const hash = doisFatores.hashCodigo(codigo);
  const valido =
    user.two_fa_email_codigo_hash &&
    hash === user.two_fa_email_codigo_hash &&
    user.two_fa_email_codigo_expira &&
    new Date(user.two_fa_email_codigo_expira) > new Date();
  if (!valido) {
    await user.update({ two_fa_email_tentativas: (user.two_fa_email_tentativas || 0) + 1 });
    req.flash('error_msg', 'Código inválido ou expirado.');
    return res.redirect('/conta/2fa/ativar/codigo');
  }
  // Ativa 2FA (email) e gera códigos de recuperação (mostrados uma única vez).
  const recovery = doisFatores.gerarRecoveryCodes(10);
  await user.update({
    two_fa_ativo: true,
    two_fa_metodo: 'email',
    two_fa_totp_secret: null,
    two_fa_email_codigo_hash: null,
    two_fa_email_codigo_expira: null,
    two_fa_email_tentativas: 0,
    two_fa_recovery_hash: doisFatores.hashRecovery(recovery),
  });
  delete req.session.pendente2faAtivar;
  req.session.codigosRecuperacao = recovery;
  await audit({ userId: user.id, acao: 'ativar_2fa', entidade: 'User', entidadeId: user.id, detalhes: { metodo: 'email' } }).catch(() => {});
  return res.redirect('/conta/2fa/codigos');
});

// ── 2FA TOTP (Aplicação autenticadora) ──────────────────────────────
// Passo 1 — gera segredo e mostra QR Code para importar.
router.post('/conta/2fa/totp/iniciar', eAutenticado, async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.redirect('/login');
  if (user.two_fa_ativo) {
    req.flash('error_msg', 'A verificação em duas etapas já está ativa.');
    return res.redirect('/conta/seguranca');
  }
  const segredo = doisFatores.gerarSegredoTOTP();
  req.session.totpAtivacao = { userId: user.id, segredo };
  await audit({ userId: user.id, acao: '2fa_totp_iniciado', entidade: 'User', entidadeId: user.id }).catch(() => {});
  return res.redirect('/conta/2fa/totp/confirmar');
});

router.get('/conta/2fa/totp/confirmar', eAutenticado, (req, res) => {
  const ativ = req.session.totpAtivacao;
  if (!ativ || ativ.userId !== req.user.id) return res.redirect('/conta/seguranca');
  const uri = doisFatores.otpauthURI({ segredo: ativ.segredo, email: req.user.email });
  res.render('auth/2fa-totp', { titulo: 'Ativar aplicação autenticadora', uri });
});

// Passo 2 — valida um código da aplicação e ativa o TOTP + recovery codes.
router.post('/conta/2fa/totp/confirmar', eAutenticado, limite2fa, async (req, res) => {
  const ativ = req.session.totpAtivacao;
  if (!ativ || ativ.userId !== req.user.id) return res.redirect('/conta/seguranca');
  const user = await User.findByPk(req.user.id);
  if (!user) return res.redirect('/login');
  const codigo = String(req.body.codigo || '').trim();
  if (!doisFatores.verificarTOTP(ativ.segredo, codigo)) {
    req.flash('error_msg', 'Código da aplicação autenticadora inválido. Tente novamente.');
    return res.redirect('/conta/2fa/totp/confirmar');
  }
  const recovery = doisFatores.gerarRecoveryCodes(10);
  await user.update({
    two_fa_ativo: true,
    two_fa_metodo: 'totp',
    two_fa_totp_secret: ativ.segredo,
    two_fa_email_codigo_hash: null,
    two_fa_email_codigo_expira: null,
    two_fa_email_tentativas: 0,
    two_fa_recovery_hash: doisFatores.hashRecovery(recovery),
  });
  delete req.session.totpAtivacao;
  req.session.codigosRecuperacao = recovery;
  await audit({ userId: user.id, acao: 'ativar_2fa', entidade: 'User', entidadeId: user.id, detalhes: { metodo: 'totp' } }).catch(() => {});
  return res.redirect('/conta/2fa/codigos');
});

// Mostra uma única vez os códigos de recuperação gerados na ativação.
router.get('/conta/2fa/codigos', eAutenticado, (req, res) => {
  const codigos = req.session.codigosRecuperacao;
  if (!codigos || !codigos.length) return res.redirect('/conta/seguranca');
  res.render('conta/codigos-recuperacao', { titulo: 'Códigos de recuperação', codigos });
});

router.post('/conta/2fa/codigos-guardados', eAutenticado, (req, res) => {
  delete req.session.codigosRecuperacao;
  req.flash('success_msg', 'Verificação em duas etapas ativada. Guarde os códigos de recuperação num local seguro.');
  res.redirect('/conta/seguranca');
});

// Desativação (com confirmação explícita).
router.post('/conta/2fa/desativar', eAutenticado, async (req, res) => {
  const confirmar = req.body.confirmar === '1' || req.body.confirmar === 'on';
  if (!confirmar) {
    req.flash('error_msg', 'Confirme que pretende desativar a verificação em duas etapas.');
    return res.redirect('/conta/seguranca');
  }
  const user = await User.findByPk(req.user.id);
  if (!user) return res.redirect('/login');
  await user.update({
    two_fa_ativo: false,
    two_fa_metodo: 'email',
    two_fa_totp_secret: null,
    two_fa_email_codigo_hash: null,
    two_fa_email_codigo_expira: null,
    two_fa_email_tentativas: 0,
    two_fa_recovery_hash: null,
  });
  await audit({ userId: user.id, acao: 'desativar_2fa', entidade: 'User', entidadeId: user.id }).catch(() => {});
  req.flash('success_msg', 'Verificação em duas etapas desativada.');
  res.redirect('/conta/seguranca');
});

router.get('/logout', (req, res, next) => {
  const userId = req.user ? req.user.id : null;
  const email = req.user ? req.user.email : null;
  req.logout((err) => {
    if (err) return next(err);
    if (userId) {
      audit({ userId, acao: 'terminar_sessao', entidade: 'User', entidadeId: userId, detalhes: { email } }).catch(() => {});
    }
    req.flash('success_msg', 'Sessão terminada com sucesso.');
    res.redirect('/login');
  });
});

// ── Recuperação de palavra-passe ───────────────────────────────────
router.get('/recuperar', (req, res) => {
  res.render('auth/recuperar');
});

router.post('/recuperar', limiteRecuperar, async (req, res) => {
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

router.post('/redefinir/:token', limiteRedefinir, async (req, res) => {
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

// ── Aceitar convite (definir palavra-passe + confirmar email) ──────
// Token único com validade (30 dias por omissão); estados pendente/enviado
// → aceite. Um convite revogado/aceite não pode ser reutilizado.
async function utilizadorPorConvite(token) {
  const user = await User.findOne({ where: { convite_token: token } });
  return user || null;
}

router.get('/aceitar-convite/:token', async (req, res) => {
  const user = await utilizadorPorConvite(req.params.token);
  if (!user) {
    req.flash('error_msg', 'Convite inválido.');
    return res.redirect('/login');
  }
  const estado = convites.estadoDoConvite(user);
  if (estado === 'aceite' || estado === 'revogado') {
    req.flash('error_msg', 'Este convite já foi utilizado.');
    return res.redirect('/login');
  }
  if (estado === 'expirado') {
    req.flash('error_msg', 'Este convite expirou. Peça à administração para o reenviar.');
    return res.redirect('/login');
  }
  res.render('auth/aceitar-convite', { titulo: 'Aceitar convite', token: req.params.token });
});

router.post('/aceitar-convite/:token', limiteRedefinir, async (req, res) => {
  const { password, password2 } = req.body;
  if (!password || password.length < 8) {
    req.flash('error_msg', 'A palavra-passe deve ter pelo menos 8 caracteres.');
    return res.redirect(`/aceitar-convite/${req.params.token}`);
  }
  if (password !== password2) {
    req.flash('error_msg', 'As palavras-passe não coincidem.');
    return res.redirect(`/aceitar-convite/${req.params.token}`);
  }
  const user = await utilizadorPorConvite(req.params.token);
  if (!user) {
    req.flash('error_msg', 'Convite inválido.');
    return res.redirect('/login');
  }
  const estado = convites.estadoDoConvite(user);
  if (estado === 'aceite' || estado === 'revogado' || estado === 'expirado') {
    req.flash('error_msg', estado === 'expirado'
      ? 'Este convite expirou. Peça à administração para o reenviar.'
      : 'Este convite já não pode ser utilizado.');
    return res.redirect('/login');
  }
  const hash = await bcrypt.hash(password, 10);
  await user.update({
    password_hash: hash,
    email_confirmado: true,
    email_confirmado_at: new Date(),
    convite_token: null,
    convite_token_expira: null,
    convite_estado: 'aceite',
  });
  await audit({ userId: user.id, acao: 'aceitar_convite', entidade: 'User', entidadeId: user.id, detalhes: { email: user.email } }).catch(() => {});
  req.flash('success_msg', 'Conta ativada. Já pode iniciar sessão.');
  res.redirect('/login');
});

module.exports = router;
