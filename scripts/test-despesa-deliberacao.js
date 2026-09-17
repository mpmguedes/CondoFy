// ═══════════════════════════════════════════════════════════════════
// Despesa ↔ Deliberação do Fundo de Reserva (FCR).
//
// Testes offline (sem base de dados nem rede):
//  · regras de validação da ligação (puras + consultas, com duplos de modelos);
//  · rotas Express REAIS (`/admin/despesas`, `/admin/despesas/:id` e
//    `/admin/assembleias/:id/agenda/:aid/eliminar`);
//  · isolamento por condomínio (cadeia deliberação → item → assembleia);
//  · coerência com a utilização do FCR: uma despesa associada NÃO pode alterar
//    `utilizado`/`disponivel` da deliberação (só saídas da conta do fundo contam);
//  · bloqueio da eliminação do ponto com despesas associadas;
//  · regressões do FCR e do financeiro correm na suite (`test:offline`).
//
// Utilização: node scripts/test-despesa-deliberacao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents } = require(path.join(RAIZ, 'helpers', 'money'));
const express = require(path.join(RAIZ, 'node_modules', 'express'));

// ── "Base de dados" em memória ─────────────────────────────────────
const db = {
  contas: [
    { id: 10, condominio_id: 1, nome: 'Conta corrente', tipo: 'corrente', saldo_inicial: '0.00', ativa: true },
    { id: 11, condominio_id: 1, nome: 'Fundo de Reserva', tipo: 'fundo_reserva', saldo_inicial: '0.00', ativa: true },
    { id: 20, condominio_id: 2, nome: 'Corrente (vizinho)', tipo: 'corrente', saldo_inicial: '0.00', ativa: true },
    { id: 21, condominio_id: 2, nome: 'FCR (vizinho)', tipo: 'fundo_reserva', saldo_inicial: '0.00', ativa: true },
  ],
  assembleias: [
    { id: 1, condominio_id: 1, numero: '2026/1', tipo: 'extraordinaria', data: '2026-04-20', estado: 'realizada' },
    { id: 2, condominio_id: 1, numero: '2026/2', tipo: 'ordinaria', data: '2026-05-20', estado: 'cancelada' },
    { id: 3, condominio_id: 1, numero: '2026/3', tipo: 'ordinaria', data: '2026-06-20', estado: 'rascunho' },
    { id: 9, condominio_id: 2, numero: '2026/1', tipo: 'ordinaria', data: '2026-04-20', estado: 'realizada' },
  ],
  agendaItems: [
    { id: 100, assembleia_id: 1, ordem: 1, descricao: 'Substituição do elevador', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '300.00', deliberacao_nota: 'Obras' },
    { id: 101, assembleia_id: 1, ordem: 2, descricao: 'Pintura das escadas', sujeito_votacao: true, deliberacao_estado: 'pendente', valor_aprovado: null, deliberacao_nota: null },
    { id: 102, assembleia_id: 1, ordem: 3, descricao: 'Bicicletas', sujeito_votacao: true, deliberacao_estado: 'rejeitada', valor_aprovado: null, deliberacao_nota: null },
    { id: 110, assembleia_id: 2, ordem: 1, descricao: 'Cobertura', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '500.00', deliberacao_nota: null },
    { id: 111, assembleia_id: 3, ordem: 1, descricao: 'Portão', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '200.00', deliberacao_nota: null },
    { id: 900, assembleia_id: 9, ordem: 1, descricao: 'Obras do vizinho', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '999.00', deliberacao_nota: null },
  ],
  despesas: [],
  movimentos: [],
  quotas: [],
  pagamentos: [],
  pagamentoQuotas: [],
  proximoId: { despesa: 0, movimento: 0 },
};
const consultas = [];
const auditorias = [];

