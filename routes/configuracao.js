const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
  const driveEstado = await drive.estadoLigacao();
  res.render('admin/configuracao/index', {
    titulo: 'Configuração do condomínio',
    condominio: condominio ? condominio.toJSON() : null,
    driveLigado: driveEstado.ligado,
    driveEstado,
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

// ═══════════════════════════════════════════════════════════════════
// Google Drive — fluxo OAuth (Ligar / Callback / Desligar)
// ═══════════════════════════════════════════════════════════════════

// Passo 1 — o administrador clica "Ligar Google Drive" e é enviado para
// o Google para autorizar a aplicação (scope mínimo: drive.file).
router.get('/config/drive/ligar', async (req, res) => {
  const estado = await drive.estadoLigacao();
  if (!estado.ativo) {
    req.flash('error_msg', 'A integração Google Drive está desativada. Ative GOOGLE_DRIVE_ENABLED=true no .env.');
    return res.redirect('/admin/config#google-drive');
  }
  if (!estado.credenciais || !estado.redirectUriDefinido) {
    req.flash('error_msg', 'Faltam as credenciais do Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI) no .env.');
    return res.redirect('/admin/config#google-drive');
  }

  const redirectUri = drive.obterRedirectUri(req);
  const state = crypto.randomBytes(18).toString('hex');
  req.session.googleDriveState = state;
  const url = drive.construirUrlAutorizacao({ redirectUri, state });
  res.redirect(url);
});

// Passo 4/5/6 — o Google redireciona para aqui; troca o código pelos
// tokens e guarda-os na base de dados.
router.get('/config/drive/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const esperado = req.session.googleDriveState;
  delete req.session.googleDriveState;

  if (error) {
    req.flash('error_msg', 'Autorização no Google não concluída. Se recusou o acesso, pode voltar a tentar.');
    return res.redirect('/admin/config#google-drive');
  }
  if (!code) {
    req.flash('error_msg', 'Não foi recebido o código de autorização do Google.');
    return res.redirect('/admin/config#google-drive');
  }
  if (esperado && state !== esperado) {
    req.flash('error_msg', 'Pedido de autorização inválido (estado não confere). Tente novamente.');
    return res.redirect('/admin/config#google-drive');
  }

  const redirectUri = drive.obterRedirectUri(req);
  try {
    await drive.trocarCodigo({ code, redirectUri });
    await drive.inicializar();
    await audit({ userId: req.user.id, acao: 'ligar_google_drive', entidade: 'GoogleDrive' });
    req.flash('success_msg', 'Google Drive ligado com sucesso. Os documentos podem agora ser guardados no Drive.');
  } catch (err) {
    console.error('[drive] erro no callback OAuth:', err.message);
    req.flash('error_msg', `Não foi possível ligar o Google Drive: ${err.message}`);
  }
  res.redirect('/admin/config#google-drive');
});

// Passo Desligar — remove a conta e os tokens (os ficheiros no Drive não
// são apagados). A confirmação é feita na interface.
router.post('/config/drive/desligar', async (req, res) => {
  try {
    await drive.desligar();
    await audit({ userId: req.user.id, acao: 'desligar_google_drive', entidade: 'GoogleDrive' });
    req.flash('success_msg', 'Google Drive desligado. Os ficheiros já guardados no Drive não foram apagados.');
  } catch (err) {
    console.error('[drive] erro ao desligar:', err.message);
    req.flash('error_msg', `Não foi possível desligar o Google Drive: ${err.message}`);
  }
  res.redirect('/admin/config#google-drive');
});

// Cria a estrutura de pastas no Google Drive.
router.post('/config/drive/estrutura', async (req, res) => {
  if (!drive.isConfigured()) {
    req.flash('error_msg', 'Google Drive não está ligado — ligue a conta Google primeiro.');
    return res.redirect('/admin/config#google-drive');
  }
  try {
    const estrutura = await drive.criarEstruturaPastas();
    await audit({ userId: req.user.id, acao: 'criar_estrutura_drive', entidade: 'GoogleDrive' });
    req.flash('success_msg', 'Estrutura de pastas criada/verificada no Google Drive (CondoFy).');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', err.message);
  }
  res.redirect('/admin/config#google-drive');
});

module.exports = router;
