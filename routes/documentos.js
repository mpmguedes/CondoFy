const express = require('express');
const multer = require('multer');
const { Op } = require('sequelize');
const { Documento, Pessoa } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const drive = require('../helpers/drive');
const documentActions = require('../helpers/document-actions');
const { enfileirarEmail: enfileirarEmailFila } = require('../helpers/email-fila');
const { compor: comporEmail, nomeFicheiro: nomeFicheiroEmail } = require('../helpers/email-templates');
const { getCondominio } = require('../helpers/condominio');

const router = express.Router();
router.use(eAdmin);

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// Estrutura de pastas da biblioteca do condomínio.
const PASTAS = {
  atas: 'Atas',
  convocatorias: 'Convocatórias',
  contratos: 'Contratos',
  regulamentos: 'Regulamentos',
  recibos: 'Recibos de Pagamento',
  assembleias: 'Assembleias',
  apolices: 'Seguros — Apólices',
  comprovativos: 'Seguros — Comprovativos',
  faturas: 'Faturas',
  outros: 'Outros',
};

// Tipos permitidos por pasta (para limitar o upload).
const TIPOS_POR_PASTA = {
  atas: ['ata', 'outro'],
  convocatorias: ['convocatoria', 'outro'],
  contratos: ['contrato', 'outro'],
  regulamentos: ['outro'],
  recibos: ['recibo', 'outro'],
  assembleias: ['ata', 'convocatoria', 'outro'],
  apolices: ['outro'],
  comprovativos: ['outro'],
  faturas: ['fatura', 'outro'],
  outros: ['outro', 'ata', 'convocatoria', 'fatura', 'contrato', 'relatorio', 'orcamento'],
};

router.get('/documentos', async (req, res) => {
  const pasta = req.query.pasta || null;
  const where = pasta && PASTAS[pasta] ? { pasta } : {};
  const documentos = await Documento.findAll({ where, order: [['data', 'DESC'], ['id', 'DESC']] });
  res.render('admin/documentos/listar', {
    titulo: 'Documentos',
    documentos,
    pasta,
    pastas: PASTAS,
    driveLigado: drive.isConfigured(),
  });
});

router.get('/documentos/nova', (req, res) => {
  res.render('admin/documentos/form', {
    titulo: 'Novo documento',
    pastas: PASTAS,
    driveLigado: drive.isConfigured(),
  });
});

router.post('/documentos', upload.single('ficheiro'), async (req, res) => {
  try {
    const { nome, tipo, data, url, pasta } = req.body;
    const pastaEscolhida = PASTAS[pasta] ? pasta : 'outros';
    const ano = data ? new Date(data).getFullYear() : new Date().getFullYear();

    let driveFileId = null;
    let driveUrl = url || null;
    let drivePastaId = null;
    let mimeType = null;
    let tamanho = null;
    let driveUploadedAt = null;

    if (req.file) {
      if (!drive.isConfigured()) {
        req.flash('error_msg', 'Google Drive não está ligado — ligue a conta em Configuração ou indique apenas um URL externo.');
        return res.redirect('/admin/documentos/nova');
      }
      const pastaId = await drive.pastaParaDocumento(tipo, ano);
      const up = await drive.uploadArquivo({
        nome: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        parentFolderId: pastaId,
      });
      driveFileId = up.driveFileId;
      driveUrl = up.url;
      drivePastaId = pastaId;
      mimeType = req.file.mimetype;
      tamanho = up.tamanho;
      driveUploadedAt = new Date();
    }

    const documento = await Documento.create({
      tipo: tipo || 'outro',
      nome: nome || (req.file ? req.file.originalname : 'Documento'),
      pasta: pastaEscolhida,
      drive_file_id: driveFileId,
      drive_folder_id: drivePastaId,
      mime_type: mimeType,
      tamanho,
      data: data || new Date(),
      url: driveUrl,
      drive_status: driveFileId ? 'guardado' : 'nao_guardado',
      drive_uploaded_at: driveUploadedAt,
      created_by: req.user.id,
    });
    await audit({ userId: req.user.id, acao: 'criar_documento', entidade: 'Documento', entidadeId: documento.id });
    req.flash('success_msg', 'Documento guardado.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', `Erro ao guardar o documento: ${err.message}`);
  }
  res.redirect(`/admin/documentos?pasta=${req.body.pasta || ''}`);
});

