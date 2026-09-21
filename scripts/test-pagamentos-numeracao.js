// ═══════════════════════════════════════════════════════════════════
// Numeração do documento de PAGAMENTO — teste de regressão.
//
// Bug de produção (2026-09): quatro pagamentos DIFERENTES (fração 4 · 1.093,65 € ·
// 2026-09-15; fração 1 · 28,70 € · 2026-09-15; fração 1 · 200 € · 2026-09-08;
// fração 1 · 200 € · 2026-09-21) falhavam todos com o MESMO número:
//   SequelizeUniqueConstraintError: numero_documento must be unique
//   MySQL: Duplicate entry '2026/0004' for key 'numero_documento'
//
// Duas causas, ambas reproduzidas aqui:
//  1. a série `numeracoes`('recibo', 2026) — a série dos PAGAMENTOS — ficou
//     ATRASADA em relação aos números já gravados em `pagamentos`
//     (`scripts/seed-demo.js` alinhava `recibo` com o nº de recibos do demo,
//     movendo a sequência para trás);
//  2. `proximoNumero` incrementava a sequência DENTRO da transação do pagamento,
//     pelo que o `rollback` da gravação falhada desfazia o incremento: a série
//     ficava presa em 3 e TODAS as tentativas seguintes recalculavam `2026/0004`
//     — o erro era permanente, não transitório.
//
// O que se prova: com a verificação de número livre (`jaUsado`), os quatro
// pagamentos são registados com números distintos, a série recupera sozinha e
// o número de um documento existente nunca é reatribuído — incluindo o de outro
// condomínio (a série é global) e sem TOCTOU entre registos concorrentes (a
// verificação corre na mesma transação, sob o `FOR UPDATE` de `numeracoes`).
//
// Utilização: node scripts/test-pagamentos-numeracao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents, fromCents } = require('../helpers/money');

// ── Estado em memória (faz de MySQL) ────────────────────────────────
let seq = { numeracao: 0, pagamento: 0, quota: 0, aplicacao: 0, extraParcela: 0 };
let db = {};

// Registo das consultas de `Pagamento.findOne` (só as que procuram um número de
// documento): serve para provar que a verificação de número livre corre DENTRO
// da transação do pagamento — é isso que impede dois pedidos concorrentes de
// ficarem com o mesmo número.
let registoFindOne = [];

// Contadores de id: arrancam no maior id já presente no estado (como faria o
// AUTO_INCREMENT depois de uma importação), senão os registos novos colidiriam
// com os ids do cenário e as asserções passariam a medir a linha errada.
const maiorId = (linhas) => (linhas || []).reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);

function reiniciar(estado) {
  db = {
    numeracoes: [],
    pagamentos: [],
    quotas: [],
    pagamentoQuotas: [],
    fracas: [],
    extraParcelas: [],
    extraPagamentoParcelas: [],
    movimentos: [],
    ...estado,
  };
  seq = {
    numeracao: maiorId(db.numeracoes),
    pagamento: maiorId(db.pagamentos),
    quota: maiorId(db.quotas),
    aplicacao: maiorId(db.pagamentoQuotas),
    extraParcela: maiorId(db.extraParcelas),
  };
  registoFindOne = [];
}

function restaurar(snapshot) {
  for (const chave of Object.keys(db)) db[chave] = snapshot[chave];
  for (const chave of Object.keys(snapshot)) if (!(chave in db)) db[chave] = snapshot[chave];
}

// Comparador mínimo de `where` (igualdade + Op.in/Op.ne/Op.lte/Op.lt/Op.gte).
function casa(valor, esperado) {
  if (esperado && typeof esperado === 'object' && !Array.isArray(esperado)) {
    if (Op.in in esperado || esperado[Op.in]) return (esperado[Op.in] || esperado.in || []).map(Number).includes(Number(valor));
    if (esperado[Op.ne] !== undefined || esperado.ne !== undefined) return Number(valor) !== Number(esperado[Op.ne] ?? esperado.ne);
    if (esperado[Op.lte] !== undefined || esperado.lte !== undefined) return Number(valor) <= Number(esperado[Op.lte] ?? esperado.lte);
    if (esperado[Op.lt] !== undefined || esperado.lt !== undefined) return Number(valor) < Number(esperado[Op.lt] ?? esperado.lt);
    if (esperado[Op.gte] !== undefined || esperado.gte !== undefined) return Number(valor) >= Number(esperado[Op.gte] ?? esperado.gte);
    return false;
  }
  return String(valor) === String(esperado);
}

