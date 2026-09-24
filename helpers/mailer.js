// ─────────────────────────────────────────────────────────────────────
// Email / SMTP — helper transversal.
//
// Configuração: as variáveis podem vir do .env (SMTP_*) ou da base de
// dados (tabela `configuracoes`, chaves smtp_*), configuráveis na
// interface administrativa. As da BD têm prioridade quando existem.
//
// Segurança: a password SMTP nunca é devolvida nem aparece na interface
// (apenas indicador "definida"). Nada de credenciais em logs.
//
// Em repouso a password é guardada CIFRADA (AES-256-GCM, chave da instalação)
// através de helpers/segredos.js — a mesma proteção das credenciais de
// armazenamento, que vivem na mesma tabela `configuracoes`. A decifragem
// acontece na leitura (`lerChavesDb`), pelo que o resto do módulo continua a
// trabalhar com texto simples em memória.
// ─────────────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const { Configuracao } = require('../models');
const segredos = require('./segredos');
// P54-1 — validador PURO da configuração. Não lê BD nem ambiente: recebe os
// valores e devolve `{ ok, valores, erros, avisos }`. Mantê-lo fora daqui é o
// que permite testá-lo sem base de dados e sem duplos.
const validacaoSmtp = require('./smtp-validacao');

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

// Substitui a password em texto simples pela versão cifrada (migração
// transparente). Falha em silêncio: o valor continua utilizável em texto
// simples e a tentativa repete-se na leitura seguinte. Sem chave de cifra não
// há nada a migrar.
async function migrarPasswordSmtp(texto) {
  if (!texto) return;
  try {
    const valor = segredos.protegerPasswordSmtp(texto);
    if (valor === texto) return; // sem chave: mantém-se como está
    const [reg] = await Configuracao.findOrCreate({ where: { chave: CHAVES.pass }, defaults: { valor } });
    if (reg.valor !== valor) {
      reg.valor = valor;
      await reg.save();
    }
  } catch (err) {
    // Sem chave ou BD indisponível: mantém-se em texto simples.
  }
}

async function lerChavesDb() {
  const rows = await Configuracao.findAll({
    where: { chave: { [Op.like]: 'smtp_%' } },
    attributes: ['chave', 'valor'],
  });
  const mapa = {};
  for (const r of rows) mapa[r.chave] = r.valor;

  // A password é decifrada aqui, uma única vez por leitura, para que
  // `comporConfigSmtp` continue a receber texto simples e todo o resto do
  // módulo (e a interface) funcione exatamente como antes.
  const p = segredos.lerPasswordSmtp(mapa[CHAVES.pass]);
  if (p.erro) {
    // Segredo ilegível (chave diferente ou valor alterado): um valor não
    // autenticado nunca é usado. A BD fica sem password e o `.env` serve de
    // queda, tal como quando a chave não existe na tabela.
    console.warn(
      '[mailer] a password SMTP guardada não pôde ser decifrada (ENCRYPTION_KEY diferente?). ' +
        'A password do `.env` (SMTP_PASS) continua a aplicar-se; guarde a password novamente em Configuração → Email / SMTP.'
    );
    mapa[CHAVES.pass] = '';
  } else {
    mapa[CHAVES.pass] = p.valor;
    if (p.precisaMigrar) await migrarPasswordSmtp(p.valor);
  }
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
    // Sem default inventado: sem smtp_from_name explícito, o From display usa
    // o contexto do condomínio (quando conhecido) ou o fallback global.
    fromName: process.env.SMTP_FROM_NAME || '',
  };
}

// Funde a configuração da BD (prioridade) com a do .env, CAMPO A CAMPO:
// se um valor não vazio existir na BD é usado; caso contrário, usa-se o
// valor do .env (fallback). Isto garante que, por exemplo, uma BD sem
// smtp_pass continua a autenticar com SMTP_PASS do .env — sem nunca
// guardar a password do .env na BD nem expô-la.
function comporConfigSmtp(db, env) {
  const mapaDb = db || {};
  const mapaEnv = env || configEnv();
  const vazio = (v) => v === null || v === undefined || String(v).trim() === '';

  const cfg = {};
  for (const campo of Object.keys(CHAVES)) {
    const chaveDb = CHAVES[campo];
    const valorDb = mapaDb[chaveDb];
    if (!vazio(valorDb)) {
      cfg[campo] = campo === 'pass' ? String(valorDb) : String(valorDb).trim();
    } else {
      cfg[campo] = mapaEnv[campo] === undefined ? '' : mapaEnv[campo];
    }
  }
  return cfg;
}

