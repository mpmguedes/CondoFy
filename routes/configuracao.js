const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Condominio, BackupLog, AuditLog, User } = require('../models');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { getCondominio, clearCondominioCache } = require('../helpers/condominio');
const { getConfig, setConfig } = require('../helpers/config');
const { listarAutomacoes, guardarAutomacoes } = require('../helpers/automacoes');
const drive = require('../helpers/drive');
// Fachada de armazenamento multi-provedor (Google Drive | Dropbox | OneDrive).
const storage = require('../helpers/storage');
// Interpretação pura do estado do último backup (cópia local vs. cloud).
const backupEstado = require('../helpers/backup-estado');
const { contarPorServico, documentosDoServico } = require('../helpers/documentos-por-servico');
const { validarNif, validarIban } = require('../public/js/validacao-fiscal');
// Email/SMTP: a configuração técnica do serviço de email é uma CONFIGURAÇÃO do
// condomínio (não operação da fila) — vive neste router. O envio do email de
// teste reutiliza o MESMO mailer: não existe uma segunda configuração.
const mailer = require('../helpers/mailer');
// Tips contextuais da área de armazenamento (motor único: helpers/tips.js).
const { tipsDaPagina } = require('../helpers/tips/contexto');

const router = express.Router();
// Isolamento: a configuração edita o condomínio ATIVO (sessão).
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('admin'));

// Provedores ligados pelo fluxo OAuth genérico (o Google Drive mantém as
// rotas históricas /admin/config/drive/*, sem alterações).
const PROVEDORES_OAUTH = new Set(['dropbox', 'onedrive']);

