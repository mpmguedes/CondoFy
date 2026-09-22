// ═══════════════════════════════════════════════════════════════════
// Adaptador Microsoft OneDrive exercitado contra um DUPLO da camada HTTP.
//
// Sem Internet, sem credenciais reais e sem base de dados: a camada
// helpers/armazenamento/http é substituída por um duplo programável, mas o
// código exercitado é o VERDADEIRO adaptador (helpers/armazenamento/
// provedores/onedrive.js), a fachada (helpers/storage) e as ligações
// (helpers/armazenamento/ligacoes.js + cifra.js).
//
// Porque existe: nenhum teste offline tocava na Graph API — as pastas, o
// upload simples, o upload por sessões, a descarga, o streaming, a renovação
// de token e a remoção só eram exercitados contra a API real.
//
// Regras que este teste protege (se alguém as mudar, o teste falha):
//  · scope DELEGADO exato: offline_access Files.ReadWrite User.Read;
//  · a conta vem de `GET /me` e NUNCA é substituída pelo id do drive;
//  · fatias de 320 KiB no upload por sessões, com a última a fechar o ficheiro;
//  · o token nunca é enviado para o domínio de upload;
//  · 401 limpa os tokens; 403 não;
//  · `apagarArquivo` existe no OneDrive e o localizador `od:` chega lá;
//  · nomes inválidos para o OneDrive são saneados sem perder legibilidade;
//  · condomínio e plataforma são ligações separadas (desligar uma não toca na outra);
//  · `featureAtiva()` governa o `disponivel` da interface.
//
// Utilização: node scripts/test-onedrive-graph.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const { Op } = require('sequelize');

// ── Ambiente de teste ───────────────────────────────────────────────
// Chave de cifragem aleatória por execução: valida o caminho de cifra real
// sem reutilizar segredos. Nunca são credenciais verdadeiras.
process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
process.env.ONEDRIVE_ENABLED = 'true';
process.env.ONEDRIVE_CLIENT_ID = 'cliente-de-teste';
process.env.ONEDRIVE_CLIENT_SECRET = 'segredo-de-teste';
process.env.ONEDRIVE_REDIRECT_URI = 'https://gescondu.exemplo.pt/admin/config/armazenamento/onedrive/callback';
process.env.ONEDRIVE_TENANT = 'common';
// Os outros serviços ficam desligados: este teste não pode depender deles.
delete process.env.STORAGE_PROVIDER;

const CID = 1;

// ── Duplo da BD: configurações em memória ───────────────────────────
const loja = new Map();
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    Configuracao: {
      findAll: async ({ where } = {}) => {
        const like = where && where.chave && where.chave[Op.like];
        const prefixo = like ? String(like).replace(/%$/, '') : null;
        return [...loja.entries()]
          .filter(([chave]) => !prefixo || String(chave).startsWith(prefixo))
          .map(([chave, valor]) => ({ chave, valor }));
      },
      findOne: async ({ where }) => (loja.has(where.chave) ? { chave: where.chave, valor: loja.get(where.chave) } : null),
      findOrCreate: async ({ where, defaults }) => {
        if (!loja.has(where.chave)) loja.set(where.chave, defaults ? defaults.valor : null);
        return [{ valor: loja.get(where.chave), save: async () => {} }];
      },
    },
    Condominio: {
      findByPk: async (id) => ({ id: Number(id), designacao: 'Condomínio de Teste', estado: 'ativo' }),
      findOne: async () => null,
      update: async () => {},
    },
    Documento: { findOne: async () => null, findAll: async () => [], count: async () => 0 },
  },
};
const configPath = require.resolve('../helpers/config');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, defeito = null) => (loja.has(chave) ? loja.get(chave) : defeito),
    setConfig: async (chave, valor) => { loja.set(chave, valor); return { chave, valor }; },
  },
};

// ── Duplo da camada HTTP (substitui SÓ `pedir`) ─────────────────────
const httpPath = require.resolve('../helpers/armazenamento/http');
const httpReal = require(httpPath);

const chamadas = [];
const rotas = [];

// Programar uma resposta. `padrao` é testado contra o URL (string = «contém»).
function rota(metodo, padrao, resposta) {
  rotas.push({ metodo: String(metodo).toUpperCase(), padrao, resposta });
}
function limparRotas() { rotas.length = 0; }
function limparChamadas() { chamadas.length = 0; }

function normalizar(saida) {
  const status = Number(saida.status || 200);
  const dados = saida.dados === undefined ? null : saida.dados;
  const texto = saida.texto !== undefined ? saida.texto : (dados === null ? '' : JSON.stringify(dados));
  const resposta = { ok: status >= 200 && status < 300, status, headers: saida.headers || {}, texto, dados };
  if (saida.buffer) resposta.buffer = saida.buffer;
  return resposta;
}

async function pedirFalso(url, opcoes = {}) {
  const metodo = String(opcoes.method || 'GET').toUpperCase();
  chamadas.push({ metodo, url, opcoes });
  for (const r of rotas) {
    if (r.metodo !== metodo) continue;
    const alvo = typeof r.padrao === 'string' ? url.includes(r.padrao) : r.padrao.test(url);
    if (!alvo) continue;
    const saida = typeof r.resposta === 'function' ? r.resposta(url, opcoes) : r.resposta;
    if (saida instanceof Error) throw saida;
    return normalizar(saida);
  }
  // Um pedido não programado tem de rebentar: um teste que «passa» porque o
  // adaptador deixou de chamar o Graph seria um falso verde.
  throw new Error(`pedido não programado no duplo HTTP: ${metodo} ${url}`);
}
httpReal.pedir = pedirFalso;

