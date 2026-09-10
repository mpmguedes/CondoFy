// ─────────────────────────────────────────────────────────────────────
// Ligações de armazenamento (multi-tenant + plataforma) com credenciais
// CIFRADAS EM REPOUSO.
//
// Conceitos SEPARADOS (não misturar):
//
//  · ARMAZENAMENTO DE DOCUMENTOS — por condomínio:
//      storage:principal:c<id>            provedor principal (onde ficam os documentos)
//      storage:tokens:<provedor>:c<id>    contas autorizadas do condomínio
//      storage:raiz:<provedor>:c<id>      pasta raiz (opcional)
//
//  · BACKUPS — da instalação (o dump contém dados de TODOS os condomínios):
//      storage:backup                        provedor de destino dos backups
//      storage:tokens:<provedor>:plataforma  contas autorizadas da plataforma
//
// Relação conceptual: Condomínio → Serviço → Conta autorizada → Pastas.
//
// ── CIFRAGEM (ponto único) ──────────────────────────────────────────
// Os tokens OAuth são guardados cifrados (AES-256-GCM, chave da instalação em
// ENCRYPTION_KEY) através de helpers/armazenamento/cifra.js. Este módulo é o
// ÚNICO sítio que cifra/decifra: quem delega (helpers/drive, provedores,
// rotas, testes) continua a receber objetos de tokens já decifrados em memória
// e nunca precisa de saber se o valor estava cifrado.
//
// Migração transparente: valores antigos em texto simples são reconhecidos,
// usados e imediatamente substituídos pela versão cifrada (sem obrigar a
// autorizar novamente as contas). O contexto de cada valor (nome da chave na
// tabela) fica autenticado, pelo que um token copiado de um condomínio para
// outro deixa de decifrar — o isolamento multi-tenant fica reforçado.
//
// Sem ENCRYPTION_KEY não se lê nem se escreve nenhuma credencial: nenhuma
// operação de armazenamento usa texto simples e qualquer tentativa de guardar
// falha com uma mensagem administrativa clara (as páginas continuam a
// responder, mostrando o serviço como não ligado).
//
// Compatibilidade: a chave antiga `storage:provedor:c<id>` continua a ser
// lida; a ligação global antiga do Google Drive (`google_drive_tokens`) é a
// ligação de PLATAFORMA do Drive e serve de fallback aos condomínios sem
// conta própria; a pasta raiz global (`google_drive_root_folder`) mantém a
// prioridade.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { getConfig, setConfig } = require('../config');
const locator = require('./locator');
const cifra = require('./cifra');

const CHAVE_TOKENS_LEGADO = 'google_drive_tokens'; // ligação de plataforma do Google Drive
const CHAVE_RAIZ_LEGADO = 'google_drive_root_folder';
const PREFIXO_CHAVES = 'storage:';
const SUFIXO_PLATAFORMA = 'plataforma';

const chavePrincipal = (condominioId) => `${PREFIXO_CHAVES}principal:c${condominioId}`;
const chaveProvedor = (condominioId) => `${PREFIXO_CHAVES}provedor:c${condominioId}`; // legado
const chaveTokens = (provedor, condominioId) => `${PREFIXO_CHAVES}tokens:${provedor}:c${condominioId}`;
const chaveRaiz = (provedor, condominioId) => `${PREFIXO_CHAVES}raiz:${provedor}:c${condominioId}`;
const CHAVE_BACKUP = `${PREFIXO_CHAVES}backup`;

// Registo de uma ligação que foi REMOVIDA porque o fornecedor revogou a
// autorização (o utilizador não pediu para desligar). Guarda apenas a
// IDENTIDADE da ligação — conta, motivo e data — para a página poder dizer
// qual conta voltar a ligar. Não contém tokens nem segredos (por isso é texto
// simples e nunca é tratado como credencial).
const chaveLigacaoInvalida = (provedor, condominioId) =>
  `${PREFIXO_CHAVES}ligacao-invalida:${provedor}:${condominioId ? `c${condominioId}` : SUFIXO_PLATAFORMA}`;

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

// ── Leitura/escrita cifrada das credenciais ─────────────────────────
// Chaves da tabela que contêm credenciais (usado pela migração explícita).
function ehChaveDeCredenciais(chave) {
  const c = String(chave || '');
  return c === CHAVE_TOKENS_LEGADO || c.startsWith(`${PREFIXO_CHAVES}tokens:`);
}

function parseTokens(valor) {
  if (valor == null || valor === '') return null;
  if (typeof valor === 'object') return valor;
  try {
    const t = JSON.parse(valor);
    return t && typeof t === 'object' ? t : null;
  } catch (err) {
    return null;
  }
}

