// Smoke test do seed de demonstração — executa as funções REAIS de
// `scripts/seed-demo.js` contra modelos FALSOS (sem base de dados).
// Utilização: node scripts/test-seed-demo-smoke.js
//
// Complementa `test-seed-demo.js` (análise estática): aqui o código é
// executado a sério, o que apanha erros de ESCOPO, nomes de variáveis e
// assinaturas que o `node --check` não deteta.
const assert = require('assert');
const path = require('path');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_EXPORTAR = '1';

// ── Dados falsos ─────────────────────────────────────────────────────
const CID = 99;
const FRACOES = [
  { id: 1, condominio_id: CID, permilagem: 180, nome: 'Fração A' },
  { id: 2, condominio_id: CID, permilagem: 170, nome: 'Fração B' },
  { id: 3, condominio_id: CID, permilagem: 165, nome: 'Fração C' },
  { id: 4, condominio_id: CID, permilagem: 160, nome: 'Fração D' },
  { id: 5, condominio_id: CID, permilagem: 165, nome: 'Fração E' },
  { id: 6, condominio_id: CID, permilagem: 160, nome: 'Fração F' },
];
const CONTAS = [
  { id: 10, condominio_id: CID, nome: 'CA — Conta Corrente', tipo: 'corrente', saldo_inicial: '2500.00' },
  { id: 11, condominio_id: CID, nome: 'CA — Fundo de Reserva', tipo: 'fundo_reserva', saldo_inicial: '0.00' },
  { id: 12, condominio_id: CID, nome: 'CA — Poupança', tipo: 'poupanca', saldo_inicial: '1800.00' },
];
const QUOTAS = [
  { id: 1, condominio_id: CID, fracao_id: 1, valor: '23.76', valor_base: '21.60', valor_fcr: '2.16', estado: 'paga', data_vencimento: '2025-11-10' },
  { id: 2, condominio_id: CID, fracao_id: 1, valor: '23.76', valor_base: '21.60', valor_fcr: '2.16', estado: 'pendente', data_vencimento: '2099-12-10' },
  { id: 3, condominio_id: CID, fracao_id: 2, valor: '22.44', valor_base: '20.40', valor_fcr: '2.04', estado: 'parcialmente_paga', data_vencimento: '2025-12-10' },
];
const MOVIMENTOS = [
  { id: 100, condominio_id: CID, conta_bancaria_id: 10, tipo: 'entrada', valor: '500.00', data: '2025-11-08', estado: 'confirmado', referencia: 'DEMO-202511', pagamento_id: 1, despesa_id: null, extra_quota_parcela_id: null },
  { id: 101, condominio_id: CID, conta_bancaria_id: 11, tipo: 'entrada', valor: '51.00', data: '2026-04-05', estado: 'confirmado', referencia: 'TRANSF', pagamento_id: null, despesa_id: null, extra_quota_parcela_id: null },
  { id: 102, condominio_id: CID, conta_bancaria_id: 10, tipo: 'saida', valor: '51.00', data: '2026-04-05', estado: 'confirmado', referencia: 'TRANSF', pagamento_id: null, despesa_id: null, extra_quota_parcela_id: null },
  { id: 103, condominio_id: CID, conta_bancaria_id: 10, tipo: 'saida', valor: '30.00', data: '2026-02-21', estado: 'anulado', referencia: null, pagamento_id: null, despesa_id: null, extra_quota_parcela_id: null },
  { id: 104, condominio_id: CID, conta_bancaria_id: 10, tipo: 'entrada', valor: '45.50', data: '2026-02-20', estado: 'confirmado', referencia: null, pagamento_id: null, despesa_id: null, extra_quota_parcela_id: null },
  { id: 105, condominio_id: CID, conta_bancaria_id: 10, tipo: 'saida', valor: '180.00', data: '2026-05-15', estado: 'confirmado', referencia: null, pagamento_id: null, despesa_id: 1, extra_quota_parcela_id: null },
];
const TITULARIDADES = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];

// ── Modelo falso ─────────────────────────────────────────────────────
// Interpreta um `where` do Sequelize (subconjunto usado pelo verificador).
const { Op } = require('sequelize');
function filtrarMovimentos(where = {}) {
  return MOVIMENTOS.filter((m) => {
    if (!where) return m.estado === 'confirmado';
    for (const [campo, cond] of Object.entries(where)) {
      const val = m[campo];
      if (cond === null) {
        if (val !== null) return false;
        continue;
      }
      if (cond && typeof cond === 'object') {
        if (Op.ne in cond && String(val) === String(cond[Op.ne])) return false;
        if (Op.in in cond && !cond[Op.in].map(String).includes(String(val))) return false;
        if (Op.lt in cond && !(String(val) < String(cond[Op.lt]))) return false;
        continue;
      }
      if (String(val) !== String(cond)) return false;
    }
    return true;
  });
}