// `abrirFluxo` usa o fetch global (streaming), não `http.pedir`.
function fluxoWeb(buffer) {
  return new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(buffer)); controller.close(); },
  });
}
const fetchReal = global.fetch;
let respostaFetch = null;
global.fetch = async (url, opcoes) => {
  chamadas.push({ metodo: String((opcoes && opcoes.method) || 'GET').toUpperCase(), url, opcoes, fetch: true });
  if (!respostaFetch) throw new Error(`fetch não programado: ${url}`);
  return respostaFetch(url, opcoes);
};

// ── Módulos REAIS em teste ──────────────────────────────────────────
const storage = require('../helpers/storage');
const ligacoes = require('../helpers/armazenamento/ligacoes');
const cifra = require('../helpers/armazenamento/cifra');
const locator = require('../helpers/armazenamento/locator');
const onedrive = require('../helpers/armazenamento/provedores/onedrive');

// ── Utilitários ─────────────────────────────────────────────────────
const GRAPH = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = '/oauth2/v2.0/token';

function resumo(c) {
  const u = new URL(c.url);
  return `${c.metodo} ${decodeURIComponent(u.pathname)}`;
}
function resumos(filtro = null) {
  return chamadas.filter((c) => (filtro ? filtro(c) : true)).map(resumo);
}
function pedidos(metodo, fragmento = null) {
  return chamadas.filter((c) => c.metodo === metodo && (!fragmento || c.url.includes(fragmento)));
}
function ultimoPedido(metodo, fragmento = null) {
  const l = pedidos(metodo, fragmento);
  return l[l.length - 1] || null;
}
async function lerFluxo(fluxo) {
  const partes = [];
  for await (const c of fluxo) partes.push(Buffer.from(c));
  return Buffer.concat(partes);
}
async function erroDe(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('esperava-se um erro, mas a operação concluiu com sucesso');
}

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');

// Reinicia o estado entre secções: loja, cache de ligações e chamadas.
async function reiniciar({ ligar = true } = {}) {
  loja.clear();
  ligacoes.limparCache();
  limparRotas();
  limparChamadas();
  respostaFetch = null;
  process.env.ONEDRIVE_ENABLED = 'true';
  if (ligar) {
    await ligacoes.guardarTokens('onedrive', CID, { access_token: 'AT-condominio', refresh_token: 'RT-condominio', expiry_date: Date.now() + 3600000, conta: 'condominio@exemplo.pt' });
    await ligacoes.guardarTokens('onedrive', null, { access_token: 'AT-plataforma', refresh_token: 'RT-plataforma', expiry_date: Date.now() + 3600000, conta: 'plataforma@exemplo.pt' });
    await ligacoes.definirPrincipal(CID, 'onedrive');
  }
}

// ── 1. Scope e URL de autorização (B1) ──────────────────────────────
function testarScopeEUrl() {
  assert.strictEqual(
    onedrive.SCOPE,
    'offline_access Files.ReadWrite User.Read',
    'o scope tem de ser exatamente o mínimo delegado (com User.Read, para identificar a conta)'
  );
  // Nada de permissões excessivas: `.All` e permissões de aplicação estão fora.
  assert.ok(!/\.All\b/.test(onedrive.SCOPE), 'o scope não pode conter permissões .All');
  assert.ok(!/Sites\.|Directory\.|User\.Read\.All/.test(onedrive.SCOPE), 'o scope não pode conter Sites.*/Directory.*/User.Read.All');

  const url = onedrive.urlAutorizacao({ redirectUri: 'https://gescondu.exemplo.pt/cb', state: 'abc', condominioId: CID });
  assert.ok(url.includes('scope=offline_access%20Files.ReadWrite%20User.Read'), `scope no URL de autorização (${url})`);
  assert.ok(!url.includes('Files.ReadWrite.All'), 'o URL não pede Files.ReadWrite.All');
  assert.ok(url.includes('prompt=select_account'), 'pede sempre a escolha da conta');
  assert.ok(url.includes('response_mode=query'), 'response_mode=query (o callback lê a query)');
  assert.ok(url.includes('state=abc'), 'preserva o state');
  assert.ok(url.includes('redirect_uri=https%3A%2F%2Fgescondu.exemplo.pt%2Fcb'), 'preserva o redirect_uri');
  assert.ok(url.includes('/common/oauth2/v2.0/authorize'), 'endpoint v2.0 com o tenant configurado');
}

// ── 2. Troca de código e identificação da conta (B1) ────────────────
async function testarTrocaDeCodigoEIdentificacao() {
  await reiniciar();
  rota('POST', TOKEN_URL, { dados: { access_token: 'AT-novo', refresh_token: 'RT-novo', expires_in: 3600 } });
  rota('GET', /\/me(\?|$)/, { dados: { userPrincipalName: 'utilizador@exemplo.pt', mail: null, displayName: 'Utilizador' } });

  const r = await onedrive.trocarCodigo({ code: 'CODIGO', redirectUri: 'https://gescondu.exemplo.pt/cb', condominioId: CID });
  assert.strictEqual(r.conta, 'utilizador@exemplo.pt', 'a conta vem do /me (userPrincipalName)');
  assert.strictEqual(r.contaErro, null, 'sem erro de identificação');

  // O scope pedido ao endpoint de tokens tem de ser o mesmo do URL de autorização.
  const pedidoToken = pedidos('POST', TOKEN_URL)[0];
  assert.strictEqual(pedidoToken.opcoes.form.scope, onedrive.SCOPE, 'scope pedido na troca de código');
  assert.strictEqual(pedidoToken.opcoes.form.grant_type, 'authorization_code', 'grant_type correto');
  assert.strictEqual(pedidoToken.opcoes.form.redirect_uri, 'https://gescondu.exemplo.pt/cb', 'redirect_uri enviado na troca');

  // `GET /me` pede exatamente os campos usados para identificar a conta.
  const pedidoMe = ultimoPedido('GET', '/me?');
  assert.ok(pedidoMe, 'GET /me foi chamado');
  assert.ok(decodeURIComponent(pedidoMe.url).includes('$select=userPrincipalName,mail,displayName'), `$select do /me (${decodeURIComponent(pedidoMe.url)})`);

  // Tokens guardados CIFRADOS e sem o access token em texto simples.
  const guardado = loja.get(ligacoes.chaveTokens('onedrive', CID));
  assert.ok(cifra.estaCifrado(guardado), 'credenciais cifradas em repouso');
  assert.ok(!String(guardado).includes('AT-novo'), 'o access token não fica em texto simples');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.conta, 'utilizador@exemplo.pt', 'conta na cache');
}