const onde = (linhas, filtro) =>
  (linhas || []).filter((l) =>
    Object.entries(filtro || {}).every(([k, v]) => {
      if (k === 'estado' && v && typeof v === 'object' && (Op.ne in v || v[Op.ne] !== undefined)) {
        return String(l[k]) !== String(v[Op.ne] ?? v.ne);
      }
      return casa(l[k], v);
    })
  );

const comMetodos = (obj) =>
  obj && Object.assign(Object.create({ update: async (v) => Object.assign(obj, v) }), obj);

// ── Transação com rollback REAL sobre o estado em memória ───────────
// É isto que reproduz o bug: o incremento da sequência vive na mesma transação
// do documento, pelo que um rollback o desfaz.
let transacoesAbertas = 0;
const novaTransacao = () => {
  const snapshot = JSON.parse(JSON.stringify(db));
  transacoesAbertas += 1;
  return {
    LOCK: { UPDATE: 'update' },
    commit: async () => {
      transacoesAbertas -= 1;
    },
    rollback: async () => {
      restaurar(snapshot);
      transacoesAbertas -= 1;
    },
  };
};

// ── Dublês dos modelos ──────────────────────────────────────────────
const modelos = {
  Numeracao: {
    findOne: async ({ where } = {}) => comMetodos(onde(db.numeracoes, where)[0]) || null,
    create: async (dados) => {
      const n = { id: (seq.numeracao += 1), sequencia: 0, formato: '{ano}/{sequencia}', ...dados };
      db.numeracoes.push(n);
      return comMetodos(n);
    },
    update: async (dados, { where } = {}) => {
      const alvos = onde(db.numeracoes, where);
      alvos.forEach((n) => Object.assign(n, dados));
      return [alvos.length];
    },
  },
  Pagamento: {
    // A UNIQUE real: `numero_documento` duplicado → ER_DUP_ENTRY.
    create: async (dados) => {
      const numero = dados.numero_documento;
      if (numero && db.pagamentos.some((p) => p.numero_documento === numero)) {
        const e = new Error('numero_documento must be unique');
        e.name = 'SequelizeUniqueConstraintError';
        e.errors = [{ message: 'numero_documento must be unique', path: 'numero_documento' }];
        e.parent = { code: 'ER_DUP_ENTRY', errno: 1062, sqlMessage: `Duplicate entry '${numero}' for key 'numero_documento'` };
        throw e;
      }
      const p = { id: (seq.pagamento += 1), estado: 'confirmado', ...dados };
      db.pagamentos.push(p);
      return comMetodos(p);
    },
    findOne: async ({ where, transaction } = {}) => {
      if (where && where.numero_documento) registoFindOne.push({ where, transaction });
      return comMetodos(onde(db.pagamentos, where)[0]) || null;
    },
    findAll: async ({ where } = {}) => onde(db.pagamentos, where).map(comMetodos),
    findByPk: async (id) => comMetodos(db.pagamentos.find((p) => Number(p.id) === Number(id))) || null,
    update: async (dados, { where } = {}) => {
      const alvos = onde(db.pagamentos, where);
      alvos.forEach((p) => Object.assign(p, dados));
      return [alvos.length];
    },
  },
  Quota: {
    findAll: async ({ where } = {}) =>
      onde(db.quotas, where)
        .sort((a, b) => a.ano - b.ano || a.mes - b.mes)
        .map(comMetodos),
    findByPk: async (id) => comMetodos(db.quotas.find((q) => Number(q.id) === Number(id))) || null,
  },
  PagamentoQuota: {
    create: async (dados) => {
      const a = { id: (seq.aplicacao += 1), ...dados };
      db.pagamentoQuotas.push(a);
      return a;
    },
    findAll: async ({ where } = {}) =>
      onde(db.pagamentoQuotas, where).map((a) => ({
        ...a,
        pagamento: db.pagamentos.find((p) => Number(p.id) === Number(a.pagamento_id)) || null,
      })),
  },
  Fracao: {
    findOne: async ({ where } = {}) => comMetodos(onde(db.fracas, where)[0]) || null,
    findAll: async ({ where } = {}) => onde(db.fracas, where),
  },
  ExtraQuotaParcela: {
    findAll: async ({ where } = {}) => onde(db.extraParcelas, where).map(comMetodos),
    findByPk: async (id) => comMetodos(db.extraParcelas.find((p) => Number(p.id) === Number(id))) || null,
  },
  ExtraQuota: {
    findOne: async ({ where } = {}) => comMetodos(onde(db.extraQuotas || [], where)[0]) || null,
  },
  PagamentoExtraParcela: {
    create: async (dados) => {
      const a = { id: (seq.extraPagamentoParcela = (seq.extraPagamentoParcela || 0) + 1), ...dados };
      db.extraPagamentoParcelas.push(a);
      return a;
    },
    findAll: async ({ where } = {}) => onde(db.extraPagamentoParcelas, where),
  },
  MovimentoBancario: {
    findAll: async ({ where } = {}) => onde(db.movimentos, where).map(comMetodos),
    findOne: async ({ where } = {}) => comMetodos(onde(db.movimentos, where)[0]) || null,
  },
};

