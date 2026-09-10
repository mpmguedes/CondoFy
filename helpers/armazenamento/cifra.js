// ─────────────────────────────────────────────────────────────────────
// Cifragem de credenciais em repouso (ponto ÚNICO do projeto).
//
// Os tokens OAuth de armazenamento (Google Drive, Dropbox, OneDrive) nunca
// são guardados em texto simples na tabela `configuracoes`. Este módulo é a
// única implementação criptográfica do GesCondu: as restantes camadas
// (helpers/armazenamento/ligacoes.js e quem delega nela) só chamam
// `cifrar`/`decifrar` e nunca precisam de saber se o valor está cifrado.
//
// Algoritmo: AES-256-GCM (authenticated encryption), nonce novo por cada
// cifragem, com a chave da instalação em ENCRYPTION_KEY.
//
// Formato gravado (versionado, autodescritivo):
//
//   enc:v1:<kid>:<iv>:<tag>:<ciphertext>
//
//   enc    prefixo que identifica um valor cifrado (nunca colide com o JSON
//          antigo, que começa por '{')
//   v1     versão do formato — permite mudar de algoritmo sem perder os
//          valores existentes
//   kid    identificador curto da chave usada (impressão SHA-256 da chave),
//          para permitir ROTAÇÃO: decifrar com a chave antiga
//          (ENCRYPTION_KEY_OLD) e voltar a cifrar com a nova
//   iv     nonce de 12 bytes (base64url), aleatório por valor
//   tag    authentication tag de 16 bytes (base64url)
//   ct     ciphertext (base64url)
//
// O contexto (nome da chave na tabela `configuracoes`) é usado como dados
// autenticados adicionais (AAD): um valor copiado para outra chave — por
// exemplo de um condomínio para outro — deixa de decifrar. Reforça o
// isolamento multi-tenant mesmo contra alterações diretas na base de dados.
//
// Nunca são registados em log a chave, os tokens ou o ciphertext.
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const PREFIXO = 'enc';
const VERSAO = 'v1';
const ALGORITMO = 'aes-256-gcm';
const BYTES_CHAVE = 32; // AES-256
const BYTES_IV = 12; // recomendado para GCM
const BYTES_TAG = 16;

// Erro próprio, com código e mensagem administrativa (sem qualquer segredo).
class ErroCifra extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroCifra';
    this.codigo = codigo;
  }
}

const MENSAGENS = {
  sem_chave:
    'A chave de cifragem das credenciais (ENCRYPTION_KEY) não está configurada nesta instalação. ' +
    'As ligações de armazenamento ficam indisponíveis até o administrador do GesCondu a configurar.',
  chave_invalida:
    'A chave de cifragem das credenciais (ENCRYPTION_KEY) não é válida: são necessários 32 bytes ' +
    '(por exemplo em base64) gerados aleatoriamente.',
  autenticacao:
    'Não foi possível decifrar as credenciais guardadas (chave diferente ou valor alterado). ' +
    'Volte a ligar o serviço de armazenamento em Configurações → Armazenamento e Backups.',
  formato: 'As credenciais guardadas estão num formato não reconhecido.',
};

function erro(codigo) {
  return new ErroCifra(codigo, MENSAGENS[codigo]);
}

// ── Chave da instalação ─────────────────────────────────────────────
// Aceita base64 (44 caracteres → 32 bytes) ou hexadecimal (64 caracteres).
// Não existe chave por omissão: sem ENCRYPTION_KEY não se cifra nada.
function interpretarChave(valor) {
  const texto = String(valor == null ? '' : valor).trim();
  if (!texto) return null;

  const tentar = (buf) => (buf && buf.length === BYTES_CHAVE ? buf : null);
  if (/^[0-9a-fA-F]{64}$/.test(texto)) return tentar(Buffer.from(texto, 'hex'));
  const b64 = tentar(Buffer.from(texto, 'base64'));
  if (b64) return b64;
  // Chaves curtas/frases-passe não são aceites: exigimos entropia real.
  throw erro('chave_invalida');
}

function lerChaveAtual() {
  return interpretarChave(process.env.ENCRYPTION_KEY);
}

// Chaves anteriores (rotação): ENCRYPTION_KEY_OLD, uma ou várias separadas
// por vírgula. Só servem para DECIFRAR valores antigos.
function lerChavesAnteriores() {
  const bruto = String(process.env.ENCRYPTION_KEY_OLD || '');
  return bruto
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => interpretarChave(s))
    .filter(Boolean);
}

// Impressão curta da chave (nunca a chave): identifica qual foi usada.
function identificador(chave) {
  return crypto.createHash('sha256').update(chave).digest('base64url').slice(0, 6);
}

// Mapa kid → chave (atual com prioridade sobre as anteriores).
function mapaDeChaves() {
  const mapa = new Map();
  for (const chave of lerChavesAnteriores()) mapa.set(identificador(chave), chave);
  const atual = lerChaveAtual();
  if (atual) mapa.set(identificador(atual), atual);
  return mapa;
}

