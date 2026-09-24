// ─────────────────────────────────────────────────────────────────────
// Email / SMTP — helper transversal.
//
// ── P30 — DOIS ÂMBITOS: GLOBAL e OVERRIDE POR CONDOMÍNIO ────────────
//
// A configuração efetiva resolve-se SEMPRE pela mesma precedência, CAMPO A
// CAMPO (a mesma convenção que o armazenamento, as quotas e as notificações
// já usam — ver `helpers/config-ambito.js`):
//
//   1. override do condomínio  ─ smtp_host:c<ID>
//   2. configuração GLOBAL     ─ smtp_host            (BD)
//   3. variável de ambiente    ─ SMTP_HOST            (.env)
//   4. default do código       ─ porta 587, TLS ligado
//
// ⛔ O SMTP GLOBAL TEM DE CONTINUAR A EXISTIR. Há envios legitimamente SEM
//    condomínio — código 2FA (`routes/auth.js`) e reposição de palavra-passe —
//    que não têm condomínio nenhum a que pertencer. Sem um âmbito global, esses
//    envios não teriam configuração. É esta a razão estrutural do P30 não ser
//    «SMTP por condomínio» mas «GLOBAL COM OVERRIDE».
//
// ⛔ NUNCA se escolhe um condomínio arbitrário. Sem `condominioId` a resolução
//    é global; com `condominioId` é esse condomínio — nunca «o primeiro da BD»,
//    nunca o condomínio ativo de quem desencadeou o envio.
//
// Segurança: a password SMTP nunca é devolvida nem aparece na interface
// (apenas indicador "definida"). Nada de credenciais em logs. O tratamento do
// segredo é EXATAMENTE o mesmo nos dois âmbitos — é o mesmo caminho de código.
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
// P30 — âmbito por condomínio das configurações chave-valor. Reutilizado, e
// NÃO duplicado: a convenção `chave:c<ID>` e a precedência vivem aqui desde o
// P54-7. Duas implementações da mesma regra divergem.
const ambito = require('./config-ambito');
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
// P30 — a cache é POR ÂMBITO. Uma cache única faria a leitura do condomínio 2
// devolver a configuração que o condomínio 1 acabou de gravar (e vice-versa) —
// o pior defeito possível num modelo multi-tenant: contaminação cruzada.
// Chave: o id do condomínio, ou a constante GLOBAL quando não há âmbito.
const GLOBAL = 'global';
const _cache = new Map();

// Cache do âmbito pedido, ou `null` se expirada/ausente.
function lerCache(chave) {
  const c = _cache.get(chave);
  if (!c) return null;
  if (Date.now() - c.at >= TTL) return null;
  return c.dados;
}

function guardarCache(chave, dados) {
  _cache.set(chave, { at: Date.now(), dados });
}

// Substitui a password em texto simples pela versão cifrada (migração
// transparente). Falha em silêncio: o valor continua utilizável em texto
// simples e a tentativa repete-se na leitura seguinte. Sem chave de cifra não
// há nada a migrar.
//
// ⛔ A chave é um PARÂMETRO e não `CHAVES.pass` fixo: é assim que a migração
//    transparente vale igualmente para o override (`smtp_pass:c<ID>`). Sem
//    isto, um override gravado sem chave de cifra nunca migrava e ficava em
//    texto simples para sempre — tratamento DIFERENTE do global, que é
//    exatamente o que o P30 proíbe.
async function migrarPasswordSmtp(texto, chave = CHAVES.pass) {
  if (!texto) return;
  try {
    const valor = segredos.protegerPasswordSmtp(texto);
    if (valor === texto) return; // sem chave: mantém-se como está
    const [reg] = await Configuracao.findOrCreate({ where: { chave }, defaults: { valor } });
    if (reg.valor !== valor) {
      reg.valor = valor;
      await reg.save();
    }
  } catch (err) {
    // Sem chave ou BD indisponível: mantém-se em texto simples.
  }
}