// Quando o /me falha, a ligação mantém-se mas a conta NÃO é inventada.
async function testarIdentificacaoFalhada() {
  // Sem ligação anterior: não existe conta nenhuma para preservar, logo o
  // resultado tem de ser `null` (e não o id do drive, nem um valor inventado).
  await reiniciar({ ligar: false });
  rota('POST', TOKEN_URL, { dados: { access_token: 'AT-sem-me', refresh_token: 'RT-sem-me', expires_in: 3600 } });
  // O padrão é um RegExp: `/me` como texto também «contém» `/me/drive` e a
  // rota do 403 engoliria o teste da ligação ao drive mais abaixo.
  rota('GET', /\/me(\?|$)/, { status: 403, dados: { error: { message: 'Insufficient privileges to complete the operation.' } } });

  const r = await onedrive.trocarCodigo({ code: 'CODIGO', redirectUri: 'https://gescondu.exemplo.pt/cb', condominioId: CID });
  assert.strictEqual(r.conta, null, 'sem conta identificada — nunca se inventa uma');
  assert.ok(r.contaErro, 'o motivo da falha é preservado (para a página o poder dizer)');
  assert.ok(!/AT-sem-me|RT-sem-me/.test(r.contaErro), 'o motivo não expõe tokens');
  // A ligação continua utilizável: os ficheiros não dependem da identificação.
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.access_token, 'AT-sem-me', 'ligação criada apesar da falha de identificação');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.conta, null, 'não fica nenhuma conta gravada');

  // Regressão: `testarLigacao` devolvia o ID DO DRIVE como se fosse a conta.
  rota('GET', '/me/drive', { dados: { id: 'b!ID-DO-DRIVE', driveType: 'personal' } });
  const teste = await onedrive.testarLigacao(CID);
  assert.strictEqual(teste.ok, true, 'a ligação ao drive funciona');
  assert.strictEqual(teste.conta, null, 'sem conta identificada, `conta` fica null');
  assert.notStrictEqual(teste.conta, 'b!ID-DO-DRIVE', 'o id do drive NUNCA é apresentado como conta');

  // Uma falha PONTUAL do /me não pode apagar uma conta já identificada: a
  // ligação anterior tinha conta conhecida e essa identificação é preservada
  // (nunca substituída pelo id do drive). A falha continua a ser reportada.
  await reiniciar(); // liga com conta conhecida: condominio@exemplo.pt
  rota('POST', TOKEN_URL, { dados: { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 } });
  rota('GET', /\/me(\?|$)/, { status: 403, dados: { error: { message: 'Insufficient privileges to complete the operation.' } } });
  const r2 = await onedrive.trocarCodigo({ code: 'CODIGO2', redirectUri: 'https://gescondu.exemplo.pt/cb', condominioId: CID });
  assert.strictEqual(r2.conta, 'condominio@exemplo.pt', 'a conta já conhecida é preservada quando o /me falha');
  assert.notStrictEqual(r2.conta, 'b!ID-DO-DRIVE', 'e nunca passa a ser o id do drive');
  assert.ok(r2.contaErro, 'a falha continua a ser reportada, mesmo preservando a conta');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.access_token, 'AT-2', 'os tokens novos ficam gravados');
}

// ── 3. Criação de pastas: idempotência e 409 ────────────────────────
async function testarCriacaoDePastas() {
  await reiniciar();
  // Nenhuma pasta existe: metadados 404 e a criação devolve o item criado.
  rota('GET', '/me/drive/root:', { status: 404 });
  rota('POST', '/children', { dados: { id: 'PASTA', name: 'criada' } });

  const caminho = await onedrive.garantirPasta('/GesCondu/Condomínio de Teste', CID);
  assert.strictEqual(caminho, '/GesCondu/Condomínio de Teste', 'devolve o caminho normalizado');

  const criacoes = pedidos('POST', '/children');
  assert.strictEqual(criacoes.length, 2, 'cria um segmento de cada vez (2 segmentos)');
  assert.deepStrictEqual(
    criacoes.map((c) => c.opcoes.json.name),
    ['GesCondu', 'Condomínio de Teste'],
    'os nomes criados vêm dos segmentos, pela ordem da hierarquia'
  );
  assert.deepStrictEqual(criacoes[0].opcoes.json.folder, {}, 'cria uma PASTA (folder vazio)');
  assert.strictEqual(criacoes[0].opcoes.json['@microsoft.graph.conflictBehavior'], 'fail', 'conflictBehavior fail (409 = já existe)');
  assert.ok(criacoes[0].url.includes('/me/drive/root/children'), 'primeiro segmento é filho da raiz do drive');
  assert.ok(decodeURIComponent(criacoes[1].url).includes('/me/drive/root:/GesCondu:/children'), 'segmentos seguintes são filhos do pai anterior');
  assert.ok(decodeURIComponent(criacoes[0].url).includes('$select=id,name'), 'pede só os campos necessários');

  // Uma pasta que já existe não é criada outra vez (metadados respondem).
  await reiniciar();
  limparRotas();
  rota('GET', '/me/drive/root:', { dados: { id: 'PASTA', name: 'GesCondu' } });
  rota('POST', '/children', { dados: { id: 'PASTA' } });
  const caminho2 = await onedrive.garantirPasta('/GesCondu/Condomínio de Teste', CID);
  assert.strictEqual(caminho2, '/GesCondu/Condomínio de Teste', 'caminho devolvido quando já existe');
  assert.strictEqual(pedidos('POST', '/children').length, 0, 'não cria nada quando os metadados confirmam que existe');

  // 409 = a pasta foi criada entretanto por outro pedido → sucesso (idempotente).
  await reiniciar();
  limparRotas();
  rota('GET', '/me/drive/root:', { status: 404 });
  rota('POST', '/children', { status: 409, dados: { error: { message: 'The resource already exists.' } } });
  const caminho3 = await onedrive.garantirPasta('/GesCondu', CID);
  assert.strictEqual(caminho3, '/GesCondu', 'um 409 é sucesso (a pasta já existe)');
}

