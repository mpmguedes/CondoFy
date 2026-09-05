// ─────────────────────────────────────────────────────────────────────
// Email / SMTP — helper transversal.
//
// Configuração: as variáveis podem vir do .env (SMTP_*) ou da base de
// dados (tabela `configuracoes`, chaves smtp_*), configuráveis na
// interface administrativa. As da BD têm prioridade quando existem.
//
// Segurança: a password SMTP nunca é devolvida nem aparece na interface
// (apenas indicador "definida"). Nada de credenciais em logs.
// ─────────────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const { Configuracao } = require('../models');

const CHAVES = {
  host: 'smtp_host',
  port: 'smtp_port',
  user: 'smtp_user',
  pass: 'smtp_pass',
  tls: 'smtp_tls',
  from: 'smtp_from',
  fromName: 'smtp_from_name',
};

const TTL = 30 * 1000; // cache curto (30 s) para leituras à BD
let _cache = { at: 0, dados: null };

async function lerChavesDb() {
  const rows = await Configuracao.findAll({
    where: { chave: { [Op.like]: 'smtp_%' } },
    attributes: ['chave', 'valor'],
  });
  const mapa = {};
  for (const r of rows) mapa[r.chave] = r.valor;
  return mapa;
}

function configEnv() {
  return {
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || '587',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    tls: process.env.SMTP_TLS || 'true',
    from: process.env.SMTP_FROM || '',
    fromName: process.env.SMTP_FROM_NAME || 'Condomínio',
  };
}

// Configuração efetiva: BD com prioridade quando tem host/utilizador;
// caso contrário, .env (compatibilidade com instalações atuais).
async function obterConfigSmtp({ force = false } = {}) {
  const agora = Date.now();
  if (!force && _cache.dados && agora - _cache.at < TTL) return _cache.dados;

  let cfg = null;
  try {
    const db = await lerChavesDb();
    if (db[CHAVES.host] || db[CHAVES.user] || db[CHAVES.from]) {
      cfg = {
        host: db[CHAVES.host] || '',
        port: db[CHAVES.port] || '587',
        user: db[CHAVES.user] || '',
        pass: db[CHAVES.pass] || '',
        tls: db[CHAVES.tls] || 'true',
        from: db[CHAVES.from] || '',
        fromName: db[CHAVES.fromName] || 'Condomínio',
      };
    }
  } catch (err) {
    // BD indisponível → usa .env
  }
  if (!cfg) cfg = configEnv();
  _cache = { at: agora, dados: cfg };
  return cfg;
}

// Limpa a cache (após guardar configuração).
function limparCache() {
  _cache = { at: 0, dados: null };
}

// Estado síncrono simples (usado em views). Reflete o .env ou a última
// configuração lida da BD.
function smtpConfigured() {
  if (process.env.SMTP_HOST) return true;
  return Boolean(_cache.dados && _cache.dados.host);
}

function construirTransporte(cfg) {
  const secure = cfg.tls === 'true' && cfg.port === '465';
  return nodemailer.createTransport({
    host: cfg.host,
    port: parseInt(cfg.port || '587', 10),
    secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: cfg.tls === 'false' ? { rejectUnauthorized: false } : undefined,
  });
}

// Nome visível do remetente (display name). Prioridade:
// 1. nome da administração configurada no condomínio;
// 2. designação do condomínio;
// 3. "GesCondu" (fallback — nunca "CondoFy").
async function obterNomeRemetente() {
  try {
    const { getCondominio } = require('./condominio');
    const c = await getCondominio();
    if (!c) return '';
    const admin = String(c.administracao_nome || '').trim();
    if (admin) return admin;
    const designacao = String(c.designacao || '').trim();
    if (designacao) return designacao;
    return '';
  } catch (err) {
    return '';
  }
}

async function sendMail({ to, subject, text, html, attachments = [], displayName }) {
  const cfg = await obterConfigSmtp();
  if (!cfg.host) {
    console.log('[mailer] SMTP não configurado — email NÃO enviado.');
    return { enviado: false, motivo: 'SMTP não configurado' };
  }
  const transport = construirTransporte(cfg);
  const nomeRemetente = String(displayName || (await obterNomeRemetente()) || cfg.fromName || 'GesCondu').trim();
  const info = await transport.sendMail({
    from: `"${nomeRemetente.replace(/"/g, '')}" <${cfg.from || 'noreply@localhost'}>`,
    to,
    subject,
    text,
    html,
    attachments,
  });
  return { enviado: true, messageId: info.messageId, resposta: info.response };
}