// Decodifica o valor guardado na BD: aceita o formato cifrado (enc:v1:…) e o
// formato antigo em texto simples. Nunca lança por falha de cifra — devolve
// `erro` e tokens nulos, para que a aplicação falhe de forma segura (não usa
// texto simples nem rebenta as páginas).
function decodificar(bruto, chaveConfig) {
  if (bruto == null || bruto === '') return { tokens: null, precisaMigrar: false, erro: null };
  let texto = null;
  let eraCifrado = false;
  try {
    const r = cifra.decifrar(bruto, { contexto: chaveConfig });
    texto = r.texto;
    eraCifrado = r.cifrado;
  } catch (err) {
    return { tokens: null, precisaMigrar: false, erro: err };
  }
  const tokens = parseTokens(texto);
  if (!tokens) return { tokens: null, precisaMigrar: false, erro: null };
  return { tokens, precisaMigrar: !eraCifrado, erro: null, cifrado: eraCifrado };
}

// Guarda as credenciais sempre cifradas (recusa sem ENCRYPTION_KEY).
async function gravarCredenciais(chaveConfig, tokens) {
  const conteudo = JSON.stringify(tokens);
  const valor = cifra.cifrar(conteudo, { contexto: chaveConfig });
  await setConfig(chaveConfig, valor);
  return valor;
}

// Migra (se necessário) um valor em texto simples para o formato cifrado.
// Devolve { alterado, erro } — nunca expõe o conteúdo.
async function migrarSeNecessario(chaveConfig, bruto) {
  if (bruto == null || bruto === '') return { alterado: false, erro: null };
  try {
    const r = cifra.garantirCifrado(bruto, { contexto: chaveConfig });
    if (!r.alterado) return { alterado: false, erro: null };
    await setConfig(chaveConfig, r.valor);
    return { alterado: true, erro: null, motivo: r.motivo };
  } catch (err) {
    return { alterado: false, erro: err };
  }
}

// ── Cache síncrona ──────────────────────────────────────────────────
// Guarda os tokens já DECIFRADOS (necessários para chamar as APIs) e nunca é
// registada em log nem exposta a vistas/respostas.
const _cache = {
  pronto: false,
  principal: new Map(), // condominioId → provedor principal
  tokens: new Map(), // `${provedor}:${condominioId|plataforma}` → tokens|false (decifrados)
  raizes: new Map(),
  cifraErro: null, // mensagem administrativa quando as credenciais não podem ser usadas
};

function chaveCacheTokens(provedor, condominioId) {
  return `${provedor}:${condominioId || SUFIXO_PLATAFORMA}`;
}

function registarErroCifra(err) {
  if (err && err.codigo === 'sem_chave') _cache.cifraErro = cifra.MENSAGENS.sem_chave;
  else if (err && err.codigo === 'chave_invalida') _cache.cifraErro = cifra.MENSAGENS.chave_invalida;
  else if (err) _cache.cifraErro = cifra.MENSAGENS.autenticacao;
}

// Preenche a cache com os valores NÃO secretos (principal, raiz).
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
  if (campo === 'raiz' && partes[1] && partes[2]) {
    const provedor = partes[1];
    const cid = Number(String(partes[2]).replace(/^c/, ''));
    if (cid && valor) _cache.raizes.set(`${provedor}:${cid}`, String(valor));
  }
}

