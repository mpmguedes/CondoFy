// ═══════════════════════════════════════════════════════════════════
// FCR — deliberação de assembleia e utilização do Fundo de Reserva.
//
// Testes offline (sem base de dados nem rede) do ciclo:
//   Assembleia → deliberação → transferência FCR → conta corrente
//
// O que se garante aqui:
//  · só uma deliberação APROVADA, num ponto sujeito a votação, com valor > 0 e
//    numa assembleia que já delibera autoriza utilização do FCR;
//  · a cadeia deliberação → agenda_item → assembleia → condomínio e
//    movimento → conta → condomínio é validada (nada do formulário é aceite);
//  · o valor utilizado conta só as SAÍDAS confirmadas da conta FCR com esse
//    deliberacao_id (o par nunca conta duas vezes);
//  · a transferência cria exatamente dois movimentos, ambos ligados à
//    deliberação, e não é receita nem despesa;
//  · limites: valor aprovado disponível e saldo real da conta do fundo;
//  · atomicidade, isolamento entre condomínios e bloqueio da eliminação de um
//    ponto já usado.
//
// Utilização: node scripts/test-fcr-deliberacoes.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents } = require(path.join(RAIZ, 'helpers', 'money'));

// ── "Base de dados" em memória ─────────────────────────────────────
const db = {
  assembleias: [],
  agendaItems: [],
  contas: [],
  movimentos: [],
  quotas: [],
  pagamentos: [],
  pagamentoQuotas: [],
  proximoId: { movimento: 0, numeracao: 0 },
};
const consultas = [];
const registar = (nome, where, include) => consultas.push({ nome, where, include });
const auditorias = [];
let falharNoDestino = false;
let registoEscritas = [];

function onde(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v === null) return l[k] === null || l[k] === undefined;
    if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].map(String).includes(String(l[k]));
    if (v && typeof v === 'object' && v[Op.notIn]) return !v[Op.notIn].map(String).includes(String(l[k]));
    if (v && typeof v === 'object' && v[Op.ne] !== undefined) return String(l[k]) !== String(v[Op.ne]);
    if (v && typeof v === 'object' && v[Op.or]) return v[Op.or].some((cond) => onde([l], cond).length === 1);
    return String(l[k]) === String(v);
  }));
}

// `include ... required: true` aplica o filtro do modelo incluído.
function incluir(linhas, include, mapa) {
  if (!include || !include.length) return linhas;
  const inc = include[0];
  return linhas
    .map((l) => ({ ...l, [inc.as]: mapa[inc.as] ? mapa[inc.as](l) : null }))
    .filter((l) => {
      const assoc = l[inc.as];
      if (!assoc) return false;
      if (!inc.where) return true;
      return onde([assoc], inc.where).length === 1;
    });
}

function comMetodos(linha) {
  if (!linha) return linha;
  return Object.assign(linha, {
    update: async (v) => Object.assign(linha, v),
    toJSON: () => ({ ...linha }),
  });
}

const modelos = {
  Assembleia: {
    findOne: async (o = {}) => {
      registar('Assembleia.findOne', o.where);
      return comMetodos(onde(db.assembleias, o.where)[0]) || null;
    },
    findAll: async (o = {}) => {
      registar('Assembleia.findAll', o.where);
      return onde(db.assembleias, o.where).map(comMetodos);
    },
  },
  AgendaItem: {
    findOne: async (o = {}) => {
      registar('AgendaItem.findOne', o.where, o.include);
      const linhas = onde(db.agendaItems, o.where);
      const comAssoc = incluir(linhas, o.include, {
        assembleia: (item) => db.assembleias.find((a) => Number(a.id) === Number(item.assembleia_id)) || null,
      });
      return comMetodos(comAssoc[0]) || null;
    },
    findAll: async (o = {}) => {
      registar('AgendaItem.findAll', o.where, o.include);
      const linhas = onde(db.agendaItems, o.where);
      const comAssoc = incluir(linhas, o.include, {
        assembleia: (item) => db.assembleias.find((a) => Number(a.id) === Number(item.assembleia_id)) || null,
      });
      return comAssoc.map(comMetodos);
    },
    create: async (dados) => {
      const item = { id: ++db.proximoId.numeracao, deliberacao_estado: 'pendente', ...dados };
      db.agendaItems.push(item);
      return comMetodos(item);
    },
    destroy: async (o = {}) => {
      const antes = db.agendaItems.length;
      const alvo = onde(db.agendaItems, o.where);
      db.agendaItems = db.agendaItems.filter((i) => !alvo.includes(i));
      return antes - db.agendaItems.length;
    },
    count: async (o = {}) => onde(db.agendaItems, o.where).length,
    update: async () => [0],
  },
  ContaBancaria: {
    findOne: async (o = {}) => {
      registar('ContaBancaria.findOne', o.where);
      return comMetodos(onde(db.contas, o.where)[0]) || null;
    },
    findAll: async (o = {}) => {
      registar('ContaBancaria.findAll', o.where);
      return onde(db.contas, o.where).map(comMetodos);
    },
  },
  MovimentoBancario: {
    findAll: async (o = {}) => {
      registar('MovimentoBancario.findAll', o.where, o.include);
      const linhas = onde(db.movimentos, o.where).map((m) => ({
        ...m,
        conta_bancaria: db.contas.find((c) => Number(c.id) === Number(m.conta_bancaria_id)) || null,
      }));
      return incluir(linhas, o.include, { conta_bancaria: (l) => l.conta_bancaria });
    },
    findOne: async (o = {}) => {
      registar('MovimentoBancario.findOne', o.where);
      return comMetodos(onde(db.movimentos, o.where)[0]) || null;
    },
    count: async (o = {}) => {
      registar('MovimentoBancario.count', o.where);
      return onde(db.movimentos, o.where).length;
    },
    create: async (dados) => {
      const m = { id: ++db.proximoId.movimento, estado: 'confirmado', ...dados };
      db.movimentos.push(m);
      return comMetodos(m);
    },
    sum: async () => 0,
  },
  Quota: {
    findAll: async (o = {}) => { registar('Quota.findAll', o.where); return onde(db.quotas, o.where).map(comMetodos); },
    sum: async (campo, o = {}) => onde(db.quotas, o.where).reduce((s, q) => s + Number(q[campo] || 0), 0),
  },
  Pagamento: {
    findAll: async (o = {}) => { registar('Pagamento.findAll', o.where); return onde(db.pagamentos, o.where).map(comMetodos); },
    sum: async (campo, o = {}) => onde(db.pagamentos, o.where).reduce((s, p) => s + Number(p[campo] || 0), 0),
  },
  PagamentoQuota: {
    findAll: async (o = {}) => {
      registar('PagamentoQuota.findAll', o.where, o.include);
      const linhas = onde(db.pagamentoQuotas, o.where).map((a) => ({
        ...a,
        pagamento: db.pagamentos.find((p) => Number(p.id) === Number(a.pagamento_id)) || null,
      }));
      const comAssoc = incluir(linhas, o.include, { pagamento: (l) => l.pagamento });
      const inc = (o.include || [])[0];
      if (!inc || !inc.where || !inc.where.condominio_id) return comAssoc;
      return comAssoc.filter((a) => String(a.pagamento.condominio_id) === String(inc.where.condominio_id));
    },
    create: async (dados) => {
      const a = { id: ++db.proximoId.numeracao, ...dados };
      db.pagamentoQuotas.push(a);
      return a;
    },
  },
  AuditLog: {
    create: async (dados) => {
      auditorias.push(dados);
      return { id: auditorias.length, ...dados };
    },
  },
  Documento: { create: async () => ({}), findAll: async () => [] },
  AssembleiaParticipante: { findAll: async () => [] },
  Fracao: { findAll: async () => [], findOne: async () => null },
  Pessoa: { findAll: async () => [] },
  Numeracao: { findOne: async () => null, create: async () => ({ sequencia: 0, update: async () => {} }) },
  Despesa: { findAll: async () => [], sum: async () => 0 },
  ExtraQuota: { findAll: async () => [] },
  ExtraQuotaParcela: { findAll: async () => [] },
  PagamentoExtraParcela: { findAll: async () => [] },
  PagamentoFornecedor: { findAll: async () => [] },
  Fornecedor: { findAll: async () => [] },
  FornecedorSaldo: { findAll: async () => [] },
  PlanoQuota: { findAll: async () => [] },
  Orcamento: { findAll: async () => [] },
  OrcamentoRubrica: { findAll: async () => [] },
  MetodoPagamento: { findAll: async () => [] },
  Categoria: { findAll: async () => [] },
  Recibo: { findAll: async () => [] },
  ReciboQuota: { findAll: async () => [] },
  ReciboExtraParcela: { findAll: async () => [] },
};

