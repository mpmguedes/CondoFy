// ═══════════════════════════════════════════════════════════════════
// Área financeira do condómino — execução REAL das rotas de leitura.
//
// Monta `routes/condomino.js` com duplos de base de dados (sem BD, sem rede) e
// pede as páginas por HTTP. Ao contrário dos testes que verificam a fonte ou
// renderizam só as vistas, este executa o corpo de cada handler — é a única
// forma de apanhar erros de execução (variáveis não declaradas, chamadas a
// helpers com forma errada) que quebram a página em produção com 500.
//
// Regressão coberta: `/condomino/quotas` rebentava com
// «ReferenceError: hoje is not defined» ao derivar o estado apresentado das
// quotas em dívida — as restantes páginas respondiam, o que fazia o erro passar
// despercebido em qualquer verificação que não executasse a rota.
//
// Utilização: node scripts/test-rotas-condomino.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');

// ── Dados de exemplo ───────────────────────────────────────────────
const SENHA_HASH = null;
const COND = { id: 1, designacao: 'Condomínio Exemplo', morada: 'Rua das Flores 1', codigo_postal: '1000-100', localidade: 'Lisboa', estado: 'ativo', documento_pastas: null };
const PESSOA = { id: 7, nome: 'Ana Teste', condominio_id: 1 };
const FRACAO_A = { id: 5, condominio_id: 1, designacao: '1.º Esq', permilagem: '125,00', toJSON() { return { ...this }; } };
const FRACAO_C = { id: 6, condominio_id: 1, designacao: '2.º Dto', permilagem: '95,00', toJSON() { return { ...this }; } };
const UTILIZADOR = { id: 42, nome: 'Ana Teste', email: 'ana@exemplo.pt', role: 'leitura', role_global: null, pessoa_id: 7, ativo: true, email_confirmado: true, two_fa_ativo: false, two_fa_email_tentativas: 0 };

// Fração como o `include` de Fracao a devolve (com toJSON).
function fracaoInst(f) {
  return { ...f, toJSON() { return { ...f }; } };
}

// Quotas: uma paga, uma em dívida (vencida sem pagamento), uma parcialmente paga.
const QUOTAS = [
  { id: 101, condominio_id: 1, fracao_id: 5, ano: 2026, mes: 7, valor: 75, valor_base: 75, valor_fcr: 0, data_vencimento: '2026-07-10', estado: 'paga', numero_documento: 'Q1' },
  { id: 102, condominio_id: 1, fracao_id: 5, ano: 2026, mes: 8, valor: 75, valor_base: 75, valor_fcr: 0, data_vencimento: '2026-08-10', estado: 'pendente', numero_documento: 'Q2' },
  { id: 103, condominio_id: 1, fracao_id: 5, ano: 2026, mes: 9, valor: 100, valor_base: 100, valor_fcr: 0, data_vencimento: '2026-09-10', estado: 'parcialmente_paga', numero_documento: 'Q3' },
  { id: 104, condominio_id: 1, fracao_id: 6, ano: 2026, mes: 9, valor: 42.5, valor_base: 42.5, valor_fcr: 0, data_vencimento: '2026-09-05', estado: 'pendente', numero_documento: 'Q4' },
  { id: 105, condominio_id: 1, fracao_id: 6, ano: 2026, mes: 5, valor: 42.5, valor_base: 42.5, valor_fcr: 0, data_vencimento: '2026-05-05', estado: 'anulada', numero_documento: 'Q5' },
];

// Aplicações de pagamento: repartidas por quota e estado do pagamento.
const APLICACOES = [
  { quota_id: 101, valor_aplicado: 75, pagamento: { id: 1, estado: 'confirmado', data_pagamento: '2026-07-05', referencia: 'TRF-1' } },
  { quota_id: 103, valor_aplicado: 50, pagamento: { id: 2, estado: 'confirmado', data_pagamento: '2026-09-01', referencia: 'TRF-2' } },
  { quota_id: 102, valor_aplicado: 75, pagamento: { id: 3, estado: 'anulado', data_pagamento: '2026-08-01', referencia: 'TRF-3' } },
];