// Uma única leitura preenche a cache (arranque da aplicação) e MIGRA os
// valores que ainda estejam em texto simples.
async function inicializar() {
  const estadoCifra = cifra.estado();
  let migrados = 0;
  try {
    const { Configuracao } = require('../../models');
    const linhas = await Configuracao.findAll({ where: { chave: { [Op.like]: `${PREFIXO_CHAVES}%` } } });
    for (const l of linhas) {
      if (ehChaveDeCredenciais(l.chave)) {
        if (!estadoCifra.configurada) continue; // fail-safe: não se usa texto simples
        const r = await migrarSeNecessario(l.chave, l.valor);
        if (r.alterado) migrados++;
        if (r.erro) { registarErroCifra(r.erro); console.warn('[armazenamento] credenciais não migradas:', r.erro.message); }
        const d = decodificar(r.alterado ? await getConfig(l.chave, null).catch(() => null) : l.valor, l.chave);
        if (d.erro) registarErroCifra(d.erro);
        else aplicarTokensNaCache(l.chave, d.tokens);
        continue;
      }
      preencherCache(l.chave, l.valor);
    }

    // Credenciais de plataforma com chave histórica (podem não começar por storage:).
    if (estadoCifra.configurada) {
      for (const chave of [CHAVE_TOKENS_LEGADO, ...locator.provedores().filter((p) => p !== 'google_drive').map((p) => chaveTokensPlataforma(p))]) {
        const bruto = await getConfig(chave, null).catch(() => null);
        if (bruto == null) {
          // Sem valor: garante que a cache não guarda uma ligação antiga (por
          // exemplo depois de desligar o serviço usado para backups).
          aplicarTokensNaCache(chave, null);
          continue;
        }
        const r = await migrarSeNecessario(chave, bruto);
        if (r.alterado) migrados++;
        const d = decodificar(r.alterado ? await getConfig(chave, null).catch(() => null) : bruto, chave);
        if (d.erro) registarErroCifra(d.erro);
        else aplicarTokensNaCache(chave, d.tokens);
      }
    } else {
      _cache.cifraErro = cifra.MENSAGENS.sem_chave;
    }

    const raizLegado = await getConfig(CHAVE_RAIZ_LEGADO, null).catch(() => null);
    if (raizLegado) _cache.raizes.set('google_drive:legado', String(raizLegado));
    if (migrados > 0) {
      console.log(`[armazenamento] ${migrados} credencial(is) migrada(s) para formato cifrado.`);
    }
    if (_cache.cifraErro) console.warn('[armazenamento]', _cache.cifraErro);
  } catch (err) {
    console.warn('[armazenamento] cache de ligações não carregada:', err.message);
  } finally {
    _cache.pronto = true;
  }
  return _cache;
}

