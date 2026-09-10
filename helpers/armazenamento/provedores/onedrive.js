// ─────────────────────────────────────────────────────────────────────
// Provedor de armazenamento: Microsoft OneDrive (Microsoft Graph v1.0)
//
// Cumpre a interface de helpers/armazenamento/contrato.js e é registado na
// fachada (helpers/storage). A ligação é feita por OAuth 2.0 (fluxo
// authorization code) a partir de Configuração → Armazenamento e Backups:
// os tokens ficam na tabela `configuracoes` por condomínio (helpers/
// armazenamento/ligacoes.js), nunca no browser nem em ficheiros públicos.
//
// ── PRIVACIDADE (invariante do contrato) ─────────────────────────────
//  · Os ficheiros ficam PRIVADOS na conta OneDrive do condomínio/
//    plataforma. O GesCondu é o único caminho de acesso aos documentos:
//    o acesso é sempre servido pelo backend, depois de verificar
//    Utilizador → Condomínio → Documento (helpers/documentos-acesso.js).
//  · Este provedor NÃO implementa — de propósito — nenhum endpoint de
//    partilha do Graph (`/invite`, `/createLink`, `createLink` com
//    `scope: 'anonymous'`, …). Os documentos nunca ganham link público.
//    `linkPasta()` devolve null pela mesma razão.
//  · Nenhuma mensagem de erro expõe tokens nem caminhos técnicos da
//    conta: tudo passa por helpers/armazenamento/http.js (sanitizar).
//
// ── Endereçamento por CAMINHOS ───────────────────────────────────────
// O Graph permite endereçar itens por id ou por caminho relativo à raiz
// do drive (`/me/drive/root:/<caminho>:/…`). Aqui usa-se o CAMINHO como
// identificador de pasta — ex.: /GesCondu/<Condomínio>/2026/Recibos — por
// ser legível na interface, estável entre execuções e igual à hierarquia
// dos outros provedores (nomes vêm SEMPRE de helpers/armazenamento/
// estrutura.js, nunca são inventados aqui).
//
// Notas técnicas:
//  · Os scopes da Microsoft vão separados por ESPAÇOS (ao contrário do
//    Google, que usa a lista de scopes da biblioteca).
//  · Um 409 ao criar pasta significa "já existe" → sucesso (idempotência).
//  · O download responde 302 para um URL PRÉ-AUTENTICADO noutro domínio:
//    o fetch nativo segue o redirecionamento e remove o cabeçalho
//    Authorization em redirecionamentos cross-origin — o token nunca
//    segue para o domínio de conteúdo.
//  · Este módulo carrega sem rede e sem BD: nada de pedidos no require e
//    nenhum acesso à BD fora de funções assíncronas.
// ─────────────────────────────────────────────────────────────────────
const { Readable } = require('stream');
const estrutura = require('../estrutura');
const ligacoes = require('../ligacoes');
const http = require('../http');

const NOME = 'onedrive';
const ROTULO = 'Microsoft OneDrive';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

// Scope mínimo: ler/escrever os ficheiros do utilizador + refresh token.
// Na Microsoft os scopes vão separados por ESPAÇOS.
const SCOPE = 'offline_access Files.ReadWrite';

// Limite do upload simples (PUT .../content). Acima disto usa-se sessão de
// upload (createUploadSession) com fatias de 320 KiB (múltiplo exigido pelo
// Graph: 320 KiB = 327 680 bytes).
const LIMITE_UPLOAD_SIMPLES = 4 * 1024 * 1024;
const TAMANHO_FATIA = 320 * 1024;

// Margem de segurança antes da expiração do access token.
const MARGEM_EXPIRACAO_MS = 60 * 1000;

// Pasta raiz por omissão na conta OneDrive.
const RAIZ_PADRAO = 'GesCondu';

const MSG_LIGAR = 'A ligação ao Microsoft OneDrive expirou ou foi revogada. Vá a Configuração → Armazenamento e Backups e ligue novamente a conta OneDrive.';

// ── Configuração (variáveis de ambiente) ────────────────────────────
function featureAtiva() {
  return process.env.ONEDRIVE_ENABLED === 'true';
}

function tenant() {
  return String(process.env.ONEDRIVE_TENANT || 'common').trim() || 'common';
}

function credenciaisOAuth() {
  return {
    clientId: process.env.ONEDRIVE_CLIENT_ID || '',
    clientSecret: process.env.ONEDRIVE_CLIENT_SECRET || '',
    redirectUri: process.env.ONEDRIVE_REDIRECT_URI || '',
  };
}

function temCredenciais() {
  const c = credenciaisOAuth();
  return Boolean(c.clientId && c.clientSecret);
}

function redirectUriDefinido() {
  return Boolean(credenciaisOAuth().redirectUri);
}

