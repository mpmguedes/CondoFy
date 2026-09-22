// ═══════════════════════════════════════════════════════════════════
// Central de Emails — filtro por PERÍODO aplicado à CONSULTA (sem BD).
//
// Monta o router REAL (`routes/emails.js`) num servidor Express com o mesmo
// motor de vistas do `app.js` e observa a CONSULTA que o handler constrói.
//
// O que este teste prova, e que nenhuma asserção de HTML poderia provar:
//
//   1. o período vai ao `where` (`createdAt BETWEEN ? AND ?`) — é um filtro de
//      CONSULTA, não um esconderijo de linhas no frontend;
//   2. o intervalo por omissão é o MÊS EM CURSO até hoje;
//   3. os atalhos e as datas escritas mudam o intervalo efetivamente aplicado;
//   4. o isolamento (`condominio_id` do condomínio ativo) mantém-se, e o
//      período NÃO contamina as contagens da fila;
//   5. a consulta continua a ser UMA só (sem N+1) e com as mesmas associações;
//   6. a configuração SMTP e o envio de teste JÁ NÃO EXISTEM neste router —
//      responderam 404 e não constam do `router.stack`.
//
// Utilização: node scripts/test-emails-filtro.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');

// ── Duplos por `require.cache` (TÊM de ser instalados antes do router) ──
function duplo(rel, valor) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// Isolamento: `comCondominioAtivo` (REAL) decide o condomínio pela sessão; aqui
// fixa-se o condomínio ativo para o teste poder observar o `where`.
duplo('helpers/tenant', {
  comCondominioAtivo: (req, res, next) => { req.condominioId = 1; req.papelCondominio = 'admin'; next(); },
});

// A admissão de suporte não é objeto deste teste (tem testes próprios:
// `test-allow-list-suporte.js`, `test-t4-suporte-isolamento.js`).
duplo('helpers/suporte-allowlist', {
  soDiagnostico: () => (req, res, next) => next(),
  comPapelOuSuporteAdmitido: () => (req, res, next) => next(),
});

// Models: só o `findAll` da fila é observado (é ele que leva o filtro).
const models = require('../models');
const consultas = [];
models.EmailFila.findAll = async (opcoes) => { consultas.push(opcoes); return []; };

// Contagens da fila: iriam à BD. O que interessa é com que argumentos é chamada.
const contagensPedidas = [];
const emailFila = require('../helpers/email-fila');
emailFila.contarFila = async (args) => {
  contagensPedidas.push(args);
  return { total: 0, pendentes: 0, enviados: 0, erros: 0, cancelados: 0 };
};

// Estado SMTP e preferências: iriam à BD.
const mailer = require('../helpers/mailer');
let SMTP_CONFIGURADO = true;
mailer.obterEstadoSmtp = async () => ({
  configurado: SMTP_CONFIGURADO,
  servidor: SMTP_CONFIGURADO ? 'smtp.gmail.com' : null,
  porta: SMTP_CONFIGURADO ? '587' : null,
  utilizador: SMTP_CONFIGURADO ? 'condominio@gmail.com' : null,
  remetente: SMTP_CONFIGURADO ? 'condominio@gmail.com' : null,
  nomeRemetente: SMTP_CONFIGURADO ? 'Administração' : null,
  seguranca: 'STARTTLS (587)',
  temPassword: SMTP_CONFIGURADO,
});
const notificacoes = require('../helpers/notificacoes');
notificacoes.listarPreferencias = async () => [];

// ── Router real ────────────────────────────────────────────────────
const router = require('../routes/emails');

// ── App de teste com o mesmo motor de vistas do app.js ─────────────
const app = express();
app.engine('handlebars', engine({
  defaultLayout: 'main',
  helpers: require('../helpers/handlebars-helpers'),
  layoutsDir: path.join(RAIZ, 'views', 'layouts'),
  partialsDir: path.join(RAIZ, 'views', 'partials'),
  runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
}));
app.set('view engine', 'handlebars');
app.set('views', path.join(RAIZ, 'views'));

