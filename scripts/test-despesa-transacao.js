// ═══════════════════════════════════════════════════════════════════
// P16 — Atomicidade entre a despesa e o seu movimento bancário.
//
// `helpers/movimentos.js:sincronizarMovimentoDespesa` sempre aceitou um
// `transaction`, mas os três handlers de `routes/financeiro.js` passavam
// `undefined`: a despesa era gravada numa escrita autónoma e o movimento noutra.
// Uma falha a meio deixava a despesa gravada sem saída na conta — o saldo
// deixava de descontar uma despesa paga, sem qualquer erro visível.
//
// Este ficheiro prova, com as ROTAS REAIS e o helper REAL, que:
//  1. o caminho normal cria/atualiza/anula o movimento a par da despesa;
//  2. se o movimento não puder ser criado, a despesa NÃO fica gravada;
//  3. se o commit falhar, não sobra um movimento órfão (prova que o movimento
//     viaja na MESMA transação da despesa, e não numa escrita autónoma);
//  4. se o movimento não puder ser atualizado, a edição/anulação da despesa é
//     integralmente desfeita;
//  5. a série de numeração NÃO é arrastada pela transação da despesa — um abort
//     deixa um salto, nunca um número repetido (a regressão que causou o
//     incidente de numeração em pagamentos).
//
// ── Modelo de transação do duplo (é o que faz o teste morder) ───────
// As escritas aplicam-se imediatamente a `db` (o estado que o pedido seguinte
// observa). Cada transação mantém um DIÁRIO DE DESFAZER com as escritas que
// recebeu COM `{ transaction }`:
//   · `commit()`  → descarta o diário (as escritas ficam);
//   · `rollback()`→ executa-o ao contrário (essas escritas desaparecem).
// Uma escrita que NÃO receba a transação não entra no diário: é autocommit e
// SOBREVIVE ao rollback. É assim que se distingue "propagou a transação" de
// "não propagou" — por comportamento, não por inspeção de código.
//
// Utilização: node scripts/test-despesa-transacao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents } = require(path.join(RAIZ, 'helpers', 'money'));
const express = require(path.join(RAIZ, 'node_modules', 'express'));

let nPassos = 0;
function ok(descricao) {
  nPassos += 1;
  console.log('  ✓ ' + descricao);
}
function grupo(titulo) {
  console.log('');
  console.log('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 58 - titulo.length)));
}

// ═══════════════════════════════════════════════════════════════════
// "Base de dados" em memória
// ═══════════════════════════════════════════════════════════════════
const db = {
  contas: [
    { id: 10, condominio_id: 1, nome: 'Conta corrente', tipo: 'corrente', saldo_inicial: '1000.00', ativa: true },
    { id: 11, condominio_id: 1, nome: 'Fundo de Reserva', tipo: 'fundo_reserva', saldo_inicial: '0.00', ativa: true },
    { id: 20, condominio_id: 2, nome: 'Corrente (vizinho)', tipo: 'corrente', saldo_inicial: '0.00', ativa: true },
  ],
  assembleias: [
    { id: 1, condominio_id: 1, numero: '2026/1', tipo: 'extraordinaria', data: '2026-04-20', estado: 'realizada' },
  ],
  agendaItems: [
    { id: 100, assembleia_id: 1, ordem: 1, descricao: 'Elevador', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '3000.00', deliberacao_nota: null },
  ],
  despesas: [],
  movimentos: [],
  numeracoes: [],
};
let proximoId = { despesa: 0, movimento: 0, numeracao: 0 };

// Injeções de falha (armadas por cenário).
let falharCreateMovimento = false;
let falharUpdateMovimento = false;
let falharCommitFinanceiro = false;

// Observabilidade.
const auditorias = [];
const consultas = [];

function reiniciar() {
  db.despesas = [];
  db.movimentos = [];
  db.numeracoes = [];
  proximoId = { despesa: 0, movimento: 0, numeracao: 0 };
  falharCreateMovimento = false;
  falharUpdateMovimento = false;
  falharCommitFinanceiro = false;
  auditorias.length = 0;
  consultas.length = 0;
}

// ── Motor de transações (diário de desfazer) ───────────────────────
function registarDesfazer(opcoes, tabela, fn) {
  const t = opcoes && opcoes.transaction;
  if (t && Array.isArray(t.desfazer) && !t.concluida) {
    t.desfazer.push({ tabela, fn });
    return true;
  }
  return false;
}

function aplicarDesfazer(t) {
  const ops = t.desfazer.slice().reverse();
  t.desfazer.length = 0;
  for (const op of ops) op.fn();
}

async function abrirTransacao() {
  const t = {
    LOCK: { UPDATE: 'UPDATE' },
    desfazer: [],
    concluida: false,
    async commit() {
      if (t.concluida) return;
      // Uma falha de commit (deadlock no fecho, ligação perdida) desfaz a
      // transação do lado do servidor.
      const tocaFinanceiro = t.desfazer.some((o) => o.tabela === 'despesas' || o.tabela === 'movimentos');
      if (falharCommitFinanceiro && tocaFinanceiro) {
        aplicarDesfazer(t);
        t.concluida = true;
        throw new Error('ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; try restarting transaction');
      }
      t.concluida = true;
    },
    async rollback() {
      if (t.concluida) return;
      aplicarDesfazer(t);
      t.concluida = true;
    },
  };
  return t;
}

// ── Duplos dos modelos ─────────────────────────────────────────────
function onde(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v === null) return l[k] === null || l[k] === undefined;
    if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].map(String).includes(String(l[k]));
    if (v && typeof v === 'object' && v[Op.notIn]) return !v[Op.notIn].map(String).includes(String(l[k]));
    if (v && typeof v === 'object' && v[Op.ne] !== undefined) return String(l[k]) !== String(v[Op.ne]);
    if (v && typeof v === 'object' && v[Op.or]) return v[Op.or].some((c) => onde([l], c).length === 1);
    return String(l[k]) === String(v);
  }));
}