// ── 4. Upload simples (≤ 4 MB) ──────────────────────────────────────
async function testarUploadSimples() {
  await reiniciar();
  const pasta = '/GesCondu/Condomínio de Teste/2026/Recibos';
  rota('PUT', '/content', { dados: { id: 'FILE-SIMPLES', size: 1234 } });

  const r = await onedrive.uploadArquivo({ nome: 'recibo.pdf', mimeType: 'application/pdf', buffer: PDF, parentFolderId: pasta, condominioId: CID });
  assert.strictEqual(r.provedorFileId, 'FILE-SIMPLES', 'devolve o id do driveItem');
  assert.strictEqual(r.localizador, 'FILE-SIMPLES', 'o adaptador devolve o id em bruto (o prefixo é da fachada)');
  assert.strictEqual(r.tamanho, 1234, 'tamanho do item devolvido pelo Graph');
  assert.strictEqual(r.pastaId, pasta, 'pasta-mãe devolvida');
  assert.strictEqual(r.url, null, 'nunca cria links (invariante do contrato)');

  const put = ultimoPedido('PUT', '/content');
  assert.ok(decodeURIComponent(put.url).includes(`${pasta}/recibo.pdf:/content`), `endereçamento por caminho (${decodeURIComponent(put.url)})`);
  assert.strictEqual(put.opcoes.headers['Content-Type'], 'application/pdf', 'Content-Type do ficheiro');
  assert.strictEqual(put.opcoes.body, PDF, 'envia o buffer tal e qual');
  assert.ok(put.url.startsWith(GRAPH), 'upload simples vai para o domínio do Graph');

  // A fachada acrescenta o prefixo `od:` no ponto único.
  const viaFachada = await storage.uploadArquivo({ nome: 'recibo.pdf', mimeType: 'application/pdf', buffer: PDF, parentFolderId: pasta, condominioId: CID });
  assert.strictEqual(viaFachada.localizador, 'od:FILE-SIMPLES', 'a fachada monta o localizador od:');
}