function fakeModel(over = {}) {
  return Object.assign({
    rawAttributes: {},
    findAll: async () => [],
    findOne: async () => null,
    findByPk: async () => null,
    count: async () => 0,
    create: async (d) => ({ id: 1, ...d }),
    update: async () => [1],
    findOrCreate: async () => [{ id: 1 }, false],
  }, over);
}
const models = {
  User: fakeModel(), UserCondominio: fakeModel(), Condominio: fakeModel(),
  Pessoa: fakeModel({ count: async () => 0 }), Fracao: fakeModel({ findAll: async () => FRACOES }),
  FracaoPessoa: fakeModel(), FracaoTitularidade: fakeModel({ count: async () => TITULARIDADES.length }),
  ContaBancaria: fakeModel({ findAll: async () => CONTAS }),
  Categoria: fakeModel({ findOne: async () => ({ id: 1, nome: 'Quotas' }) }),
  MetodoPagamento: fakeModel({ findOne: async () => ({ id: 1, nome: 'Transferência bancária' }) }),
  Orcamento: fakeModel(), OrcamentoRubrica: fakeModel(), OrcamentoDistribuicao: fakeModel(),
  Quota: fakeModel({
    findAll: async ({ where } = {}) => {
      let out = QUOTAS;
      if (where && where.estado === 'paga') out = out.filter((q) => q.estado === 'paga');
      if (where && where.condominio_id === CID) out = out.filter((q) => q.condominio_id === CID);
      return out;
    },
    count: async ({ where } = {}) => {
      // Sem fugas de âmbito e sem quotas do demo fora do demo.
      if (where && where.condominio_id && where.condominio_id[Op.ne] !== undefined) return 0;
      if (where && where.fracao_id && where.condominio_id === CID) return QUOTAS.length;
      return QUOTAS.length;
    },
  }),
  Pagamento: fakeModel(), PagamentoQuota: fakeModel({ findAll: async () => [
    { quota_id: 1, valor_aplicado: '23.76', pagamento: { estado: 'confirmado' } },
    { quota_id: 3, valor_aplicado: '11.22', pagamento: { estado: 'confirmado' } },
  ] }),
  ExtraQuota: fakeModel({ count: async () => 1, findAll: async () => [{ id: 7 }] }),
  ExtraQuotaParcela: fakeModel({ count: async () => 6 }),
  PagamentoExtraParcela: fakeModel(),
  Despesa: fakeModel({
    count: async ({ where } = {}) => {
      const todas = [
        { estado: 'paga', conta_bancaria_id: 10, condominio_id: CID },
        { estado: 'paga', conta_bancaria_id: 10, condominio_id: CID },
        { estado: 'registada', conta_bancaria_id: null, condominio_id: CID },
      ];
      if (!where) return todas.length;
      return todas.filter((d) => {
        if (where.estado !== undefined && d.estado !== where.estado) return false;
        if (where.conta_bancaria_id === null && d.conta_bancaria_id !== null) return false;
        if (where.condominio_id === CID && d.condominio_id !== CID) return false;
        return true;
      }).length;
    },
  }),
  Fornecedor: fakeModel(),
  MovimentoBancario: fakeModel({
    findAll: async ({ where } = {}) => filtrarMovimentos(where),
    count: async ({ where } = {}) => filtrarMovimentos(where).length,
  }),
  Documento: fakeModel({ count: async () => 0 }), Assembleia: fakeModel(), AgendaItem: fakeModel(),
  AssembleiaParticipante: fakeModel(), Aviso: fakeModel(), AvisoDestinatario: fakeModel(),
  Recibo: fakeModel(), ReciboQuota: fakeModel(), AuditLog: fakeModel(),
  Numeracao: fakeModel(), EmailFila: fakeModel({ count: async () => 0 }),
};

// ── Interceção dos requires ──────────────────────────────────────────
// O `models/index.js` real constrói os modelos com `sequelize.define` (e isso
// exigiria uma BD). Em vez de o carregar, injetamos os modelos falsos na cache
// de módulos. Só assim nenhum ficheiro de modelo é sequer lido.
const RAIZ = path.join(__dirname, '..');
const MODELS_PATH = require.resolve(path.join(RAIZ, 'models'));
require.cache[MODELS_PATH] = {
  id: MODELS_PATH,
  filename: MODELS_PATH,
  loaded: true,
  exports: models,
  children: [],
  paths: [],
};

