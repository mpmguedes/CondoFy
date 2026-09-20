// Execução orçamental no portal do condómino — sem base de dados.
// Utilização: node scripts/test-orcamento-portal-execucao.js
//
// PORQUÊ ESTE TESTE EXISTE
// A página `/condomino/orcamento` calculava o executado com um `Despesa.findAll`
// DENTRO do ciclo das rubricas, filtrando por `data` (não pela competência) e por
// `categoria_id: rubrica.categoria_id || null`. Consequências:
//   · uma despesa SEM categoria era somada uma vez por cada rubrica sem
//     categoria (duplicação → executado inflacionado);
//   · o ano era decidido por `data` e não por `competencia_ano` (divergia do
//     `resumoOrcamento` que alimenta a Situação financeira);
//   · N+1 consultas (uma por rubrica).
//
// Este teste fixa a regra nova: `competencia_ano` ESTRITO (sem fallback para
// `data`), cada despesa contabilizada UMA só vez, e o executado total a FECHAR
// com o executado único do condomínio.
//
// Método: o duplo de `Despesa` NÃO devolve o que lhe é pedido — imita a base de
// dados. Guarda as linhas reais de despesa, aplica o `where` (condominio_id,
// competencia_ano estrito, estado != anulada) e faz ele próprio o
// `SUM(valor) GROUP BY categoria_id`. Se a rota pedir mal, recebe mal.
const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');

// ── Dados reais de despesa (dois condomínios) ──────────────────────
// Valores em unidades, para as somas serem legíveis.
const DESPESAS = [
  // Condomínio 1 — o ativo.
  // Categoria 7 (Elevadores): 300 no exercício de 2026.
  { id: 1, condominio_id: 1, categoria_id: 7, valor: 300, data: '2026-03-10', competencia_ano: 2026, competencia_mes: 3, estado: 'registada' },
  // ⭐ COMPETÊNCIA: data em JANEIRO/2027 mas competência de 2026 → pertence a 2026.
  { id: 2, condominio_id: 1, categoria_id: 7, valor: 500, data: '2027-01-15', competencia_ano: 2026, competencia_mes: 12, estado: 'registada' },
  // ⭐ SEM COMPETÊNCIA: `competencia_ano` NULL e `data` em 2026 → NÃO entra em
  //    exercício nenhum (não pode cair silenciosamente num fallback para `data`).
  { id: 3, condominio_id: 1, categoria_id: 7, valor: 999, data: '2026-05-01', competencia_ano: null, competencia_mes: null, estado: 'registada' },
  // Categoria 8 (Limpezas): 200 em 2026.
  { id: 4, condominio_id: 1, categoria_id: 8, valor: 200, data: '2026-02-01', competencia_ano: 2026, competencia_mes: 2, estado: 'registada' },
  // SEM categoria (categoria_id NULL), 2026: 400 — a fonte da duplicação antiga.
  { id: 5, condominio_id: 1, categoria_id: null, valor: 400, data: '2026-06-01', competencia_ano: 2026, competencia_mes: 6, estado: 'registada' },
  // SEM categoria (categoria_id NULL), 2026: 100.
  { id: 6, condominio_id: 1, categoria_id: null, valor: 100, data: '2026-07-01', competencia_ano: 2026, competencia_mes: 7, estado: 'registada' },
  // ANULADA: 777 em 2026 — nunca entra.
  { id: 7, condominio_id: 1, categoria_id: 7, valor: 777, data: '2026-04-01', competencia_ano: 2026, competencia_mes: 4, estado: 'anulada' },
  // Categoria 9, 2026: 50 — categoria SEM rubrica no orçamento (não pode sumir).
  { id: 8, condominio_id: 1, categoria_id: 9, valor: 50, data: '2026-08-01', competencia_ano: 2026, competencia_mes: 8, estado: 'registada' },
  // Exercício vizinho (2025): 888 — não pode entrar em 2026.
  { id: 9, condominio_id: 1, categoria_id: 7, valor: 888, data: '2025-03-01', competencia_ano: 2025, competencia_mes: 3, estado: 'registada' },
  // OUTRO CONDOMÍNIO (2): 5000 em 2026 — jamais pode entrar no condomínio 1.
  { id: 10, condominio_id: 2, categoria_id: 7, valor: 5000, data: '2026-03-01', competencia_ano: 2026, competencia_mes: 3, estado: 'registada' },
  { id: 11, condominio_id: 2, categoria_id: null, valor: 1234, data: '2026-03-01', competencia_ano: 2026, competencia_mes: 3, estado: 'registada' },
];