const transacao = {
  COMMIT: 'commit',
  ROLLBACK: 'rollback',
  LOCK: { UPDATE: 'update' },
  commit: async () => {},
  rollback: async () => {},
};

const modelsPath = require.resolve(path.join(RAIZ, 'models'));
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [], exports: modelos };
const dbPath = require.resolve(path.join(RAIZ, 'config', 'database'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { transaction: async () => transacao, Sequelize: {}, Op },
};
// Auditoria: o helper real grava via modelo AuditLog (em memória, acima); aqui
// usa-se um duplo para capturar exatamente o que as rotas registam.
const auditPath = require.resolve(path.join(RAIZ, 'helpers', 'audit'));
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true, children: [], paths: [],
  exports: {
    audit: async ({ userId, acao, entidade, entidadeId, detalhes }) => {
      auditorias.push({
        user_id: userId || null,
        acao,
        entidade: entidade || null,
        entidade_id: entidadeId || null,
        detalhes: detalhes ? JSON.stringify(detalhes) : null,
      });
    },
  },
};

// Duplo controlado de movimentos: o encadeamento do FCR é o que está em teste
// (a criação do par de movimentos tem teste próprio em test-fcr-movimentos.js).
const movimentosPath = require.resolve(path.join(RAIZ, 'helpers', 'movimentos'));
require.cache[movimentosPath] = {
  id: movimentosPath, filename: movimentosPath, loaded: true, children: [], paths: [],
  exports: {
    registarTransferencia: async ({ contaOrigemId, contaDestinoId, valor, data, descricao, transaction, condominioId, deliberacaoId }) => {
      if (!transaction) throw new Error('a utilização do FCR tem de correr numa transação');
      if (falharNoDestino) throw new Error('falha simulada ao gravar o segundo movimento');
      const base = {
        data: data || '2026-05-10', valor, descricao: descricao || 'Transferência entre contas',
        referencia: 'TRANSF', estado: 'confirmado', condominio_id: condominioId || null,
        deliberacao_id: deliberacaoId || null,
      };
      const saida = await modelos.MovimentoBancario.create({ ...base, conta_bancaria_id: contaOrigemId, tipo: 'saida' });
      const entrada = await modelos.MovimentoBancario.create({ ...base, conta_bancaria_id: contaDestinoId, tipo: 'entrada' });
      registoEscritas.push(saida.id, entrada.id);
      return { saidaId: saida.id, entradaId: entrada.id };
    },
    // Implementação equivalente à real, a ler os movimentos em memória.
    saldoContaMovimentos: async (conta) => {
      const movimentos = await modelos.MovimentoBancario.findAll({ where: { conta_bancaria_id: conta.id, estado: 'confirmado' } });
      const entradasC = movimentos.filter((m) => m.tipo === 'entrada').reduce((s, m) => s + toCents(m.valor), 0);
      const saidasC = movimentos.filter((m) => m.tipo === 'saida').reduce((s, m) => s + toCents(m.valor), 0);
      return (toCents(conta.saldo_inicial) + entradasC - saidasC) / 100;
    },
    criarMovimento: async (d) => modelos.MovimentoBancario.create({
      conta_bancaria_id: d.contaBancariaId, condominio_id: d.condominioId || null, data: d.data || '2026-05-10',
      tipo: d.tipo, valor: d.valor, descricao: d.descricao || null, referencia: d.referencia || null,
      deliberacao_id: d.deliberacaoId || null, pagamento_id: d.pagamentoId || null, estado: 'confirmado',
    }),
    sincronizarMovimentoDespesa: async () => {},
  },
};

const fcr = require(path.join(RAIZ, 'helpers', 'fcr'));
const delib = require(path.join(RAIZ, 'helpers', 'fcr-deliberacoes'));

