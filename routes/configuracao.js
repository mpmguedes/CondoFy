const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Condominio, BackupLog, AuditLog, User } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { getCondominio, clearCondominioCache } = require('../helpers/condominio');
const { getConfig, setConfig } = require('../helpers/config');
const { listarAutomacoes, guardarAutomacoes } = require('../helpers/automacoes');
const drive = require('../helpers/drive');
// Fachada de armazenamento multi-provedor (Google Drive | Dropbox | OneDrive).
const storage = require('../helpers/storage');
const { validarNif, validarIban } = require('../public/js/validacao-fiscal');

const router = express.Router();
// Isolamento: a configuração edita o condomínio ATIVO (sessão).
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('admin'));

// Provedores ligados pelo fluxo OAuth genérico (o Google Drive mantém as
// rotas históricas /admin/config/drive/*, sem alterações).
const PROVEDORES_OAUTH = new Set(['dropbox', 'onedrive']);

const VAR_REDIRECT = {
  dropbox: 'DROPBOX_REDIRECT_URI',
  onedrive: 'ONEDRIVE_REDIRECT_URI',
};

// Redirect URI do provedor: .env (quando definido) ou derivado do pedido.
function redirectUriDe(req, provedor) {
  const daEnv = String(process.env[VAR_REDIRECT[provedor]] || '').trim();
  if (daEnv) return daEnv;
  return `${req.protocol}://${req.get('host')}/admin/config/armazenamento/${provedor}/callback`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  // O logótipo é guardado em public/uploads (servido como imagem estática):
  // o tipo é validado no SERVIDOR (não basta o accept do formulário) para não
  // permitir gravar HTML/SVG executável na origem da aplicação.
  fileFilter: (req, file, cb) => {
    const permitidos = new Set(['image/png', 'image/jpeg']);
    if (!permitidos.has(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('Formato de logótipo não suportado (use PNG ou JPG).'));
    }
    return cb(null, true);
  },
});

// Dados de armazenamento/backups (Google Drive, pasta de destino, último backup),
// usados pelo separador "Armazenamento e Backups".
async function dadosArmazenamento(condominioId) {
  const driveEstado = await drive.estadoLigacao();

  const [ultimoBackup, raizDbRaw, backupsDb, estados] = await Promise.all([
    BackupLog.findOne({ order: [['id', 'DESC']] }).catch(() => null),
    getConfig('google_drive_root_folder', '').catch(() => ''),
    getConfig('drive_auto_backups', '1').catch(() => '1'),
    storage.estadoDoCondominio(condominioId).catch(() => ({ escolhido: 'google_drive', provedores: [] })),
  ]);

  // Fonte única de verdade: BD → .env → pasta inicial "GesCondu".
  const raizDb = String(raizDbRaw || '').trim();
  const raizEfetiva = raizDb || (process.env.GOOGLE_DRIVE_ROOT_FOLDER || '').trim() || 'GesCondu';

  return {
    driveLigado: driveEstado.ligado,
    driveEstado,
    driveOpcoes: { pastaRaiz: raizEfetiva, backupsDrive: String(backupsDb) !== '0' },
    ultimoBackup: ultimoBackup ? ultimoBackup.toJSON() : null,
    armazenamento: estados,
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
    ...(await dadosArmazenamento(req.condominioId)),
  });
});

// ── Serviço de armazenamento do condomínio ─────────────────────────
// A escolha do armazenamento principal e do destino de backups é feita em
// /config/armazenamento/principal e /config/armazenamento/backups (abaixo).

// Ligar (passo 1): envia o administrador para o fornecedor escolhido.
// Âmbito: 'condominio' (documentos do condomínio, por omissão) ou 'plataforma'
// (ligação da instalação, usada pelos backups).
router.get('/config/armazenamento/:provedor/ligar', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  const ambito = req.query.ambito === 'plataforma' ? 'plataforma' : 'condominio';
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const p = storage.obterProvedor(provedor);
  const alvo = ambito === 'plataforma' ? null : req.condominioId;
  const estado = await p.estadoLigacao(alvo);
  if (!estado.ativo || !estado.credenciais) {
    // Mensagem amigável: o utilizador final nunca vê detalhes técnicos.
    req.flash('error_msg', `${p.rotulo()} ainda não está disponível nesta instalação. Contacte o administrador do GesCondu.`);
    return res.redirect('/admin/config/armazenamento');
  }

  const redirectUri = redirectUriDe(req, provedor);
  const state = crypto.randomBytes(18).toString('hex');
  // O estado fica na sessão e inclui condomínio e âmbito: o callback nunca
  // aceita nem o condomínio nem o âmbito vindos do browser.
  req.session.storageOauthState = { provedor, state, ambito, condominioId: ambito === 'plataforma' ? null : req.condominioId };
  const url = p.urlAutorizacao({ redirectUri, state, condominioId: req.session.storageOauthState.condominioId });
  return res.redirect(url);
});