// Escrita de campos: regista o estado anterior no diário da transação e só
// depois aplica. Sem transação (ou com transação já fechada) é autocommit.
function atualizarCampos(linha, valores, opcoes, tabela) {
  const antes = {};
  for (const k of Object.keys(valores)) antes[k] = linha[k];
  registarDesfazer(opcoes, tabela, () => Object.assign(linha, antes));
  Object.assign(linha, valores);
  return linha;
}

function criarLinha(tabela, id, linha, opcoes) {
  db[tabela].push(linha);
  registarDesfazer(opcoes, tabela, () => {
    const i = db[tabela].indexOf(linha);
    if (i >= 0) db[tabela].splice(i, 1);
  });
  return linha;
}

const comDespesa = (l) => (l ? Object.assign(l, {
  update: async (v, o = {}) => atualizarCampos(l, v, o, 'despesas'),
  toJSON: () => ({ ...l }),
  destroy: async () => {},
}) : null);

const comMovimento = (l) => (l ? Object.assign(l, {
  update: async (v, o = {}) => {
    if (falharUpdateMovimento) throw new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded');
    return atualizarCampos(l, v, o, 'movimentos');
  },
  toJSON: () => ({ ...l }),
  destroy: async () => {},
}) : null);

const comNumeracao = (l) => (l ? Object.assign(l, {
  update: async (v, o = {}) => atualizarCampos(l, v, o, 'numeracoes'),
  toJSON: () => ({ ...l }),
}) : null);

