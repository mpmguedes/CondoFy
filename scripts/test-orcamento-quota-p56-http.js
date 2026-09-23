// ═══════════════════════════════════════════════════════════════════
// P56 — REFORÇO: emissão de quotas por orçamento, com comportamento REAL.
//
// Responde, com prova executável e sem inspeção de código:
//   1. `POST /admin/quotas/gerar` com `metodo=orcamento` grava o vínculo?
//      · o orçamento tem de ser do condomínio da SESSÃO;
//      · um orçamento inexistente é recusado (sem criar quotas);
//      · um orçamento de OUTRO condomínio é inutilizável (IDOR);
//   2. se a criação da 2.ª quota falhar, a 1.ª DESAPARECE? (rollback a sério)
//   3. uma quota já existente (fração, ano, mês) é tratada como «ignorada»?
//      e uma falha de base de dados nessa zona desfaz o lote sem deixar
//      resíduo parcial?
//
// ── Porquê o duplo reversível ──────────────────────────────────────
// A obrigação 2 proíbe um teste que só verifique «rollback() foi chamado».
// Aqui o duplo (`scripts/helpers/duplo-transacao.js`) aplica as escritas com
// diário de desfazer: o que viajou na transação desaparece no rollback, o que
// não viajou (autocommit) sobrevive. A asserção é sobre o ESTADO FINAL de
// `db.quotas`, não sobre a chamada.
//
// Utilização: node scripts/test-orcamento-quota-p56-http.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');
const session = require('express-session');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');
const { criarBancada } = require('./helpers/duplo-transacao');

const stub = (rel, valor) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
};

let n = 0;
const secao = (t) => { console.log(`\n${t}`); };
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ═══════════════════════════════════════════════════════════════════
// Bancada
// ═══════════════════════════════════════════════════════════════════
const bancada = criarBancada({
  tabelas: ['quotas', 'numeracoes', 'orcamentos', 'rubricas', 'fracoes'],
});
const { db, falhas, auditorias, consultas } = bancada;

// FAL-2: a N-ésima chamada a `Quota.create` rebenta. Contador explícito (não um
// booleano) para que o teste queira «a primeira passa, a segunda falha».
const falhaCreate = { armarDepoisDe: null, jaChamadas: 0 };

// FAL-3: a pesquisa de quota existente rebenta (falha de BD a meio do lote).
const falhaFindOne = { ativa: false };

const MODELS = {
  Quota: bancada.modelo('quotas', {
    iniciais: { estado: 'pendente', orcamento_id: null },
    aoCriar: () => {
      if (falhaCreate.armarDepoisDe !== null) {
        falhaCreate.jaChamadas += 1;
        if (falhaCreate.jaChamadas > falhaCreate.armarDepoisDe) {
          throw new Error('ER_DUP_ENTRY: Duplicate entry for key \'quotas_unique\'');
        }
      }
    },
  }),
  Numeracao: bancada.modelo('numeracoes', { iniciais: { sequencia: 0, formato: '{ano}/{sequencia}' } }),
  Orcamento: bancada.modelo('orcamentos', { extras: {
    // O `include` das rubricas é resolvido pelo duplo: a rota filtra
    // `orcamento.rubricas.filter(r => r.ativo)`, por isso o array TEM de existir.
  } }),
  OrcamentoRubrica: bancada.modelo('rubricas'),
  Fracao: bancada.modelo('fracoes'),
  // Modelos que a rota toca mas que não interessam a estes cenários.
  OrcamentoDistribuicao: bancada.modelo('orcamentos'),
  OrcamentoAlteracao: bancada.modelo('orcamentos'),
  PlanoQuota: bancada.modelo('quotas'),
  Categoria: bancada.modelo('fracoes'),
  User: bancada.modelo('fracoes'),
  Configuracao: bancada.modelo('fracoes'),
  ExtraQuota: bancada.modelo('quotas'),
  ExtraQuotaParcela: bancada.modelo('quotas'),
};

// `Orcamento.findOne` devolve o orçamento COM as rubricas já resolvidas —
// a rota pede `include: [{ model: OrcamentoRubrica, as: 'rubricas' }]`.
const rubricasDe = (orcamentoId) => db.rubricas.filter((r) => String(r.orcamento_id) === String(orcamentoId));
MODELS.Orcamento.findOne = async (o = {}) => {
  consultas.push({ nome: 'Orcamento.findOne', where: o.where });
  const achado = bancada.onde(db.orcamentos, o.where)[0];
  if (!achado) return null;
  return Object.assign(achado, { rubricas: rubricasDe(achado.id), toJSON: () => ({ ...achado }) });
};