router.post('/documentos/:id/eliminar', async (req, res) => {
  const documento = await Documento.findByPk(req.params.id);
  if (documento) {
    await documento.destroy();
    await audit({ userId: req.user.id, acao: 'eliminar_documento', entidade: 'Documento', entidadeId: req.params.id });
  }
  req.flash('success_msg', 'Documento eliminado.');
  res.redirect('/admin/documentos');
});

// ── Ações sobre documentos ──────────────────────────────────────────
// Enviar documento por email (fila normal). Pré-preenche destinatários
// manualmente e/ou por seleção de condóminos.
router.get('/documentos/:id/email', async (req, res) => {
  const documento = await Documento.findByPk(req.params.id);
  if (!documento) return res.redirect('/admin/documentos');
  const pessoas = await Pessoa.findAll({
    where: { ativo: true, email: { [Op.ne]: null } },
    order: [['nome', 'ASC']],
  });
  res.render('admin/documentos/email', {
    titulo: 'Enviar documento por email',
    documento,
    pessoas,
    driveLigado: drive.isConfigured(),
  });
});

router.post('/documentos/:id/email', async (req, res) => {
  const documento = await Documento.findByPk(req.params.id);
  if (!documento) return res.redirect('/admin/documentos');

  const destinatarios = [];
  // emails escritos manualmente (separados por vírgula, ponto e vírgula ou linha)
  const manual = String(req.body.emails || '')
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const email of manual) destinatarios.push({ email, nome: null });
  // condóminos selecionados
  const ids = toArray(req.body.pessoas).map(Number);
  if (ids.length) {
    const pessoas = await Pessoa.findAll({ where: { id: { [Op.in]: ids }, email: { [Op.ne]: null } } });
    for (const p of pessoas) destinatarios.push({ email: p.email, nome: p.nome });
  }

  // Anexo (cópia independente): descarrega o ficheiro do Drive quando disponível.
  let anexoBuffer = null;
  let anexoNome = null;
  if (documento.drive_file_id && drive.isConfigured()) {
    try {
      anexoBuffer = await drive.descargarArquivo(documento.drive_file_id);
      anexoNome = String(documento.nome || '').trim() || 'documento.pdf';
    } catch (err) {
      console.error('[documento-email] sem anexo:', err.message);
      anexoBuffer = null; // segue com link
    }
  }
  const comAnexo = Boolean(anexoBuffer);

  const cond = await getCondominio();
  const condNome = (cond && String(cond.designacao || '').trim()) || '';
  const adminNome = (cond && String(cond.administracao_nome || '').trim()) || '';
  const tipoDoc = ['convocatoria', 'recibo'].includes(documento.tipo) ? documento.tipo : 'documento';
  const urlOnline = documento.url || null;

  const notaManual = String(req.body.mensagem || '').trim();
  let enfileirados = 0;
  for (const dest of destinatarios) {
    const tpl = notaManual
      ? comporEmail('generico', {
          destinatarioNome: dest.nome || undefined,
          condominio: condNome,
          administracao: adminNome,
          titulo: documento.nome,
          mensagem: notaManual,
          urlOnline,
          urlTexto: 'Consultar documento',
        })
      : comporEmail(tipoDoc, {
          destinatarioNome: dest.nome || undefined,
          condominio: condNome,
          administracao: adminNome,
          nomeDocumento: documento.nome,
          urlOnline,
          anexo: comAnexo,
        });
    await enfileirarEmailFila({
      destinatario_email: dest.email,
      destinatario_nome: dest.nome || null,
      assunto: tpl.assunto,
      corpo: tpl.text,
      corpo_html: tpl.html,
      documento_id: documento.id,
      entidade_tipo: 'Documento',
      entidade_id: documento.id,
      userId: req.user.id,
      anexoNome: comAnexo ? anexoNome : null,
      anexoBuffer: comAnexo ? anexoBuffer : null,
    });
    enfileirados++;
  }
  await audit({
    userId: req.user.id,
    acao: 'enviar_documento_email',
    entidade: 'Documento',
    entidadeId: documento.id,
    detalhes: { destinatarios: destinatarios.length, comAnexo },
  }).catch(() => {});
  req.flash('success_msg', `Documento enfileirado para envio a ${enfileirados} destinatário(s).${comAnexo ? ' (com PDF em anexo)' : ' (link online; sem anexo — configure o Drive para anexar)'}`);
  res.redirect('/admin/documentos');
});

module.exports = router;