// ── 5. Upload por sessões (fatias de 320 KiB) ───────────────────────
async function testarUploadPorSessoes() {
  await reiniciar();
  const pasta = '/GesCondu/Condomínio de Teste/2026/Outros';
  const URL_SESSAO = 'https://upload.exemplo.pt/sessao/ABC';
  const total = onedrive.LIMITE_UPLOAD_SIMPLES + 1; // 1 byte acima do limite simples
  const grande = Buffer.alloc(total, 7);

  rota('POST', '/createUploadSession', { dados: { uploadUrl: URL_SESSAO } });
  rota('PUT', URL_SESSAO, { dados: { id: 'FILE-GRANDE', size: total } });

  const r = await onedrive.uploadArquivo({ nome: 'backup_manual_2026.sql.gz', mimeType: 'application/gzip', buffer: grande, parentFolderId: pasta, condominioId: CID });
  assert.strictEqual(r.provedorFileId, 'FILE-GRANDE', 'id do ficheiro enviado por sessões');

  const inicio = ultimoPedido('POST', '/createUploadSession');
  assert.ok(decodeURIComponent(inicio.url).includes(`${pasta}/backup_manual_2026.sql.gz:/createUploadSession`), 'sessão criada por caminho');
  assert.strictEqual(inicio.opcoes.json.item['@microsoft.graph.conflictBehavior'], 'replace', 'substitui o ficheiro existente');
  assert.strictEqual(inicio.opcoes.json.item.name, 'backup_manual_2026.sql.gz', 'nome do item na sessão');

  const fatias = pedidos('PUT', URL_SESSAO);
  assert.ok(fatias.length > 1, 'o ficheiro é enviado em várias fatias');
  // Requisito da Microsoft: cada fatia tem de ser múltipla de 320 KiB.
  assert.strictEqual(onedrive.TAMANHO_FATIA, 320 * 1024, 'tamanho da fatia é 320 KiB (múltiplo exigido pelo Graph)');
  for (const f of fatias.slice(0, -1)) {
    assert.strictEqual(Number(f.opcoes.headers['Content-Length']), 320 * 1024, 'todas as fatias menos a última têm exatamente 320 KiB');
  }
  // Content-Range sequencial e coerente com o corpo enviado.
  let esperado = 0;
  for (const f of fatias) {
    const cr = f.opcoes.headers['Content-Range'];
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    assert.ok(m, `Content-Range no formato do Graph (${cr})`);
    assert.strictEqual(Number(m[1]), esperado, `início da fatia continua onde a anterior acabou (${cr})`);
    assert.strictEqual(Number(m[3]), total, `total correto em cada fatia (${cr})`);
    assert.strictEqual(Number(f.opcoes.headers['Content-Length']), f.opcoes.body.length, `Content-Length = bytes enviados (${cr})`);
    esperado = Number(m[2]) + 1;
  }
  // A última fatia fecha exatamente o ficheiro: não sobra nada por enviar.
  const ultima = fatias[fatias.length - 1];
  assert.strictEqual(Number(/^bytes (\d+)-(\d+)\//.exec(ultima.opcoes.headers['Content-Range'])[2]), total - 1, 'a última fatia termina no último byte do ficheiro');
  assert.strictEqual(esperado, total, 'todas as fatias cobrem o ficheiro sem falhas nem sobreposições');
  // Consequência: o pedido final de comprimento ZERO («bytes */total») nunca é
  // emitido — o último fragmento já fecha a sessão. Se o algoritmo mudar, isto
  // falha e obriga a uma decisão consciente (ver relatório da auditoria).
  assert.ok(
    !fatias.some((f) => /bytes \*\//.test(String(f.opcoes.headers['Content-Range']))),
    'nenhum pedido final de comprimento zero (a última fatia fecha a sessão)'
  );
  assert.ok(!chamadas.some((c) => c.opcoes && c.opcoes.headers && c.opcoes.headers['Content-Length'] === '0'), 'não envia pedidos de comprimento zero');

  // Segurança: o URL da sessão é pré-autenticado — o token NUNCA é reenviado.
  for (const f of fatias) {
    assert.strictEqual(f.opcoes.headers.Authorization, undefined, 'as fatias não levam Authorization (URL pré-autenticado)');
  }
}

// ── 6. Descarga e streaming ─────────────────────────────────────────
async function testarDescargaEStreaming() {
  await reiniciar();
  rota('GET', '/me/drive/items/FILE-1/content', { buffer: PDF, status: 200 });

  const descarregado = await onedrive.descarregarArquivo('FILE-1', CID);
  assert.strictEqual(Buffer.compare(descarregado, PDF), 0, 'a descarga devolve o conteúdo do ficheiro');
  const pedido = ultimoPedido('GET', '/me/drive/items/FILE-1/content');
  assert.strictEqual(pedido.opcoes.binario, true, 'a descarga pede o corpo em binário');

  // Streaming: caminho usado para servir o documento ao utilizador.
  respostaFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(PDF.length) : null) },
    body: fluxoWeb(PDF),
  });
  const abertura = await onedrive.abrirFluxo('FILE-1', CID);
  assert.strictEqual(abertura.tamanho, PDF.length, 'tamanho do stream vem do content-length');
  assert.strictEqual(Buffer.compare(await lerFluxo(abertura.fluxo), PDF), 0, 'o stream devolve o ficheiro inteiro');
  const pedidoStream = chamadas.filter((c) => c.fetch)[0];
  assert.strictEqual(pedidoStream.opcoes.headers.Authorization, 'Bearer AT-condominio', 'o streaming usa o access token do condomínio');
  assert.strictEqual(pedidoStream.opcoes.redirect, 'follow', 'segue o 302 para o URL pré-autenticado do conteúdo');
}

// ── 7. 401 limpa os tokens; 403 não ─────────────────────────────────
async function testarErros401e403() {
  // 401: token inválido/revogado → limpa as credenciais e aponta à Configuração.
  await reiniciar();
  rota('GET', '/me/drive/root:', { status: 401, dados: { error: { message: 'InvalidAuthenticationToken' } } });
  const e401 = await erroDe(() => onedrive.garantirPasta('/GesCondu', CID));
  assert.ok(/expirou ou foi revogada/i.test(e401.message), `401 explica que a ligação expirou (${e401.message})`);
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens, null, '401 remove as credenciais do condomínio');
  assert.strictEqual(loja.get(ligacoes.chaveTokens('onedrive', CID)), null, '401 limpa também a BD');
  // A ligação de plataforma é OUTRA ligação: um 401 do condomínio não a apaga.
  assert.ok(ligacoes.tokensSync('onedrive', null, { plataforma: true }).tokens, '401 do condomínio não afeta a plataforma');

  // 403: falta de permissão → NÃO limpa nada (a ligação continua válida).
  await reiniciar();
  rota('GET', '/me/drive/root:', { status: 403, dados: { error: { message: 'Access denied' } } });
  const e403 = await erroDe(() => onedrive.garantirPasta('/GesCondu', CID));
  assert.ok(/Sem permissão/i.test(e403.message), `403 explica a falta de permissão (${e403.message})`);
  assert.ok(/Configuração/i.test(e403.message), '403 aponta onde resolver');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.access_token, 'AT-condominio', '403 NÃO remove as credenciais');

  // 401 no streaming também limpa as credenciais.
  await reiniciar();
  respostaFetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => '{}' });
  const eStream = await erroDe(() => onedrive.abrirFluxo('FILE-1', CID));
  assert.ok(/expirou ou foi revogada/i.test(eStream.message), '401 no streaming explica a expiração');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens, null, '401 no streaming limpa as credenciais');
}

