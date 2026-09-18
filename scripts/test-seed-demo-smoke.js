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

// ── Estado mutável para o teste do `--reparar` ───────────────────────
// O reparador altera registos, por isso precisa de modelos que guardem estado.
// Recria-se aqui o cenário EXATO que falhou em produção: gestor com
// `pessoa_id = null`, `role = 'condomino'` e associação `gestor` ativa.
// Os parâmetros permitem cobrir também a associação INATIVA — que é o mesmo
// que não existir para `associacaoAtiva` (helpers/tenant.js:21).
function fakeModelReparacao({ assocRole = 'gestor', assocEstado = 'ativo', fracoesLivres = [2, 3] } = {}) {
  // Instâncias com `.update()` (o reparador usa `gestor.update(...)` e
  // `associacao.update(...)`, tal como o código real faz).
  const user = {
    id: 4, email: 'demo.gestor@example.test', nome: 'Gestor Demo',
    role: 'condomino', pessoa_id: null,
    async update(d) { Object.assign(this, d); return this; },
  };
  const associacao = {
    id: 9, utilizador_id: 4, condominio_id: CID, role: assocRole, estado: assocEstado,
    async update(d) { Object.assign(this, d); return this; },
  };
  const estado = {
    user,
    associacao,
    pessoaCriada: null,
    titularidadeCriada: null,
    // A fração 1 já tem titularidade ativa → a reparação tem de escolher a 2.ª.
    titularidades: [{ id: 1, condominio_id: CID, fracao_id: 1, pessoa_id: 30, estado: 'ativa' }],
  };

  // Filtro mínimo de `where` que chega para o reparador: igualdade estrita
  // sobre os campos pedidos (os `null` comparam-se como `null` de propósito —
  // é assim que o Sequelize traduz `{ campo: null }`).
  const corresponde = (registo, where) =>
    Object.entries(where || {}).every(([k, v]) => {
      if (v !== null && typeof v === 'object') return true; // operadores (Op.*): ignora
      return registo[k] === v;
    });

  const models = {
    User: fakeModel({ findOne: async () => estado.user }),
    Pessoa: fakeModel({
      findOne: async ({ where } = {}) => {
        if (estado.pessoaCriada && corresponde(estado.pessoaCriada, where)) return estado.pessoaCriada;
        // Sem Pessoa ligada e ainda sem Pessoa criada → não existe nenhuma.
        return null;
      },
      create: async (d) => { estado.pessoaCriada = { id: 77, ...d }; return estado.pessoaCriada; },
    }),
    UserCondominio: fakeModel({
      findOne: async () => estado.associacao,
      create: async (d) => { estado.associacao = { id: 10, ...d }; return estado.associacao; },
    }),
    // ESTATEFUL a sério: o `create` entra na coleção, para que a 2.ª passagem
    // do reparador encontre a titularidade criada na 1.ª e não duplique nada.
    // (Sem isto o teste passaria por acidente e não provaria a idempotência.)
    FracaoTitularidade: fakeModel({
      findOne: async ({ where } = {}) => estado.titularidades.find((t) => corresponde(t, where)) || null,
      findAll: async ({ where } = {}) => estado.titularidades.filter((t) => corresponde(t, where)),
      create: async (d) => {
        estado.titularidadeCriada = { id: estado.titularidades.length + 1, ...d };
        estado.titularidades.push(estado.titularidadeCriada);
        return estado.titularidadeCriada;
      },
    }),
    Fracao: fakeModel({
      // As frações existentes; `fracoesLivres` diz quais NÃO têm titular ativa.
      findAll: async () => FRACOES,
      findOne: async () => FRACOES[0],
    }),
  };
  // Marca como ocupadas todas as frações exceto as de `fracoesLivres`, para se
  // poder testar o caso «não há nenhuma livre» sem alterar o reparador.
  const FRACOES_TODAS = FRACOES.map((f) => Number(f.id));
  const ocupadas = FRACOES_TODAS.filter((id) => !fracoesLivres.includes(id));
  for (const [i, fid] of ocupadas.entries()) {
    estado.titularidades.push({
      id: 100 + i, condominio_id: CID, fracao_id: fid, pessoa_id: 900 + i, estado: 'ativa',
    });
  }
  return { models, estado };
}

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
    // Categoria de um movimento — MESMA regra do módulo real
    // (`helpers/extrato.js: categoriaDe`). O verificador de invariantes usa-a
    // para identificar os ajustes manuais, por isso o falso tem de a expor.
    CATEGORIAS: {
      pagamento: 'pagamento',
      despesa: 'despesa',
      quotaExtra: 'quota_extra',
      transferencia: 'transferencia',
      ajuste: 'ajuste',
    },
    categoriaDe: (m) => {
      if (Number(m.pagamento_id)) return 'pagamento';
      if (Number(m.despesa_id)) return 'despesa';
      if (Number(m.extra_quota_parcela_id)) return 'quota_extra';
      if (String(m.referencia || '') === 'TRANSF' || String(m.tipo || '') === 'transferencia') return 'transferencia';
      return 'ajuste';
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

  await testarReparacaoGestor(linhas);

  console.log('✓ Smoke test do seed de demonstração passou (modelos falsos, sem base de dados).');
}