// `Quota.findOne` é o predicado de idempotência: quando `falhaFindOne` está
// armada, rebenta em vez de responder — é a falha de BD a meio do lote.
const quotaFindOneOriginal = MODELS.Quota.findOne;
MODELS.Quota.findOne = async (o = {}) => {
  if (falhaFindOne.ativa && o.where && o.where.fracao_id !== undefined) {
    throw new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded; try restarting transaction');
  }
  return quotaFindOneOriginal(o);
};

stub('models/index.js', MODELS);
stub('models', MODELS);
stub('config/database.js', {
  transaction: bancada.abrirTransacao,
  Sequelize: {}, Op: require('sequelize').Op,
});
stub('helpers/tenant.js', {
  comCondominioAtivo: (req, res, next) => { req.condominioId = Number(req.headers['x-condominio'] || 1); next(); },
  comPapel: () => (req, res, next) => next(),
  comSuporte: () => (req, res, next) => next(),
  pertenceAoAtivo: () => true, papelMaiorOuIgual: () => true,
});
stub('helpers/suporte-allowlist.js', {
  soDiagnostico: () => (req, res, next) => next(),
  comPapelOuSuporteAdmitido: () => (req, res, next) => next(),
});
stub('helpers/audit.js', {
  audit: async ({ userId, acao, entidade, entidadeId }) => {
    auditorias.push({ user_id: userId || null, acao, entidade: entidade || null, entidade_id: entidadeId || null });
  },
});
stub('helpers/storage.js', { isConfigured: () => false });
stub('helpers/automacoes.js', { estaAtivo: async () => false });
stub('helpers/background-jobs.js', { enqueue: () => {}, registar: () => {} });
stub('helpers/saldos.js', { resumoCondominio: async () => ({ contas: [] }), resumoFracao: async () => ({}), estadoEfetivo: () => 'pendente' });
stub('helpers/condominio.js', { getCondominio: async () => ({ id: 1, designacao: 'C1' }) });
stub('helpers/dates.js', { monthName: (m) => `M${m}`, toDateInput: (d) => String(d).slice(0, 10) });
stub('helpers/handlebars-helpers.js', {});
// A percentagem do FCR tem de ser USADA (não zero) para que a decomposição da
// quota seja exercitada a sério: base + fcr = total, por construção.
stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: '110.0000', fcrPercentagem: '10' }) });

// ── App real (router REAL de routes/financeiro.js) ─────────────────
const flashes = [];
function limparModulos() {
  for (const rel of ['routes/financeiro.js']) {
    delete require.cache[require.resolve(path.join(RAIZ, rel))];
  }
}

let servidor = null;
let base = null;

