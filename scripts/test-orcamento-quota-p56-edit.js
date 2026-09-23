// ═══════════════════════════════════════════════════════════════════
// P56 — REFORÇO: não-sobreposição na EDIÇÃO, com comportamento REAL.
//
// Responde, por comportamento (não por inspeção de código):
//   1. `POST /orcamento/:id` recusa um período que se sobrepõe a OUTRO
//      orçamento do mesmo condomínio?
//      · identifica QUAL é o orçamento conflituoso (mensagem acionável);
//      · o orçamento ORIGINAL fica intacto (datas e designação inalteradas);
//      · nenhum orçamento novo aparece;
//   2. `ignorarId` — o PRÓPRIO orçamento não conta como conflito:
//      A. editar SEM mudar o período (mantendo-o) é PERMITIDO;
//      B. mudar para o período de OUTRO orçamento é RECUSADO;
//      C. mudar para um período ADJACENTE é PERMITIDO;
//   3. o período de 13 meses é recusado na edição (mesma regra da criação);
//   4. um período sobreposto de outro CONDOMÍNIO não bloqueia (multitenancy).
//
// Utilização: node scripts/test-orcamento-quota-p56-edit.js
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
const bancada = criarBancada({ tabelas: ['orcamentos', 'rubricas', 'quotas'] });
const { db, auditorias, consultas } = bancada;

const MODELS = {
  Orcamento: bancada.modelo('orcamentos'),
  OrcamentoRubrica: bancada.modelo('rubricas'),
  OrcamentoDistribuicao: bancada.modelo('orcamentos'),
  OrcamentoAlteracao: bancada.modelo('orcamentos'),
  PlanoQuota: bancada.modelo('quotas'),
  Quota: bancada.modelo('quotas'),
  Categoria: bancada.modelo('rubricas'),
  Fracao: bancada.modelo('orcamentos'),
  User: bancada.modelo('orcamentos'),
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
stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: '110.0000', fcrPercentagem: '10' }) });