// Ligar (passo 2): o fornecedor devolve o código de autorização.
router.get('/config/armazenamento/:provedor/callback', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const guardado = req.session.storageOauthState || null;
  delete req.session.storageOauthState;

  const { code, state, error } = req.query;
  if (error) {
    req.flash('error_msg', 'Autorização não concluída no fornecedor. Pode voltar a tentar.');
    return res.redirect('/admin/config/armazenamento');
  }
  if (!code) {
    req.flash('error_msg', 'Não foi recebido o código de autorização.');
    return res.redirect('/admin/config/armazenamento');
  }
  if (!guardado || guardado.provedor !== provedor || guardado.state !== state) {
    req.flash('error_msg', 'Pedido de autorização inválido (estado não confere). Tente novamente.');
    return res.redirect('/admin/config/armazenamento');
  }

  const p = storage.obterProvedor(provedor);
  try {
    const tokens = await p.trocarCodigo({
      code,
      redirectUri: redirectUriDe(req, provedor),
      // Âmbito guardado na sessão: 'condominio' liga a conta ao condomínio ativo,
      // 'plataforma' cria a ligação da instalação (usada pelos backups).
      condominioId: guardado.ambito === 'plataforma' ? null : guardado.condominioId,
      plataforma: guardado.ambito === 'plataforma',
    });
    await storage.inicializar();
    await audit({
      userId: req.user.id,
      acao: 'ligar_armazenamento',
      entidade: p.rotulo(),
      entidadeId: guardado.ambito === 'plataforma' ? null : guardado.condominioId,
      detalhes: { provedor, ambito: guardado.ambito || 'condominio', conta: tokens && tokens.conta ? tokens.conta : null },
    }).catch(() => {});
    const onde = guardado.ambito === 'plataforma' ? 'à plataforma' : 'a este condomínio';
    req.flash('success_msg', `${p.rotulo()} ligado ${onde}${tokens && tokens.conta ? ` (${tokens.conta})` : ''}.`);
  } catch (err) {
    console.error(`[armazenamento] callback ${provedor}:`, err.message);
    req.flash('error_msg', `Não foi possível ligar ${p.rotulo()}: ${err.message}`);
  }
  return res.redirect('/admin/config/armazenamento');
});

// Desligar: remove os tokens da ligação (do condomínio ou da plataforma). Os
// ficheiros no fornecedor NÃO são apagados nem despartilhados.
router.post('/config/armazenamento/:provedor/desligar', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const p = storage.obterProvedor(provedor);
  try {
    // O âmbito tem de ser explícito: sem chave de condomínio, os adaptadores
    // recusam-se a apagar uma ligação (protege a ligação de um condomínio de
    // ser removida por engano). Sem este argumento, "Desligar (plataforma)"
    // não fazia nada e o serviço continuava a aparecer ligado.
    await p.desligar(plataforma ? null : req.condominioId, { plataforma });
    await storage.inicializar();
    // Desligar o serviço de backup liberta o destino configurado.
    if (plataforma && (await storage.destinoDeBackup()) === provedor) {
      await storage.definirDestinoDeBackup(null);
    }
    await audit({
      userId: req.user.id,
      acao: 'desligar_armazenamento',
      entidade: p.rotulo(),
      entidadeId: plataforma ? null : req.condominioId,
      detalhes: { provedor, ambito: plataforma ? 'plataforma' : 'condominio' },
    }).catch(() => {});
    req.flash('success_msg', `${p.rotulo()} desligado${plataforma ? ' (ligação da plataforma)' : ''}. Os ficheiros já guardados não foram apagados.`);
  } catch (err) {
    req.flash('error_msg', `Não foi possível desligar ${p.rotulo()}: ${err.message}`);
  }
  return res.redirect('/admin/config/armazenamento');
});