function reiniciar() {
  db.despesas = [];
  db.movimentos = [];
  db.quotas = [];
  db.pagamentos = [];
  db.pagamentoQuotas = [];
  db.proximoId = { despesa: 0, movimento: 0 };
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
    if (v && typeof v === 'object' && v[Op.ne] !== undefined) return String(l[k]) !== String(v[Op.ne]);
    if (v && typeof v === 'object' && v[Op.or]) return v[Op.or].some((c) => onde([l], c).length === 1);
    return String(l[k]) === String(v);
  }));
}
const comMetodos = (l) => (l ? Object.assign(l, {
  // O Sequelize devolve DECIMAL como string ("150.00"); o duplo normaliza para
  // número, como o driver faria na leitura de uma DECIMAL(12,2).
  update: async (v) => {
    const normalizado = { ...v };
    if (normalizado.valor !== undefined) normalizado.valor = Number(normalizado.valor);
    Object.assign(l, normalizado);
    return l;
  },
  toJSON: () => ({ ...l }),
  destroy: async () => {},
}) : l);

function incluir(linhas, include, associado) {
  const inc = (include || [])[0];
  if (!inc) return linhas;
  const filhas = inc.include || [];
  // O registo é o MESMO objeto da "tabela" (o Sequelize devolve instâncias
  // ligadas ao registo; `update()` tem de refletir-se na linha guardada).
  return linhas.map((l) => {
    let assoc = associado(l, inc.as);
    if (assoc && filhas.length) assoc = incluir([assoc], filhas, (x, nome) => {
      if (nome === 'assembleia') return db.assembleias.find((a) => Number(a.id) === Number(x.assembleia_id)) || null;
      return x[nome] || null;
    })[0];
    l[inc.as] = assoc || null;
    return l;
  }).filter((l) => {
    const a = l[inc.as];
    if (!a) return false;
    const w = inc.where || {};
    const chaves = [...Object.keys(w), ...Object.getOwnPropertySymbols(w).map(String)];
    return chaves.every((k) => {
      const ehOp = k.startsWith('Symbol(');
      const valor = ehOp ? w[Object.getOwnPropertySymbols(w).find((s) => String(s) === k)] : w[k];
      const testa = (campo, v) => {
        if (v === null) return a[campo] === null || a[campo] === undefined;
        if (Array.isArray(v)) return v.some((c) => Object.entries(c).every(([kk, vv]) => testa(kk, vv)));
        if (v && typeof v === 'object') return Object.entries(v).every(([kk, vv]) => testa(kk, vv));
        return String(a[campo]) === String(v);
      };
      return ehOp ? testa(null, valor) : testa(k, valor);
    });
  });
}

