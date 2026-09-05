// ─────────────────────────────────────────────────────────────────────
// Google Drive — integração OAuth 2.0 + API Drive v3
//
// A ligação à conta Google é feita pelo fluxo OAuth (Ligar/Desligar na
// página de Configuração). Os tokens são guardados na base de dados
// (tabela `configuracoes`, através de helpers/config.js), nunca no
// frontend nem em ficheiros públicos.
//
// Compatibilidade: se não existirem tokens na BD mas estiver definido
// GOOGLE_REFRESH_TOKEN no .env, a integração continua a funcionar em
// modo legado (ligação direta), até ser ligada uma conta pela aplicação.
// ─────────────────────────────────────────────────────────────────────
const { Readable } = require('stream');
const { google } = require('googleapis');
const { getConfig, setConfig } = require('./config');

const CHAVE_TOKENS = 'google_drive_tokens'; // JSON {access_token, refresh_token, expiry_date, conta}

// Cache síncrona (para isConfigured() continuar síncrono, como os callers esperam).
let _cache = { pronto: false, tokens: null };

// ── Configuração (variáveis de ambiente) ────────────────────────────
function featureAtiva() {
  return process.env.GOOGLE_DRIVE_ENABLED === 'true';
}

function credenciaisOAuth() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  };
}

function temCredenciais() {
  const c = credenciaisOAuth();
  return Boolean(c.clientId && c.clientSecret);
}

function refreshTokenEnv() {
  return process.env.GOOGLE_REFRESH_TOKEN || '';
}

// ── Leitura/escrita de tokens ───────────────────────────────────────
function parseTokens(valor) {
  if (!valor) return null;
  try {
    const t = JSON.parse(valor);
    return t && typeof t === 'object' ? t : null;
  } catch (err) {
    return null;
  }
}

// Tokens atuais (BD com prioridade; .env apenas como legado).
function obterTokensSync() {
  if (_cache.pronto && _cache.tokens) return _cache.tokens;
  const env = refreshTokenEnv();
  return env ? { refresh_token: env, origem: 'env' } : null;
}

async function obterTokensDb() {
  const valor = await getConfig(CHAVE_TOKENS, null);
  return parseTokens(valor);
}

async function gravarTokens({ access_token, refresh_token, expiry_date, conta }) {
  const atuais = (await obterTokensDb()) || {};
  const novos = {
    access_token: access_token != null ? access_token : atuais.access_token || null,
    refresh_token: refresh_token != null ? refresh_token : atuais.refresh_token || null,
    expiry_date: expiry_date != null ? expiry_date : atuais.expiry_date || null,
    conta: conta != null ? conta : atuais.conta || null,
  };
  await setConfig(CHAVE_TOKENS, JSON.stringify(novos));
  _cache = { pronto: true, tokens: novos };
  return novos;
}

async function limparTokens() {
  await setConfig(CHAVE_TOKENS, null);
  _cache = { pronto: true, tokens: null };
}

// Carrega o estado para a cache síncrona (chamado no arranque da app e
// depois de ligar/desligar).
async function inicializar() {
  try {
    const t = await obterTokensDb();
    _cache = { pronto: true, tokens: t };
  } catch (err) {
    console.error('[drive] não foi possível ler os tokens:', err.message);
    _cache = { pronto: true, tokens: null };
  }
}

// ── Cliente OAuth ───────────────────────────────────────────────────
function criarCliente() {
  const c = credenciaisOAuth();
  return new google.auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri);
}

// Cliente com as credenciais guardadas; renova o access token
// automaticamente e persiste os tokens novos na BD.
function obterClienteAutenticado() {
  const tokens = obterTokensSync();
  const cliente = criarCliente();

  const creds = { refresh_token: tokens.refresh_token || undefined };
  if (tokens.access_token) creds.access_token = tokens.access_token;
  if (tokens.expiry_date) creds.expiry_date = Number(tokens.expiry_date);
  cliente.setCredentials(creds);

  cliente.on('tokens', (novos) => {
    if (!novos || !(novos.access_token || novos.refresh_token)) return;
    gravarTokens({
      access_token: novos.access_token,
      refresh_token: novos.refresh_token,
      expiry_date: novos.expiry_date != null ? novos.expiry_date : novos.expires_in ? Date.now() + novos.expires_in * 1000 : null,
    }).catch(() => {});
  });

  return cliente;
}

function getDrive() {
  return google.drive({ version: 'v3', auth: obterClienteAutenticado() });
}

// ── Estado da integração ────────────────────────────────────────────
// O estado "configurado" exige credenciais OAuth; a Drive API só é usada
// depois de ligada uma conta (tokens na BD) ou em modo legado (.env).
function isConfigured() {
  if (!featureAtiva() || !temCredenciais()) return false;
  const t = obterTokensSync();
  return Boolean(t && (t.refresh_token || t.access_token));
}