// Totais esperados para o condomínio 1 / 2026 (calculados à mão):
//   Categoria 7: 300 (id1) + 500 (id2) = 800   [id3 é NULL comp, não entra; id7 anulada; id9 é 2025]
//   Categoria 8: 200
//   Sem categoria: 400 + 100 = 500
//   Categoria 9 (sem rubrica): 50
//   TOTAL EXECUTADO ÚNICO = 800 + 200 + 500 + 50 = 1550
const EXECUTADO_UNICO_COND1_2026 = 1550;
const CAT7_2026 = 800;
const CAT8_2026 = 200;
const SEM_CATEGORIA_2026 = 500;
const CAT9_SEM_RUBRICA_2026 = 50;

// ── Orçamento com rubricas (incluindo DUAS sem categoria) ──────────
const RUBRICAS = [
  { id: 101, orcamento_id: 1, categoria_id: 7, descricao: 'Elevadores', valor_anual: 1000, ativo: true, categoria: { id: 7, nome: 'Elevadores' } },
  { id: 102, orcamento_id: 1, categoria_id: 8, descricao: 'Limpezas', valor_anual: 500, ativo: true, categoria: { id: 8, nome: 'Limpezas' } },
  // Rubricas SEM categoria: mantêm o orçamento, executado tem de ser 0.
  { id: 103, orcamento_id: 1, categoria_id: null, descricao: 'Diversos A', valor_anual: 300, ativo: true, categoria: null },
  { id: 104, orcamento_id: 1, categoria_id: null, descricao: 'Diversos B', valor_anual: 200, ativo: true, categoria: null },
  { id: 105, orcamento_id: 1, categoria_id: 8, descricao: 'Inativa', valor_anual: 999, ativo: false, categoria: { id: 8, nome: 'Limpezas' } },
];

const MESMA_RUBRICA = (catId, descricao, valor, id) => ({
  id, orcamento_id: 1, categoria_id: catId, descricao, valor_anual: valor, ativo: true,
  categoria: catId === null ? null : { id: catId, nome: `Cat ${catId}` },
});

// ── Duplo de Despesa: IMITA a base de dados ────────────────────────
// Recebe a consulta REAL da rota e comporta-se como a BD: filtra pelo `where`
// (condominio_id, competencia_ano estrito, estado != anulada) e agrega por
// `categoria_id`, devolvendo `[{ categoria_id, total }]`.
let consultasDespesa = 0;
function despesaFindAll(opts = {}) {
  consultasDespesa += 1;
  const w = opts.where || {};
  const linhas = DESPESAS.filter((d) => {
    if (w.condominio_id !== undefined && Number(d.condominio_id) !== Number(w.condominio_id)) return false;
    // Competência ESTRITA: `competencia_ano = ano`. Uma linha com NULL NUNCA casa
    // com um número — é exatamente o que a BD real faz.
    if (w.competencia_ano !== undefined) {
      const exigido = w.competencia_ano;
      if (exigido && typeof exigido === 'object' && exigido[Op.ne] !== undefined) {
        if (d.competencia_ano !== null && Number(d.competencia_ano) === Number(exigido[Op.ne])) return false;
      } else if (d.competencia_ano === null || Number(d.competencia_ano) !== Number(exigido)) {
        return false;
      }
    }
    if (w.estado !== undefined) {
      if (w.estado && typeof w.estado === 'object' && w.estado[Op.ne] !== undefined) {
        if (d.estado === w.estado[Op.ne]) return false;
      } else if (d.estado !== w.estado) return false;
    }
    return true;
  });
  // Agregação por categoria_id (o que a rota pediu com GROUP BY).
  const porCat = new Map();
  for (const d of linhas) {
    const chave = d.categoria_id === null || d.categoria_id === undefined ? null : Number(d.categoria_id);
    porCat.set(chave, (porCat.get(chave) || 0) + Number(d.valor));
  }
  return [...porCat.entries()].map(([categoria_id, total]) => ({ categoria_id, total }));
}

