// ─────────────────────────────────────────────────────────────────────
// Dropbox — provedor de armazenamento do GesCondu (OAuth 2.0 + API v2).
//
// O provedor é escolhido por condomínio (Configuração → Armazenamento e
// Backups) e a ligação é feita pelo fluxo OAuth: os tokens (access +
// refresh) ficam guardados na base de dados, por condomínio, através de
// helpers/armazenamento/ligacoes.js — nunca no browser, em logs ou em
// ficheiros públicos.
//
// ── INVARIANTE DE SEGURANÇA ──────────────────────────────────────────
//  · Os ficheiros ficam PRIVADOS na conta Dropbox do condomínio/operador.
//    O GesCondu é o único caminho de acesso aos documentos: o download e o
//    streaming são servidos pelo backend, depois de verificar
//    Utilizador → Condomínio → Documento (helpers/documentos-acesso.js).
//  · Este adaptador NÃO usa (nem pode usar) os endpoints de partilha da
//    Dropbox (`sharing/create_shared_link_*`, `sharing/add_file_member`,
//    …): não existem links públicos nem acesso direto sem passar pelo
//    GesCondu. Por isso `linkPasta` devolve sempre null.
//  · Nenhuma mensagem de erro mostra caminhos, ids de ficheiro ou tokens
//    (ver `semLocalizacao`); uma ligação revogada é limpa e o utilizador é
//    encaminhado para Configuração → Armazenamento e Backups.
//
// ── Pastas: CAMINHOS, não ids ────────────────────────────────────────
// A API da Dropbox não tem identificadores de pasta. Como `files/upload` e
// `files/download` aceitam caminhos, a hierarquia é expressa em caminhos
// (strings começadas por `/`) — o mesmo formato lógico dos restantes
// provedores (helpers/armazenamento/estrutura.js). Os nomes da árvore vêm
// sempre dos planners puros (nunca são duplicados aqui) e a criação de
// pastas é idempotente (a Dropbox responde `path/conflict/folder` quando a
// pasta já existe — tratado como sucesso).
//
// Este módulo carrega sem rede e sem base de dados: nada é executado no
// `require` (todas as leituras de BD/API acontecem dentro das funções).
// ─────────────────────────────────────────────────────────────────────
const { Readable } = require('stream');
const ligacoes = require('../ligacoes');
const estrutura = require('../estrutura');
const { pedir, urlComQuery, erroApi, mensagemErro, sanitizar, TIMEOUT_MS } = require('../http');

const PROVEDOR = 'dropbox';
const ROTULO = 'Dropbox';

// Endpoints (constantes — nenhum pedido é feito no carregamento do módulo).
const URL_AUTORIZACAO = 'https://www.dropbox.com/oauth2/authorize';
const URL_TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const URL_API = 'https://api.dropboxapi.com/2';
const URL_CONTEUDO = 'https://content.dropboxapi.com/2';

// Pasta inicial na conta Dropbox quando não há raiz configurada.
const RAIZ_PADRAO = 'GesCondu';

// Margem de segurança antes da expiração do access token (o token é
// renovado um minuto antes de caducar, para não falhar a meio de um envio).
const MARGEM_EXPIRACAO_MS = 60000;

const MENSAGEM_SEM_LIGACAO =
  'O Dropbox não está ligado a este condomínio. Vá a Configuração → Armazenamento e Backups e ligue uma conta Dropbox.';
const MENSAGEM_RELIGAR =
  'A ligação ao Dropbox expirou ou foi revogada. Vá a Configuração → Armazenamento e Backups e ligue novamente a conta Dropbox.';

// ── Identidade do provedor ──────────────────────────────────────────
function nome() {
  return PROVEDOR;
}

function rotulo() {
  return ROTULO;
}

// Nunca declara `linksPublicos`: o acesso é sempre servido pelo GesCondu.
function capacidades() {
  return { oauth: true, pastas: true, streaming: true, backups: true };
}

// ── Configuração (variáveis de ambiente) ────────────────────────────
function featureAtiva() {
  return process.env.DROPBOX_ENABLED === 'true';
}