// Estado detalhado para a interface de Configuração.
async function estadoLigacao() {
  const ativo = featureAtiva();
  const credenciais = temCredenciais();
  const redirectUriDefinido = Boolean(credenciaisOAuth().redirectUri);

  const dbTokens = await obterTokensDb();
  const envToken = refreshTokenEnv();

  const ligado = Boolean((dbTokens && (dbTokens.refresh_token || dbTokens.access_token)) || envToken);
  const viaEnv = Boolean(!(dbTokens && (dbTokens.refresh_token || dbTokens.access_token)) && envToken);

  return {
    ativo,
    credenciais,
    redirectUriDefinido,
    ligado: ativo && credenciais && ligado,
    viaEnv: ativo && credenciais && viaEnv,
    conta: (dbTokens && dbTokens.conta) || null,
  };
}

// Redirect URI usado no fluxo OAuth (variável de ambiente com recurso ao
// host do pedido para desenvolvimento local).
function obterRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = req && req.get ? req.get('host') : 'localhost:3000';
  const protocol = req && req.secure ? 'https' : req && req.protocol ? req.protocol : 'http';
  return `${protocol}://${host}/admin/config/drive/callback`;
}

// URL para o utilizador autorizar a aplicação (scope mínimo: ficheiros
// criados/abertos pela aplicação no Drive).
function construirUrlAutorizacao({ redirectUri, state }) {
  const cliente = criarCliente();
  return cliente.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    redirect_uri: redirectUri,
    state,
  });
}

// Troca o código de autorização pelos tokens e guarda-os na BD.
async function trocarCodigo({ code, redirectUri }) {
  const cliente = criarCliente();
  const { tokens } = await cliente.getToken({ code, redirect_uri: redirectUri });
  cliente.setCredentials(tokens);

  let conta = null;
  try {
    const about = await google.drive({ version: 'v3', auth: cliente }).about.get({
      fields: 'user(emailAddress, displayName)',
    });
    const u = about.data.user || {};
    conta = u.emailAddress || u.displayName || null;
  } catch (err) {
    // identificar a conta é opcional — não falha a ligação
  }

  const dados = {
    access_token: tokens.access_token || null,
    refresh_token: tokens.refresh_token || null,
    expiry_date: tokens.expiry_date != null ? tokens.expiry_date : tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    conta,
  };
  return gravarTokens(dados);
}

// Desliga: revoga o token no Google (melhor esforço) e remove os tokens da BD.
// Os ficheiros já existentes no Drive NÃO são apagados.
async function desligar() {
  const dbTokens = await obterTokensDb();
  const refresh = (dbTokens && dbTokens.refresh_token) || refreshTokenEnv();
  if (refresh && temCredenciais()) {
    try {
      await criarCliente().revokeToken(refresh);
    } catch (err) {
      // revogação é melhor esforço — segue em frente
    }
  }
  await limparTokens();
}

// ── Tratamento de erros da API ──────────────────────────────────────
function analisarErro(err) {
  const resposta = (err && err.response && err.response.data) || {};
  const e = resposta.error || {};
  const status = (err && err.response && err.response.status) || (err && err.code) || 0;
  const descricao =
    e.error_description ||
    e.message ||
    (Array.isArray(e.errors) && e.errors[0] && e.errors[0].message) ||
    (err && err.message) ||
    'erro desconhecido do Google Drive';
  const texto = String(descricao).toLowerCase();
  const revogado =
    status === 401 ||
    e.error === 'invalid_grant' ||
    /invalid_grant|token has been expired|revoked|auth(e?ntication)? error/i.test(texto);
  return { revogado, mensagem: String(descricao) };
}

function erroDriveParaMensagem(err) {
  const { revogado, mensagem } = analisarErro(err);
  if (revogado) {
    return 'A ligação ao Google Drive foi revogada ou expirou. Vá a Configuração e ligue novamente a conta Google.';
  }
  if (/quota|rate limit|userRateLimitExceeded/i.test(String(mensagem))) {
    return 'Limite da API do Google Drive atingido. Tente novamente mais tarde.';
  }
  if (/permission|insufficient|access.?denied/i.test(String(mensagem))) {
    return 'Sem permissão para executar esta operação no Google Drive.';
  }
  return `Não foi possível comunicar com o Google Drive: ${mensagem}`;
}

// Executa uma operação da API com tratamento de erros centralizado.
// Se a autorização tiver sido revogada, remove os tokens (fica "Não ligado").
async function operacaoDrive(fn) {
  try {
    return await fn();
  } catch (err) {
    const { revogado } = analisarErro(err);
    if (revogado) {
      await limparTokens().catch(() => {});
    }
    throw new Error(erroDriveParaMensagem(err));
  }
}