// ── Erros ───────────────────────────────────────────────────────────
// Erro de negócio legível: aponta sempre o caminho para a Configuração e
// nunca inclui tokens nem caminhos técnicos da conta.
function erroLigacao(detalhe = '') {
  const e = new Error(detalhe ? `${MSG_LIGAR} (${detalhe})` : MSG_LIGAR);
  e.status = 401;
  e.provedor = NOME;
  return e;
}

// ── Tokens (por condomínio, via helpers/armazenamento/ligacoes) ─────
async function lerTokens(condominioId) {
  try {
    const { tokens } = await ligacoes.lerTokens(NOME, condominioId);
    return tokens || null;
  } catch (err) {
    return null;
  }
}

function tokensSync(condominioId) {
  try {
    return ligacoes.tokensSync(NOME, condominioId).tokens || null;
  } catch (err) {
    return null;
  }
}

function contaDosTokens(tokens) {
  const conta = tokens && tokens.conta;
  if (!conta) return null;
  if (typeof conta === 'string') return conta;
  return conta.email || conta.userPrincipalName || conta.nome || conta.displayName || null;
}

// Pasta raiz: configuração guardada (BD) → ONEDRIVE_ROOT_FOLDER (.env) →
// 'GesCondu'. Igual à precedência usada pelo provedor Google Drive.
async function obterNomeRaiz(condominioId) {
  const daBd = String((await ligacoes.lerRaiz(NOME, condominioId).catch(() => '')) || '').trim();
  if (daBd) return daBd;
  const doEnv = String(process.env.ONEDRIVE_ROOT_FOLDER || '').trim();
  if (doEnv) return doEnv;
  return RAIZ_PADRAO;
}

// Caminho normalizado da raiz (com `/` inicial), para que todos os ids de
// pasta devolvidos por este provedor tenham a mesma forma: '/GesCondu'.
// A raiz configurada é sanitizada segmento a segmento (nunca cria `//`).
async function obterCaminhoRaiz(condominioId) {
  return pastaNormalizada(await obterNomeRaiz(condominioId));
}

// ── Normalização dos nomes/paths do Graph ───────────────────────────
// Um 409 ao criar uma pasta significa que já existe → sucesso (idempotência).
function jaExiste(resposta) {
  return Boolean(resposta && resposta.status === 409);
}

function respostaVazia(status, dados = null) {
  return { ok: status >= 200 && status < 300, status, dados };
}

// Normaliza um único segmento: sem `\` nem `/` (um nome nunca cria
// subpastas), sem espaços nas pontas, sem comprimento abusivo.
function segmentoSeguro(segmento, fallback = '') {
  const texto = String(segmento == null ? '' : segmento)
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  return texto || fallback;
}

// Converte uma lista de segmentos no caminho do Graph:
// ['GesCondu','Condomínio X','2026','Recibos'] → '/GesCondu/Condomínio X/2026/Recibos'.
// As barras não são codificadas como %2F: são separadores de pasta válidos
// no caminho do Graph (o fetch codifica o resto — espaços/acentos — sozinho).
function caminhoGraph(segmentos) {
  const limpos = (Array.isArray(segmentos) ? segmentos : [segmentos])
    .map((s) => segmentoSeguro(s))
    .filter(Boolean);
  return limpos.length ? `/${limpos.join('/')}` : '';
}

// Devolve os segmentos de um caminho já montado (aceita com ou sem `/`).
function segmentosDe(caminho) {
  return String(caminho == null ? '' : caminho)
    .split('/')
    .map((s) => segmentoSeguro(s))
    .filter(Boolean);
}

// Caminho do documento: raiz/condomínio/ano/<subpasta do tipo>.
// A raiz já vem sanitizada (obterCaminhoRaiz) e a subpasta vem SEMPRE de
// estrutura.subpastaDoTipo (fonte única de verdade dos nomes da hierarquia).
function caminhoDocumento({ raiz, condominioNome, ano, tipo }) {
  return estrutura.caminhoPastaDocumento({ raiz, condominioNome, ano, tipo });
}

// Caminho do fornecedor: raiz/condomínio/ano/Fornecedores/<nome>/<subpasta>.
function caminhoFornecedor({ raiz, condominioNome, ano, nome, subpasta }) {
  return estrutura.caminhoPastaFornecedor({ raiz, condominioNome, ano, nome, subpasta });
}

// O condomínio é resolvido SEMPRE por condominio_id (nunca por nome de
// ficheiro, fração, tipo, ano, email ou pasta). Lança erro claro quando o
// condomínio não existe; os condomínios inativos não criam estrutura nova
// (regra do projeto — as pastas já existentes nunca são apagadas).
async function carregarCondominio(condominioId) {
  const cid = Number(condominioId);
  if (!cid) {
    throw new Error('condominioId é obrigatório para determinar a pasta no Microsoft OneDrive.');
  }
  // Caminho relativo a partir de helpers/armazenamento/provedores/ → models/.
  const { Condominio } = require('../../../models');
  const cond = await Condominio.findByPk(cid);
  if (!cond) throw new Error('Condomínio não encontrado para determinar a pasta no Microsoft OneDrive.');
  if (cond.estado === 'inativo') {
    throw new Error(`O condomínio "${estrutura.nomePastaCondominio(cond)}" está inativo — não são criadas pastas novas no Microsoft OneDrive.`);
  }
  return cond;
}