// Aplica à password a MESMA leitura (decifra + migração) em qualquer âmbito.
// Devolve o mapa com a password já em texto simples.
async function lerPasswordDoMapa(mapa, chavePass) {
  const p = segredos.lerPasswordSmtp(mapa[chavePass]);
  if (p.erro) {
    // Segredo ilegível (chave diferente ou valor alterado): um valor não
    // autenticado nunca é usado. Fica sem password e o âmbito seguinte da
    // precedência serve de queda, tal como quando a chave não existe.
    console.warn(
      '[mailer] uma password SMTP guardada não pôde ser decifrada (ENCRYPTION_KEY diferente?). ' +
        'O âmbito seguinte da configuração (global ou `.env`) continua a aplicar-se; ' +
        'guarde a password novamente em Configuração → Email / SMTP.'
    );
    mapa[chavePass] = '';
    return p;
  }
  mapa[chavePass] = p.valor;
  if (p.precisaMigrar) await migrarPasswordSmtp(p.valor, chavePass);
  return p;
}

// Lê as chaves do GLOBAL (`smtp_*`) — exatamente o que sempre fez.
//
// ⛔ O filtro `Op.like: 'smtp_%'` NÃO pode passar a incluir os overrides: em
//    SQL, `smtp_%` casa também com `smtp_host:c7` (o `%` engole o sufixo), pelo
//    que um padrão mais largo traria as configurações de TODOS os condomínios
//    para o mapa global e um override vazaria para os outros. Os overrides são
//    lidos por chave EXATA, em `lerChavesDoCondominio`. `test-smtp-estado.js`
//    fixa este filtro.
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
  await lerPasswordDoMapa(mapa, CHAVES.pass);
  return mapa;
}