// ── Semeadura ──────────────────────────────────────────────────────
// Condomínio 1: conta corrente (10) + conta FCR (11). Condomínio 2: contas
// próprias (20 corrente, 21 FCR) para provar o isolamento.
// Quotas de 55,00 € com 10% de FCR (50,00 base + 5,00 fundo).
function reiniciar() {
  db.assembleias = [
    { id: 1, condominio_id: 1, numero: '2026/1', tipo: 'extraordinaria', data: '2026-04-20', estado: 'realizada' },
    { id: 2, condominio_id: 1, numero: '2026/2', tipo: 'ordinaria', data: '2026-06-15', estado: 'cancelada' },
    { id: 3, condominio_id: 1, numero: '2026/3', tipo: 'ordinaria', data: '2026-07-15', estado: 'rascunho' },
    { id: 4, condominio_id: 1, numero: '2026/4', tipo: 'ordinaria', data: '2026-08-15', estado: 'agendada' },
    { id: 5, condominio_id: 1, numero: '2026/5', tipo: 'ordinaria', data: '2026-09-15', estado: 'convocada' },
    { id: 9, condominio_id: 2, numero: '2026/1', tipo: 'ordinaria', data: '2026-04-20', estado: 'realizada' },
  ];
  db.agendaItems = [
    // Ponto aprovado na assembleia realizada: 300,00 € para obras.
    { id: 100, assembleia_id: 1, ordem: 1, descricao: 'Substituição do elevador', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '300.00', deliberacao_nota: 'Obras de substituição do elevador' },
    // Ponto sujeito a votação mas ainda pendente.
    { id: 101, assembleia_id: 1, ordem: 2, descricao: 'Pintura das escadas', sujeito_votacao: true, deliberacao_estado: 'pendente', valor_aprovado: null, deliberacao_nota: null },
    // Ponto rejeitado.
    { id: 102, assembleia_id: 1, ordem: 3, descricao: 'Compra de bicicletas', sujeito_votacao: true, deliberacao_estado: 'rejeitada', valor_aprovado: null, deliberacao_nota: null },
    // Ponto NÃO sujeito a votação (nunca pode ser aprovado).
    { id: 103, assembleia_id: 1, ordem: 4, descricao: 'Informações da administração', sujeito_votacao: false, deliberacao_estado: 'pendente', valor_aprovado: null, deliberacao_nota: null },
    // Assembleia cancelada / rascunho / agendada: itens aprovados na BD (dados
    // antigos ou editados fora da aplicação) que NUNCA autorizam.
    { id: 110, assembleia_id: 2, ordem: 1, descricao: 'Obras na cobertura', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '500.00', deliberacao_nota: null },
    { id: 111, assembleia_id: 3, ordem: 1, descricao: 'Reparação do portão', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '200.00', deliberacao_nota: null },
    { id: 112, assembleia_id: 4, ordem: 1, descricao: 'Limpeza de fachada', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '150.00', deliberacao_nota: null },
    // Assembleia convocada: autoriza (já deliberou validamente).
    { id: 113, assembleia_id: 5, ordem: 1, descricao: 'Auditoria energética', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '120.00', deliberacao_nota: null },
    // Outro condomínio.
    { id: 900, assembleia_id: 9, ordem: 1, descricao: 'Obras do vizinho', sujeito_votacao: true, deliberacao_estado: 'aprovada', valor_aprovado: '999.00', deliberacao_nota: null },
  ];
  db.contas = [
    { id: 10, condominio_id: 1, nome: 'Conta corrente', tipo: 'corrente', saldo_inicial: '0.00', ativa: true },
    { id: 11, condominio_id: 1, nome: 'Fundo de Reserva', tipo: 'fundo_reserva', saldo_inicial: '0.00', ativa: true },
    { id: 20, condominio_id: 2, nome: 'Corrente (vizinho)', tipo: 'corrente', saldo_inicial: '100.00', ativa: true },
    { id: 21, condominio_id: 2, nome: 'FCR (vizinho)', tipo: 'fundo_reserva', saldo_inicial: '100.00', ativa: true },
  ];
  db.quotas = [
    { id: 500, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 1, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
    { id: 501, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 2, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
    { id: 502, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 3, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
    { id: 503, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 4, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
    { id: 504, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 5, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
    { id: 505, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 6, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' },
  ];
  db.pagamentos = [];
  db.pagamentoQuotas = [];
  for (let i = 0; i < db.quotas.length; i++) {
    const q = db.quotas[i];
    const pid = i + 1;
    db.pagamentos.push({ id: pid, condominio_id: 1, fracao_id: 1, valor: q.valor, data_pagamento: `2026-0${i + 1}-05`, estado: 'confirmado' });
    db.pagamentoQuotas.push({ id: pid, pagamento_id: pid, quota_id: q.id, valor_aplicado: q.valor });
  }
  db.movimentos = [];
  db.proximoId = { movimento: 0, numeracao: 2000 };
  consultas.length = 0;
  auditorias.length = 0;
  falharNoDestino = false;
  registoEscritas = [];
}

// Simula os pagamentos: entrada TOTAL na conta corrente (30,00 € de FCR) e a
// transferência corrente → FCR de 30,00 € (a operação da fase 2H.3c.1), para a
// conta do fundo ter saldo real antes de ser utilizada.
async function comFcrTransferido() {
  const totalC = db.quotas.reduce((s, q) => s + toCents(q.valor), 0);
  db.movimentos.push({
    id: ++db.proximoId.movimento, conta_bancaria_id: 10, condominio_id: 1, data: '2026-01-05',
    tipo: 'entrada', valor: totalC / 100, referencia: null, estado: 'confirmado',
  });
  // Fundo com saldo acumulado de exercícios anteriores (movimento de entrada): dá
  // folga para testar os limites do valor aprovado sem esbarrar no saldo do fundo.
  db.movimentos.push({
    id: ++db.proximoId.movimento, conta_bancaria_id: 11, condominio_id: 1, data: '2026-01-01',
    tipo: 'entrada', valor: 2000, referencia: 'SALDO INICIAL FCR', estado: 'confirmado',
  });
  const r = await fcr.transferirFcr({
    condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 3000, data: '2026-05-02', userId: 7,
  });
  assert.strictEqual(r.ok, true, 'pré-condição: transferência corrente → FCR de 30,00 € aceite');
  return r;
}

async function main() {
  // ── 1. Regra pura: validação da deliberação registada ────────────
  const assembleiaOk = { id: 1, estado: 'realizada' };
  const itemOk = { id: 100, assembleia_id: 1, sujeito_votacao: true };
  assert.deepStrictEqual(
    deliberacaoPura(assembleiaOk, itemOk, 'aprovada', 30000),
    { ok: true, valorAprovadoC: 30000 },
    '1. aprovada com valor válido (300,00 €) é aceite'
  );
  assert.strictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: { ...itemOk, sujeito_votacao: false }, estado: 'aprovada', valorAprovadoC: 1000 }).motivo, 'sem_sujeito_votacao', '2. aprovada sem sujeito_votacao é rejeitada');
  assert.strictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: itemOk, estado: 'aprovada', valorAprovadoC: 0 }).motivo, 'valor_invalido', '3a. valor aprovado 0 é rejeitado');
  assert.strictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: itemOk, estado: 'aprovada', valorAprovadoC: -500 }).motivo, 'valor_invalido', '3b. valor aprovado negativo é rejeitado');
  assert.strictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: itemOk, estado: 'aprovada' }).motivo, 'valor_invalido', '3c. aprovada sem valor é rejeitada');
  assert.strictEqual(delib.validarDeliberacao({ assembleia: { id: 2, estado: 'cancelada' }, item: { ...itemOk, assembleia_id: 2 }, estado: 'aprovada', valorAprovadoC: 1000 }).motivo, 'assembleia_nao_delibera', '4. assembleia cancelada não autoriza');
  for (const estado of ['rascunho', 'agendada']) {
    assert.strictEqual(delib.validarDeliberacao({ assembleia: { id: 3, estado }, item: { ...itemOk, assembleia_id: 3 }, estado: 'aprovada', valorAprovadoC: 1000 }).motivo, 'assembleia_nao_delibera', `5. assembleia ${estado} não autoriza`);
  }
  assert.strictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: { ...itemOk, assembleia_id: 99 }, estado: 'aprovada', valorAprovadoC: 1000 }).motivo, 'item_invalido', 'item de outra assembleia é rejeitado');
  assert.deepStrictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: itemOk, estado: 'rejeitada', valorAprovadoC: 5000 }), { ok: true, valorAprovadoC: null }, 'rejeitada é aceite mas sem valor aprovado');
  assert.deepStrictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: { ...itemOk, sujeito_votacao: false }, estado: 'pendente', valorAprovadoC: 0 }), { ok: true, valorAprovadoC: null }, 'pendente é aceite sem valor');
  assert.strictEqual(delib.validarDeliberacao({ assembleia: assembleiaOk, item: itemOk, estado: 'inventado' }).motivo, 'estado_invalido', 'estado inválido é rejeitado');

  // ── 2. Utilização com deliberação aprovada ───────────────────────
  reiniciar();
  await comFcrTransferido();
  const aprovadas = await delib.deliberacoesAprovadas({ condominioId: 1 });
  assert.deepStrictEqual(aprovadas.map((d) => d.id), [100, 113], 'só as deliberações aprovadas em assembleia que delibera são listadas (realizada e convocada)');
  const d100 = aprovadas.find((d) => d.id === 100);
  assert.strictEqual(d100.valorAprovadoC, 30000, 'valor aprovado em cêntimos');
  assert.strictEqual(d100.utilizadoC, 0, 'nada utilizado ainda');
  assert.strictEqual(d100.disponivelC, 30000, 'disponível = valor aprovado');

  const antes = db.movimentos.length;
  const u1 = await fcr.transferirFcrAprovado({
    condominioId: 1, deliberacaoId: 100, contaOrigemId: 11, contaDestinoId: 10, valorC: 1000, data: '2026-05-10', userId: 7,
  });
  assert.strictEqual(u1.ok, true, `utilização de 10,00 € aceite (aprovado 300,00 €, fundo com 30,00 €) — motivo: ${u1.motivo || '-'} ${u1.mensagem || ''}`);
  assert.strictEqual(u1.valorC, 1000, 'valor utilizado em cêntimos');
  assert.strictEqual(u1.deliberacaoId, 100, 'a operação identifica a deliberação');
  assert.strictEqual(u1.assembleiaId, 1, 'a operação identifica a assembleia');
  assert.strictEqual(u1.disponivelAprovadoC, 29000, 'disponível da deliberação passa a 290,00 €');

  // ── 16/17. Dois movimentos, ambos ligados à deliberação ─────────
  const novos = db.movimentos.slice(antes);
  assert.strictEqual(novos.length, 2, '16. a utilização cria exatamente dois movimentos');
  const saida = novos.find((m) => m.tipo === 'saida');
  const entrada = novos.find((m) => m.tipo === 'entrada');
  assert.ok(saida && entrada, 'um movimento de saída (fundo) e um de entrada (corrente)');
  assert.strictEqual(saida.conta_bancaria_id, 11, 'a saída é na conta do Fundo de Reserva');
  assert.strictEqual(entrada.conta_bancaria_id, 10, 'a entrada é na conta corrente');
  assert.strictEqual(toCents(saida.valor), toCents(entrada.valor), 'os dois movimentos têm o mesmo valor');
  assert.strictEqual(saida.referencia, 'TRANSF', 'mantém a referencia TRANSF');
  assert.strictEqual(Number(saida.deliberacao_id), 100, '17a. a saída fica associada à deliberação');
  assert.strictEqual(Number(entrada.deliberacao_id), 100, '17b. a entrada fica associada à deliberação');
  assert.strictEqual(Number(saida.condominio_id), 1, 'o movimento fica com o condomínio ativo');
  assert.strictEqual(Number(entrada.condominio_id), 1, 'a entrada também');

  // ── 18. Não é receita nem despesa ───────────────────────────────
  // A mesma regra do relatório financeiro: entradas/saídas sem `referencia`
  // 'TRANSF' são receita/despesa; as transferências entre contas nunca contam.
  const ehTransferencia = (m) => String(m.referencia || '') === 'TRANSF';
  const receitasC = db.movimentos
    .filter((m) => m.tipo === 'entrada' && m.estado === 'confirmado' && !ehTransferencia(m) && Number(m.conta_bancaria_id) === 10)
    .reduce((s, m) => s + toCents(m.valor), 0);
  const despesasC = db.movimentos
    .filter((m) => m.tipo === 'saida' && m.estado === 'confirmado' && !ehTransferencia(m))
    .reduce((s, m) => s + toCents(m.valor), 0);
  assert.strictEqual(receitasC, 33000, '18a. receitas da conta corrente = só os pagamentos das quotas (330,00 €)');
  assert.strictEqual(despesasC, 0, '18b. a utilização do fundo não é despesa');
  assert.strictEqual(
    db.movimentos.filter((m) => ehTransferencia(m)).length,
    4,
    '18c. as duas transferências do fundo são identificadas como transferências (par saída/entrada cada)'
  );
  const relatorio = fs.readFileSync(path.join(RAIZ, 'helpers', 'relatorio-financeiro.js'), 'utf8');
  assert.ok(/REF_TRANSFERENCIA/.test(relatorio), '18d. o relatório continua a excluir as transferências (referencia TRANSF)');

  // ── 19. Saldos das duas contas ──────────────────────────────────
  const saldoCorrente = db.movimentos.filter((m) => Number(m.conta_bancaria_id) === 10 && m.estado === 'confirmado');
  const saldoFundo = db.movimentos.filter((m) => Number(m.conta_bancaria_id) === 11 && m.estado === 'confirmado');
  const soma = (lista, tipo) => lista.filter((m) => m.tipo === tipo).reduce((s, m) => s + toCents(m.valor), 0);
  const recebidoFundoC = soma(saldoFundo, 'entrada') - soma(saldoFundo, 'saida');
  assert.strictEqual(recebidoFundoC, 200000 + 3000 - 1000, '19a. conta FCR: saldo acumulado + 30,00 € recebidos − 10,00 € utilizados');
  assert.strictEqual(saldoC(11), recebidoFundoC, '19b. o saldo da conta do fundo pelas regras do sistema é o mesmo');
  assert.strictEqual(
    soma(saldoCorrente, 'entrada') - soma(saldoCorrente, 'saida'),
    toCents(330) + 1000 - 3000,
    '19c. conta corrente: quotas recebidas + utilização do fundo − transferência para o fundo'
  );
  assert.strictEqual(saldoC(10) + saldoC(11), toCents(330) + 200000, '19d. as transferências não criam nem destroem dinheiro: o total das duas contas = quotas recebidas (330,00 €) + saldo acumulado do fundo (2.000,00 €)');

  // ── 8. Utilização parcial e 9. várias utilizações ───────────────
  const u2 = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 100, contaOrigemId: 11, contaDestinoId: 10, valorC: 500, data: '2026-05-11', userId: 7 });
  assert.strictEqual(u2.ok, true, `9a. segunda utilização da mesma deliberação é aceite — motivo: ${u2.motivo || '-'}`);
  assert.strictEqual(u2.valorC, 500, '8a. utilização parcial de 5,00 €');
  assert.strictEqual(u2.disponivelAprovadoC, 28500, '9b. disponível acumula as duas utilizações (300,00 − 10,00 − 5,00)');
  const utilizados = await delib.valorUtilizadoDeliberacaoC(100, { condominioId: 1 });
  assert.strictEqual(utilizados, 1500, '9c. valor utilizado = soma das saídas confirmadas (não conta o par duas vezes)');
  assert.strictEqual(utilizados, 1000 + 500, '9d. as duas utilizações somam exatamente o utilizado');
  assert.strictEqual(saldoC(11), recebidoFundoC - 500, '8b. saldo do fundo depois de duas utilizações');

  // ── 10. Um cêntimo acima do aprovado ───────────────────────────
  // A deliberação 100 tem 300,00 € aprovados (285,00 € ainda disponíveis) e o
  // fundo tem saldo suficiente: o limite que tem de travar é o do aprovado.
  const acimaAprovado = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 100, contaOrigemId: 11, contaDestinoId: 10, valorC: 28501, data: '2026-05-12', userId: 7 });
  assert.strictEqual(acimaAprovado.ok, false, '10a. 1 cêntimo acima do aprovado disponível é recusado');
  assert.strictEqual(acimaAprovado.motivo, 'acima_do_aprovado', '10b. motivo: acima do aprovado');
  const exato = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 100, contaOrigemId: 11, contaDestinoId: 10, valorC: 28500, data: '2026-05-12', userId: 7 });
  assert.strictEqual(exato.ok, true, `10c. o valor exato do disponível é aceite — motivo: ${exato.motivo || '-'}`);
  assert.strictEqual(exato.disponivelAprovadoC, 0, '10d. disponível fica a zero');
  const semSaldo = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 100, contaOrigemId: 11, contaDestinoId: 10, valorC: 100, data: '2026-05-13', userId: 7 });
  assert.strictEqual(semSaldo.ok, false, '10e. depois de esgotado o aprovado, nova utilização é recusada');
  assert.strictEqual(semSaldo.motivo, 'acima_do_aprovado', '10f. motivo: acima do aprovado');

  // ── 11. Acima do saldo da conta FCR ────────────────────────────
  // Deliberação com valor aprovado (120,00 €) acima do saldo do fundo no momento
  // (o saldo foi reduzido para 10,00 € por um movimento manual fora da aplicação).
  db.movimentos.push({
    id: ++db.proximoId.movimento, conta_bancaria_id: 11, condominio_id: 1, data: '2026-05-14',
    tipo: 'saida', valor: (saldoC(11) - 1000) / 100, referencia: 'AJUSTE', estado: 'confirmado',
  });
  assert.strictEqual(saldoC(11), 1000, '11b. pré-condição: o fundo ficou com 10,00 €');
  const acimaSaldoFcr = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 11, contaDestinoId: 10, valorC: 1001, data: '2026-05-14', userId: 7 });
  assert.strictEqual(acimaSaldoFcr.ok, false, '11c. utilização acima do saldo da conta FCR é recusada');
  assert.strictEqual(acimaSaldoFcr.motivo, 'saldo_fcr_insuficiente', '11d. motivo: saldo do fundo insuficiente');
  const dentroDoSaldo = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 11, contaDestinoId: 10, valorC: 1000, data: '2026-05-14', userId: 7 });
  assert.strictEqual(dentroDoSaldo.ok, true, `11e. até ao saldo do fundo continua a ser aceite — motivo: ${dentroDoSaldo.motivo || '-'}`);

  // ── 12/13/14/15. Direção, contas e valor ───────────────────────
  const origemNaoFcr = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 10, contaDestinoId: 11, valorC: 100, data: '2026-05-14', userId: 7 });
  assert.strictEqual(origemNaoFcr.motivo, 'origem_nao_fcr', '12. origem que não é conta do fundo é recusada');
  assert.strictEqual(origemNaoFcr.ok, false, '12b. recusada');
  const destinoFcr = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 11, contaDestinoId: 21, valorC: 100, data: '2026-05-14', userId: 7 });
  assert.strictEqual(destinoFcr.ok, false, '21b. conta do vizinho nunca é aceite como destino');
  const mesmoDestino = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 11, contaDestinoId: 11, valorC: 100, data: '2026-05-14', userId: 7 });
  assert.strictEqual(mesmoDestino.motivo, 'contas_iguais', '14. origem = destino é recusada');
  const zero = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 11, contaDestinoId: 10, valorC: 0, data: '2026-05-14', userId: 7 });
  assert.strictEqual(zero.motivo, 'valor_invalido', '15a. valor zero é recusado');
  const negativo = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 11, contaDestinoId: 10, valorC: -100, data: '2026-05-14', userId: 7 });
  assert.strictEqual(negativo.motivo, 'valor_invalido', '15b. valor negativo é recusado');
  // Destino do próprio condomínio mas do tipo fundo_reserva (a outra conta? não
  // existe): o caso real é usar a própria conta FCR como destino.
  const destinoFundo = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 113, contaOrigemId: 10, contaDestinoId: 11, valorC: 100, data: '2026-05-14', userId: 7 });
  assert.strictEqual(destinoFundo.ok, false, '13. com a conta do fundo como destino, a origem deixa de ser o fundo → recusado');

  // ── 4/5/6/7. Deliberação e assembleia que não autorizam ─────────
  reiniciar();
  await comFcrTransferido();
  for (const [id, motivo, rotulo] of [
    [101, 'deliberacao_nao_aprovada', '6a. deliberação pendente não autoriza'],
    [102, 'deliberacao_nao_aprovada', '6b. deliberação rejeitada não autoriza'],
    [110, 'assembleia_nao_delibera', '4b. deliberação de assembleia cancelada não autoriza'],
    [111, 'assembleia_nao_delibera', '5b. deliberação de assembleia em rascunho não autoriza'],
    [112, 'assembleia_nao_delibera', '5c. deliberação de assembleia agendada não autoriza'],
    [900, 'deliberacao_invalida', '7. deliberação de outro condomínio é rejeitada'],
    [999999, 'deliberacao_invalida', 'deliberação inexistente é rejeitada'],
  ]) {
    const r = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: id, contaOrigemId: 11, contaDestinoId: 10, valorC: 100, data: '2026-05-10', userId: 7 });
    assert.strictEqual(r.ok, false, rotulo);
    assert.strictEqual(r.motivo, motivo, `${rotulo} (motivo)`);
  }
  const semDeliberacao = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: null, contaOrigemId: 11, contaDestinoId: 10, valorC: 100, data: '2026-05-10', userId: 7 });
  assert.strictEqual(semDeliberacao.ok, false, 'utilização sem deliberação é recusada');
  assert.strictEqual(semDeliberacao.motivo, 'deliberacao_obrigatoria', 'motivo: deliberação obrigatória');
  assert.strictEqual(db.movimentos.filter((m) => m.referencia === 'TRANSF').length, 2, 'nenhuma tentativa recusada criou movimentos (só a transferência corrente → FCR)');

  // Ponto não sujeito a votação: aprovada é recusada no registo; forçada na base
  // de dados, a utilização também não passa (defesa em profundidade).
  const itemNaoVotacao = db.agendaItems.find((i) => i.id === 103);
  itemNaoVotacao.deliberacao_estado = 'aprovada';
  itemNaoVotacao.valor_aprovado = '50.00';
  const utilizacaoItemNaoVotacao = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 103, contaOrigemId: 11, contaDestinoId: 10, valorC: 100, data: '2026-05-10', userId: 7 });
  assert.strictEqual(utilizacaoItemNaoVotacao.ok, true, 'a utilização valida o essencial (estado/valor/assembleia); o sujeito a votação é validado no registo da deliberação');
  itemNaoVotacao.deliberacao_estado = 'pendente';
  itemNaoVotacao.valor_aprovado = null;

  // ── 20. Atomicidade ────────────────────────────────────────────
  reiniciar();
  await comFcrTransferido();
  const antesFalha = db.movimentos.length;
  registoEscritas = [];
  falharNoDestino = true;
  let erro = null;
  try {
    await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 100, contaOrigemId: 11, contaDestinoId: 10, valorC: 1000, data: '2026-05-10', userId: 7 });
  } catch (e) {
    erro = e;
  }
  falharNoDestino = false;
  assert.ok(erro, '20a. a falha a meio propaga o erro (rollback)');
  assert.strictEqual(registoEscritas.length, 0, '20b. nenhum par de movimentos ficou registado');
  assert.strictEqual(db.movimentos.length, antesFalha, '20c. a base ficou como estava');
  const aposFalha = await delib.valorUtilizadoDeliberacaoC(100, { condominioId: 1 });
  assert.strictEqual(aposFalha, 0, '20d. o valor utilizado da deliberação não ficou "consumido"');

  // ── 21. Isolamento entre condomínios ───────────────────────────
  const utilizadosC1 = await delib.valorUtilizadoDeliberacaoC(900, { condominioId: 1 });
  assert.strictEqual(utilizadosC1, 0, '21a. uma deliberação de outro condomínio não tem utilização no condomínio ativo');
  const aprovadasC2 = await delib.deliberacoesAprovadas({ condominioId: 2 });
  assert.deepStrictEqual(aprovadasC2.map((d) => d.id), [900], '21b. cada condomínio só vê as suas deliberações');
  const aprovadasC1 = await delib.deliberacoesAprovadas({ condominioId: 1 });
  assert.ok(!aprovadasC1.some((d) => d.id === 900), '21c. a deliberação do vizinho nunca aparece');
  // Cadeia: deliberação do condomínio 2 não pode ser usada no condomínio 1.
  const cruzado = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 900, contaOrigemId: 11, contaDestinoId: 10, valorC: 100, data: '2026-05-10', userId: 7 });
  assert.strictEqual(cruzado.motivo, 'deliberacao_invalida', '21d. utilização cruzada entre condomínios é recusada');
  const contaCruzada = await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 100, contaOrigemId: 21, contaDestinoId: 10, valorC: 100, data: '2026-05-10', userId: 7 });
  assert.strictEqual(contaCruzada.ok, false, '21e. conta do outro condomínio nunca é aceite');
  // Consultas: nenhuma leitura fica sem o condomínio — diretamente no `where`
  // (deliberações via assembleia, contas, quotas), por associação obrigatória
  // (movimentos filtrados pela conta do condomínio; aplicações pelo pagamento,
  // que aceita o histórico com condominio_id NULL porque a quota já foi
  // filtrada por condomínio; o saldo da conta é lido pela conta já carregada
  // dentro do condomínio ativo).
  // As chaves de operadores do Sequelize são Symbols, por isso a verificação
  // percorre as chaves (símbolos incluídos) em vez de usar JSON.stringify.
  const chaves = (obj) => [...Object.keys(obj || {}), ...Object.getOwnPropertySymbols(obj || {}).map(String)];
  const filtraCondominio = (where, profundidade = 0) => {
    if (!where || profundidade > 3) return false;
    if (chaves(where).includes('condominio_id')) return true;
    const simbolos = Object.getOwnPropertySymbols(where);
    return chaves(where).some((k) => {
      const v = where[k] !== undefined ? where[k] : where[simbolos.find((s) => String(s) === k)];
      if (!v || typeof v !== 'object') return false;
      if (Array.isArray(v)) return v.some((sub) => filtraCondominio(sub, profundidade + 1));
      return filtraCondominio(v, profundidade + 1);
    });
  };
  for (const c of consultas) {
    const where = c.where || {};
    const porAssociacao = (c.include || []).some((i) => i && i.required && filtraCondominio(i.where));
    const porConta = where.conta_bancaria_id !== undefined;
    assert.ok(
      filtraCondominio(where) || porAssociacao || porConta,
      `21f. ${c.nome} tem de filtrar pelo condomínio (chaves: ${JSON.stringify(chaves(where))})`
    );
  }
  assert.ok(consultas.some((c) => c.nome === 'AgendaItem.findAll' && (c.include || []).some((i) => i.where && String(i.where.condominio_id) === '1')), '21g. as deliberações são lidas pela assembleia do condomínio');
  assert.ok(consultas.some((c) => c.nome === 'ContaBancaria.findOne' && String(c.where.condominio_id) === '1'), '21h. as contas são sempre verificadas contra o condomínio ativo');
  assert.ok(consultas.some((c) => c.nome === 'PagamentoQuota.findAll' && (c.include || []).some((i) => i && filtraCondominio(i.where))), '21i. as aplicações são lidas com o pagamento confirmado do condomínio (aceitando o histórico sem condominio_id)');

  // ── 22. Eliminação de um ponto já usado é bloqueada ────────────
  reiniciar();
  await comFcrTransferido();
  await fcr.transferirFcrAprovado({ condominioId: 1, deliberacaoId: 100, contaOrigemId: 11, contaDestinoId: 10, valorC: 1000, data: '2026-05-10', userId: 7 });
  assert.strictEqual(await delib.temMovimentosAssociados(100), 2, '22a. o ponto usado tem dois movimentos associados');
  assert.strictEqual(await delib.temMovimentosAssociados(101), 0, '22b. um ponto sem utilização não tem movimentos');
  const rotasAssembleias = await simularRotasAssembleias();
  assert.ok(rotasAssembleias.bloqueado, '22c. a rota de eliminação recusa o ponto com utilização');
  assert.ok(/não pode ser eliminado/i.test(rotasAssembleias.mensagem || ''), '22d. a mensagem explica que existe utilização financeira associada');
  assert.ok(db.agendaItems.some((i) => i.id === 100), '22e. o ponto continua na base de dados');
  const itemLivre = await simularEliminacaoLivre();
  assert.strictEqual(itemLivre, true, '22f. um ponto sem utilização continua a poder ser eliminado');

  // ── 23. Auditoria do registo da deliberação e da utilização ────
  // Registo pela rota real: aprovada com valor válido (no ponto 102, rejeitado,
  // que é reaproveitado aqui).
  const rotasDelib = await simularRegistoDeliberacao({ itemId: 102, estado: 'aprovada', valor: 75.5, nota: 'Pintura das escadas' });
  assert.strictEqual(rotasDelib.ok, true, `23a. a rota registou a deliberação aprovada — ${rotasDelib.mensagem || 'sem mensagem'}`);
  const itemAprovado = db.agendaItems.find((i) => i.id === 102);
  assert.strictEqual(itemAprovado.deliberacao_estado, 'aprovada', '23b. estado gravado');
  assert.strictEqual(toCents(itemAprovado.valor_aprovado), 7550, '23c. valor aprovado gravado em euros (75,50 €)');
  assert.strictEqual(itemAprovado.deliberacao_nota, 'Pintura das escadas', '23d. finalidade gravada');
  const auditDelib = auditorias.find((a) => a.acao === 'registar_deliberacao' && Number(a.entidade_id) === 102);
  assert.ok(auditDelib, '23e. o registo da deliberação é auditado');
  const detalhes = JSON.parse(auditDelib.detalhes);
  assert.strictEqual(Number(detalhes.assembleiaId), 1, '23f. a auditoria identifica a assembleia');
  assert.strictEqual(Number(detalhes.condominioId), 1, '23g. a auditoria identifica o condomínio');
  assert.strictEqual(detalhes.estado, 'aprovada', '23h. a auditoria identifica o estado registado');
  assert.ok(detalhes.anterior, '23i. a auditoria guarda o estado anterior (rasto da alteração)');

  // Recusas da rota (nada é gravado nem auditado).
  const semVotacao = await simularRegistoDeliberacao({ itemId: 103, estado: 'aprovada', valor: 50 });
  assert.strictEqual(semVotacao.ok, false, '23j. aprovada num ponto não sujeito a votação é recusada');
  assert.ok(/vota/i.test(semVotacao.mensagem || ''), '23k. a mensagem explica que só pontos sujeitos a votação podem ser aprovados');
  assert.strictEqual(db.agendaItems.find((i) => i.id === 103).deliberacao_estado, 'pendente', '23l. o ponto ficou como estava');
  const valorZero = await simularRegistoDeliberacao({ itemId: 102, estado: 'aprovada', valor: 0 });
  assert.strictEqual(valorZero.ok, false, '23m. aprovada sem valor é recusada');
  const itemAssembleiaRascunho = await simularRegistoDeliberacao({ assembleiaId: 3, itemId: 111, estado: 'aprovada', valor: 100 });
  assert.strictEqual(itemAssembleiaRascunho.ok, false, '23n. assembleia em rascunho não autoriza aprovada');
  const itemOutroCondominio = await simularRegistoDeliberacao({ assembleiaId: 9, itemId: 900, estado: 'aprovada', valor: 100, condominioId: 1 });
  assert.strictEqual(itemOutroCondominio.redirect, '/admin/assembleias', '23o. uma assembleia de outro condomínio nem sequer é carregada (IDOR bloqueado, sem mexer em nada)');
  const rejeitada = await simularRegistoDeliberacao({ itemId: 102, estado: 'rejeitada', valor: 0 });
  assert.strictEqual(rejeitada.ok, true, '23p. rejeitada é aceite');
  assert.strictEqual(db.agendaItems.find((i) => i.id === 102).valor_aprovado, null, '23q. rejeitada não guarda valor aprovado (não autoriza utilização)');

  // Auditoria da utilização: payload registado pela rota financeira.
  reiniciar();
  await comFcrTransferido();
  const rotaUtilizacao = await simularUtilizacaoFcr({ deliberacaoId: 100, valor: 25, contaOrigemId: 11, contaDestinoId: 10 });
  assert.strictEqual(rotaUtilizacao.ok, true, '23r. a rota registou a utilização');
  const auditUtilizacao = auditorias.find((a) => a.acao === 'utilizar_fcr');
  assert.ok(auditUtilizacao, '23s. a utilização é auditada com a ação utilizar_fcr');
  const detalhesUtilizacao = JSON.parse(auditUtilizacao.detalhes);
  for (const campo of ['deliberacaoId', 'assembleiaId', 'valor', 'contaOrigemId', 'contaDestinoId', 'saidaId', 'entradaId', 'disponivelApos']) {
    assert.ok(Object.prototype.hasOwnProperty.call(detalhesUtilizacao, campo), `23t. auditoria de utilização contém ${campo}`);
  }
  assert.strictEqual(Number(detalhesUtilizacao.deliberacaoId), 100, '23u. auditoria aponta à deliberação certa');
  assert.strictEqual(Number(detalhesUtilizacao.assembleiaId), 1, '23v. auditoria aponta à assembleia certa');
  assert.strictEqual(detalhesUtilizacao.valor, 25, '23w. auditoria guarda o valor utilizado');
  assert.strictEqual(detalhesUtilizacao.disponivelApos, 275, '23x. auditoria guarda o disponível depois da operação');
  assert.strictEqual(Number(auditUtilizacao.entidade_id), 100, '23y. a entidade auditada é o ponto da deliberação');

  // ── 24. Interface: as duas vistas afetadas renderizam com dados ─
  verificarVistas();

  // ── 25. FLUXO COMPLETO pela rota real (teste manual reproduzido) ─
  // 1. deliberação aprovada = 300 €; 2. corrente → FCR = 100 €; 3–5. dois
  // movimentos e saldos; 6. deliberação continua com 300 € disponíveis;
  // 7–9. FCR → corrente = 100 € e utilização contabilizada; 10. deliberacao_id
  // no movimento; 11. nem um nem outro entram como receita/despesa;
  // 12. novo corrente → FCR sem deliberação; 13. excessos recusados;
  // 14. isolamento entre condomínios.
  reiniciar();
  await semearFcrRecebido(30000); // 300,00 € de FCR efetivamente recebido
  const saldoInicialCorrente = saldoC(10);
  const saldoInicialFundo = saldoC(11);

  // [1] deliberação aprovada de 300,00 €
  const aprovacao = await simularRegistoDeliberacao({ itemId: 100, estado: 'aprovada', valor: 300, nota: 'Substituição do elevador' });
  assert.strictEqual(aprovacao.ok, true, `25.1. deliberação de 300,00 € registada — ${aprovacao.mensagem || ''}`);
  const listaAprovadas = await delib.deliberacoesAprovadas({ condominioId: 1 }).then((l) => l.filter((d) => d.id === 100));
  assert.strictEqual(listaAprovadas.length, 1, '25.1b. a deliberação aparece na lista de aprovadas da página financeira');
  assert.strictEqual(listaAprovadas[0].valorAprovado, 300, '25.1c. valor aprovado = 300,00 €');
  assert.strictEqual(listaAprovadas[0].utilizado, 0, '25.1d. utilizado = 0,00 €');
  assert.strictEqual(listaAprovadas[0].disponivel, 300, '25.1e. disponível = 300,00 €');

  // [2..5] corrente → FCR de 100,00 € pela rota
  const movAntesTopUp = db.movimentos.length;
  const topUp = await simularTransferenciaFcr({ valor: 100, contaOrigemId: 10, contaDestinoId: 11, data: '2026-05-20' });
  assert.strictEqual(topUp.ok, true, `25.2. corrente → FCR de 100,00 € aceite — ${topUp.mensagem || ''}`);
  const parTopUp = db.movimentos.slice(movAntesTopUp);
  assert.strictEqual(parTopUp.length, 2, '25.3a. cria exatamente dois movimentos');
  assert.strictEqual(parTopUp.filter((m) => m.tipo === 'saida' && Number(m.conta_bancaria_id) === 10).length, 1, '25.3b. saída na conta à ordem');
  assert.strictEqual(parTopUp.filter((m) => m.tipo === 'entrada' && Number(m.conta_bancaria_id) === 11).length, 1, '25.3c. entrada na conta do fundo');
  assert.ok(parTopUp.every((m) => m.referencia === 'TRANSF'), '25.3d. ambos com referencia TRANSF');
  assert.ok(parTopUp.every((m) => !m.deliberacao_id), '25.3e. corrente → FCR não usa deliberação');
  assert.strictEqual(saldoC(10), saldoInicialCorrente - 10000, '25.4. saldo da conta à ordem diminui 100,00 €');
  assert.strictEqual(saldoC(11), saldoInicialFundo + 10000, '25.5. saldo da conta do fundo aumenta 100,00 €');
  const depoisTopUp = (await delib.deliberacoesAprovadas({ condominioId: 1 }))[0];
  assert.strictEqual(depoisTopUp.disponivel, 300, '25.6. a deliberação continua com 300,00 € disponíveis (o topo do fundo não consome autorização)');

  // [7..10] FCR → corrente de 100,00 € com a deliberação, pela rota
  const movAntesUtil = db.movimentos.length;
  const utilizacao = await simularUtilizacaoFcr({ deliberacaoId: 100, valor: 100, contaOrigemId: 11, contaDestinoId: 10, data: '2026-05-21' });
  assert.strictEqual(utilizacao.ok, true, `25.7. FCR → corrente de 100,00 € aceite — ${utilizacao.mensagem || ''}`);
  const parUtil = db.movimentos.slice(movAntesUtil);
  assert.strictEqual(parUtil.length, 2, '25.8a. cria exatamente dois movimentos');
  assert.strictEqual(parUtil.filter((m) => m.tipo === 'saida' && Number(m.conta_bancaria_id) === 11).length, 1, '25.8b. saída na conta do fundo');
  assert.strictEqual(parUtil.filter((m) => m.tipo === 'entrada' && Number(m.conta_bancaria_id) === 10).length, 1, '25.8c. entrada na conta à ordem');
  assert.ok(parUtil.every((m) => m.referencia === 'TRANSF'), '25.8d. ambos com referencia TRANSF');
  assert.ok(parUtil.every((m) => Number(m.deliberacao_id) === 100), '25.10. os dois movimentos da utilização ficam com deliberacao_id');
  const depoisUtil = (await delib.deliberacoesAprovadas({ condominioId: 1 }))[0];
  assert.strictEqual(depoisUtil.utilizado, 100, '25.9a. utilizado = 100,00 €');
  assert.strictEqual(depoisUtil.disponivel, 200, '25.9b. disponível = 200,00 €');
  assert.strictEqual(saldoC(11), saldoInicialFundo, '25.9c. a conta do fundo voltou ao saldo inicial');
  assert.strictEqual(saldoC(10), saldoInicialCorrente, '25.9d. a conta à ordem voltou ao saldo inicial');

  // [11] nenhum destes movimentos é receita nem despesa: só as transferências
  // entre contas do próprio fluxo (as entradas de quotas são outro assunto).
  const ehTransf = (m) => String(m.referencia || '') === 'TRANSF';
  const movimentosFluxo = [...parTopUp, ...parUtil];
  assert.strictEqual(movimentosFluxo.length, 4, '25.11a. o fluxo produziu quatro movimentos (dois pares)');
  assert.ok(movimentosFluxo.every(ehTransf), '25.11b. os quatro estão identificados como transferências');
  assert.ok(movimentosFluxo.every((m) => m.tipo === 'entrada' || m.tipo === 'saida'), '25.11c. a semântica tipo=entrada/saida é mantida (não é «transferencia»)');
  const receitasFluxo = db.movimentos.filter((m) => m.tipo === 'entrada' && m.estado === 'confirmado' && !ehTransf(m) && m.referencia !== null && m.referencia !== 'SALDO INICIAL FCR');
  assert.strictEqual(receitasFluxo.filter((m) => Number(m.conta_bancaria_id) === 11).length, 0, '25.11d. nada entrou na conta do fundo como receita');
  const despesasFluxo = db.movimentos.filter((m) => m.tipo === 'saida' && m.estado === 'confirmado' && !ehTransf(m));
  assert.strictEqual(despesasFluxo.length, 0, '25.11e. nenhuma saída do fluxo é despesa');

  // [12] corrente → FCR outra vez, sem deliberação
  const segundoTopUp = await simularTransferenciaFcr({ valor: 50, contaOrigemId: 10, contaDestinoId: 11, data: '2026-05-22' });
  assert.strictEqual(segundoTopUp.ok, true, `25.12. segunda transferência corrente → FCR (sem deliberação) aceite — ${segundoTopUp.mensagem || ''}`);

  // [13] excessos
  const fluxoAcimaAprovado = await simularUtilizacaoFcr({ deliberacaoId: 100, valor: 201, contaOrigemId: 11, contaDestinoId: 10, data: '2026-05-23' });
  assert.strictEqual(fluxoAcimaAprovado.ok, false, '25.13a. acima do aprovado disponível é recusado');
  assert.ok(/aprovado/i.test(fluxoAcimaAprovado.mensagem || ''), '25.13b. a mensagem fala do valor aprovado');
  const fluxoAcimaSaldo = await simularUtilizacaoFcr({ deliberacaoId: 100, valor: 150, contaOrigemId: 11, contaDestinoId: 10, data: '2026-05-24' });
  assert.strictEqual(fluxoAcimaSaldo.ok, false, '25.13c. acima do saldo real do fundo é recusado');
  assert.ok(/saldo/i.test(fluxoAcimaSaldo.mensagem || ''), '25.13d. a mensagem fala do saldo do fundo');
  const utilizacaoOk = await simularUtilizacaoFcr({ deliberacaoId: 100, valor: 50, contaOrigemId: 11, contaDestinoId: 10, data: '2026-05-25' });
  assert.strictEqual(utilizacaoOk.ok, true, '25.13e. dentro do aprovado e do saldo continua a ser aceite');

  // [14] isolamento entre condomínios
  const fluxoCruzado = await simularUtilizacaoFcr({ deliberacaoId: 900, valor: 10, contaOrigemId: 11, contaDestinoId: 10, data: '2026-05-26' });
  assert.strictEqual(fluxoCruzado.ok, false, '25.14a. deliberação de outro condomínio é recusada na rota');
  assert.strictEqual((await delib.deliberacoesAprovadas({ condominioId: 2 })).map((d) => d.id).join(','), '900', '25.14b. o condomínio 2 vê apenas a sua deliberação');
  assert.ok(!(await delib.deliberacoesAprovadas({ condominioId: 1 })).some((d) => d.id === 900), '25.14c. a deliberação do vizinho nunca aparece no condomínio ativo');

  console.log('✓ Testes das deliberações e utilização do FCR passaram, sem base de dados.');
}