const flashes = [];
function limparModulos() {
  // O router guarda referências aos modelos no `require`: sem isto, uma segunda
  // montagem correria com os stubs da primeira. `helpers/orcamento-periodo.js`
  // fica FRESCO para que a suite exercite o helper REAL (não uma cópia).
  for (const rel of ['routes/orcamento.js']) {
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
  app.use('/admin', require('../routes/orcamento'));
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));
  servidor = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function editar(id, campos, { condominio = 1 } = {}) {
  const r = await fetch(`${base}/admin/orcamento/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-condominio': String(condominio) },
    body: new URLSearchParams({
      tipo_periodo: 'personalizado', metodo_calculo: 'modo_a', saldo_transitado: '0', ...campos,
    }),
    redirect: 'manual',
  });
  return { estado: r.status, localizacao: r.headers.get('location') };
}

const ultimoFlash = (tipo) => {
  for (let i = flashes.length - 1; i >= 0; i -= 1) if (flashes[i].tipo === tipo) return flashes[i].msg;
  return null;
};

// Cenário: três orçamentos do condomínio 1 (todos em rascunho, para poderem ser
// editados) e um do condomínio 2 que ocupa o MESMO período do A — para provar
// que o orçamento do vizinho não bloqueia.
//
// O estado de partida tem de ser ELE PRÓPRIO válido: os orçamentos ativos não
// podem sobrepor-se. Por isso os três períodos são disjuntos:
//   A: 2026-01-01 → 2026-12-31
//   B: 2027-01-01 → 2027-12-31
//   Anulado: 2028-01-01 → 2028-12-31   (estado «anulado» ⇒ liberta o período)
// O Vizinho (condomínio 2) ocupa o período do A — em OUTRO condomínio.
function semear() {
  bancada.reiniciar();
  flashes.length = 0;
  db.orcamentos.push(
    { id: 1, condominio_id: 1, designacao: 'A', ano: 2026, estado: 'rascunho', data_inicio: '2026-01-01', data_fim: '2026-12-31', saldo_transitado: '0', metodo_calculo: 'modo_a', receita_quotas_prevista: null },
    { id: 2, condominio_id: 1, designacao: 'B', ano: 2027, estado: 'rascunho', data_inicio: '2027-01-01', data_fim: '2027-12-31', saldo_transitado: '0', metodo_calculo: 'modo_a', receita_quotas_prevista: null },
    { id: 3, condominio_id: 1, designacao: 'Anulado', ano: 2028, estado: 'anulado', data_inicio: '2028-01-01', data_fim: '2028-12-31', saldo_transitado: '0', metodo_calculo: 'modo_a', receita_quotas_prevista: null },
    { id: 9, condominio_id: 2, designacao: 'Vizinho', ano: 2026, estado: 'rascunho', data_inicio: '2026-01-01', data_fim: '2026-12-31', saldo_transitado: '0', metodo_calculo: 'modo_a', receita_quotas_prevista: null },
  );
}

const orcamento = (id) => db.orcamentos.find((o) => o.id === id);

// ═══════════════════════════════════════════════════════════════════
async function main() {
  await arrancar();
  try {
    // ── 1. Sobrepõe-se a OUTRO → recusado, original intacto ───────
    secao('1. Edição com sobreposição a outro orçamento — RECUSADA');
    semear();
    // O A (jan–dez 2026) tenta passar a ocupar o período do B (jan–dez 2027).
    let r = await editar(1, { designacao: 'A (tentativa)', data_inicio: '2027-01-01', data_fim: '2027-12-31' });
    assert.strictEqual(r.estado, 302, '1a. responde com redirect');
    assert.strictEqual(r.localizacao, '/admin/orcamento/1/editar', '1b. devolve o formulário de edição (não avança)');
    const a = orcamento(1);
    assert.strictEqual(a.data_inicio, '2026-01-01', '1c. a data de INÍCIO original não foi alterada');
    assert.strictEqual(a.data_fim, '2026-12-31', '1d. a data de FIM original não foi alterada');
    assert.strictEqual(a.designacao, 'A', '1e. a designação também não (a edição não foi aplicada)');
    assert.strictEqual(db.orcamentos.length, 4, '1f. não nasceu nenhum orçamento novo');
    const msg = ultimoFlash('error_msg') || '';
    assert.ok(/sobrepõe-se/i.test(msg), '1g. a mensagem explica que há sobreposição');
    assert.ok(/«B»/.test(msg), `1h. identificando o orçamento CONFLITUOSO («B») — recebido: ${msg.slice(0, 90)}`);
    assert.ok(consultas.some((c) => c.nome === 'orcamentos.findAll'), '1i. a lista de existentes foi mesmo consultada');
    const qExist = [...consultas].reverse().find((c) => c.nome === 'orcamentos.findAll');
    assert.strictEqual(Number(qExist.where.condominio_id), 1, '1j. consultada com o filtro do condomínio da SESSÃO');
    ok('edição sobreposta: recusada, conflito identificado, original intacto');

    // ── 2. ignorarId (A) — manter o período é PERMITIDO ──────────
    secao('2. ignorarId (A) — editar mantendo o PRÓPRIO período é permitido');
    semear();
    r = await editar(1, { designacao: 'A revista', data_inicio: '2026-01-01', data_fim: '2026-12-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1', '2a. avança para o detalhe (sucesso)');
    assert.strictEqual(orcamento(1).designacao, 'A revista', '2b. a alteração pretendida foi aplicada');
    assert.strictEqual(orcamento(1).data_inicio, '2026-01-01', '2c. o período manteve-se');
    assert.ok(auditorias.some((x) => x.acao === 'editar_orçamento'), '2d. a edição foi auditada');
    // Sem `ignorarId`, o próprio orçamento apareceria na lista de existentes e
    // colidiria consigo mesmo: a edição sem mexer no período seria impossível.
    ok('manter o período não colide consigo mesmo (ignorarId efetivo)');

    // ── 3. ignorarId (B) — mudar para o período de OUTRO → recusado ──
    secao('3. ignorarId (B) — mudar para o período de OUTRO é recusado');
    semear();
    // O A tenta passar a ocupar exatamente o período do B (jan–dez 2027).
    r = await editar(1, { designacao: 'A invasor', data_inicio: '2027-01-01', data_fim: '2027-12-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1/editar', '3a. recusado');
    assert.strictEqual(orcamento(1).designacao, 'A', '3b. o original fica intacto');
    assert.strictEqual(orcamento(2).data_inicio, '2027-01-01', '3c. o orçamento B também não foi tocado');
    assert.ok(/«B»/.test(ultimoFlash('error_msg') || ''), '3d. identifica o B como conflituoso');
    // A sobreposição PARCIAL também tem de ser apanhada (não só a coincidência
    // exata): jul–dez 2027 toca o período do B (jan–dez 2027).
    r = await editar(1, { designacao: 'A parcial', data_inicio: '2027-07-01', data_fim: '2028-06-30' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1/editar', '3e. sobreposição PARCIAL também é recusada (jul–dez 2027 toca o B)');
    assert.strictEqual(orcamento(1).designacao, 'A', '3f. original intacto');
    ok('ignorarId ignora SÓ o próprio: sobreposição parcial e total a outro são recusadas');

    // ── 4. ignorarId (C) — período ADJACENTE é permitido ─────────
    secao('4. ignorarId (C) — período ADJACENTE é permitido');
    semear();
    // Um período adjacente tem de ser ACEITE: a regra proíbe coincidência de
    // meses, não encadeamento. O A (2026-01→2026-12) vai para 2025-01→2025-12,
    // que fica entre o C (2024) e o período que o A deixa livre (2026) — sem
    // partilhar um único mês com ninguém.
    db.orcamentos.push({ id: 4, condominio_id: 1, designacao: 'C', ano: 2024, estado: 'rascunho', data_inicio: '2024-01-01', data_fim: '2024-12-31', saldo_transitado: '0', metodo_calculo: 'modo_a', receita_quotas_prevista: null });
    r = await editar(1, { designacao: 'A adjacente', data_inicio: '2025-01-01', data_fim: '2025-12-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1', '4a. adjacente ao B e ao C → permitido');
    assert.strictEqual(orcamento(1).data_inicio, '2025-01-01', '4b. o período novo foi gravado');
    assert.strictEqual(orcamento(1).data_fim, '2025-12-31', '4c. com o fim certo');
    assert.strictEqual(orcamento(1).designacao, 'A adjacente', '4d. a alteração foi aplicada');
    // Contraprova de que o A não bloqueia o período que DEIXOU livre: o B pode
    // recuar para 2026, o buraco que o A acabou de libertar.
    r = await editar(2, { designacao: 'B recuado', data_inicio: '2026-01-01', data_fim: '2026-12-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/2', '4e. o período deixado livre pelo A é reutilizável');
    assert.strictEqual(orcamento(2).data_inicio, '2026-01-01', '4f. gravado');
    ok('períodos adjacentes continuam válidos (a regra proíbe coincidência, não encadeia)');

    // ── 5. Período de 13 meses na edição → recusado ──────────────
    secao('5. Período de 13 meses na EDIÇÃO — recusado');
    semear();
    // 2026-07-15 → 2027-07-14 atravessa 13 meses de calendário (o defeito
    // original: gerava uma 13.ª quota em silêncio).
    r = await editar(1, { data_inicio: '2026-07-15', data_fim: '2027-07-14' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1/editar', '5a. recusado');
    assert.ok(/12 meses/i.test(ultimoFlash('error_msg') || ''), '5b. explica que tem de ser 12 meses de calendário inteiros');
    assert.strictEqual(orcamento(1).data_inicio, '2026-01-01', '5c. o original ficou intacto (nada foi gravado)');
    // Um período alinhado mas de 13 meses (dia 1.º a último dia do 13.º mês).
    r = await editar(1, { data_inicio: '2026-01-01', data_fim: '2027-01-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1/editar', '5e. 13 meses alinhados também são recusados');
    // Data invertida.
    r = await editar(1, { data_inicio: '2026-12-31', data_fim: '2026-01-01' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1/editar', '5f. data de fim antes do início → recusado');
    assert.strictEqual(orcamento(1).data_inicio, '2026-01-01', '5g. nada foi gravado');
    ok('edição valida o período: 13 meses e datas invertidas recusados');

    // ── 6. Orçamento ANULADO não bloqueia ────────────────────────
    secao('6. Orçamento anulado liberta o período');
    semear();
    // O orçamento 3 (anulado) ocupa 2028. Não deve bloquear: o período está
    // LIBERTADO. O A (2026) passa a ocupar exatamente esse período.
    r = await editar(1, { designacao: 'A sobre o anulado', data_inicio: '2028-01-01', data_fim: '2028-12-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1', '6a. o período do anulado está livre → permitido');
    assert.strictEqual(orcamento(1).data_inicio, '2028-01-01', '6b. gravado');
    ok('estado «anulado» liberta o período (não conta como ocupado)');

    // ── 7. Multitenancy — o vizinho não bloqueia ─────────────────
    secao('7. Multitenancy — um período igual no OUTRO condomínio não bloqueia');
    semear();
    // O orçamento 9 (condomínio 2) ocupa jan–dez 2026, exatamente o período do A
    // (condomínio 1). Editar o A mantendo o período tem de ser permitido.
    r = await editar(1, { designacao: 'A multitenant', data_inicio: '2026-01-01', data_fim: '2026-12-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento/1', '7a. o orçamento do vizinho não bloqueia');
    assert.strictEqual(orcamento(1).designacao, 'A multitenant', '7b. a edição passou');
    // E a lista de existentes tem de ter sido filtrada pelo condomínio ATIVO.
    const consulta = [...consultas].reverse().find((c) => c.nome === 'orcamentos.findAll');
    assert.strictEqual(Number(consulta.where.condominio_id), 1, '7c. a consulta filtra pelo condomínio da sessão');
    ok('a não-sobreposição é por condomínio: o orçamento do vizinho é irrelevante');

    // ── 8. IDOR — orçamento de outro condomínio não é editável ───
    secao('8. IDOR — orçamento de outro condomínio não é editável');
    semear();
    r = await editar(9, { designacao: 'Ataque', data_inicio: '2026-01-01', data_fim: '2026-12-31' });
    assert.strictEqual(r.localizacao, '/admin/orcamento', '8a. cai na lista (não pertence ao condomínio ativo)');
    assert.strictEqual(orcamento(9).designacao, 'Vizinho', '8b. o orçamento do vizinho ficou intacto');
    ok('IDOR: o id de outro condomínio não abre a edição');

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
