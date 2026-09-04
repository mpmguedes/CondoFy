const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Condominio } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { getCondominio, clearCondominioCache } = require('../helpers/condominio');
const drive = require('../helpers/drive');

const router = express.Router();
router.use(eAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

router.get('/config', async (req, res) => {
  const condominio = await getCondominio({ force: true });
  res.render('admin/configuracao/index', {
    titulo: 'Configuração do condomínio',
    condominio: condominio ? condominio.toJSON() : null,
    driveLigado: drive.isConfigured(),
  });
});

router.post('/config', upload.single('logotipo'), async (req, res) => {
  try {
    const dados = {
      designacao: req.body.designacao,
      administracao_nome: req.body.administracao_nome || null,
      website: req.body.website || null,
      nif: req.body.nif || null,
      morada: req.body.morada || null,
      codigo_postal: req.body.codigo_postal || null,
      localidade: req.body.localidade || null,
      email: req.body.email || null,
      telefone: req.body.telefone || null,
      iban_principal: req.body.iban_principal || null,
      outros_meios_pagamento: req.body.outros_meios_pagamento || null,
      dados_bancarios_adicionais: req.body.dados_bancarios_adicionais || null,
      identidade_visual: req.body.identidade_visual || 'designacao',
    };

    let condominio = await Condominio.findOne();
    if (!condominio) {
      condominio = await Condominio.create(dados);
    } else {
      await condominio.update(dados);
    }

    // Logótipo
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
      const nome = `logo_${Date.now()}${ext}`;
      const destino = path.join(__dirname, '..', 'public', 'uploads', nome);
      fs.writeFileSync(destino, req.file.buffer);
      await condominio.update({ logotipo: nome });
    }

    clearCondominioCache();
    await audit({ userId: req.user.id, acao: 'editar_configuração', entidade: 'Condominio', entidadeId: condominio.id });
    req.flash('success_msg', 'Configuração guardada.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao guardar a configuração.');
  }
  res.redirect('/admin/config');
});

// Cria a estrutura de pastas no Google Drive.
router.post('/config/drive/estrutura', async (req, res) => {
  if (!drive.isConfigured()) {
    req.flash('error_msg', 'Google Drive não está configurado (verifique o .env).');
    return res.redirect('/admin/config');
  }
  try {
    const estrutura = await drive.criarEstruturaPastas();
    await audit({ userId: req.user.id, acao: 'criar_estrutura_drive', entidade: 'GoogleDrive' });
    req.flash('success_msg', 'Estrutura de pastas criada no Google Drive.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', `Erro ao criar pastas no Drive: ${err.message}`);
  }
  res.redirect('/admin/config');
});

module.exports = router;