// ── Sessão/renovação de tokens ──────────────────────────────────────
function expirado(expiryDate) {
  const t = Number(expiryDate);
  if (!Number.isFinite(t) || t <= 0) return false;
  return Date.now() >= t - MARGEM_EXPIRACAO_MS;
}

function calcularExpiry(dados) {
  if (dados && dados.expires_in != null) return Date.now() + Number(dados.expires_in) * 1000;
  if (dados && dados.expires_on != null) return Number(dados.expires_on) * 1000;
  return null;
}

// Pedido ao endpoint de tokens (form-urlencoded, como a Microsoft exige).
async function pedidoToken(form, contexto) {
  const resposta = await http.pedir(`${LOGIN}/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    form,
  });
  if (!resposta.ok) {
    const e = http.erroApi(ROTULO, resposta, contexto);
    e.status = resposta.status;
    throw e;
  }
  return resposta.dados || {};
}

// Renova o access token com grant_type=refresh_token. Só é chamado quando o
// token expirou (ou não existe) — a renovação nunca é feita "a cada pedido".
// O refresh_token novo é sempre persistido quando a Microsoft devolve um.
async function renovarToken(condominioId) {
  const tokens = await lerTokens(condominioId);
  const refresh = tokens && tokens.refresh_token;
  if (!refresh) throw erroLigacao('sem refresh token guardado');
  if (!temCredenciais()) throw erroLigacao('credenciais OAuth em falta (ONEDRIVE_CLIENT_ID/ONEDRIVE_CLIENT_SECRET)');

  const credenciais = credenciaisOAuth();
  let dados;
  try {
    dados = await pedidoToken(
      {
        client_id: credenciais.clientId,
        client_secret: credenciais.clientSecret,
        refresh_token: refresh,
        grant_type: 'refresh_token',
        scope: SCOPE,
      },
      'renovação do token'
    );
  } catch (err) {
    // invalid_grant / 401: a autorização foi revogada pelo utilizador ou
    // expirou → limpa os tokens e aponta para Configuração.
    const revogado = err.status === 401 || err.status === 400 || /invalid_grant|expired|revoked/i.test(err.message || '');
    if (revogado) {
      await ligacoes.limparTokens(NOME, condominioId).catch(() => {});
      throw erroLigacao();
    }
    throw err;
  }
  if (!dados.access_token) throw erroLigacao('resposta de renovação sem access token');

  await ligacoes.guardarTokens(NOME, condominioId, {
    access_token: dados.access_token,
    // Só grava refresh_token quando a Microsoft devolve um novo (rotação);
    // caso contrário `guardarTokens` mantém o atual.
    refresh_token: dados.refresh_token,
    expiry_date: calcularExpiry(dados),
  });
  return dados.access_token;
}

// Access token válido para operações do Graph (renova quando necessário).
async function accessToken(condominioId) {
  if (!featureAtiva() || !temCredenciais()) throw erroLigacao();
  const tokens = await lerTokens(condominioId);
  if (tokens && tokens.access_token && !expirado(tokens.expiry_date)) return tokens.access_token;
  if (tokens && tokens.refresh_token) return renovarToken(condominioId);
  if (tokens && tokens.access_token) return tokens.access_token;
  throw erroLigacao('sem tokens guardados');
}

// ── Operações no Graph (com tratamento centralizado de erros) ────────
// Um 401/403 da Microsoft (token inválido/revogado/sem permissão) limpa os
// tokens locais e falha com mensagem a apontar para Configuração →
// Armazenamento e Backups. As mensagens do Graph nunca trazem tokens.
async function operacaoGraph(condominioId, contexto, fn) {
  const token = await accessToken(condominioId);
  const opcoes = fn(token);
  let resposta;
  try {
    resposta = await http.pedir(opcoes.url, opcoes);
  } catch (err) {
    throw new Error(`Não foi possível comunicar com o ${ROTULO}: ${http.sanitizar(err.message)}`);
  }
  if (!resposta.ok) {
    if (resposta.status === 401) {
      await ligacoes.limparTokens(NOME, condominioId).catch(() => {});
      throw erroLigacao();
    }
    if (resposta.status === 403) {
      throw new Error(`Sem permissão para executar esta operação no ${ROTULO}. Confirme a ligação em Configuração → Armazenamento e Backups.`);
    }
    const e = http.erroApi(ROTULO, resposta, contexto);
    e.status = resposta.status;
    throw e;
  }
  return resposta;
}

// Metadados de um item por caminho (null quando não existe). Nunca lança
// por 404 — a ausência é uma resposta legítima neste fluxo.
async function metadataDaPasta(caminho, condominioId) {
  const limpo = String(caminho || '');
  if (!limpo || limpo === '/') return { id: 'root', name: '', path: '/' };
  const alvo = limpo.replace(/^\/+|\/+$/g, '');
  const url = http.urlComQuery(`${GRAPH}/me/drive/root:/${alvo}:`, { $select: 'id,name,webUrl' });
  try {
    const resposta = await operacaoGraph(condominioId, 'consulta de pasta', (token) => ({
      url,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }));
    return resposta.dados || {};
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ── Garantia de pastas (idempotente, segmento a segmento) ───────────
//  · a pasta existe → devolve o caminho normalizado;
//  · falta um segmento → cria-o com conflictBehavior 'fail'; um 409
//    significa que já existe (sucesso).
// Os nomes são sempre sanitizados (segmentoSeguro) — nenhum nome vindo do
// utilizador cria subpastas por conter `\` ou `/`.
async function garantirPasta(caminho, condominioId) {
  const segmentos = segmentosDe(caminho);
  if (!segmentos.length) return '';
  let atual = '';
  for (const segmento of segmentos) {
    const pai = atual;
    atual = `${atual}/${segmento}`;
    const existente = await metadataDaPasta(atual, condominioId);
    if (existente && existente.id) continue;
    const url = pai
      ? http.urlComQuery(`${GRAPH}/me/drive/root:/${pai.replace(/^\/+/, '')}:/children`, { $select: 'id,name' })
      : http.urlComQuery(`${GRAPH}/me/drive/root/children`, { $select: 'id,name' });
    let resposta;
    try {
      resposta = await operacaoGraph(condominioId, `criação da pasta "${segmento}"`, (token) => ({
        url,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        json: { name: segmento, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      }));
    } catch (err) {
      // 409 = a pasta já existe (criada por outro pedido) → idempotente.
      if (!jaExiste(respostaVazia(err.status))) throw err;
    }
  }
  return atual;
}

// ── Estado da integração ────────────────────────────────────────────
function nome() {
  return NOME;
}

function rotulo() {
  return ROTULO;
}

// Nunca declara linksPublicos (proibido pelo contrato) e não existe nenhum
// método de partilha neste provedor.
function capacidades() {
  return { oauth: true, pastas: true, streaming: true, backups: true };
}

// Síncrono: a interface (vistas de Configuração) precisa de saber "está
// ligado?" sem await. Usa a cache de ligações (ligacoes.tokensSync).
function isConfigured(condominioId) {
  if (!featureAtiva() || !temCredenciais()) return false;
  const t = tokensSync(condominioId);
  return Boolean(t && (t.access_token || t.refresh_token));
}

// Estado detalhado para a interface de Configuração (mesma forma do
// provedor Google Drive). Nunca expõe tokens.
async function estadoLigacao(condominioId) {
  const ativo = featureAtiva();
  const credenciais = temCredenciais();
  const uriDefinido = redirectUriDefinido();
  const tokens = await lerTokens(condominioId);
  const ligado = Boolean(tokens && (tokens.refresh_token || tokens.access_token));
  return {
    ativo,
    credenciais,
    redirectUriDefinido: uriDefinido,
    ligado: Boolean(ativo && credenciais && ligado),
    // A Microsoft não tem ligação legada por .env (só o Google Drive tem
    // GOOGLE_REFRESH_TOKEN) — mantém-se a chave para a interface ser igual.
    viaEnv: false,
    conta: contaDosTokens(tokens),
  };
}

// Confirma que a ligação funciona: quem é o utilizador e que o drive
// responde. Nunca lança — a interface mostra sempre uma mensagem.
async function testarLigacao(condominioId) {
  if (!isConfigured(condominioId)) {
    return { ok: false, erro: 'O Microsoft OneDrive não está ligado.' };
  }
  try {
    const resposta = await operacaoGraph(condominioId, 'teste da ligação', (token) => ({
      url: http.urlComQuery(`${GRAPH}/me/drive`, { $select: 'id,driveType' }),
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }));
    const dados = resposta.dados || {};
    return { ok: true, conta: contaDosTokens(await lerTokens(condominioId)) || dados.id || null };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

// ── OAuth ───────────────────────────────────────────────────────────
// Codificação de parâmetros de query no formato do OAuth 2.0: o espaço vai
// como `%20` (a codificação `+` de formulário, que o URLSearchParams usa
// por omissão, não é aceite no URL de autorização da Microsoft).
function parametrosOAuth(parametros) {
  const p = new URLSearchParams();
  for (const [chave, valor] of Object.entries(parametros)) {
    if (valor === undefined || valor === null || valor === '') continue;
    p.set(chave, String(valor));
  }
  return p.toString().replace(/\+/g, '%20');
}

// URL de autorização. Os scopes vão numa única string separada por ESPAÇOS
// (`offline_access Files.ReadWrite`) e o `state` é opaco para a Microsoft:
// leva o contexto do condomínio e é validado pela rota de callback.
function urlAutorizacao({ redirectUri, state, condominioId } = {}) {
  const credenciais = credenciaisOAuth();
  const uri = redirectUri || credenciais.redirectUri;
  const query = parametrosOAuth({
    client_id: credenciais.clientId,
    response_type: 'code',
    redirect_uri: uri,
    response_mode: 'query',
    scope: SCOPE,
    state: state || '',
    prompt: 'consent',
  });
  return `${LOGIN}/${tenant()}/oauth2/v2.0/authorize?${query}`;
}

// Troca o código de autorização pelos tokens e guarda-os por condomínio.
// O refresh_token é essencial (offline_access): sem ele a ligação não se
// renova sozinha.
async function trocarCodigo({ code, redirectUri, condominioId } = {}) {
  if (!code) throw new Error('Código de autorização em falta.');
  if (!temCredenciais()) throw new Error('Credenciais OAuth do Microsoft OneDrive em falta (ONEDRIVE_CLIENT_ID/ONEDRIVE_CLIENT_SECRET).');
  const credenciais = credenciaisOAuth();
  const uri = redirectUri || credenciais.redirectUri;
  const dados = await pedidoToken(
    {
      client_id: credenciais.clientId,
      client_secret: credenciais.clientSecret,
      code,
      redirect_uri: uri,
      grant_type: 'authorization_code',
      scope: SCOPE,
    },
    'troca do código de autorização'
  );

  const access = dados.access_token || null;
  if (!access) throw new Error('A Microsoft não devolveu um access token.');

  // Identificar a conta é opcional: se falhar, a ligação continua válida.
  let conta = null;
  try {
    const resposta = await http.pedir(http.urlComQuery(`${GRAPH}/me`, { $select: 'userPrincipalName,mail,displayName' }), {
      method: 'GET',
      headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' },
    });
    if (resposta.ok) {
      const perfil = resposta.dados || {};
      conta = perfil.userPrincipalName || perfil.mail || perfil.displayName || null;
    }
  } catch (err) {
    // identificar a conta é opcional — não invalida a ligação
  }

  const guardados = await ligacoes.guardarTokens(NOME, condominioId, {
    access_token: access,
    refresh_token: dados.refresh_token || null,
    expiry_date: calcularExpiry(dados),
    conta,
  });
  return { conta: contaDosTokens(guardados) };
}

// Desligar remove APENAS os tokens guardados localmente.
//  · A Microsoft não tem um endpoint de revogação simples equivalente ao
//    do Google (o utilizador pode retirar o acesso da aplicação em
//    account.live.com → Aplicações e serviços, ou no Entra ID do tenant).
//  · Os ficheiros já existentes no OneDrive NÃO são apagados — continuam
//    privados na conta e o GesCondu deixa apenas de os conseguir aceder.
async function desligar(condominioId) {
  // Sem BD acessível (testes offline, manutenção) não há tokens a limpar:
  // falhar aqui só bloquearia a interface sem efeito útil.
  try {
    await ligacoes.limparTokens(NOME, condominioId);
  } catch (err) {
    console.warn('[onedrive] tokens locais não removidos:', http.sanitizar(err.message));
  }
}

// ── Pastas ──────────────────────────────────────────────────────────
// Concatena segmentos JÁ resolvidos (nomes ou caminhos do Graph) sem
// duplicar barras: `[...]` une tudo, `caminhoGraph` recria o prefixo `/`.
// Sem isto, `caminhoGraph([caminho, '2026'])` trataria o caminho inteiro
// como UM segmento e produziria "/GesCondu/Condomínio 2026".
function juntarCaminho(...partes) {
  return caminhoGraph(partes.flatMap((p) => segmentosDe(p)));
}

// Caminho da pasta do condomínio (<raiz>/<Condomínio>), criando-a se
// necessário (idempotente). O nome amigável vem SEMPRE de
// estrutura.nomePastaCondominio.
async function obterPastaCondominioId(condominioId) {
  const cond = await carregarCondominio(condominioId);
  const caminho = caminhoGraph([await obterCaminhoRaiz(condominioId), estrutura.nomePastaCondominio(cond)]);
  return garantirPasta(caminho, condominioId);
}

// Caminho da pasta do documento (cria os segmentos em falta).
// O condominioId é OBRIGATÓRIO — o condomínio nunca é deduzido por
// tipo/ano/ficheiro; fluxos sem contexto de condomínio não resolvem pasta.
async function pastaParaDocumento(tipo, ano, condominioId) {
  const cond = await carregarCondominio(condominioId);
  const raiz = await obterNomeRaiz(condominioId);
  const caminho = caminhoGraph(
    caminhoDocumento({
      raiz,
      condominioNome: estrutura.nomePastaCondominio(cond),
      ano: ano || new Date().getFullYear(),
      tipo,
    })
  );
  return garantirPasta(caminho, condominioId);
}

// Pasta de comprovativos de um fornecedor, DENTRO da árvore do condomínio
// (decisão documentada no projeto): o catálogo de fornecedores é partilhado
// do operador, mas o Documento/comprovativo é registado por condomínio —
// por isso o ficheiro físico segue o condomínio do documento:
//   <raiz>/<Condomínio>/<ano>/Fornecedores/<nome>/<subpasta>
// Nunca cria pastas duplicadas (garantirPasta reutiliza as existentes).
async function pastaParaFornecedor({ condominioId, nome, ano, subpasta = 'Comprovativos' } = {}) {
  await carregarCondominio(condominioId);
  const condominioFolderId = await obterPastaCondominioId(condominioId);
  const anoNum = String(ano || new Date().getFullYear());
  const anoId = await garantirPasta(juntarCaminho(condominioFolderId, anoNum), condominioId);
  const fornecedoresId = await garantirPasta(juntarCaminho(anoId, 'Fornecedores'), condominioId);
  const fornecedorId = await garantirPasta(
    juntarCaminho(fornecedoresId, segmentoSeguro(nome, 'Fornecedor')),
    condominioId
  );
  const subpastaId = await garantirPasta(
    juntarCaminho(fornecedorId, segmentoSeguro(subpasta, 'Outros')),
    condominioId
  );
  return { condominioFolderId, anoId, fornecedoresId, fornecedorId, subpastaId };
}

// Estrutura de pastas: <raiz>/<Condomínio>/<ano>/{<NOMES_PASTAS_ANO>} com a
// pasta global Backups na raiz (infraestrutura). Devolve caminhos do Graph.
async function criarEstruturaPastas(condominioId, ano = new Date().getFullYear()) {
  const raiz = await garantirPasta(await obterCaminhoRaiz(condominioId), condominioId);
  const condominioFolderId = await obterPastaCondominioId(condominioId);
  const anoId = await garantirPasta(juntarCaminho(condominioFolderId, String(ano)), condominioId);
  const subpastas = {};
  for (const nomePasta of estrutura.NOMES_PASTAS_ANO) {
    subpastas[nomePasta] = await garantirPasta(juntarCaminho(anoId, nomePasta), condominioId);
  }
  const backupsId = await garantirPasta(juntarCaminho(raiz, 'Backups'), condominioId);
  return { raizId: raiz, condominioFolderId, anoId, subpastas, backupsId };
}

// Pasta de BACKUPS da plataforma: <raiz>/Backups (sem condomínio). Os backups
// são da instalação (o dump contém dados de todos os condomínios) e usam a
// ligação de plataforma — nunca a conta de um condomínio.
async function pastaDeBackups() {
  const raiz = await garantirPasta(await obterCaminhoRaiz(null), null);
  return garantirPasta(juntarCaminho(raiz, 'Backups'), null);
}

// Não existem partilhas: o acesso aos documentos passa sempre pelo GesCondu
// (ver invariante de segurança no topo do ficheiro).
function linkPasta() {
  return null;
}

// ── Ficheiros ───────────────────────────────────────────────────────
// MIME type por extensão do nome (só para quando o chamador não indica um).
const MIME_POR_EXTENSAO = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function tipoConteudo(nomeArquivo, mimeType) {
  const declarado = String(mimeType || '').trim();
  if (declarado) return declarado;
  const ext = String(nomeArquivo || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return (ext && MIME_POR_EXTENSAO[ext[1]]) || 'application/octet-stream';
}

// Nome do ficheiro: sem `\` nem `/` (nunca cria subpastas nem sai da pasta
// do documento) e com um fallback sempre válido.
function nomeSeguro(nome) {
  const limpo = String(nome == null ? '' : nome)
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180)
    .trim();
  return limpo || `documento-${Date.now()}`;
}

// Pasta-mãe do upload: aceita o caminho devolvido pelos resolvedores
// (ex.: /GesCondu/<Condomínio>/2026/Recibos) e normaliza-o segmento a
// segmento, para nunca gerar `//` no caminho do Graph.
function pastaNormalizada(parentFolderId) {
  const texto = String(parentFolderId == null ? '' : parentFolderId).trim();
  if (!texto) throw new Error('parentFolderId é obrigatório para guardar o ficheiro no Microsoft OneDrive.');
  const caminho = segmentosDe(texto).map((s) => `/${s}`).join('');
  if (!caminho) throw new Error('parentFolderId inválido para guardar o ficheiro no Microsoft OneDrive.');
  return caminho;
}

// Upload pequeno (≤ 4 MB): PUT do buffer no conteúdo do item, por CAMINHO
// (o `caminho` já começa por `/`, pelo que o prefixo é `/root:` e não
// `/root:/`, para não gerar `//`), com o Content-Type do ficheiro.
async function uploadSimples(caminho, nomeArquivo, tipo, buffer, condominioId) {
  const url = `${GRAPH}/me/drive/root:${caminho}:/content`;
  const resposta = await operacaoGraph(condominioId, `envio de "${nomeArquivo}"`, (token) => ({
    url,
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': tipo },
    body: buffer,
  }));
  return resposta.dados || {};
}

// Upload grande (> 4 MB): sessão de upload com fatias de 320 KiB
// (múltiplo exigido pelo Graph) e Content-Range em cada fatia. Nenhuma
// fatia inclui o cabeçalho Authorization (o URL da sessão é
// pré-autenticado) — o token nunca é enviado para o domínio de upload.
async function uploadPorSessoes(caminho, nomeArquivo, tipo, buffer, condominioId) {
  const inicio = await operacaoGraph(condominioId, `início do envio de "${nomeArquivo}"`, (token) => ({
    url: `${GRAPH}/me/drive/root:${caminho}:/createUploadSession`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    json: { item: { '@microsoft.graph.conflictBehavior': 'replace', name: nomeArquivo } },
  }));
  const dadosSessao = inicio.dados || {};
  const urlSessao = dadosSessao.uploadUrl;
  if (!urlSessao) throw new Error(`O ${ROTULO} não devolveu um URL de sessão de envio.`);

  const total = buffer.length;
  let deslocamento = 0;
  let ultima = null;
  let ultimoByte = -1;
  while (deslocamento < total) {
    const fim = Math.min(deslocamento + TAMANHO_FATIA, total);
    const fatia = buffer.subarray(deslocamento, fim);
    const resposta = await http.pedir(urlSessao, {
      method: 'PUT',
      headers: {
        'Content-Length': String(fatia.length),
        'Content-Range': `bytes ${deslocamento}-${fim - 1}/${total}`,
      },
      body: fatia,
      timeoutMs: Math.max(http.TIMEOUT_MS, 120000),
    });
    if (!resposta.ok) {
      const e = http.erroApi(ROTULO, resposta, `envio de "${nomeArquivo}"`);
      e.status = resposta.status;
      throw e;
    }
    ultima = resposta;
    ultimoByte = fim - 1;
    deslocamento = fim;
  }

  // O Graph exige uma última fatia de comprimento ZERO ("bytes */total")
  // quando a última fatia enviada NÃO termina exatamente no fim do
  // ficheiro (tamanho não múltiplo de 320 KiB). Quando é múltiplo exato, a
  // própria fatia já fecha a sessão e não se envia mais nada.
  // (A verificação usa o intervalo que ENVIÁMOS: o Content-Range da
  // resposta pode não vir preenchido, e não se decide o fecho por ele.)
  if (ultima && ultimoByte < total - 1) {
    const fecho = await http.pedir(urlSessao, {
      method: 'PUT',
      headers: {
        'Content-Length': '0',
        // Chunk final de comprimento zero — ver Content-Range em
        // createUploadSession (o corpo vazio é obrigatório no fetch).
        'Content-Range': `bytes */${total}`,
      },
      body: '',
      timeoutMs: Math.max(http.TIMEOUT_MS, 120000),
    });
    if (!fecho.ok) {
      const e = http.erroApi(ROTULO, fecho, `fecho do envio de "${nomeArquivo}"`);
      e.status = fecho.status;
      throw e;
    }
    ultima = fecho;
  }
  return (ultima && ultima.dados) || {};
}

// Envia um Buffer para a pasta indicada (caminho do Graph) e devolve o
// localizador do contrato: o `localizador` é o id do driveItem SEM prefixo
// (o prefixo `od:` é acrescentado pela fachada com helpers/armazenamento/
// locator.js). `url` é sempre null: não se criam partilhas nem links.
async function uploadArquivo({ nome, mimeType, buffer, parentFolderId, condominioId } = {}) {
  const pasta = pastaNormalizada(parentFolderId);
  const corpo = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!corpo.length) throw new Error('O ficheiro a enviar está vazio.');
  const nomeArquivo = nomeSeguro(nome);
  const tipo = tipoConteudo(nomeArquivo, mimeType);
  // `pasta` já começa por `/`: não acrescentar outra barra (o Graph trata
  // `//` como nome de pasta vazio e a criação falharia).
  const caminho = `${pasta}/${nomeArquivo}`.replace(/\/{2,}/g, '/');
  const meta =
    corpo.length > LIMITE_UPLOAD_SIMPLES
      ? await uploadPorSessoes(caminho, nomeArquivo, tipo, corpo, condominioId)
      : await uploadSimples(caminho, nomeArquivo, tipo, corpo, condominioId);

  const id = meta.id || null;
  if (!id) throw new Error(`O ${ROTULO} não confirmou o envio do ficheiro "${nomeArquivo}".`);
  return {
    provedorFileId: id,
    localizador: id, // sem prefixo — o `od:` é montado pela fachada
    tamanho: meta.size != null ? Number(meta.size) : corpo.length,
    pastaId: pasta,
    url: null,
  };
}

// Descarrega um ficheiro para um Buffer (ex.: para anexar em email).
// O Graph responde 302 para um URL PRÉ-AUTENTICADO de outro domínio: o
// fetch nativo segue o redirecionamento e, por ser cross-origin, NÃO
// reenvia o cabeçalho Authorization — o token fica sempre no domínio do
// Graph e o conteúdo é servido pelo URL temporário assinado.
async function descarregarArquivo(fileId, condominioId) {
  const id = String(fileId == null ? '' : fileId).trim();
  if (!id) throw new Error('fileId é obrigatório para descarregar do Microsoft OneDrive.');
  const resposta = await operacaoGraph(condominioId, 'download do ficheiro', (token) => ({
    url: `${GRAPH}/me/drive/items/${encodeURIComponent(id)}/content`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    binario: true,
  }));
  return resposta.buffer || Buffer.alloc(0);
}

// Abre um fluxo de leitura (streaming para o cliente), utilizável em
// stream.pipeline. O http.js consome sempre o corpo, por isso o pedido é
// feito aqui com fetch + AbortSignal.timeout, com o mesmo tratamento de
// erros (401 limpa os tokens; 403 aponta para Configuração).
async function abrirFluxo(fileId, condominioId) {
  const id = String(fileId == null ? '' : fileId).trim();
  if (!id) throw new Error('fileId é obrigatório para abrir o ficheiro do Microsoft OneDrive.');
  const token = await accessToken(condominioId);
  let resposta;
  try {
    resposta = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}/content`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow', // o Authorization é removido neste salto (cross-origin)
      signal: AbortSignal.timeout(Math.max(http.TIMEOUT_MS, 120000)),
    });
  } catch (err) {
    const motivo = err && err.name === 'TimeoutError' ? 'sem resposta do serviço' : http.sanitizar(err && err.message);
    throw new Error(`Não foi possível comunicar com o ${ROTULO}: ${motivo}`);
  }
  if (!resposta.ok) {
    if (resposta.status === 401) {
      await ligacoes.limparTokens(NOME, condominioId).catch(() => {});
      throw erroLigacao();
    }
    if (resposta.status === 403) {
      throw new Error(`Sem permissão para executar esta operação no ${ROTULO}. Confirme a ligação em Configuração → Armazenamento e Backups.`);
    }
    // Consome o corpo (JSON de erro) para conseguir uma mensagem legível.
    let dados = null;
    let texto = '';
    try {
      texto = await resposta.text();
      dados = JSON.parse(texto);
    } catch (err) {
      dados = null;
    }
    const e = http.erroApi(ROTULO, { status: resposta.status, dados, texto }, 'abertura do ficheiro');
    e.status = resposta.status;
    throw e;
  }
  if (!resposta.body) throw new Error(`O ${ROTULO} devolveu uma resposta sem conteúdo.`);
  const tamanho = Number(resposta.headers.get('content-length'));
  return {
    fluxo: Readable.fromWeb(resposta.body),
    tamanho: Number.isFinite(tamanho) && tamanho > 0 ? tamanho : undefined,
    nome: null,
  };
}

module.exports = {
  // Identificação
  nome,
  rotulo,
  capacidades,
  // Configuração/estado
  featureAtiva,
  temCredenciais,
  redirectUriDefinido,
  isConfigured,
  estadoLigacao,
  testarLigacao,
  // OAuth
  urlAutorizacao,
  trocarCodigo,
  renovarToken,
  desligar,
  // Pastas
  garantirPasta,
  obterPastaCondominioId,
  pastaParaDocumento,
  pastaParaFornecedor,
  criarEstruturaPastas,
  pastaDeBackups,
  linkPasta,
  // Ficheiros
  uploadArquivo,
  descarregarArquivo,
  abrirFluxo,
  // Estrutura partilhada (multi-provedor)
  nomePastaCondominio: estrutura.nomePastaCondominio,
  subpastaDoTipo: estrutura.subpastaDoTipo,
  caminhoPastaDocumento: estrutura.caminhoPastaDocumento,
  caminhoPastaFornecedor: estrutura.caminhoPastaFornecedor,
  SCOPE,
  RAIZ_PADRAO,
  LIMITE_UPLOAD_SIMPLES,
  TAMANHO_FATIA,
};