// Verifica a ligação SMTP (sem enviar mensagens).
async function testarLigacao() {
  const cfg = await obterConfigSmtp({ force: true });
  if (!cfg.host) {
    return { ok: false, erro: 'SMTP não configurado.' };
  }
  const transport = construirTransporte(cfg);
  await transport.verify(); // lança erro se a ligação falhar
  return {
    ok: true,
    servidor: cfg.host,
    port: cfg.port,
    utilizador: cfg.user || null,
    secure: cfg.tls === 'true' && String(cfg.port) === '465',
  };
}

// Envio de teste IMEDIATO (não passa pela fila).
// Devolve sempre { ok, erro?/messageId? }; nunca lança.
async function enviarEmailTeste({ para, assunto, mensagem, html }) {
  try {
    const res = await sendMail({ to: para, subject: assunto, text: mensagem, html });
    if (res.enviado) return { ok: true, messageId: res.messageId };
    return { ok: false, erro: res.motivo };
  } catch (err) {
    return { ok: false, erro: mensagemErroAmigavel(err) };
  }
}

function mensagemErroAmigavel(err) {
  const m = String((err && err.message) || err || 'erro desconhecido');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(m)) return 'Não foi possível ligar ao servidor SMTP (host/porta incorretos ou indisponível).';
  if (/EAUTH|535|Username and Password|Application-specific password/i.test(m)) return 'Falha de autenticação SMTP (utilizador/password incorretos).';
  if (/550|553|rejected|spam/i.test(m)) return 'O servidor SMTP recusou o envio (remetente/destinatário ou política do servidor).';
  if (/SSL|TLS|self.signed|certificate/i.test(m)) return 'Problema de segurança da ligação (TLS/certificado). Verifique a opção de segurança.';
  if (/quota|limit|rate/i.test(m)) return 'Limite de envio do servidor SMTP atingido. Tente novamente mais tarde.';
  // Nunca ecoar mensagens técnicas não categorizadas (podem conter dados sensíveis).
  return 'Ocorreu um erro ao enviar o email. Reveja a configuração SMTP e tente novamente.';
}

// Estado para a interface (nunca inclui a password).
async function obterEstadoSmtp() {
  const cfg = await obterConfigSmtp({ force: true });
  return {
    configurado: Boolean(cfg.host),
    servidor: cfg.host || null,
    porta: cfg.port || null,
    utilizador: cfg.user || null,
    remetente: cfg.from || null,
    nomeRemetente: cfg.fromName || null,
    seguranca: cfg.tls === 'true' ? (String(cfg.port) === '465' ? 'SSL/TLS (465)' : 'STARTTLS (587)') : 'Sem TLS',
    temPassword: Boolean(cfg.pass),
  };
}

// Guarda a configuração SMTP na BD. A password só é alterada se for
// fornecida (nunca é mostrada nem devolvida).
async function guardarConfigSmtp(dados) {
  const mapa = {};
  if (dados.host !== undefined) mapa[CHAVES.host] = String(dados.host).trim();
  if (dados.port !== undefined) mapa[CHAVES.port] = String(dados.port || '587').trim();
  if (dados.user !== undefined) mapa[CHAVES.user] = String(dados.user).trim();
  if (dados.tls !== undefined) mapa[CHAVES.tls] = dados.tls === 'on' || dados.tls === 'true' || dados.tls === true ? 'true' : 'false';
  if (dados.from !== undefined) mapa[CHAVES.from] = String(dados.from).trim();
  if (dados.fromName !== undefined) mapa[CHAVES.fromName] = String(dados.fromName).trim();
  if (dados.pass !== undefined && String(dados.pass).trim() !== '') {
    mapa[CHAVES.pass] = String(dados.pass); // apenas quando o administrador introduz nova password
  }

  for (const [chave, valor] of Object.entries(mapa)) {
    const [reg] = await Configuracao.findOrCreate({ where: { chave }, defaults: { valor } });
    if (reg.valor !== valor) {
      reg.valor = valor;
      await reg.save();
    }
  }
  limparCache();
}

// Pré-aquece a cache (chamado no arranque da aplicação).
async function inicializar() {
  try {
    await obterConfigSmtp({ force: true });
  } catch (err) {
    console.error('[mailer] não foi possível ler a configuração SMTP:', err.message);
  }
}

module.exports = {
  sendMail,
  smtpConfigured,
  testarLigacao,
  enviarEmailTeste,
  obterEstadoSmtp,
  guardarConfigSmtp,
  obterNomeRemetente,
  limparCache,
  inicializar,
  mensagemErroAmigavel,
};