// ── Um registo por consulta: prova quantas consultas a rota fez ────
function registoDeDespesas() {
  return {
    get consultas() { return consultasDespesa; },
    reset() { consultasDespesa = 0; },
  };
}

// ── Duplos dos modelos ─────────────────────────────────────────────
function orcamentoComRubricas(rubricas) {
  const rubricasInst = rubricas.map((r) => ({ ...r }));
  return {
    id: 1, condominio_id: 1, ano: 2026, estado: 'ativo', data_inicio: '2026-01-01', data_fim: '2026-12-31',
    rubricas: rubricasInst,
    toJSON() { return { ...this, rubricas: rubricasInst }; },
  };
}

function montarModelos(rubricas) {
  const ORC = orcamentoComRubricas(rubricas);
  return {
    User: { findByPk: async () => ({ id: 42, pessoa_id: 10, nome: 'Ana', email: 'a@ex.pt' }), findOne: async () => ({ id: 42, pessoa_id: 10 }) },
    UserCondominio: { findAll: async () => [{ id: 1, utilizador_id: 42, condominio_id: 1, role: 'leitura', estado: 'ativo' }], findOne: async () => ({ id: 1, role: 'leitura', condominio_id: 1 }), update: async () => [0] },
    Condominio: { findByPk: async () => ({ id: 1, designacao: 'Condomínio Exemplo' }), findOne: async () => ({ id: 1, designacao: 'Condomínio Exemplo' }), findAll: async () => [{ id: 1, designacao: 'Condomínio Exemplo' }] },
    Pessoa: { findOne: async () => ({ id: 10, nome: 'Ana', email: 'a@ex.pt' }), findAll: async () => [], count: async () => 1 },
    Fracao: { findAll: async () => [], findOne: async () => null, count: async () => 1 },
    Quota: { findAll: async () => [], findOne: async () => null, sum: async () => 0, count: async () => 0 },
    Pagamento: { findAll: async () => [], findOne: async () => null, sum: async () => 0 },
    PagamentoQuota: { findAll: async () => [] },
    PagamentoExtraParcela: { findAll: async () => [] },
    Recibo: { findAll: async () => [], findOne: async () => null, count: async () => 0 },
    ReciboQuota: { findAll: async () => [] },
    ReciboExtraParcela: { findAll: async () => [] },
    ExtraQuotaParcela: { findAll: async () => [] },
    ExtraQuota: { findOne: async () => null, findAll: async () => [] },
    Aviso: { findAll: async () => [], count: async () => 0 },
    Documento: { findAll: async () => [], findOne: async () => null },
    Assembleia: { findAll: async () => [] },
    // O duplo IMITA a BD.
    Despesa: { findAll: despesaFindAll, sum: async () => 0 },
    ContaBancaria: { findAll: async () => [], count: async () => 0 },
    MovimentoBancario: { findAll: async () => [], sum: async () => 0, count: async () => 0 },
    Orcamento: { findOne: async (o = {}) => {
      const w = o.where || {};
      if (w.condominio_id !== undefined && Number(w.condominio_id) !== 1) return null;
      return ORC;
    }, findAll: async () => [ORC], count: async () => 1 },
    OrcamentoRubrica: { findAll: async () => rubricas, findOne: async () => rubricas[0], count: async () => rubricas.length },
    Categoria: { findAll: async () => [], findByPk: async () => null },
    AgendaItem: { findAll: async () => [] },
    RecomendacaoEstado: { findAll: async () => [], findOne: async () => null, create: async () => ({}), destroy: async () => 0 },
  };
}