const stub = (rel, valor) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
};

stub('models', modelos);
stub('models/index.js', modelos);
stub('config/database.js', { transaction: async () => novaTransacao(), Sequelize: {}, Op });
// O movimento bancário não é o objeto deste teste (é exercido pelas suites de
// movimentos): aqui só interessa que a gravação do pagamento o cria.
stub('helpers/movimentos.js', {
  criarMovimento: async (d) => {
    const m = { id: db.movimentos.length + 1, ...d, estado: 'confirmado' };
    db.movimentos.push(m);
    return m;
  },
  sincronizarMovimentoDespesa: async () => {},
});

const { proximoNumero, comporNumero } = require('../helpers/numeracao');
const pagamentosHelper = require('../helpers/pagamentos');

// ── Cenário de produção ─────────────────────────────────────────────
// A série está em 3 (recuada pelo seed) e `2026/0004` já pertence a um documento
// gravado — é exatamente o estado que produziu o erro em produção.
const PAGAMENTOS_EXISTENTES = [
  { id: 1, condominio_id: 1, numero_documento: '2026/0001', fracao_id: 1, valor: '50.00' },
  { id: 2, condominio_id: 1, numero_documento: '2026/0002', fracao_id: 1, valor: '50.00' },
  { id: 3, condominio_id: 1, numero_documento: '2026/0003', fracao_id: 1, valor: '50.00' },
  { id: 4, condominio_id: 1, numero_documento: '2026/0004', fracao_id: 4, valor: '1093.65', data_pagamento: '2026-09-15' },
];

const cenárioDeProducao = () => ({
  numeracoes: [{ id: 1, tipo_documento: 'recibo', ano: 2026, sequencia: 3, formato: '{ano}/{sequencia}' }],
  pagamentos: PAGAMENTOS_EXISTENTES.map((p) => ({ ...p })),
  fracas: [
    { id: 1, condominio_id: 1, permilagem: '500' },
    { id: 4, condominio_id: 1, permilagem: '500' },
  ],
  quotas: [
    { id: 11, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 9, valor: '28.70', estado: 'pendente' },
    { id: 14, condominio_id: 4, fracao_id: 4, ano: 2026, mes: 9, valor: '1093.65', estado: 'pendente' },
  ],
});

// Os quatro registos do log de produção.
const REGISTOS_DE_PRODUCAO = [
  { fracaoId: 4, valor: 1093.65, dataPagamento: '2026-09-15' },
  { fracaoId: 1, valor: 28.70, dataPagamento: '2026-09-15' },
  { fracaoId: 1, valor: 200, dataPagamento: '2026-09-08' },
  { fracaoId: 1, valor: 200, dataPagamento: '2026-09-21' },
];

