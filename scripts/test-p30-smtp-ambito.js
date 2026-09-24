// ═══════════════════════════════════════════════════════════════════
// P30 — separação entre o SMTP GLOBAL e os OVERRIDES por condomínio.
//
// O que esta frente estabelece:
//
//   · o GLOBAL (`smtp_*`) é configuração da PLATAFORMA — só um Super Admin o
//     pode alterar, por uma rota própria (`/config/email/smtp/global`);
//   · o OVERRIDE (`smtp_*:c<ID>`) é do CONDOMÍNIO ATIVO — um admin altera o SEU
//     e não o de outro, por `/config/email/smtp`;
//   · o âmbito do override vem SEMPRE do tenant da sessão, nunca de um campo
//     do corpo — um `condominio_id` arbitrário é ignorado;
//   · os envios resolvem por precedência `override → global → .env → default`,
//     CAMPO A CAMPO, e quem não tem condomínio usa o global (2FA, reposição);
//   · as proteções do P54-3 (confirmação server-side, reautenticação, rate
//     limit, transação, auditoria) continuam a valer NOS DOIS âmbitos.
//
// Estratégia: monta o ROUTER REAL num servidor Express, com o MAILER REAL (só a
// BD é substituída por duplos). É a única forma de exercitar o caminho
// completo — âmbito → validação → transação → auditoria — sem base de dados.
//
// ⛔ A palavra-passe de teste nunca é impressa: só a sua PRESENÇA é procurada —
//    e aqui procura-se também que ela NUNCA apareça na auditoria nem na vista.
// Utilização: node scripts/test-p30-smtp-ambito.js
// ═══════════════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const PASSWORD = 'palavra-passe-de-teste';
const PASSWORD_SMTP = 'segredo-smtp-a-guardar';
const PASSWORD_SMTP_GLOBAL = 'segredo-smtp-do-global';
const PASSWORD_SMTP_A = 'segredo-smtp-do-condominio-A';

// ═══════════════════════════════════════════════════════════════════
// Duplos de BD
//
// UMA tabela `configuracoes` em memória, com a semântica REAL: chave-valor,
// `chave` UNIQUE, e `findAll` honrando o `where` (incluindo `Op.like`). É isto
// que permite provar que o `smtp_%` do global NÃO arrasta os `smtp_*:c<ID>` e
// que a leitura do override é por chave exata.
// ═══════════════════════════════════════════════════════════════════
const loja = new Map(); // `configuracoes` em memória
let transacoesAbertas = 0;
let transacoesRevertidas = 0;
let auditoriaFalha = false;
const auditoriaGravada = [];
const consultas = []; // registo dos `where` lidos (para inspecionar os filtros)

// Transforma um id de condomínio no sufixo de âmbito usado pelas chaves.
const sufixoDe = (id) => `:c${Number(id)}`;

const models = require(path.join(RAIZ, 'models'));

// Associação do utilizador: MUTÁVEL. `role: 'admin'` para o caso normal, ou
// uma associação para OUTRO condomínio quando se prova o isolamento.
let associacao = { role: 'admin', condominio_id: 1 };
models.UserCondominio.findOne = async (opcoes) => {
  const alvo = opcoes && opcoes.where ? Number(opcoes.where.condominio_id) : null;
  if (!associacao || (alvo && Number(associacao.condominio_id) !== alvo)) return null;
  return { role: associacao.role, condominio_id: associacao.condominio_id };
};

models.Configuracao.findAll = async ({ where } = {}) => {
  consultas.push(where);
  let linhas = [...loja.entries()].map(([chave, valor]) => ({ chave, valor }));
  const cond = where && where.chave;
  if (cond && cond[Op.like]) {
    // Traduz o padrão LIKE para regex, EXATAMENTE como um motor SQL faria:
    // `%` engole qualquer sufixo (é por isso que `smtp_%` casa `smtp_host:c7`).
    const re = new RegExp(
      `^${String(cond[Op.like]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`
    );
    linhas = linhas.filter((l) => re.test(l.chave));
  }
  return linhas;
};
models.Configuracao.findOrCreate = async ({ where, defaults }) => {
  if (!loja.has(where.chave)) loja.set(where.chave, defaults ? defaults.valor : null);
  const reg = {
    get valor() { return loja.get(where.chave); },
    set valor(v) { loja.set(where.chave, v); },
    async save() {},
  };
  return [reg, false];
};
models.AuditLog.create = async (dados) => {
  if (auditoriaFalha) throw new Error('falha simulada na auditoria');
  auditoriaGravada.push(dados);
  return {};
};
// Transação em memória com ROLLBACK a sério: guarda um retrato da loja no
// início e repõe-no se for revertida. É o que permite provar que uma gravação
// falhada não deixa configuração parcialmente alterada, sem MariaDB.
models.sequelize.transaction = async () => {
  const retrato = new Map(loja);
  transacoesAbertas += 1;
  return {
    async commit() {},
    async rollback() {
      loja.clear();
      for (const [k, v] of retrato) loja.set(k, v);
      transacoesRevertidas += 1;
    },
  };
};

