// ─────────────────────────────────────────────────────────────────────
// Emails — central administrativa (fila) + configuração SMTP + teste.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const { EmailFila, Documento, Aviso, User } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const mailer = require('../helpers/mailer');
const {
  processarEmailUnico,
  cancelarEmail,
  contarFila,
  reenviarEmail,
} = require('../helpers/email-fila');
const { listarPreferencias, guardarPreferencias } = require('../helpers/notificacoes');

const router = express.Router();
router.use(eAdmin);

const ESTADOS_LABEL = {
  pendente: 'Pendente',
  a_enviar: 'A enviar',
  enviado: 'Enviado',
  erro: 'Erro',
  cancelado: 'Cancelado',
};

function filtraPor(filtro) {
  if (filtro === 'pendentes') return { estado: { [Op.in]: ['pendente', 'a_enviar'] } };
  if (filtro === 'enviados') return { estado: 'enviado' };
  if (filtro === 'erros') return { estado: 'erro' };
  if (filtro === 'cancelados') return { estado: 'cancelado' };
  return {};
}

// Filtro por origem (tipo de documento/entidade).
const ORIGENS = {
  quotas: { rotulo: 'Quotas', condicao: { entidade_tipo: 'Quota' } },
  recibos: { rotulo: 'Recibos', condicao: { entidade_tipo: 'Pagamento' } },
  avisos: { rotulo: 'Avisos', condicao: { aviso_id: { [Op.ne]: null } } },
  documentos: { rotulo: 'Documentos', condicao: { documento_id: { [Op.ne]: null }, aviso_id: null } },
  fornecedores: { rotulo: 'Fornecedores', condicao: { entidade_tipo: 'PagamentoFornecedor' } },
};

function filtraOrigem(tipo) {
  const origem = ORIGENS[tipo];
  return origem ? origem.condicao : {};
}

router.get('/emails', async (req, res) => {
  const filtro = ['pendentes', 'enviados', 'erros', 'cancelados'].includes(req.query.estado)
    ? req.query.estado
    : 'todas';
  const tipo = Object.prototype.hasOwnProperty.call(ORIGENS, req.query.tipo) ? req.query.tipo : 'todas';

  const [contagens, emails, estadoSmtp, preferencias] = await Promise.all([
    contarFila(),
    EmailFila.findAll({
      where: { ...filtraPor(filtro), ...filtraOrigem(tipo) },
      include: [
        { model: Documento, as: 'documento', attributes: ['id', 'nome', 'drive_status', 'url'] },
        { model: Aviso, as: 'aviso', attributes: ['id', 'assunto'] },
        { model: User, as: 'utilizador', attributes: ['id', 'nome'] },
      ],
      order: [['id', 'DESC']],
      limit: 200,
    }),
    mailer.obterEstadoSmtp(),
    listarPreferencias(),
  ]);

  res.render('admin/emails/index', {
    titulo: 'Emails',
    emails,
    filtro,
    tipo,
    origens: ORIGENS,
    contagens,
    estadoSmtp,
    preferencias,
    estadosLabel: ESTADOS_LABEL,
  });
});

// ── Notificações automáticas (preferências por evento) ─────────────
router.post('/emails/notificacoes', async (req, res) => {
  try {
    const r = await guardarPreferencias(req.body);
    await audit({ userId: req.user.id, acao: 'configurar_notificacoes', entidade: 'Configuracao', detalhes: { eventos: r.eventos } }).catch(() => {});
    req.flash('success_msg', 'Preferências de notificações guardadas.');
  } catch (err) {
    console.error('[emails] notificações:', err.message);
    req.flash('error_msg', 'Não foi possível guardar as notificações.');
  }
  res.redirect('/admin/emails#notificacoes');
});

// ── SMTP: guardar configuração ──────────────────────────────────────
router.post('/emails/smtp', async (req, res) => {
  try {
    await mailer.guardarConfigSmtp({
      host: req.body.host,
      port: req.body.port,
      user: req.body.user,
      pass: req.body.pass, // vazio → mantém a existente
      tls: req.body.tls,
      from: req.body.from,
      fromName: req.body.from_name,
    });
    await audit({ userId: req.user.id, acao: 'configurar_smtp', entidade: 'Configuracao' });
    req.flash('success_msg', 'Configuração SMTP guardada.');
  } catch (err) {
    console.error('[smtp] erro ao guardar:', err.message);
    req.flash('error_msg', 'Não foi possível guardar a configuração SMTP.');
  }
  res.redirect('/admin/emails#smtp');
});

// ── SMTP: testar ligação (verificação, sem enviar) ─────────────────
router.post('/emails/smtp/testar', async (req, res) => {
  try {
    const r = await mailer.testarLigacao();
    if (r.ok) {
      await audit({ userId: req.user.id, acao: 'testar_smtp', entidade: 'Configuracao', detalhes: { ok: true, servidor: r.servidor } });
      req.flash('success_msg', '✓ Ligação SMTP estabelecida.');
    } else {
      req.flash('error_msg', `✕ ${r.erro}`);
    }
  } catch (err) {
    req.flash('error_msg', `✕ Não foi possível ligar ao servidor SMTP: ${mailer.mensagemErroAmigavel(err)}`);
  }
  res.redirect('/admin/emails#smtp');
});

// ── SMTP: enviar email de teste (envio IMEDIATO, fora da fila) ─────
router.post('/emails/teste', async (req, res) => {
  const para = String(req.body.para || '').trim();
  if (!para) {
    req.flash('error_msg', 'Indique o email de destino do teste.');
    return res.redirect('/admin/emails#smtp');
  }
  const r = await mailer.enviarEmailTeste({
    para,
    assunto: req.body.assunto || 'Teste SMTP — CondoFy',
    mensagem: req.body.mensagem || 'Este é um email de teste do CondoFy.',
  });
  await audit({
    userId: req.user.id,
    acao: 'email_teste',
    entidade: 'EmailFila',
    detalhes: { ok: r.ok, para },
  }).catch(() => {});
  if (r.ok) {
    req.flash('success_msg', `✓ Email de teste enviado para ${para}.`);
  } else {
    req.flash('error_msg', `✕ Não foi possível enviar o email de teste: ${r.erro}`);
  }
  res.redirect('/admin/emails#smtp');
});

// ── Ações sobre a fila ──────────────────────────────────────────────
router.post('/emails/:id/reenviar', async (req, res) => {
  try {
    const item = await EmailFila.findByPk(req.params.id);
    if (!item) throw new Error('Registo não encontrado.');
    await reenviarEmail(item.id);
    if (item.estado === 'enviado') {
      req.flash('success_msg', 'Email marcado para reenvio (será processado pela fila).');
    } else {
      await processarEmailUnico(item.id);
      req.flash('success_msg', `Email reenviado para ${item.destinatario_email}.`);
    }
    await audit({ userId: req.user.id, acao: 'reenviar_email', entidade: 'EmailFila', entidadeId: item.id }).catch(() => {});
  } catch (err) {
    console.error('[emails] reenviar:', err.message);
    req.flash('error_msg', `Não foi possível reenviar: ${err.message}`);
  }
  res.redirect('/admin/emails');
});

router.post('/emails/:id/cancelar', async (req, res) => {
  try {
    const item = await cancelarEmail(req.params.id);
    await audit({ userId: req.user.id, acao: 'cancelar_email', entidade: 'EmailFila', entidadeId: item.id }).catch(() => {});
    req.flash('success_msg', 'Email cancelado.');
  } catch (err) {
    req.flash('error_msg', `Não foi possível cancelar: ${err.message}`);
  }
  res.redirect('/admin/emails');
});

module.exports = router;