// ── 8. Remoção: apagarArquivo e a retenção de backups (B2) ──────────
async function testarApagarArquivo() {
  await reiniciar();
  rota('DELETE', '/me/drive/items/FILE-1', { status: 204 });

  const ok = await onedrive.apagarArquivo('FILE-1', CID);
  assert.strictEqual(ok, true, 'apagarArquivo devolve true');
  const pedido = ultimoPedido('DELETE', '/me/drive/items/FILE-1');
  assert.ok(pedido, 'emite DELETE /me/drive/items/{id}');
  assert.ok(pedido.url.startsWith(GRAPH), 'a remoção vai para o domínio do Graph');
  assert.strictEqual(pedido.opcoes.headers.Authorization, 'Bearer AT-condominio', 'a remoção usa o access token do condomínio');

  // Idempotente: um 404 significa que já não existe — a remoção está feita.
  limparRotas();
  rota('DELETE', '/me/drive/items/SUMIDO', { status: 404, dados: { error: { message: 'itemNotFound' } } });
  assert.strictEqual(await onedrive.apagarArquivo('SUMIDO', CID), true, '404 é tratado como «já removido»');

  // Um erro real do fornecedor propaga-se (não é engolido).
  limparRotas();
  rota('DELETE', '/me/drive/items/ERRO', { status: 500, dados: { error: { message: 'generalException' } } });
  const e = await erroDe(() => onedrive.apagarArquivo('ERRO', CID));
  assert.ok(/Microsoft OneDrive/i.test(e.message), `erro do fornecedor propagado (${e.message})`);
  assert.strictEqual(e.status, 500, 'o status do fornecedor é preservado');

  // Sem id não há pedido: falha cedo e de forma legível.
  const semId = await erroDe(() => onedrive.apagarArquivo('', CID));
  assert.ok(/fileId é obrigatório/i.test(semId.message), 'fileId obrigatório');

  // A RETENÇÃO de backups passa a funcionar: a fachada resolve o localizador
  // `od:` e chega ao adaptador (jobs/backup.js usa exatamente este caminho).
  limparRotas();
  limparChamadas();
  rota('DELETE', '/me/drive/items/FILE-RETENCAO', { status: 204 });
  assert.strictEqual(await storage.apagarArquivo('od:FILE-RETENCAO', CID), true, 'storage.apagarArquivo funciona com um localizador od:');
  assert.ok(ultimoPedido('DELETE', '/me/drive/items/FILE-RETENCAO'), 'a remoção chegou ao Graph com o id do localizador');
  assert.ok(!/od:/.test(ultimoPedido('DELETE').url), 'o prefixo od: não vai para o Graph (é da fachada)');

  // O Dropbox passou a ter remoção (P25): a fachada deixa de degradar para
  // `false` e chega ao adaptador. Sem ligação Dropbox configurada neste teste,
  // o adaptador falha de forma legível — é essa a prova de que a capacidade
  // está ligada. Antes da P25 esta chamada devolvia `false` sem exceção.
  const semLigacaoDropbox = await erroDe(() => storage.apagarArquivo('dbx:id:abc', CID));
  assert.ok(/Dropbox não está ligado/i.test(semLigacaoDropbox.message), `o Dropbox deixou de ser um no-op na retenção (${semLigacaoDropbox.message})`);
}

// ── 9. Localizadores od: na fachada ─────────────────────────────────
async function testarLocalizadores() {
  await reiniciar();
  assert.deepStrictEqual(locator.ler('od:FILE-1'), { provedor: 'onedrive', id: 'FILE-1' }, 'od: resolve para onedrive');
  assert.strictEqual(locator.montar('onedrive', 'FILE-1'), 'od:FILE-1', 'montar acrescenta o prefixo');
  assert.strictEqual(storage.montarLocalizador('onedrive', 'X'), 'od:X', 'a fachada monta o localizador');
  assert.strictEqual(storage.lerLocalizador('od:X').provedor, 'onedrive', 'a fachada lê o localizador');

  // A leitura é decidida pelo LOCALIZADOR, não pelo principal do condomínio.
  rota('GET', '/me/drive/items/FILE-OD/content', { buffer: PDF, status: 200 });
  const viaFachada = await storage.descargarArquivo('od:FILE-OD', CID);
  assert.strictEqual(Buffer.compare(viaFachada, PDF), 0, 'a descarga por localizador od: chega ao OneDrive');
  assert.ok(ultimoPedido('GET', '/me/drive/items/FILE-OD/content'), 'o id enviado ao Graph não tem o prefixo');
}

// ── 10. Sanitização de nomes (B5) ───────────────────────────────────
async function nomesCriados(caminhos) {
  await reiniciar();
  limparRotas();
  rota('GET', '/me/drive/root:', { status: 404 });
  rota('POST', '/children', { dados: { id: 'PASTA' } });
  const nomes = [];
  for (const c of caminhos) {
    limparChamadas();
    await onedrive.garantirPasta(c, CID);
    nomes.push(...pedidos('POST', '/children').map((x) => x.opcoes.json.name));
  }
  return nomes;
}