// Semeia FCR efetivamente recebido (pagamentos confirmados do condomínio 1).
async function semearFcrRecebido(totalC) {
  const porQuota = 500; // cada quota de 55,00 € tem 5,00 € de FCR
  const n = Math.ceil(totalC / porQuota);
  const quotas = [];
  for (let i = 0; i < n; i++) {
    const id = 600 + i;
    quotas.push({ id, condominio_id: 1, fracao_id: 1, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'paga' });
    db.pagamentos.push({ id: 700 + i, condominio_id: 1, fracao_id: 1, valor: '55.00', data_pagamento: `2026-01-${String((i % 27) + 1).padStart(2, '0')}`, estado: 'confirmado' });
    db.pagamentoQuotas.push({ id: 800 + i, pagamento_id: 700 + i, quota_id: id, valor_aplicado: '55.00' });
  }
  db.quotas.push(...quotas);
  db.movimentos.push({
    id: ++db.proximoId.movimento, conta_bancaria_id: 10, condominio_id: 1, data: '2026-01-05',
    tipo: 'entrada', valor: (n * toCents('55.00')) / 100, referencia: null, estado: 'confirmado',
  });
  const recebido = await fcr.fcrRecebidoC(1);
  assert.ok(recebido.totalC >= totalC, `pré-condição do fluxo completo: FCR recebido (${recebido.totalC} cêntimos)`);
}