const DOCUMENTOS = [
  { id: 11, condominio_id: 1, nome: 'Ata da assembleia.pdf', pasta: 'atas', tipo: 'ata', data: '2026-09-12', drive_file_id: 'F11', disponivel_condominos: true, toJSON() { return { ...this }; } },
  { id: 12, condominio_id: 1, nome: 'Convocatória.pdf', pasta: 'convocatorias', tipo: 'convocatoria', data: '2026-08-28', drive_file_id: 'F12', disponivel_condominos: true, toJSON() { return { ...this }; } },
];

const RECIBOS = [
  { id: 201, condominio_id: 1, fracao_id: 5, codigo: '2026/000201', data_emissao: '2026-09-20', valor: 75, estado: 'emitido', fracao: fracaoInst(FRACAO_A), quotas: [{ mes: 9, ano: 2026 }], parcelasExtra: [], toJSON() { return { id: this.id, codigo: this.codigo, data_emissao: this.data_emissao, valor: this.valor, estado: this.estado }; } },
  { id: 202, condominio_id: 1, fracao_id: 6, codigo: '2026/000202', data_emissao: '2026-08-20', valor: 42.5, estado: 'emitido', fracao: fracaoInst(FRACAO_C), quotas: [{ mes: 8, ano: 2026 }], parcelasExtra: [], toJSON() { return { id: this.id, codigo: this.codigo, data_emissao: this.data_emissao, valor: this.valor, estado: this.estado }; } },
];

const EXTRAS = [
  { id: 301, extra_quota_id: 1, fracao_id: 5, parcela_numero: 2, valor: 165, valor_pago: 0, data_vencimento: '2026-12-01', estado: 'cobrada', extra_quota: { id: 1, designacao: 'Impermeabilização', estado: 'processada' }, fracao: fracaoInst(FRACAO_A), toJSON() { return { id: this.id, fracao_id: this.fracao_id, parcela_numero: this.parcela_numero, valor: this.valor, valor_pago: this.valor_pago, data_vencimento: this.data_vencimento, estado: this.estado }; } },
];

function filtroSimples(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].includes(l[k]);
    if (v && typeof v === 'object' && v[Op.ne] !== undefined) return l[k] !== v[Op.ne];
    if (v && typeof v === 'object' && v[Op.gte] !== undefined) return String(l[k] || '') >= String(v[Op.gte]);
    if (v && typeof v === 'object' && v[Op.between]) return String(l[k] || '') >= v[Op.between][0] && String(l[k] || '') <= v[Op.between][1];
    return l[k] === v;
  }));
}

// ── Duplos dos modelos (antes de carregar a rota) ──────────────────
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    User: { findByPk: async () => UTILIZADOR, findOne: async () => UTILIZADOR },
    UserCondominio: { findAll: async () => [{ id: 1, utilizador_id: 42, condominio_id: 1, role: 'leitura', estado: 'ativo', condominio: COND }], findOne: async () => ({ id: 1, role: 'leitura', condominio_id: 1 }), update: async () => [0] },
    Condominio: { findByPk: async () => COND, findOne: async () => COND, findAll: async () => [COND] },
    Pessoa: { findOne: async () => PESSOA, findAll: async () => [PESSOA], count: async () => 8 },
    Fracao: { findAll: async () => [FRACAO_A, FRACAO_C], findOne: async () => FRACAO_A, count: async () => 2 },
    Quota: {
      findAll: async (o = {}) => filtroSimples(QUOTAS, o.where).map((q) => ({ ...q, fracao: fracaoInst(q.fracao_id === 5 ? FRACAO_A : FRACAO_C), toJSON() { const { fracao, ...resto } = this; return resto; } })),
      findOne: async () => null, sum: async () => 0, count: async () => QUOTAS.length,
    },
    Pagamento: { findAll: async () => [], findOne: async () => null, sum: async () => 0 },
    PagamentoQuota: { findAll: async () => APLICACOES },
    Recibo: {
      findAll: async () => RECIBOS,
      findOne: async () => RECIBOS[0],
      count: async () => RECIBOS.length,
    },
    ExtraQuotaParcela: { findAll: async () => EXTRAS },
    ExtraQuota: { findOne: async () => null, findAll: async () => [] },
    Aviso: { findAll: async () => [], count: async () => 3 },
    Documento: { findAll: async (o = {}) => filtroSimples(DOCUMENTOS, o.where), findOne: async () => DOCUMENTOS[0] },
    Assembleia: { findAll: async () => [] },
    Despesa: { findAll: async () => [], sum: async () => 0 },
    ContaBancaria: { findAll: async () => [] },
    Orcamento: { findOne: async () => null },
    AgendaItem: { findAll: async () => [] },
  },
};