async function arrancar() {
  limparModulos();
  const app = express();
  app.engine('handlebars', engine({
    defaultLayout: false, helpers: {},
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use(session({ secret: 't', resave: false, saveUninitialized: true }));
  app.use(express.urlencoded({ extended: true }));
  app.use(flash());
  // O `connect-flash` SUBSTITUI `res.locals` a cada pedido: observar
  // `res.locals.error_msg` fora do pedido não vê nada. Intercetamos `req.flash`
  // DEPOIS do middleware e ANTES do router.
  app.use((req, res, next) => {
    req.user = { id: 7 };
    res.locals.user = { id: 7 };
    res.locals.currentYear = 2026; res.locals.currentMonth = 1;
    res.locals.currentPath = req.path;
    res.locals.condominioAtivo = { id: 1, role: 'gestor' };
    res.locals.appName = 'GesCondu';
    res.locals.tarefas = {}; res.locals.meusCondominios = [];
    const original = req.flash.bind(req);
    req.flash = (tipo, msg) => { flashes.push({ tipo, msg }); return original(tipo, msg); };
    next();
  });
  app.use('/admin', require('../routes/financeiro'));
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));
  servidor = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function gerar(campos, { condominio = 1 } = {}) {
  const r = await fetch(`${base}/admin/quotas/gerar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-condominio': String(condominio) },
    body: new URLSearchParams({
      escopo: 'mes', ano: '2026', mes: '3', vencimento_dia: '8', metodo: 'orcamento', ...campos,
    }),
    redirect: 'manual',
  });
  return { estado: r.status, localizacao: r.headers.get('location') };
}

// O `console.error` do handler é capturado para se poder afirmar que o erro foi
// MESMO registado do lado do servidor (um abort silencioso seria indiagnosticável).
async function gerarComFalha(campos, opcoes) {
  const capturado = [];
  const original = console.error;
  console.error = (...a) => capturado.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  try {
    const r = await gerar(campos, opcoes);
    return { r, registos: capturado };
  } finally {
    console.error = original;
  }
}

const ultimoFlash = (tipo) => {
  for (let i = flashes.length - 1; i >= 0; i -= 1) if (flashes[i].tipo === tipo) return flashes[i].msg;
  return null;
};

// Estado de partida: 2 frações ativas no condomínio 1 (duas quotas por mês),
// um orçamento aprovado do condomínio 1 e um do condomínio 2 (o «vizinho»).
function semear() {
  bancada.reiniciar();
  falhas.aoCommit = null;
  falhaCreate.armarDepoisDe = null;
  falhaCreate.jaChamadas = 0;
  falhaFindOne.ativa = false;
  flashes.length = 0;

  db.fracoes.push(
    { id: 21, condominio_id: 1, designacao: 'A', permilagem: '500', estado: 'ativo' },
    { id: 22, condominio_id: 1, designacao: 'B', permilagem: '500', estado: 'ativo' },
    { id: 99, condominio_id: 2, designacao: 'Z', permilagem: '1000', estado: 'ativo' },
  );
  db.orcamentos.push(
    { id: 77, condominio_id: 1, designacao: 'Orçamento 2026', estado: 'aprovado', data_inicio: '2026-01-01', data_fim: '2026-12-31' },
    { id: 88, condominio_id: 2, designacao: 'Orçamento vizinho', estado: 'aprovado', data_inicio: '2026-01-01', data_fim: '2026-12-31' },
  );
  db.rubricas.push(
    { id: 1, orcamento_id: 77, ativo: true, valor_anual: '1200.00' },
    { id: 2, orcamento_id: 88, ativo: true, valor_anual: '1200.00' },
  );
}

const quotasDoCondominio = (id) => db.quotas.filter((q) => Number(q.condominio_id) === Number(id));

// ═══════════════════════════════════════════════════════════════════
async function main() {
  await arrancar();
  try {
    // ── 1. metodo=orcamento grava o vínculo ───────────────────────
    secao('1. POST /admin/quotas/gerar (metodo=orcamento) — o vínculo é GRAVADO');
    semear();
    let r = await gerar({ metodo: 'orcamento', orcamento_id: '77' });
    assert.strictEqual(r.estado, 302, '1a. responde com redirect');
    assert.strictEqual(r.localizacao, '/admin/quotas', '1b. volta para a lista de quotas');
    assert.strictEqual(quotasDoCondominio(1).length, 2, '1c. uma quota por fração ativa (2 frações × 1 mês)');
    for (const q of quotasDoCondominio(1)) {
      assert.strictEqual(Number(q.orcamento_id), 77, `1d. a quota está ligada ao orçamento 77 (recebido ${q.orcamento_id})`);
      assert.strictEqual(Number(q.ano), 2026, '1e. ano do pedido');
      assert.strictEqual(Number(q.mes), 3, '1f. mês do pedido');
      assert.strictEqual(q.estado, 'pendente', '1g. nasce pendente');
      assert.ok(q.data_emissao, '1h. com data de emissão (é um documento — R10)');
    }
    // A decomposição tem de fechar ao cêntimo (I-4): valor = base + fcr.
    for (const q of quotasDoCondominio(1)) {
      const c = (v) => Math.round(Number(v) * 100);
      assert.strictEqual(c(q.valor), c(q.valor_base) + c(q.valor_fcr),
        `1i. decomposição fecha (${q.valor} = ${q.valor_base} + ${q.valor_fcr})`);
      assert.ok(c(q.valor_fcr) > 0, '1j. o FCR do condomínio foi aplicado (não saiu a zero)');
    }
    ok('metodo=orcamento: vínculo gravado, por fração, com decomposição fechada');

    // ── 2. Orçamento sem id / inexistente / de outro condomínio ───
    secao('2. Orçamento inválido — recusado SEM criar nada');
    semear();
    r = await gerar({ metodo: 'orcamento', orcamento_id: '' });
    assert.strictEqual(r.localizacao, '/admin/quotas/gerar', '2a. sem orçamento escolhido → volta ao formulário');
    assert.strictEqual(db.quotas.length, 0, '2b. não criou quota nenhuma');
    assert.ok(/orçamento/i.test(ultimoFlash('error_msg') || ''), '2c. com mensagem acionável ao utilizador');
    ok('sem orcamento_id: recusado, zero quotas');

    semear();
    r = await gerar({ metodo: 'orcamento', orcamento_id: '999' });
    assert.strictEqual(r.localizacao, '/admin/quotas/gerar', '2d. orçamento inexistente → volta ao formulário');
    assert.strictEqual(db.quotas.length, 0, '2e. não criou quota nenhuma');
    ok('orçamento inexistente: recusado, zero quotas');

    // IDOR: o orçamento 88 existe, mas é do condomínio 2. A sessão é do 1.
    semear();
    r = await gerar({ metodo: 'orcamento', orcamento_id: '88' });
    assert.strictEqual(r.localizacao, '/admin/quotas/gerar', '2f. orçamento de OUTRO condomínio → recusado');
    assert.strictEqual(db.quotas.length, 0, '2g. não criou quota nenhuma (nem no condomínio errado)');
    assert.strictEqual(quotasDoCondominio(2).length, 0, '2h. o condomínio vizinho não ficou com quotas');
    ok('orçamento de outro condomínio: inutilizável (filtro de condomínio ativo)');

    // ── 3. ROLLBACK REAL: 1.ª quota criada, 2.ª falha → 1.ª desaparece ──
    secao('3. ROLLBACK REAL — a 1.ª quota não sobrevive à falha da 2.ª');
    semear();
    // Com 2 frações e 1 mês: a 1.ª Quota.create passa, a 2.ª rebenta.
    falhaCreate.armarDepoisDe = 1;
    const { r: r3, registos } = await gerarComFalha({ metodo: 'orcamento', orcamento_id: '77' });
    assert.strictEqual(r3.estado, 302, '3a. o pedido responde (não rebenta o servidor)');
    assert.strictEqual(r3.localizacao, '/admin/quotas', '3b. redireciona para a lista');
    assert.ok(registos.length > 0, '3c. o erro foi registado no servidor (não abortou em silêncio)');
    // A PROVA: o estado final não tem NENHUMA quota. Não se pergunta «o
    // rollback foi chamado?» — pergunta-se «o efeito desapareceu?».
    assert.strictEqual(db.quotas.length, 0,
      `3d. o lote foi integralmente desfeito (sobraram ${db.quotas.length} quota(s) — a 1.ª teria sobrevivido se a escrita não viajasse na transação)`);
    assert.strictEqual(quotasDoCondominio(1).length, 0, '3e. nada ficou no condomínio ativo');
    assert.strictEqual(quotasDoCondominio(2).length, 0, '3f. nada ficou noutro condomínio');
    assert.ok(/não foi possível gerar/i.test(ultimoFlash('error_msg') || ''), '3g. mensagem controlada (não o SQL cru)');
    ok('falha na 2.ª quota → o lote inteiro é desfeito (prova por estado, não por chamada)');

    // ── 3b. Distinguir «propagou a transação» de «autocommit» ─────
    secao('3b. Contraprova — uma escrita FORA da transação sobrevive ao rollback');
    semear();
    // Com `escopo=ano` há 12 meses × 2 frações: a 1.ª quota passa e a 2.ª falha.
    falhaCreate.armarDepoisDe = 1;
    // Escrita deliberadamente FORA da transação (sem `{ transaction }`): é o
    // modelo que este duplo tem de conseguir distinguir. Se sobrevivesse ao
    // lote abortado, o teste acima (3d) seria um falso verde.
    db.quotas.push({ id: 900, condominio_id: 1, fracao_id: 21, ano: 2026, mes: 3, valor: '10.00', estado: 'pendente' });
    await gerarComFalha({ metodo: 'orcamento', orcamento_id: '77', escopo: 'ano' });
    assert.strictEqual(db.quotas.filter((q) => q.id === 900).length, 1,
      '3h. a quota autocommit (fora da transação) SOBREVIVE — o duplo distingue os dois casos');
    assert.strictEqual(db.quotas.length, 1, '3i. só resta a autocommit: as duas da transação desapareceram');
    ok('contraprova: o duplo não apaga tudo — só o que viajou na transação');

    // ── 4. Quota já existente (fração, ano, mês) é «ignorada» ─────
    secao('4. Quota existente (fração, ano, mês) — ignorada, sem duplicar');
    semear();
    db.quotas.push(
      { id: 500, condominio_id: 1, fracao_id: 21, ano: 2026, mes: 3, valor: '30.00', valor_base: '27.27', valor_fcr: '2.73', estado: 'pendente', data_emissao: '2026-03-01', orcamento_id: null },
      { id: 501, condominio_id: 1, fracao_id: 22, ano: 2026, mes: 3, valor: '30.00', valor_base: '27.27', valor_fcr: '2.73', estado: 'pendente', data_emissao: '2026-03-01', orcamento_id: null },
    );
    r = await gerar({ metodo: 'orcamento', orcamento_id: '77' });
    assert.strictEqual(r.localizacao, '/admin/quotas', '4a. corre até ao fim (é um caminho normal)');
    assert.strictEqual(db.quotas.length, 2, '4b. NÃO duplicou: continuam as 2 que já existiam');
    assert.strictEqual(db.quotas.filter((q) => q.orcamento_id === null).length, 2,
      '4c. as pré-existentes não foram tocadas (continuam sem vínculo — R10 não as reescreve)');
    assert.ok(/já existiam/i.test(ultimoFlash('success_msg') || ''), '4d. o utilizador é informado de que foram ignoradas');
    ok('quota existente: ignorada (idempotência), sem reescrever o documento emitido');

    // ── 4b. Falha de BD a meio → sem resíduo parcial ──────────────
    secao('4b. Falha de BD a meio do lote — nada de resíduo parcial');
    semear();
    // Só a fração 21 tem quota; a pesquisa da 22 rebenta. A rota cria a quota
    // da 21, depois encontra a 22 e a consulta de idempotência falha.
    falhaCreate.armarDepoisDe = null;
    db.quotas.push({ id: 500, condominio_id: 1, fracao_id: 21, ano: 2026, mes: 3, valor: '30.00', estado: 'pendente', data_emissao: '2026-03-01' });
    falhaFindOne.ativa = true;
    const { r: r4, registos: reg4 } = await gerarComFalha({ metodo: 'orcamento', orcamento_id: '77' });
    assert.strictEqual(r4.estado, 302, '4e. o pedido responde');
    assert.ok(reg4.length > 0, '4f. o erro foi registado');
    assert.ok(/não foi possível gerar/i.test(ultimoFlash('error_msg') || ''), '4g. mensagem controlada ao utilizador (nunca o SQL cru)');
    assert.strictEqual(db.quotas.filter((q) => q.id !== 500).length, 0, '4h. nenhuma quota parcial ficou gravada');
    assert.strictEqual(db.quotas.length, 1, '4i. só resta a que já existia antes do pedido');
    ok('falha de BD a meio: lote desfeito, sem quota parcial');

    // ── 5. Multitenancy: o lote é do condomínio da sessão ─────────
    secao('5. Multitenancy — o lote pertence SEMPRE ao condomínio da sessão');
    semear();
    r = await gerar({ metodo: 'orcamento', orcamento_id: '77' }, { condominio: 2 });
    // O condomínio 2 não tem o orçamento 77 (é do 1) → recusado.
    assert.strictEqual(r.localizacao, '/admin/quotas/gerar', '5a. o orçamento do 1 é inutilizável a partir do 2');
    assert.strictEqual(db.quotas.length, 0, '5b. não se criou quota no condomínio errado');
    ok('o condomínio vem da sessão: o orçamento de outro condomínio não serve');

    semear();
    // A partir do condomínio 2, com o orçamento DELE (88), as quotas nascem no 2.
    r = await gerar({ metodo: 'orcamento', orcamento_id: '88' }, { condominio: 2 });
    assert.strictEqual(r.localizacao, '/admin/quotas', '5c. com o orçamento do próprio condomínio, avança');
    assert.strictEqual(db.quotas.length, 1, '5d. uma fração ativa no condomínio 2');
    assert.strictEqual(Number(db.quotas[0].condominio_id), 2, '5e. a quota nasceu no condomínio da sessão');
    assert.strictEqual(Number(db.quotas[0].orcamento_id), 88, '5f. ligada ao orçamento desse condomínio');
    ok('com o orçamento do próprio condomínio: quota no condomínio certo, vínculo certo');

    console.log(`\n${n} asserções OK`);
  } finally {
    if (servidor) servidor.close();
  }
}

main().catch((e) => {
  console.error('\n✗ FALHOU: ' + (e && e.message));
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