// ── `--reparar`: executa o reparador REAL contra os modelos com estado ─
// Reproduz o cenário de produção (utilizador #4, pessoa_id NULL, role
// 'condomino', associação 'gestor') e exige que fique tudo corrigido — é a
// função que o utilizador vai correr no servidor, por isso tem de ser provada.
// Corre DOIS cenários de associação: `gestor` (papel errado) e `inativo`
// (a associação deixa de contar para `associacaoAtiva`).
async function testarReparacaoGestor(linhas) {
  await correrCenarioReparacao(linhas, {
    rotulo: "associação 'gestor' ativa",
    assocRole: 'gestor',
    assocEstado: 'ativo',
  });
  await correrCenarioReparacao(linhas, {
    rotulo: "associação 'admin' mas INATIVA",
    assocRole: 'admin',
    assocEstado: 'inativo',
  });
  // Com TODAS as frações ocupadas, o reparador não pode sobrepor-se a nenhuma:
  // tem de terminar sem criar titularidade.
  await correrCenarioReparacao(linhas, {
    rotulo: 'todas as frações já ocupadas',
    assocRole: 'gestor',
    assocEstado: 'ativo',
    fracoesLivres: [],
    esperaTitularidade: false,
  });
}

async function correrCenarioReparacao(linhas, { rotulo, assocRole, assocEstado, fracoesLivres = [2, 3], esperaTitularidade = true }) {
  const { models: modelsReparacao, estado } = fakeModelReparacao({ assocRole, assocEstado, fracoesLivres });

  // Carrega o seed numa cache LIMPA, com os modelos de reparação injetados.
  const RAIZ2 = path.join(__dirname, '..');
  const MODELS2 = require.resolve(path.join(RAIZ2, 'models'));
  const cacheAnterior = require.cache[MODELS2];
  const seedAnterior = require.cache[require.resolve(path.join(RAIZ2, 'scripts', 'seed-demo.js'))];
  require.cache[MODELS2] = {
    id: MODELS2, filename: MODELS2, loaded: true, exports: modelsReparacao, children: [], paths: [],
  };
  delete require.cache[require.resolve(path.join(RAIZ2, 'scripts', 'seed-demo.js'))];

  // Interceção temporária: devolve os modelos de reparação, mantém os helpers.
  const origLoad2 = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (e) { /* original */ }
    if (resolved === MODELS2) return modelsReparacao;
    if (resolved && Object.prototype.hasOwnProperty.call(ALVO, resolved)) return ALVO[resolved];
    return origLoad2.apply(this, arguments);
  };

  let seed2;
  try {
    seed2 = require(path.join(RAIZ2, 'scripts', 'seed-demo.js'));
    assert.strictEqual(typeof seed2.repararGestorDemo, 'function', 'repararGestorDemo exportada');

    const origLog = console.log;
    console.log = (...a) => linhas.push(a.join(' '));
    let res;
    try {
      res = await seed2.repararGestorDemo({ id: CID, designacao: 'Condomínio Demonstração' }, { dryRun: false });
    } finally {
      console.log = origLog;
    }

    // 1. AS DUAS fontes de autorização, coerentes:
    //    Após a correção da arquitetura, o destino pós-login e a guarda do
    //    backoffice leem a MESMA fonte (`utilizador_condominios.role` +
    //    `estado='ativo'`), pelo que o ciclo `/` ⇄ `/admin` deixou de ser
    //    possível por construção. `users.role` é legado, mantido por
    //    compatibilidade — o reparador continua a normalizá-lo para 'admin'.
    assert.strictEqual(estado.user.role, 'admin', "users.role normalizado para 'admin' (legado/compatibilidade)");
    assert.strictEqual(estado.associacao.role, 'admin', "utilizador_condominios.role = 'admin' (fonte do backoffice)");
    assert.strictEqual(estado.associacao.estado, 'ativo', "utilizador_condominios.estado = 'ativo' (associacaoAtiva)");
    // 2. A conta passou a estar ligada a uma Pessoa (remove o aviso do portal).
    assert.ok(estado.user.pessoa_id, 'users.pessoa_id preenchido');
    assert.strictEqual(Number(estado.user.pessoa_id), Number(estado.pessoaCriada.id), 'pessoa_id aponta para a Pessoa criada');
    // 3. Titularidade: criada na fração LIVRE (nunca na #1, que já tinha
    //    titular) — ou NENHUMA, quando não há fração livre.
    const nTitularidadesAntes = estado.titularidades.length;
    if (esperaTitularidade) {
      assert.ok(estado.titularidadeCriada, 'titularidade do gestor criada');
      assert.notStrictEqual(Number(estado.titularidadeCriada.fracao_id), 1, 'não sobrepõe a titularidade existente');
      assert.strictEqual(estado.titularidadeCriada.utilizador_id, estado.user.id, 'titularidade ligada ao gestor');
      assert.strictEqual(estado.titularidadeCriada.estado, 'ativa', 'titularidade ativa');
    } else {
      assert.strictEqual(estado.titularidadeCriada, null, `nenhuma titularidade criada (${rotulo})`);
    }
    assert.ok(res.alteracoes > 0, 'o reparador reporta alterações');

    // 4. IDEMPOTÊNCIA: a 2.ª passagem não altera nada.
    console.log = (...a) => linhas.push(a.join(' '));
    let res2;
    try {
      res2 = await seed2.repararGestorDemo({ id: CID, designacao: 'Condomínio Demonstração' }, { dryRun: false });
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(res2.alteracoes, 0, `a 2.ª execução não altera nada (${rotulo})`);
    // E depois da 2.ª passagem as duas fontes continuam coerentes.
    assert.strictEqual(estado.user.role, 'admin', 'users.role mantém-se admin (legado)');
    assert.strictEqual(estado.associacao.role, 'admin', 'a associação mantém-se admin');
    assert.strictEqual(estado.associacao.estado, 'ativo', "a associação mantém-se 'ativo'");
    // Nunca se acumulam titularidades (nem na 1.ª, nem na 2.ª passagem).
    assert.strictEqual(estado.titularidades.length, nTitularidadesAntes, `nenhuma titularidade duplicada (${rotulo})`);
  } finally {
    Module._load = origLoad2;
    if (cacheAnterior) require.cache[MODELS2] = cacheAnterior; else delete require.cache[MODELS2];
    if (seedAnterior) require.cache[require.resolve(path.join(RAIZ2, 'scripts', 'seed-demo.js'))] = seedAnterior;
    else delete require.cache[require.resolve(path.join(RAIZ2, 'scripts', 'seed-demo.js'))];
  }
}

correr().catch((err) => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