async function testarSanitizacaoDeNomes() {
  // Caracteres proibidos pelo OneDrive → `-`, mantendo o nome legível.
  assert.deepStrictEqual(
    await nomesCriados(['/GesCondu/Ata: 2026?']),
    ['GesCondu', 'Ata- 2026-'],
    'caracteres proibidos ( : ? ) são substituídos'
  );
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/A*B"C<D>E|F']), ['GesCondu', 'A-B-C-D-E-F'], 'todos os proibidos são tratados');

  // Controlos, pontos e espaços finais.
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/Ata\u0001de 2026 ']), ['GesCondu', 'Ata de 2026'], 'controlos e espaços finais removidos');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/Relatório 2026.']), ['GesCondu', 'Relatório 2026'], 'ponto final removido');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/...']), ['GesCondu'], 'um segmento que fica vazio é descartado');

  // Nomes reservados ganham um `_` à frente (não são descartados).
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/NUL']), ['GesCondu', '_NUL'], 'NUL é reservado');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/com1']), ['GesCondu', '_com1'], 'COM1 é reservado (sem distinguir maiúsculas)');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/LPT9']), ['GesCondu', '_LPT9'], 'LPT9 é reservado');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/desktop.ini']), ['GesCondu', '_desktop.ini'], 'desktop.ini é reservado');

  // Nomes normais NÃO são tocados (sem colisões nem prefixos desnecessários).
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/Assembleia 2026']), ['GesCondu', 'Assembleia 2026'], 'nome normal inalterado');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/Quotas']), ['GesCondu', 'Quotas'], 'pasta padrão inalterada');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/CONDOMÍNIO']), ['GesCondu', 'CONDOMÍNIO'], 'nomes que começam por CON mas não são reservados ficam iguais');
  assert.deepStrictEqual(await nomesCriados(['/GesCondu/Recibos 2026']), ['GesCondu', 'Recibos 2026'], 'nome com número inalterado');

  // Regressão: a raiz configurada chega como caminho ('/GesCondu') e tem de
  // continuar a dar 'GesCondu' — nunca '-GesCondu'.
  assert.deepStrictEqual(await nomesCriados(['/GesCondu']), ['GesCondu'], 'a barra inicial não contamina o nome da raiz');

  // Ficheiros: mesmo tratamento no nome enviado ao Graph.
  await reiniciar();
  limparRotas();
  rota('PUT', '/content', { dados: { id: 'F', size: PDF.length } });
  await onedrive.uploadArquivo({ nome: 'CON.pdf', mimeType: 'application/pdf', buffer: PDF, parentFolderId: '/GesCondu/2026/Recibos', condominioId: CID });
  assert.ok(decodeURIComponent(ultimoPedido('PUT', '/content').url).endsWith('/_CON.pdf:/content'), 'nome de ficheiro reservado é prefixado');
  limparChamadas();
  await onedrive.uploadArquivo({ nome: 'recibo: final?.pdf', mimeType: 'application/pdf', buffer: PDF, parentFolderId: '/GesCondu/2026/Recibos', condominioId: CID });
  assert.ok(decodeURIComponent(ultimoPedido('PUT', '/content').url).endsWith('/recibo- final-.pdf:/content'), 'nome de ficheiro com caracteres proibidos é saneado');
}

// ── 11. Isolamento condomínio/plataforma e desligar (B7) ────────────
async function testarIsolamentoEDesligar() {
  await reiniciar();
  const chaveCondominio = ligacoes.chaveTokens('onedrive', CID);
  const chavePlataforma = ligacoes.chaveTokensPlataforma('onedrive');
  assert.notStrictEqual(chaveCondominio, chavePlataforma, 'as chaves de configuração são distintas');
  assert.notStrictEqual(loja.get(chaveCondominio), loja.get(chavePlataforma), 'os valores cifrados são distintos');
  assert.ok(cifra.estaCifrado(loja.get(chavePlataforma)), 'a ligação de plataforma também está cifrada');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.access_token, 'AT-condominio', 'o condomínio usa a sua conta');
  assert.strictEqual(ligacoes.tokensSync('onedrive', null, { plataforma: true }).tokens.access_token, 'AT-plataforma', 'a plataforma usa a sua conta');
  // Só o Google Drive admite a conta da plataforma como fallback dos documentos.
  assert.strictEqual(ligacoes.tokensSync('onedrive', 99).tokens, null, 'um condomínio sem ligação NÃO herda a conta da plataforma');

  // Desligar o condomínio remove só a ligação do condomínio.
  await onedrive.desligar(CID);
  assert.strictEqual(loja.get(chaveCondominio), null, 'ligação do condomínio removida');
  assert.ok(loja.get(chavePlataforma), 'ligação da plataforma preservada');
  assert.strictEqual(ligacoes.tokensSync('onedrive', null, { plataforma: true }).tokens.access_token, 'AT-plataforma', 'plataforma intacta na cache');

  // Desligar a plataforma exige âmbito explícito.
  const semAmbito = await erroDe(() => onedrive.desligar(null));
  assert.ok(/condominioId é obrigatório/i.test(semAmbito.message), 'desligar sem âmbito é recusado');
  assert.ok(loja.get(chavePlataforma), 'a tentativa sem âmbito não apagou a ligação da plataforma');

  // Com âmbito explícito, remove a plataforma.
  await onedrive.desligar(null, { plataforma: true });
  assert.strictEqual(loja.get(chavePlataforma), null, 'ligação da plataforma removida com âmbito explícito');

  // `opcoes.plataforma` manda sobre o condominioId: mesmo com um id indicado,
  // o alvo é a plataforma (e o condomínio fica intacto).
  await reiniciar();
  await onedrive.desligar(CID, { plataforma: true });
  assert.strictEqual(loja.get(chavePlataforma), null, 'opcoes.plataforma prevalece sobre o condominioId');
  assert.ok(loja.get(chaveCondominio), 'o condomínio não foi tocado');

  // Desligar nunca apaga ficheiros: nenhum DELETE é emitido.
  limparChamadas();
  await onedrive.desligar(CID);
  assert.strictEqual(pedidos('DELETE').length, 0, 'desligar não emite nenhum DELETE no fornecedor');
}