const modelos = {
  Despesa: {
    findAll: async (o = {}) => onde(db.despesas, o.where).map(comDespesa),
    findOne: async (o = {}) => {
      consultas.push({ nome: 'Despesa.findOne', where: o.where });
      return comDespesa(onde(db.despesas, o.where)[0]) || null;
    },
    count: async (o = {}) => onde(db.despesas, o.where).length,
    sum: async (campo, o = {}) => onde(db.despesas, o.where).reduce((s, d) => s + Number(d[campo] || 0), 0),
    create: async (d, o = {}) => {
      const x = criarLinha('despesas', 'despesa', { id: ++proximoId.despesa, estado: 'registada', ...d }, o);
      return comDespesa(x);
    },
  },
  MovimentoBancario: {
    findAll: async (o = {}) => onde(db.movimentos, o.where).map(comMovimento),
    findOne: async (o = {}) => {
      consultas.push({ nome: 'MovimentoBancario.findOne', where: o.where });
      return comMovimento(onde(db.movimentos, o.where)[0]) || null;
    },
    count: async (o = {}) => onde(db.movimentos, o.where).length,
    sum: async () => 0,
    create: async (d, o = {}) => {
      if (falharCreateMovimento) throw new Error('ER_NO_REFERENCED_ROW_2: Cannot add or update a child row');
      const x = criarLinha('movimentos', 'movimento', { id: ++proximoId.movimento, estado: 'confirmado', ...d }, o);
      return comMovimento(x);
    },
  },
  Numeracao: {
    findOne: async (o = {}) => comNumeracao(onde(db.numeracoes, o.where)[0]) || null,
    create: async (d, o = {}) => {
      const x = criarLinha('numeracoes', 'numeracao', {
        id: ++proximoId.numeracao, sequencia: 0, formato: '{ano}/{sequencia}', ...d,
      }, o);
      return comNumeracao(x);
    },
    update: async () => {},
  },
  ContaBancaria: {
    findOne: async (o = {}) => comDespesa(onde(db.contas, o.where)[0]) || null,
    findAll: async (o = {}) => onde(db.contas, o.where),
  },
  AgendaItem: {
    findOne: async (o = {}) => onde(db.agendaItems, o.where)[0] || null,
    findAll: async (o = {}) => onde(db.agendaItems, o.where),
  },
  Assembleia: { findOne: async (o = {}) => onde(db.assembleias, o.where)[0] || null, findAll: async (o = {}) => onde(db.assembleias, o.where) },
  Categoria: { findAll: async () => [] },
  MetodoPagamento: { findAll: async () => [] },
  Fornecedor: { findAll: async () => [], findOne: async () => null },
  Documento: { findAll: async () => [], create: async () => ({}) },
  Fracao: { findAll: async () => [], findOne: async () => null },
  Orcamento: { findAll: async () => [] },
  OrcamentoRubrica: { findAll: async () => [] },
  Quota: { findAll: async () => [], sum: async () => 0 },
  Pagamento: { findAll: async () => [], sum: async () => 0 },
  PagamentoQuota: { findAll: async () => [] },
  ExtraQuota: { findAll: async () => [], findOne: async () => null },
  ExtraQuotaParcela: { findAll: async () => [], findByPk: async () => null },
  PagamentoExtraParcela: { findAll: async () => [] },
  Recibo: { findAll: async () => [], findOne: async () => null },
  ReciboQuota: { findAll: async () => [] },
  ReciboExtraParcela: { findAll: async () => [] },
  EmailFila: { findAll: async () => [], create: async () => ({}) },
  UserCondominio: { findOne: async () => ({ role: 'admin', utilizador_id: 7 }), findAll: async () => [] },
  Condominio: { findOne: async () => ({ id: 1, estado: 'ativo' }) },
  User: { findOne: async () => ({ id: 7, role_global: 'user' }), findByPk: async () => ({ id: 7, role_global: 'user' }) },
  AuditLog: { create: async () => ({}) },
  AssembleiaParticipante: { findAll: async () => [] },
  Pessoa: { findAll: async () => [] },
};

// ── Instalação dos duplos ANTES de carregar o router ───────────────
// `helpers/movimentos.js` NÃO é substituído: corre o código real, com os
// duplos dos modelos. É o que dá valor ao teste — exercita o `criarMovimento`
// verdadeiro e a passagem (ou não) da transação.
const cache = (rel, exp) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exp };
};
cache('models', modelos);
cache('config/database', { transaction: abrirTransacao, Sequelize: {}, Op });
cache('helpers/audit', {
  audit: async ({ userId, acao, entidade, entidadeId, detalhes }) => {
    auditorias.push({ user_id: userId || null, acao, entidade: entidade || null, entidade_id: entidadeId || null });
  },
});

// ── App real ───────────────────────────────────────────────────────
const routerFinanceiro = require(path.join(RAIZ, 'routes', 'financeiro'));

const flashesRecolhidos = [];
let servidor = null;
let base = null;

