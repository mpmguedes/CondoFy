const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Condominio, BackupLog } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { getCondominio, clearCondominioCache } = require('../helpers/condominio');
const { getConfig, setConfig } = require('../helpers/config');
const { listarAutomacoes, guardarAutomacoes } = require('../helpers/automacoes');
const drive = require('../helpers/drive');
const { validarNif, validarIban } = require('../public/js/validacao-fiscal');

const router = express.Router();
// Isolamento: a configuração edita o condomínio ATIVO (sessão).
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('admin'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// Dados de armazenamento/backups (Google Drive, pasta de destino, último backup),
// usados pelo separador "Armazenamento e Backups".
async function dadosArmazenamento() {
  const driveEstado = await drive.estadoLigacao();

  const [ultimoBackup, raizDbRaw, backupsDb] = await Promise.all([
    BackupLog.findOne({ order: [['id', 'DESC']] }).catch(() => null),
    getConfig('google_drive_root_folder', '').catch(() => ''),
    getConfig('drive_auto_backups', '1').catch(() => '1'),
  ]);

  // Fonte única de verdade: BD → .env → pasta inicial "GesCondu".
  const raizDb = String(raizDbRaw || '').trim();
  const raizEfetiva = raizDb || (process.env.GOOGLE_DRIVE_ROOT_FOLDER || '').trim() || 'GesCondu';

  return {
    driveLigado: driveEstado.ligado,
    driveEstado,
    driveOpcoes: { pastaRaiz: raizEfetiva, backupsDrive: String(backupsDb) !== '0' },
    ultimoBackup: ultimoBackup ? ultimoBackup.toJSON() : null,
  };
}

// ── Separador 1: Configuração do Condomínio ────────────────────────
router.get('/config', async (req, res) => {
  const condominio = await getCondominio({ force: true, id: req.condominioId });

  res.render('admin/configuracao/index', {
    titulo: 'Configuração do Condomínio',
    condominio: condominio ? condominio.toJSON() : null,
  });
});

// ── Separador 2: Armazenamento e Backups ───────────────────────────
router.get('/config/armazenamento', async (req, res) => {
  res.render('admin/configuracao/armazenamento', {
    titulo: 'Armazenamento e Backups',
    ...(await dadosArmazenamento()),
  });
});

router.post('/config', upload.single('logotipo'), async (req, res) => {
  try {
    // NIF e IBAN: normalizar e validar antes de guardar (nunca confiar no browser).
    const nifValidado = validarNif(req.body.nif);
    if (!nifValidado.ok) {
      req.flash('error_msg', nifValidado.mensagem);
      return res.redirect('/admin/config');
    }
    const ibanValidado = validarIban(req.body.iban_principal);
    if (!ibanValidado.ok) {
      req.flash('error_msg', ibanValidado.mensagem);
      return res.redirect('/admin/config');
    }

    const dados = {
      designacao: req.body.designacao,
      administracao_nome: req.body.administracao_nome || null,
      website: req.body.website || null,
      nif: nifValidado.valor || null,
      morada: req.body.morada || null,
      codigo_postal: req.body.codigo_postal || null,
      localidade: req.body.localidade || null,
      email: req.body.email || null,
      telefone: req.body.telefone || null,
      iban_principal: ibanValidado.valor || null,
      outros_meios_pagamento: req.body.outros_meios_pagamento || null,
      dados_bancarios_adicionais: req.body.dados_bancarios_adicionais || null,
      identidade_visual: req.body.identidade_visual || 'designacao',
    };

    let condominio = await Condominio.findOne({ where: { id: req.condominioId } });
    if (!condominio) {
      req.flash('error_msg', 'Condomínio não encontrado.');
      return res.redirect('/admin/config');
    }
    await condominio.update(dados);

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
// Documentos e Automações (Configurações)
// ═══════════════════════════════════════════════════════════════════
router.get('/config/automacoes', async (req, res) => {
  const grupos = await listarAutomacoes();
  res.render('admin/configuracao/automacoes', {
    titulo: 'Documentos e Automações',
    grupos,
  });
});

router.post('/config/automacoes', async (req, res) => {
  try {
    const r = await guardarAutomacoes(req.body);
    await audit({ userId: req.user.id, acao: 'configurar_automacoes', entidade: 'Configuracao', detalhes: { tipos: r.tipos } }).catch(() => {});
    req.flash('success_msg', 'Automações de documentos guardadas.');
  } catch (err) {
    console.error('[automacoes]', err.message);
    req.flash('error_msg', 'Não foi possível guardar as automações.');
  }
  res.redirect('/admin/config/automacoes');
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
    return res.redirect('/admin/config/armazenamento#google-drive');
  }
  if (!estado.credenciais || !estado.redirectUriDefinido) {
    req.flash('error_msg', 'Faltam as credenciais do Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI) no .env.');
    return res.redirect('/admin/config/armazenamento#google-drive');
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
    return res.redirect('/admin/config/armazenamento#google-drive');
  }
  if (!code) {
    req.flash('error_msg', 'Não foi recebido o código de autorização do Google.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }
  if (esperado && state !== esperado) {
    req.flash('error_msg', 'Pedido de autorização inválido (estado não confere). Tente novamente.');
    return res.redirect('/admin/config/armazenamento#google-drive');
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
  res.redirect('/admin/config/armazenamento#google-drive');
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
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Guarda opções de armazenamento: pasta raiz do Drive e backups automáticos.
router.post('/config/drive/opcoes', async (req, res) => {
  try {
    const pastaRaiz = String(req.body.pasta_raiz || '').trim();
    const backupsDrive = req.body.backups_drive === 'on' || req.body.backups_drive === '1';
    await setConfig('google_drive_root_folder', pastaRaiz);
    await setConfig('drive_auto_backups', backupsDrive ? '1' : '0');
    await audit({ userId: req.user.id, acao: 'configurar_armazenamento_drive', entidade: 'GoogleDrive', detalhes: { pastaRaiz, backupsDrive } }).catch(() => {});
    req.flash('success_msg', 'Opções de armazenamento guardadas.');
  } catch (err) {
    console.error('[drive] opções:', err.message);
    req.flash('error_msg', 'Não foi possível guardar as opções de armazenamento.');
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Testa a ligação atual ao Google Drive (sem criar pastas nem enviar nada).
router.post('/config/drive/testar', async (req, res) => {
  const r = await drive.testarLigacao();
  if (r.ok) {
    await audit({ userId: req.user.id, acao: 'testar_google_drive', entidade: 'GoogleDrive', detalhes: { ok: true } }).catch(() => {});
    req.flash('success_msg', r.conta ? `✓ Ligação ao Google Drive estabelecida (${r.conta}).` : '✓ Ligação ao Google Drive estabelecida.');
  } else {
    req.flash('error_msg', `✕ Não foi possível testar o Google Drive: ${r.erro}`);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Cria a estrutura de pastas no Google Drive (do condomínio ativo).
router.post('/config/drive/estrutura', async (req, res) => {
  if (!drive.isConfigured()) {
    req.flash('error_msg', 'Google Drive não está ligado — ligue a conta Google primeiro.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }
  try {
    // Multi-condomínio: a árvore é <raiz>/<Condomínio>/<ano>/{tipos}; a pasta
    // do condomínio fica registada (condominios.drive_folder_id) para todos os
    // uploads seguintes (a pasta Backups é global e também é criada aqui).
    const estrutura = await drive.criarEstruturaPastas(req.condominioId);
    await audit({ userId: req.user.id, acao: 'criar_estrutura_drive', entidade: 'GoogleDrive', detalhes: { condominioId: req.condominioId } }).catch(() => {});
    req.flash('success_msg', 'Estrutura de pastas do condomínio criada/verificada no Google Drive (raiz → condomínio → ano → tipos).');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', err.message);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

module.exports = router;