// ── Duplos dos ajudantes ───────────────────────────────────────────
const stubs = {
  '../helpers/audit': { audit: async () => ({}), auditSafe: async () => ({}) },
  '../helpers/mailer': { sendMail: async () => ({ ok: true }) },
  '../helpers/saldos': {
    // `resumoOrcamento` NÃO é usado pelo handler de /orcamento, mas a rota
    // importa-o — o duplo fica coerente com o que a página mostra.
    resumoFinanceiro: async () => ({ ano: 2026, saldoContas: 0, receitasAno: 0, despesasAno: 0, saldoAno: 0, totalQuotas: 0, pagoQuotas: 0, emDivida: 0, cobrancaPct: 0, nFracoesEmAtraso: 0, nFracoes: 0, contas: [], fundoReserva: 0, contasPorMes: Array(12).fill(0), despesasPorMes: Array(12).fill(0) }),
    evolucaoMensal: () => ({ meses: Array.from({ length: 12 }, (_, i) => ({ mes: i + 1, contas: 0, despesas: 0, saldo: 0, temMovimentos: false })), temMovimentos: false, mesesComMovimentos: 0, totalContas: 0, totalDespesas: 0 }),
    estadoEfetivo: (q) => (q && q.estado) || null,
    saldoConta: async () => 0,
    resumoFracao: async () => ({ totalQuotas: 0, totalPago: 0, emDivida: 0, quotasPagas: 0, quotasPendentes: 0, quotasVencidas: 0, ultimoPagamento: null }),
    resumoCondominio: async () => ({ saldoContas: 0, fundoReserva: 0, receitas: 0, despesas: 0, emDividaGlobal: 0, contas: [] }),
    // Devolve o executado pela MESMA regra do portal (para o invariante de fecho).
    resumoOrcamento: async (ano, condominioId) => {
      const linhas = despesaFindAll({ where: { condominio_id: condominioId || 1, competencia_ano: Number(ano) || 2026, estado: { [require('sequelize').Op.ne]: 'anulada' } } });
      const executado = linhas.reduce((s, l) => s + (Number(l.total) || 0), 0);
      return { ano: Number(ano) || 2026, orcamentado: 0, executado, percentagem: 0 };
    },
    ESTADOS_PENDENTES: ['pendente', 'parcialmente_paga', 'vencida'],
  },
  '../helpers/conta-corrente': {
    contaCorrenteFracao: async () => ({ saldo: 0, saldoC: 0, emDivida: false, temCredito: false, quotasEmDivida: 0, extrasEmDivida: 0, extrato: [], anos: [2026] }),
    anosContaCorrente: async () => [2026],
    listaFracoes: async () => [],
  },
  '../helpers/titularidades': {
    fracoesDoUtilizador: async () => ({ fracoes: [], terminadas: [] }),
    historicoDaPessoa: async () => [],
    estaAtiva: () => true,
  },
  '../helpers/condominio': { getCondominio: async () => ({ id: 1, designacao: 'Condomínio Exemplo' }) },
  '../helpers/pdf': { gerarReciboPDF: async () => Buffer.from('pdf') },
  '../helpers/cabecalhos-ficheiro': { periodoLabel: () => 'Setembro 2026' },
  '../helpers/recibos': { gerarReciboPDF: async () => Buffer.from('pdf') },
  '../helpers/documento-pastas': { mapaPastas: () => ({}) },
  '../helpers/recomendacoes': { recomendacoesDoPortal: async () => [] },
  '../helpers/documentos-acesso': {
    autorizarAcessoDocumento: async () => ({ ok: false, estado: 404 }),
    servirDocumento: async ({ res }) => { res.status(200).send('f'); return { ok: true }; },
    verificarDocumento: async () => ({ ok: true }),
    responderRecusa: (res, r) => res.status((r && r.estado) || 404).send('recusado'),
  },
  '../helpers/storage': { rotuloPrincipal: () => 'Google Drive', abrePastaNoFornecedor: () => true, iconePrincipal: () => 'cloud' },
  '../helpers/seguranca': { createLimiter: () => (req, res, next) => next() },
  '../helpers/eAdmin': { eAutenticado: (req, res, next) => next() },
  '../helpers/tenant': {
    comCondominioAtivo: (req, res, next) => { req.condominioId = 1; next(); },
    semSuporte: (req, res, next) => next(),
    pertenceAoAtivo: () => true,
    entrarCondominio: async () => ({ ok: true }),
  },
};

