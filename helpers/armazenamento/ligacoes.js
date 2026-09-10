// ─────────────────────────────────────────────────────────────────────
// Ligações de armazenamento (multi-tenant + plataforma).
//
// Conceitos SEPARADOS (não misturar):
//
//  · ARMazenamento de documentos — por condomínio:
//      storage:principal:c<id>            provedor principal (onde ficam os documentos)
//      storage:tokens:<provedor>:c<id>    contas autorizadas do condomínio
//      storage:raiz:<provedor>:c<id>      pasta raiz (opcional)
//
//  · BACKUPS — da instalação (o dump contém dados de TODOS os condomínios):
//      storage:backup                     provedor de destino dos backups
//      storage:tokens:<provedor>:plataforma  contas autorizadas da plataforma
//
// Relação conceptual: Condomínio → Serviço → Conta autorizada → Pastas.
//
// Compatibilidade:
//  · a chave antiga `storage:provedor:c<id>` continua a ser lida (e mantida em
//    escrita) como armazenamento principal;
//  · a ligação global antiga do Google Drive (`google_drive_tokens`) é a
//    ligação de PLATAFORMA do Drive e serve de fallback aos condomínios que
//    ainda não têm conta própria;
//  · a pasta raiz global (`google_drive_root_folder`) mantém a prioridade.
//
// Os tokens nunca são expostos ao browser nem escritos em ficheiros públicos.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { getConfig, setConfig } = require('../config');
const locator = require('./locator');

const CHAVE_TOKENS_LEGADO = 'google_drive_tokens'; // ligação de plataforma do Google Drive
const CHAVE_RAIZ_LEGADO = 'google_drive_root_folder';
const PREFIXO_CHAVES = 'storage:';
const SUFIXO_PLATAFORMA = 'plataforma';

const chavePrincipal = (condominioId) => `${PREFIXO_CHAVES}principal:c${condominioId}`;
const chaveProvedor = (condominioId) => `${PREFIXO_CHAVES}provedor:c${condominioId}`; // legado
const chaveTokens = (provedor, condominioId) => `${PREFIXO_CHAVES}tokens:${provedor}:c${condominioId}`;
const chaveRaiz = (provedor, condominioId) => `${PREFIXO_CHAVES}raiz:${provedor}:c${condominioId}`;
const CHAVE_BACKUP = `${PREFIXO_CHAVES}backup`;

// Tokens da plataforma: o Google Drive mantém a chave histórica.
function chaveTokensPlataforma(provedor) {
  return String(provedor) === 'google_drive'
    ? CHAVE_TOKENS_LEGADO
    : `${PREFIXO_CHAVES}tokens:${provedor}:${SUFIXO_PLATAFORMA}`;
}

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
// As vistas precisam de saber "está ligado?" sem esperar pela BD.
const _cache = {
  pronto: false,
  principal: new Map(), // condominioId → provedor principal
  tokens: new Map(), // `${provedor}:${condominioId|plataforma|legado}` → tokens|false
  raizes: new Map(),
};