const sequencia = (tipo = 'recibo', ano = 2026) => {
  const n = db.numeracoes.find((x) => x.tipo_documento === tipo && x.ano === ano);
  return n ? n.sequencia : null;
};

// ── 1. O estado de produção é reproduzível e o gerador ANTIGO falharia ──
function testeEstadoDeProducao() {
  reiniciar(cenárioDeProducao());

  // Sem verificação, o gerador devolve mesmo o número ocupado — é este o bug.
  const semVerificacao = proximoNumero('recibo', {
    ano: 2026,
    transaction: { LOCK: { UPDATE: 'u' }, commit: async () => {}, rollback: async () => {} },
  });
  return semVerificacao.then(async (numero) => {
    assert.strictEqual(numero, '2026/0004', 'sem verificação o gerador devolve o número JÁ OCUPADO (2026/0004)');
    assert.ok(
      db.pagamentos.some((p) => p.numero_documento === numero),
      '…e esse número já existe em `pagamentos` — é a colisão de produção'
    );

    // A demonstração acima consumiu um número (o gerador avança sempre a série).
    // Repõe-se o estado de produção para que a asserção seguinte meça só o
    // comportamento novo — e para que o valor esperado (3) seja o de produção.
    reiniciar(cenárioDeProducao());

    // Com verificação, salta para o primeiro livre.
    const transacao = novaTransacao();
    const comVerificacao = await proximoNumero('recibo', {
      ano: 2026,
      transaction: transacao,
      jaUsado: async (n) => db.pagamentos.some((p) => p.numero_documento === n),
    });
    assert.strictEqual(comVerificacao, '2026/0005', 'com verificação o gerador salta para 2026/0005');
    await transacao.rollback();
    assert.strictEqual(sequencia(), 3, 'a sequência volta a 3 (rollback) — o estado de produção mantém-se');

    console.log('  ✓ 1. o estado de produção é reproduzido e a verificação de número livre evita a colisão');
  });
}

// ── 2. Os quatro pagamentos do log passam a ser registados ──────────
async function testeQuatroPagamentos() {
  reiniciar(cenárioDeProducao());

  const numeros = [];
  for (const registo of REGISTOS_DE_PRODUCAO) {
    const { pagamento } = await pagamentosHelper.registarPagamento({
      ...registo,
      metodoPagamentoId: null,
      contaBancariaId: null,
      referencia: null,
      observacoes: null,
      userId: 7,
      condominioId: 1,
    });
    numeros.push(pagamento.numero_documento);
  }

  assert.deepStrictEqual(
    numeros,
    ['2026/0005', '2026/0006', '2026/0007', '2026/0008'],
    `os quatro pagamentos ficam com números distintos e livres (obtido: ${numeros.join(', ')})`
  );
  assert.strictEqual(new Set(numeros).size, 4, 'nenhum número repetido');
  assert.ok(!numeros.includes('2026/0004'), 'o número do documento já gravado NUNCA é reatribuído');
  assert.strictEqual(sequencia(), 8, 'a série avança para 8 e fica coerente com os documentos gravados');

  // O documento antigo mantém o seu número (não foi tocado).
  const antigo = db.pagamentos.find((p) => Number(p.id) === 4);
  assert.strictEqual(antigo.numero_documento, '2026/0004', 'o documento original conserva 2026/0004');

  // Cada pagamento continua a ser aplicado às quotas (o número não mudou nada).
  const p1 = db.pagamentos.find((p) => p.numero_documento === '2026/0006');
  const aplicacoes = db.pagamentoQuotas.filter((a) => Number(a.pagamento_id) === Number(p1.id));
  assert.strictEqual(aplicacoes.length, 1, 'o pagamento de 28,70 € foi aplicado à quota de setembro');
  assert.strictEqual(toCents(aplicacoes[0].valor_aplicado), toCents('28.70'), 'valor aplicado integral');
  assert.strictEqual(db.quotas.find((q) => q.id === 11).estado, 'paga', 'a quota fica paga');

  console.log('  ✓ 2. os 4 pagamentos do log de produção são registados com números distintos (0005–0008)');
}