async function arrancar() {
  const { engine } = require(path.join(RAIZ, 'node_modules', 'express-handlebars'));
  const helpers = require(path.join(RAIZ, 'helpers', 'handlebars-helpers'));
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { condominio_ativo_id: 1 };
    req.user = { id: 7, role_global: 'user' };
    req.isAuthenticated = () => true;
    req.flashes = [];
    req.flash = (tipo, msg) => { req.flashes.push({ tipo, msg }); flashesRecolhidos.push({ tipo, msg }); };
    res.locals.flashes = req.flashes;
    next();
  });
  app.engine('handlebars', engine({
    defaultLayout: 'main',
    helpers,
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use('/admin', routerFinanceiro);
  servidor = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function pedir(caminho, { metodo = 'GET', corpo = null } = {}) {
  const opcoes = { method: metodo, redirect: 'manual' };
  if (corpo) {
    opcoes.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    opcoes.body = new URLSearchParams(corpo).toString();
  }
  const r = await fetch(`${base}${caminho}`, opcoes);
  return { estado: r.status, localizacao: r.headers.get('location'), corpo: await r.text() };
}

// Nos cenários de falha esperada, o `console.error` do handler é capturado em
// vez de impresso (mantém a saída da suite limpa) e devolvido, para se poder
// afirmar que o erro foi mesmo registado do lado do servidor — um abort
// silencioso seria indiagnosticável em produção.
async function pedirComFalha(caminho, opcoes) {
  const capturado = [];
  const original = console.error;
  console.error = (...a) => capturado.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  try {
    const r = await pedir(caminho, opcoes);
    return { r, registos: capturado };
  } finally {
    console.error = original;
  }
}

function ultimoFlash(tipo) {
  for (let i = flashesRecolhidos.length - 1; i >= 0; i -= 1) {
    if (flashesRecolhidos[i].tipo === tipo) return flashesRecolhidos[i].msg;
  }
  return null;
}

const CORPO_BASE = {
  descricao: 'Elevador', valor: '120', data: '2026-05-02', conta_bancaria_id: '10',
  estado: 'paga', categoria_id: '', fornecedor_id: '', metodo_pagamento_id: '', observacoes: '', deliberacao_id: '',
};

// Estado de partida dos cenários de edição/anulação: uma despesa paga com o seu
// movimento confirmado, ambos em 100,00 € — coerentes entre si.
function semearDespesaPaga() {
  db.despesas.push({
    id: 1, condominio_id: 1, numero_documento: '2026/0001', descricao: 'Elevador', valor: 100,
    data: '2026-05-02', competencia_ano: 2026, competencia_mes: 5, estado: 'paga',
    conta_bancaria_id: 10, categoria_id: null, deliberacao_id: null,
  });
  db.movimentos.push({
    id: 1, conta_bancaria_id: 10, condominio_id: 1, despesa_id: 1, tipo: 'saida', valor: 100,
    estado: 'confirmado', data: '2026-05-02', descricao: 'Elevador',
  });
}

// ═══════════════════════════════════════════════════════════════════
async function main() {
  await arrancar();
  try {
    // ── 1. Caminho normal: despesa paga cria a saída na conta ─────
    grupo('1. Caminho normal — a despesa paga cria o movimento');
    reiniciar();
    const r1 = await pedir('/admin/despesas', { metodo: 'POST', corpo: CORPO_BASE });
    assert.strictEqual(r1.estado, 302, '1a. o POST responde com redirect');
    assert.strictEqual(r1.localizacao, '/admin/despesas', '1b. volta para a lista de despesas');
    assert.strictEqual(db.despesas.length, 1, '1c. a despesa foi gravada');
    assert.strictEqual(db.movimentos.length, 1, '1d. o movimento bancário foi criado');
    const mov1 = db.movimentos[0];
    assert.strictEqual(mov1.tipo, 'saida', '1e. é uma saída');
    assert.strictEqual(toCents(mov1.valor), 12000, '1f. com o valor da despesa');
    assert.strictEqual(Number(mov1.despesa_id), Number(db.despesas[0].id), '1g. ligado à despesa');
    assert.strictEqual(Number(mov1.conta_bancaria_id), 10, '1h. na conta escolhida');
    assert.strictEqual(Number(mov1.condominio_id), 1, '1i. com o condomínio do pedido (nunca NULL)');
    assert.strictEqual(mov1.estado, 'confirmado', '1j. confirmado (desconta no saldo)');
    assert.ok(auditorias.some((a) => a.acao === 'criar_despesa'), '1k. a criação é auditada');
    ok('despesa paga + conta → 1 saída confirmada, ligada, no condomínio certo');

    // ── 2. Edição: o movimento segue o novo valor ─────────────────
    grupo('2. Caminho normal — a edição atualiza o movimento');
    const r2 = await pedir(`/admin/despesas/${db.despesas[0].id}`, {
      metodo: 'POST',
      corpo: { ...CORPO_BASE, valor: '250', descricao: 'Elevador (rev.)' },
    });
    assert.strictEqual(r2.estado, 302, '2a. a edição responde com redirect');
    assert.strictEqual(toCents(db.despesas[0].valor), 25000, '2b. a despesa ficou com o valor novo');
    assert.strictEqual(db.movimentos.length, 1, '2c. continua a haver UM só movimento (não duplica)');
    assert.strictEqual(toCents(db.movimentos[0].valor), 25000, '2d. o movimento acompanhou o valor');
    ok('editar o valor da despesa atualiza o movimento existente (sem duplicar)');

    // ── 3. Anulação: o movimento fica anulado ─────────────────────
    grupo('3. Caminho normal — a anulação anula o movimento');
    const r3 = await pedir(`/admin/despesas/${db.despesas[0].id}/anular`, { metodo: 'POST', corpo: {} });
    assert.strictEqual(r3.estado, 302, '3a. a anulação responde com redirect');
    assert.strictEqual(db.despesas[0].estado, 'anulada', '3b. a despesa ficou anulada');
    assert.strictEqual(db.movimentos[0].estado, 'anulado', '3c. o movimento ficou anulado (deixa de pesar no saldo)');
    ok('anular a despesa anula o movimento — deixa de descontar no saldo');

    // ── 4. Falha ao criar o movimento desfaz a despesa ────────────
    grupo('4. Falha ao criar o movimento → a despesa NÃO fica gravada');
    reiniciar();
    falharCreateMovimento = true;
    const f4 = await pedirComFalha('/admin/despesas', { metodo: 'POST', corpo: CORPO_BASE });
    const r4 = f4.r;
    assert.strictEqual(r4.estado, 302, '4a. responde com redirect (não rebenta com 500)');
    assert.strictEqual(r4.localizacao, '/admin/despesas/nova', '4b. volta ao formulário para tentar de novo');
    assert.ok(/não foi possível criar a despesa/i.test(ultimoFlash('error_msg') || ''), '4c. com mensagem de erro explícita');
    assert.ok(f4.registos.some((t) => /\[despesas\] criar:/.test(t)), '4d. o erro ficou registado no log do servidor');
    assert.strictEqual(db.despesas.length, 0, '4e. a despesa foi DESFEITA (sem despesa órfã de saldo)');
    assert.strictEqual(db.movimentos.length, 0, '4f. nenhum movimento ficou para trás');
    assert.strictEqual(auditorias.length, 0, '4g. uma operação abortada não é auditada como concluída');
    ok('sem movimento ⇒ sem despesa: nada fica meio gravado');

    // ── 5. Falha no commit não deixa movimento órfão ──────────────
    // Prova que o movimento viaja na MESMA transação da despesa: se fosse
    // gravado numa escrita autónoma (o defeito P16), sobreviveria ao rollback e
    // ficaria a apontar para uma despesa que não existe.
    grupo('5. Falha no commit → nenhum movimento órfão');
    reiniciar();
    falharCommitFinanceiro = true;
    const f5 = await pedirComFalha('/admin/despesas', { metodo: 'POST', corpo: CORPO_BASE });
    const r5 = f5.r;
    assert.strictEqual(r5.estado, 302, '5a. responde com redirect');
    assert.ok(/não foi possível criar a despesa/i.test(ultimoFlash('error_msg') || ''), '5b. com mensagem de erro explícita');
    assert.strictEqual(db.despesas.length, 0, '5c. a despesa não ficou gravada');
    assert.strictEqual(db.movimentos.length, 0,
      '5d. o movimento NÃO sobreviveu ao rollback (a transação foi mesmo propagada)');
    const orfaos = db.movimentos.filter((m) => !db.despesas.some((d) => Number(d.id) === Number(m.despesa_id)));
    assert.strictEqual(orfaos.length, 0, '5e. não há movimento a apontar para uma despesa inexistente');
    ok('o movimento entra na transação da despesa (não numa escrita autónoma)');

    // ── 6. Edição ─────────────────────────────────────────────────
    grupo('6. Edição — a despesa e o movimento nunca divergem');
    reiniciar();
    semearDespesaPaga();
    falharUpdateMovimento = true;
    const f6 = await pedirComFalha('/admin/despesas/1', { metodo: 'POST', corpo: { ...CORPO_BASE, valor: '999' } });
    const r6 = f6.r;
    assert.strictEqual(r6.estado, 302, '6a. responde com redirect');
    assert.strictEqual(r6.localizacao, '/admin/despesas/1/editar', '6b. volta ao formulário da despesa');
    assert.ok(/não foi possível atualizar a despesa/i.test(ultimoFlash('error_msg') || ''), '6c. com mensagem de erro explícita');
    assert.ok(f6.registos.some((t) => /\[despesas\] editar:/.test(t)), '6d. o erro ficou registado no log do servidor');
    assert.strictEqual(toCents(db.despesas[0].valor), 10000, '6e. a despesa manteve o valor ANTIGO (rollback)');
    assert.strictEqual(toCents(db.movimentos[0].valor), 10000, '6f. o movimento manteve o valor antigo — os dois concordam');
    assert.strictEqual(auditorias.length, 0, '6g. a edição abortada não é auditada');

    // Mesma edição, mas a falhar no COMMIT: o movimento já foi escrito, logo tem
    // de ser desfeito com a despesa (senão o saldo ficava a descontar 999,00 €
    // de uma despesa de 100,00 €).
    reiniciar();
    semearDespesaPaga();
    falharCommitFinanceiro = true;
    const f6b = await pedirComFalha('/admin/despesas/1', { metodo: 'POST', corpo: { ...CORPO_BASE, valor: '999' } });
    assert.strictEqual(f6b.r.estado, 302, '6h. responde com redirect');
    assert.strictEqual(toCents(db.despesas[0].valor), 10000, '6i. a despesa ficou no valor antigo');
    assert.strictEqual(toCents(db.movimentos[0].valor), 10000, '6j. o movimento ficou no valor antigo (sem divergência)');
    ok('edição abortada ⇒ despesa e movimento continuam a concordar no valor antigo');

    // ── 7. Anulação ───────────────────────────────────────────────
    grupo('7. Anulação — a despesa e o movimento nunca divergem');
    reiniciar();
    semearDespesaPaga();
    falharUpdateMovimento = true;
    const f7 = await pedirComFalha('/admin/despesas/1/anular', { metodo: 'POST', corpo: {} });
    const r7 = f7.r;
    assert.strictEqual(r7.estado, 302, '7a. responde com redirect');
    assert.ok(/não foi possível anular a despesa/i.test(ultimoFlash('error_msg') || ''), '7b. com mensagem de erro explícita');
    assert.ok(f7.registos.some((t) => /\[despesas\] anular:/.test(t)), '7c. o erro ficou registado no log do servidor');
    assert.strictEqual(db.despesas[0].estado, 'paga',
      '7d. a despesa NÃO ficou anulada — senão ficava anulada com o movimento a descontar no saldo');
    assert.strictEqual(db.movimentos[0].estado, 'confirmado', '7e. o movimento continua confirmado (coerente)');

    // Falha no commit da anulação: o movimento já foi anulado, logo a anulação
    // tem de ser desfeita com ele.
    reiniciar();
    semearDespesaPaga();
    falharCommitFinanceiro = true;
    const f7b = await pedirComFalha('/admin/despesas/1/anular', { metodo: 'POST', corpo: {} });
    assert.strictEqual(f7b.r.estado, 302, '7f. responde com redirect');
    assert.strictEqual(db.despesas[0].estado, 'paga', '7g. a despesa ficou por anular');
    assert.strictEqual(db.movimentos[0].estado, 'confirmado', '7h. o movimento ficou confirmado (sem divergência)');
    ok('anulação abortada ⇒ despesa e movimento mantêm-se coerentes');

    // ── 8. A numeração não é arrastada pela transação ─────────────
    // Se `proximoNumero` fosse chamado DENTRO da transação da despesa, o
    // rollback desfaria o incremento da sequência e a tentativa seguinte
    // reutilizaria o mesmo número — a série ficaria presa (a causa do incidente
    // de numeração em pagamentos). Aqui prova-se que um abort deixa um SALTO.
    grupo('8. Um abort deixa um salto na série — nunca um número repetido');
    reiniciar();
    falharCreateMovimento = true;
    await pedirComFalha('/admin/despesas', { metodo: 'POST', corpo: CORPO_BASE });
    const numeroAbortado = (db.numeracoes.find((n) => n.tipo_documento === 'despesa') || {}).sequencia;
    assert.strictEqual(numeroAbortado, 1, '8a. a sequência avançou apesar do abort');
    falharCreateMovimento = false;
    await pedir('/admin/despesas', { metodo: 'POST', corpo: CORPO_BASE });
    const numeroNovo = db.despesas[0].numero_documento;
    assert.strictEqual(numeroNovo, '2026/0002',
      '8b. a tentativa seguinte usa um número NOVO (a série não voltou atrás)');
    assert.notStrictEqual(numeroNovo, '2026/0001', '8c. o número abortado não é reutilizado');
    ok('a série de numeração avança fora da transação (salto, nunca repetição)');

    // ── 9. Voltar a marcar «paga» repõe o movimento ───────────────
    // Sequência real: pagar → anular → corrigir para «paga». O movimento fica
    // 'anulado' e o saldo deixa de descontar uma despesa que voltou a estar
    // paga — sem erro visível. Repor é seguro: o movimento de uma despesa só
    // pode ser anulado por esta via (o extrato RECUSA anular movimentos com
    // origem — «corrija o registo na origem»), logo não se sobrepõe a nenhuma
    // decisão humana.
    grupo('9. Voltar a marcar «paga» repõe o movimento');
    reiniciar();
    const r9a = await pedir('/admin/despesas', { metodo: 'POST', corpo: CORPO_BASE });
    assert.strictEqual(r9a.localizacao, '/admin/despesas', '9a. a despesa é criada paga');
    const id9 = db.despesas[0].id;
    assert.strictEqual(db.movimentos[0].estado, 'confirmado', '9b. com o movimento confirmado');
    await pedir(`/admin/despesas/${id9}/anular`, { metodo: 'POST', corpo: {} });
    assert.strictEqual(db.despesas[0].estado, 'anulada', '9c. a despesa é anulada');
    assert.strictEqual(db.movimentos[0].estado, 'anulado', '9d. e o movimento é anulado com ela');
    const r9b = await pedir(`/admin/despesas/${id9}`, { metodo: 'POST', corpo: { ...CORPO_BASE, valor: '80' } });
    assert.strictEqual(r9b.localizacao, '/admin/despesas', '9e. a correção para «paga» é aceite');
    assert.strictEqual(db.despesas[0].estado, 'paga', '9f. a despesa voltou a estar paga');
    assert.strictEqual(db.movimentos.length, 1, '9g. não se cria um segundo movimento');
    assert.strictEqual(db.movimentos[0].estado, 'confirmado',
      '9h. o movimento volta a contar no saldo (senão a despesa ficava paga SEM saída na conta)');
    assert.strictEqual(toCents(db.movimentos[0].valor), 8000, '9i. com o valor atualizado');
    ok('pagar → anular → voltar a pagar repõe o movimento (o saldo volta a descontar)');

    // ── 10. Um movimento nunca fica sem despesa ──────────────────
    // Invariante global depois de todos os cenários.
    grupo('10. Invariante — nenhum movimento aponta para despesa inexistente');
    const semDono = db.movimentos.filter((m) => m.despesa_id && !db.despesas.some((d) => Number(d.id) === Number(m.despesa_id)));
    assert.strictEqual(semDono.length, 0, '10a. todos os movimentos de despesa têm a despesa correspondente');
    ok('invariante mantida: movimento de despesa ⇒ despesa existe');

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' OK — P16: ' + nPassos + ' verificações passaram (sem base de dados).');
    console.log('═══════════════════════════════════════════════════════════════');
  } finally {
    if (servidor) servidor.close();
  }
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