// Testar a ligação (sem criar pastas nem enviar ficheiros).
router.post('/config/armazenamento/:provedor/testar', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const p = storage.obterProvedor(provedor);
  const r = await p.testarLigacao(plataforma ? null : req.condominioId);
  if (r.ok) {
    await audit({ userId: req.user.id, acao: 'testar_armazenamento', entidade: p.rotulo(), detalhes: { ok: true, ambito: plataforma ? 'plataforma' : 'condominio' } }).catch(() => {});
    req.flash('success_msg', r.conta ? `✓ Ligação a ${p.rotulo()} estabelecida (${r.conta}).` : `✓ Ligação a ${p.rotulo()} estabelecida.`);
  } else {
    req.flash('error_msg', `✕ Não foi possível testar ${p.rotulo()}: ${r.erro}`);
  }
  return res.redirect('/admin/config/armazenamento');
});

// ── Armazenamento principal (documentos) ───────────────────────────
// Só pode ser principal um serviço LIGADO neste condomínio. Os documentos
// continuam a ser gravados num único serviço (sem duplicação automática) e é
// este o serviço usado pelas automações de documentos.
router.post('/config/armazenamento/principal', async (req, res) => {
  const nome = String(req.body.provedor || '').trim().toLowerCase();
  try {
    const p = storage.obterProvedor(nome);
    if (!p) throw new Error('Serviço de armazenamento desconhecido.');
    if (!p.isConfigured(req.condominioId)) {
      throw new Error(`${p.rotulo()} não está ligado a este condomínio. Ligue o serviço antes de o tornar principal.`);
    }
    await storage.definirPrincipalDoCondominio(req.condominioId, nome);
    await audit({
      userId: req.user.id,
      acao: 'definir_armazenamento_principal',
      entidade: 'Condominio',
      entidadeId: req.condominioId,
      detalhes: { provedor: nome },
    }).catch(() => {});
    req.flash('success_msg', `Armazenamento principal dos documentos: ${p.rotulo()}.`);
  } catch (err) {
    req.flash('error_msg', `Não foi possível definir o armazenamento principal: ${err.message}`);
  }
  res.redirect('/admin/config/armazenamento');
});

// Compatibilidade com o nome anterior da rota.
router.post('/config/armazenamento/provedor', (req, res) => res.redirect(307, '/admin/config/armazenamento/principal'));

// ── Destino de backups (instalação) ────────────────────────────────
// Os backups contêm dados de todos os condomínios: o destino usa sempre uma
// ligação de PLATAFORMA e pode ser um serviço diferente do principal.
router.post('/config/armazenamento/backups', async (req, res) => {
  const escolha = String(req.body.provedor || '').trim().toLowerCase();
  try {
    if (!escolha || escolha === 'nenhum') {
      await storage.definirDestinoDeBackup(null);
      req.flash('success_msg', 'Backups passam a ser guardados apenas localmente no servidor.');
    } else {
      const p = storage.obterProvedor(escolha);
      if (!p) throw new Error('Serviço de armazenamento desconhecido.');
      if (!p.isConfigured(null)) {
        throw new Error(`${p.rotulo()} não tem ligação da plataforma. Ligue o serviço para backups primeiro.`);
      }
      await storage.definirDestinoDeBackup(escolha);
      req.flash('success_msg', `Destino dos backups: ${p.rotulo()}.`);
    }
    await audit({
      userId: req.user.id,
      acao: 'definir_destino_backups',
      entidade: 'Configuracao',
      detalhes: { provedor: escolha || null },
    }).catch(() => {});
  } catch (err) {
    req.flash('error_msg', `Não foi possível guardar o destino dos backups: ${err.message}`);
  }
  res.redirect('/admin/config/armazenamento');
});

// Upload do logótipo com tratamento de erro amigável (formato inválido não
// deve rebentar a página de Configuração).
function uploadLogotipo(req, res, next) {
  upload.single('logotipo')(req, res, (err) => {
    if (err) {
      req.flash('error_msg', err.message || 'Não foi possível carregar o logótipo.');
      return res.redirect('/admin/config');
    }
    return next();
  });
}