// ── Duplos dos ajudantes que dependem de dados ─────────────────────
const stubs = {
  '../helpers/audit': { audit: async () => ({}), auditSafe: async () => ({}) },
  '../helpers/mailer': { sendMail: async () => ({ ok: true }) },
  '../helpers/saldos': {
    estadoEfetivo: (q) => (q && q.estado) || null,
    resumoFracao: async () => ({ totalQuotas: 292.5, totalPago: 125, emDivida: 167.5, quotasPagas: 1, quotasPendentes: 2, quotasVencidas: 1, ultimoPagamento: { valor: 50, data: '2026-09-01' } }),
    saldoConta: async () => 0,
    resumoCondominio: async () => ({ saldoContas: 1000, fundoReserva: 500, receitas: 2000, despesas: 1500, emDividaGlobal: 100, contas: [] }),
    resumoOrcamento: async (ano) => ({ ano: ano || 2026, orcamentado: 12000, executado: 8000, percentagem: 67 }),
    ESTADOS_PENDENTES: ['pendente', 'parcialmente_paga', 'vencida'],
  },
  '../helpers/titularidades': {
    fracoesDoUtilizador: async () => ({ fracoes: [{ fracao: FRACAO_A, vinculo: 'proprietario' }, { fracao: FRACAO_C, vinculo: 'proprietario' }], terminadas: [] }),
    historicoDaPessoa: async () => [],
    estaAtiva: () => true,
  },
  '../helpers/recibos': {
    pagoPorQuota: async () => new Map(),
    cobertoPorQuota: async () => new Map(),
    pagamentosDasQuotas: async () => [],
    periodoLabel: () => 'Setembro 2026',
    gerarReciboPDF: async () => Buffer.from('pdf'),
  },
  '../helpers/pdf': { gerarReciboPDF: async () => Buffer.from('pdf') },
  '../helpers/documentos-acesso': {
    autorizarAcessoDocumento: async () => ({ ok: false, estado: 404 }),
    servirDocumento: async ({ res }) => { res.status(200).send('ficheiro'); return { ok: true }; },
    verificarDocumento: async () => ({ ok: true }),
    responderRecusa: (res, r) => res.status((r && r.estado) || 404).send('recusado'),
  },
  '../helpers/storage': { rotuloPrincipal: () => 'Google Drive', abrePastaNoFornecedor: () => true, iconePrincipal: () => 'cloud' },
  '../helpers/seguranca': { createLimiter: () => (req, res, next) => next() },
  '../helpers/doisfatores': { verificarTOTP: () => false, consumirRecovery: () => null, hashCodigo: () => 'x', gerarSegredoTOTP: () => 'S', totpParaContador: () => '000000', uriTOTP: () => 'x', gerarCodigosRecuperacao: () => [] },
  '../helpers/convites': { estadoDoConvite: () => 'enviado', marcarAceite: async () => ({}) },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}
require(path.join(RAIZ, 'config/passport'))(passport);

// ── Aplicação de teste (rotas REAIS, montadas como no app.js) ──────
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
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Sessão de condómino simulada.
app.use((req, res, next) => {
  req.user = UTILIZADOR;
  req.session.condominio_ativo_id = 1;
  next();
});

app.use((req, res, next) => {
  res.locals.success_msg = [];
  res.locals.error_msg = [];
  res.locals.error = [];
  res.locals.user = UTILIZADOR;
  res.locals.isAdmin = false;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = { id: 1, designacao: COND.designacao, role: 'leitura' };
  res.locals.condominio = COND;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = 2026;
  res.locals.currentPath = req.path || '';
  res.locals.tarefas = { ativas: 0, emErro: 0 };
  res.locals.avisosRecentes = 0;
  res.locals.sessaoExpiraEm = Date.now() + 3600000;
  res.locals.sessaoAvisoMs = 120000;
  res.locals.sessaoIdleMs = 1800000;
  next();
});