// ── 3. A gravação falhada já não bloqueia a série ───────────────────
async function testeFalhaNaoBloqueia() {
  reiniciar(cenárioDeProducao());

  // Um pagamento que falha DEPOIS de obter o número (quota de outra fração).
  let erro = null;
  try {
    await pagamentosHelper.registarPagamentoComItens({
      fracaoId: 1,
      valor: 200,
      quotaIds: [14], // quota 14 é da fração 4
      parcelaIds: [],
      dataPagamento: '2026-09-21',
      userId: 7,
      condominioId: 1,
    });
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, 'a seleção inválida é recusada (não grava nada)');
  assert.strictEqual(db.pagamentos.length, PAGAMENTOS_EXISTENTES.length, 'nenhum pagamento gravado');
  assert.strictEqual(sequencia(), 3, 'a sequência não é consumida por uma gravação falhada (atomicidade)');

  // O registo seguinte continua a funcionar — a série não fica presa.
  const { pagamento } = await pagamentosHelper.registarPagamento({
    fracaoId: 1, valor: 28.70, dataPagamento: '2026-09-15', userId: 7, condominioId: 1,
  });
  assert.strictEqual(pagamento.numero_documento, '2026/0005', 'o registo seguinte obtém 2026/0005 (não fica preso em 0004)');
  assert.strictEqual(sequencia(), 5, 'a série volta a avançar');

  console.log('  ✓ 3. uma gravação falhada não consome o número nem prende a série');
}

// ── 4. Vários números ocupados seguidos: salta todos ────────────────
async function testeSaltosMultiplos() {
  reiniciar({
    ...cenárioDeProducao(),
    numeracoes: [{ id: 1, tipo_documento: 'recibo', ano: 2026, sequencia: 3, formato: '{ano}/{sequencia}' }],
    pagamentos: [
      ...PAGAMENTOS_EXISTENTES.map((p) => ({ ...p })),
      { id: 5, condominio_id: 1, numero_documento: '2026/0005', fracao_id: 1, valor: '10.00' },
      { id: 6, condominio_id: 1, numero_documento: '2026/0006', fracao_id: 1, valor: '10.00' },
      { id: 7, condominio_id: 1, numero_documento: '2026/0007', fracao_id: 1, valor: '10.00' },
    ],
  });

  const { pagamento } = await pagamentosHelper.registarPagamento({
    fracaoId: 1, valor: 28.70, dataPagamento: '2026-09-15', userId: 7, condominioId: 1,
  });
  assert.strictEqual(pagamento.numero_documento, '2026/0008', 'salta 0004–0007 e usa 2026/0008');
  assert.strictEqual(sequencia(), 8, 'a sequência fica no último número atribuído');

  console.log('  ✓ 4. com vários números ocupados seguidos, salta para o primeiro livre');
}

// ── 5. O número de um pagamento ANULADO não é reutilizado ───────────
async function testeAnuladoNaoReutiliza() {
  reiniciar(cenárioDeProducao());

  const { pagamento } = await pagamentosHelper.registarPagamento({
    fracaoId: 1, valor: 28.70, dataPagamento: '2026-09-15', userId: 7, condominioId: 1,
  });
  assert.strictEqual(pagamento.numero_documento, '2026/0005', 'primeiro pagamento: 2026/0005');

  await pagamentosHelper.anularPagamento(pagamento.id);
  assert.strictEqual(
    db.pagamentos.find((p) => p.id === pagamento.id).numero_documento,
    '2026/0005',
    'o pagamento anulado CONSERVA o número do documento'
  );

  const seguinte = await pagamentosHelper.registarPagamento({
    fracaoId: 1, valor: 28.70, dataPagamento: '2026-09-16', userId: 7, condominioId: 1,
  });
  assert.strictEqual(seguinte.pagamento.numero_documento, '2026/0006', 'o número anulado não é reutilizado');

  console.log('  ✓ 5. o número de um pagamento anulado nunca é reutilizado');
}