function credenciaisOAuth() {
  return {
    clientId: process.env.DROPBOX_APP_KEY || '',
    clientSecret: process.env.DROPBOX_APP_SECRET || '',
    redirectUri: process.env.DROPBOX_REDIRECT_URI || '',
  };
}

function temCredenciais() {
  const c = credenciaisOAuth();
  return Boolean(c.clientId && c.clientSecret);
}

function redirectUriDefinido() {
  return Boolean(credenciaisOAuth().redirectUri);
}

// ── Estado da ligação ───────────────────────────────────────────────
// Id de condomínio normalizado (a ligação ao Dropbox é sempre por
// condomínio: sem id não há tokens e nada é escrito na chave global antiga
// do Google Drive).
function normalizarId(condominioId) {
  const n = Number(condominioId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Síncrono (cache de helpers/armazenamento/ligacoes): é o que as vistas e os
// callers esperam. Sem feature/credenciais, ou sem tokens, não está ligado.
function isConfigured(condominioId) {
  if (!featureAtiva() || !temCredenciais()) return false;
  const { tokens } = ligacoes.tokensSync(PROVEDOR, normalizarId(condominioId));
  return Boolean(tokens && (tokens.refresh_token || tokens.access_token));
}

// Estado detalhado para a interface de Configuração (mesma forma do
// Google Drive — helpers/drive.js:estadoLigacao). `viaEnv` é sempre false:
// a Dropbox não tem ligação legada por variável de ambiente.
async function estadoLigacao(condominioId) {
  const cid = normalizarId(condominioId);
  let guardados = null;
  if (cid) {
    guardados = (await ligacoes.lerTokens(PROVEDOR, cid).catch(() => ({ tokens: null }))).tokens;
  }
  const temTokens = Boolean(guardados && (guardados.refresh_token || guardados.access_token));
  return {
    ativo: featureAtiva(),
    credenciais: temCredenciais(),
    redirectUriDefinido: redirectUriDefinido(),
    ligado: featureAtiva() && temCredenciais() && temTokens,
    viaEnv: false,
    conta: (guardados && guardados.conta) || null,
  };
}

// ── Erros da API ────────────────────────────────────────────────────
// Resumo técnico da falha tal como a Dropbox o devolve (uso interno: as
// decisões de idempotência comparam este texto, antes de qualquer limpeza).
function resumoErro(resposta) {
  const d = (resposta && resposta.dados) || {};
  return String(d.error_summary || d.error_description || d.error || (resposta && resposta.texto) || '');
}

// Um corpo binário (download) também pode trazer um erro em JSON: é
// descodificado apenas para se poder ler a mensagem da API.
function comoTexto(resposta) {
  if (!resposta || resposta.texto || resposta.dados) return resposta;
  let texto = '';
  if (resposta.buffer) {
    try {
      texto = Buffer.from(resposta.buffer).toString('utf8');
    } catch (err) {
      texto = '';
    }
  }
  let dados = null;
  if (texto) {
    try {
      dados = JSON.parse(texto);
    } catch (err) {
      dados = null;
    }
  }
  return { ...resposta, texto, dados };
}

// Remove caminhos e ids de ficheiro das mensagens: o utilizador nunca vê a
// localização dos documentos na conta Dropbox (helpers/armazenamento/http.js
// já remove as credenciais).
function semLocalizacao(texto) {
  return sanitizar(texto)
    .replace(/id:[A-Za-z0-9_-]+/g, 'id…')
    .replace(/\/[^\s"',;)]+/g, '/…');
}

// Detalhe técnico para diagnóstico (logs) — nunca mostrado na interface.
function detalheTecnico(resposta) {
  return semLocalizacao(mensagemErro(comoTexto(resposta), 'erro desconhecido'));
}

// Erros da Dropbox que significam "token inválido/revogado/permissões
// retiradas": obrigam a ligar novamente a conta.
const PADRAO_TOKEN_INVALIDO =
  /invalid_access_token|expired_access_token|invalid_grant|invalid_refresh|revoked|user_suspended|missing_scope|no_access/i;

function pedidoComTokenInvalido(resposta) {
  if (!resposta) return false;
  if (resposta.status === 401) return true;
  const resumo = resumoErro(resposta);
  return PADRAO_TOKEN_INVALIDO.test(String(resumo));
}

// Erro normalizado do provedor (nunca inclui tokens, caminhos nem ids).
function erroDropbox(resposta, contexto) {
  const r = comoTexto(resposta);
  const e = erroApi(ROTULO, r, contexto);
  e.message = semLocalizacao(e.message);
  if (pedidoComTokenInvalido(r)) e.tokenInvalido = true;
  return e;
}

// Falha de rede/tempo limite do fetch direto (streaming) — mesmo tratamento
// do cliente partilhado.
function erroRede(err) {
  const motivo = err && err.name === 'TimeoutError' ? `sem resposta em ${TIMEOUT_MS} ms` : semLocalizacao(err && err.message);
  const e = new Error(`${ROTULO}: falha de rede${motivo ? ` — ${motivo}` : ''}.`);
  e.codigo = 'REDE';
  return e;
}

// ── Tokens: renovação e chamadas autenticadas ───────────────────────
// Limpa a ligação do condomínio (nunca a chave global do Google Drive).
async function esquecerLigacao(condominioId) {
  const cid = normalizarId(condominioId);
  if (!cid) return;
  await ligacoes.limparTokens(PROVEDOR, cid).catch(() => {});
}

// O access token da Dropbox dura ~4 h. Sem data de expiração conhecida
// assume-se válido (a API decide: um 401 força a renovação).
function expirado(tokens) {
  if (!tokens || !tokens.access_token) return true;
  const exp = Number(tokens.expiry_date);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  return Date.now() + MARGEM_EXPIRACAO_MS >= exp;
}

// Devolve tokens utilizáveis, renovando o access token quando expirou (ou
// está a menos de 60 s de expirar). Não é feito um pedido de renovação por
// cada operação enquanto o token guardado continuar válido.
async function renovarToken(condominioId, { forcar = false } = {}) {
  const cid = normalizarId(condominioId);
  if (!cid) throw new Error(MENSAGEM_SEM_LIGACAO);

  const { tokens } = await ligacoes.lerTokens(PROVEDOR, cid).catch(() => ({ tokens: null }));
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) throw new Error(MENSAGEM_SEM_LIGACAO);
  if (!forcar && tokens.access_token && !expirado(tokens)) return tokens;

  // Sem refresh_token não há renovação possível: usa-se o access existente
  // (se o token tiver sido revogado, o 401 limpa a ligação mais abaixo).
  if (!tokens.refresh_token) {
    if (tokens.access_token) return tokens;
    throw new Error(MENSAGEM_SEM_LIGACAO);
  }

  const c = credenciaisOAuth();
  if (!c.clientId || !c.clientSecret) throw new Error(MENSAGEM_SEM_LIGACAO);

  const resposta = await pedir(URL_TOKEN, {
    method: 'POST',
    form: {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: c.clientId,
      client_secret: c.clientSecret,
    },
  });
  if (!resposta.ok) {
    if (pedidoComTokenInvalido(resposta)) {
      await esquecerLigacao(cid);
      throw new Error(MENSAGEM_RELIGAR);
    }
    throw erroDropbox(resposta, 'não foi possível renovar o acesso ao Dropbox');
  }

  const dados = resposta.dados || {};
  if (!dados.access_token) throw new Error('O Dropbox não devolveu um token de acesso.');
  // guardarTokens funde com o que está na BD: o refresh_token nunca se perde.
  return ligacoes.guardarTokens(PROVEDOR, cid, {
    access_token: dados.access_token,
    refresh_token: dados.refresh_token || null,
    expiry_date: dados.expires_in ? Date.now() + Number(dados.expires_in) * 1000 : null,
  });
}

// Executa uma operação autenticada: renova o token antes da chamada e, se a
// API recusar o token, tenta uma única renovação forçada; se essa também
// falhar, limpa a ligação e lança uma mensagem que aponta para Configuração →
// Armazenamento e Backups (nunca a resposta em bruto da Dropbox).
async function comAutenticacao(condominioId, executar) {
  const tokens = await renovarToken(condominioId);
  try {
    return await executar(tokens.access_token);
  } catch (err) {
    if (!err || !err.tokenInvalido) throw err;
    if (!tokens.refresh_token) {
      await esquecerLigacao(condominioId);
      throw new Error(MENSAGEM_RELIGAR);
    }
    const renovados = await renovarToken(condominioId, { forcar: true });
    try {
      return await executar(renovados.access_token);
    } catch (err2) {
      if (!err2 || !err2.tokenInvalido) throw err2;
      await esquecerLigacao(condominioId);
      throw new Error(MENSAGEM_RELIGAR);
    }
  }
}

// ── Fluxo OAuth ─────────────────────────────────────────────────────
// URL para o utilizador autorizar a aplicação. `token_access_type=offline`
// garante o refresh_token (sem ele a ligação morria ao fim de ~4 h).
function urlAutorizacao({ redirectUri, state, condominioId } = {}) {
  const c = credenciaisOAuth();
  if (!c.clientId) throw new Error('O Dropbox não está configurado (falta DROPBOX_APP_KEY).');
  return urlComQuery(URL_AUTORIZACAO, {
    client_id: c.clientId,
    response_type: 'code',
    token_access_type: 'offline',
    redirect_uri: redirectUri || c.redirectUri,
    state: state || (condominioId ? `c${normalizarId(condominioId) || ''}` : undefined),
  });
}

// Identifica a conta ligada (email ou nome). Nunca devolve tokens.
async function identificarConta(accessToken) {
  const resposta = await pedir(`${URL_API}/users/get_current_account`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    // Endpoint sem argumentos: a Dropbox espera o corpo `null`.
    body: 'null',
  });
  if (!resposta.ok) throw erroDropbox(resposta, 'não foi possível identificar a conta Dropbox');
  const d = resposta.dados || {};
  if (d.email) return String(d.email);
  if (d.name && d.name.display_name) return String(d.name.display_name);
  return null;
}

// Troca o código de autorização pelos tokens e guarda-os (por condomínio).
async function trocarCodigo({ code, redirectUri, condominioId }) {
  const cid = normalizarId(condominioId);
  if (!cid) throw new Error('condominioId é obrigatório para guardar a ligação ao Dropbox.');
  if (!code) throw new Error('Código de autorização do Dropbox em falta.');

  const c = credenciaisOAuth();
  if (!c.clientId || !c.clientSecret) {
    throw new Error('O Dropbox não está configurado (faltam DROPBOX_APP_KEY e DROPBOX_APP_SECRET).');
  }

  const form = {
    code,
    grant_type: 'authorization_code',
    client_id: c.clientId,
    client_secret: c.clientSecret,
  };
  const uri = String(redirectUri || c.redirectUri || '').trim();
  if (uri) form.redirect_uri = uri;

  const resposta = await pedir(URL_TOKEN, { method: 'POST', form });
  if (!resposta.ok) throw erroDropbox(resposta, 'não foi possível concluir a autorização do Dropbox');

  const dados = resposta.dados || {};
  if (!dados.access_token) throw new Error('O Dropbox não devolveu um token de acesso.');

  // Identificar a conta é opcional: uma falha aqui NÃO invalida a ligação.
  const conta = await identificarConta(dados.access_token).catch(() => null);

  return ligacoes.guardarTokens(PROVEDOR, cid, {
    access_token: dados.access_token,
    refresh_token: dados.refresh_token || null,
    expiry_date: dados.expires_in ? Date.now() + Number(dados.expires_in) * 1000 : null,
    conta,
  });
}

// Testa a ligação atual (não altera nada e nunca lança).
async function testarLigacao(condominioId) {
  try {
    if (!isConfigured(condominioId)) {
      return { ok: false, erro: 'O Dropbox não está ligado a este condomínio.' };
    }
    const conta = await comAutenticacao(condominioId, (accessToken) => identificarConta(accessToken));
    return { ok: true, conta: conta || null };
  } catch (err) {
    return { ok: false, erro: (err && err.message) || 'Não foi possível contactar o Dropbox.' };
  }
}

// Desliga o condomínio: revoga o token na Dropbox (melhor esforço) e limpa
// os tokens guardados. Os ficheiros já existentes na conta Dropbox NÃO são
// apagados — continuam privados e acessíveis se a conta for ligada de novo.
async function desligar(condominioId) {
  const cid = normalizarId(condominioId);
  if (cid) {
    try {
      const tokens = await renovarToken(cid).catch(() => null);
      const acesso = tokens && tokens.access_token;
      if (acesso) {
        const resposta = await pedir(`${URL_API}/auth/token/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${acesso}` },
        });
        // A revogação é melhor esforço: uma falha aqui não impede o
        // "Desligar" (os tokens locais são removidos na mesma).
        if (!resposta.ok) console.warn('[dropbox] revogação não confirmada:', detalheTecnico(resposta));
      }
    } catch (err) {
      // Sem ligação utilizável: segue para a limpeza dos tokens locais.
    }
  }
  await esquecerLigacao(cid);
}

