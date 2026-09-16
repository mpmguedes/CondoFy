// ═══════════════════════════════════════════════════════════════════
// FCR — receção e transferência do Fundo Comum de Reserva.
//
// Testes offline (sem base de dados nem rede) do ciclo:
//   quota com FCR → pagamento → FCR recebido → transferência → conta FCR
//
// O que se garante aqui:
//  · o pagamento entra na conta corrente pelo valor TOTAL (sem entrada
//    fictícia de FCR);
//  · a parcela de FCR de cada pagamento é proporcional e nunca conta duas vezes;
//  · FCR emitido ≠ recebido ≠ transferido ≠ disponível;
//  · a transferência cria exatamente dois movimentos (saída/entrada), atómicos,
//    com o mesmo valor, identificados por 'TRANSF' e sem efeito em
//    receitas/despesas;
//  · todas as validações (destino FCR, origem ≠ destino, valor positivo, valor ≤
//    disponível e ≤ saldo da origem) e o isolamento por condomínio.
//
// Utilização: node scripts/test-fcr-movimentos.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents } = require(path.join(RAIZ, 'helpers', 'money'));

// ── "Base de dados" em memória ─────────────────────────────────────
const db = {
  contas: [],
  quotas: [],
  pagamentos: [],
  pagamentoQuotas: [],
  movimentos: [],
  proximoId: { conta: 0, quota: 0, pagamento: 0, movimento: 0, numeracao: 0 },
};
const consultas = [];
const registar = (nome, where, include) => consultas.push({ nome, where, include });

function onde(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].map(Number).includes(Number(l[k]));
    if (v && typeof v === 'object' && v[Op.ne] !== undefined) return l[k] !== v[Op.ne];
    return String(l[k]) === String(v);
  }));
}

// As linhas guardadas na "base de dados" em memória precisam dos métodos que o
// Sequelize expõe (update): o duplo devolve o registo com o mesmo estado.
function comMetodos(linha) {
  if (!linha) return linha;
  return Object.assign(linha, { update: async (v) => Object.assign(linha, v) });
}

// Igual ao que o Sequelize faz com `include ... required: true`: aplica o
// filtro do modelo incluído sobre os campos do registo associado.
function incluir(linhas, include, camposAssoc) {
  if (!include || !include.length) return linhas;
  const inc = include[0];
  const alias = inc.as;
  const chave = camposAssoc[alias];
  return linhas.filter((l) => {
    const assoc = l[alias];
    if (!assoc) return false;
    const valor = assoc[chave];
    const alvo = inc.where ? inc.where[chave] : undefined;
    if (alvo === undefined) return true;
    if (alvo && typeof alvo === 'object' && alvo[Op.in]) return alvo[Op.in].map(Number).includes(Number(valor));
    return String(valor) === String(alvo);
  });
}

const modelos = {
  ContaBancaria: {
    findAll: async (o = {}) => { registar('ContaBancaria.findAll', o.where); return onde(db.contas, o.where); },
    findOne: async (o = {}) => { registar('ContaBancaria.findOne', o.where); return onde(db.contas, o.where)[0] || null; },
    sum: async () => 0,
  },
  MovimentoBancario: {
    findAll: async (o = {}) => {
      registar('MovimentoBancario.findAll', o.where, o.include);
      const linhas = onde(db.movimentos, o.where).map((m) => ({
        ...m,
        conta_bancaria: db.contas.find((c) => Number(c.id) === Number(m.conta_bancaria_id)) || null,
      }));
      return incluir(linhas, o.include, { conta_bancaria: 'condominio_id' });
    },
    sum: async (campo, o = {}) => {
      registar('MovimentoBancario.sum', o.where);
      return onde(db.movimentos, o.where).reduce((s, m) => s + Number(m.valor || 0), 0);
    },
    findOne: async (o = {}) => { registar('MovimentoBancario.findOne', o.where); return onde(db.movimentos, o.where)[0] || null; },
    create: async (dados) => {
      const m = { id: ++db.proximoId.movimento, estado: 'confirmado', ...dados };
      db.movimentos.push(m);
      return { ...m, update: async (v) => Object.assign(m, v) };
    },
  },
  Quota: {
    findAll: async (o = {}) => { registar('Quota.findAll', o.where); return onde(db.quotas, o.where).map(comMetodos); },
    findOne: async (o = {}) => { registar('Quota.findOne', o.where); return comMetodos(onde(db.quotas, o.where)[0]) || null; },
    sum: async (campo, o = {}) => {
      registar('Quota.sum', o.where);
      return onde(db.quotas, o.where).reduce((s, q) => s + Number(q[campo] || 0), 0);
    },
  },
  Pagamento: {
    findAll: async (o = {}) => { registar('Pagamento.findAll', o.where); return onde(db.pagamentos, o.where).map(comMetodos); },
    findOne: async (o = {}) => { registar('Pagamento.findOne', o.where); return comMetodos(onde(db.pagamentos, o.where)[0]) || null; },
    findByPk: async (id) => comMetodos(db.pagamentos.find((p) => Number(p.id) === Number(id))) || null,
    create: async (dados) => {
      const p = { id: ++db.proximoId.pagamento, estado: 'confirmado', ...dados };
      db.pagamentos.push(p);
      return { ...p, update: async (v) => Object.assign(p, v) };
    },
  },
  PagamentoQuota: {
    findAll: async (o = {}) => {
      registar('PagamentoQuota.findAll', o.where, o.include);
      const linhas = onde(db.pagamentoQuotas, o.where).map((a) => ({
        ...a,
        pagamento: db.pagamentos.find((p) => Number(p.id) === Number(a.pagamento_id)) || null,
      }));
      return incluir(linhas, o.include, { pagamento: 'estado' }).filter((a) => {
        const inc = (o.include || [])[0];
        if (!inc || !inc.where || !inc.where.condominio_id) return true;
        return String(a.pagamento && a.pagamento.condominio_id) === String(inc.where.condominio_id);
      });
    },
    create: async (dados) => {
      const a = { id: ++db.proximoId.numeracao, ...dados };
      db.pagamentoQuotas.push(a);
      return a;
    },
  },
  Numeracao: {
    findOne: async () => null,
    create: async () => ({ sequencia: 0, update: async () => {} }),
    update: async () => {},
  },
  Fracao: { findOne: async () => null, findAll: async () => [] },
  PagamentoExtraParcela: { findAll: async () => [] },
  ExtraQuotaParcela: { findAll: async () => [] },
  ExtraQuota: { findAll: async () => [] },
  Despesa: { findAll: async () => [] },
  Fornecedor: { findAll: async () => [] },
  FornecedorSaldo: { findAll: async () => [] },
  PagamentoFornecedor: { findAll: async () => [] },
  PlanoQuota: { findAll: async () => [] },
  Orcamento: { findAll: async () => [] },
  OrcamentoRubrica: { findAll: async () => [] },
  MetodoPagamento: { findAll: async () => [] },
};

