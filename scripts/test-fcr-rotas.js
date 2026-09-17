// ═══════════════════════════════════════════════════════════════════
// Rotas do Fundo de Reserva — montagem REAL do router Express.
//
// Aplica o HTTP contra `routes/financeiro.js` montado em `/admin` (stack
// completo, não a chamada direta ao handler), que é onde o bug vivia:
// `POST /contas/:id` estava registada antes de `POST /contas/transferir-fcr`,
// pelo que `transferir-fcr` era interpretado como `:id`, a rota respondia
// "conta não encontrada" e redirecionava para `/admin/contas` — sem criar
// movimento nenhum e sem mensagem.
//
// Este teste falha se a ordem das rotas voltar a ser trocada ou se o `:id`
// deixar de estar restrito a dígitos.
//
// Utilização: node scripts/test-fcr-rotas.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents } = require(path.join(RAIZ, 'helpers', 'money'));
const express = require('express');

// ── "Base de dados" em memória ─────────────────────────────────────
const db = {
  contas: [
    { id: 10, condominio_id: 1, nome: 'Conta corrente', tipo: 'corrente', saldo_inicial: '1000.00', ativa: true },
    { id: 11, condominio_id: 1, nome: 'Fundo de Reserva', tipo: 'fundo_reserva', saldo_inicial: '0.00', ativa: true },
  ],
  quotas: [],
  pagamentos: [],
  pagamentoQuotas: [],
  movimentos: [],
  assembleias: [{ id: 1, condominio_id: 1, numero: '2026/1', estado: 'realizada', data: '2026-04-20', tipo: 'extraordinaria' }],
  agendaItems: [{ id: 100, assembleia_id: 1, ordem: 1, descricao: 'Substituição do elevador', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '300.00', deliberacao_nota: 'Obras' }],
  proximoId: 500,
  escritas: [],
};
const consultas = [];
const auditorias = [];

function reiniciar() {
  // Duas quotas pagas (5,00 € de FCR cada) → 10,00 € de FCR recebido.
  db.quotas = [
    { id: 600, condominio_id: 1, fracao_id: 1, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
    { id: 601, condominio_id: 1, fracao_id: 1, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
  ];
  db.pagamentos = [
    { id: 700, condominio_id: 1, estado: 'confirmado' },
    { id: 701, condominio_id: 1, estado: 'confirmado' },
  ];
  db.pagamentoQuotas = [
    { id: 800, pagamento_id: 700, quota_id: 600, valor_aplicado: '55.00' },
    { id: 801, pagamento_id: 701, quota_id: 601, valor_aplicado: '55.00' },
  ];
  db.movimentos = [
    { id: 1, conta_bancaria_id: 10, condominio_id: 1, data: '2026-01-05', tipo: 'entrada', valor: '110.00', referencia: null, estado: 'confirmado' },
  ];
  db.escritas = [];
  consultas.length = 0;
  auditorias.length = 0;
}

// ── Duplos dos modelos ─────────────────────────────────────────────
function onde(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v === null) return l[k] === null || l[k] === undefined;
    if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].map(String).includes(String(l[k]));
    if (v && typeof v === 'object' && v[Op.notIn]) return !v[Op.notIn].map(String).includes(String(l[k]));
    if (v && typeof v === 'object' && v[Op.or]) return v[Op.or].some((c) => onde([l], c).length === 1);
    return String(l[k]) === String(v);
  }));
}
const comMetodos = (l) => (l ? Object.assign(l, { update: async (v) => Object.assign(l, v), toJSON: () => ({ ...l }), destroy: async () => {} }) : l);

// Avalia o `where` de um `include required: true` sobre o registo associado.
function incluir(linhas, include, associado) {
  const inc = (include || [])[0];
  if (!inc) return linhas;
  return linhas.map((l) => ({ ...l, [inc.as]: associado(l) })).filter((l) => {
    const assoc = l[inc.as];
    if (!assoc) return false;
    const w = inc.where || {};
    const chaves = [...Object.keys(w), ...Object.getOwnPropertySymbols(w).map(String)];
    return chaves.every((k) => {
      const ehOperador = k.startsWith('Symbol(');
      const valor = ehOperador ? w[Object.getOwnPropertySymbols(w).find((s) => String(s) === k)] : w[k];
      const testa = (campo, v) => {
        if (v === null) return assoc[campo] === null || assoc[campo] === undefined;
        if (Array.isArray(v)) return v.some((c) => Object.entries(c).every(([kk, vv]) => testa(kk, vv)));
        if (v && typeof v === 'object') return Object.entries(v).every(([kk, vv]) => testa(kk, vv));
        return String(assoc[campo]) === String(v);
      };
      return ehOperador ? testa(null, valor) : testa(k, valor);
    });
  });
}