// ── Pastas (caminhos) ───────────────────────────────────────────────
// A Dropbox recusa nomes com estes caracteres (ou terminados em ponto):
// são substituídos por '-' para que a hierarquia partilhada seja estável e
// não colida com as regras do serviço.
const CARACTERES_PROIBIDOS = /[\\/:*?"<>|]/g;

function nomeSegmento(valor) {
  const nome = String(valor == null ? '' : valor)
    // Remove caracteres de controlo (nunca aparecem num nome válido).
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(CARACTERES_PROIBIDOS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim()
    .replace(/[.\s]+$/, '');
  if (nome === '.' || nome === '..') return '';
  return nome;
}

// Segmentos válidos de um caminho ou de uma lista de nomes (um valor com
// barras, como uma raiz configurada "GesCondu/Clientes", dá vários níveis).
function segmentosDe(valor) {
  const lista = Array.isArray(valor) ? valor : [valor];
  const segmentos = [];
  for (const item of lista) {
    for (const parte of String(item == null ? '' : item).split('/')) {
      const nome = nomeSegmento(parte);
      if (nome) segmentos.push(nome);
    }
  }
  return segmentos;
}

// Prende a raiz configurada ao caminho devolvido pelos planners puros
// (helpers/armazenamento/estrutura.js): o planner recebe o nome da raiz e as
// subpastas de raiz são acrescentadas à frente.
function caminhoComRaiz(raizSeg, partes) {
  const prefixo = raizSeg.slice(0, -1);
  const nomes = [...partes].map((p) => nomeSegmento(p)).filter(Boolean);
  return [...prefixo, ...nomes];
}

// Raiz do condomínio: pasta guardada (Configuração → Armazenamento e
// Backups) → DROPBOX_ROOT_FOLDER (.env) → "GesCondu".
async function segmentosRaiz(condominioId) {
  const cid = normalizarId(condominioId);
  let guardada = '';
  if (cid) guardada = await ligacoes.lerRaiz(PROVEDOR, cid).catch(() => '');
  const valor = String(guardada || process.env.DROPBOX_ROOT_FOLDER || '').trim();
  const segmentos = segmentosDe(valor || RAIZ_PADRAO);
  return segmentos.length ? segmentos : [RAIZ_PADRAO];
}

// O condomínio é SEMPRE resolvido por condominio_id (nunca por nome de
// ficheiro, fração, tipo, ano ou pasta).
async function carregarCondominio(condominioId) {
  const cid = normalizarId(condominioId);
  if (!cid) throw new Error('condominioId é obrigatório para determinar a pasta no Dropbox.');
  const { Condominio } = require('../../../models');
  const cond = await Condominio.findByPk(cid);
  if (!cond) throw new Error('Condomínio não encontrado para determinar a pasta no Dropbox.');
  return cond;
}

// Cria uma pasta (um nível) com o token já resolvido. Idempotente: a Dropbox
// responde `path/conflict/folder` quando a pasta já existe — é sucesso.
// `autorename` fica desligado para nunca criar pastas duplicadas ("Pasta (1)").
async function criarPastaSeFaltar(accessToken, caminho) {
  const resposta = await pedir(`${URL_API}/files/create_folder_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    json: { path: caminho, autorename: false },
  });
  if (resposta.ok) return;
  if (resposta.status === 409 && /path\/conflict\/folder/i.test(resumoErro(resposta))) return;
  throw erroDropbox(resposta, 'não foi possível criar a pasta no Dropbox');
}

// Criador de pastas de UMA operação: recebe o token já resolvido e cria cada
// nível pedido, sem repetir níveis já tratados (cada nível é um pedido; a
// repetição de um nível já criado é evitada localmente). Devolve sempre o
// caminho completo do último nível.
function criadorDePastas(accessToken) {
  const tratados = new Set();
  return async function criar(caminho) {
    const partes = segmentosDe(caminho);
    let atual = '';
    for (const parte of partes) {
      atual += `/${parte}`;
      if (tratados.has(atual)) continue;
      await criarPastaSeFaltar(accessToken, atual);
      tratados.add(atual);
    }
    return atual;
  };
}

// Cria todos os níveis de um caminho (lista de segmentos ou string com
// barras) com UMA autenticação: uma leitura de tokens por operação, não uma
// por pasta.
async function garantirCaminho(caminho, condominioId) {
  return comAutenticacao(condominioId, async (accessToken) => criadorDePastas(accessToken)(caminho));
}

// Pasta do condomínio: <raiz>/<nome amigável> (criada se faltar).
async function obterPastaCondominioId(condominioId) {
  const cid = normalizarId(condominioId);
  const cond = await carregarCondominio(cid);
  const raizSeg = await segmentosRaiz(cid);
  const segmentos = [...raizSeg, nomeSegmento(estrutura.nomePastaCondominio(cond))].filter(Boolean);
  return garantirCaminho(segmentos, cid);
}

// Estrutura de pastas no Dropbox (todos os valores são CAMINHOS):
//   <raiz>/{Backups, <Condomínio>/<ano>/{Assembleias, Quotas, Recibos,
//           Despesas, Contratos, Outros}}
// Os nomes das subpastas do ano vêm de estrutura.NOMES_PASTAS_ANO e a pasta
// Backups é sempre global (na raiz). Sem condominioId não há ligação própria
// (os tokens são por condomínio): a árvore é criada, mas a Dropbox exige uma
// ligação — sem ela o erro aponta para Configuração → Armazenamento e
// Backups.
async function criarEstruturaPastas(condominioId = null, ano = new Date().getFullYear()) {
  const cid = normalizarId(condominioId);
  const raizSeg = await segmentosRaiz(cid);
  const cond = cid ? await carregarCondominio(cid) : null;
  const nomeAno = nomeSegmento(ano) || String(new Date().getFullYear());

  return comAutenticacao(cid, async (accessToken) => {
    const criar = criadorDePastas(accessToken);
    const raizId = await criar(raizSeg);
    // A pasta Backups é infraestrutura global (sempre na raiz).
    const backupsId = await criar([raizId, 'Backups']);
    const condominioFolderId = cond
      ? await criar([raizId, nomeSegmento(estrutura.nomePastaCondominio(cond)) || 'Condomínio'])
      : null;
    const anoId = await criar([condominioFolderId || raizId, nomeAno]);

    const subpastas = {};
    for (const nome of estrutura.NOMES_PASTAS_ANO) {
      subpastas[nome] = await criar([anoId, nome]);
    }
    return { raizId, condominioFolderId, anoId, subpastas, backupsId };
  });
}

// Caminho da pasta de BACKUPS da plataforma: <raiz>/Backups (sem condomínio).
// Os backups são da instalação (o dump contém dados de todos os condomínios),
// por isso usam a ligação de plataforma — nunca a conta de um condomínio.
async function pastaDeBackups() {
  return comAutenticacao(null, async (accessToken) => {
    const criar = criadorDePastas(accessToken);
    const raizSeg = await segmentosRaiz(null);
    const raizId = await criar(raizSeg);
    return criar([raizId, 'Backups']);
  });
}

// Caminho da pasta do condomínio/ano/tipo do documento (cria o que faltar).
// O condominioId é OBRIGATÓRIO — o condomínio nunca se deduz pelo tipo/ano.
async function pastaParaDocumento(tipo, ano, condominioId) {
  const cid = normalizarId(condominioId);
  if (!cid) throw new Error('condominioId é obrigatório para determinar a pasta do documento no Dropbox.');
  const cond = await carregarCondominio(cid);
  const raizSeg = await segmentosRaiz(cid);
  const partes = estrutura.caminhoPastaDocumento({
    raiz: raizSeg[raizSeg.length - 1],
    condominioNome: estrutura.nomePastaCondominio(cond),
    ano: ano || new Date().getFullYear(),
    tipo,
  });
  return garantirCaminho(caminhoComRaiz(raizSeg, partes), cid);
}

// Pasta de comprovativos de um fornecedor, DENTRO da árvore do condomínio
// (mesma decisão do Google Drive): o catálogo de fornecedores é do operador,
// mas o comprovativo é registado por condomínio:
//   <raiz>/<Condomínio>/<ano>/Fornecedores/<nome>/<subpasta>
// Devolve CAMINHOS (a Dropbox não tem ids de pasta), com a mesma forma do
// objeto devolvido por helpers/drive.js:pastaParaFornecedor.
async function pastaParaFornecedor({ condominioId, nome, ano, subpasta = 'Comprovativos' } = {}) {
  const cid = normalizarId(condominioId);
  if (!cid) throw new Error('condominioId é obrigatório para determinar a pasta do fornecedor no Dropbox.');
  const cond = await carregarCondominio(cid);
  const raizSeg = await segmentosRaiz(cid);
  const partes = estrutura.caminhoPastaFornecedor({
    raiz: raizSeg[raizSeg.length - 1],
    condominioNome: estrutura.nomePastaCondominio(cond),
    ano: ano || new Date().getFullYear(),
    nome: nome || 'Fornecedor',
    subpasta: subpasta || 'Outros',
  });

  // Layout do planner: [raiz, condomínio, ano, Fornecedores, nome, subpasta];
  // o prefixo da raiz (uma raiz com subpastas, ex. "Clientes/GesCondu") fica
  // à frente, pelo que o condomínio está em prefixo.length + 1.
  const prefixo = raizSeg.slice(0, -1);
  const segmentos = caminhoComRaiz(raizSeg, partes);
  const niveis = {
    condominioFolderId: prefixo.length + 1,
    anoId: prefixo.length + 2,
    fornecedoresId: prefixo.length + 3,
    fornecedorId: prefixo.length + 4,
    subpastaId: prefixo.length + 5,
  };

  return comAutenticacao(cid, async (accessToken) => {
    const criar = criadorDePastas(accessToken);
    const caminhos = {};
    for (const [chave, indice] of Object.entries(niveis)) {
      caminhos[chave] = await criar(segmentos.slice(0, indice + 1));
    }
    return caminhos;
  });
}

// Sem link de pasta: a Dropbox não expõe um URL de pasta sem criar uma
// partilha pública — PROIBIDO pelo contrato (o acesso aos documentos passa
// sempre pelo GesCondu, depois de verificar Utilizador → Condomínio →
// Documento). O painel mostra o estado, não um atalho externo.
function linkPasta(pastaId) {
  return null;
}

// ── Ficheiros ───────────────────────────────────────────────────────
// Referência aceite pela Dropbox: o id (`id:…`, tal como é guardado no
// localizador) ou um caminho. Um localizador completo (`dbx:…`) é aceite por
// robustez — o prefixo é da fachada (helpers/armazenamento/locator.js).
function referencia(fileId) {
  const texto = String(fileId == null ? '' : fileId).trim();
  if (!texto) throw new Error('O identificador do ficheiro no Dropbox é obrigatório.');
  return texto.replace(/^dbx:/i, '');
}

// Envia um Buffer para a pasta indicada (content endpoint `files/upload`).
// O id devolvido segue SEM prefixo (`localizador`): o prefixo `dbx:` é
// acrescentado pela fachada.
// O mimeType é aceite por compatibilidade com o contrato, mas a Dropbox não
// guarda o tipo de conteúdo no envio. A API limita este envio simples a
// 150 MB (os documentos/PDF do GesCondu ficam muito abaixo desse limite).
async function uploadArquivo({ nome, buffer, parentFolderId, condominioId }) {
  const nomeFicheiro = nomeSegmento(nome);
  if (!nomeFicheiro) throw new Error('O nome do ficheiro é obrigatório para o upload no Dropbox.');
  if (!buffer || !buffer.length) throw new Error('O conteúdo do ficheiro está vazio.');

  const pasta = segmentosDe(parentFolderId).join('/');
  const caminho = `/${pasta ? `${pasta}/` : ''}${nomeFicheiro}`;

  return comAutenticacao(condominioId, async (accessToken) => {
    const resposta = await pedir(`${URL_CONTEUDO}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: caminho, mode: 'add', autorename: true, mute: false }),
      },
      body: buffer,
    });
    if (!resposta.ok) throw erroDropbox(resposta, 'não foi possível enviar o ficheiro para o Dropbox');

    const d = resposta.dados || {};
    const id = d.id ? String(d.id) : null;
    if (!id) throw new Error('O Dropbox não devolveu o identificador do ficheiro.');
    return {
      provedorFileId: id,
      localizador: id,
      tamanho: d.size != null ? Number(d.size) : buffer.length,
      // Caminho da pasta onde o ficheiro ficou (a Dropbox não tem ids de pasta).
      pastaId: pasta ? `/${pasta}` : null,
      url: null,
    };
  });
}

