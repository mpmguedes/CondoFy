// ─────────────────────────────────────────────────────────────────────
// Ligações de armazenamento por condomínio (multi-tenant).
//
//  · Qual provedor usa cada condomínio:  storage:provedor:c<id>
//  · Tokens/credenciais da ligação:      storage:tokens:<provedor>:c<id>
//  · Pasta raiz opcional por provedor:   storage:raiz:<provedor>:c<id>
//
// São chaves da tabela `configuracoes` (chave única, STRING(120)): não é
// precisa migração de esquema e o valor por omissão mantém o comportamento
// anterior à introdução de múltiplos provedores.
//
// Compatibilidade (Google Drive):
//  · a ligação global antiga (chave `google_drive_tokens`, criada pelo fluxo
//    de Configuração → Google Drive) continua a ser a ligação usada quando o
//    condomínio não tem ligação própria — nenhuma instalação existente muda
//    de comportamento;
//  · a pasta raiz global (`google_drive_root_folder`) continua a ter
//    prioridade sobre o .env, como antes.
//
// Os tokens nunca são expostos ao browser nem escritos em ficheiros públicos.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { getConfig, setConfig } = require('../config');
const locator = require('./locator');

const CHAVE_TOKENS_LEGADO = 'google_drive_tokens'; // ligação global antiga ao Google Drive
const CHAVE_RAIZ_LEGADO = 'google_drive_root_folder';
const PREFIXO_CHAVES = 'storage:';

const chaveProvedor = (condominioId) => `${PREFIXO_CHAVES}provedor:c${condominioId}`;
const chaveTokens = (provedor, condominioId) => `${PREFIXO_CHAVES}tokens:${provedor}:c${condominioId}`;
const chaveRaiz = (provedor, condominioId) => `${PREFIXO_CHAVES}raiz:${provedor}:c${condominioId}`;