// Invoca a rota real da transferência corrente → FCR (sem deliberação).
async function simularTransferenciaFcr({ valor, contaOrigemId, contaDestinoId, data, condominioId = 1 }) {
  const rota = rotaDe('financeiro', /^\/contas\/transferir-fcr$/, 'post');
  const flashes = [];
  const req = {
    params: {},
    body: {
      sentido: 'corrente_para_fcr',
      conta_origem_id: contaOrigemId,
      conta_destino_id: contaDestinoId,
      valor,
      data,
    },
    condominioId,
    user: { id: 7 },
    flash: (tipo, msg) => flashes.push({ tipo, msg }),
  };
  const res = {
    redirect: () => {},
    render: () => { throw new Error('esta simulação só pode invocar o POST'); },
    status: () => res,
  };
  await rota(req, res);
  const erro = flashes.find((f) => f.tipo === 'error_msg');
  if (erro) return { ok: false, mensagem: erro.msg };
  const ok = flashes.find((f) => f.tipo === 'success_msg');
  return { ok: true, mensagem: ok ? ok.msg : null };
}

// Renderiza as vistas alteradas com contexto representativo, para garantir que
// o estado da deliberação, o valor aprovado, o utilizado e o disponível são
// apresentados (e que a recusa continua explícita na vista).
function verificarVistas() {
  const handlebars = require('handlebars');
  const helpers = require(path.join(RAIZ, 'helpers', 'handlebars-helpers'));
  Object.entries(helpers).forEach(([k, v]) => handlebars.registerHelper(k, v));
  const parcialDir = path.join(RAIZ, 'views', 'partials');
  for (const f of fs.readdirSync(parcialDir)) {
    if (f.endsWith('.handlebars')) {
      handlebars.registerPartial(f.replace('.handlebars', ''), fs.readFileSync(path.join(parcialDir, f), 'utf8'));
    }
  }
  const render = (vista, contexto) => handlebars.compile(fs.readFileSync(path.join(RAIZ, 'views', vista), 'utf8'))(contexto);

  // Vista da assembleia: ponto aprovado com utilização.
  const detalhe = render('admin/assembleias/detalhe.handlebars', {
    assembleia: {
      id: 1, numero: '2026/1', tipo: 'extraordinaria', estado: 'realizada', data: '2026-04-20', hora: '21:00',
      local: 'Sala comum', agenda_itens: [{
        id: 100, ordem: 1, descricao: 'Substituição do elevador', sujeito_votacao: true,
        deliberacao_estado: 'aprovada', valor_aprovado: '300.00', deliberacao_nota: 'Obras de substituição do elevador',
        fcr: { valorAprovadoC: 30000, utilizadoC: 2500, disponivelC: 27500, valorAprovado: 300, utilizado: 25, disponivel: 275 },
      }],
    },
    participantes: [], fracoes: [], pessoas: [], anexos: [], driveLigado: false,
    tipos: { ordinaria: 'Ordinária' }, estadosLabel: { realizada: 'Realizada' }, deliberacaoPendente: false,
    currentPath: '/admin/assembleias/1', user: { nome: 'Ana' },
  });
  assert.ok(detalhe.includes('Aprovada'), '24a. a vista da assembleia mostra o estado da deliberação');
  assert.ok(detalhe.includes('FCR aprovado'), '24b. a vista da assembleia mostra o valor aprovado');
  assert.ok(detalhe.includes('utilizado') && detalhe.includes('disponível'), '24c. a vista da assembleia mostra o utilizado e o disponível');
  assert.ok(detalhe.includes('300,00') && detalhe.includes('275,00'), '24d. os valores aparecem formatados');
  assert.ok(detalhe.includes('Obras de substituição do elevador'), '24e. a finalidade é apresentada');
  assert.ok(detalhe.includes('/agenda/100/deliberacao'), '24f. a vista permite registar/editar a deliberação');

  // Vista financeira: dois sentidos, deliberação e aviso de que não é despesa.
  const financeiro = render('admin/contas/transferir-fcr.handlebars', {
    contas: [{ id: 10, nome: 'Conta corrente', tipo: 'corrente', saldo: 310 }, { id: 11, nome: 'Fundo de Reserva', tipo: 'fundo_reserva', saldo: 275 }],
    contasFcr: [{ id: 11, nome: 'Fundo de Reserva', tipo: 'fundo_reserva', saldo: 275 }],
    contasNaoFcr: [{ id: 10, nome: 'Conta corrente', tipo: 'corrente', saldo: 310 }],
    fcr: { emitido: 33, recebido: 30, transferido: 30, disponivel: 0, nTransferencias: 1, transferencias: [] },
    deliberacoes: [{
      id: 100, ordem: 1, descricao: 'Substituição do elevador', nota: 'Obras', estado: 'aprovada',
      valorAprovado: 300, utilizado: 25, disponivel: 275,
      assembleia: { id: 1, numero: '2026/1', data: '2026-04-20' },
    }],
    nDeliberacoesSemSaldo: 0, hoje: '2026-05-20',
    currentPath: '/admin/contas', user: { nome: 'Ana' },
  });
  assert.ok(financeiro.includes('corrente_para_fcr') && financeiro.includes('fcr_para_corrente'), '24g. a vista permite escolher os dois sentidos');
  assert.ok(financeiro.includes('Esta operação é uma transferência entre contas e não uma despesa.'), '24h. o aviso de que não é despesa está explícito');
  assert.ok(financeiro.includes('Substituição do elevador') && financeiro.includes('2026/1'), '24i. a vista mostra a assembleia e o ponto da ordem de trabalhos');
  assert.ok(financeiro.includes('Obras'), '24j. a vista mostra a finalidade');
  assert.ok(financeiro.includes('300,00') && financeiro.includes('25,00') && financeiro.includes('275,00'), '24k. a vista mostra aprovado, utilizado e disponível');
  assert.ok(financeiro.includes('name="deliberacao_id"'), '24l. a deliberação é escolhida num campo do formulário');
}