// ── Transação com rollback real (para provar atomicidade) ──────────
let falharNoDestino = false;
let registoEscritas = [];
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

// O helper real de movimentos é substituído por um duplo controlado: o que está
// em teste é o encadeamento do FCR (a criação dos dois movimentos é exercida
// pelo teste próprio dos movimentos). `saldoContaMovimentos` fica REAL — lê os
// movimentos pelos modelos em memória, como em produção.
const movimentosPath = require.resolve(path.join(RAIZ, 'helpers', 'movimentos'));
require.cache[movimentosPath] = {
  id: movimentosPath, filename: movimentosPath, loaded: true, children: [], paths: [],
  exports: {
    registarTransferencia: async ({ contaOrigemId, contaDestinoId, valor, data, descricao, transaction }) => {
      if (!transaction) throw new Error('a transferência do FCR tem de correr numa transação');
      if (falharNoDestino) throw new Error('falha simulada ao gravar o segundo movimento');
      const base = { data: data || '2026-03-10', valor, descricao: descricao || 'Transferência entre contas', referencia: 'TRANSF', estado: 'confirmado' };
      const saida = await modelos.MovimentoBancario.create({ ...base, conta_bancaria_id: contaOrigemId, tipo: 'saida' });
      const entrada = await modelos.MovimentoBancario.create({ ...base, conta_bancaria_id: contaDestinoId, tipo: 'entrada' });
      registoEscritas.push(saida.id, entrada.id);
      return { saidaId: saida.id, entradaId: entrada.id };
    },
    saldoContaMovimentos: async (conta) => {
      const movimentos = await modelos.MovimentoBancario.findAll({
        where: { conta_bancaria_id: conta.id, estado: 'confirmado' },
      });
      const entradasC = movimentos.filter((m) => m.tipo === 'entrada').reduce((s, m) => s + toCents(m.valor), 0);
      const saidasC = movimentos.filter((m) => m.tipo === 'saida').reduce((s, m) => s + toCents(m.valor), 0);
      return (toCents(conta.saldo_inicial) + entradasC - saidasC) / 100;
    },
    criarMovimento: async (d) => modelos.MovimentoBancario.create({
      conta_bancaria_id: d.contaBancariaId, data: d.data || '2026-03-10', tipo: d.tipo, valor: d.valor,
      descricao: d.descricao || null, referencia: d.referencia || null, pagamento_id: d.pagamentoId || null, estado: 'confirmado',
    }),
    sincronizarMovimentoDespesa: async () => {},
  },
};

const fcr = require(path.join(RAIZ, 'helpers', 'fcr'));
const pagamentosHelper = require(path.join(RAIZ, 'helpers', 'pagamentos'));

// Saldo de uma conta pelas regras do sistema (saldo inicial + entradas − saídas
// confirmadas) — a mesma fórmula de helpers/movimentos.saldoContaMovimentos.
function saldoC(contaId) {
  const conta = db.contas.find((c) => Number(c.id) === Number(contaId));
  const mov = db.movimentos.filter((m) => Number(m.conta_bancaria_id) === Number(contaId) && m.estado === 'confirmado');
  const entradas = mov.filter((m) => m.tipo === 'entrada').reduce((s, m) => s + toCents(m.valor), 0);
  const saidas = mov.filter((m) => m.tipo === 'saida').reduce((s, m) => s + toCents(m.valor), 0);
  return toCents(conta.saldo_inicial) + entradas - saidas;
}