const ALVO = {
  [path.join(RAIZ, 'config', 'database.js')]: { authenticate: async () => {}, close: async () => {}, transaction: async () => ({ commit: async () => {}, rollback: async () => {} }) },
  [path.join(RAIZ, 'helpers', 'movimentos.js')]: {
    saldoContaMovimentos: async (conta) => {
      const movs = MOVIMENTOS.filter((m) => m.conta_bancaria_id === conta.id && m.estado === 'confirmado');
      let s = Math.round(Number(conta.saldo_inicial) * 100);
      for (const m of movs) {
        const v = Math.round(Number(m.valor) * 100);
        s += m.tipo === 'entrada' ? v : -v;
      }
      return (s / 100).toFixed(2);
    },
    criarMovimento: async () => ({ id: 1 }),
    registarTransferencia: async () => ({ id: 1 }),
    sincronizarMovimentoDespesa: async () => {},
  },
  [path.join(RAIZ, 'helpers', 'fcr.js')]: {
    transferirFcr: async () => ({ ok: true }),
    transferirFcrAprovado: async () => ({ ok: true }),
    resumoFcr: async () => ({ emitidoC: 10278, recebidoC: 10278, transferidoC: 5100, disponivelC: 5178 }),
  },
  [path.join(RAIZ, 'helpers', 'extrato.js')]: {
    // Espelha a regra real: saldo = Σ saldos iniciais + entradas − saídas das
    // contas do condomínio. Calculado a partir dos mesmos MOVIMENTOS.
    extrato: async () => {
      const confirmados = MOVIMENTOS.filter((m) => m.estado === 'confirmado');
      let saldoC = CONTAS.reduce((s, c) => s + Math.round(Number(c.saldo_inicial) * 100), 0);
      let entradasC = 0;
      let saidasC = 0;
      for (const m of confirmados) {
        const v = Math.round(Number(m.valor) * 100);
        if (m.tipo === 'entrada') {
          saldoC += v;
          entradasC += v;
        } else {
          saldoC -= v;
          saidasC += v;
        }
      }
      return { linhas: confirmados, resumo: { saldoFinalC: saldoC, entradasC, saidasC } };
    },
  },
  [path.join(RAIZ, 'helpers', 'saldos.js')]: {
    estadoEfetivo: (q) => (q && q.estado === 'paga' ? 'paga' : 'vencida'),
  },
  [path.join(RAIZ, 'helpers', 'pagamentos.js')]: { registarPagamento: async () => ({ id: 1 }), registarPagamentoExtraParcela: async () => ({ id: 1 }) },
  [path.join(RAIZ, 'helpers', 'quotas-config.js')]: { getQuotaConfig: async () => ({ valorPor1000: '120.0000', fcrPercentagem: '10' }) },
  [path.join(RAIZ, 'helpers', 'config.js')]: { setConfig: async () => {} },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (e) { /* deixa o require original tratar */ }
  if (resolved && Object.prototype.hasOwnProperty.call(ALVO, resolved)) return ALVO[resolved];
  return origLoad.apply(this, arguments);
};

// ── Execução ─────────────────────────────────────────────────────────
async function correr() {
  const seed = require(path.join(RAIZ, 'scripts', 'seed-demo.js'));
  assert.strictEqual(typeof seed.verificarInvariantes, 'function', 'verificarInvariantes exportada');

  // Captura a saída para não poluir o terminal do utilizador.
  const origLog = console.log;
  const linhas = [];
  console.log = (...a) => linhas.push(a.join(' '));
  let resultado;
  try {
    resultado = await seed.verificarInvariantes(CID);
  } finally {
    console.log = origLog;
  }

  const texto = linhas.join('\n');
  assert.ok(resultado && Array.isArray(resultado.falhas), 'verificarInvariantes devolve { falhas }');
  assert.ok(texto.length > 0, 'verificarInvariantes imprime o resultado');

  // As verificações têm de ter corrido TODAS (nenhuma exceção de escopo).
  const esperadas = [
    'Σ permilagens = 1000‰',
    'Pagamentos aplicados ≤ valor da quota',
    'Estado das quotas derivado do pago',
    'Transferências com duas pontas',
    'Nenhum movimento novo sem condominio_id',
    'Saldo agregado do Extrato = somatório das contas',
    'Isolamento do condomínio demo',
    'Existem movimentos anulados',
    'Existem ajustes manuais',
    "Documentos com drive_status='nao_guardado'",
    'Nenhum email enviado pelo seed',
    'FCR transferido ≤ FCR recebido',
    'Nenhuma conta com saldo negativo',
    'Existe quota extra processada',
    'Existem parcelas de quota extra pagas',
    'Existem despesas pagas E por pagar',
    'Despesas pagas têm conta bancária',
    'Titularidades ativas ≥ frações',
  ];
  for (const e of esperadas) {
    assert.ok(texto.includes(e), `verificação executada: ${e}`);
  }

  // Com estes dados falsos coerentes, não pode haver falhas.
  if (resultado.falhas.length) {
    throw new Error('Invariantes falharam com dados coerentes:\n  · ' + resultado.falhas.join('\n  · '));
  }

  // resumir() também tem de correr sem erro de escopo.
  const contas = CONTAS;
  console.log = (...a) => linhas.push(a.join(' '));
  try {
    await seed.resumir(CID, { condominio: { id: CID }, gestor: { id: 1 }, fracoes: FRACOES, pessoas: [], usersCondominos: [], contas });
  } finally {
    console.log = origLog;
  }
  assert.ok(linhas.join('\n').includes('FCR'), 'resumir imprime o resumo do FCR');

  // mostrarPlano() corre sem BD.
  console.log = (...a) => linhas.push(a.join(' '));
  try {
    seed.mostrarPlano();
  } finally {
    console.log = origLog;
  }
  assert.ok(linhas.join('\n').includes('1000‰'), 'mostrarPlano mostra as permilagens');

  console.log('✓ Smoke test do seed de demonstração passou (modelos falsos, sem base de dados).');
}

correr().catch((err) => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
