// ═══════════════════════════════════════════════════════════════════
// Numeração do RECIBO (série `recibo_mensal`, código RCP-ANO-NNNN) — regressão.
//
// Mesma classe de defeito da série dos PAGAMENTOS (`helpers/numeracao.js`):
// `recibos.codigo` é UNIQUE e o código nunca é reutilizado, mas
// `proximoReciboNumero` confiava cegamente na `sequencia` de `numeracoes`.
// Se a série ficar ATRASADA em relação aos códigos já gravados (importação,
// restauro de backup, alinhamento manual), o gerador devolveria para sempre um
// código ocupado, o `create` falhava com ER_DUP_ENTRY e — porque o incremento
// vive dentro da transação — o `rollback` desfazia-o: a emissão de recibos
// ficava PERMANENTEMENTE bloqueada.
//
// O que se prova: com a verificação de código livre, a série recupera sozinha,
// os códigos nunca se repetem (incluindo os de recibos ANULADOS) e a verificação
// corre dentro da transação (sem TOCTOU entre pedidos concorrentes).
//
// Utilização: node scripts/test-recibos-numeracao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents } = require('../helpers/money');

// ── Estado em memória (faz de MySQL) ────────────────────────────────
let seq = { numeracao: 0, recibo: 0, reciboExtra: 0 };
let db = {};

// Registo das consultas do predicado: prova que a verificação de código livre
// corre DENTRO da transação da emissão.
let registoFindOne = [];

// Uma falha forçada no `create` da cobertura (para provar a atomicidade).
let falharProximaCobertura = false;

const maiorId = (linhas) => (linhas || []).reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);

function reiniciar(estado) {
  db = {
    numeracoes: [],
    recibos: [],
    reciboExtraParcelas: [],
    extraParcelas: [],
    extraQuotas: [],
    ...estado,
  };
  seq = {
    numeracao: maiorId(db.numeracoes),
    recibo: maiorId(db.recibos),
    reciboExtra: maiorId(db.reciboExtraParcelas),
  };
  registoFindOne = [];
  falharProximaCobertura = false;
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
    return false;
  }
  return String(valor) === String(esperado);
}

const onde = (linhas, filtro) =>
  (linhas || []).filter((l) => Object.entries(filtro || {}).every(([k, v]) => casa(l[k], v)));

const comMetodos = (obj) =>
  obj && Object.assign(Object.create({ update: async (v) => Object.assign(obj, v) }), obj);

// ── Transação com rollback REAL sobre o estado em memória ───────────
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
      const n = { id: (seq.numeracao += 1), sequencia: 0, formato: 'RCP-{ano}-{sequencia}', ...dados };
      db.numeracoes.push(n);
      return comMetodos(n);
    },
    update: async (dados, { where } = {}) => {
      const alvos = onde(db.numeracoes, where);
      alvos.forEach((n) => Object.assign(n, dados));
      return [alvos.length];
    },
  },
  Recibo: {
    // A UNIQUE real: `codigo` duplicado → ER_DUP_ENTRY.
    create: async (dados) => {
      const codigo = dados.codigo;
      if (codigo && db.recibos.some((r) => r.codigo === codigo)) {
        const e = new Error('codigo must be unique');
        e.name = 'SequelizeUniqueConstraintError';
        e.errors = [{ message: 'codigo must be unique', path: 'codigo' }];
        e.parent = { code: 'ER_DUP_ENTRY', errno: 1062, sqlMessage: `Duplicate entry '${codigo}' for key 'codigo'` };
        throw e;
      }
      const r = { id: (seq.recibo += 1), estado: 'emitido', ...dados };
      db.recibos.push(r);
      return comMetodos(r);
    },
    findOne: async ({ where, transaction } = {}) => {
      if (where && where.codigo) registoFindOne.push({ where, transaction });
      return comMetodos(onde(db.recibos, where)[0]) || null;
    },
    findByPk: async (id) => comMetodos(db.recibos.find((r) => Number(r.id) === Number(id))) || null,
  },
  ReciboExtraParcela: {
    findAll: async () => [], // sem cobertura prévia: o mês está todo por emitir
    create: async (dados) => {
      if (falharProximaCobertura) {
        falharProximaCobertura = false;
        throw new Error('falha simulada ao gravar a cobertura');
      }
      const c = { id: (seq.reciboExtra += 1), ...dados };
      db.reciboExtraParcelas.push(c);
      return c;
    },
  },
  ExtraQuotaParcela: {
    findByPk: async (id) => comMetodos(db.extraParcelas.find((p) => Number(p.id) === Number(id))) || null,
  },
  ExtraQuota: {
    findOne: async ({ where } = {}) => comMetodos(onde(db.extraQuotas, where)[0]) || null,
  },
  // Não usados neste teste, mas exigidos pelo `require` do módulo.
  Quota: {}, ReciboQuota: {}, PagamentoExtraParcela: {}, Pagamento: {}, PagamentoQuota: {},
  MetodoPagamento: {}, Fracao: {},
};