// ── Aplicação de teste (rota REAL) ─────────────────────────────────
// `captura` (opcional) é preenchida com `{ vista, ctx }` sempre que a vista do
// orçamento for renderizada — permite provar o OBJETO entregue, não o HTML.
function construirApp(rubricas, captura) {
  const modelsPath = require.resolve('../models');
  require.cache[modelsPath] = {
    id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
    exports: montarModelos(rubricas),
  };
  for (const [rel, valor] of Object.entries(stubs)) {
    const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
    require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
  }
  // Limpa a rota para apanhar sempre os duplos frescos.
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('routes\\condomino.js') || k.endsWith('routes/condomino.js')) delete require.cache[k];
  }

  const app = express();
  const { engine } = require('express-handlebars');
  app.engine('handlebars', engine({
    defaultLayout: 'main',
    helpers: require('../helpers/handlebars-helpers'),
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use(session({ secret: 'teste', resave: false, saveUninitialized: false, rolling: false }));
  app.use(express.urlencoded({ extended: true }));
  app.use(flash());
  app.use((req, res, next) => {
    req.user = { id: 42, pessoa_id: 10, nome: 'Ana' };
    req.isAuthenticated = () => true;
    req.session.condominio_ativo_id = 1;
    next();
  });
  app.use((req, res, next) => {
    res.locals.success_msg = []; res.locals.error_msg = []; res.locals.error = [];
    res.locals.user = { id: 42, nome: 'Ana' }; res.locals.isAdmin = false;
    res.locals.meusCondominios = [];
    res.locals.condominioAtivo = { id: 1, designacao: 'Condomínio Exemplo', role: 'leitura' };
    res.locals.condominio = { id: 1, designacao: 'Condomínio Exemplo' };
    res.locals.appName = 'GesCondu'; res.locals.currentYear = 2026; res.locals.currentPath = req.path || '';
    res.locals.tarefas = { ativas: 0, emErro: 0 }; res.locals.avisosRecentes = 0;
    res.locals.sessaoExpiraEm = Date.now() + 3600000; res.locals.sessaoAvisoMs = 120000; res.locals.sessaoIdleMs = 1800000;
    next();
  });
  // Intercepta o render ANTES do router (para capturar o contexto e não
  // depender do HTML da vista).
  if (captura) {
    app.use((req, res, next) => {
      res.render = (vista, ctx) => {
        if (vista === 'condomino/orcamento') { captura.vista = vista; captura.ctx = ctx; }
        res.status(200).send('ok');
      };
      next();
    });
  }
  app.use('/condomino', require('../routes/condomino'));
  return app;
}

function pedir(app, caminho) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, () => {
      const porta = servidor.address().port;
      require('http').get({ host: '127.0.0.1', port: porta, path: caminho }, (res) => {
        let corpo = '';
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, html: corpo }); });
      }).on('error', (e) => { servidor.close(); reject(e); });
    });
  });
}

// Extrai as linhas da tabela do orçamento a partir do HTML renderizado.
// A vista mostra: nome da rubrica | orçamentado | executado | %.
function extrairLinhas(html) {
  const linhas = [];
  // Cada linha da tabela tem uma célula de nome e células numéricas.
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const celulas = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (celulas.length === 0) continue;
    // Números no formato português: 1.234,56 ou 1234,56
    const nums = celulas.map((c) => {
      const v = c.match(/(-?\d[\d.]*\d|\d)(,\d{1,2})?/);
      return v ? Number(v[0].replace(/\./g, '').replace(',', '.')) : null;
    });
    linhas.push({ celulas, nums });
  }
  return linhas;
}

// Lê o executado de uma rubrica pelo NOME (a célula onde o nome aparece).
function executadoPorNome(html, nome) {
  for (const l of extrairLinhas(html)) {
    if (l.celulas.some((c) => c === nome)) {
      // A vista do orçamento: [nome, orçamentado, executado, percentagem].
      const idx = l.celulas.findIndex((c) => c === nome);
      const apos = l.nums.slice(idx + 1).filter((n) => n !== null);
      if (apos.length >= 1) return { orcamentado: apos[0], executado: apos[1] !== undefined ? apos[1] : null };
    }
  }
  return null;
}

const resultados = [];
function titulo(t) { console.log(`\n── ${t}`); }
function ok(nome) { resultados.push(nome); console.log(`  ✓ ${nome}`); }

