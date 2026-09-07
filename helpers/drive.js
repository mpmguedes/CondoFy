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
const { Op } = require('sequelize');
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
// Procura uma pasta pelo nome EXATO dentro da pasta-mãe (comparação local,
// sem interpolar o nome numa query do Drive — nomes com aspas/acentos são
// seguros) e devolve o id ou null.
async function encontrarPastaPorNome(nome, parentId) {
  return operacaoDrive(async () => {
    let q = `mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const res = await getDrive().files.list({ q, fields: 'files(id, name)', pageSize: 1000 });
    const alvo = String(nome || '').toLowerCase();
    const f = (res.data.files || []).find((x) => String(x.name || '').toLowerCase() === alvo);
    return f ? f.id : null;
  });
}

// Cria uma pasta nova (pasta-mãe opcional).
async function criarPasta(nome, parentId) {
  return operacaoDrive(async () => {
    const res = await getDrive().files.create({
      requestBody: {
        name: String(nome),
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
      },
      fields: 'id',
    });
    return res.data.id;
  });
}

// Encontra uma pasta pelo nome (e pasta-mãe) ou cria-a — nunca duplica.
async function encontrarOuCriarPasta(nome, parentId) {
  const existente = await encontrarPastaPorNome(nome, parentId);
  if (existente) return existente;
  return criarPasta(nome, parentId);
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

// ── Estrutura por condomínio (multi-condomínio) ─────────────────────
// Layout alvo no Google Drive (raiz = empresa; cada condomínio tem a sua
// própria árvore física):
//
//   <raiz da empresa>/
//   ├── Backups/                      ← infraestrutura (global)
//   ├── <Condomínio A>/
//   │   └── <ano>/{Assembleias,Quotas,Recibos,Despesas,Contratos,Outros,
//   │                Fornecedores/<nome>/<subpasta>}
//   └── <Condomínio B>/…
//
// O condomínio é SEMPRE resolvido por condominio_id → condominios.drive_folder_id
// (coluna da migração 063). Nunca por nome de ficheiro, fração, tipo, ano,
// email ou pasta. Ficheiros antigos (estrutura global <raiz>/<ano>/…) NÃO são
// movidos: os Documentos continuam a apontar para os drive_file_id existentes.

// Nome amigável da pasta do condomínio na raiz (nunca o id no nome).
function nomePastaCondominio(cond) {
  const nome = String((cond && cond.designacao) || '').trim();
  if (nome) {
    // Nomes puramente numéricos colidiriam com as pastas de anos antigas
    // (<raiz>/<ano>); o prefixo mantém a árvore legível e sem ambiguidade.
    if (/^\d+$/.test(nome)) return `Condomínio ${nome}`;
    return nome;
  }
  return cond && cond.id ? `Condomínio ${cond.id}` : 'Condomínio';
}

// Rótulo físico da subpasta por tipo de documento (mesmo mapeamento antigo).
const SUBPASTA_POR_TIPO = {
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

function subpastaDoTipo(tipo) {
  return SUBPASTA_POR_TIPO[tipo] || 'Outros';
}

// Planners puros do caminho físico (usados pelos resolvedores reais e pelos
// testes offline — fonte única de verdade para os nomes da hierarquia).
function caminhoPastaDocumento({ raiz, condominioNome, ano, tipo }) {
  return [raiz, condominioNome, String(ano || new Date().getFullYear()), subpastaDoTipo(tipo)];
}

function caminhoPastaFornecedor({ raiz, condominioNome, ano, nome, subpasta = 'Comprovativos' }) {
  return [raiz, condominioNome, String(ano || new Date().getFullYear()), 'Fornecedores', String(nome || 'Fornecedor'), String(subpasta || 'Outros')];
}

// Link para abrir uma pasta do Google Drive. A aplicação sabe condominio_id →
// drive_folder_id e gera o link; o administrador nunca precisa do folderId.
function linkPastaDrive(folderId) {
  return folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;
}

// Persiste drive_folder_id no condomínio e limpa a cache de condomínios
// (helpers/condominio) para que as leituras seguintes vejam o id novo.
async function registarPastaCondominio(condominioId, folderId) {
  const { Condominio } = require('../models');
  const { clearCondominioCache } = require('./condominio');
  await Condominio.update({ drive_folder_id: String(folderId) }, { where: { id: condominioId } });
  clearCondominioCache();
}

// Resolve (e regista) a pasta raiz do condomínio no Drive:
//   1. devolve condominios.drive_folder_id quando já está registado;
//   2. senão procura/cria <raiz>/<nome amigável> e regista o id na BD.
// Condomínios INATIVOS sem pasta não criam estrutura nova (regra do projeto);
// pastas já existentes de condomínios inativos nunca são apagadas.
async function obterPastaCondominioId(condominioId) {
  const cid = Number(condominioId);
  if (!cid) {
    throw new Error('condominioId é obrigatório para determinar a pasta do condomínio no Google Drive.');
  }
  const { Condominio } = require('../models');
  const cond = await Condominio.findByPk(cid);
  if (!cond) throw new Error('Condomínio não encontrado para determinar a pasta no Google Drive.');
  if (cond.drive_folder_id) return cond.drive_folder_id;
  if (cond.estado === 'inativo') {
    throw new Error(`O condomínio "${nomePastaCondominio(cond)}" está inativo — não são criadas pastas novas no Google Drive.`);
  }
  const raizId = await encontrarOuCriarPasta(await obterNomeRaiz());
  const nome = nomePastaCondominio(cond);
  const existenteId = await encontrarPastaPorNome(nome, raizId);
  if (existenteId) {
    // Adota a pasta existente apenas se nenhum OUTRO condomínio a registou.
    const outroDono = await Condominio.findOne({
      where: { drive_folder_id: existenteId, id: { [Op.ne]: cid } },
      attributes: ['id'],
    }).catch(() => null);
    if (!outroDono) {
      await registarPastaCondominio(cid, existenteId);
      return existenteId;
    }
    // Nome ocupado por outro condomínio: cria pasta própria (o Google permite
    // pastas com o mesmo nome; o id registado resolve sem ambiguidade).
    console.warn(`[drive] pasta "${nome}" já registada noutro condomínio — criada pasta própria.`);
  }
  const criadaId = await criarPasta(nome, raizId);
  await registarPastaCondominio(cid, criadaId);
  return criadaId;
}

// Estrutura de pastas no Google Drive.
//  · com condominioId: <raiz>/<Condomínio>/<ano>/{tipos} (multi-condomínio);
//  · sem condominioId: <raiz>/<ano>/{tipos} + <raiz>/Backups (comportamento
//    legado — usado pelos backups automáticos, que são infraestrutura global).
// A pasta Backups é sempre global (<raiz>/Backups).
async function criarEstruturaPastas(condominioId = null, ano = new Date().getFullYear()) {
  const raizId = await encontrarOuCriarPasta(await obterNomeRaiz());
  const nomes = ['Assembleias', 'Quotas', 'Recibos', 'Despesas', 'Contratos', 'Outros'];
  const subpastas = {};
  let condominioFolderId = null;
  let anoId;
  if (condominioId) {
    condominioFolderId = await obterPastaCondominioId(condominioId);
    anoId = await encontrarOuCriarPasta(String(ano), condominioFolderId);
  } else {
    anoId = await encontrarOuCriarPasta(String(ano), raizId);
  }
  for (const nome of nomes) {
    subpastas[nome] = await encontrarOuCriarPasta(nome, anoId);
  }
  const backupsId = await encontrarOuCriarPasta('Backups', raizId);
  return { raizId, condominioFolderId, anoId, subpastas, backupsId };
}

// Devolve o id da pasta do condomínio/ano/tipo do documento (cria a estrutura
// se necessário). O condominioId é OBRIGATÓRIO — nunca se deduz o condomínio
// pelo tipo/ano/ficheiro; fluxos sem contexto de condomínio não resolvem pasta.
async function pastaParaDocumento(tipo, ano, condominioId) {
  const cid = Number(condominioId);
  if (!cid) {
    throw new Error('condominioId é obrigatório para determinar a pasta do documento no Google Drive.');
  }
  const estrutura = await criarEstruturaPastas(cid, ano || new Date().getFullYear());
  return estrutura.subpastas[subpastaDoTipo(tipo)];
}

// Pasta de comprovativos de um fornecedor, DENTRO da árvore do condomínio
// (decisão documentada): o catálogo de fornecedores é partilhado do operador
// (tabela fornecedores sem condominio_id), mas o Documento/comprovativo é
// registado por condomínio (documentos.condominio_id) — por isso o ficheiro
// físico segue o condomínio do documento:
//   <raiz>/<Condomínio>/<ano>/Fornecedores/<nome>/<subpasta>
// (nunca cria pastas duplicadas; reutiliza as existentes pelo nome).
async function pastaParaFornecedor({ condominioId, nome, ano, subpasta = 'Comprovativos' }) {
  const cid = Number(condominioId);
  if (!cid) {
    throw new Error('condominioId é obrigatório para determinar a pasta do fornecedor no Google Drive.');
  }
  const condominioFolderId = await obterPastaCondominioId(cid);
  const anoNum = ano || new Date().getFullYear();
  const anoId = await encontrarOuCriarPasta(String(anoNum), condominioFolderId);
  const fornecedoresId = await encontrarOuCriarPasta('Fornecedores', anoId);
  const fornecedorId = await encontrarOuCriarPasta(String(nome || 'Fornecedor'), fornecedoresId);
  const subId = await encontrarOuCriarPasta(String(subpasta || 'Outros'), fornecedorId);
  return { condominioFolderId, anoId, fornecedoresId, fornecedorId, subpastaId: subId };
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
  // Estrutura por condomínio (multi-condomínio)
  nomePastaCondominio,
  subpastaDoTipo,
  caminhoPastaDocumento,
  caminhoPastaFornecedor,
  obterPastaCondominioId,
  linkPastaDrive,
};