router.post('/config', uploadLogotipo, async (req, res) => {
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

    // Logótipo: a extensão do ficheiro gravado vem do TIPO validado no
    // servidor (nunca do nome enviado pelo browser).
    if (req.file) {
      const ext = String(req.file.mimetype || '').toLowerCase() === 'image/jpeg' ? '.jpg' : '.png';
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

// ── Separador 4: Auditoria (antes com entrada própria no menu principal) ──
router.get('/config/auditoria', async (req, res) => {
  const logs = await AuditLog.findAll({
    include: [{ model: User, as: 'user', attributes: ['nome', 'email'] }],
    order: [['id', 'DESC']],
    limit: 300,
  });
  res.render('admin/configuracao/auditoria', { titulo: 'Auditoria', logs });
});

// Endereço antigo da auditoria (tinha entrada própria no menu principal):
// mantém os links existentes a funcionar.
router.get('/auditoria', (req, res) => res.redirect('/admin/config/auditoria'));

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
// Âmbito: 'condominio' (por omissão — a conta fica associada ao condomínio
// ativo) ou 'plataforma' (conta da instalação, usada pelos backups).
router.get('/config/drive/ligar', async (req, res) => {
  const ambito = req.query.ambito === 'plataforma' ? 'plataforma' : 'condominio';
  const alvo = ambito === 'plataforma' ? null : req.condominioId;
  const estado = await drive.estadoLigacao(alvo);
  if (!estado.ativo || !estado.credenciais) {
    // Mensagem amigável: nunca se expõem detalhes técnicos de configuração.
    req.flash('error_msg', 'O Google Drive ainda não está disponível nesta instalação. Contacte o administrador do GesCondu.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }

  const redirectUri = drive.obterRedirectUri(req);
  const state = crypto.randomBytes(18).toString('hex');
  // O estado (com âmbito e condomínio) fica na sessão: o callback nunca
  // aceita o condomínio nem o âmbito vindos do browser.
  req.session.googleDriveState = { state, ambito, condominioId: alvo };
  const url = drive.construirUrlAutorizacao({ redirectUri, state });
  res.redirect(url);
});

// Passo 4/5/6 — o Google redireciona para aqui; troca o código pelos
// tokens e guarda-os na base de dados (da conta do condomínio ou da
// plataforma, conforme o âmbito pedido no passo 1).
router.get('/config/drive/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const guardado = req.session.googleDriveState;
  delete req.session.googleDriveState;
  const esperado = guardado && typeof guardado === 'object' ? guardado.state : guardado;
  const ambito = guardado && typeof guardado === 'object' ? guardado.ambito : 'plataforma';
  const condominioAlvo = guardado && typeof guardado === 'object' ? guardado.condominioId : null;

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
    await drive.trocarCodigo({
      code,
      redirectUri,
      // Âmbito guardado na sessão: 'condominio' guarda a conta no condomínio;
      // 'plataforma' (e fluxos antigos sem estado) guarda a conta da instalação.
      condominioId: ambito === 'plataforma' ? undefined : condominioAlvo,
    });
    await drive.inicializar();
    await audit({
      userId: req.user.id,
      acao: 'ligar_google_drive',
      entidade: 'GoogleDrive',
      entidadeId: ambito === 'plataforma' ? null : condominioAlvo,
      detalhes: { ambito },
    }).catch(() => {});
    const onde = ambito === 'plataforma' ? 'à plataforma' : 'a este condomínio';
    req.flash('success_msg', `Google Drive ligado ${onde}. Os documentos podem agora ser guardados no Drive.`);
  } catch (err) {
    console.error('[drive] erro no callback OAuth:', err.message);
    req.flash('error_msg', `Não foi possível ligar o Google Drive: ${err.message}`);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Passo Desligar — remove a conta e os tokens (os ficheiros no Drive não
// são apagados). A confirmação é feita na interface.
// Âmbito: a conta do condomínio (por omissão) ou a da plataforma.
router.post('/config/drive/desligar', async (req, res) => {
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  try {
    await drive.desligar(plataforma ? null : req.condominioId);
    await drive.inicializar();
    if (plataforma && (await storage.destinoDeBackup()) === 'google_drive') {
      await storage.definirDestinoDeBackup(null);
    }
    await audit({
      userId: req.user.id,
      acao: 'desligar_google_drive',
      entidade: 'GoogleDrive',
      entidadeId: plataforma ? null : req.condominioId,
      detalhes: { ambito: plataforma ? 'plataforma' : 'condominio' },
    }).catch(() => {});
    req.flash('success_msg', `Google Drive desligado${plataforma ? ' (ligação da plataforma)' : ''}. Os ficheiros já guardados no Drive não foram apagados.`);
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