// Aplica na cache os tokens de uma chave de configuração (já decifrados).
function aplicarTokensNaCache(chaveConfig, tokens) {
  if (chaveConfig === CHAVE_TOKENS_LEGADO) {
    _cache.tokens.set(chaveCacheTokens('google_drive', null), tokens || false);
    return;
  }
  const partes = String(chaveConfig).slice(PREFIXO_CHAVES.length).split(':');
  if (partes[0] !== 'tokens' || !partes[1] || !partes[2]) return;
  const provedor = partes[1];
  const alvo = String(partes[2]);
  if (alvo === SUFIXO_PLATAFORMA) {
    _cache.tokens.set(chaveCacheTokens(provedor, null), tokens || false);
    return;
  }
  const cid = Number(alvo.replace(/^c/, ''));
  if (cid) _cache.tokens.set(chaveCacheTokens(provedor, cid), tokens || false);
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

// ── Backups: que ligação usar ───────────────────────────────────────
// Os backups são da instalação (o dump contém dados de todos os condomínios) e
// usam a ligação JÁ EXISTENTE do serviço escolhido — uma ligação por serviço,
// sem contas duplicadas:
//   1. ligação de plataforma do serviço (quando existe: é o caso histórico do
//      Google Drive e mantém-se válida);
//   2. caso contrário, a ligação do condomínio que a tem (o primeiro, por id),
//      com aviso explícito na interface de que os backups contêm dados de todos
//      os condomínios.
// Devolve { condominioId, conta, origem } — `condominioId` nulo significa que se
// usa a ligação de plataforma.
function ligacaoParaBackup(provedor) {
  const plataforma = tokensSync(provedor, null, { plataforma: true }).tokens;
  if (plataforma) {
    return { condominioId: null, conta: plataforma.conta || null, origem: 'plataforma' };
  }
  const prefixo = `${PREFIXO_CHAVES}tokens:${provedor}:c`;
  const candidatos = [..._cache.tokens.keys()]
    .filter((k) => k.startsWith(prefixo))
    .map((k) => ({ chave: k, cid: Number(k.slice(prefixo.length)) }))
    .filter((x) => Number.isFinite(x.cid) && x.cid > 0)
    .sort((a, b) => a.cid - b.cid);
  for (const c of candidatos) {
    const tokens = _cache.tokens.get(c.chave);
    if (tokens) return { condominioId: c.cid, conta: tokens.conta || null, origem: 'condominio' };
  }
  // Ligação legada por variável de ambiente (só Google Drive): é da instalação,
  // por isso não há conta associada nem aviso de "conta de condomínio".
  if (provedor === 'google_drive' && String(process.env.GOOGLE_REFRESH_TOKEN || '').trim()) {
    return { condominioId: null, conta: null, origem: 'plataforma' };
  }
  return { condominioId: null, conta: null, origem: null };
}

// ── Tokens (sempre cifrados na BD) ──────────────────────────────────
// Carrega (e usa) as credenciais de uma chave de configuração.
// Fail-safe: sem ENCRYPTION_KEY nenhuma credencial é usada — nem sequer um
// valor antigo em texto simples (a migração não é possível sem chave).
async function carregarCredenciais(chaveConfig) {
  const chaveCache = chaveCacheDeConfig(chaveConfig);
  const bruto = await getConfig(chaveConfig, null).catch(() => null);
  const d = decodificar(bruto, chaveConfig);
  if (d.erro) {
    registarErroCifra(d.erro);
    _cache.tokens.set(chaveCache, false);
    return null;
  }
  if (!d.tokens) {
    _cache.tokens.set(chaveCache, false);
    return null;
  }
  if (d.precisaMigrar) {
    if (!cifraDisponivel()) {
      // Não se opera com texto simples: fica indisponível até haver chave.
      registarErroCifra({ codigo: 'sem_chave' });
      _cache.tokens.set(chaveCache, false);
      return null;
    }
    await migrarSeNecessario(chaveConfig, bruto);
  }
  _cache.tokens.set(chaveCache, d.tokens);
  return d.tokens;
}

// Traduz uma chave de configuração na sua chave de cache.
function chaveCacheDeConfig(chaveConfig) {
  if (chaveConfig === CHAVE_TOKENS_LEGADO) return chaveCacheTokens('google_drive', null);
  const partes = String(chaveConfig).slice(PREFIXO_CHAVES.length).split(':');
  if (partes[0] !== 'tokens' || !partes[1] || !partes[2]) return chaveConfig;
  const alvo = String(partes[2]);
  return alvo === SUFIXO_PLATAFORMA ? chaveCacheTokens(partes[1], null) : chaveCacheTokens(partes[1], Number(alvo.replace(/^c/, '')));
}

async function lerTokens(provedor, condominioId, opcoes = {}) {
  const plataforma = Boolean(opcoes.plataforma);
  const cid = plataforma ? null : normalizarCondominio(condominioId);
  const admiteFallback = provedor === 'google_drive';

  if (cid) {
    const tokens = await carregarCredenciais(chaveTokens(provedor, cid));
    if (tokens) return { tokens, origem: 'condominio' };
  }

  if (plataforma || admiteFallback || !cid) {
    const tokens = await carregarCredenciais(chaveTokensPlataforma(provedor));
    if (tokens) return { tokens, origem: plataforma ? 'plataforma' : 'plataforma_fallback' };
  }

  // Ligação antiga por variável de ambiente (mantida como último recurso).
  if (!plataforma && provedor === 'google_drive') {
    const env = String(process.env.GOOGLE_REFRESH_TOKEN || '').trim();
    if (env) return { tokens: { refresh_token: env, origem: 'env' }, origem: 'env' };
  }
  return { tokens: null, origem: null };
}

// Síncrono (cache, já decifrada) — mesmas regras do lerTokens.
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

// ── Ligação removida pelo fornecedor (revogação) ────────────────────
// Quando o fornecedor revoga a autorização, os tokens deixam de servir e são
// removidos. Perder também a IDENTIDADE da ligação deixava o administrador sem
// saber que conta voltar a ligar (e na interface o serviço simplesmente
// desaparecia). Guarda-se então um registo mínimo — conta, motivo e data, sem
// nenhum segredo — até a conta ser ligada de novo.
async function marcarLigacaoInvalida(provedor, condominioId, dados = {}) {
  const cid = normalizarCondominio(condominioId);
  const chave = chaveLigacaoInvalida(provedor, cid);
  const anterior = (await lerLigacaoInvalida(provedor, cid)) || {};
  const registo = {
    conta: dados.conta || anterior.conta || null,
    motivo: dados.motivo || anterior.motivo || null,
    // Mantém a data da PRIMEIRA falha: é a informação útil para o diagnóstico.
    quando: anterior.quando || new Date().toISOString(),
  };
  await setConfig(chave, JSON.stringify(registo));
  return registo;
}

async function lerLigacaoInvalida(provedor, condominioId) {
  const cid = normalizarCondominio(condominioId);
  try {
    const bruto = await getConfig(chaveLigacaoInvalida(provedor, cid), null);
    if (!bruto) return null;
    const dados = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
    if (!dados || typeof dados !== 'object') return null;
    return { conta: dados.conta || null, motivo: dados.motivo || null, quando: dados.quando || null };
  } catch (err) {
    return null;
  }
}

async function limparLigacaoInvalida(provedor, condominioId) {
  const cid = normalizarCondominio(condominioId);
  await setConfig(chaveLigacaoInvalida(provedor, cid), null).catch(() => {});
}

// Guarda os tokens SEMPRE cifrados. Sem ENCRYPTION_KEY lança ErroCifra com
// mensagem administrativa (nada é escrito em texto simples).
async function guardarTokens(provedor, condominioId, dados) {
  const cid = normalizarCondominio(condominioId);
  const chave = cid ? chaveTokens(provedor, cid) : chaveTokensPlataforma(provedor);

  // Lê sempre o valor atual da BD antes de fundir: nunca perde o refresh_token.
  const brutoAtual = await getConfig(chave, null).catch(() => null);
  const atual = decodificar(brutoAtual, chave);
  const anteriores = atual.tokens || {};

  const novos = {
    access_token: dados.access_token != null ? dados.access_token : anteriores.access_token || null,
    refresh_token: dados.refresh_token != null ? dados.refresh_token : anteriores.refresh_token || null,
    expiry_date: dados.expiry_date != null ? dados.expiry_date : anteriores.expiry_date || null,
    conta: dados.conta != null ? dados.conta : anteriores.conta || null,
  };
  await gravarCredenciais(chave, novos);
  _cache.tokens.set(chaveCacheTokens(provedor, cid), novos);
  _cache.cifraErro = null;
  // Ligação nova: o registo de "ligação inválida" deixa de fazer sentido.
  await limparLigacaoInvalida(provedor, cid);
  return novos;
}

// Remove as credenciais do âmbito indicado.
//  · `opcoes.motivo` identifica uma remoção NÃO pedida pelo utilizador (o
//    fornecedor revogou a autorização): guarda-se o registo da ligação (conta e
//    data, sem tokens) para a página poder dizer QUAL conta voltar a ligar;
//  · sem motivo (desligar a pedido do utilizador) o registo é apagado — a
//    ligação foi removida de propósito e não há nada a reconectar.
async function limparTokens(provedor, condominioId, opcoes = {}) {
  const cid = normalizarCondominio(condominioId);
  const chave = cid ? chaveTokens(provedor, cid) : chaveTokensPlataforma(provedor);
  if (opcoes.motivo) {
    const atuais = await carregarCredenciais(chave).catch(() => null);
    await marcarLigacaoInvalida(provedor, cid, {
      conta: atuais && atuais.conta ? atuais.conta : null,
      motivo: opcoes.motivo,
    }).catch(() => {});
  } else {
    await limparLigacaoInvalida(provedor, cid);
  }
  await setConfig(chave, null);
  _cache.tokens.set(chaveCacheTokens(provedor, cid), false);
}

// ── Backups (instalação) ────────────────────────────────────────────
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

// ── Estado da cifragem e diagnóstico ────────────────────────────────
// Nunca inclui chaves, tokens ou ciphertexts.
function estadoCifra() {
  const e = cifra.estado();
  return { ...e, erroOperacional: _cache.cifraErro || e.mensagem || null };
}

function cifraDisponivel() {
  return cifra.estado().configurada;
}

function resumo(registo = null) {
  const provedores = registo ? Object.keys(registo) : locator.provedores();
  const comLigacao = (provedor, cid) => Boolean(tokensSync(provedor, cid).tokens);
  return {
    pronto: _cache.pronto,
    principal: Object.fromEntries(_cache.principal),
    plataforma: provedores.map((p) => ({ provedor: p, ligado: comLigacao(p, null) })),
    ligacoes: [..._cache.tokens.keys()],
    cifra: estadoCifra(),
  };
}

function limparCache() {
  _cache.pronto = false;
  _cache.principal.clear();
  _cache.tokens.clear();
  _cache.raizes.clear();
  _cache.cifraErro = null;
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
  chaveLigacaoInvalida,
  ehChaveDeCredenciais,
  provedorPadrao,
  principalSync,
  principalDoCondominio,
  definirPrincipal,
  // aliases históricos (mesma semântica: armazenamento principal)
  provedorSync: principalSync,
  provedorDoCondominio: principalDoCondominio,
  definirProvedor: definirPrincipal,
  carregarCredenciais,
  chaveCacheDeConfig,
  lerTokens,
  tokensSync,
  guardarTokens,
  limparTokens,
  marcarLigacaoInvalida,
  lerLigacaoInvalida,
  limparLigacaoInvalida,
  lerDestinoBackup,
  definirDestinoBackup,
  ligacaoParaBackup,
  lerRaiz,
  raizSync,
  guardarRaiz,
  inicializar,
  // cifragem
  estadoCifra,
  cifraDisponivel,
  decodificar,
  migrarSeNecessario,
  gravarCredenciais,
  resumo,
  limparCache,
  normalizarCondominio,
};
