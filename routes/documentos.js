const express = require('express');
const multer = require('multer');
const { Documento } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const drive = require('../helpers/drive');

const router = express.Router();
router.use(eAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

router.get('/documentos', async (req, res) => {
  const documentos = await Documento.findAll({ order: [['data', 'DESC'], ['id', 'DESC']] });
  res.render('admin/documentos/listar', { titulo: 'Documentos', documentos, driveLigado: drive.isConfigured() });
});

router.get('/documentos/nova', (req, res) => {
  res.render('admin/documentos/form', { titulo: 'Novo documento', driveLigado: drive.isConfigured() });
});

router.post('/documentos', upload.single('ficheiro'), async (req, res) => {
  try {
    const { nome, tipo, data, url } = req.body;
    const ano = data ? new Date(data).getFullYear() : new Date().getFullYear();

    let driveFileId = null;
    let driveUrl = url || null;
    let mimeType = null;
    let tamanho = null;

    if (req.file) {
      if (!drive.isConfigured()) {
        req.flash('error_msg', 'Google Drive não está configurado — não é possível guardar o ficheiro.');
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
      mimeType = req.file.mimetype;
      tamanho = up.tamanho;
    }

    const documento = await Documento.create({
      tipo: tipo || 'outro',
      nome: nome || (req.file ? req.file.originalname : 'Documento'),
      drive_file_id: driveFileId,
      mime_type: mimeType,
      tamanho,
      data: data || new Date(),
      url: driveUrl,
      created_by: req.user.id,
    });
    await audit({ userId: req.user.id, acao: 'criar_documento', entidade: 'Documento', entidadeId: documento.id });
    req.flash('success_msg', 'Documento guardado.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', `Erro ao guardar o documento: ${err.message}`);
  }
  res.redirect('/admin/documentos');
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

module.exports = router;