app.get('/sessao/estado', (req, res) => res.json({ autenticado: true, expirada: false }));
app.use('/condomino', require('../routes/condomino'));
app.use((err, req, res, next) => {
  // Um erro inesperado num handler é exatamente o que este teste procura.
  res.status(500).send('ERRO_NO_HANDLER: ' + err.message);
});

// ── Cliente HTTP ───────────────────────────────────────────────────
function pedir(caminho) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      http.get({ host: '127.0.0.1', port: servidor.address().port, path: caminho }, (res) => {
        let corpo = '';
        res.on('data', (d) => { corpo += d; });
        res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, html: corpo }); });
      }).on('error', (e) => { servidor.close(); reject(e); });
    });
  });
}

// Páginas de leitura da área financeira e de documentos.
const PAGINAS = [
  ['/condomino/quotas', 'As minhas quotas'],
  ['/condomino/quotas?ano=2026', 'As minhas quotas (ano filtrado)'],
  ['/condomino/quotas?estado=vencida', 'As minhas quotas (filtro por estado)'],
  ['/condomino/pagamentos', 'Os meus pagamentos'],
  ['/condomino/recibos', 'Os meus recibos'],
  ['/condomino/documentos', 'Documentos'],
  ['/condomino/documentos?pasta=atas', 'Documentos (por categoria)'],
  ['/condomino/documentos?ano=2026', 'Documentos (por ano)'],
  ['/condomino/situacao', 'Situação financeira'],
  ['/condomino/orcamento', 'Orçamento'],
  ['/condomino', 'Início'],
];

(async () => {
  // 1. Todas as páginas de leitura executam sem erro de runtime.
  for (const [caminho, nome] of PAGINAS) {
    const r = await pedir(caminho);
    assert.strictEqual(r.status, 200, `${nome} (${caminho}) responde 200 — recebido ${r.status}`);
    assert.ok(!/ERRO_NO_HANDLER/.test(r.html), `${nome}: o handler não lança exceção`);
    assert.ok(!/ReferenceError|is not defined/.test(r.html), `${nome}: sem erros de referência`);
  }

  // 2. Regressão específica: a derivação do estado das quotas em dívida corre.
  const quotas = await pedir('/condomino/quotas');
  assert.ok(/As minhas quotas/.test(quotas.html), 'quotas: página renderizada');
  assert.ok(/portal-hero/.test(quotas.html), 'quotas: resumo por fração presente');
  assert.ok(/Parcialmente paga/.test(quotas.html), 'quotas: a quota paga em parte é apresentada como parcial');
  assert.ok(/Vencida/.test(quotas.html) || /em atraso/.test(quotas.html), 'quotas: as quotas em dívida são assinaladas');
  assert.ok(/Anulada/.test(quotas.html), 'quotas: a quota anulada não vira pendente');

  // 3. Várias frações: um resumo por fração, com a respetiva designação.
  assert.strictEqual((quotas.html.match(/portal-hero-valor/g) || []).length, 2,
    'quotas: um cartão de resumo por fração');
  assert.ok(/1\.º Esq/.test(quotas.html) && /2\.º Dto/.test(quotas.html),
    'quotas: as duas frações identificadas');

  // 4. Filtros não rebentam e devolvem a mesma página.
  const porEstado = await pedir('/condomino/quotas?estado=paga');
  assert.strictEqual(porEstado.status, 200, 'quotas: filtro por estado responde 200');

  // 5. A correção não pode voltar a depender de uma variável inexistente.
  const fonte = fs.readFileSync(path.join(RAIZ, 'routes', 'condomino.js'), 'utf8');
  const rotaQuotas = fonte.slice(fonte.indexOf("router.get('/quotas'"), fonte.indexOf("router.get('/pagamentos'"));
  assert.ok(/const hoje = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/.test(rotaQuotas),
    'quotas: `hoje` é declarado no handler da rota (regressão do ReferenceError)');
  assert.ok(!/router\.post|\.create\(|\.update\(|\.destroy\(/.test(rotaQuotas),
    'quotas: a rota continua só de leitura');

  console.log('✓ Testes das rotas do condómino passaram (execução real dos handlers, sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