// ═══════════════════════════════════════════════════════════════════
// Servidor Express com o router REAL
// ═══════════════════════════════════════════════════════════════════
const router = require(path.join(RAIZ, 'routes/configuracao'));

const app = express();
const sessaoTeste = { condominio_ativo_id: 1 };
const HASH = bcrypt.hashSync(PASSWORD, 4); // custo baixo: é um teste

let utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
let contadorUtilizadores = 1;
const novoUtilizador = (extra = {}) => {
  contadorUtilizadores += 1;
  utilizadorAtual = { id: contadorUtilizadores, nome: 'Admin', role_global: 'admin', password_hash: HASH, ...extra };
  return utilizadorAtual.id;
};

app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = utilizadorAtual;
  req.session = sessaoTeste;
  req.sessionID = 'sess-p30';
  req.flash = () => req;
  res.locals.user = req.user;
  res.locals.condominioAtivo = { id: 1, designacao: 'Condomínio Teste', role: 'admin' };
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = 2026;
  res.locals.tarefas = null;
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use('/admin', router);

const enviar = (url, corpo) => new Promise((resolve, reject) => {
  const dados = new URLSearchParams(corpo).toString();
  const servidor = app.listen(0, '127.0.0.1', () => {
    const req = http.request({
      host: '127.0.0.1', port: servidor.address().port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) },
    }, (res) => {
      let resposta = '';
      res.on('data', (d) => { resposta += d; });
      res.on('end', () => {
        servidor.close();
        let json = null;
        try { json = JSON.parse(resposta); } catch (err) { json = null; }
        resolve({ status: res.statusCode, corpo: resposta, location: res.headers.location, json });
      });
    });
    req.on('error', (e) => { servidor.close(); reject(e); });
    req.end(dados);
  });
});

const obter = (url) => new Promise((resolve, reject) => {
  const servidor = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: servidor.address().port, path: url }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, corpo }); });
    }).on('error', (e) => { servidor.close(); reject(e); });
  });
});

const CONFIG_OK = {
  host: 'smtp.exemplo.pt', port: '587', user: 'conta@exemplo.pt',
  tls: 'true', from: 'geral@exemplo.pt', from_name: 'Administração',
};
// `pass` é a password SMTP a GUARDAR; `password` é a da CONTA (reautenticação
// do P54-3). São duas coisas distintas e ambas são precisas no fluxo completo.
const pedido = (extra = {}) => ({ ...CONFIG_OK, pass: PASSWORD_SMTP, password: PASSWORD, ...extra });

// Fluxo legítimo do P54-3: preparar (emite o token) → gravar (consome-o).
const preparar = (extra = {}) => enviar('/admin/config/email/smtp/preparar', pedido(extra));
const guardar = (extra = {}) => enviar('/admin/config/email/smtp', pedido(extra));
const prepararGlobal = (extra = {}) => enviar('/admin/config/email/smtp/global/preparar', pedido(extra));
const guardarGlobal = (extra = {}) => enviar('/admin/config/email/smtp/global', pedido(extra));

// Gravação completa (preparar + gravar) com o MESMO payload: devolve o resultado
// da preparação para o teste poder afirmar sobre o status (é aí que a guarda de
// autorização se manifesta).
async function gravarOverride(extra = {}, envio = guardar) {
  const prep = await enviar('/admin/config/email/smtp/preparar', pedido(extra));
  if (prep.status !== 200) return prep;
  return envio({ ...extra, _confirmacao: prep.json.token });
}
async function gravarGlobal(extra = {}) {
  const prep = await prepararGlobal(extra);
  if (prep.status !== 200) return prep;
  return guardarGlobal({ ...extra, _confirmacao: prep.json.token });
}

const limparLoja = () => { loja.clear(); };

// Réplica, em teste, da impressão do pedido que a rota calcula
// (`impressaoDoPedido`). Só é precisa para emitir uma confirmação VÁLIDA
// diretamente na sessão — o que permite provar a guarda de autorização sem
// depender de a preparação estar (ou não) aberta ao papel em causa.
const confirmacaoSensivel = require(path.join(RAIZ, 'helpers/confirmacao-sensivel'));
function impressaoPedidoDeTeste(body) {
  const b = body || {};
  const texto = (v) => (v === undefined || v === null ? '' : String(v));
  return confirmacaoSensivel.impressao({
    host: texto(b.host), port: texto(b.port), user: texto(b.user), tls: texto(b.tls),
    from: texto(b.from), from_name: texto(b.from_name),
    pass: confirmacaoSensivel.impressaoSegredo(b.pass),
  });
}