// Cria diretamente um pagamento confirmado com as aplicações indicadas (evita
// depender da ordem de alocação FIFO para montar cenários de FCR).
function seedPagamento({ id, condominioId = 1, fracaoId = 1, data = '2026-01-20', aplicacoes = [], contaBancariaId = 10 }) {
  const totalC = aplicacoes.reduce((s, a) => s + toCents(a.valor), 0);
  db.pagamentos.push({ id, condominio_id: condominioId, fracao_id: fracaoId, valor: totalC / 100, data_pagamento: data, estado: 'confirmado' });
  if (contaBancariaId) {
    db.movimentos.push({
      id: ++db.proximoId.movimento, conta_bancaria_id: contaBancariaId, data, tipo: 'entrada',
      valor: totalC / 100, descricao: `Pagamento ${id}`, referencia: null, pagamento_id: id, estado: 'confirmado',
    });
  }
  for (const a of aplicacoes) {
    db.pagamentoQuotas.push({
      id: ++db.proximoId.numeracao, pagamento_id: id, quota_id: Number(a.quota), valor_aplicado: toCents(a.valor) / 100,
    });
  }
  return { pagamento: db.pagamentos[db.pagamentos.length - 1] };
}

// ── Cenário base ───────────────────────────────────────────────────
// Condomínio 1: conta corrente (id 10) + conta FCR (id 11). Condomínio 2 tem as
// suas próprias contas (id 20/21) para provar o isolamento.
// Quotas de 2026, cada uma com 10% de FCR: valor 55,00 € (50,00 base + 5,00 FCR).
function reiniciar() {
  db.contas = [
    { id: 10, condominio_id: 1, nome: 'Conta corrente', tipo: 'corrente', saldo_inicial: '1000.00', ativa: true },
    { id: 11, condominio_id: 1, nome: 'Fundo de Reserva', tipo: 'fundo_reserva', saldo_inicial: '200.00', ativa: true },
    { id: 12, condominio_id: 1, nome: 'Poupança', tipo: 'poupanca', saldo_inicial: '0.00', ativa: true },
    { id: 20, condominio_id: 2, nome: 'Corrente (vizinho)', tipo: 'corrente', saldo_inicial: '500.00', ativa: true },
    { id: 21, condominio_id: 2, nome: 'FCR (vizinho)', tipo: 'fundo_reserva', saldo_inicial: '50.00', ativa: true },
  ];
  db.quotas = [
    { id: 100, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 1, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'pendente' },
    { id: 101, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 2, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'pendente' },
    { id: 102, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 3, valor: '30.00', valor_base: '30.00', valor_fcr: '0.00', estado: 'pendente' },
    { id: 103, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 4, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'pendente' },
    { id: 200, condominio_id: 2, fracao_id: 9, ano: 2026, mes: 1, valor: '55.00', valor_base: '50.00', valor_fcr: '5.00', estado: 'pendente' },
  ];
  db.pagamentos = [];
  db.pagamentoQuotas = [];
  db.movimentos = [];
  db.proximoId = { conta: 0, quota: 0, pagamento: 0, movimento: 0, numeracao: 0 };
  consultas.length = 0;
  falharNoDestino = false;
  registoEscritas = [];
}