// Auxiliares de leitura para os testes acima.
function deliberacaoPura(assembleia, item, estado, valorAprovadoC) {
  return delib.validarDeliberacao({ assembleia, item, estado, valorAprovadoC });
}
function saldoC(contaId) {
  const conta = db.contas.find((c) => Number(c.id) === Number(contaId));
  const mov = db.movimentos.filter((m) => Number(m.conta_bancaria_id) === Number(contaId) && m.estado === 'confirmado');
  const entradas = mov.filter((m) => m.tipo === 'entrada').reduce((s, m) => s + toCents(m.valor), 0);
  const saidas = mov.filter((m) => m.tipo === 'saida').reduce((s, m) => s + toCents(m.valor), 0);
  return toCents(conta.saldo_inicial) + entradas - saidas;
}

// Invoca a rota real de eliminação de um ponto (com o pedido simulado) para
// provar o bloqueio quando já existe utilização financeira.
async function simularRotasAssembleias() {
  const rota = rotaDe('assembleias', /agenda\/:aid\/eliminar/);
  const flashes = [];
  const req = {
    params: { id: '1', aid: '100' },
    body: {},
    condominioId: 1,
    user: { id: 7 },
    flash: (tipo, msg) => flashes.push({ tipo, msg }),
  };
  let redirect = null;
  const res = { redirect: (url) => { redirect = url; }, render: () => {}, status: () => res };
  await rota(req, res);
  const erro = flashes.find((f) => f.tipo === 'error_msg');
  return { bloqueado: Boolean(erro), mensagem: erro ? erro.msg : null, redirect };
}