function chaveCacheTokens(provedor, condominioId) {
  return `${provedor}:${condominioId || SUFIXO_PLATAFORMA}`;
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

function preencherCache(chave, valor) {
  const partes = String(chave).slice(PREFIXO_CHAVES.length).split(':');
  const campo = partes[0];
  if ((campo === 'principal' || campo === 'provedor') && partes[1]) {
    const cid = Number(String(partes[1]).replace(/^c/, ''));
    const nome = String(valor || '').trim().toLowerCase();
    // `principal` tem prioridade sobre a chave legada `provedor`.
    if (cid && nome && (campo === 'principal' || !_cache.principal.has(cid))) {
      _cache.principal.set(cid, nome);
    }
    return;
  }
  if (campo === 'tokens' && partes[1] && partes[2]) {
    const provedor = partes[1];
    const alvo = String(partes[2]);
    if (alvo === SUFIXO_PLATAFORMA || provedor === 'google_drive') {
      // A plataforma do Drive usa a chave histórica, tratada abaixo.
      if (alvo === SUFIXO_PLATAFORMA) {
        _cache.tokens.set(chaveCacheTokens(provedor, null), parseTokens(valor) || false);
        return;
      }
    }
    const cid = Number(alvo.replace(/^c/, ''));
    if (cid) _cache.tokens.set(chaveCacheTokens(provedor, cid), parseTokens(valor) || false);
    return;
  }
  if (campo === 'raiz' && partes[1] && partes[2]) {
    const provedor = partes[1];
    const cid = Number(String(partes[2]).replace(/^c/, ''));
    if (cid && valor) _cache.raizes.set(`${provedor}:${cid}`, String(valor));
  }
}

// Uma única leitura preenche a cache (arranque da aplicação).
async function inicializar() {
  try {
    const { Configuracao } = require('../../models');
    const linhas = await Configuracao.findAll({ where: { chave: { [Op.like]: `${PREFIXO_CHAVES}%` } } });
    for (const l of linhas) preencherCache(l.chave, l.valor);

    // Ligações de plataforma (chaves históricas/legado).
    const legadoDrive = await getConfig(CHAVE_TOKENS_LEGADO, null).catch(() => null);
    if (legadoDrive) _cache.tokens.set(chaveCacheTokens('google_drive', null), parseTokens(legadoDrive) || false);
    for (const provedor of locator.provedores()) {
      if (provedor === 'google_drive') continue;
      const chave = chaveTokensPlataforma(provedor);
      const valor = await getConfig(chave, null).catch(() => null);
      if (valor) _cache.tokens.set(chaveCacheTokens(provedor, null), parseTokens(valor) || false);
    }
    const raizLegado = await getConfig(CHAVE_RAIZ_LEGADO, null).catch(() => null);
    if (raizLegado) _cache.raizes.set('google_drive:legado', String(raizLegado));
  } catch (err) {
    console.warn('[armazenamento] cache de ligações não carregada:', err.message);
  } finally {
    _cache.pronto = true;
  }
  return _cache;
}

// ── Armazenamento principal (documentos) ────────────────────────────
function principalSync(condominioId, registo = null) {
  const cid = normalizarCondominio(condominioId);
  const daCache = cid ? _cache.principal.get(cid) : null;
  for (const c of [daCache, provedorPadrao(), locator.PROVEDOR_PADRAO]) {
    if (!c) continue;
    if (registo && !registo[c]) continue;
    if (locator.provedorValido(c)) return c;
  }
  return locator.PROVEDOR_PADRAO;
}

async function principalDoCondominio(condominioId, registo = null) {
  const cid = normalizarCondominio(condominioId);
  if (!cid) return principalSync(null, registo);
  try {
    const valor = await getConfig(chavePrincipal(cid), null);
    const legado = valor || (await getConfig(chaveProvedor(cid), null));
    if (legado) _cache.principal.set(cid, String(legado).trim().toLowerCase());
  } catch (err) {
    // BD indisponível → defaults
  }
  return principalSync(cid, registo);
}

async function definirPrincipal(condominioId, nome) {
  const cid = normalizarCondominio(condominioId);
  const alvo = String(nome || '').trim().toLowerCase();
  if (!cid) throw new Error('condominioId é obrigatório para definir o armazenamento principal.');
  if (!locator.provedorValido(alvo)) throw new Error(`Provedor de armazenamento desconhecido: ${nome}`);
  await setConfig(chavePrincipal(cid), alvo);
  // Mantém a chave antiga alinhada (leitores legados continuam coerentes).
  await setConfig(chaveProvedor(cid), alvo);
  _cache.principal.set(cid, alvo);
  return alvo;
}

// ── Tokens ──────────────────────────────────────────────────────────
// Leitura assíncrona (BD).
//  · `opcoes.plataforma` → ligação da instalação (usada pelos backups);
//  · caso contrário → ligação do condomínio e, SÓ para o Google Drive (que tem
//    uma conta de plataforma desde o início), fallback à conta da plataforma.
//    Nos restantes provedores a ligação é sempre do condomínio: documentos de
//    condomínios diferentes nunca partilham a mesma conta.
async function lerTokens(provedor, condominioId, opcoes = {}) {
  const plataforma = Boolean(opcoes.plataforma);
  const cid = plataforma ? null : normalizarCondominio(condominioId);
  const admiteFallback = provedor === 'google_drive';

  if (cid) {
    const tokens = parseTokens(await getConfig(chaveTokens(provedor, cid), null).catch(() => null));
    _cache.tokens.set(chaveCacheTokens(provedor, cid), tokens || false);
    if (tokens) return { tokens, origem: 'condominio' };
  }

  if (plataforma || admiteFallback || !cid) {
    const chavePlataforma = chaveTokensPlataforma(provedor);
    const tokensPlataforma = parseTokens(await getConfig(chavePlataforma, null).catch(() => null));
    _cache.tokens.set(chaveCacheTokens(provedor, null), tokensPlataforma || false);
    if (tokensPlataforma) {
      return { tokens: tokensPlataforma, origem: plataforma ? 'plataforma' : 'plataforma_fallback' };
    }
  }

  // Ligação antiga por variável de ambiente (mantida como último recurso).
  if (!plataforma && provedor === 'google_drive') {
    const env = String(process.env.GOOGLE_REFRESH_TOKEN || '').trim();
    if (env) return { tokens: { refresh_token: env, origem: 'env' }, origem: 'env' };
  }
  return { tokens: null, origem: null };
}

// Síncrono (cache) — mesmas regras do lerTokens.
function tokensSync(provedor, condominioId, opcoes = {}) {
  const plataforma = Boolean(opcoes.plataforma);
  const cid = plataforma ? null : normalizarCondominio(condominioId);
  const admiteFallback = provedor === 'google_drive';
  if (cid) {
    const t = _cache.tokens.get(chaveCacheTokens(provedor, cid));
    if (t) return { tokens: t, origem: 'condominio' };
  }
  if (plataforma || admiteFallback || !cid) {
    const tp = _cache.tokens.get(chaveCacheTokens(provedor, null));
    if (tp) return { tokens: tp, origem: plataforma ? 'plataforma' : 'plataforma_fallback' };
  }
  if (!plataforma && provedor === 'google_drive') {
    const env = String(process.env.GOOGLE_REFRESH_TOKEN || '').trim();
    if (env) return { tokens: { refresh_token: env, origem: 'env' }, origem: 'env' };
  }
  return { tokens: null, origem: null };
}

async function guardarTokens(provedor, condominioId, dados) {
  const cid = normalizarCondominio(condominioId);
  const chave = cid ? chaveTokens(provedor, cid) : chaveTokensPlataforma(provedor);
  // Lê sempre o valor atual da BD antes de fundir: nunca perde o refresh_token.
  const atuais = parseTokens(await getConfig(chave, null).catch(() => null)) || {};
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
  const chave = cid ? chaveTokens(provedor, cid) : chaveTokensPlataforma(provedor);
  await setConfig(chave, null);
  _cache.tokens.set(chaveCacheTokens(provedor, cid), false);
}

// ── Backups (instalação) ────────────────────────────────────────────
// O dump da base de dados contém dados de TODOS os condomínios: o destino de
// backups usa sempre a ligação de PLATAFORMA, nunca a de um condomínio.
async function lerDestinoBackup() {
  try {
    const valor = await getConfig(CHAVE_BACKUP, null);
    if (valor !== null && valor !== undefined && String(valor).trim() !== '') {
      const nome = String(valor).trim().toLowerCase();
      return locator.provedorValido(nome) ? nome : null;
    }
  } catch (err) {
    // cai no valor por omissão
  }
  // Compatibilidade: sem escolha explícita usa o Drive se estiver ligado à
  // plataforma e a opção antiga de backups no Drive não estiver desligada.
  const antigo = await getConfig('drive_auto_backups', '1').catch(() => '1');
  if (String(antigo) === '0') return null;
  const drive = tokensSync('google_drive', null, { plataforma: true }).tokens;
  return drive ? 'google_drive' : null;
}

async function definirDestinoBackup(nome) {
  const alvo = nome === null || nome === '' ? null : String(nome).trim().toLowerCase();
  if (alvo !== null && !locator.provedorValido(alvo)) {
    throw new Error(`Provedor de backups desconhecido: ${nome}`);
  }
  await setConfig(CHAVE_BACKUP, alvo);
  return alvo;
}

// ── Pasta raiz (por provedor) ───────────────────────────────────────
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
  if (provedor === 'google_drive') return _cache.raizes.get('google_drive:legado') || '';
  return '';
}