// Descarrega um ficheiro para um Buffer (para anexar em email/PDF).
async function descarregarArquivo(fileId, condominioId) {
  const alvo = referencia(fileId);
  return comAutenticacao(condominioId, async (accessToken) => {
    const resposta = await pedir(`${URL_CONTEUDO}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: alvo }),
      },
      binario: true,
    });
    if (!resposta.ok) throw erroDropbox(resposta, 'não foi possível descarregar o ficheiro do Dropbox');
    return resposta.buffer || Buffer.alloc(0);
  });
}

// Abre um fluxo de leitura para servir o ficheiro ao cliente sem o carregar
// todo em memória. O http.js não devolve o corpo em bruto, por isso o fetch é
// feito aqui — com o mesmo tempo limite e o mesmo tratamento de erros.
async function abrirFluxo(fileId, condominioId) {
  const alvo = referencia(fileId);
  return comAutenticacao(condominioId, async (accessToken) => {
    let resposta;
    try {
      resposta = await fetch(`${URL_CONTEUDO}/files/download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': JSON.stringify({ path: alvo }),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw erroRede(err);
    }
    if (!resposta.ok) {
      const corpo = { ok: resposta.ok, status: resposta.status, headers: resposta.headers, texto: '', dados: null };
      try {
        corpo.texto = await resposta.text();
        if (corpo.texto) {
          try {
            corpo.dados = JSON.parse(corpo.texto);
          } catch (err) {
            corpo.dados = null;
          }
        }
      } catch (err) {
        corpo.texto = '';
      }
      throw erroDropbox(corpo, 'não foi possível abrir o ficheiro no Dropbox');
    }
    if (!resposta.body) throw new Error(`${ROTULO}: a resposta não trouxe conteúdo.`);

    // A Dropbox devolve os metadados no cabeçalho Dropbox-API-Result.
    let meta = null;
    try {
      meta = JSON.parse(resposta.headers.get('Dropbox-API-Result') || 'null');
    } catch (err) {
      meta = null;
    }
    return {
      fluxo: Readable.fromWeb(resposta.body),
      tamanho: meta && meta.size != null ? Number(meta.size) : null,
      nome: (meta && meta.name) || null,
    };
  });
}

module.exports = {
  nome,
  rotulo,
  capacidades,
  featureAtiva,
  temCredenciais,
  redirectUriDefinido,
  isConfigured,
  estadoLigacao,
  testarLigacao,
  urlAutorizacao,
  trocarCodigo,
  desligar,
  uploadArquivo,
  descarregarArquivo,
  abrirFluxo,
  pastaParaDocumento,
  pastaParaFornecedor,
  obterPastaCondominioId,
  criarEstruturaPastas,
  pastaDeBackups,
  linkPasta,
};