// ── 6. Os outros dois pontos de pagamento também verificam ──────────
async function testeOutrosPontos() {
  // registarPagamentoComItens (pagamento combinado).
  reiniciar(cenárioDeProducao());
  const combinado = await pagamentosHelper.registarPagamentoComItens({
    fracaoId: 1,
    valor: 28.70,
    quotaIds: [11],
    parcelaIds: [],
    dataPagamento: '2026-09-15',
    userId: 7,
    condominioId: 1,
  });
  assert.strictEqual(combinado.pagamento.numero_documento, '2026/0005', 'o pagamento combinado usa 2026/0005');

  // registarPagamentoExtraParcela (parcela de quota extra).
  reiniciar({
    ...cenárioDeProducao(),
    extraQuotas: [{ id: 3, condominio_id: 1, designacao: 'Obras', estado: 'processada' }],
    extraParcelas: [{ id: 21, extra_quota_id: 3, fracao_id: 1, parcela_numero: 1, valor: '120.00', estado: 'pendente' }],
  });
  const parcela = await pagamentosHelper.registarPagamentoExtraParcela({
    parcelaId: 21, dataPagamento: '2026-09-20', userId: 7, condominioId: 1,
  });
  assert.strictEqual(parcela.pagamento.numero_documento, '2026/0005', 'o pagamento da parcela usa 2026/0005');

  console.log('  ✓ 6. os três pontos de criação de pagamento usam a mesma série verificada');
}

// ── 7. Retrocompatibilidade do gerador ──────────────────────────────
async function testeRetrocompatibilidade() {
  reiniciar({
    numeracoes: [{ id: 1, tipo_documento: 'aviso_quota', ano: 2026, sequencia: 0, formato: '{ano}/{sequencia}' }],
  });
  const t = novaTransacao();
  const a = await proximoNumero('aviso_quota', { ano: 2026, transaction: t });
  const b = await proximoNumero('aviso_quota', { ano: 2026, transaction: t });
  await t.commit();
  assert.strictEqual(a, '2026/0001', 'sem verificação, o primeiro número é 2026/0001');
  assert.strictEqual(b, '2026/0002', 'e o seguinte 2026/0002 — comportamento anterior preservado');
  assert.strictEqual(comporNumero('RCP-{ano}-{sequencia}', 2026, 7), 'RCP-2026-0007', 'o formato do recibo é respeitado');

  console.log('  ✓ 7. sem verificação o gerador mantém exatamente o comportamento anterior');
}