// ── 12. featureAtiva() e disponivel() na interface (B4) ─────────────
async function testarFeatureAtivaEDisponivel() {
  await reiniciar();
  const antes = await storage.estadoDoCondominio(CID);
  const onedriveAntes = antes.provedores.find((p) => p.nome === 'onedrive');
  const outrosAntes = antes.provedores.filter((p) => p.nome !== 'onedrive').map((p) => `${p.nome}:${p.disponivel}`);
  assert.strictEqual(onedriveAntes.disponivel, true, 'com ONEDRIVE_ENABLED=true o serviço está disponível');
  assert.strictEqual(onedriveAntes.ligado, true, 'a ligação do condomínio é reconhecida');

  // Desligar o feature: o serviço deixa de estar disponível E deixa de operar.
  process.env.ONEDRIVE_ENABLED = 'false';
  assert.strictEqual(onedrive.featureAtiva(), false, 'featureAtiva() reflete a configuração');
  assert.strictEqual(onedrive.isConfigured(CID), false, 'sem feature ativa não há ligação utilizável');
  const durante = await storage.estadoDoCondominio(CID);
  const onedriveDurante = durante.provedores.find((p) => p.nome === 'onedrive');
  assert.strictEqual(onedriveDurante.disponivel, false, 'sem feature ativa o serviço NÃO aparece como disponível para ligar');
  assert.strictEqual(
    durante.provedores.filter((p) => p.nome !== 'onedrive').map((p) => `${p.nome}:${p.disponivel}`).join(','),
    outrosAntes.join(','),
    'a disponibilidade dos OUTROS serviços não é afetada'
  );
  // O mesmo vale para a lista usada pela ligação de plataforma (backups).
  const plataformaDurante = durante.plataforma.find((p) => p.nome === 'onedrive');
  assert.strictEqual(plataformaDurante.disponivel, false, 'a ligação de plataforma também respeita o feature');

  // Sem credenciais técnicas, também não está disponível.
  process.env.ONEDRIVE_ENABLED = 'true';
  const segredo = process.env.ONEDRIVE_CLIENT_SECRET;
  delete process.env.ONEDRIVE_CLIENT_SECRET;
  assert.strictEqual((await storage.estadoDoCondominio(CID)).provedores.find((p) => p.nome === 'onedrive').disponivel, false, 'sem credenciais não está disponível');
  process.env.ONEDRIVE_CLIENT_SECRET = segredo;
}

// ── 13. Renovação automática do token ───────────────────────────────
async function testarRenovacao() {
  await reiniciar();
  // Força a expiração da ligação do condomínio.
  const atuais = ligacoes.tokensSync('onedrive', CID).tokens;
  await ligacoes.guardarTokens('onedrive', CID, { ...atuais, expiry_date: Date.now() - 60000 });

  rota('POST', TOKEN_URL, { dados: { access_token: 'AT-renovado', refresh_token: 'RT-renovado', expires_in: 3600 } });
  rota('GET', '/me/drive/items/FILE-1/content', { buffer: PDF, status: 200 });

  const r = await onedrive.descarregarArquivo('FILE-1', CID);
  assert.strictEqual(Buffer.compare(r, PDF), 0, 'a operação conclui após renovar');

  const pedido = pedidos('POST', TOKEN_URL)[0];
  assert.strictEqual(pedido.opcoes.form.grant_type, 'refresh_token', 'renova com grant_type=refresh_token');
  assert.strictEqual(pedido.opcoes.form.refresh_token, 'RT-condominio', 'usa o refresh token guardado');
  assert.strictEqual(pedido.opcoes.form.scope, onedrive.SCOPE, 'a renovação pede o mesmo scope');
  assert.ok(!pedido.opcoes.form.client_secret.includes('AT-'), 'o client secret é o da aplicação, não um token');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.access_token, 'AT-renovado', 'access token novo em cache');
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens.refresh_token, 'RT-renovado', 'refresh token rotacionado e guardado');
  assert.strictEqual(ultimoPedido('GET', '/me/drive/items/FILE-1/content').opcoes.headers.Authorization, 'Bearer AT-renovado', 'a operação usa o token renovado');
  assert.ok(cifra.estaCifrado(loja.get(ligacoes.chaveTokens('onedrive', CID))), 'os tokens renovados continuam cifrados');

  // Autorização revogada no fornecedor: limpa e explica.
  await reiniciar();
  const t2 = ligacoes.tokensSync('onedrive', CID).tokens;
  await ligacoes.guardarTokens('onedrive', CID, { ...t2, expiry_date: Date.now() - 60000 });
  rota('POST', TOKEN_URL, { status: 400, dados: { error: 'invalid_grant', error_description: 'AADSTS70000: The grant is expired or revoked.' } });
  const e = await erroDe(() => onedrive.descarregarArquivo('FILE-1', CID));
  assert.ok(/expirou ou foi revogada/i.test(e.message), `invalid_grant explica a revogação (${e.message})`);
  assert.strictEqual(ligacoes.tokensSync('onedrive', CID).tokens, null, 'invalid_grant limpa as credenciais');
}

// ── Execução ────────────────────────────────────────────────────────
const SECOES = [
  ['scope e URL de autorização (B1)', testarScopeEUrl],
  ['troca de código e identificação da conta (B1)', testarTrocaDeCodigoEIdentificacao],
  ['identificação falhada não inventa conta (B1)', testarIdentificacaoFalhada],
  ['criação de pastas e idempotência', testarCriacaoDePastas],
  ['upload simples', testarUploadSimples],
  ['upload por sessões (fatias de 320 KiB)', testarUploadPorSessoes],
  ['descarga e streaming', testarDescargaEStreaming],
  ['401 limpa os tokens; 403 não', testarErros401e403],
  ['apagarArquivo e retenção de backups (B2)', testarApagarArquivo],
  ['localizadores od: na fachada', testarLocalizadores],
  ['sanitização de nomes (B5)', testarSanitizacaoDeNomes],
  ['isolamento condomínio/plataforma e desligar (B7)', testarIsolamentoEDesligar],
  ['featureAtiva() e disponivel() (B4)', testarFeatureAtivaEDisponivel],
  ['renovação automática do token', testarRenovacao],
];

async function main() {
  let falhas = 0;
  for (const [nome, fn] of SECOES) {
    try {
      await fn();
      console.log(`  ✓ ${nome}`);
    } catch (err) {
      falhas++;
      console.log(`  ✗ ${nome}`);
      console.log(`      ${err && err.message}`);
    }
  }
  global.fetch = fetchReal;
  if (falhas) {
    console.log(`\n✗ ${falhas} secção(ões) falharam.`);
    process.exit(1);
  }
  console.log(`\n✓ Testes do adaptador OneDrive (duplo da Graph API) passaram — ${SECOES.length} secções.`);
}

main().catch((err) => {
  global.fetch = fetchReal;
  console.error('✗ Falha inesperada:', err);
  process.exit(1);
});