// Provedor usado quando o condomínio não tem escolha guardada.
function provedorPadrao() {
  const env = String(process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
  return locator.provedorValido(env) ? env : locator.PROVEDOR_PADRAO;
}

function normalizarCondominio(condominioId) {
  const n = Number(condominioId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Cache síncrona ──────────────────────────────────────────────────
// As vistas e alguns callers precisam de saber "está ligado?" de forma
// síncrona (comportamento herdado de helpers/drive). A cache é preenchida
// no arranque e em cada escrita; sem BD (testes offline) fica vazia e
// aplicam-se os valores por omissão.
const _cache = {
  pronto: false,
  provedores: new Map(), // condominioId → nome do provedor
  tokens: new Map(), // `${provedor}:${condominioId|legado}` → tokens|false
  raizes: new Map(),
};

function chaveCacheTokens(provedor, condominioId) {
  return `${provedor}:${condominioId || 'legado'}`;
}

function parseTokens(valor) {
  if (!valor) return null;
  if (typeof valor === 'object') return valor;
  try {
    const t = JSON.parse(valor);
    return t && typeof t === 'object' ? t : null;
  } catch (err) {
    return null;
  }
}

// Uma única leitura preenche a cache (arranque da aplicação).
async function inicializar() {
  try {
    const { Configuracao } = require('../../models');
    const linhas = await Configuracao.findAll({ where: { chave: { [Op.like]: `${PREFIXO_CHAVES}%` } } });
    for (const l of linhas) {
      preencherCache(l.chave, l.valor);
    }
    // Ligação global antiga do Google Drive (legado).
    const legado = await getConfig(CHAVE_TOKENS_LEGADO, null);
    _cache.tokens.set(chaveCacheTokens('google_drive', null), parseTokens(legado) || false);
    const raizLegado = await getConfig(CHAVE_RAIZ_LEGADO, null);
    if (raizLegado) _cache.raizes.set('google_drive:legado', String(raizLegado));
  } catch (err) {
    // Sem BD (testes offline) ou BD indisponível: cache vazia, defaults.
    console.warn('[armazenamento] cache de ligações não carregada:', err.message);
  } finally {
    _cache.pronto = true;
  }
  return _cache;
}

function preencherCache(chave, valor) {
  const partes = String(chave).slice(PREFIXO_CHAVES.length).split(':');
  const campo = partes[0];
  if (campo === 'provedor' && partes[1]) {
    const cid = Number(String(partes[1]).replace(/^c/, ''));
    if (cid) _cache.provedores.set(cid, String(valor || '').trim().toLowerCase());
    return;
  }
  if ((campo === 'tokens' || campo === 'raiz') && partes[1] && partes[2]) {
    const provedor = partes[1];
    const cid = Number(String(partes[2]).replace(/^c/, ''));
    const chaveMapa = campo === 'tokens' ? chaveCacheTokens(provedor, cid) : `${provedor}:${cid}`;
    const mapa = campo === 'tokens' ? _cache.tokens : _cache.raizes;
    if (campo === 'tokens') mapa.set(chaveMapa, parseTokens(valor) || false);
    else if (valor) mapa.set(chaveMapa, String(valor));
  }
}

// ── Provedor por condomínio ─────────────────────────────────────────
// Síncrono: cache → STORAGE_PROVIDER (.env) → google_drive.
function provedorSync(condominioId, registo = null) {
  const cid = normalizarCondominio(condominioId);
  const daCache = cid ? _cache.provedores.get(cid) : null;
  const candidatos = [daCache, provedorPadrao(), locator.PROVEDOR_PADRAO];
  for (const c of candidatos) {
    if (!c) continue;
    if (registo && !registo[c]) continue;
    if (locator.provedorValido(c)) return c;
  }
  return locator.PROVEDOR_PADRAO;
}

async function provedorDoCondominio(condominioId, registo = null) {
  const cid = normalizarCondominio(condominioId);
  if (!cid) return provedorSync(null, registo);
  try {
    const valor = await getConfig(chaveProvedor(cid), null);
    if (valor) {
      const nome = String(valor).trim().toLowerCase();
      _cache.provedores.set(cid, nome);
    }
  } catch (err) {
    // BD indisponível → defaults
  }
  return provedorSync(cid, registo);
}

async function definirProvedor(condominioId, nome) {
  const cid = normalizarCondominio(condominioId);
  const alvo = String(nome || '').trim().toLowerCase();
  if (!cid) throw new Error('condominioId é obrigatório para definir o provedor de armazenamento.');
  if (!locator.provedorValido(alvo)) throw new Error(`Provedor de armazenamento desconhecido: ${nome}`);
  await setConfig(chaveProvedor(cid), alvo);
  _cache.provedores.set(cid, alvo);
  return alvo;
}

// ── Tokens da ligação ───────────────────────────────────────────────
// Leitura assíncrona (BD) com fallback à ligação global antiga do Drive.
async function lerTokens(provedor, condominioId) {
  const cid = normalizarCondominio(condominioId);
  let tokens = null;
  if (cid) {
    tokens = parseTokens(await getConfig(chaveTokens(provedor, cid), null).catch(() => null));
    _cache.tokens.set(chaveCacheTokens(provedor, cid), tokens || false);
  }
  if (tokens) return { tokens, origem: 'condominio' };
  // Ligação global antiga (só Google Drive): mantém as instalações existentes.
  if (provedor === 'google_drive') {
    const legado = parseTokens(await getConfig(CHAVE_TOKENS_LEGADO, null).catch(() => null));
    _cache.tokens.set(chaveCacheTokens(provedor, null), legado || false);
    if (legado) return { tokens: legado, origem: 'legado' };
  }
  return { tokens: null, origem: null };
}

// Síncrono (cache). Sem entrada em cache devolve o legado do Drive, quando existe.
function tokensSync(provedor, condominioId) {
  const cid = normalizarCondominio(condominioId);
  if (cid) {
    const t = _cache.tokens.get(chaveCacheTokens(provedor, cid));
    if (t) return { tokens: t, origem: 'condominio' };
  }
  if (provedor === 'google_drive') {
    const legado = _cache.tokens.get(chaveCacheTokens('google_drive', null));
    if (legado) return { tokens: legado, origem: 'legado' };
    const env = String(process.env.GOOGLE_REFRESH_TOKEN || '').trim();
    if (env) return { tokens: { refresh_token: env, origem: 'env' }, origem: 'env' };
  }
  return { tokens: null, origem: null };
}

async function guardarTokens(provedor, condominioId, dados) {
  const cid = normalizarCondominio(condominioId);
  const chave = cid ? chaveTokens(provedor, cid) : CHAVE_TOKENS_LEGADO;
  // Lê sempre o valor atual da BD antes de fundir: nunca perde o refresh_token
  // (a cache pode ainda não estar carregada quando o token é renovado).
  const atuais = cid
    ? parseTokens(await getConfig(chave, null).catch(() => null)) || {}
    : parseTokens(await getConfig(CHAVE_TOKENS_LEGADO, null).catch(() => null)) || {};
  const novos = {
    access_token: dados.access_token != null ? dados.access_token : atuais.access_token || null,
    refresh_token: dados.refresh_token != null ? dados.refresh_token : atuais.refresh_token || null,
    expiry_date: dados.expiry_date != null ? dados.expiry_date : atuais.expiry_date || null,
    conta: dados.conta != null ? dados.conta : atuais.conta || null,
  };
  await setConfig(chave, JSON.stringify(novos));
  _cache.tokens.set(chaveCacheTokens(provedor, cid), novos);
  return novos;
}

async function limparTokens(provedor, condominioId) {
  const cid = normalizarCondominio(condominioId);
  const chave = cid ? chaveTokens(provedor, cid) : CHAVE_TOKENS_LEGADO;
  await setConfig(chave, null);
  _cache.tokens.set(chaveCacheTokens(provedor, cid), false);
}

// ── Pasta raiz por provedor (opcional) ──────────────────────────────
async function lerRaiz(provedor, condominioId) {
  const cid = normalizarCondominio(condominioId);
  if (cid) {
    const valor = await getConfig(chaveRaiz(provedor, cid), null).catch(() => null);
    if (valor) {
      _cache.raizes.set(`${provedor}:${cid}`, String(valor));
      return String(valor).trim();
    }
  }
  if (provedor === 'google_drive') {
    const legado = await getConfig(CHAVE_RAIZ_LEGADO, null).catch(() => null);
    if (legado) {
      _cache.raizes.set('google_drive:legado', String(legado));
      return String(legado).trim();
    }
  }
  return '';
}

function raizSync(provedor, condominioId) {
  const cid = normalizarCondominio(condominioId);
  if (cid) {
    const v = _cache.raizes.get(`${provedor}:${cid}`);
    if (v) return v;
  }
  if (provedor === 'google_drive') {
    const v = _cache.raizes.get('google_drive:legado');
    if (v) return v;
  }
  return '';
}

async function guardarRaiz(provedor, condominioId, valor) {
  const cid = normalizarCondominio(condominioId);
  const chave = cid ? chaveRaiz(provedor, cid) : CHAVE_RAIZ_LEGADO;
  await setConfig(chave, String(valor || '').trim() || null);
  if (String(valor || '').trim()) _cache.raizes.set(`${provedor}:${cid || 'legado'}`, String(valor).trim());
  else _cache.raizes.delete(`${provedor}:${cid || 'legado'}`);
}

// Utilitário de diagnóstico (nunca expõe tokens, só o estado).
function resumoCache() {
  return {
    pronto: _cache.pronto,
    provedores: Object.fromEntries(_cache.provedores),
    ligacoes: [..._cache.tokens.entries()].map(([k, v]) => [k, v ? 'ligado' : 'sem tokens']),
    raizes: Object.fromEntries(_cache.raizes),
  };
}

function limparCache() {
  _cache.pronto = false;
  _cache.provedores.clear();
  _cache.tokens.clear();
  _cache.raizes.clear();
}

module.exports = {
  CHAVE_TOKENS_LEGADO,
  CHAVE_RAIZ_LEGADO,
  PREFIXO_CHAVES,
  chaveProvedor,
  chaveTokens,
  chaveRaiz,
  provedorPadrao,
  provedorSync,
  provedorDoCondominio,
  definirProvedor,
  lerTokens,
  tokensSync,
  guardarTokens,
  limparTokens,
  lerRaiz,
  raizSync,
  guardarRaiz,
  inicializar,
  resumoCache,
  limparCache,
  normalizarCondominio,
};