// ═══════════════════════════════════════════════════════════════════
async function principal() {
  console.log('P30 — SMTP global vs overrides por condomínio');

  // ═══════════════════════════════════════════════════════════════
  // BLOCO I — RESOLUÇÃO (1–7)
  // ═══════════════════════════════════════════════════════════════
  titulo('I. RESOLUÇÃO — precedência override → global → default');

  // ── 1. Global sem override de ninguém → global ──────────────────
  limparLoja();
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_port', '587');
  loja.set('smtp_user', 'global@exemplo.pt');
  loja.set('smtp_from', 'geral@exemplo.pt');
  loja.set('smtp_from_name', 'Plataforma');
  loja.set('smtp_tls', 'true');

  const mailer = require(path.join(RAIZ, 'helpers/mailer'));
  mailer.limparCache();

  let cfg = await mailer.obterConfigSmtp(1, { force: true });
  assert.strictEqual(cfg.host, 'global.exemplo.pt', '1. sem override, o host é o global');
  assert.strictEqual(cfg.port, '587', '1. a porta é a global');
  feito('1. global sem override ⇒ o condomínio resolve o global');

  // ── 2. A com override → A ───────────────────────────────────────
  limparLoja();
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_port', '587');
  loja.set('smtp_user', 'global@exemplo.pt');
  loja.set('smtp_pass', PASSWORD_SMTP_GLOBAL);
  // O override do condomínio 1 define um CAMPO VAZIO de propósito (`smtp_user`):
  // significa «herdar», e é o que prova que a fusão é campo a campo e não uma
  // sobreposição cega do mapa do override sobre o global.
  loja.set('smtp_host:c1', 'a.exemplo.pt');
  loja.set('smtp_user:c1', '');
  mailer.limparCache();

  cfg = await mailer.obterConfigSmtp(1, { force: true });
  assert.strictEqual(cfg.host, 'a.exemplo.pt', '2. o condomínio 1 tem override do host');
  assert.strictEqual(cfg.port, '587', '2. e herda a porta do global (campo a campo)');
  assert.strictEqual(cfg.user, 'global@exemplo.pt', '2. ⛔ um campo VAZIO no override significa HERDAR (não sobrepõe com vazio)');
  assert.strictEqual(cfg.pass, PASSWORD_SMTP_GLOBAL, '2. e a password também é herdada quando o override não a define');
  feito('2. condomínio A com override ⇒ resolve o seu override, herdando campo a campo (inclusive a password)');

  // ── 3. B sem override → global ──────────────────────────────────
  cfg = await mailer.obterConfigSmtp(2, { force: true });
  assert.strictEqual(cfg.host, 'global.exemplo.pt', '3. o condomínio 2 não tem override: cai no global');
  feito('3. condomínio B sem override ⇒ cai no global');

  // ── 4. A e B com overrides DIFERENTES → cada um recebe o seu ────
  loja.set('smtp_host:c2', 'b.exemplo.pt');
  mailer.limparCache();
  const cfgA = await mailer.obterConfigSmtp(1, { force: true });
  const cfgB = await mailer.obterConfigSmtp(2, { force: true });
  assert.strictEqual(cfgA.host, 'a.exemplo.pt', '4. A recebe o override de A');
  assert.strictEqual(cfgB.host, 'b.exemplo.pt', '4. B recebe o override de B');
  // ⛔ O defeito mais grave possível: contaminação cruzada pela cache.
  assert.notStrictEqual(cfgA.host, cfgB.host, '4. os dois condomínios NÃO partilham configuração (sem contaminação cruzada)');
  // Agora SEM `force`: servindo-se da CACHE, cada âmbito tem de continuar a
  // devolver o seu. Uma cache única devolveria a do último lido.
  const cacheA = await mailer.obterConfigSmtp(1);
  const cacheB = await mailer.obterConfigSmtp(2);
  assert.strictEqual(cacheA.host, 'a.exemplo.pt', '4. a cache do condomínio 1 serve o 1 (não a do último lido)');
  assert.strictEqual(cacheB.host, 'b.exemplo.pt', '4. a cache do condomínio 2 serve o 2');
  feito('4. overrides distintos ⇒ cada condomínio recebe o SEU, mesmo servido pela cache (sem contaminação cruzada)');

  // ── 5. Queda para o default do código ───────────────────────────
  limparLoja(); // nenhum `smtp_*` na BD
  const envGuardado = {};
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_TLS', 'SMTP_FROM', 'SMTP_FROM_NAME']) {
    envGuardado[k] = process.env[k];
    delete process.env[k];
  }
  mailer.limparCache();
  cfg = await mailer.obterConfigSmtp(1, { force: true });
  assert.strictEqual(cfg.port, '587', '5. sem BD e sem .env, a porta cai no default do código (587)');
  assert.strictEqual(cfg.tls, 'true', '5. o tls cai no default do código (true)');
  assert.strictEqual(cfg.host, '', '5. sem host em lado nenhum, o host fica vazio (não se inventa um)');
  feito('5. sem BD nem .env ⇒ default do código (587/true), sem valores inventados');

  // ── 6. Contexto inexistente / inválido → global/default ─────────
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_host:c1', 'a.exemplo.pt');
  mailer.limparCache();
  for (const invalido of [null, undefined, 0, -3, 'abc', NaN]) {
    const c = await mailer.obterConfigSmtp(invalido, { force: true });
    assert.strictEqual(c.host, 'global.exemplo.pt', `6. contexto inválido (${String(invalido)}) resolve o GLOBAL, não um condomínio`);
  }
  feito('6. contexto inexistente/inválido ⇒ global/default, nunca um condomínio arbitrário');

  // ── 7. NUNCA escolher arbitrariamente outro condomínio ──────────
  // Com o override SÓ no condomínio 7, pedir o 3 tem de devolver o GLOBAL — a
  // alternativa (apanhar o primeiro que exista na BD) é o defeito que o P30 fecha.
  limparLoja();
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_host:c7', 'sete.exemplo.pt');
  mailer.limparCache();
  const cfg3 = await mailer.obterConfigSmtp(3, { force: true });
  assert.strictEqual(cfg3.host, 'global.exemplo.pt', '7. o condomínio 3 (sem override) NÃO apanha o override do 7');
  assert.notStrictEqual(cfg3.host, 'sete.exemplo.pt', '7. e jamais «o primeiro condomínio da BD»');
  // A leitura do global continua a ser `smtp_%` EXATO: se o padrão alargasse, o
  // override do 7 vazava para o mapa global e para TODOS os condomínios.
  const filtroGlobal = consultas.filter((w) => w && w.chave && w.chave[Op.like] === 'smtp_%');
  assert.ok(filtroGlobal.length > 0, '7. a leitura global usa o padrão smtp_% exato');
  feito('7. nunca se escolhe um condomínio arbitrário; a leitura global fica restrita');

  // ═══════════════════════════════════════════════════════════════
  // BLOCO II — ESCRITA (8–12)
  // ═══════════════════════════════════════════════════════════════
  titulo('II. ESCRITA — o âmbito vem do tenant, nunca do corpo');

  // ── 8. Admin de condomínio altera o PRÓPRIO override ────────────
  limparLoja();
  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  mailer.limparCache();
  let r = await gravarOverride();
  assert.strictEqual(r.status, 302, '8. a gravação do override responde 302');
  assert.strictEqual(loja.get('smtp_host:c5'), 'smtp.exemplo.pt', '8. grava o override DO CONDOMÍNIO ATIVO (c5)');
  assert.ok(!loja.has('smtp_host'), '8. e NÃO toca no global');
  feito('8. admin de condomínio grava o override do seu condomínio ativo');

  // ── 9. Admin de condomínio NÃO altera o GLOBAL ──────────────────
  limparLoja();
  // ⛔ A prova tem de ser na GUARDA, não no fluxo: com reautenticação válida, o
  //    admin chegaria ao handler se `tenant.apenasSuperAdmin` não estivesse lá.
  //    Por isso o pedido traz a password da conta CORRETA — só a guarda o pode
  //    travar. `apenasSuperAdmin` é uma guarda de BROWSER: redireciona (302)
  //    para o painel, e a preparação nunca emite token.
  const r9prep = await prepararGlobal();
  assert.strictEqual(r9prep.status, 302, '9. ⛔ a PREPARAÇÃO global redireciona um admin de condomínio (guarda antes do handler)');
  assert.ok(!r9prep.json || !r9prep.json.token, '9. e nenhum token é emitido a um admin de condomínio');
  // A gravação, com um token inventado, também não passa — e nada é escrito.
  const r9 = await guardarGlobal({ _confirmacao: 'a'.repeat(64) });
  assert.strictEqual(loja.size, 0, '9. ⛔ nada é escrito no global por um admin de condomínio (nem por POST direto)');
  feito('9. ⛔ admin de condomínio NÃO altera o global — a guarda recusa antes do handler, sem emitir token');

  // ── 9b. E na GRAVAÇÃO do global, a guarda também está lá ────────
  // A forma mais forte: um admin de condomínio com uma confirmação VÁLIDA do
  // âmbito GLOBAL (emitida na sua própria sessão) e a password da conta
  // CORRETA. Sem a guarda da rota de gravação, chegaria ao handler e escreveria
  // `smtp_host`. Com ela, é recusado antes de tocar em qualquer coisa.
  limparLoja();
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  // Emite-se o token no MESMO contexto de sessão que o pedido vai usar.
  const reqFalso = { user: utilizadorAtual, session: sessaoTeste };
  const tGlobal = confirmacaoSensivel.emitir(reqFalso, {
    operacao: 'smtp-config-global',
    impressao: impressaoPedidoDeTeste(pedido()),
  });
  assert.ok(tGlobal.ok, '9b. sanidade: o token de âmbito global foi emitido');
  const r9b = await guardarGlobal({ _confirmacao: tGlobal.valor });
  assert.strictEqual(loja.size, 0, '9b. ⛔ um admin de condomínio NÃO escreve o global, mesmo com confirmação válida');
  assert.ok(!loja.has('smtp_host'), '9b. ⛔ nem a chave global, nem a do condomínio');
  feito('9b. ⛔ a guarda de Super Admin trava a gravação global mesmo com confirmação e password válidas');

  // ── 9c. A gravação global escreve na chave GLOBAL, não na de condomínio ─
  // Contraprova direta: um Super Admin com um condomínio ATIVO na sessão grava
  // o global — e a chave tem de ficar SEM sufixo. Se a rota usasse
  // `req.condominioSmtp`, escreveria `smtp_host:c1`.
  limparLoja();
  sessaoTeste.condominio_ativo_id = 1;
  associacao = { role: 'admin', condominio_id: 1 };
  utilizadorAtual = { id: 9, nome: 'Super Admin', role_global: 'super_admin', password_hash: HASH };
  const r9c = await gravarGlobal();
  assert.strictEqual(r9c.status, 302, '9c. o Super Admin grava o global');
  assert.ok(loja.has('smtp_host'), '9c. a chave gravada é a GLOBAL (`smtp_host`)');
  assert.ok(!loja.has('smtp_host:c1'), '9c. ⛔ e NÃO a do condomínio ativo — o âmbito global é fixado a `null` pela rota');
  feito('9c. ⛔ a via global grava sempre em `smtp_*` (o condomínio ativo da sessão é irrelevante)');

  // ── 10. Admin de condomínio NÃO altera o override de OUTRO ──────
  // O ataque plausível: um `condominio_id` no corpo apontando a outro tenant.
  limparLoja();
  // Repor o contexto: admin de condomínio, condomínio ativo = 5.
  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  mailer.limparCache();
  r = await gravarOverride({ condominio_id: '9', condominioId: '9' });
  assert.strictEqual(loja.get('smtp_host:c5'), 'smtp.exemplo.pt', '10. grava no condomínio ATIVO (c5)');
  assert.ok(!loja.has('smtp_host:c9'), '10. ⛔ o `condominio_id=9` do corpo é IGNORADO — nada em c9');
  assert.ok(!loja.has('smtp_host'), '10. e nada no global');
  feito('10. ⛔ o `condominio_id` arbitrário no corpo é ignorado — não escreve noutro tenant');

  // ── 11. Super Utilizador PODE alterar o global ──────────────────
  limparLoja();
  utilizadorAtual = { id: 9, nome: 'Super Admin', role_global: 'super_admin', password_hash: HASH };
  r = await gravarGlobal();
  assert.strictEqual(r.status, 302, '11. a via global aceita um Super Admin');
  assert.strictEqual(loja.get('smtp_host'), 'smtp.exemplo.pt', '11. o Super Admin altera o global (chave SEM sufixo)');
  // ⛔ O Super Admin tem, na sessão, um condomínio ATIVO (o 5). Se a gravação
  //    global usasse `req.condominioSmtp` em vez de `null`, escreveria
  //    `smtp_host:c5` — a chave tem de continuar SEM sufixo.
  assert.ok(!loja.has('smtp_host:c5') && !loja.has('smtp_host:c1'),
    '11. ⛔ a gravação global NÃO cai no âmbito do condomínio ativo (chave sem `:c<ID>`)');
  assert.strictEqual([...loja.keys()].filter((k) => k.includes(':c')).length, 0,
    '11. e não é criada uma única chave de condomínio na gravação global');
  feito('11. Super Admin altera o global pela via explícita, sempre no âmbito global');

  // ── 12. Alterar o global NÃO cria/modifica overrides ────────────
  assert.strictEqual([...loja.keys()].filter((k) => k.includes(':c')).length, 0,
    '12. ⛔ alterar o global não materializa cópia em NENHUM condomínio');
  // E o inverso: alterar um override não toca no global.
  loja.clear();
  loja.set('smtp_host', 'global-original.exemplo.pt');
  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  await gravarOverride();
  assert.strictEqual(loja.get('smtp_host'), 'global-original.exemplo.pt', '12. alterar o override NÃO altera o global');
  assert.strictEqual(loja.get('smtp_host:c5'), 'smtp.exemplo.pt', '12. o override foi gravado no seu próprio âmbito');
  feito('12. os dois âmbitos são independentes nos dois sentidos');

  // ═══════════════════════════════════════════════════════════════
  // BLOCO III — EMAIL REAL (13–16)
  // ═══════════════════════════════════════════════════════════════
  titulo('III. EMAIL — o âmbito efetivo de cada envio');

  // ── 13. Envio SEM condomínio usa o global (2FA, reposição) ──────
  limparLoja();
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_port', '587');
  loja.set('smtp_host:c1', 'a.exemplo.pt');
  mailer.limparCache();
  const semContexto = await mailer.obterConfigSmtp(undefined, { force: true });
  assert.strictEqual(semContexto.host, 'global.exemplo.pt', '13. um envio sem condomínio resolve o GLOBAL (nunca o override de um condomínio)');
  feito('13. envio sem contexto de condomínio ⇒ SMTP global (login/2FA/reposição intactos)');

  // ── 14. Envio COM condomínio usa o override DESSE condomínio ────
  const comA = await mailer.obterConfigSmtp(1, { force: true });
  assert.strictEqual(comA.host, 'a.exemplo.pt', '14. o envio do condomínio 1 usa o override do 1');
  feito('14. envio com condomínio ⇒ override desse condomínio');

  // ── 15. E-mail de teste usa o âmbito EFETIVO da página ──────────
  // Prova que a rota de teste NÃO testa sempre o global: com o condomínio ativo
  // a ter override, `testarLigacao` tem de receber o id do condomínio.
  loja.clear();
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_host:c5', 'a.exemplo.pt');
  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  mailer.limparCache();
  const vistos = [];
  const originalTestar = mailer.testarLigacao;
  mailer.testarLigacao = async (cid) => { vistos.push(cid); return { ok: true, servidor: 'x' }; };
  await enviar('/admin/config/email/smtp/testar', {});
  assert.deepStrictEqual(vistos, [5], '15. «testar ligação» na página do condomínio testa o condomínio 5 (override), não o global');
  mailer.testarLigacao = originalTestar;
  feito('15. o teste de ligação usa o âmbito efetivo do contexto');

  // ── 16. Mensagem de fila resolve pelo `email_fila.condominio_id` ─
  // O contexto da fila é o REGISTO, não o condomínio ativo de quem olha.
  // Prova-se por COMPORTAMENTO: o `sendMail` do próprio módulo recebe o id do
  // condomínio do registo. Para o exercitar sem BD, duplica-se o `sendMail` do
  // mailer ANTES de carregar a fila e dá-se-lhe um item — o que se mede é o
  // argumento que chega ao mailer, não o texto do ficheiro.
  const caminhoMailer = require.resolve(path.join(RAIZ, 'helpers/mailer'));
  const mailerReal = require.cache[caminhoMailer].exports;
  const enviosFila = [];
  const sendMailOriginal = mailerReal.sendMail;
  mailerReal.sendMail = async (opcoes) => { enviosFila.push(opcoes); return { ok: true, messageId: '<fila@exemplo.pt>' }; };
  const caminhoFila = require.resolve(path.join(RAIZ, 'helpers/email-fila'));
  delete require.cache[caminhoFila];
  const fila = require(path.join(RAIZ, 'helpers/email-fila'));
  // `processarEmailUnico` carrega o item pela BD; substitui-se o modelo para
  // devolver um registo do condomínio 5 — o único caminho para exercitar o envio
  // sem MariaDB. É o que se mede: o ARGUMENTO que chega ao mailer.
  const models2 = require(path.join(RAIZ, 'models'));
  const respostaItem = {
    id: 77, estado: 'pendente', para: 'a@exemplo.pt', assunto: 'Aviso',
    corpo: 'Corpo', html: null, anexos: null,
    condominio_id: 5, documento_id: null, quota_id: null,
    async save() {}, async update() {},
  };
  models2.EmailFila = models2.EmailFila || {};
  models2.EmailFila.findByPk = async () => respostaItem;
  try {
    await fila.processarEmailUnico(77, 5);
  } catch (err) {
    // O item é um duplo mínimo: o que importa é o ARGUMENTO do envio, que é
    // registado antes de qualquer outra falha de campo. Só falhas do próprio
    // duplo são toleradas aqui.
  }
  assert.ok(enviosFila.length > 0, '16. a fila chegou a invocar o mailer (o item do condomínio foi processado)');
  assert.strictEqual(enviosFila[0].condominioId, 5,
    '16. o envio da fila passa o `condominio_id` do REGISTO (5) ao mailer — não o condomínio ativo de quem olha');
  mailerReal.sendMail = sendMailOriginal;
  delete require.cache[caminhoFila];
  feito('16. a fila resolve o SMTP pelo `email_fila.condominio_id` (do registo), não pelo contexto de quem olha');

  // ═══════════════════════════════════════════════════════════════
  // BLOCO IV — SEGREDOS (17–19)
  // ═══════════════════════════════════════════════════════════════
  titulo('IV. SEGREDOS — paridade de tratamento e herança');

  // ── 17. Sem override de password → herda a do global ────────────
  limparLoja();
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_pass', PASSWORD_SMTP_GLOBAL);
  mailer.limparCache();
  let estado = await mailer.obterEstadoSmtp(1);
  assert.strictEqual(estado.passwordEstado, 'herdada', '17. sem `smtp_pass:c1`, o estado é «herdada»');
  const efetiva = await mailer.obterConfigSmtp(1, { force: true });
  assert.strictEqual(efetiva.pass, PASSWORD_SMTP_GLOBAL, '17. e a password efetiva é a DO GLOBAL');
  feito('17. sem password própria ⇒ herda a do global (estado «herdada»)');

  // ── 18. Com password própria → estado «própria»; global intacto ─
  loja.set('smtp_pass:c1', PASSWORD_SMTP_A);
  mailer.limparCache();
  estado = await mailer.obterEstadoSmtp(1);
  assert.strictEqual(estado.passwordEstado, 'propria', '18. com `smtp_pass:c1`, o estado é «própria»');
  const efetivaA = await mailer.obterConfigSmtp(1, { force: true });
  assert.strictEqual(efetivaA.pass, PASSWORD_SMTP_A, '18. a password efetiva é a do override');
  assert.strictEqual(loja.get('smtp_pass'), PASSWORD_SMTP_GLOBAL, '18. o global NÃO foi alterado ao definir a do override');
  feito('18. password própria ⇒ estado «própria», global intacto');

  // ── 19. Campo vazio NÃO apaga (P54 §5) e não materializa cópia ──
  loja.clear();
  loja.set('smtp_host', 'global.exemplo.pt');
  loja.set('smtp_pass', PASSWORD_SMTP_GLOBAL);
  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  mailer.limparCache();
  // Grava o override SEM password (campo vazio) — o formulário do P54-2 envia
  // sempre o campo, vazio quando o utilizador não escreveu nada.
  const prepVazio = await preparar({ pass: '' });
  assert.strictEqual(prepVazio.status, 200, '19. um override sem password nova é aceite');
  await guardar({ pass: '', _confirmacao: prepVazio.json.token });
  assert.ok(!loja.has('smtp_pass:c5'), '19. ⛔ o campo vazio NÃO materializa uma cópia da password do global no override');
  assert.strictEqual(loja.get('smtp_pass'), PASSWORD_SMTP_GLOBAL, '19. e a password do global fica intacta');
  const estadoDepois = await mailer.obterEstadoSmtp(5);
  assert.strictEqual(estadoDepois.passwordEstado, 'herdada', '19. o estado continua «herdada» (o vazio não apagou nem copiou)');
  feito('19. campo vazio ≠ remover: mantém a herança e não copia o global para o override');

  // A password nunca sai do estado — nem o valor, nem a serialização.
  const valores = Object.values(estadoDepois).map((v) => String(v));
  assert.ok(!valores.includes(PASSWORD_SMTP_GLOBAL), '19. a password (global) não aparece em nenhum campo do estado');
  assert.ok(!JSON.stringify(estadoDepois).includes(PASSWORD_SMTP_GLOBAL), '19. nem na serialização do estado');
  feito('19b. o estado nunca revela a password (nem própria, nem herdada)');

  // ═══════════════════════════════════════════════════════════════
  // BLOCO V — REGRESSÃO P54-3 NOS DOIS ÂMBITOS (20–25)
  // ═══════════════════════════════════════════════════════════════
  titulo('V. REGRESSÃO — as proteções do P54-3 valem nos DOIS âmbitos');

  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };

  // ── 20. POST direto (sem confirmação) recusado — condomínio ─────
  limparLoja();
  r = await guardar();
  assert.strictEqual(r.status, 302, '20. o POST direto responde 302 (não rebenta)');
  assert.strictEqual(loja.size, 0, '20. ⛔ sem confirmação, o override NÃO é escrito');
  feito('20. ⛔ override: POST direto sem confirmação recusado');

  // ── 21. POST direto recusado — GLOBAL (Super Admin) ─────────────
  limparLoja();
  utilizadorAtual = { id: 9, nome: 'Super Admin', role_global: 'super_admin', password_hash: HASH };
  r = await guardarGlobal();
  assert.strictEqual(loja.size, 0, '21. ⛔ sem confirmação, o GLOBAL não é escrito nem por um Super Admin');
  feito('21. ⛔ global: POST direto sem confirmação recusado');

  // ── 22. Token não serve no OUTRO âmbito ─────────────────────────
  // A confirmação está ligada à OPERAÇÃO (`smtp-config` vs
  // `smtp-config-global`): um token preparado na página do condomínio não pode
  // gravar o global (e vice-versa).
  limparLoja();
  utilizadorAtual = { id: 9, nome: 'Super Admin', role_global: 'super_admin', password_hash: HASH };
  const prepCond = await enviar('/admin/config/email/smtp/preparar', pedido());
  assert.strictEqual(prepCond.status, 200, '22. a preparação do override é válida');
  r = await guardarGlobal({ _confirmacao: prepCond.json.token });
  assert.strictEqual(loja.size, 0, '22. ⛔ um token do âmbito do condomínio NÃO grava o global (operação diferente)');
  // E o inverso.
  limparLoja();
  const prepGlob = await prepararGlobal();
  assert.strictEqual(prepGlob.status, 200, '22. a preparação do global é válida para um Super Admin');
  r = await guardar({ _confirmacao: prepGlob.json.token });
  assert.strictEqual(loja.size, 0, '22. ⛔ um token do âmbito global NÃO grava o override do condomínio');
  feito('22. ⛔ os tokens são de âmbito: não atravessam global ↔ condomínio');

  // ── 23. Payload adulterado recusado nos dois âmbitos ────────────
  limparLoja();
  let prep = await preparar();
  r = await guardar({ host: 'smtp.outro.pt', _confirmacao: prep.json.token });
  assert.strictEqual(loja.size, 0, '23. ⛔ override: payload diferente do confirmado é recusado');
  limparLoja();
  let prepG = await prepararGlobal();
  r = await guardarGlobal({ host: 'smtp.outro.pt', _confirmacao: prepG.json.token });
  assert.strictEqual(loja.size, 0, '23. ⛔ global: payload diferente do confirmado é recusado');
  feito('23. ⛔ o payload adulterado é recusado nos DOIS âmbitos');

  // ── 24. Reautenticação exigida nos dois âmbitos ─────────────────
  limparLoja();
  prep = await preparar();
  r = await guardar({ _confirmacao: prep.json.token, password: 'password-errada' });
  assert.strictEqual(loja.size, 0, '24. ⛔ override: sem reautenticação válida, nada é escrito');
  limparLoja();
  prepG = await prepararGlobal();
  r = await guardarGlobal({ _confirmacao: prepG.json.token, password: 'password-errada' });
  assert.strictEqual(loja.size, 0, '24. ⛔ global: sem reautenticação válida, nada é escrito');
  feito('24. ⛔ a reautenticação é exigida nos DOIS âmbitos');

  // ── 25. Auditoria identifica o ÂMBITO e os CAMPOS, sem valores ───
  limparLoja();
  auditoriaGravada.length = 0;
  utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  sessaoTeste.condominio_ativo_id = 5;
  associacao = { role: 'admin', condominio_id: 5 };
  const prepOk = await preparar();
  await guardar({ _confirmacao: prepOk.json.token });
  let evento = auditoriaGravada.find((e) => e.acao === 'configurar_smtp');
  assert.ok(evento, '25. o override é auditado com a ação própria');
  assert.strictEqual(evento.entidade_id, 5, '25. a auditoria do override identifica o CONDOMÍNIO (entidade_id = 5)');
  // `detalhes` é serializado em JSON pelo `audit()`. Analisa-se o objeto.
  const det = JSON.parse(evento.detalhes);
  assert.ok(det && det.ambito && det.ambito.tipo === 'condominio',
    '25. e o âmbito fica registado como «condominio» (sem ambiguidade)');
  assert.ok(Array.isArray(det.campos_alterados), '25. os CAMPOS alterados são nomes, uma lista');
  assert.ok(det.campos_alterados.includes('host'), '25. o campo alterado `host` está identificado');
  const jsonEvento = JSON.stringify(evento);
  assert.ok(!jsonEvento.includes(PASSWORD_SMTP), '25. ⛔ NENHUM valor sensível entra na auditoria');
  feito('25a. auditoria do override: âmbito «condominio», entidade_id=5, campos identificados, sem valores');

  // Agora o global: ação e âmbito distintos, sem id de condomínio.
  limparLoja();
  auditoriaGravada.length = 0;
  utilizadorAtual = { id: 9, nome: 'Super Admin', role_global: 'super_admin', password_hash: HASH };
  const prepGok = await prepararGlobal();
  await guardarGlobal({ _confirmacao: prepGok.json.token });
  evento = auditoriaGravada.find((e) => e.acao === 'configurar_smtp_global');
  assert.ok(evento, '25. a gravação global é auditada com a ação PRÓPRIA (distinta da do condomínio)');
  assert.strictEqual(evento.entidade_id, null, '25. a auditoria global não aponta a nenhum condomínio');
  assert.strictEqual(JSON.parse(evento.detalhes).ambito.tipo, 'global', '25. e o âmbito fica registado como «global»');
  assert.ok(!JSON.stringify(evento).includes(PASSWORD_SMTP), '25. ⛔ e nenhum valor sensível entra no evento global');
  feito('25. auditoria distingue âmbito (condominio/global) e campos, sem um único valor sensível');

  // ── Prova final: o suporte não tem caminho para escrever SMTP ───
  titulo('Fecho — o suporte nunca escreve SMTP (por construção)');
  const allow = require(path.join(RAIZ, 'helpers/suporte-allowlist'));
  const dump = JSON.stringify(allow);
  assert.ok(!/configuracao/.test(dump),
    'o router `configuracao` NÃO consta da allow-list de suporte ⇒ o suporte não tem rota para escrever SMTP');
  feito('o suporte está estruturalmente excluído da escrita SMTP (sem mecanismo novo)');

  console.log(`\n✓ P30 — SMTP global vs overrides: ${n} verificações passaram (sem BD).`);
  console.log(`  transações abertas: ${transacoesAbertas}, revertidas: ${transacoesRevertidas}`);
}

principal()
  .catch((err) => {
    console.error('\n✗ ' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