// Configuração efetiva: BD com prioridade por campo + fallback ao .env.
async function obterConfigSmtp({ force = false } = {}) {
  const agora = Date.now();
  if (!force && _cache.dados && agora - _cache.at < TTL) return _cache.dados;

  let cfg = null;
  try {
    const db = await lerChavesDb();
    cfg = comporConfigSmtp(db, configEnv());
  } catch (err) {
    // BD indisponível → usa apenas o .env
    cfg = comporConfigSmtp({}, configEnv());
  }
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

// Nome contextual do condomínio para o remetente (função pura, testável).
// "O nome do condomínio" é a designação; a administração é apenas recurso
// quando não existe designação (nunca o inverso — o From sem override global
// deve mostrar o condomínio a que o email diz respeito).
function nomeDoCondominioParaRemetente(cond) {
  const designacao = String((cond && cond.designacao) || '').trim();
  if (designacao) return designacao;
  const admin = String((cond && cond.administracao_nome) || '').trim();
  if (admin) return admin;
  return '';
}

// Resolução do nome visível do remetente (função pura, testável).
// Prioridade EXATA:
//   1. displayName explicitamente fornecido no envio;
//   2. smtp_from_name configurado globalmente (override explícito da empresa);
//   3. contexto do condomínio (quando o envio está associado a um condomínio);
//   4. "GesCondu" apenas como último fallback (sem contexto, sem override).
function resolverNomeRemetente({ displayName, fromName, contexto } = {}) {
  const partes = [displayName, fromName, contexto].map((v) => String(v == null ? '' : v).trim());
  const nome = partes.find((v) => v !== '') || 'GesCondu';
  return nome;
}

// Nome visível do remetente (display name) contextualizado pelo condomínio.
// `condominioId` presente → designação (nome) desse condomínio; ausente → ''
// (deixa o fallback global decidir). Nunca usa "o primeiro condomínio da BD".
async function obterNomeRemetente({ condominioId } = {}) {
  const cid = condominioId ? Number(condominioId) : null;
  if (!cid) return '';
  try {
    const { getCondominio } = require('./condominio');
    const c = await getCondominio({ id: cid });
    return nomeDoCondominioParaRemetente(c);
  } catch (err) {
    return '';
  }
}

async function sendMail({ to, subject, text, html, attachments = [], displayName, condominioId }) {
  const cfg = await obterConfigSmtp();
  if (!cfg.host) {
    console.log('[mailer] SMTP não configurado — email NÃO enviado.');
    return { enviado: false, motivo: 'SMTP não configurado' };
  }
  const transport = construirTransporte(cfg);
  // displayName → smtp_from_name (override global explícito) → contexto do
  // condomínio (quando conhecido) → "GesCondu". O contexto vem SEMPRE de
  // condominioId — nunca de "primeiro condomínio" da BD nem de nomes.
  const contexto = condominioId ? await obterNomeRemetente({ condominioId }) : '';
  const nomeRemetente = resolverNomeRemetente({ displayName, fromName: cfg.fromName, contexto });
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
// `condominioId` opcional: quando o teste é feito dentro de um condomínio
// ativo, o nome do remetente respeita a mesma prioridade dos envios reais.
async function enviarEmailTeste({ para, assunto, mensagem, html, condominioId }) {
  try {
    const res = await sendMail({ to: para, subject: assunto, text: mensagem, html, condominioId });
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
//
// `tls` é devolvido como BOOLEANO (e não apenas como a etiqueta `seguranca`):
// o formulário tem de refletir o valor GUARDADO — sem isto, o `<select>` ficava
// com uma opção fixa e gravar (mesmo só para mudar a password) enviava
// `tls=true`, sobrepondo um `smtp_tls='false'` guardado. Ver P50.
async function obterEstadoSmtp() {
  const cfg = await obterConfigSmtp({ force: true });
  const tls = cfg.tls === 'true';
  return {
    configurado: Boolean(cfg.host),
    servidor: cfg.host || null,
    porta: cfg.port || null,
    utilizador: cfg.user || null,
    remetente: cfg.from || null,
    nomeRemetente: cfg.fromName || null,
    tls,
    seguranca: tls ? (String(cfg.port) === '465' ? 'SSL/TLS (465)' : 'STARTTLS (587)') : 'Sem TLS',
    temPassword: Boolean(cfg.pass),
  };
}

// Lê os valores GUARDADOS de `smtp_*` (brutos, sem decifrar a password).
//
// Serve três coisas que dependem do ESTADO e não só da entrada:
//   · V1 (parte 2) e V8 — as regras avaliam o estado EFETIVO (guardado + novo);
//     sem isto, um formulário que só altere o `from` era recusado por «falta de
//     host» mesmo quando já havia um host guardado;
//   · V14 — saber que campos mudaram de facto (nomes, nunca valores);
//   · V13 — detetar que o segredo guardado está ILEGÍVEL.
//
// Leitura estreita (só `smtp_%`) e tolerante: sem BD devolve vazio, e as regras
// passam a avaliar apenas o que foi submetido — nunca se inventam valores.
async function lerGuardadosSmtp() {
  const mapa = {};
  try {
    const rows = await Configuracao.findAll({
      where: { chave: { [Op.like]: 'smtp_%' } },
      attributes: ['chave', 'valor'],
    });
    for (const r of rows) mapa[r.chave] = r.valor;
  } catch (err) {
    // BD indisponível: segue sem estado. A validação continua a correr sobre a
    // entrada submetida e a gravação falhará adiante, como falhava antes.
  }
  return mapa;
}

// Contexto de ESTADO para as regras que dele dependem (V1 parte 2, V8): o host
// é obrigatório em função do remetente/utilizador EFETIVOS, não só dos enviados.
function contextoAtual(guardados) {
  const g = guardados || {};
  return {
    host: g[CHAVES.host],
    port: g[CHAVES.port],
    user: g[CHAVES.user],
    tls: g[CHAVES.tls],
    from: g[CHAVES.from],
  };
}

// Validação SEM escrever. Existe para o endpoint de PREPARAÇÃO da confirmação
// (P54-3): um payload inválido tem de ser recusado ANTES de o servidor emitir
// um token — não faz sentido confirmar o que já se sabe que não pode ser
// gravado. Não lança: devolve o resultado do validador puro.
async function validarConfigSmtp(dados) {
  const guardados = await lerGuardadosSmtp();
  return validacaoSmtp.validarConfigSmtp(dados || {}, { atual: contextoAtual(guardados) });
}

// Guarda a configuração SMTP na BD. A password só é alterada se for
// fornecida (nunca é mostrada nem devolvida).
//
// P54-1 — a configuração é VALIDADA antes de qualquer escrita (V1–V8). Uma
// entrada inválida lança `ErroValidacaoSmtp` e **nada** é gravado. Antes desta
// frente, uma porta `abc`, um `fromName` com `\r\n` ou um `tls='1'` chegavam
// intactos à BD e só se manifestavam no envio seguinte (ou desligavam o TLS em
// silêncio, como no P50).
//
// Um campo AUSENTE continua a significar «não mexer» — é o contrato que a
// interface e os chamadores já têm, e é o que torna a mudança retrocompatível.
//
// P54-3 (V9) — aceita `{ transaction }`. Quando é dada, TODAS as escritas
// acontecem dentro dela e o `limparCache()` passa a ser responsabilidade do
// CHAMADOR, **depois do commit**: limpar a cache antes de a transação confirmar
// deixaria a aplicação a ler a configuração NOVA de uma gravação que ainda
// podia reverter — o pior dos dois mundos.
//
// Devolve `{ ok, alterados, avisos }`:
//   · `alterados` — NOMES dos campos que mudaram (V14). Nunca valores: a
//     password aparece como `pass`, jamais o seu conteúdo;
//   · `avisos` — coerências que NÃO bloqueiam: V8 (TLS numa porta não
//     habitual), V13 (segredo ilegível preservado), V5 (nome saneado).
async function guardarConfigSmtp(dados, { transaction } = {}) {
  const d = dados || {};
  const opcoes = transaction ? { transaction } : undefined;

  const guardados = await lerGuardadosSmtp();
  const v = validacaoSmtp.validarConfigSmtp(d, { atual: contextoAtual(guardados) });

  // ⛔ Fronteira: nada foi escrito até aqui.
  if (!v.ok) throw new validacaoSmtp.ErroValidacaoSmtp(v.erros);

  const avisos = v.avisos.slice();

  const mapa = {};
  if (d.host !== undefined) mapa[CHAVES.host] = v.valores.host;
  // `port` mantém o comportamento anterior: um valor presente mas vazio cai na
  // porta padrão (`587`), tal como `String(dados.port || '587')` fazia.
  if (d.port !== undefined) mapa[CHAVES.port] = v.valores.port;
  if (d.user !== undefined) mapa[CHAVES.user] = v.valores.user;
  if (d.tls !== undefined) mapa[CHAVES.tls] = v.valores.tls;
  if (d.from !== undefined) mapa[CHAVES.from] = v.valores.from;
  if (d.fromName !== undefined) mapa[CHAVES.fromName] = v.valores.fromName;

  if (v.passDefinida) {
    // Só quando o administrador introduz uma password nova (nunca é mostrada
    // nem devolvida). É guardada CIFRADA em repouso; sem chave de cifra fica em
    // texto simples (comportamento anterior) e é emitido um aviso.
    mapa[CHAVES.pass] = segredos.protegerPasswordSmtp(String(d.pass));
  } else {
    // ── V13 — segredo ilegível preservado, com AVISO ────────────────
    // Campo vazio ⇒ a password existente NÃO é apagada (comportamento de
    // sempre). Mas se o valor guardado estiver ILEGÍVEL (chave de cifra
    // diferente, valor adulterado), o operador tem de o SABER: sem o aviso fica
    // convencido de que há uma password configurada quando já não há nenhuma
    // utilizável, e o sintoma aparece só no próximo envio.
    const lido = segredos.lerPasswordSmtp(guardados[CHAVES.pass]);
    if (lido && lido.erro) {
      avisos.push({
        campo: 'pass',
        codigo: 'password_ilegivel_preservada',
        mensagem: 'A password guardada não pôde ser decifrada e foi PRESERVADA sem alterações; '
          + 'introduza uma nova password para a substituir.',
      });
    }
  }

  // V14 — que campos mudam de facto. Nomes apenas; a password nunca é
  // comparada (o que está guardado é cifrado, logo a comparação seria vazia) e
  // entra na lista pelo NOME quando é fornecida uma nova.
  const alterados = [];
  for (const [campo, chave] of Object.entries(CHAVES)) {
    if (campo === 'pass') {
      if (v.passDefinida) alterados.push(campo);
      continue;
    }
    if (mapa[chave] === undefined) continue;
    const antigo = guardados[chave];
    const antigoTxt = antigo === undefined || antigo === null ? '' : String(antigo);
    if (antigoTxt !== String(mapa[chave])) alterados.push(campo);
  }

  for (const [chave, valor] of Object.entries(mapa)) {
    const [reg] = await Configuracao.findOrCreate({
      where: { chave },
      defaults: { valor },
      ...(opcoes || {}),
    });
    if (reg.valor !== valor) {
      reg.valor = valor;
      await reg.save(opcoes);
    }
  }

  // Com transação, a cache só é limpa pelo CHAMADOR, depois do commit (ver o
  // comentário da função): limpar agora serviria uma configuração que ainda
  // pode reverter.
  if (!transaction) limparCache();

  return { ok: true, alterados, avisos };
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
  validarConfigSmtp,
  obterNomeRemetente,
  nomeDoCondominioParaRemetente,
  resolverNomeRemetente,
  comporConfigSmtp,
  limparCache,
  inicializar,
  mensagemErroAmigavel,
};