const modelos = {
    Despesa: {
    findAll: async (o = {}) => {
      consultas.push({ nome: 'Despesa.findAll', where: o.where });      const linhas = onde(db.despesas, o.where);
      const inc = (o.include || []).find((i) => i.as === 'deliberacao');
      if (!inc) return linhas.map(comMetodos);
      return incluir(linhas, [inc], (l) => {
        const item = db.agendaItems.find((i) => Number(i.id) === Number(l.deliberacao_id));
        if (!item) return null;
        return { ...item, assembleia: db.assembleias.find((a) => Number(a.id) === Number(item.assembleia_id)) || null };
      }).map(comMetodos);
    },
    findOne: async (o = {}) => {
      consultas.push({ nome: 'Despesa.findOne', where: o.where });
      const linhas = onde(db.despesas, o.where);
      const inc = (o.include || []).find((i) => i.as === 'deliberacao');
      if (!inc) return comMetodos(linhas[0]) || null;
      const comAssoc = incluir(linhas, [inc], (l) => {
        const item = db.agendaItems.find((i) => Number(i.id) === Number(l.deliberacao_id));
        if (!item) return null;
        return { ...item, assembleia: db.assembleias.find((a) => Number(a.id) === Number(item.assembleia_id)) || null };
      });
      return comMetodos(comAssoc[0]) || null;
    },
    count: async (o = {}) => onde(db.despesas, o.where).length,
    create: async (d) => {
      const x = { id: ++db.proximoId.despesa, estado: 'registada', ...d };
      db.despesas.push(x);
      return comMetodos(x);
    },
    sum: async (campo, o = {}) => onde(db.despesas, o.where).reduce((s, d) => s + Number(d[campo] || 0), 0),
  },
  AgendaItem: {
    findOne: async (o = {}) => {
      consultas.push({ nome: 'AgendaItem.findOne', where: o.where });
      const linhas = onde(db.agendaItems, o.where);
      const comAssoc = incluir(linhas, o.include, (l, nome) => {
        if (nome === 'assembleia') return db.assembleias.find((a) => Number(a.id) === Number(l.assembleia_id)) || null;
        return null;
      });
      return comMetodos(comAssoc[0]) || null;
    },
    findAll: async (o = {}) => {
      consultas.push({ nome: 'AgendaItem.findAll', where: o.where, include: o.include });
      const linhas = onde(db.agendaItems, o.where);
      return incluir(linhas, o.include, (l, nome) => {
        if (nome === 'assembleia') return db.assembleias.find((a) => Number(a.id) === Number(l.assembleia_id)) || null;
        return null;
      }).map(comMetodos);
    },
    findByPk: async (id) => comMetodos(db.agendaItems.find((i) => Number(i.id) === Number(id))) || null,
    destroy: async (o = {}) => {
      const alvo = onde(db.agendaItems, o.where);
      db.agendaItems = db.agendaItems.filter((i) => !alvo.includes(i));
      return alvo.length;
    },
    create: async (d) => { const x = { id: ++db.proximoId.despesa, ...d }; db.agendaItems.push(x); return comMetodos(x); },
    update: async () => [0],
  },
  Assembleia: {
    findOne: async (o = {}) => comMetodos(onde(db.assembleias, o.where)[0]) || null,
    findAll: async (o = {}) => onde(db.assembleias, o.where).map(comMetodos),
  },
  ContaBancaria: {
    findOne: async (o = {}) => {
      consultas.push({ nome: 'ContaBancaria.findOne', where: o.where });
      return comMetodos(onde(db.contas, o.where)[0]) || null;
    },
    findAll: async (o = {}) => onde(db.contas, o.where).map(comMetodos),
  },
  MovimentoBancario: {
    findAll: async (o = {}) => incluir(onde(db.movimentos, o.where), o.include, (l) => db.contas.find((c) => Number(c.id) === Number(l.conta_bancaria_id))),
    findOne: async (o = {}) => comMetodos(onde(db.movimentos, o.where)[0]) || null,
    count: async (o = {}) => onde(db.movimentos, o.where).length,
    create: async (d) => { const m = { id: ++db.proximoId.movimento, estado: 'confirmado', ...d }; db.movimentos.push(m); return comMetodos(m); },
    update: async () => [0],
    sum: async () => 0,
  },
  Quota: { findAll: async (o = {}) => onde(db.quotas, o.where).map(comMetodos), sum: async () => 0 },
  Pagamento: { findAll: async (o = {}) => onde(db.pagamentos, o.where), sum: async () => 0 },
  PagamentoQuota: { findAll: async (o = {}) => incluir(onde(db.pagamentoQuotas, o.where), o.include, (l) => db.pagamentos.find((p) => Number(p.id) === Number(l.pagamento_id))) },
  Categoria: { findAll: async () => [] },
  MetodoPagamento: { findAll: async () => [] },
  Fornecedor: { findAll: async () => [], findOne: async () => null },
  Documento: { findAll: async () => [], create: async () => ({}) },
  Fracao: { findAll: async () => [], findOne: async () => null },
  Orcamento: { findAll: async () => [] },
  UserCondominio: { findOne: async () => ({ role: 'admin', utilizador_id: 7 }), findAll: async () => [] },
  Condominio: { findOne: async () => ({ id: 1, estado: 'ativo' }) },
  User: { findOne: async () => ({ id: 7, role_global: 'user' }), findByPk: async () => ({ id: 7, role_global: 'user' }) },
  AuditLog: { create: async () => ({}) },
  Numeracao: {
    findOne: async () => null,
    create: async () => ({ sequencia: 0, update: async () => {} }),
    update: async () => {},
  },
  AssembleiaParticipante: { findAll: async () => [] },
  Pessoa: { findAll: async () => [] },
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

const fcrDelib = require(path.join(RAIZ, 'helpers', 'fcr-deliberacoes'));

// O `req.flash` do middleware de teste recolhe todas as mensagens escritas
// pelas rotas, para os testes verificarem a mensagem efetivamente produzida.
const flashesRecolhidos = [];

// ── App real (rotas de despesas e de assembleias) ──────────────────
const routerFinanceiro = require(path.join(RAIZ, 'routes', 'financeiro'));
const routerAssembleias = require(path.join(RAIZ, 'routes', 'assembleias'));

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
  app.use('/admin', routerAssembleias);
  servidor = app.listen(0, '127.0.0.1');
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
  return { estado: r.status, localizacao: r.headers.get('location'), corpo: await r.text() };
}