app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = { id: 1, nome: 'Administrador', email: 'admin@exemplo.pt' };
  req.session = { condominio_ativo_id: 1 };
  req.flash = () => req;
  res.locals.user = req.user;
  res.locals.isAdmin = true;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = { id: 1, designacao: 'Condomínio de Teste', role: 'admin' };
  res.locals.condominio = { id: 1, designacao: 'Condomínio de Teste' };
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = new Date().getFullYear();
  res.locals.tarefas = null;
  res.locals.armazenamentoIcone = 'bi bi-cloud-arrow-up';
  res.locals.armazenamentoRotulo = 'serviço de armazenamento';
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use('/admin', router);

const pedir = (url) => new Promise((resolve, reject) => {
  const servidor = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: servidor.address().port, path: url }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, corpo, location: res.headers.location }); });
    }).on('error', (e) => { servidor.close(); reject(e); });
  });
});

const enviar = (url) => new Promise((resolve, reject) => {
  const dados = '';
  const servidor = app.listen(0, '127.0.0.1', () => {
    const req = http.request({
      host: '127.0.0.1',
      port: servidor.address().port,
      path: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) },
    }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, corpo }); });
    });
    req.on('error', (e) => { servidor.close(); reject(e); });
    req.end(dados);
  });
});

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// O intervalo aplicado na última consulta, em instantes.
const intervaloAplicado = () => {
  const onde = consultas[consultas.length - 1].where;
  assert.ok(onde && onde.createdAt, 'a consulta tem de filtrar por `createdAt`');
  const iv = onde.createdAt[Op.between];
  assert.ok(Array.isArray(iv) && iv.length === 2, '`createdAt` filtrado por intervalo [início, fim]');
  return iv;
};