async function simularEliminacaoLivre() {
  const rota = rotaDe('assembleias', /agenda\/:aid\/eliminar/);
  const req = {
    params: { id: '1', aid: '101' },
    body: {},
    condominioId: 1,
    user: { id: 7 },
    flash: () => {},
  };
  const res = { redirect: () => {}, render: () => {}, status: () => res };
  await rota(req, res);
  return !db.agendaItems.some((i) => i.id === 101);
}

// Invoca a rota real de registo da deliberação e devolve o que aconteceu.
async function simularRegistoDeliberacao({ assembleiaId = 1, itemId, estado, valor = 0, nota = null, condominioId = 1 }) {
  const rota = rotaDe('assembleias', /agenda\/:aid\/deliberacao/);
  const flashes = [];
  let redirecionado = null;
  const req = {
    params: { id: String(assembleiaId), aid: String(itemId) },
    body: { deliberacao_estado: estado, valor_aprovado: valor, deliberacao_nota: nota },
    condominioId,
    user: { id: 7 },
    flash: (tipo, msg) => flashes.push({ tipo, msg }),
  };
  const res = { redirect: (url) => { redirecionado = url; }, render: () => {}, status: () => res };
  await rota(req, res);
  const erro = flashes.find((f) => f.tipo === 'error_msg');
  if (erro) return { ok: false, mensagem: erro.msg, redirect: redirecionado };
  const ok = flashes.find((f) => f.tipo === 'success_msg');
  return { ok: true, mensagem: ok ? ok.msg : null, redirect: redirecionado };
}