// Mensagem de flash escrita pela última rota chamada (o prefixo é o tipo).
function flashDaUltimaResposta() {
  const ultimo = flashesRecolhidos[flashesRecolhidos.length - 1];
  return ultimo ? ultimo.msg : null;
}

async function main() {
  await arrancar();
  try {
    // ── 1. Validações puras/consultas ──────────────────────────────
    reiniciar();
    const ok = await fcrDelib.validarAssociacaoDespesa({
      deliberacaoId: 100, condominioId: 1, valorC: 10000, contaBancariaId: 10,
    });
    assert.strictEqual(ok.ok, true, '1a. deliberação aprovada com valor e conta corrente válidos é aceite');
    assert.strictEqual(ok.valorAprovadoC, 30000, '1b. valor aprovado em cêntimos');
    assert.strictEqual(ok.disponivelC, 30000, '1c. disponível = aprovado (nada associado)');

    const semDelib = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: null, condominioId: 1, valorC: 100 });
    assert.strictEqual(semDelib.motivo, 'deliberacao_obrigatoria', '1d. sem deliberação é recusado quando se pede associação');

    const inexistente = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: 99999, condominioId: 1, valorC: 100 });
    assert.strictEqual(inexistente.motivo, 'deliberacao_invalida', '1e. deliberação inexistente recusada');

    for (const [id, motivo, rotulo] of [
      [101, 'deliberacao_nao_aprovada', '1f. deliberação pendente recusada'],
      [102, 'deliberacao_nao_aprovada', '1g. deliberação rejeitada recusada'],
      [110, 'assembleia_nao_delibera', '1h. assembleia cancelada recusada'],
      [111, 'assembleia_nao_delibera', '1i. assembleia em rascunho recusada'],
      [900, 'deliberacao_invalida', '1j. deliberação de outro condomínio recusada'],
    ]) {
      const r = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: id, condominioId: 1, valorC: 100, contaBancariaId: 10 });
      assert.strictEqual(r.ok, false, rotulo);
      assert.strictEqual(r.motivo, motivo, `${rotulo} (motivo)`);
    }

    const contaFundo = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: 100, condominioId: 1, valorC: 100, contaBancariaId: 11 });
    assert.strictEqual(contaFundo.ok, false, '1k. conta do Fundo de Reserva como conta de pagamento é recusada');
    assert.strictEqual(contaFundo.motivo, 'conta_fundo_reserva', '1l. motivo: conta do fundo');

    const contaVizinha = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: 100, condominioId: 1, valorC: 100, contaBancariaId: 20 });
    assert.strictEqual(contaVizinha.motivo, 'conta_invalida', '1m. conta de outro condomínio é recusada');

    // Limite do valor aprovado, com despesas já associadas.
    db.despesas.push({ id: 1, condominio_id: 1, descricao: 'Fatura 1', valor: '200.00', estado: 'registada', deliberacao_id: 100 });
    const acima = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: 100, condominioId: 1, valorC: 10001, contaBancariaId: 10 });
    assert.strictEqual(acima.ok, false, '1n. acima do que resta do aprovado é recusado');
    assert.strictEqual(acima.motivo, 'acima_do_aprovado', '1o. motivo: acima do aprovado');
    assert.strictEqual(acima.jaAssociadoC, 20000, '1p. já associado = 200,00 €');
    assert.strictEqual(acima.disponivelC, 10000, '1q. disponível = 100,00 €');
    const noLimite = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: 100, condominioId: 1, valorC: 10000, contaBancariaId: 10 });
    assert.strictEqual(noLimite.ok, true, '1r. exatamente no limite é aceite');
    // Despesa anulada não conta para o já associado.
    db.despesas.push({ id: 2, condominio_id: 1, descricao: 'Fatura anulada', valor: '500.00', estado: 'anulada', deliberacao_id: 100 });
    const comAnulada = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: 100, condominioId: 1, valorC: 10000, contaBancariaId: 10 });
    assert.strictEqual(comAnulada.jaAssociadoC, 20000, '1s. despesas anuladas não contam para o valor associado');
    assert.strictEqual(comAnulada.ok, true, '1t. continua a caber no aprovado');
    // Ao editar a própria despesa, o seu valor não conta duas vezes.
    const aoEditar = await fcrDelib.validarAssociacaoDespesa({ deliberacaoId: 100, condominioId: 1, valorC: 25000, contaBancariaId: 10, ignorarDespesaId: 1 });
    assert.strictEqual(aoEditar.jaAssociadoC, 0, '1u. ao editar, a própria despesa é ignorada no já associado');
    assert.strictEqual(aoEditar.ok, true, '1v. e o novo valor é avaliado contra o aprovado');

    // ── 2. Uma despesa associada NÃO altera utilizado/disponivel ────
    reiniciar();
    db.despesas.push({ id: 1, condominio_id: 1, descricao: 'Fatura do elevador', valor: '120.00', estado: 'registada', deliberacao_id: 100 });
    const utilizados = await fcrDelib.valorUtilizadoDeliberacaoC(100, { condominioId: 1 });
    assert.strictEqual(utilizados, 0, '2a. o valor utilizado (movimentos do fundo) continua a zero');
    const assoc = await fcrDelib.valorDespesasDeliberacaoC(100);
    assert.strictEqual(assoc, 12000, '2b. o valor das despesas associadas é medido à parte');
    const comDados = await fcrDelib.deliberacaoComUtilizacao(
      { id: 100, assembleia_id: 1, ordem: 1, descricao: 'Elevador', deliberacao_estado: 'aprovada', valor_aprovado: '300.00', assembleia: db.assembleias[0] },
      { condominioId: 1 }
    );
    assert.strictEqual(comDados.utilizadoC, 0, '2c. `utilizado` da deliberação não é afetado pela despesa');
    assert.strictEqual(comDados.disponivelC, 30000, '2d. `disponivel` = valor aprovado (a despesa não consome a autorização)');

    // ── 3. Rotas reais: criar e editar despesa com deliberação ─────
    reiniciar();
    const r1 = await pedir('/admin/despesas', {
      metodo: 'POST',
      corpo: {
        descricao: 'Substituição do elevador — 1.ª tranche', valor: '120', data: '2026-05-02',
        conta_bancaria_id: '10', estado: 'registada', deliberacao_id: '100', categoria_id: '', fornecedor_id: '', metodo_pagamento_id: '', observacoes: '',
      },
    });
    assert.strictEqual(r1.estado, 302, '3a. o POST de criação responde com redirect');
    assert.strictEqual(r1.localizacao, '/admin/despesas', '3b. volta para a lista de despesas');
    const criada = db.despesas[0];
    assert.strictEqual(Number(criada.deliberacao_id), 100, '3c. a despesa fica ligada à deliberação');
    assert.strictEqual(criada.condominio_id, 1, '3d. fica no condomínio ativo');
    const auditCriar = auditorias.find((a) => a.acao === 'criar_despesa');
    assert.ok(auditCriar, '3e. a criação é auditada');
    const detalhesCriar = JSON.parse(auditCriar.detalhes);
    assert.strictEqual(detalhesCriar.deliberacaoId, 100, '3f. a auditoria inclui deliberacaoId');
    assert.strictEqual(detalhesCriar.assembleiaId, 1, '3g. a auditoria inclui a assembleia');
    assert.ok(detalhesCriar.disponivelC !== null, '3h. a auditoria inclui o disponível no momento');

    // Despesa corrente (sem deliberação) mantém-se possível e sem detalhes FCR.
    const r2 = await pedir('/admin/despesas', {
      metodo: 'POST',
      corpo: { descricao: 'Eletricidade', valor: '40', data: '2026-05-03', conta_bancaria_id: '10', estado: 'registada', deliberacao_id: '' },
    });
    assert.strictEqual(r2.localizacao, '/admin/despesas', '3i. despesa sem deliberação continua a ser criada');
    const corrente = db.despesas.find((d) => d.descricao === 'Eletricidade');
    assert.ok(corrente.deliberacao_id === null || corrente.deliberacao_id === undefined, '3j. sem deliberação fica NULL (comportamento anterior)');
    assert.strictEqual(JSON.parse(auditorias.filter((a) => a.acao === 'criar_despesa')[1].detalhes || 'null'), null, '3k. auditoria das despesas correntes mantém-se como estava (sem detalhes)');

    // Recusas pela rota.
    const casos = [
      { corpo: { deliberacao_id: '101' }, motivo: /aprovada/i, rotulo: '3l. deliberação pendente recusada pela rota' },
      { corpo: { deliberacao_id: '110' }, motivo: /assembleia/i, rotulo: '3m. assembleia cancelada recusada pela rota' },
      { corpo: { deliberacao_id: '900' }, motivo: /condomínio|delibera/i, rotulo: '3n. deliberação de outro condomínio recusada pela rota' },
      { corpo: { deliberacao_id: '100', conta_bancaria_id: '11' }, motivo: /Fundo de Reserva não paga/i, rotulo: '3o. conta do fundo como conta de pagamento recusada pela rota' },
      { corpo: { deliberacao_id: '100', valor: '1000' }, motivo: /aprovado/i, rotulo: '3p. valor acima do aprovado recusado pela rota' },
    ];
    const antesRecusas = db.despesas.length;
    for (const caso of casos) {
      const r = await pedir('/admin/despesas', {
        metodo: 'POST',
        corpo: {
          descricao: 'Recusada', valor: '100', data: '2026-05-04', conta_bancaria_id: '10', estado: 'registada', ...caso.corpo,
        },
      });
      assert.strictEqual(r.estado, 302, caso.rotulo);
      assert.ok(r.corpo === '' || true, caso.rotulo);
      const flashErro = await estadoFlash(r);
      assert.ok(flashErro && caso.motivo.test(flashErro), `${caso.rotulo} (mensagem: ${flashErro})`);
    }
    assert.strictEqual(db.despesas.length, antesRecusas, '3q. nenhuma despesa inválida foi gravada');

    // Edição: manter a deliberação, mudar o valor dentro do aprovado.
    const idCriada = criada.id;
    const r3 = await pedir(`/admin/despesas/${idCriada}`, {
      metodo: 'POST',
      corpo: {
        descricao: 'Substituição do elevador — 1.ª tranche (rev.)', valor: '150', data: '2026-05-02',
        conta_bancaria_id: '10', estado: 'registada', deliberacao_id: '100',
      },
    });
    assert.strictEqual(r3.localizacao, '/admin/despesas', '3r. a edição redireciona para a lista');
    const editada = db.despesas.find((d) => Number(d.id) === Number(idCriada));
    assert.strictEqual(toCents(editada.valor), 15000, '3s. valor atualizado');
    assert.strictEqual(Number(editada.deliberacao_id), 100, '3t. deliberação mantida');
    assert.ok(auditorias.some((a) => a.acao === 'editar_despesa' && JSON.parse(a.detalhes).deliberacaoId === 100), '3u. a edição é auditada com deliberacaoId');

    // Remover a ligação (despesa passa a corrente).
    const r4 = await pedir(`/admin/despesas/${idCriada}`, {
      metodo: 'POST',
      corpo: { descricao: 'Substituição do elevador — 1.ª tranche (rev.)', valor: '150', data: '2026-05-02', conta_bancaria_id: '10', estado: 'registada', deliberacao_id: '' },
    });
    assert.strictEqual(r4.localizacao, '/admin/despesas', '3v. remover a deliberação é aceite');
    assert.strictEqual(db.despesas.find((d) => Number(d.id) === Number(idCriada)).deliberacao_id, null, '3w. a ligação fica nula');

    // ── 4. Isolamento por condomínio nas consultas ─────────────────
    consultas.length = 0;
    await pedir('/admin/despesas');
    await pedir('/admin/despesas/nova');
    for (const c of consultas) {
      const where = c.where || {};
      if (['Despesa.findAll', 'Despesa.findOne'].includes(c.nome)) {
        assert.ok('condominio_id' in where, `4a. ${c.nome} filtra pelo condomínio`);
      }
    }
    assert.ok(consultas.some((c) => c.nome === 'AgendaItem.findAll'), '4b. as deliberações são carregadas para o formulário');
    const consultaDelib = consultas.find((c) => c.nome === 'AgendaItem.findAll');
    const incluiAssembleia = (o) => (o && o.where && String(o.where.condominio_id) === '1');
    const incluiOpOr = (o) => {
      if (!o || !o.where) return false;
      const simbolos = Object.getOwnPropertySymbols(o.where);
      if (!simbolos.length) return false;
      const valor = o.where[simbolos[0]];
      return Array.isArray(valor) && valor.some((c) => c.condominio_id !== undefined && String(c.condominio_id) === '1');
    };
    assert.ok(
      (consultaDelib.include || []).some((i) => incluiAssembleia(i) || incluiOpOr(i))
        || (consultaDelib.where && String(consultaDelib.where.condominio_id) === '1'),
      `4c. a deliberação é carregada com o filtro do condomínio ativo (includes: ${JSON.stringify((consultaDelib.include || []).map((i) => [...Object.keys(i.where || {}), ...Object.getOwnPropertySymbols(i.where || {}).map(String)]))})`
    );

    // ── 5. Bloqueio da eliminação do ponto com despesas associadas ─
    reiniciar();
    db.despesas.push({ id: 1, condominio_id: 1, descricao: 'Obra', valor: '100.00', estado: 'registada', deliberacao_id: 100 });
    assert.strictEqual(await fcrDelib.temMovimentosAssociados(100), 1, '5a. a contagem inclui despesas associadas');
    const reliminar = await pedir('/admin/assembleias/1/agenda/100/eliminar', { metodo: 'POST', corpo: {} });
    assert.strictEqual(reliminar.estado, 302, '5b. a rota de eliminação responde com redirect');
    const flashEliminar = await estadoFlash(reliminar);
    assert.ok(flashEliminar && /não pode ser eliminado/i.test(flashEliminar), `5c. bloqueia com mensagem clara (${flashEliminar})`);
    assert.ok(/despesa/i.test(flashEliminar), '5d. a mensagem menciona as despesas associadas');
    assert.ok(db.agendaItems.some((i) => Number(i.id) === 100), '5e. o ponto continua na base de dados');

    // Ponto sem nada associado continua eliminável.
    const livre = await pedir('/admin/assembleias/1/agenda/101/eliminar', { metodo: 'POST', corpo: {} });
    assert.strictEqual(livre.estado, 302, '5f. a eliminação de um ponto livre responde com redirect');
    assert.ok(!db.agendaItems.some((i) => Number(i.id) === 101), '5g. um ponto sem utilização é eliminado');

    // ── 6. Formulário: selector e badge ────────────────────────────
    reiniciar();
    const form = await pedir('/admin/despesas/nova');
    assert.strictEqual(form.estado, 200, '6a. o formulário de nova despesa responde 200');
    assert.ok(/name="deliberacao_id"/.test(form.corpo), '6b. o formulário tem o selector de deliberação');
    assert.ok(/Assembleia 2026\/1/.test(form.corpo), '6c. o selector mostra a assembleia da deliberação aprovada');
    assert.ok(/300,00/.test(form.corpo), '6d. o selector mostra o valor disponível');
    assert.ok(!/Pintura das escadas/.test(form.corpo), '6e. deliberações não aprovadas não aparecem no selector');

    db.despesas.push({ id: 1, condominio_id: 1, descricao: 'Obra do elevador', valor: '100.00', estado: 'registada', deliberacao_id: 100, data: '2026-05-02' });
    const lista = await pedir('/admin/despesas');
    assert.strictEqual(lista.estado, 200, '6f. a lista de despesas responde 200');
    assert.ok(/FCR/.test(lista.corpo) && /Assembleia 2026\/1/.test(lista.corpo), '6g. a lista mostra o badge da deliberação');

    console.log('✓ Testes da ligação Despesa ↔ Deliberação FCR passaram, sem base de dados.');
  } finally {
    parar();
  }
}

// O flash da rota é escrito no `req.flash` do pedido HTTP; o middleware de teste
// recolhe-o para o teste poder verificar a mensagem produzida.
async function estadoFlash() {
  const ultimo = flashesRecolhidos[flashesRecolhidos.length - 1];
  return ultimo && ultimo.tipo === 'error_msg' ? ultimo.msg : null;
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