// ── 8. A causa 1 (o seed mexia na série dos PAGAMENTOS) não pode voltar ──
// Verificação estática do seed: `numeracoes` só pode ser tocada na série dos
// RECIBOS (`recibo_mensal`). Escrever a série `recibo` (pagamentos) — ou recuá-la
// — foi o que deixou a produção a entregar `2026/0004` repetidamente.
function testeSeedNaoTocaNaSerieDosPagamentos() {
  const fonte = fs.readFileSync(path.join(RAIZ, 'scripts/seed-demo.js'), 'utf8');
  const usos = [...fonte.matchAll(/tipo_documento:\s*'([^']+)'/g)].map((m) => m[1]);

  assert.ok(usos.length >= 2, `o seed continua a mexer em numeração (encontrados ${usos.length} usos)`);
  assert.ok(
    usos.every((t) => t === 'recibo_mensal'),
    `o seed só pode mexer na série 'recibo_mensal' (recibos); encontrado: ${[...new Set(usos)].join(', ')}`
  );
  assert.ok(
    !/tipo_documento:\s*'recibo'/.test(fonte),
    "o seed NUNCA pode escrever a série 'recibo' — é a série dos PAGAMENTOS"
  );
  // O alinhamento tem de ser só para a frente: recuar a sequência recria a colisão.
  assert.ok(
    /tipo_documento:\s*'recibo_mensal',\s*ano:\s*anoAtual,\s*sequencia:\s*\{\s*\[Op\.lt\]/.test(fonte),
    'o alinhamento da sequência tem de ser avanço-só ([Op.lt]), nunca um recuo'
  );

  console.log('  ✓ 8. o seed só alinha a série dos recibos e apenas para a frente');
}

// ── 9. Isolamento por condomínio: o número é único GLOBALMENTE ──────
// `pagamentos.numero_documento` é UNIQUE e `numeracoes` NÃO tem `condominio_id`
// — a série é global. Logo a verificação não pode ser filtrada por condomínio:
// um número já usado por OUTRO condomínio continua ocupado. Se o predicado
// passasse a filtrar por `condominio_id`, devolveria o número do vizinho e a
// gravação rebentava com ER_DUP_ENTRY — o mesmo erro de produção.
async function testeIsolamentoPorCondominio() {
  reiniciar({
    numeracoes: [{ id: 1, tipo_documento: 'recibo', ano: 2026, sequencia: 3, formato: '{ano}/{sequencia}' }],
    pagamentos: [
      { id: 1, condominio_id: 1, numero_documento: '2026/0001', fracao_id: 1, valor: '50.00' },
      { id: 2, condominio_id: 1, numero_documento: '2026/0002', fracao_id: 1, valor: '50.00' },
      { id: 3, condominio_id: 1, numero_documento: '2026/0003', fracao_id: 1, valor: '50.00' },
      // `2026/0004` pertence a OUTRO condomínio (2).
      { id: 4, condominio_id: 2, numero_documento: '2026/0004', fracao_id: 9, valor: '77.00' },
    ],
    fracas: [{ id: 1, condominio_id: 1, permilagem: '500' }],
    quotas: [{ id: 11, condominio_id: 1, fracao_id: 1, ano: 2026, mes: 9, valor: '28.70', estado: 'pendente' }],
  });

  const { pagamento } = await pagamentosHelper.registarPagamento({
    fracaoId: 1, valor: 28.70, dataPagamento: '2026-09-15', userId: 7, condominioId: 1,
  });

  assert.strictEqual(
    pagamento.numero_documento,
    '2026/0005',
    'o número de OUTRO condomínio (2026/0004) está ocupado — a série é global'
  );
  assert.strictEqual(Number(pagamento.condominio_id), 1, 'o pagamento fica no condomínio ativo');

  // E a verificação NÃO pode ter filtrado por condomínio.
  assert.ok(
    registoFindOne.every((c) => !('condominio_id' in c.where)),
    'a verificação do número livre é GLOBAL: filtrá-la por condominio_id reabre a colisão'
  );

  console.log('  ✓ 9. o número é único globalmente — o de outro condomínio não é reatribuído');
}

// ── 10. A verificação corre DENTRO da transação (concorrência) ──────
// A serialização de dois registos simultâneos depende do `FOR UPDATE` sobre a
// linha de `numeracoes`, e é a mesma transação que serve o predicado. Se o
// predicado corresse fora da transação, dois pedidos poderiam ler o mesmo
// «primeiro número livre» e um deles falharia (TOCTOU).
async function testeVerificacaoDentroDaTransacao() {
  reiniciar(cenárioDeProducao());

  await pagamentosHelper.registarPagamento({
    fracaoId: 1, valor: 28.70, dataPagamento: '2026-09-15', userId: 7, condominioId: 1,
  });

  const verificacoes = registoFindOne.filter((c) => c.where && c.where.numero_documento);
  assert.ok(verificacoes.length >= 1, 'a verificação consultou os números já usados');
  assert.ok(
    verificacoes.every((c) => c.transaction && c.transaction.LOCK && c.transaction.LOCK.UPDATE === 'update'),
    'o predicado tem de correr na MESMA transação do pagamento (é o FOR UPDATE que serializa os concorrentes)'
  );

  console.log('  ✓ 10. a verificação de número livre corre dentro da transação (sem TOCTOU)');
}

(async () => {
  console.log('Numeração do documento de pagamento — regressão do erro de produção\n');
  await testeEstadoDeProducao();
  await testeQuatroPagamentos();
  await testeFalhaNaoBloqueia();
  await testeSaltosMultiplos();
  await testeAnuladoNaoReutiliza();
  await testeOutrosPontos();
  await testeRetrocompatibilidade();
  testeSeedNaoTocaNaSerieDosPagamentos();
  await testeIsolamentoPorCondominio();
  await testeVerificacaoDentroDaTransacao();
  assert.strictEqual(transacoesAbertas, 0, 'nenhuma transação ficou aberta');
  console.log('\n✓ Testes da numeração do documento de pagamento passaram (sem base de dados).');
})().catch((e) => {
  console.error('\n✗ FALHA:', e.message);
  console.error(e.stack);
  process.exit(1);
});