const stub = (rel, valor) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
};

stub('models', modelos);
stub('models/index.js', modelos);
stub('config/database.js', { transaction: async () => novaTransacao(), Sequelize: {}, Op });

// ⚠️ Só DEPOIS dos stubs: `helpers/recibos.js` carrega `config/database` e
// `models` no topo — exigi-lo antes daqui ligava a BD real.
const { emitirReciboParcela, formatarCodigo } = require('../helpers/recibos');

// ── Cenário análogo ao de produção ──────────────────────────────────
// A série está em 2 (atrasada) e os códigos 0003 e 0004 JÁ pertencem a recibos
// gravados: sem verificação, o gerador devolveria 0003 e a emissão rebentava.
const RECIBOS_EXISTENTES = [
  { id: 1, condominio_id: 1, codigo: 'RCP-2026-0001', numero: '0001', ano: 2026, estado: 'emitido' },
  { id: 2, condominio_id: 1, codigo: 'RCP-2026-0002', numero: '0002', ano: 2026, estado: 'emitido' },
  { id: 3, condominio_id: 1, codigo: 'RCP-2026-0003', numero: '0003', ano: 2026, estado: 'emitido' },
  { id: 4, condominio_id: 1, codigo: 'RCP-2026-0004', numero: '0004', ano: 2026, estado: 'emitido' },
];

const cenarioDeProducao = () => ({
  numeracoes: [{ id: 1, tipo_documento: 'recibo_mensal', ano: 2026, sequencia: 2, formato: 'RCP-{ano}-{sequencia}' }],
  recibos: RECIBOS_EXISTENTES.map((r) => ({ ...r })),
  extraQuotas: [{ id: 3, condominio_id: 1, designacao: 'Obras', estado: 'processada' }],
  extraParcelas: [
    { id: 21, extra_quota_id: 3, fracao_id: 1, parcela_numero: 1, valor: '120.00', estado: 'paga' },
    { id: 22, extra_quota_id: 3, fracao_id: 1, parcela_numero: 2, valor: '80.00', estado: 'paga' },
  ],
});

const sequencia = (ano = 2026) => {
  const n = db.numeracoes.find((x) => x.tipo_documento === 'recibo_mensal' && x.ano === ano);
  return n ? n.sequencia : null;
};

const emitir = (parcelaId) =>
  emitirReciboParcela({ parcelaId, condominioId: 1, userId: 7, ano: 2026 });

// ── 1. O estado de produção é reproduzível: o código ocupado seria reatribuído ──
function testeEstadoDeProducao() {
  reiniciar(cenarioDeProducao());

  // Réplica da lógica ANTIGA (`sequencia + 1`, sem verificação), com o
  // formatador real: é este o código que o gerador devolveria.
  const ingenuo = formatarCodigo(2026, sequencia() + 1);
  assert.strictEqual(ingenuo, 'RCP-2026-0003', 'sem verificação o gerador devolve o código JÁ OCUPADO');
  assert.ok(
    db.recibos.some((r) => r.codigo === ingenuo),
    '…e esse código já existe em `recibos` — é a colisão'
  );

  console.log('  ✓ 1. o estado de produção é reproduzido (a série atrasada reatribuiria RCP-2026-0003)');
}