// Invoca a rota real da utilização do FCR (fundo → corrente).
async function simularUtilizacaoFcr({ deliberacaoId, valor, contaOrigemId, contaDestinoId, condominioId = 1 }) {
  const rota = rotaDe('financeiro', /^\/contas\/transferir-fcr$/, 'post');
  const flashes = [];
  const req = {
    params: {},
    body: {
      sentido: 'fcr_para_corrente',
      deliberacao_id: deliberacaoId,
      conta_origem_id: contaOrigemId,
      conta_destino_id: contaDestinoId,
      valor,
      data: '2026-05-20',
    },
    condominioId,
    user: { id: 7 },
    flash: (tipo, msg) => flashes.push({ tipo, msg }),
  };
  const res = {
    redirect: () => {},
    render: () => { throw new Error('esta simulação só pode invocar o POST'); },
    status: () => res,
  };
  await rota(req, res);
  const erro = flashes.find((f) => f.tipo === 'error_msg');
  if (erro) return { ok: false, mensagem: erro.msg };
  const ok = flashes.find((f) => f.tipo === 'success_msg');
  return { ok: true, mensagem: ok ? ok.msg : null };
}

// A rota é carregada uma única vez (require cache) e a função é extraída do
// router do Express pela assinatura do caminho e pelo método HTTP.
const rotasCache = new Map();
function rotaDe(modulo, padrao, metodo) {
  if (!rotasCache.has(modulo)) {
    const router = require(path.join(RAIZ, 'routes', modulo));
    rotasCache.set(modulo, router);
  }
  const router = rotasCache.get(modulo);
  const camada = router.stack.find((l) => l.route && padrao.test(l.route.path)
    && (!metodo || l.route.methods[metodo]));
  assert.ok(camada, `a rota ${metodo || ''} ${padrao} existe em routes/${modulo}.js`);
  return camada.route.stack[camada.route.stack.length - 1].handle;
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