async function main() {
  // ── 1. Regra pura: parcela de FCR de uma aplicação ───────────────
  assert.strictEqual(fcr.fcrDaAplicacaoC({ valorAplicadoC: 5500, valorQuotaC: 5500, fcrQuotaC: 500 }), 500, 'quota paga por inteiro: FCR integral');
  assert.strictEqual(fcr.fcrDaAplicacaoC({ valorAplicadoC: 2750, valorQuotaC: 5500, fcrQuotaC: 500 }), 250, 'meia quota: metade do FCR');
  assert.strictEqual(fcr.fcrDaAplicacaoC({ valorAplicadoC: 1000, valorQuotaC: 5500, fcrQuotaC: 500 }), 91, 'pagamento parcial: FCR proporcional (500×1000/5500)');
  assert.strictEqual(fcr.fcrDaAplicacaoC({ valorAplicadoC: 5500, valorQuotaC: 3000, fcrQuotaC: 0 }), 0, 'quota sem FCR: nada a receber');
  assert.strictEqual(fcr.fcrDaAplicacaoC({ valorAplicadoC: 0, valorQuotaC: 5500, fcrQuotaC: 500 }), 0, 'nada pago: nada recebido');
  assert.strictEqual(fcr.fcrDaAplicacaoC({ valorAplicadoC: 5500, valorQuotaC: 5500, fcrQuotaC: 7000 }), 5500, 'FCR nunca excede o valor efetivamente pago');
  assert.strictEqual(fcr.fcrDaAplicacaoC({ valorAplicadoC: 9999, valorQuotaC: 0, fcrQuotaC: 500 }), 0, 'quota sem valor guardado não gera FCR');

  // ── 2. Pagamento de quota com FCR → entrada TOTAL na conta corrente ──
  reiniciar();
  const p1 = await pagamentosHelper.registarPagamento({
    fracaoId: 1, valor: 55, dataPagamento: '2026-01-20', contaBancariaId: 10, userId: 7, condominioId: 1,
  });
  const movimentosPagamento = db.movimentos.filter((m) => m.pagamento_id === p1.pagamento.id);
  assert.strictEqual(movimentosPagamento.length, 1, 'um pagamento gera UM movimento bancário (sem entrada fictícia de FCR)');
  assert.strictEqual(movimentosPagamento[0].tipo, 'entrada', 'o movimento do pagamento é uma entrada');
  assert.strictEqual(movimentosPagamento[0].conta_bancaria_id, 10, 'a entrada é na conta corrente');
  assert.strictEqual(toCents(movimentosPagamento[0].valor), 5500, 'a entrada é pelo valor TOTAL recebido (55,00 €)');
  assert.strictEqual(toCents(p1.pagamento.valor), 5500, 'o pagamento fica com o valor total');
  const alocacao = db.pagamentoQuotas[0];
  assert.strictEqual(toCents(alocacao.valor_aplicado), 5500, 'a aplicação cobre a quota por inteiro');
  assert.strictEqual(db.quotas.find((q) => q.id === 100).estado, 'paga', 'a quota fica paga');

  // ── 3. Parcela de FCR efetivamente recebida ──────────────────────
  const recebido1 = await fcr.fcrRecebidoC(1);
  assert.strictEqual(recebido1.totalC, 500, 'FCR recebido = 5,00 € (10% de 50,00 € de quota corrente)');
  assert.strictEqual(recebido1.porQuotaC.get(100), 500, 'FCR recebido registado por quota');
  assert.ok(!recebido1.porQuotaC.has(101), 'a quota ainda não paga não conta como recebido');
  assert.ok(!recebido1.porQuotaC.has(200), 'a quota do outro condomínio nunca entra');

  // FCR emitido (informativo) ≠ recebido: as quotas do condomínio 1 somam 15,00 €
  // (5,00 + 5,00 + 0,00 + 5,00), dos quais só 5,00 € estão recebidos.
  const emitido1 = await fcr.fcrEmitidoC(1);
  assert.strictEqual(emitido1, toCents(15), 'FCR emitido = 15,00 €');
  assert.ok(emitido1 > recebido1.totalC, 'FCR emitido é maior do que o recebido (nem todas as quotas foram pagas)');
  const resumo1 = await fcr.resumoFcr(1);
  assert.strictEqual(resumo1.disponivelC, 500, 'disponível = recebido − transferido (nada transferido ainda)');
  assert.strictEqual(resumo1.transferidoC, 0, 'nada transferido no início');

  // ── 4. Vários pagamentos parciais: o FCR nunca conta duas vezes ───
  // As aplicações são semeadas diretamente (o que está em teste é o cálculo do
  // FCR, não a ordenação FIFO dos pagamentos, que tem teste próprio).
  reiniciar();
  seedPagamento({ id: 1, data: '2026-01-10', aplicacoes: [{ quota: 100, valor: 20 }] });
  seedPagamento({ id: 2, data: '2026-01-25', aplicacoes: [{ quota: 100, valor: 20 }] });
  seedPagamento({ id: 3, data: '2026-02-05', aplicacoes: [{ quota: 100, valor: 15 }] });
  const recebidoParcial = await fcr.fcrRecebidoC(1);
  // Três pagamentos parciais que, juntos, pagam a quota 100 → FCR 5,00 € (nem 1
  // cêntimo a mais), distribuído pelas três aplicações.
  assert.strictEqual(recebidoParcial.porQuotaC.get(100), 500, 'parciais: a quota 100 contribui com o seu FCR integral, uma só vez');
  assert.strictEqual(recebidoParcial.totalC, 500, 'parciais: total recebido = 5,00 €');
  assert.strictEqual(recebidoParcial.detalhe.length, 3, 'as três aplicações parciais são consideradas');
  assert.strictEqual(recebidoParcial.detalhe.reduce((s, d) => s + d.fcrC, 0), 500, 'a soma das parcelas de FCR é exatamente o FCR da quota');

  // Parcela de FCR de uma quota parcialmente paga (1500 de 5500 cêntimos).
  seedPagamento({ id: 4, data: '2026-02-10', aplicacoes: [{ quota: 101, valor: 15 }] });
  const recebidoQuota101 = await fcr.fcrRecebidoC(1);
  assert.strictEqual(recebidoQuota101.porQuotaC.get(101), 136, 'quota parcialmente paga: contribui só com o FCR da parte paga (500×1500/5500)');
  assert.strictEqual(recebidoQuota101.totalC, 636, 'total recebido = 5,00 € + 1,36 €');
  assert.strictEqual(recebidoQuota101.totalC, 500 + 136, 'o FCR recebido é a soma das parcelas, sem duplicações');

  // Pagamento a mais (aplicado em duas quotas dentro do mesmo pagamento).
  seedPagamento({ id: 5, data: '2026-02-20', aplicacoes: [{ quota: 101, valor: 40 }, { quota: 103, valor: 10 }] });
  const recebidoMisto = await fcr.fcrRecebidoC(1);
  const aplicado101 = db.pagamentoQuotas.filter((a) => a.quota_id === 101).reduce((s, a) => s + toCents(a.valor_aplicado), 0);
  const esperado101 = Math.min(500, Math.round((500 * aplicado101) / 5500));
  assert.strictEqual(recebidoMisto.porQuotaC.get(101), esperado101, 'a quota 101 recebe o FCR proporcional ao que está pago (' + aplicado101 + ' cêntimos)');
  assert.ok(recebidoMisto.porQuotaC.get(101) <= 500, 'a quota 101 nunca ultrapassa o seu próprio FCR');
  assert.strictEqual(recebidoMisto.porQuotaC.get(103), 91, 'a quota 103 (10,00 € de 55,00 €) contribui com 0,91 € de FCR');
  assert.ok(recebidoMisto.totalC <= toCents(15), 'o FCR recebido nunca excede o FCR emitido (15,00 €)');
  // Repetir a leitura não altera nada (cálculo idempotente).
  const recebidoMisto2 = await fcr.fcrRecebidoC(1);
  assert.strictEqual(recebidoMisto2.totalC, recebidoMisto.totalC, 'ler o FCR recebido duas vezes não duplica o valor');

  // ── 5. Transferência corrente → FCR: dois movimentos, mesmo valor ──
  reiniciar();
  await pagamentosHelper.registarPagamento({ fracaoId: 1, valor: 55, dataPagamento: '2026-01-20', contaBancariaId: 10, userId: 7, condominioId: 1 });
  await pagamentosHelper.registarPagamento({ fracaoId: 1, valor: 55, dataPagamento: '2026-02-20', contaBancariaId: 10, userId: 7, condominioId: 1 });
  const antesMov = db.movimentos.length;
  const t1 = await fcr.transferirFcr({
    condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 1000, data: '2026-03-10', userId: 7,
  });
  assert.strictEqual(t1.ok, true, 'transferência de 10,00 € aceite (FCR disponível 10,00 €)');
  assert.strictEqual(t1.valorC, 1000, 'valor transferido em cêntimos');
  const novos = db.movimentos.slice(antesMov);
  assert.strictEqual(novos.length, 2, 'a transferência cria exatamente dois movimentos');
  const saida = novos.find((m) => m.tipo === 'saida');
  const entrada = novos.find((m) => m.tipo === 'entrada');
  assert.ok(saida && entrada, 'um movimento de saída (origem) e um de entrada (destino)');
  assert.strictEqual(saida.conta_bancaria_id, 10, 'a saída é na conta de origem');
  assert.strictEqual(entrada.conta_bancaria_id, 11, 'a entrada é na conta do Fundo de Reserva');
  assert.strictEqual(toCents(saida.valor), toCents(entrada.valor), 'os dois movimentos têm o mesmo valor');
  assert.strictEqual(toCents(saida.valor), 1000, 'o valor é o pedido (10,00 €)');
  assert.strictEqual(saida.referencia, 'TRANSF', 'o movimento está identificado como transferência');
  assert.strictEqual(entrada.referencia, 'TRANSF', 'a entrada também está identificada como transferência');

  // ── 6. FCR transferido e disponível depois da transferência ──────
  const resumo2 = await fcr.resumoFcr(1, { incluirDetalhe: true });
  assert.strictEqual(resumo2.recebidoC, 1000, 'recebido continua a ser o FCR efetivamente recebido (10,00 €)');
  assert.strictEqual(resumo2.transferidoC, 1000, 'transferido = 10,00 € (contado UMA vez, pela entrada no FCR)');
  assert.strictEqual(resumo2.nTransferencias, 1, 'uma transferência registada');
  assert.strictEqual(resumo2.disponivelC, 0, 'disponível fica a zero');
  assert.strictEqual(resumo2.transferencias[0].origem, 'Conta corrente', 'a transferência identifica a conta de origem');
  assert.strictEqual(resumo2.transferencias[0].destino, 'Fundo de Reserva', 'a transferência identifica a conta de destino');

  // ── 7. Transferências anteriores não voltam a contar o mesmo FCR ──
  const t2 = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 100, data: '2026-03-11', userId: 7 });
  assert.strictEqual(t2.ok, false, 'sem FCR disponível, nova transferência é recusada');
  assert.strictEqual(t2.motivo, 'acima_do_disponivel', 'motivo: acima do disponível');
  assert.strictEqual(db.movimentos.length, antesMov + 2, 'nenhum movimento extra foi criado');

  // Um novo pagamento de uma quota com FCR volta a libertar FCR — mas só o FCR
  // dessa quota.
  seedPagamento({ id: 900, data: '2026-03-20', aplicacoes: [{ quota: 103, valor: 55 }] });
  const resumo3 = await fcr.resumoFcr(1);
  assert.strictEqual(resumo3.recebidoC, 1500, 'novo pagamento de 55,00 € → +5,00 € de FCR recebido (total 15,00 €)');
  assert.strictEqual(resumo3.transferidoC, 1000, 'o FCR já transferido mantém-se contabilizado');
  assert.strictEqual(resumo3.disponivelC, 500, 'disponível = 15,00 − 10,00 = 5,00 €');
  const t3 = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 600, data: '2026-03-21', userId: 7 });
  assert.strictEqual(t3.ok, false, 'pedido de 6,00 € acima dos 5,00 € disponíveis é recusado');
  const t4 = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 500, data: '2026-03-21', userId: 7 });
  assert.strictEqual(t4.ok, true, 'pedido de 5,00 € (disponível exato) é aceite');
  assert.strictEqual(t4.disponivelC, 0, 'disponível volta a zero');
  assert.strictEqual(db.movimentos.filter((m) => m.referencia === 'TRANSF').length, 4, 'duas transferências = quatro movimentos');

  // ── 8. Saldos das duas contas ficam corretos ─────────────────────
  reiniciar();
  await pagamentosHelper.registarPagamento({ fracaoId: 1, valor: 55, dataPagamento: '2026-01-20', contaBancariaId: 10, userId: 7, condominioId: 1 });
  const saldoCorrenteAntes = saldoC(10);
  const saldoFundoAntes = saldoC(11);
  assert.strictEqual(saldoCorrenteAntes, 100000 + 5500, 'conta corrente: saldo inicial + pagamento recebido');
  assert.strictEqual(saldoFundoAntes, 20000, 'conta FCR: só o saldo inicial (nada transferido ainda)');
  const r8 = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 500, data: '2026-03-10', userId: 7 });
  assert.strictEqual(r8.ok, true, 'transferência de 5,00 € aceite');
  const saldoCorrenteDepois = saldoC(10);
  const saldoFundoDepois = saldoC(11);
  assert.strictEqual(saldoCorrenteDepois, saldoCorrenteAntes - 500, 'a conta de origem é debitada pelo valor transferido');
  assert.strictEqual(saldoFundoDepois, saldoFundoAntes + 500, 'a conta FCR é creditada pelo mesmo valor');
  assert.strictEqual(saldoCorrenteDepois + saldoFundoDepois, saldoCorrenteAntes + saldoFundoAntes, 'a transferência não cria nem destrói dinheiro');

  // ── 9. Transferência não é receita nem despesa ───────────────────
  // A regra de classificação usada pelo relatório financeiro: só entradas sem
  // referencia 'TRANSF' são receita; só saídas sem 'TRANSF' são despesa.
  const ehTransferencia = (m) => String(m.referencia || '') === 'TRANSF';
  const receitasC = db.movimentos
    .filter((m) => m.tipo === 'entrada' && m.estado === 'confirmado' && !ehTransferencia(m))
    .reduce((s, m) => s + toCents(m.valor), 0);
  const despesasC = db.movimentos
    .filter((m) => m.tipo === 'saida' && m.estado === 'confirmado' && !ehTransferencia(m))
    .reduce((s, m) => s + toCents(m.valor), 0);
  assert.strictEqual(receitasC, 5500, 'receitas = apenas o pagamento da quota (5,00 € do FCR incluídos no valor recebido)');
  assert.strictEqual(despesasC, 0, 'a transferência não é despesa');
  const relatorio = fs.readFileSync(path.join(RAIZ, 'helpers', 'relatorio-financeiro.js'), 'utf8');
  assert.ok(/REF_TRANSFERENCIA/.test(relatorio), 'o relatório identifica as transferências pela referencia TRANSF');
  assert.ok(/não contam como receita nem como despesa/.test(relatorio), 'o relatório documenta que as transferências não são receita/despesa');

  // ── 10. Validações da transferência ──────────────────────────────
  reiniciar();
  await pagamentosHelper.registarPagamento({ fracaoId: 1, valor: 55, dataPagamento: '2026-01-20', contaBancariaId: 10, userId: 7, condominioId: 1 });

  const destinoNaoFcr = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 12, valorC: 500, data: '2026-03-10', userId: 7 });
  assert.strictEqual(destinoNaoFcr.ok, false, 'destino que não é conta FCR é recusado');
  assert.strictEqual(destinoNaoFcr.motivo, 'destino_nao_fcr', 'motivo: destino não é FCR');

  const iguais = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 11, contaDestinoId: 11, valorC: 500, data: '2026-03-10', userId: 7 });
  assert.strictEqual(iguais.ok, false, 'origem = destino é recusada');
  assert.strictEqual(iguais.motivo, 'contas_iguais', 'motivo: contas iguais');

  const zero = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 0, data: '2026-03-10', userId: 7 });
  assert.strictEqual(zero.ok, false, 'valor zero é recusado');
  assert.strictEqual(zero.motivo, 'valor_invalido', 'motivo: valor inválido');
  const negativo = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: -500, data: '2026-03-10', userId: 7 });
  assert.strictEqual(negativo.ok, false, 'valor negativo é recusado');

  const acima = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 501, data: '2026-03-10', userId: 7 });
  assert.strictEqual(acima.ok, false, '1 cêntimo acima do disponível já é recusado');
  assert.strictEqual(acima.motivo, 'acima_do_disponivel', 'motivo: acima do disponível');

  const contaFora = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 20, contaDestinoId: 11, valorC: 500, data: '2026-03-10', userId: 7 });
  assert.strictEqual(contaFora.ok, false, 'conta de origem de outro condomínio é recusada');
  assert.strictEqual(contaFora.motivo, 'conta_invalida', 'motivo: conta inválida');
  const destinoFora = await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 21, valorC: 500, data: '2026-03-10', userId: 7 });
  assert.strictEqual(destinoFora.ok, false, 'conta FCR de outro condomínio é recusada');

  // Valor dentro do FCR disponível (5,00 €) mas acima do saldo da conta de
  // origem: o dinheiro recebido ficou noutra conta, pelo que esta conta não pode
  // suportar a transferência.
  db.movimentos = [];
  const conta10 = db.contas.find((c) => c.id === 10);
  const inicialOriginal = conta10.saldo_inicial;
  conta10.saldo_inicial = '1.00';
  const saldoInsuficiente = await fcr.transferirFcr({
    condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 500, data: '2026-03-10', userId: 7,
  });
  assert.strictEqual(saldoInsuficiente.ok, false, 'valor acima do saldo da conta de origem é recusado');
  assert.strictEqual(saldoInsuficiente.motivo, 'saldo_origem_insuficiente', 'motivo: saldo da origem insuficiente');
  conta10.saldo_inicial = inicialOriginal;
  assert.strictEqual(db.movimentos.filter((m) => m.referencia === 'TRANSF').length, 0, 'nenhum movimento de transferência foi criado em nenhuma tentativa recusada');

  // ── 11. Atomicidade: falha a meio → nenhum movimento parcial ─────
  reiniciar();
  await pagamentosHelper.registarPagamento({ fracaoId: 1, valor: 55, dataPagamento: '2026-01-20', contaBancariaId: 10, userId: 7, condominioId: 1 });
  const antesFalha = db.movimentos.length;
  falharNoDestino = true;
  let erro = null;
  try {
    await fcr.transferirFcr({ condominioId: 1, contaOrigemId: 10, contaDestinoId: 11, valorC: 500, data: '2026-03-10', userId: 7 });
  } catch (e) {
    erro = e;
  }
  falharNoDestino = false;
  assert.ok(erro, 'a falha ao criar os dois movimentos propaga o erro (a transação faz rollback)');
  assert.strictEqual(registoEscritas.length, 0, 'nenhum par de movimentos ficou registado');
  const resumoAposFalha = await fcr.resumoFcr(1);
  assert.strictEqual(resumoAposFalha.disponivelC, 500, 'o FCR disponível não ficou "consumido" por uma transferência falhada');
  assert.strictEqual(resumoAposFalha.transferidoC, 0, 'nada consta como transferido depois da falha');
  assert.strictEqual(db.movimentos.length, antesFalha, 'a base de dados ficou como estava antes da tentativa');

  // ── 12. Isolamento multi-condomínio ──────────────────────────────
  reiniciar();
  db.pagamentos.push({ id: 900, condominio_id: 2, fracao_id: 9, valor: '55.00', data_pagamento: '2026-01-20', estado: 'confirmado' });
  db.pagamentoQuotas.push({ id: 901, pagamento_id: 900, quota_id: 200, valor_aplicado: '55.00' });
  db.movimentos.push({ id: 950, conta_bancaria_id: 21, data: '2026-01-21', tipo: 'entrada', valor: '5.00', referencia: 'TRANSF', estado: 'confirmado' });
  db.movimentos.push({ id: 951, conta_bancaria_id: 20, data: '2026-01-21', tipo: 'saida', valor: '5.00', referencia: 'TRANSF', estado: 'confirmado' });
  const recebidoC1 = await fcr.fcrRecebidoC(1);
  assert.strictEqual(recebidoC1.totalC, 0, 'o FCR recebido do condomínio 1 não inclui pagamentos do condomínio 2');
  const recebidoC2 = await fcr.fcrRecebidoC(2);
  assert.strictEqual(recebidoC2.totalC, 500, 'o condomínio 2 vê o seu próprio FCR recebido');
  const resumoC1 = await fcr.resumoFcr(1);
  assert.strictEqual(resumoC1.transferidoC, 0, 'as transferências do condomínio 2 não contam para o condomínio 1');
  const resumoC2 = await fcr.resumoFcr(2);
  assert.strictEqual(resumoC2.transferidoC, 500, 'o condomínio 2 vê a sua transferência (5,00 €, contada uma só vez)');
  assert.deepStrictEqual(resumoC2.contasFcrIds, [21], 'só a conta FCR do próprio condomínio é considerada');

  // Consultas: nenhuma leitura fica sem o condomínio — diretamente no `where`
  // (quotas, contas, pagamentos) ou por associação obrigatória (os movimentos
  // bancários não têm condominio_id: são filtrados pela conta do condomínio,
  // como no resto do projeto).
  assert.ok(consultas.length > 0, 'o cenário fez consultas');
  for (const c of consultas) {
    const where = c.where || {};
    const porAssociacao = (c.include || []).some((i) => i && i.required && i.where && i.where.condominio_id !== undefined);
    assert.ok(
      where.condominio_id !== undefined || porAssociacao,
      `${c.nome} tem de filtrar pelo condomínio (where: ${JSON.stringify(where)})`
    );
  }
  const todas = consultas.map((c) => ({ nome: c.nome, where: c.where, incl: c.include }));
  assert.ok(todas.some((c) => c.nome === 'MovimentoBancario.findAll' && (c.incl || []).some((i) => i && i.where && i.where.condominio_id !== undefined)), 'os movimentos são filtrados pela conta do condomínio');
  assert.ok(todas.some((c) => c.nome === 'Quota.sum' && String(c.where.condominio_id) === '1'), 'o FCR emitido é somado por condomínio');
  assert.ok(todas.some((c) => c.nome === 'ContaBancaria.findAll' && String(c.where.condominio_id) === '1'), 'as contas são lidas por condomínio');

  // ── 13. Registo histórico (transferências antigas) ───────────────
  // Uma transferência antiga gravada como par saída/entrada com referencia
  // TRANSF conta UMA vez (o FCR não é transferido duas vezes por ter dois
  // movimentos), e continua a ser visível como transferência.
  reiniciar();
  await pagamentosHelper.registarPagamento({ fracaoId: 1, valor: 55, dataPagamento: '2026-01-20', contaBancariaId: 10, userId: 7, condominioId: 1 });
  db.movimentos.push({ id: 5001, conta_bancaria_id: 10, data: '2026-02-01', tipo: 'saida', valor: '5.00', descricao: 'Transferência entre contas', referencia: 'TRANSF', estado: 'confirmado' });
  db.movimentos.push({ id: 5002, conta_bancaria_id: 11, data: '2026-02-01', tipo: 'entrada', valor: '5.00', descricao: 'Transferência entre contas', referencia: 'TRANSF', estado: 'confirmado' });
  const antigas = await fcr.resumoFcr(1, { incluirDetalhe: true });
  assert.strictEqual(antigas.transferidoC, 500, 'transferência antiga (par saída/entrada) conta 5,00 € — não 10,00 €');
  assert.strictEqual(antigas.nTransferencias, 1, 'uma transferência antiga = uma transferência');
  assert.strictEqual(antigas.transferencias[0].origem, 'Conta corrente', 'a transferência antiga fica atribuída à conta de origem');
  assert.strictEqual(antigas.disponivelC, 0, 'depois de transferido o FCR antigo já não está disponível');
  // Movimento anulado (transferência revertida) nunca conta.
  db.movimentos.push({ id: 5003, conta_bancaria_id: 11, data: '2026-02-02', tipo: 'entrada', valor: '5.00', referencia: 'TRANSF', estado: 'anulado' });
  const comAnulado = await fcr.fcrTransferidoC(1);
  assert.strictEqual(comAnulado.totalC, 500, 'movimentos anulados não contam como transferido');

  // ── 14. Interface administrativa e ligação às contas ─────────────
  const rotas = fs.readFileSync(path.join(RAIZ, 'routes', 'financeiro.js'), 'utf8');
  const vista = fs.readFileSync(path.join(RAIZ, 'views', 'admin', 'contas', 'transferir-fcr.handlebars'), 'utf8');
  const vistaContas = fs.readFileSync(path.join(RAIZ, 'views', 'admin', 'contas', 'listar.handlebars'), 'utf8');
  assert.ok(/router\.get\('\/contas\/transferir-fcr'/.test(rotas), 'rota da página de transferência do FCR');
  assert.ok(/router\.post\('\/contas\/transferir-fcr'/.test(rotas), 'rota POST da transferência do FCR');
  assert.ok(/transferirFcr\(\{[\s\S]{0,240}condominioId: req\.condominioId/.test(rotas), 'a rota passa o condomínio ativo à operação');
  assert.ok(/resumoFcr\(req\.condominioId/.test(rotas), 'a página mostra o resumo do FCR do condomínio ativo');
  assert.ok(/name="conta_origem_id"/.test(vista) && /name="conta_destino_id"/.test(vista), 'a vista permite escolher as duas contas');
  assert.ok(/name="valor"/.test(vista), 'a vista permite indicar o valor');
  assert.ok(/não é uma despesa/.test(vista), 'a vista afirma que a operação não é uma despesa');
  assert.ok(/FCR emitido/.test(vista) && /FCR recebido/.test(vista) && /FCR transferido/.test(vista) && /Disponível para transferir/.test(vista), 'a vista separa emitido/recebido/transferido/disponível');
  assert.ok(/transferir-fcr/.test(vistaContas), 'a lista de contas tem entrada para a transferência do FCR');

  console.log('✓ Testes do ciclo do FCR (receção e transferência) passaram, sem base de dados.');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  console.error(e.stack);
  process.exit(1);
});