async function guardarRaiz(provedor, condominioId, valor) {
  const cid = normalizarCondominio(condominioId);
  const chave = cid ? chaveRaiz(provedor, cid) : CHAVE_RAIZ_LEGADO;
  const limpo = String(valor || '').trim();
  await setConfig(chave, limpo || null);
  if (limpo) _cache.raizes.set(`${provedor}:${cid || 'legado'}`, limpo);
  else _cache.raizes.delete(`${provedor}:${cid || 'legado'}`);
}

// ── Diagnóstico ─────────────────────────────────────────────────────
function resumo(registo = null) {
  const provedores = registo ? Object.keys(registo) : locator.provedores();
  const comLigacao = (provedor, cid) => Boolean(tokensSync(provedor, cid).tokens);
  return {
    pronto: _cache.pronto,
    principal: Object.fromEntries(_cache.principal),
    plataforma: provedores.map((p) => ({ provedor: p, ligado: comLigacao(p, null) })),
    ligacoes: [..._cache.tokens.keys()],
  };
}

function limparCache() {
  _cache.pronto = false;
  _cache.principal.clear();
  _cache.tokens.clear();
  _cache.raizes.clear();
}

module.exports = {
  CHAVE_TOKENS_LEGADO,
  CHAVE_RAIZ_LEGADO,
  CHAVE_BACKUP,
  PREFIXO_CHAVES,
  SUFIXO_PLATAFORMA,
  chavePrincipal,
  chaveProvedor,
  chaveTokens,
  chaveTokensPlataforma,
  chaveRaiz,
  provedorPadrao,
  principalSync,
  principalDoCondominio,
  definirPrincipal,
  // aliases históricos (mesma semântica: armazenamento principal)
  provedorSync: principalSync,
  provedorDoCondominio: principalDoCondominio,
  definirProvedor: definirPrincipal,
  lerTokens,
  tokensSync,
  guardarTokens,
  limparTokens,
  lerDestinoBackup,
  definirDestinoBackup,
  lerRaiz,
  raizSync,
  guardarRaiz,
  inicializar,
  resumo,
  limparCache,
  normalizarCondominio,
};