// P30 — lê as chaves de OVERRIDE de um condomínio, com os nomes que
// `comporConfigSmtp` já entende (`smtp_host`, `smtp_port`, …).
//
// Devolve um mapa VAZIO quando o condomínio não tem override nenhum — e é
// então que a composição cai no global. Um override inexistente nunca é
// materializado: consultar não cria cópia local do global.
//
// Leitura por chave EXATA (e não por padrão): um `smtp_%:c<ID>` literal — um
// único valor, do condomínio certo — sem risco de arrastar chaves vizinhas.
async function lerChavesDoCondominio(id) {
  const cid = ambito.idCondominio(id);
  if (!cid) return {};
  const sufixo = `:c${cid}`;
  const rows = await Configuracao.findAll({
    // Sem metacaracteres de LIKE: o sufixo é `:c<inteiro>` e o prefixo é
    // `smtp_`. Usar `Op.like` sem `ESCAPE` faria o `\_` casar um sublinhado
    // literal em alguns motores e nada em outros — um comportamento que
    // depende da BD não é uma fronteira. O filtro exato do sufixo é feito
    // ABAIXO, em memória, e é ele que é a fronteira real.
    where: { chave: { [Op.like]: `smtp_%${sufixo}` } },
    attributes: ['chave', 'valor'],
  });
  const mapa = {};
  for (const r of rows) {
    const chave = String(r.chave);
    if (!chave.endsWith(sufixo)) continue;
    const base = chave.slice(0, -sufixo.length);
    if (!base.startsWith('smtp_')) continue; // fronteira: só chaves smtp_*
    mapa[base] = r.valor;
  }
  // Paridade de segredo: a password do override segue o MESMO caminho do global.
  if (Object.prototype.hasOwnProperty.call(mapa, CHAVES.pass)) {
    await lerPasswordDoMapa(mapa, CHAVES.pass);
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
//
// P30 — `db` pode ser o mapa JÁ COMPOSTO de dois níveis (override do condomínio
// sobre o global), como `mesclarChaves` devolve. A função não sabe de âmbito
// nenhum: recebe um mapa e compõe-no com o ambiente. É isso que faz com que a
// precedência override → global → `.env` não precise de duas implementações.
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

// P30 — funde o mapa do OVERRIDE sobre o do GLOBAL, campo a campo.
// Um campo vazio no override (ausente, `null` ou só espaços) NÃO sobrepõe:
// significa «herdar». Assim, um condomínio que só defina o `smtp_host` continua
// a herdar porta, utilizador, password e remetente do global.
//
// ⛔ Esta função é a fronteira do isolamento: os dois mapas vêm de leituras
//    separadas (`lerChavesDb` só `smtp_*` exatos; `lerChavesDoCondominio` só
//    `smtp_*:c<ID>` do condomínio pedido). Nenhum override de outro condomínio
//    chega aqui.
function mesclarChaves(global, doCondominio) {
  const g = global || {};
  const c = doCondominio || {};
  const vazio = (v) => v === null || v === undefined || String(v).trim() === '';
  const resultado = { ...g };
  for (const [chave, valor] of Object.entries(c)) {
    if (!vazio(valor)) resultado[chave] = valor;
  }
  return resultado;
}

// Configuração efetiva. A precedência é CAMPO A CAMPO:
//
//   override do condomínio → global (BD) → `.env` → default do código
//
// `obterConfigSmtp()` sem argumento (ou com `condominioId` inválido/ausente)
// devolve a configuração GLOBAL — é o que os envios sem condomínio (2FA,
// reposição de palavra-passe) precisam. `obterConfigSmtp(cid)` resolve o
// override DESSE condomínio. Nunca se escolhe um condomínio arbitrário.
//
// Aceita as duas formas de chamada, e a posicional vem primeiro de propósito:
// há duplos antigos de `mailer.obterConfigSmtp` nos testes que ignoram os
// argumentos, e um `obterConfigSmtp(7)` que caísse em `{}.condominioId`
// devolveria a configuração global em SILÊNCIO — uma falha aberta.
async function obterConfigSmtp(arg, opcoes = {}) {
  const posicional = arg === undefined || arg === null || typeof arg !== 'object' ? arg : undefined;
  const op = arg && typeof arg === 'object' ? arg : opcoes;
  const { force = false } = op;
  const cid = ambito.idCondominio(posicional !== undefined ? posicional : op.condominioId);
  const chaveCache = cid ? String(cid) : GLOBAL;

  if (!force) {
    const cacheado = lerCache(chaveCache);
    if (cacheado) return cacheado;
  }

  let cfg = null;
  try {
    const env = configEnv();
    if (!cid) {
      const global = await lerChavesDb();
      cfg = comporConfigSmtp(global, env);
    } else {
      // As duas leituras são independentes: em paralelo.
      const [global, doCondominio] = await Promise.all([
        lerChavesDb(),
        lerChavesDoCondominio(cid),
      ]);
      cfg = comporConfigSmtp(mesclarChaves(global, doCondominio), env);
    }
  } catch (err) {
    // BD indisponível → usa apenas o .env
    cfg = comporConfigSmtp({}, configEnv());
  }
  guardarCache(chaveCache, cfg);
  return cfg;
}

// Limpa a cache (após guardar configuração).
//
// P30 — o âmbito decidido pelo chamador é o SUJEITO da gravação, mas o efeito
// da invalidação é mais largo, e de propósito:
//
//   · gravar um OVERRIDE do condomínio 7 invalida **só** o 7 e o GLOBAL.
//     O global porque a sua entrada composta pode ter herdado de um global
//     entretanto alterado por outro processo; os restantes condomínios NÃO são
//     tocados (o override do 7 nunca lhes pertence).
//   · gravar o GLOBAL invalida **TUDO**: qualquer condomínio sem override
//     próprio estava a ler o global, logo a entrada em cache dele ficou obsoleta
//     no instante da gravação. Manter essas entradas era servir uma configuração
//     que já não existe — precisamente o defeito que a precedência por campo
//     torna invisível (o campo herdado só se nota no envio seguinte).
//
// Sem argumento limpa tudo (é o caso da gravação global), para que uma chamada
// esquecida nunca deixe cache envenenada.
function limparCache(condominioId) {
  const cid = ambito.idCondominio(condominioId);
  if (!cid) {
    _cache.clear();
    return;
  }
  _cache.delete(String(cid));
  _cache.delete(GLOBAL);
}

// Estado síncrono simples (usado em views). Reflete o .env ou a última
// configuração lida da BD.
function smtpConfigured() {
  if (process.env.SMTP_HOST) return true;
  for (const c of _cache.values()) {
    if (c.dados && c.dados.host) return true;
  }
  return false;
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
  // P30 — o envio resolve o SMTP do condomínio a que PERTENCE. `condominioId`
  // é a única fonte do âmbito: nunca o condomínio ativo de quem desencadeou o
  // envio, nunca o primeiro da BD. Ausente ⇒ configuração global (é o caso
  // legítimo de 2FA e reposição de palavra-passe).
  const cfg = await obterConfigSmtp(condominioId);
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
//
// P30 — o âmbito é o PRIMEIRO argumento POSICIONAL (`testarLigacao(cid)`), e
// não um objeto: há duplos antigos deste método nos testes que ignoram os
// argumentos, e um `{ condominioId }` que eles descartassem testaria a
// configuração global em vez da do condomínio — em silêncio.
async function testarLigacao(condominioId) {
  const cfg = await obterConfigSmtp(condominioId, { force: true });
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
// ativo, o envio usa a configuração EFETIVA desse condomínio (P30) — testar
// tem de testar o que os envios reais vão mesmo usar — e o nome do remetente
// respeita a mesma prioridade dos envios reais.
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
//
// P30 — aceita o âmbito (`obterEstadoSmtp(cid)`): com condomínio, o estado é o
// EFETIVO desse condomínio (override → global → `.env`), que é o que os envios
// reais vão usar. Sem condomínio, o global.
//
// P30 — `passwordEstado` distingue a ORIGEM da password efetiva, sem revelar
// nada sobre ela:
//   · `propria`     — existe `smtp_pass:c<ID>` neste condomínio;
//   · `herdada`     — não existe override e vale a password global/`.env`;
//   · `ausente`     — não há password utilizável em nenhum âmbito.
// Sem esta distinção, um administrador ficava convencido de ter definido uma
// password quando apenas estava a herdar a da plataforma. ⛔ A origem é dita
// pelo ESTADO — o valor, o tamanho, o hash e a máscara nunca saem daqui.
async function obterEstadoSmtp(condominioId) {
  const cid = ambito.idCondominio(condominioId);
  const cfg = await obterConfigSmtp(cid, { force: true });

  let temPasswordPropria = false;
  if (cid) {
    try {
      const doCondominio = await lerChavesDoCondominio(cid);
      const v = doCondominio[CHAVES.pass];
      temPasswordPropria = v !== null && v !== undefined && String(v) !== '';
    } catch (err) {
      // BD indisponível: não se afirma uma origem que não se pôde verificar.
    }
  }

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
    // `herdada` só quando NÃO há password própria e HÁ uma efetiva para herdar.
    // Uma password própria não é «herdada» mesmo que o global também tenha uma.
    passwordEstado: temPasswordPropria ? 'propria' : (cfg.pass ? 'herdada' : 'ausente'),
    // O condomínio tem override PRÓPRIO (qualquer campo) ou está tudo herdado?
    temOverride: cid ? await temOverrideSmtp(cid) : false,
  };
}

// P30 — o condomínio tem QUALQUER chave `smtp_*:c<ID>` própria?
// É o que permite à consulta dizer «configuração deste condomínio» em vez de
// «configuração global (herdada)» — sem inventar uma cópia local do global só
// porque o administrador abriu a página.
async function temOverrideSmtp(condominioId) {
  const cid = ambito.idCondominio(condominioId);
  if (!cid) return false;
  try {
    const doCondominio = await lerChavesDoCondominio(cid);
    return Object.keys(doCondominio).length > 0;
  } catch (err) {
    return false;
  }
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
//
// P30 — com `condominioId`, lê o estado GUARDADO DESSE ÂMBITO: as chaves
// `smtp_*:c<ID>` do condomínio, com os nomes que o validador entende. É o que
// faz a validação de um override avaliar o override (e não o global): um
// condomínio que só altere o `from` do seu override tem de ser validado contra
// o host do SEU âmbito.
async function lerGuardadosSmtp(condominioId) {
  const cid = ambito.idCondominio(condominioId);
  if (cid) {
    try {
      return await lerChavesDoCondominio(cid);
    } catch (err) {
      return {};
    }
  }
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
//
// P30 — valida no âmbito pedido (o override do condomínio, quando existe).
async function validarConfigSmtp(dados, condominioId) {
  const guardados = await lerGuardadosSmtp(condominioId);
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
// Devolve `{ ok, alterados, avisos, ambito }`:
//   · `alterados` — NOMES dos campos que mudaram (V14). Nunca valores: a
//     password aparece como `pass`, jamais o seu conteúdo;
//   · `avisos` — coerências que NÃO bloqueiam: V8 (TLS numa porta não
//     habitual), V13 (segredo ilegível preservado), V5 (nome saneado);
//   · `ambito` — `'condominio'` com o id, ou `'global'` (P30). É o que permite
//     à auditoria identificar SEM ÂMBITO DE DÚVIDA o que foi alterado.
//
// P30 — O ÂMBITO É EXPLÍCITO NO ARGUMENTO, NUNCA NO CONTEÚDO:
//   · `guardarConfigSmtp(dados)` → GLOBAL (`smtp_*`);
//   · `guardarConfigSmtp(dados, { condominioId: 7 })` → OVERRIDE do condomínio 7
//     (`smtp_*:c7`).
// Um `condominioId` que venha do CORPO do pedido nunca é lido aqui — o âmbito é
// decidido pela ROTA, a partir do tenant da sessão. É esta separação que impede
// que um administrador de condomínio escreva no global, e que um pedido com um
// `condominio_id` arbitrário altere outro tenant: não há caminho de código que
// leve o valor do corpo até à chave gravada.
async function guardarConfigSmtp(dados, { transaction, condominioId } = {}) {
  const d = dados || {};
  const opcoes = transaction ? { transaction } : undefined;

  const cid = ambito.idCondominio(condominioId);
  // Prefixo de chave do âmbito. `null` ⇒ global (`smtp_host`); com condomínio ⇒
  // `smtp_host:c7`, sempre com um id VALIDADO (nunca `:cNaN` nem `:c0`).
  const chaveDe = (base) => (cid ? ambito.chaveDoCondominio(base, cid) : base);

  const guardados = await lerGuardadosSmtp(cid);
  const v = validacaoSmtp.validarConfigSmtp(d, { atual: contextoAtual(guardados) });

  // ⛔ Fronteira: nada foi escrito até aqui.
  if (!v.ok) throw new validacaoSmtp.ErroValidacaoSmtp(v.erros);

  const avisos = v.avisos.slice();

  // Mapa de chaves REAIS (já com o sufixo do âmbito) → valor.
  const mapa = {};
  if (d.host !== undefined) mapa[chaveDe(CHAVES.host)] = v.valores.host;
  // `port` mantém o comportamento anterior: um valor presente mas vazio cai na
  // porta padrão (`587`), tal como `String(dados.port || '587')` fazia.
  if (d.port !== undefined) mapa[chaveDe(CHAVES.port)] = v.valores.port;
  if (d.user !== undefined) mapa[chaveDe(CHAVES.user)] = v.valores.user;
  if (d.tls !== undefined) mapa[chaveDe(CHAVES.tls)] = v.valores.tls;
  if (d.from !== undefined) mapa[chaveDe(CHAVES.from)] = v.valores.from;
  if (d.fromName !== undefined) mapa[chaveDe(CHAVES.fromName)] = v.valores.fromName;

  if (v.passDefinida) {
    // Só quando o administrador introduz uma password nova (nunca é mostrada
    // nem devolvida). É guardada CIFRADA em repouso; sem chave de cifra fica em
    // texto simples (comportamento anterior) e é emitido um aviso.
    //
    // ⛔ Paridade de segredo: a MESMA função do global. Uma password de override
    //    cifrada de outra maneira (ou não cifrada) seria um tratamento diferente
    //    para o mesmo segredo.
    mapa[chaveDe(CHAVES.pass)] = segredos.protegerPasswordSmtp(String(d.pass));
  } else {
    // ── V13 — segredo ilegível preservado, com AVISO ────────────────
    // Campo vazio ⇒ a password existente NÃO é apagada (comportamento de
    // sempre, P54 §5). Mas se o valor guardado estiver ILEGÍVEL (chave de cifra
    // diferente, valor adulterado), o operador tem de o SABER: sem o aviso fica
    // convencido de que há uma password configurada quando já não há nenhuma
    // utilizável, e o sintoma aparece só no próximo envio.
    //
    // ⛔ Campo vazio NÃO significa «herdar a do global». Remover o override de
    //    password é uma operação EXPLÍCITA e separada, que o P30 deliberadamente
    //    NÃO implementa: uma herança acidental por esvaziar um campo seria uma
    //    alteração silenciosa às credenciais de envio do condomínio.
    const lido = segredos.lerPasswordSmtp(guardados[CHAVES.pass]);
    if (lido && lido.erro) {
      avisos.push({
        campo: 'pass',
        codigo: 'password_ilegivel_preservada',
        mensagem: cid
          ? 'A password deste condomínio não pôde ser decifrada e foi PRESERVADA sem alterações; '
            + 'introduza uma nova password para a substituir.'
          : 'A password guardada não pôde ser decifrada e foi PRESERVADA sem alterações; '
            + 'introduza uma nova password para a substituir.',
      });
    }
  }

  // V14 — que campos mudam de facto. Nomes apenas; a password nunca é
  // comparada (o que está guardado é cifrado, logo a comparação seria vazia) e
  // entra na lista pelo NOME quando é fornecida uma nova.
  const alterados = [];
  for (const [campo, base] of Object.entries(CHAVES)) {
    if (campo === 'pass') {
      if (v.passDefinida) alterados.push(campo);
      continue;
    }
    const chave = chaveDe(base);
    if (mapa[chave] === undefined) continue;
    const antigo = guardados[base];
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
  if (!transaction) limparCache(cid);

  return { ok: true, alterados, avisos, ambito: cid ? { tipo: 'condominio', condominioId: cid } : { tipo: 'global' } };
}

// Pré-aquece a cache (chamado no arranque da aplicação).
// P30 — aquece o âmbito GLOBAL apenas. Os overrides são lidos à primeira
// utilização de cada condomínio: aquecer todos obrigaria a varrer `configuracoes`
// por condomínios que podem nem ter override, e o custo aparece no arranque.
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
  obterConfigSmtp,
  guardarConfigSmtp,
  validarConfigSmtp,
  obterNomeRemetente,
  nomeDoCondominioParaRemetente,
  resolverNomeRemetente,
  comporConfigSmtp,
  mesclarChaves,
  lerChavesDoCondominio,
  temOverrideSmtp,
  limparCache,
  inicializar,
  mensagemErroAmigavel,
  CHAVES,
};