(async () => {
  // ── 1. Por omissão: mês em curso até hoje, aplicado na consulta ────
  titulo('T1 — por omissão, o período vai ao `where` (mês em curso até hoje)');
  consultas.length = 0;
  contagensPedidas.length = 0;
  const agora = new Date();
  let r = await pedir('/admin/emails');
  assert.strictEqual(r.status, 200, 'GET /admin/emails responde 200');
  assert.strictEqual(consultas.length, 1, 'uma só consulta à fila (sem N+1)');
  assert.strictEqual(contagensPedidas.length, 1, 'as contagens são pedidas uma vez');

  const [de, ate] = intervaloAplicado();
  // Derivação INDEPENDENTE do módulo (não se reutiliza `resolverPeriodo`).
  assert.strictEqual(de.getTime(), new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0, 0).getTime(),
    'data inicial = 1.º dia do mês em curso, à meia-noite local');
  assert.strictEqual(ate.getTime(), new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999).getTime(),
    'data final = hoje, ao fim do dia local');
  feito('intervalo por omissão = mês em curso até hoje, dentro do `where`');

  // Isolamento e associações preservadas.
  assert.strictEqual(consultas[0].where.condominio_id, 1, 'a consulta continua isolada pelo condomínio ativo');
  assert.deepStrictEqual(consultas[0].include.map((i) => i.as), ['documento', 'aviso', 'utilizador'],
    'as associações da listagem mantêm-se (documento, aviso, utilizador)');
  assert.deepStrictEqual(consultas[0].order, [['id', 'DESC']], 'a ordenação mantém-se');
  assert.strictEqual(consultas[0].limit, 200, 'o limite da listagem mantém-se');
  // As contagens da fila são um retrato da fila, não do período consultado.
  assert.deepStrictEqual(contagensPedidas[0], { condominioId: 1 },
    'o período não contamina as contagens da fila');
  feito('isolamento, associações, ordenação e contagens inalterados');

  // A vista mostra os campos de data já preenchidos com esse intervalo.
  const mesDois = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  assert.ok(r.corpo.includes(`name="de" value="${agora.getFullYear()}-${mesDois}-01"`), 'campo Data inicial pré-preenchido');
  assert.ok(r.corpo.includes(`name="ate" value="${agora.getFullYear()}-${mesDois}-${dia}"`), 'campo Data final pré-preenchido');
  assert.ok(r.corpo.includes('value="este-mes"'), 'atalho «Este mês» disponível');
  assert.ok(r.corpo.includes('value="personalizado"'), 'atalho «Personalizado» disponível');
  feito('a vista entrega o período resolvido (campos e atalhos)');

  // ── 2. Datas escritas: intervalo exato e determinístico ────────────
  titulo('T2 — datas escritas aplicam-se tal e qual');
  consultas.length = 0;
  r = await pedir('/admin/emails?de=2026-01-01&ate=2026-01-31');
  let [d2, a2] = intervaloAplicado();
  assert.strictEqual(d2.getTime(), new Date(2026, 0, 1, 0, 0, 0, 0).getTime(), 'início = 1 de janeiro, à meia-noite');
  assert.strictEqual(a2.getTime(), new Date(2026, 0, 31, 23, 59, 59, 999).getTime(), 'fim = 31 de janeiro, ao fim do dia');
  assert.ok(r.corpo.includes('name="de" value="2026-01-01"'), 'a vista devolve as datas aplicadas');
  assert.ok(r.corpo.includes('name="ate" value="2026-01-31"'), 'a vista devolve as datas aplicadas (fim)');

  // Intervalo invertido: normalizado, para não parecer «não há emails».
  consultas.length = 0;
  r = await pedir('/admin/emails?de=2026-01-31&ate=2026-01-01');
  let [d3, a3] = intervaloAplicado();
  assert.ok(d3.getTime() < a3.getTime(), 'intervalo invertido é normalizado na consulta');
  assert.strictEqual(d3.getTime(), new Date(2026, 0, 1, 0, 0, 0, 0).getTime(), 'intervalo invertido: início normalizado');
  assert.strictEqual(a3.getTime(), new Date(2026, 0, 31, 23, 59, 59, 999).getTime(), 'intervalo invertido: fim normalizado');

  // Data inexistente: ignorada (não produz um intervalo inventado). A data
  // válida é «hoje», para o caso continuar determinístico em qualquer dia.
  consultas.length = 0;
  await pedir(`/admin/emails?de=2026-02-30&ate=${agora.getFullYear()}-${mesDois}-${dia}`);
  const [d4, a4] = intervaloAplicado();
  assert.strictEqual(d4.getTime(), new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0, 0).getTime(),
    'data inexistente cai no limite por omissão');
  assert.strictEqual(a4.getTime(), new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999).getTime(),
    'a data válida é respeitada');
  feito('datas escritas, invertidas e inexistentes');

  // ── 3. Atalhos ────────────────────────────────────────────────────
  titulo('T3 — atalhos mudam o intervalo aplicado');
  const esperado = {
    'este-mes': [new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0, 0),
      new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999)],
    'ultimos-7': [new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - 6, 0, 0, 0, 0),
      new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999)],
    'ultimos-30': [new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - 29, 0, 0, 0, 0),
      new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999)],
  };
  for (const [id, [eDe, eAte]] of Object.entries(esperado)) {
    consultas.length = 0;
    const resp = await pedir(`/admin/emails?periodo=${id}`);
    const [gDe, gAte] = intervaloAplicado();
    assert.strictEqual(gDe.getTime(), eDe.getTime(), `atalho ${id}: início aplicado na consulta`);
    assert.strictEqual(gAte.getTime(), eAte.getTime(), `atalho ${id}: fim aplicado na consulta`);
    // O atalho prevalece sobre as datas que o formulário envia sempre.
    assert.ok(resp.corpo.includes(`value="${id}"`), `atalho ${id}: botão presente`);
  }
  // Mês anterior: derivado por contas próprias (1.º dia do mês passado → último dia).
  const primeiroEsteMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const ultimoMesAnterior = new Date(primeiroEsteMes.getTime());
  ultimoMesAnterior.setDate(0); // dia 0 do mês em curso = último do anterior
  consultas.length = 0;
  await pedir('/admin/emails?periodo=mes-anterior');
  const [gMes, aMes] = intervaloAplicado();
  assert.strictEqual(gMes.getTime(), new Date(ultimoMesAnterior.getFullYear(), ultimoMesAnterior.getMonth(), 1, 0, 0, 0, 0).getTime(),
    'mês anterior: início = 1.º dia do mês anterior');
  assert.strictEqual(aMes.getTime(), new Date(ultimoMesAnterior.getFullYear(), ultimoMesAnterior.getMonth(), ultimoMesAnterior.getDate(), 23, 59, 59, 999).getTime(),
    'mês anterior: fim = último dia do mês anterior');
  feito('os quatro atalhos alteram o intervalo efetivamente consultado');

  // ── 4. Coexistência com estado e origem ───────────────────────────
  titulo('T4 — período, estado e origem coexistem no mesmo `where`');
  consultas.length = 0;
  r = await pedir('/admin/emails?estado=pendentes&tipo=quotas&de=2026-01-01&ate=2026-01-31');
  const onde = consultas[0].where;
  assert.strictEqual(onde.condominio_id, 1, 'condomínio ativo');
  assert.deepStrictEqual(onde.estado[Op.in], ['pendente', 'a_enviar'], 'filtro de estado «Pendentes» mantido');
  assert.strictEqual(onde.entidade_tipo, 'Quota', 'filtro de origem «Quotas» mantido');
  assert.ok(onde.createdAt && onde.createdAt[Op.between], 'filtro de período mantido em simultâneo');
  assert.ok(r.corpo.includes('de=2026-01-01&ate=2026-01-31'), 'as ligações de estado/origem preservam o período');
  feito('período + estado + origem aplicados na mesma consulta');

  // ── 5. Estado vazio do período ────────────────────────────────────
  titulo('T5 — sem emails no período, estado vazio adequado');
  r = await pedir('/admin/emails?de=2020-01-01&ate=2020-01-31');
  assert.ok(r.corpo.includes('Sem emails no período selecionado'), 'mensagem de estado vazio do período');
  assert.ok(r.corpo.includes('01/01/2020') && r.corpo.includes('31/01/2020'), 'o estado vazio indica o intervalo consultado');
  assert.ok(r.corpo.includes('Alargue o período'), 'sugere alargar o período');
  feito('estado vazio específico do período, com o intervalo visível');

  // ── 6. A configuração SMTP saiu deste módulo ──────────────────────
  titulo('T6 — a configuração SMTP e o envio de teste já não vivem na Central de Emails');
  for (const rota of ['/admin/emails/smtp', '/admin/emails/smtp/testar', '/admin/emails/teste']) {
    const resp = await enviar(rota);
    assert.strictEqual(resp.status, 404, `POST ${rota} já não existe neste módulo (404, recebeu ${resp.status})`);
    feito(`POST ${rota} → 404 (rota inexistente)`);
  }
  const caminhos = router.stack.filter((l) => l.route)
    .map((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path);
  assert.ok(!caminhos.some((c) => /\/emails\/smtp/.test(c)), 'nenhuma rota SMTP no router de emails');
  assert.ok(!caminhos.includes('POST /emails/teste'), 'a rota de envio de teste saiu do router de emails');
  // As rotas OPERACIONAIS continuam todas lá.
  for (const esperada of ['GET /emails', 'POST /emails/notificacoes', 'POST /emails/:id/reenviar', 'POST /emails/:id/cancelar']) {
    assert.ok(caminhos.includes(esperada), `rota operacional preservada: ${esperada}`);
  }
  feito(`router de emails: ${caminhos.length} rotas operacionais, nenhuma de configuração`);

  // Sem SMTP configurado, a Central avisa e aponta para onde se configura.
  SMTP_CONFIGURADO = false;
  r = await pedir('/admin/emails');
  assert.ok(r.corpo.includes('href="/admin/config/email"'), 'a Central encaminha para Configuração → Email / SMTP');
  assert.ok(r.corpo.includes('ainda não está configurado'), 'avisa que o servidor de email não está configurado');
  SMTP_CONFIGURADO = true;
  feito('a Central avisa e liga à nova localização da configuração');

  console.log(`\n✓ Testes do filtro por período da Central de Emails passaram (${n} verificações, sem BD).`);
})().catch((err) => {
  console.error('✗ ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