// O Google Drive mantém as rotas próprias (Redirect URI registado na consola
// Google e estado OAuth próprio): as rotas genéricas delegam nelas.
const ROTAS_DRIVE = {
  ligar: '/admin/config/drive/ligar',
  desligar: '/admin/config/drive/desligar',
  testar: '/admin/config/drive/testar',
};

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

  const [ultimoBackup, raizDbRaw, backupsDb, estados, documentosPorServico] = await Promise.all([
    BackupLog.findOne({ order: [['id', 'DESC']] }).catch(() => null),
    getConfig('google_drive_root_folder', '').catch(() => ''),
    getConfig('drive_auto_backups', '1').catch(() => '1'),
    storage.estadoDoCondominio(condominioId).catch(() => ({ escolhido: 'google_drive', provedores: [] })),
    // Quantos documentos deste condomínio estão em cada serviço: permite avisar
    // quando há ficheiros guardados num serviço que não está ligado (sem esse
    // aviso, o administrador só descobre ao tentar abrir um documento).
    contarPorServico(condominioId),
  ]);

  // Fonte única de verdade: BD → .env → pasta inicial "GesCondu".
  const raizDb = String(raizDbRaw || '').trim();
  const raizEfetiva = raizDb || (process.env.GOOGLE_DRIVE_ROOT_FOLDER || '').trim() || 'GesCondu';

  // Cada serviço fica a saber quantos documentos guardou (a vista usa isto para
  // avisar quando não está ligado).
  const provedores = (estados.provedores || []).map((p) => ({
    ...p,
    documentos: documentosDoServico(documentosPorServico, p.nome),
  }));

  // Estado do último backup interpretado (cópia local vs. cópia cloud). As
  // colunas de `backup_logs` chegam para o distinguir — sem migration.
  const rotulosProvedor = {};
  for (const nome of storage.provedores()) {
    const p = storage.obterProvedor(nome);
    if (p) rotulosProvedor[nome] = p.rotulo();
  }

  return {
    driveLigado: driveEstado.ligado,
    driveEstado,
    driveOpcoes: { pastaRaiz: raizEfetiva, backupsDrive: String(backupsDb) !== '0' },
    ultimoBackup: ultimoBackup ? ultimoBackup.toJSON() : null,
    ultimoBackupEstado: backupEstado.interpretar(ultimoBackup, { rotulos: rotulosProvedor }),
    armazenamento: { ...estados, provedores },
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
  const dados = await dadosArmazenamento(req.condominioId);

  // ── Tips contextuais (orientação, distinta dos sinais) ────────────
  // A área é `armazenamento`: o motor só apresenta os tips registados para
  // esta página, e só quando a situação descrita existe mesmo (destino sem
  // ligação, backup falhado, retenção no mínimo...). Tolerante a falha: um tip
  // que não se consegue avaliar simplesmente não aparece.
  let contextoDeTips = { apresentar: [], total: 0, outras: [], limite: 0 };
  try {
    contextoDeTips = await tipsDaPagina({
      area: 'armazenamento',
      condominioId: req.condominioId,
      userId: req.user.id,
      papel: req.papelCondominio,
      dados,
    });
  } catch (err) {
    console.error('[tips] armazenamento:', err.message);
  }

  res.render('admin/configuracao/armazenamento', {
    titulo: 'Armazenamento e Backups',
    ...dados,
    // `voltar` diz à rota de dispensa para onde regressar (validado no servidor).
    tips: { ...contextoDeTips, voltar: '/admin/config/armazenamento' },
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
  if (provedor === 'google_drive') {
    // O Drive usa as rotas próprias (Redirect URI registado no Google).
    return res.redirect(`${ROTAS_DRIVE.ligar}?ambito=${ambito}`);
  }
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
    if (tokens && tokens.conta) {
      req.flash('success_msg', `${p.rotulo()} ligado ${onde} (${tokens.conta}).`);
    } else if (tokens && tokens.contaErro) {
      // A ligação foi criada, mas a conta não ficou identificada (por exemplo:
      // o scope `User.Read` não foi consentido no ecrã da Microsoft). Dizê-lo
      // é mais honesto do que mostrar uma conta que não é a real; a mensagem já
      // vem sanitizada do adaptador (nunca traz tokens).
      req.flash('success_msg', `${p.rotulo()} ligado ${onde}. Não foi possível identificar a conta ligada: ${tokens.contaErro}`);
    } else {
      req.flash('success_msg', `${p.rotulo()} ligado ${onde}.`);
    }
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
  if (provedor === 'google_drive') {
    // 307 preserva o POST e o âmbito.
    return res.redirect(307, `${ROTAS_DRIVE.desligar}?ambito=${plataforma ? 'plataforma' : 'condominio'}`);
  }
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
    // Desligar o serviço de backup liberta o destino configurado — mas só se
    // deixar de existir QUALQUER ligação utilizável para ele (de plataforma ou
    // de outro condomínio). Sem esta verificação, desligar a ligação da
    // plataforma apagava um destino de backups que continuava a funcionar.
    if ((await storage.destinoDeBackup()) === provedor) {
      const restante = storage.ligacaoDeBackup(provedor);
      if (!restante || !restante.origem) await storage.definirDestinoDeBackup(null);
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
  if (provedor === 'google_drive') {
    return res.redirect(307, `${ROTAS_DRIVE.testar}?ambito=${plataforma ? 'plataforma' : 'condominio'}`);
  }
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const p = storage.obterProvedor(provedor);
  const cidTeste = plataforma ? null : req.condominioId;
  const r = await p.testarLigacao(cidTeste);
  // O teste pode detetar que a autorização foi revogada no fornecedor: nesse
  // caso o adaptador remove os tokens guardados. Recarrega-se o estado para a
  // página deixar imediatamente de mostrar o serviço como "Ligado".
  await storage.inicializar().catch(() => {});
  if (r.ok) {
    await audit({ userId: req.user.id, acao: 'testar_armazenamento', entidade: p.rotulo(), detalhes: { ok: true, ambito: plataforma ? 'plataforma' : 'condominio' } }).catch(() => {});
    req.flash('success_msg', r.conta ? `✓ Ligação a ${p.rotulo()} estabelecida (${r.conta}).` : `✓ Ligação a ${p.rotulo()} estabelecida.`);
  } else {
    const removida = !p.isConfigured(cidTeste)
      ? ' A ligação foi removida porque a autorização já não é válida — ligue a conta novamente.'
      : '';
    req.flash('error_msg', `✕ Não foi possível testar ${p.rotulo()}: ${r.erro}${removida}`);
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
// Os backups usam a ligação JÁ EXISTENTE do serviço escolhido (uma ligação por
// serviço, sem contas duplicadas). Como o dump contém dados de todos os
// condomínios, a interface avisa quando a conta é a de um condomínio.
//
// Guarda: a escolha é da INSTALAÇÃO, não do condomínio ativo — só um Super
// Admin a pode fazer (`tenant.apenasSuperAdmin`, decidido por
// `users.role_global`). Sem isto, um admin de condomínio mudava o destino dos
// backups de todos os condomínios. A guarda corre ANTES do handler, pelo que um
// pedido recusado não grava nada.
router.post('/config/armazenamento/backups', tenant.apenasSuperAdmin, async (req, res) => {
  const escolha = String(req.body.provedor || '').trim().toLowerCase();
  try {
    if (!escolha || escolha === 'nenhum') {
      await storage.definirDestinoDeBackup(null);
      req.flash('success_msg', 'Backups passam a ser guardados apenas localmente no servidor.');
    } else {
      const p = storage.obterProvedor(escolha);
      if (!p) throw new Error('Serviço de armazenamento desconhecido.');
      // Mesma condição que o job de backups usa (`ligacaoParaBackup`): só se
      // aceita um destino que o job consiga MESMO usar. Antes bastava haver
      // uma configuração (ligação de plataforma OU do condomínio), e um destino
      // só com ligação de condomínio era aceite pela página mas ignorado pelo
      // job — os backups ficavam no servidor e a página dizia «Dropbox».
      const ligacao = storage.ligacaoDeBackup(escolha);
      if (!ligacao || !ligacao.origem) {
        throw new Error(`${p.rotulo()} não tem nenhuma ligação utilizável. Ligue o serviço antes de o escolher para backups.`);
      }
      await storage.definirDestinoDeBackup(escolha);
      req.flash(
        'success_msg',
        ligacao.conta
          ? `Destino dos backups: ${p.rotulo()} (${ligacao.conta}).`
          : `Destino dos backups: ${p.rotulo()}.`
      );
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

// ── Separador 5: Auditoria (antes com entrada própria no menu principal) ──
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
// Separador 4: Email / SMTP (antes na Central de Emails)
//
// A CONFIGURAÇÃO técnica do serviço de email é administração do condomínio,
// não operação da fila: a Central de Emails fica com a fila (reenviar,
// cancelar) e a configuração passa a viver aqui. Não há — nem pode haver —
// uma segunda configuração SMTP: as três rotas abaixo usam o MESMO
// `helpers/mailer` que a fila usa para enviar.
//
// O envio do email de teste é uma AÇÃO DE VALIDAÇÃO desta configuração: usa a
// configuração JÁ GUARDADA (`obterConfigSmtp` lê a BD com prioridade sobre o
// `.env`), pelo que testa o que está efetivamente a ser usado nos envios reais.
// ═══════════════════════════════════════════════════════════════════
router.get('/config/email', async (req, res) => {
  // `obterEstadoSmtp` nunca devolve a password — apenas o indicador «definida».
  const estadoSmtp = await mailer.obterEstadoSmtp();
  // ── P54-2 — linhas da CONSULTA para o padrão P54-0 ────────────────
  // Só o que o utilizador pode ver: valores de configuração e, para a password,
  // o ESTADO («Definida»/«Em falta»). ⛔ Não há aqui nenhum caminho que ponha a
  // password na vista: `obterEstadoSmtp` não a devolve, e a linha da password é
  // marcada `sensivel` para o parcial imprimir a máscara e IGNORAR o valor.
  const linhasSmtp = [
    { rotulo: 'Servidor', valor: estadoSmtp.servidor },
    { rotulo: 'Porta', valor: estadoSmtp.porta },
    { rotulo: 'Utilizador', valor: estadoSmtp.utilizador },
    { rotulo: 'Remetente', valor: estadoSmtp.remetente, estado: estadoSmtp.nomeRemetente },
    { rotulo: 'Segurança', valor: estadoSmtp.seguranca },
    { rotulo: 'Password', sensivel: true, estado: estadoSmtp.temPassword ? 'Definida' : 'Em falta' },
  ];
  res.render('admin/configuracao/email', { titulo: 'Email / SMTP', estadoSmtp, linhasSmtp });
});

// ── Guardar a configuração SMTP ────────────────────────────────────
router.post('/config/email/smtp', async (req, res) => {
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
  res.redirect('/admin/config/email');
});

// ── Testar a ligação (verificação, sem enviar nada) ────────────────
router.post('/config/email/smtp/testar', async (req, res) => {
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
  res.redirect('/admin/config/email');
});

// ── Enviar email de teste (envio IMEDIATO, fora da fila) ───────────
router.post('/config/email/teste', async (req, res) => {
  const para = String(req.body.para || '').trim();
  if (!para) {
    req.flash('error_msg', 'Indique o email de destino do teste.');
    return res.redirect('/admin/config/email');
  }
  const r = await mailer.enviarEmailTeste({
    para,
    assunto: req.body.assunto || 'Teste SMTP — GesCondu',
    mensagem: req.body.mensagem || 'Este é um email de teste do GesCondu.',
    // Teste feito dentro do condomínio ativo: o nome do remetente segue a
    // mesma prioridade dos envios reais (override global ou nome do condomínio).
    condominioId: req.condominioId,
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
  res.redirect('/admin/config/email');
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
    await drive.desligar(plataforma ? null : req.condominioId, { plataforma });
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
  // Âmbito: a ligação da plataforma (backups) ou a do condomínio ativo.
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  const cidTeste = plataforma ? null : req.condominioId;
  const r = await drive.testarLigacao(cidTeste);
  // Uma autorização revogada no Google faz o teste falhar e os tokens são
  // removidos: recarrega-se o estado para a página deixar de mostrar "Ligado".
  await drive.inicializar().catch(() => {});
  if (r.ok) {
    await audit({ userId: req.user.id, acao: 'testar_google_drive', entidade: 'GoogleDrive', detalhes: { ok: true, ambito: plataforma ? 'plataforma' : 'condominio' } }).catch(() => {});
    req.flash('success_msg', r.conta ? `✓ Ligação ao Google Drive estabelecida (${r.conta}).` : '✓ Ligação ao Google Drive estabelecida.');
  } else {
    const removida = !drive.isConfigured(cidTeste)
      ? ' A ligação foi removida porque a autorização já não é válida — ligue a conta novamente.'
      : '';
    req.flash('error_msg', `✕ Não foi possível testar o Google Drive: ${r.erro}${removida}`);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Cria a estrutura de pastas no Google Drive (do condomínio ativo).
// ⛔ `isConfigured()` SEM condomínio responde pelo âmbito da PLATAFORMA (a
// conta que serve os backups e os condomínios sem conta própria). A árvore,
// porém, é criada com `req.condominioId` — logo a verificação tem de ser feita
// para ESSE condomínio: sem isto, um condomínio com a sua própria conta Google
// era recusado («não está ligado») só porque a plataforma não tinha ligação.
router.post('/config/drive/estrutura', async (req, res) => {
  if (!drive.isConfigured(req.condominioId)) {
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