// ── 2. Uma emissão real usa o primeiro código livre ─────────────────
async function testeEmissaoUsaPrimeiroLivre() {
  reiniciar(cenarioDeProducao());

  const { recibo } = await emitir(21);
  assert.strictEqual(recibo.codigo, 'RCP-2026-0005', 'salta 0003–0004 e usa RCP-2026-0005');
  assert.strictEqual(recibo.numero, '0005', 'o número de 4 dígitos acompanha o código');
  assert.strictEqual(recibo.ano, 2026, 'o ano é o do recibo');
  assert.strictEqual(sequencia(), 5, 'a série avança para 5, coerente com os códigos gravados');

  // O recibo antigo conserva o seu código (não foi tocado).
  assert.strictEqual(db.recibos.find((r) => r.id === 3).codigo, 'RCP-2026-0003', 'o recibo original conserva 0003');

  console.log('  ✓ 2. a emissão usa o primeiro código livre (RCP-2026-0005)');
}

// ── 3. Duas emissões consecutivas ficam com códigos distintos ───────
async function testeDuasEmissoes() {
  reiniciar(cenarioDeProducao());

  const a = (await emitir(21)).recibo;
  const b = (await emitir(22)).recibo;

  assert.strictEqual(a.codigo, 'RCP-2026-0005', 'primeira emissão: 0005');
  assert.strictEqual(b.codigo, 'RCP-2026-0006', 'segunda emissão: 0006');
  assert.notStrictEqual(a.codigo, b.codigo, 'nenhum código repetido');
  assert.strictEqual(new Set(db.recibos.map((r) => r.codigo)).size, db.recibos.length, 'todos os códigos são únicos');
  assert.strictEqual(sequencia(), 6, 'a série fica no último código atribuído');

  console.log('  ✓ 3. duas emissões consecutivas ficam com códigos distintos');
}

// ── 4. Vários códigos ocupados seguidos: salta todos ────────────────
async function testeSaltosMultiplos() {
  reiniciar({
    ...cenarioDeProducao(),
    recibos: [
      ...RECIBOS_EXISTENTES.map((r) => ({ ...r })),
      { id: 5, condominio_id: 1, codigo: 'RCP-2026-0005', numero: '0005', ano: 2026, estado: 'emitido' },
      { id: 6, condominio_id: 1, codigo: 'RCP-2026-0006', numero: '0006', ano: 2026, estado: 'emitido' },
      { id: 7, condominio_id: 1, codigo: 'RCP-2026-0007', numero: '0007', ano: 2026, estado: 'emitido' },
    ],
  });

  const { recibo } = await emitir(21);
  assert.strictEqual(recibo.codigo, 'RCP-2026-0008', 'salta 0003–0007 e usa RCP-2026-0008');
  assert.strictEqual(sequencia(), 8, 'a sequência fica no último código atribuído');

  console.log('  ✓ 4. com vários códigos ocupados seguidos, salta para o primeiro livre');
}

// ── 5. O código de um recibo ANULADO não é reutilizado ──────────────
async function testeAnuladoNaoReutiliza() {
  reiniciar({
    ...cenarioDeProducao(),
    recibos: [
      ...RECIBOS_EXISTENTES.map((r) => ({ ...r })),
      { id: 5, condominio_id: 1, codigo: 'RCP-2026-0005', numero: '0005', ano: 2026, estado: 'anulado' },
    ],
  });

  // `anularRecibo` só muda o `estado` — o código fica gravado e ocupado.
  const { recibo } = await emitir(21);
  assert.strictEqual(recibo.codigo, 'RCP-2026-0006', 'o código de um recibo anulado NÃO é reutilizado');

  console.log('  ✓ 5. o código de um recibo anulado nunca é reutilizado');
}

// ── 6. Uma emissão falhada não consome o código nem prende a série ──
async function testeFalhaNaoPrende() {
  reiniciar(cenarioDeProducao());

  // Falha DEPOIS de o código ser obtido (na gravação da cobertura).
  falharProximaCobertura = true;
  let erro = null;
  try {
    await emitir(21);
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, 'a falha simulada é propagada');
  assert.strictEqual(db.recibos.length, RECIBOS_EXISTENTES.length, 'nenhum recibo gravado');
  assert.strictEqual(sequencia(), 2, 'a sequência não é consumida por uma emissão falhada (atomicidade)');

  // A emissão seguinte continua a funcionar — a série não fica presa.
  const { recibo } = await emitir(21);
  assert.strictEqual(recibo.codigo, 'RCP-2026-0005', 'a emissão seguinte obtém RCP-2026-0005 (não fica presa)');
  assert.strictEqual(sequencia(), 5, 'a série volta a avançar');

  console.log('  ✓ 6. uma emissão falhada não consome o código nem prende a série');
}