(async () => {
  console.log('\nExecução orçamental no portal do condómino (sem BD)');

  // Uma só consulta às despesas é medida por um contador global.
  const registo = registoDeDespesas();

  // ── A consulta devolve o objeto que a vista recebe ──────────────
  // Para não depender do formato exato do HTML, interceta-se o `res.render` e
  // prova-se o OBJETO (`linhas`, `totais`) entregue à vista.
  const captura = {};
  const app = construirApp(RUBRICAS, captura);

  const r = await pedir(app, '/condomino/orcamento');
  assert.strictEqual(r.status, 200, 'a página responde 200');
  assert.ok(captura.ctx, 'a vista do orçamento foi renderizada');

  const linhas = captura.ctx.linhas;
  const totais = captura.ctx.totais;

  // ── 1. Competência: 2027 por `data`, 2026 por competência ────────
  titulo('1. Competência (data em 2027, competencia_ano = 2026)');
  const elevadores = linhas.find((l) => l.nome === 'Elevadores');
  assert.ok(elevadores, 'a rubrica Elevadores existe');
  assert.strictEqual(elevadores.executado, CAT7_2026,
    `a despesa com data em 2027 e competência de 2026 conta em 2026 (esperado ${CAT7_2026})`);
  ok(`Elevadores/2026 executado = ${elevadores.executado} (inclui a de data 2027)`);
  {
    // E não aparece em 2027.
    const captura2027 = {};
    const app2027 = construirApp(RUBRICAS, captura2027);
    await pedir(app2027, '/condomino/orcamento?ano=2027');
    const lin2027 = (captura2027.ctx && captura2027.ctx.linhas) || [];
    const exec2027 = lin2027.reduce((s, l) => s + (Number(l.executado) || 0), 0);
    assert.strictEqual(exec2027, 0, 'em 2027 não há execução (a despesa pertence a 2026)');
    ok('em 2027 o executado é 0 — a competência manda, não a data');
  }

  // ── 2. Dupla contagem: despesas sem categoria ───────────────────
  titulo('2. Dupla contagem (2 rubricas com categoria_id = NULL)');
  const semCat = linhas.filter((l) => l.nome === 'Sem categoria');
  assert.strictEqual(semCat.length, 1, 'há UMA só linha «Sem categoria» (não uma por rubrica)');
  assert.strictEqual(semCat[0].executado, SEM_CATEGORIA_2026,
    `as despesas sem categoria aparecem uma única vez (esperado ${SEM_CATEGORIA_2026})`);
  ok(`«Sem categoria» = ${semCat[0].executado} (uma só vez)`);

  // ── 3. Independência do número de rubricas NULL ─────────────────
  titulo('3. Independência do n.º de rubricas sem categoria');
  {
    const com3 = RUBRICAS.concat([MESMA_RUBRICA(null, 'Diversos C', 111, 106)]);
    const capturaC = {};
    const appC = construirApp(com3, capturaC);
    await pedir(appC, '/condomino/orcamento');
    const execC = capturaC.ctx.totais.executado;
    assert.strictEqual(execC, totais.executado,
      `passar de 2 para 3 rubricas NULL não altera o executado (era ${totais.executado}, ficou ${execC})`);
    ok(`2 → 3 rubricas NULL: executado inalterado (${execC})`);
  }

  // ── 4. Fecho: Σ linhas.executado === executado único ────────────
  titulo('4. Fecho (Σ linhas.executado === executado único do condomínio)');
  const soma = linhas.reduce((s, l) => s + (Number(l.executado) || 0), 0);
  assert.strictEqual(totais.executado, EXECUTADO_UNICO_COND1_2026,
    `executado total = executado único do condomínio (esperado ${EXECUTADO_UNICO_COND1_2026})`);
  assert.strictEqual(soma, totais.executado, 'a soma das linhas fecha com o total apresentado');
  ok(`Σ linhas (${soma}) === totais.executado (${totais.executado})`);

  // ── 5. Rubricas NULL: presentes, orçamento intacto, executado 0 ──
  titulo('5. Rubricas com categoria_id = NULL');
  const rubNullA = linhas.find((l) => l.nome === 'Diversos A');
  assert.ok(rubNullA, 'a rubrica sem categoria continua presente');
  assert.strictEqual(rubNullA.orcamentado, 300, 'mantém o orçamento (300)');
  assert.strictEqual(rubNullA.executado, 0, 'o executado da rubrica sem categoria é 0');
  ok('rubrica NULL: presente, orçamento 300 intacto, executado 0');

  // ── 6. Categoria normal: atribuída uma única vez ────────────────
  titulo('6. Categoria normal (Limpezas)');
  const limpezas = linhas.find((l) => l.nome === 'Limpezas');
  assert.strictEqual(limpezas.executado, CAT8_2026, `Limpezas = ${CAT8_2026} (uma só vez)`);
  ok(`Limpezas = ${limpezas.executado} (atribuída uma só vez)`);

  // ── 7. Anuladas não entram ──────────────────────────────────────
  titulo('7. Despesas anuladas');
  assert.ok(!linhas.some((l) => Number(l.executado) === 777), 'a despesa anulada (777) não entra em nenhuma linha');
  ok('a despesa anulada (777) não entra no executado');

  // ── 8. Isolamento por condomínio ────────────────────────────────
  titulo('8. Isolamento por condomínio');
  // O condomínio 2 tem 5000 (cat 7) + 1234 (sem categoria) em 2026. Se
  // entrassem, Elevadores teria 800+5000 e «Sem categoria» 500+1234.
  assert.strictEqual(elevadores.executado, CAT7_2026, 'as despesas do condomínio 2 não entram em Elevadores');
  assert.strictEqual(semCat[0].executado, SEM_CATEGORIA_2026, 'as despesas do condomínio 2 não entram em «Sem categoria»');
  ok('despesas do condomínio 2 nunca entram (isolamento provado)');

  // ── 9. Categoria sem rubrica não desaparece ─────────────────────
  titulo('9. Categoria sem rubrica no orçamento (não pode sumir)');
  const outras = linhas.find((l) => l.nome === 'Outras categorias');
  assert.ok(outras, 'a despesa de uma categoria sem rubrica aparece (linha «Outras categorias»)');
  assert.strictEqual(outras.executado, CAT9_SEM_RUBRICA_2026, `Outras categorias = ${CAT9_SEM_RUBRICA_2026}`);
  ok(`categoria 9 (sem rubrica) = ${outras.executado} — não desaparece`);

  // ── 10. SEM COMPETÊNCIA: não entra em exercício nenhum ──────────
  titulo('10. competencia_ano = NULL (não pode cair num fallback para data)');
  // A despesa id3 (999, cat 7, data 2026-05-01, competencia NULL) NÃO pode
  // aparecer em 2026 (nem em lado nenhum). Se caísse em `data`, Elevadores
  // seria 800+999=1799.
  assert.strictEqual(elevadores.executado, CAT7_2026,
    'a despesa sem competência (999) NÃO entra em 2026 — não há fallback para `data`');
  assert.strictEqual(totais.executado, EXECUTADO_UNICO_COND1_2026, 'o total exclui as despesas sem competência');
  // Prova explícita do caso negativo: se 999 tivesse entrado, o total seria 2549.
  assert.notStrictEqual(totais.executado, EXECUTADO_UNICO_COND1_2026 + 999,
    'o total NÃO inclui a despesa sem competência (o fallback para `data` está desligado)');
  ok('despesa sem competência (999) fica fora do exercício (sem fallback para data)');

  // ── 11. Uma só consulta às despesas (fim do N+1) ────────────────
  titulo('11. Uma única consulta às despesas (sem N+1)');
  registo.reset();
  const app2 = construirApp(RUBRICAS, {});
  await pedir(app2, '/condomino/orcamento');
  assert.strictEqual(registo.consultas, 1,
    `a página faz UMA consulta às despesas, não uma por rubrica (fez ${registo.consultas})`);
  ok('1 consulta às despesas (antes: 1 por rubrica ativa)');

  console.log(`\n✓ Execução orçamental do portal: ${resultados.length} verificações passaram (sem BD).`);
})().catch((e) => {
  console.error(`\n✗ FALHA: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