const modelos = {
  ContaBancaria: {
    findOne: async (o = {}) => {
      consultas.push({ nome: 'ContaBancaria.findOne', where: o.where });
      return comMetodos(onde(db.contas, o.where)[0]) || null;
    },
    findAll: async (o = {}) => onde(db.contas, o.where).map(comMetodos),
  },
  MovimentoBancario: {
    findAll: async (o = {}) => incluir(onde(db.movimentos, o.where), o.include, (l) => db.contas.find((c) => Number(c.id) === Number(l.conta_bancaria_id))),
    create: async (d) => {
      const m = { id: ++db.proximoId, estado: 'confirmado', ...d };
      db.movimentos.push(m);
      db.escritas.push(m);
      return comMetodos(m);
    },
    count: async (o = {}) => onde(db.movimentos, o.where).length,
    findOne: async (o = {}) => onde(db.movimentos, o.where)[0] || null,
    sum: async () => 0,
  },
  Quota: {
    findAll: async (o = {}) => onde(db.quotas, o.where).map(comMetodos),
    sum: async (campo, o = {}) => onde(db.quotas, o.where).reduce((s, q) => s + Number(q[campo] || 0), 0),
  },
  Pagamento: {
    findAll: async (o = {}) => onde(db.pagamentos, o.where),
    sum: async () => 0,
  },
  PagamentoQuota: {
    findAll: async (o = {}) => incluir(onde(db.pagamentoQuotas, o.where), o.include, (l) => db.pagamentos.find((p) => Number(p.id) === Number(l.pagamento_id))),
  },
  AgendaItem: {
    findOne: async (o = {}) => comMetodos(incluir(onde(db.agendaItems, o.where), o.include, (i) => db.assembleias.find((a) => Number(a.id) === Number(i.assembleia_id)))[0]) || null,
    findAll: async (o = {}) => incluir(onde(db.agendaItems, o.where), o.include, (i) => db.assembleias.find((a) => Number(a.id) === Number(i.assembleia_id))).map(comMetodos),
  },
  Assembleia: {
    findOne: async (o = {}) => comMetodos(onde(db.assembleias, o.where)[0]) || null,
    findAll: async (o = {}) => onde(db.assembleias, o.where).map(comMetodos),
  },
  Despesa: { findAll: async () => [], sum: async () => 0, count: async () => 0 },
  Documento: { findAll: async () => [], create: async () => ({}) },
  Fracao: { findAll: async () => [], findOne: async () => null },
  Orcamento: { findAll: async () => [] },
  Categoria: { findAll: async () => [] },
  MetodoPagamento: { findAll: async () => [] },
  Fornecedor: { findAll: async () => [] },
  UserCondominio: {
    findOne: async () => ({ role: 'admin', utilizador_id: 7, condominio_id: 1 }),
    findAll: async () => [],
  },
  Condominio: { findOne: async () => ({ id: 1, estado: 'ativo', toJSON: () => ({ id: 1 }) }) },
  User: { findOne: async () => ({ id: 7, role_global: 'user' }), findByPk: async () => ({ id: 7, role_global: 'user' }) },
  AuditLog: { create: async () => ({}) },
};

const transacao = { COMMIT: 'commit', ROLLBACK: 'rollback', LOCK: { UPDATE: 'u' }, commit: async () => {}, rollback: async () => {} };
const cache = (rel, exp) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exp };
};
cache('models', modelos);
cache('config/database', { transaction: async () => transacao, Sequelize: {}, Op });
cache('helpers/audit', {
  audit: async ({ userId, acao, entidade, entidadeId, detalhes }) => {
    auditorias.push({ user_id: userId || null, acao, entidade: entidade || null, entidade_id: entidadeId || null, detalhes: detalhes ? JSON.stringify(detalhes) : null });
  },
});

// ── App real (router montado em /admin, com o tenant simulado) ──────
const routerFinanceiro = require(path.join(RAIZ, 'routes', 'financeiro'));

function criarApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { condominio_ativo_id: 1 };
    req.user = { id: 7, role_global: 'user' };
    req.isAuthenticated = () => true;
    req.flashes = [];
    req.flash = (tipo, msg) => req.flashes.push({ tipo, msg });
    res.locals.flashes = req.flashes;
    next();
  });
  // Motor de vistas igual ao de app.js (express-handlebars + helpers), para o
  // GET renderizar a página como em produção e o teste verificar o formulário.
  const { engine } = require(path.join(RAIZ, 'node_modules', 'express-handlebars'));
  const helpers = require(path.join(RAIZ, 'helpers', 'handlebars-helpers'));
  app.engine('handlebars', engine({
    defaultLayout: 'main',
    helpers,
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use('/admin', routerFinanceiro);
  return app;
}

let servidor = null;
let base = null;
async function arrancar() {
  servidor = criarApp().listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
}
function parar() {
  if (servidor) servidor.close();
}

async function pedir(caminho, { metodo = 'GET', corpo = null } = {}) {
  const opcoes = { method: metodo, redirect: 'manual' };
  if (corpo) {
    opcoes.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    opcoes.body = new URLSearchParams(corpo).toString();
  }
  const r = await fetch(`${base}${caminho}`, opcoes);
  const redirecionado = r.headers.get('location');
  return { estado: r.status, localizacao: redirecionado, corpo: await r.text() };
}

function saldoC(contaId) {
  const conta = db.contas.find((c) => Number(c.id) === Number(contaId));
  const mov = db.movimentos.filter((m) => Number(m.conta_bancaria_id) === Number(contaId) && m.estado === 'confirmado');
  const entradasC = mov.filter((m) => m.tipo === 'entrada').reduce((s, m) => s + toCents(m.valor), 0);
  const saidasC = mov.filter((m) => m.tipo === 'saida').reduce((s, m) => s + toCents(m.valor), 0);
  return toCents(conta.saldo_inicial) + entradasC - saidasC;
}

async function main() {
  await arrancar();
  try {
    // ── 0. Ordem das rotas registadas (a causa do bug) ──────────────
    const rotas = routerFinanceiro.stack
      .filter((l) => l.route && l.route.path.startsWith('/contas'))
      .map((l) => ({ caminhos: Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`) }))
      .flatMap((x) => x.caminhos);
    const posTransferir = rotas.findIndex((r) => r === 'POST /contas/transferir-fcr');
    const posParametrica = rotas.findIndex((r) => r === 'POST /contas/:id(\\d+)');
    assert.ok(posTransferir !== -1, 'a rota POST /contas/transferir-fcr está registada');
    assert.ok(posParametrica !== -1, 'a rota POST /contas/:id(\\d+) está registada');
    assert.ok(
      posTransferir < posParametrica,
      `POST /contas/transferir-fcr tem de estar registada ANTES de POST /contas/:id(\\d+) (ordem atual: ${rotas.join(' → ')})`
    );
    assert.ok(rotas.includes('GET /contas/transferir-fcr'), 'a rota GET /contas/transferir-fcr está registada');
    // Todas as paramétricas de conta limitam o id a dígitos.
    for (const caminho of rotas.filter((r) => r.includes('/contas/:id'))) {
      assert.ok(
        caminho.includes(':id(\\d+)'),
        `a rota paramétrica ${caminho} tem de restringir o id a dígitos`
      );
    }

    // ── 1. POST corrente_para_fcr pela stack real ──────────────────
    reiniciar();
    const antes1 = db.escritas.length;
    const r1 = await pedir('/admin/contas/transferir-fcr', {
      metodo: 'POST',
      corpo: { sentido: 'corrente_para_fcr', deliberacao_id: '', valor: '10', conta_origem_id: '10', conta_destino_id: '11', data: '2026-05-20', descricao: '' },
    });
    assert.strictEqual(r1.estado, 302, '1a. o POST responde com redirect');
    assert.strictEqual(r1.localizacao, '/admin/contas/transferir-fcr', '1b. o redirect volta para a página do Fundo de Reserva (e não para /admin/contas)');
    const novos1 = db.escritas.slice(antes1);
    assert.strictEqual(novos1.length, 2, '1c. cria exatamente dois movimentos');
    assert.deepStrictEqual(novos1.map((m) => m.tipo).sort(), ['entrada', 'saida'], '1d. um saída e uma entrada');
    assert.ok(novos1.every((m) => m.referencia === 'TRANSF'), '1e. ambos com referencia TRANSF');
    assert.ok(novos1.every((m) => Number(m.condominio_id) === 1), '1f. ambos com o condomínio ativo');
    assert.ok(novos1.every((m) => !m.deliberacao_id), '1g. corrente → FCR não leva deliberação');
    assert.strictEqual(Number(novos1.find((m) => m.tipo === 'saida').conta_bancaria_id), 10, '1h. saída na conta à ordem');
    assert.strictEqual(Number(novos1.find((m) => m.tipo === 'entrada').conta_bancaria_id), 11, '1i. entrada na conta do fundo');
    assert.strictEqual(toCents(novos1[0].valor), 1000, '1j. valor do formulário (10,00 €)');
    // Conta à ordem: 1.000,00 € iniciais + 110,00 € de quotas − 10,00 € transferidos.
    assert.strictEqual(saldoC(10), 100000 + 11000 - 1000, '1k. saldo da conta à ordem diminui 10,00 €');
    assert.strictEqual(saldoC(11), 1000, '1l. saldo do fundo aumenta 10,00 €');
    assert.ok(auditorias.some((a) => a.acao === 'transferir_fcr'), '1m. auditado como transferir_fcr');

    // ── 2. POST fcr_para_corrente pela stack real ──────────────────
    const antes2 = db.escritas.length;
    const r2 = await pedir('/admin/contas/transferir-fcr', {
      metodo: 'POST',
      corpo: { sentido: 'fcr_para_corrente', deliberacao_id: '100', valor: '5', conta_origem_id: '11', conta_destino_id: '10', data: '2026-05-21', descricao: '' },
    });
    assert.strictEqual(r2.estado, 302, '2a. o POST responde com redirect');
    assert.strictEqual(r2.localizacao, '/admin/contas/transferir-fcr', '2b. o redirect volta para a página do Fundo de Reserva');
    const novos2 = db.escritas.slice(antes2);
    assert.strictEqual(novos2.length, 2, '2c. cria exatamente dois movimentos');
    assert.ok(novos2.every((m) => Number(m.deliberacao_id) === 100), '2d. ambos os movimentos ficam com deliberacao_id');
    assert.strictEqual(Number(novos2.find((m) => m.tipo === 'saida').conta_bancaria_id), 11, '2e. saída na conta do fundo');
    assert.strictEqual(Number(novos2.find((m) => m.tipo === 'entrada').conta_bancaria_id), 10, '2f. entrada na conta à ordem');
    assert.ok(auditorias.some((a) => a.acao === 'utilizar_fcr'), '2g. auditado como utilizar_fcr');
    assert.strictEqual(saldoC(11), 500, '2h. o fundo fica com 5,00 €');

    // ── 3. GET continua correto ────────────────────────────────────
    const r3 = await pedir('/admin/contas/transferir-fcr');
    assert.strictEqual(r3.estado, 200, '3a. o GET responde 200');
    assert.ok(/Movimentos do Fundo de Reserva|Novo movimento/.test(r3.corpo), '3b. o GET renderiza a página do Fundo de Reserva');
    assert.ok(/nome="conta_origem_id"/.test(r3.corpo) || /name="conta_origem_id"/.test(r3.corpo), '3c. a página mantém o formulário de movimento');

    // ── 4. POST /contas/:id com id numérico continua a funcionar ───
    reiniciar();
    const r4 = await pedir('/admin/contas/10', {
      metodo: 'POST',
      corpo: { nome: 'Conta corrente renomeada', banco: 'Banco X', iban: 'PT50000201231234567890154', tipo: 'corrente', saldo_inicial: '1000.00', ativa: 'on' },
    });
    assert.strictEqual(r4.estado, 302, '4a. a atualização de conta responde com redirect');
    assert.strictEqual(r4.localizacao, '/admin/contas', '4b. volta para a lista de contas');
    assert.strictEqual(db.contas.find((c) => Number(c.id) === 10).nome, 'Conta corrente renomeada', '4c. a conta foi mesmo atualizada');
    // Id não numérico já não entra no handler de contas (não casa com :id(\d+)).
    const r4b = await pedir('/admin/contas/transferir-fcr-x', { metodo: 'POST', corpo: { nome: 'x' } });
    assert.strictEqual(r4b.estado, 404, '4d. um id não numérico não é aceite pela rota paramétrica');

    // ── 5. O POST de transferência nunca entra na rota :id ─────────
    reiniciar();
    consultas.length = 0;
    const r5 = await pedir('/admin/contas/transferir-fcr', {
      metodo: 'POST',
      corpo: { sentido: 'corrente_para_fcr', deliberacao_id: '', valor: '1', conta_origem_id: '10', conta_destino_id: '11', data: '2026-05-22', descricao: '' },
    });
    assert.strictEqual(r5.localizacao, '/admin/contas/transferir-fcr', '5a. o pedido foi tratado pela rota de transferência');
    const procurasPorId = consultas.filter((c) => String(c.where && c.where.id) === 'transferir-fcr');
    assert.strictEqual(procurasPorId.length, 0, '5b. nenhuma consulta procurou uma conta com id "transferir-fcr" (rota :id não foi usada)');
    // E a conta de destino é sempre validada no condomínio ativo.
    assert.ok(consultas.every((c) => c.where.condominio_id === undefined || String(c.where.condominio_id) === '1'), '5c. as contas são sempre verificadas no condomínio ativo');

    console.log('✓ Testes das rotas do Fundo de Reserva (router Express real) passaram, sem base de dados.');
  } finally {
    parar();
  }
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