// Estado para a interface/verificações administrativas (sem segredos).
function estado() {
  let configurada = false;
  let kid = null;
  let erroChave = null;
  try {
    const atual = lerChaveAtual();
    configurada = Boolean(atual);
    kid = atual ? identificador(atual) : null;
  } catch (err) {
    erroChave = err.message;
  }
  return {
    configurada,
    kid,
    formato: `${PREFIXO}:${VERSAO}`,
    algoritmo: 'AES-256-GCM',
    anteriores: lerChavesAnteriores().length,
    erro: erroChave,
    mensagem: configurada ? null : MENSAGENS.sem_chave,
  };
}

// ── Cifrar / decifrar ───────────────────────────────────────────────
function estaCifrado(valor) {
  return typeof valor === 'string' && valor.startsWith(`${PREFIXO}:${VERSAO}:`);
}

// Devolve true quando o valor cifrado não usou a chave ATUAL (candidato a
// recifragem depois de uma rotação de chave).
function precisaRecifrar(valor) {
  if (!estaCifrado(valor)) return false;
  const partes = String(valor).split(':');
  const kid = partes[2];
  const atual = lerChaveAtual();
  const kidAtual = atual ? identificador(atual) : null;
  return Boolean(kidAtual) && kid !== kidAtual;
}

function dadosAutenticados(contexto) {
  return Buffer.from(String(contexto || 'gescondu'), 'utf8');
}

// Cifra um texto. `contexto` fica autenticado (AAD) e é obrigatório na
// decifragem correspondente.
function cifrar(texto, opcoes = {}) {
  const chave = lerChaveAtual();
  if (!chave) throw erro('sem_chave');
  const iv = crypto.randomBytes(BYTES_IV);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv, { authTagLength: BYTES_TAG });
  cipher.setAAD(dadosAutenticados(opcoes.contexto));
  const ct = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIXO, VERSAO, identificador(chave), iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

// Decifra um valor. Valores antigos (texto simples) são devolvidos tal e qual,
// para que a camada chamadora os possa migrar:
//   { ok: true, texto, cifrado: false, formato: 'texto-simples' }
function decifrar(valor, opcoes = {}) {
  const bruto = valor == null ? null : String(valor);
  if (bruto === null || bruto === '') return { ok: true, texto: null, cifrado: false, formato: 'vazio' };

  if (!estaCifrado(bruto)) {
    return { ok: true, texto: bruto, cifrado: false, formato: 'texto-simples' };
  }

  const partes = bruto.split(':');
  if (partes.length !== 6) throw erro('formato');
  const [, versao, kid, ivTxt, tagTxt, ctTxt] = partes;
  if (versao !== VERSAO) throw erro('formato');

  const mapa = mapaDeChaves();
  if (mapa.size === 0) throw erro('sem_chave');
  const chave = mapa.get(kid);
  if (!chave) throw erro('autenticacao');

  let decifrador;
  try {
    decifrador = crypto.createDecipheriv(ALGORITMO, chave, Buffer.from(ivTxt, 'base64url'), { authTagLength: BYTES_TAG });
    decifrador.setAAD(dadosAutenticados(opcoes.contexto));
    decifrador.setAuthTag(Buffer.from(tagTxt, 'base64url'));
  } catch (err) {
    throw erro('formato');
  }

  let texto;
  try {
    texto = Buffer.concat([decifrador.update(Buffer.from(ctTxt, 'base64url')), decifrador.final()]).toString('utf8');
  } catch (err) {
    // Falha de autenticação: ciphertext, tag, IV, contexto ou chave errados.
    throw erro('autenticacao');
  }
  return { ok: true, texto, cifrado: true, formato: `${PREFIXO}:${VERSAO}`, kid };
}

// Cifra se necessário: usado pela migração transparente.
function garantirCifrado(valor, opcoes = {}) {
  if (estaCifrado(valor) && !precisaRecifrar(valor)) {
    return { valor, alterado: false, motivo: 'ja-cifrado' };
  }
  if (!estaCifrado(valor)) {
    const texto = valor == null ? null : String(valor);
    if (texto === null || texto === '') return { valor, alterado: false, motivo: 'vazio' };
    return { valor: cifrar(texto, opcoes), alterado: true, motivo: 'migrado' };
  }
  // Cifrado com chave anterior → recifra com a chave atual (rotação).
  const { texto } = decifrar(valor, opcoes);
  return { valor: cifrar(texto, opcoes), alterado: true, motivo: 'recifrado' };
}

module.exports = {
  PREFIXO,
  VERSAO,
  ALGORITMO,
  ErroCifra,
  MENSAGENS,
  estado,
  estaCifrado,
  precisaRecifrar,
  cifrar,
  decifrar,
  garantirCifrado,
  identificador,
  interpretarChave,
};