// Testa a ligação atual ao Google Drive (sem alterar nada).
async function testarLigacao() {
  if (!isConfigured()) {
    return { ok: false, erro: 'Google Drive não está ligado.' };
  }
  try {
    const resultado = await operacaoDrive(async () => {
      const about = await google.drive({ version: 'v3', auth: obterClienteAutenticado() }).about.get({
        fields: 'user(emailAddress, displayName)',
      });
      const u = about.data.user || {};
      return { conta: u.emailAddress || u.displayName || null };
    });
    return { ok: true, conta: resultado.conta };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

// ── Pastas ──────────────────────────────────────────────────────────
// Encontra uma pasta pelo nome (e pasta-mãe) ou cria-a — nunca duplica.
async function encontrarOuCriarPasta(nome, parentId) {
  return operacaoDrive(async () => {
    const drive = getDrive();
    let q = `mimeType='application/vnd.google-apps.folder' and name='${nome}' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;

    const res = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 1 });
    if (res.data.files.length) {
      return res.data.files[0].id;
    }
    const criada = await drive.files.create({
      requestBody: {
        name: nome,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
      },
      fields: 'id',
    });
    return criada.data.id;
  });
}

// Fonte única de verdade da pasta raiz no Google Drive.
// Precedência: configuração guardada na BD → GOOGLE_DRIVE_ROOT_FOLDER (.env)
// → pasta inicial "GesCondu". Nunca substitui uma pasta já configurada.
async function obterNomeRaiz() {
  try {
    const dbRaiz = String((await getConfig('google_drive_root_folder', '')) || '').trim();
    if (dbRaiz) return dbRaiz;
  } catch (err) {
    // BD indisponível → segue para .env/fallback
  }
  const envRaiz = (process.env.GOOGLE_DRIVE_ROOT_FOLDER || '').trim();
  if (envRaiz) return envRaiz;
  return 'GesCondu';
}

// Estrutura: <raiz>/<ano>/<pastas> e <raiz>/Backups.
// A pasta raiz configurada é reutilizada se já existir (nunca duplicada);
// pastas antigas (ex.: "CondoFy") continuam válidas e utilizáveis.
async function criarEstruturaPastas(ano = new Date().getFullYear()) {
  const raizId = await encontrarOuCriarPasta(await obterNomeRaiz());
  const anoId = await encontrarOuCriarPasta(String(ano), raizId);

  const nomes = ['Assembleias', 'Quotas', 'Recibos', 'Despesas', 'Contratos', 'Outros'];
  const subpastas = {};
  for (const nome of nomes) {
    subpastas[nome] = await encontrarOuCriarPasta(nome, anoId);
  }
  const backupsId = await encontrarOuCriarPasta('Backups', raizId);

  return { raizId, anoId, subpastas, backupsId };
}

// Devolve o id da pasta do ano/tipo adequado (cria a estrutura se necessário).
async function pastaParaDocumento(tipo, ano) {
  const estrutura = await criarEstruturaPastas(ano || new Date().getFullYear());
  const mapa = {
    ata: 'Assembleias',
    convocatoria: 'Assembleias',
    aviso_quota: 'Quotas',
    recibo: 'Recibos',
    fatura: 'Despesas',
    contrato: 'Contratos',
    relatorio: 'Outros',
    orcamento: 'Outros',
    outro: 'Outros',
  };
  const sub = mapa[tipo] || 'Outros';
  return estrutura.subpastas[sub];
}

// Pasta de um fornecedor:
// <raiz>/<ano>/Fornecedores/<nome>/<subpasta>
// (nunca cria pastas duplicadas; reutiliza as existentes pelo nome).
async function pastaParaFornecedor({ nome, ano, subpasta = 'Comprovativos' }) {
  const anoNum = ano || new Date().getFullYear();
  const raizId = await encontrarOuCriarPasta(await obterNomeRaiz());
  const anoId = await encontrarOuCriarPasta(String(anoNum), raizId);
  const fornecedoresId = await encontrarOuCriarPasta('Fornecedores', anoId);
  const fornecedorId = await encontrarOuCriarPasta(String(nome || 'Fornecedor'), fornecedoresId);
  const subId = await encontrarOuCriarPasta(String(subpasta || 'Outros'), fornecedorId);
  return { raizId, anoId, fornecedoresId, fornecedorId, subpastaId: subId };
}

// Descarrega um ficheiro do Drive para um Buffer (para anexar em email).
async function descargarArquivo(fileId) {
  return operacaoDrive(async () => {
    const res = await getDrive().files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    const chunks = [];
    for await (const c of res.data) chunks.push(c);
    return Buffer.concat(chunks);
  });
}

// ── Upload ──────────────────────────────────────────────────────────
// Faz upload de um Buffer para o Drive.
async function uploadArquivo({ nome, mimeType, buffer, parentFolderId }) {
  return operacaoDrive(async () => {
    const drive = getDrive();
    const res = await drive.files.create({
      requestBody: {
        name: nome,
        mimeType: mimeType || 'application/pdf',
        parents: parentFolderId ? [parentFolderId] : [],
      },
      media: { mimeType: mimeType || 'application/pdf', body: Readable.from(buffer) },
      fields: 'id, webViewLink, size',
    });
    return {
      driveFileId: res.data.id,
      url: res.data.webViewLink || null,
      tamanho: res.data.size ? parseInt(res.data.size, 10) : null,
    };
  });
}

module.exports = {
  isConfigured,
  getDrive,
  inicializar,
  estadoLigacao,
  testarLigacao,
  obterRedirectUri,
  construirUrlAutorizacao,
  trocarCodigo,
  desligar,
  criarEstruturaPastas,
  pastaParaDocumento,
  pastaParaFornecedor,
  descargarArquivo,
  uploadArquivo,
  encontrarOuCriarPasta,
};