// ── 7. Retrocompatibilidade: sem códigos ocupados, sequência normal ──
async function testeRetrocompatibilidade() {
  reiniciar({
    numeracoes: [{ id: 1, tipo_documento: 'recibo_mensal', ano: 2026, sequencia: 2, formato: 'RCP-{ano}-{sequencia}' }],
    recibos: [
      { id: 1, condominio_id: 1, codigo: 'RCP-2026-0001', numero: '0001', ano: 2026, estado: 'emitido' },
      { id: 2, condominio_id: 1, codigo: 'RCP-2026-0002', numero: '0002', ano: 2026, estado: 'emitido' },
    ],
    extraQuotas: [{ id: 3, condominio_id: 1, designacao: 'Obras', estado: 'processada' }],
    extraParcelas: [{ id: 21, extra_quota_id: 3, fracao_id: 1, parcela_numero: 1, valor: '120.00', estado: 'paga' }],
  });

  const { recibo } = await emitir(21);
  assert.strictEqual(recibo.codigo, 'RCP-2026-0003', 'série alinhada → código seguinte é 0003 (comportamento anterior)');
  assert.strictEqual(sequencia(), 3, 'a série avança normalmente');

  console.log('  ✓ 7. com a série alinhada o gerador mantém exatamente o comportamento anterior');
}

// ── 8. A verificação corre DENTRO da transação (concorrência) ───────
async function testeVerificacaoDentroDaTransacao() {
  reiniciar(cenarioDeProducao());
  await emitir(21);

  const verificacoes = registoFindOne.filter((c) => c.where && c.where.codigo);
  assert.ok(verificacoes.length >= 1, 'a verificação consultou os códigos já usados');
  assert.ok(
    verificacoes.every((c) => c.transaction && c.transaction.LOCK && c.transaction.LOCK.UPDATE === 'update'),
    'o predicado tem de correr na MESMA transação da emissão (é o FOR UPDATE que serializa os concorrentes)'
  );
  assert.ok(
    verificacoes.every((c) => !('condominio_id' in c.where)),
    'a verificação do código livre é GLOBAL: `recibos.codigo` é UNIQUE sem condominio_id'
  );

  console.log('  ✓ 8. a verificação de código livre corre dentro da transação (sem TOCTOU)');
}

// ── 9. Estático: todos os pontos de emissão usam o gerador verificado ──
function testePontosDeEmissao() {
  const fonte = fs.readFileSync(path.join(RAIZ, 'helpers/recibos.js'), 'utf8');

  const chamadas = [...fonte.matchAll(/proximoReciboNumero\(/g)].length;
  // 1 definição + 5 chamadas nos fluxos de emissão.
  assert.strictEqual(chamadas, 6, `esperava a definição + 5 pontos de emissão; encontrei ${chamadas}`);

  assert.ok(
    /function codigoDeReciboJaUsado\(transaction\)/.test(fonte),
    'o predicado de código livre existe'
  );
  assert.ok(
    /while \(await jaUsado\(codigo\)\)/.test(fonte),
    'o gerador salta os códigos ocupados'
  );
  assert.ok(
    /Recibo\.findOne\(\{ where: \{ codigo \}, transaction \}\)/.test(fonte),
    'o predicado consulta o código DENTRO da transação'
  );

  console.log('  ✓ 9. a série dos recibos tem um único gerador, com verificação de código livre');
}

(async () => {
  console.log('Numeração do RECIBO (RCP) — regressão da série atrasada\n');
  testeEstadoDeProducao();
  await testeEmissaoUsaPrimeiroLivre();
  await testeDuasEmissoes();
  await testeSaltosMultiplos();
  await testeAnuladoNaoReutiliza();
  await testeFalhaNaoPrende();
  await testeRetrocompatibilidade();
  await testeVerificacaoDentroDaTransacao();
  testePontosDeEmissao();
  assert.strictEqual(transacoesAbertas, 0, 'nenhuma transação ficou aberta');
  console.log('\n✓ Testes da numeração do recibo passaram (sem base de dados).');
})().catch((e) => {
  console.error('\n✗ FALHA:', e.message);
  console.error(e.stack);
  process.exit(1);
});
