const express = require('express');
const {
  Aviso,
  AvisoDestinatario,
  Pessoa,
  Fracao,
  Documento,
  EmailFila,
} = require('../models');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { resolverDestinatarios } = require('../helpers/avisos');
// Motor ÚNICO de enfileiramento de avisos — o mesmo que o job dos avisos
// programados usa (`jobs/avisos-programados.js`). Não há segundo motor.
const { enfileirarAviso, ESTADOS_EM_CURSO } = require('../helpers/avisos-envio');
const { smtpConfigured } = require('../helpers/mailer');
const documentActions = require('../helpers/document-actions');

const router = express.Router();
// Isolamento: condomínio ativo (sessão validada) em todas as operações.
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('gestor'));

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

router.get('/avisos', async (req, res) => {
  const avisos = await Aviso.findAll({ where: { condominio_id: req.condominioId }, order: [['id', 'DESC']] });
  res.render('admin/avisos/listar', { titulo: 'Avisos e comunicações', avisos });
});

router.get('/avisos/nova', async (req, res) => {
  const [fracoes, pessoas, documentos] = await Promise.all([
    Fracao.findAll({ where: { condominio_id: req.condominioId }, order: [['designacao', 'ASC']] }),
    Pessoa.findAll({ where: { ativo: true, condominio_id: req.condominioId }, order: [['nome', 'ASC']] }),
    Documento.findAll({ where: { condominio_id: req.condominioId }, order: [['data', 'DESC']], limit: 50 }),
  ]);
  res.render('admin/avisos/form', { titulo: 'Novo aviso', fracoes, pessoas, documentos, smtp: smtpConfigured() });
});

router.post('/avisos', async (req, res) => {
  try {
    const { tipo, assunto, mensagem, documento_id, data_programada } = req.body;
    const modo = req.body.modo || 'todos';
    const selecao = { modo, fracoes: toArray(req.body.fracoes), pessoas: toArray(req.body.pessoas) };

    // Documento anexo tem de pertencer ao condomínio ativo (guarda IDOR).
    let documentoId = null;
    if (documento_id) {
      const doc = await Documento.findOne({ where: { id: documento_id, condominio_id: req.condominioId } });
      documentoId = doc ? doc.id : null;
    }

    const aviso = await Aviso.create({
      condominio_id: req.condominioId,
      tipo: tipo || 'manual',
      assunto,
      mensagem: mensagem || null,
      documento_id: documentoId,
      data_programada: data_programada || null,
      created_by: req.user.id,
    });

    const destinatarios = await resolverDestinatarios(selecao, req.condominioId);
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
  const aviso = await Aviso.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
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
  const aviso = await Aviso.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Documento, as: 'documento' }],
  });
  if (!aviso) return res.redirect('/admin/avisos');

  // O enfileiramento (destinatários → deduplicação → templates → fila) vive em
  // `helpers/avisos-envio.js`: é o MESMO motor que o job dos avisos programados
  // usa (P29). Aqui só se decide ENVIAR — a ação do administrador.
  //
  // A deduplicação do envio manual usa `ESTADOS_EM_CURSO`: depois de um `erro`
  // ou de um `cancelado`, carregar em «Enviar» volta a pôr a mensagem na fila,
  // porque é uma ação explícita. (O disparo automático é mais restrito.)
  const r = await enfileirarAviso({
    aviso,
    condominioId: req.condominioId,
    userId: req.user.id,
    baseUrl: `${req.protocol}://${req.get('host')}`,
    estadosJaDespachados: ESTADOS_EM_CURSO,
  });

  if (!r.enfileirados) {
    req.flash('success_msg', 'Não há novos destinatários para enfileirar (envio já agendado/enviado).');
    return res.redirect(`/admin/avisos/${aviso.id}`);
  }

  await audit({
    userId: req.user.id,
    acao: 'enviar_aviso',
    entidade: 'Aviso',
    entidadeId: aviso.id,
    detalhes: { enfileirados: r.enfileirados, comAnexo: r.comAnexo },
  }).catch(() => {});
  req.flash('success_msg', `Foram enfileirados ${r.enfileirados} email(s).${r.comAnexo ? ' (com documento em anexo)' : ''}`);
  res.redirect(`/admin/avisos/${aviso.id}`);
});

module.exports = router;
