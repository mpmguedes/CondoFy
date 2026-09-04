const express = require('express');
const {
  Aviso,
  AvisoDestinatario,
  Pessoa,
  Fracao,
  Documento,
  EmailFila,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { resolverDestinatarios } = require('../helpers/avisos');
const { enfileirarEmail } = require('../helpers/email-fila');
const { smtpConfigured } = require('../helpers/mailer');

const router = express.Router();
router.use(eAdmin);

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

router.get('/avisos', async (req, res) => {
  const avisos = await Aviso.findAll({ order: [['id', 'DESC']] });
  res.render('admin/avisos/listar', { titulo: 'Avisos e comunicações', avisos });
});

router.get('/avisos/nova', async (req, res) => {
  const [fracoes, pessoas, documentos] = await Promise.all([
    Fracao.findAll({ order: [['designacao', 'ASC']] }),
    Pessoa.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] }),
    Documento.findAll({ order: [['data', 'DESC']], limit: 50 }),
  ]);
  res.render('admin/avisos/form', { titulo: 'Novo aviso', fracoes, pessoas, documentos, smtp: smtpConfigured() });
});

router.post('/avisos', async (req, res) => {
  try {
    const { tipo, assunto, mensagem, documento_id, data_programada } = req.body;
    const modo = req.body.modo || 'todos';
    const selecao = { modo, fracoes: toArray(req.body.fracoes), pessoas: toArray(req.body.pessoas) };

    const aviso = await Aviso.create({
      tipo: tipo || 'manual',
      assunto,
      mensagem: mensagem || null,
      documento_id: documento_id || null,
      data_programada: data_programada || null,
      created_by: req.user.id,
    });

    const destinatarios = await resolverDestinatarios(selecao);
    await AvisoDestinatario.bulkCreate(
      destinatarios.map((d) => ({ aviso_id: aviso.id, pessoa_id: d.pessoa_id }))
    );
    await audit({ userId: req.user.id, acao: 'criar_aviso', entidade: 'Aviso', entidadeId: aviso.id, detalhes: { destinatarios: destinatarios.length } });
    req.flash('success_msg', `Aviso criado com ${destinatarios.length} destinatário(s).`);
    res.redirect(`/admin/avisos/${aviso.id}`);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao criar o aviso.');
    res.redirect('/admin/avisos/nova');
  }
});

router.get('/avisos/:id', async (req, res) => {
  const aviso = await Aviso.findByPk(req.params.id, {
    include: [{ model: Documento, as: 'documento' }],
  });
  if (!aviso) return res.redirect('/admin/avisos');

  const destinatarios = await AvisoDestinatario.findAll({
    where: { aviso_id: aviso.id },
    include: [{ model: Pessoa, as: 'pessoa' }],
    order: [[{ model: Pessoa, as: 'pessoa' }, 'nome', 'ASC']],
  });
  const envios = await EmailFila.findAll({ where: { aviso_id: aviso.id }, order: [['id', 'ASC']] });

  res.render('admin/avisos/detalhe', {
    titulo: 'Aviso',
    aviso,
    destinatarios,
    envios,
    smtp: smtpConfigured(),
  });
});

router.post('/avisos/:id/enviar', async (req, res) => {
  const aviso = await Aviso.findByPk(req.params.id, {
    include: [{ model: Documento, as: 'documento' }],
  });
  if (!aviso) return res.redirect('/admin/avisos');

  const destinatarios = await AvisoDestinatario.findAll({
    where: { aviso_id: aviso.id },
    include: [{ model: Pessoa, as: 'pessoa' }],
  });

  const docLink = aviso.documento && aviso.documento.url ? `\n\nDocumento: ${aviso.documento.url}` : '';
  let enfileirados = 0;
  for (const d of destinatarios) {
    if (d.pessoa && d.pessoa.email) {
      await enfileirarEmail({
        destinatario_email: d.pessoa.email,
        destinatario_nome: d.pessoa.nome,
        assunto: aviso.assunto,
        corpo: `${aviso.mensagem || ''}${docLink}`,
        aviso_id: aviso.id,
        documento_id: aviso.documento_id,
      });
      enfileirados++;
    }
  }

  await audit({ userId: req.user.id, acao: 'enviar_aviso', entidade: 'Aviso', entidadeId: aviso.id, detalhes: { enfileirados } });
  req.flash('success_msg', `Foram enfileirados ${enfileirados} email(s).`);
  res.redirect(`/admin/avisos/${aviso.id}`);
});

module.exports = router;
