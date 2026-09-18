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

// Contas bancárias e orçamento do condomínio (duplos dos modelos usados pelas
// consultas dos ajudantes substituídos neste teste).
const CONTAS = [
  { id: 1, condominio_id: 1, nome: 'Conta principal', banco: 'Banco Exemplo', iban: 'PT50 0002 0123 1234 5678 9015 4', tipo: 'corrente', saldo_inicial: 1000, ativa: true, toJSON() { return { ...this }; } },
  { id: 2, condominio_id: 1, nome: 'Fundo de reserva', banco: 'Banco Exemplo', iban: null, tipo: 'fundo_reserva', saldo_inicial: 500, ativa: true, toJSON() { return { ...this }; } },
];
const ORCAMENTO = {
  id: 1, condominio_id: 1, ano: 2026, designacao: 'Orçamento 2026', estado: 'em_execucao',
  data_inicio: '2026-01-01', data_fim: '2026-12-31',
  rubricas: [
    { id: 1, orcamento_id: 1, descricao: 'Eletricidade', valor_anual: 4200, ativo: true },
    { id: 2, orcamento_id: 1, descricao: 'Limpeza', valor_anual: 6600, ativo: true },
  ],
  toJSON() { return { ...this }; },
};

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

// Saldos por quota (em cêntimos) — coerentes com APLICACOES: 102 tem um
// pagamento ANULADO (não conta) e 103 está paga em parte.
const PAGO_POR_QUOTA = new Map([[101, 7500], [103, 5000]]);
// Valor transitado por fração (conta-corrente).
const TRANSITADO = new Map([[5, 0], [6, 0]]);

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
    Pagamento: {
      // A listagem de pagamentos (com `include`) continua vazia, como antes. A
      // situação financeira pede só valor + data (raw) — é aqui que os
      // pagamentos confirmados do exemplo entram no resumo e no mês.
      findAll: async (o = {}) => {
        const attrs = Array.isArray(o.attributes) ? o.attributes : [];
        if (!attrs.includes('data_pagamento')) return [];
        const linhas = APLICACOES.filter((a) => a.pagamento.estado === 'confirmado')
          .map((a) => ({ valor: a.valor_aplicado / 100, data_pagamento: a.pagamento.data_pagamento, estado: 'confirmado', condominio_id: 1 }));
        return filtroSimples(linhas, o.where);
      },
      findOne: async () => null,
      sum: async () => 0,
    },
    PagamentoQuota: { findAll: async () => APLICACOES },
    PagamentoExtraParcela: { findAll: async () => [] },
    Recibo: {
      findAll: async () => RECIBOS,
      findOne: async () => RECIBOS[0],
      count: async () => RECIBOS.length,
    },
    ReciboQuota: { findAll: async () => [] },
    ReciboExtraParcela: { findAll: async () => [] },
    ExtraQuotaParcela: { findAll: async () => EXTRAS },
    ExtraQuota: { findOne: async () => null, findAll: async () => [] },
    Aviso: { findAll: async () => [], count: async () => 3 },
    Documento: { findAll: async (o = {}) => filtroSimples(DOCUMENTOS, o.where), findOne: async () => DOCUMENTOS[0] },
    Assembleia: { findAll: async () => [] },
    Despesa: { findAll: async () => [], sum: async () => 0 },
    ContaBancaria: { findAll: async (o = {}) => filtroSimples(CONTAS, o.where), count: async () => CONTAS.length },
    MovimentoBancario: { findAll: async () => [], sum: async () => 0, count: async () => 0 },
    Orcamento: { findOne: async () => ORCAMENTO, findAll: async () => [ORCAMENTO], count: async () => 1 },
    OrcamentoRubrica: { findAll: async () => ORCAMENTO.rubricas, findOne: async () => ORCAMENTO.rubricas[0], count: async () => ORCAMENTO.rubricas.length },
    Categoria: { findAll: async () => [], findByPk: async () => null },
    AgendaItem: { findAll: async () => [] },
    // Recomendações contextuais (Fase 2G): o Início lê o estado de dispensa da
    // conta. O comportamento a sério (dispensar → esconder → reaparecer) é
    // testado em scripts/test-rotas-recomendacoes.js.
    RecomendacaoEstado: { findAll: async () => [], findOne: async () => null, create: async () => ({}), destroy: async () => 0 },
  },
};

// ── Duplos dos ajudantes que dependem de dados ─────────────────────
const stubs = {
  '../helpers/audit': { audit: async () => ({}), auditSafe: async () => ({}) },
  '../helpers/mailer': { sendMail: async () => ({ ok: true }) },
  '../helpers/saldos': {
    // A aritmética da situação financeira é código puro e é testada à parte
    // (scripts/test-situacao-financeira.js); aqui duplica-se para o teste
    // executar o HANDLER, que é o que esta bateria cobre.
    resumoFinanceiro: async (ano) => ({
      ano,
      saldoContas: 2500,
      receitasAno: 125,
      despesasAno: 0,
      saldoAno: 125,
      totalQuotas: 335,
      pagoQuotas: 125,
      emDivida: 210,
      cobrancaPct: 37,
      nFracoesEmAtraso: 1,
      nFracoes: 2,
      contas: [
        { id: 1, nome: 'Conta principal', banco: 'Banco Exemplo', iban: 'PT50 0002 0123 1234 5678 9015 4', tipo: 'corrente', saldo: 1000 },
        { id: 2, nome: 'Fundo de reserva', banco: 'Banco Exemplo', iban: null, tipo: 'fundo_reserva', saldo: 500 },
      ],
      fundoReserva: 500,
      orcamentado: 10800,
      executadoC: 0,
      contasPorMes: [0, 0, 0, 0, 0, 0, 7500, 0, 5000, 0, 0, 0],
      despesasPorMes: Array(12).fill(0),
    }),
    evolucaoMensal: ({ contasPorMes = [], despesasPorMes = [] } = {}) => {
      const meses = [];
      for (let i = 0; i < 12; i += 1) {
        const contas = contasPorMes[i] || 0;
        const despesas = despesasPorMes[i] || 0;
        meses.push({ mes: i + 1, contas: contas / 100, despesas: despesas / 100, saldo: (contas - despesas) / 100, temMovimentos: contas !== 0 || despesas !== 0 });
      }
      return {
        meses,
        temMovimentos: meses.some((m) => m.temMovimentos),
        mesesComMovimentos: meses.filter((m) => m.temMovimentos).length,
        totalContas: 125,
        totalDespesas: 0,
      };
    },
    estadoEfetivo: (q) => (q && q.estado) || null,
    saldoConta: async () => 0,
    // Duplos apenas para os resumos usados por outras páginas.
    resumoFracao: async () => ({ totalQuotas: 292.5, totalPago: 125, emDivida: 167.5, quotasPagas: 1, quotasPendentes: 2, quotasVencidas: 1, ultimoPagamento: { valor: 50, data: '2026-09-01' } }),
    resumoCondominio: async () => ({ saldoContas: 1000, fundoReserva: 500, receitas: 2000, despesas: 1500, emDividaGlobal: 100, contas: [] }),
    resumoOrcamento: async (ano) => ({ ano: ano || 2026, orcamentado: 10800, executado: 0, percentagem: 0 }),
    ESTADOS_PENDENTES: ['pendente', 'parcialmente_paga', 'vencida'],
  },
  '../helpers/conta-corrente': {
    // Duplo da conta-corrente: a fração C não deve dívida, a A deve.
    contaCorrenteFracao: async ({ fracaoId }) => (Number(fracaoId) === 5
      ? { saldo: 167.5, saldoC: 16750, emDivida: true, temCredito: false, quotasEmDivida: 167.5, extrasEmDivida: 0, extrato: [], anos: [2026] }
      : { saldo: 0, saldoC: 0, emDivida: false, temCredito: false, quotasEmDivida: 0, extrasEmDivida: 0, extrato: [], anos: [2026] }),
    anosContaCorrente: async () => [2026],
    listaFracoes: async () => [],
  },
  '../helpers/titularidades': {
    fracoesDoUtilizador: async () => ({ fracoes: [{ fracao: FRACAO_A, vinculo: 'proprietario' }, { fracao: FRACAO_C, vinculo: 'proprietario' }], terminadas: [] }),
    historicoDaPessoa: async () => [],
    estaAtiva: () => true,
  },
  // Área pessoal: a lista de condomínios vem das associações do próprio. Aqui o
  // duplo serve as duas páginas do portal que a usam (perfil e condomínios); o
  // isolamento a sério é exercitado em scripts/test-conta-condominios.js, com o
  // ajudante real.
  '../helpers/tenant': {
    // O módulo da área do condomínio monta este middleware à entrada; aqui já
    // há condomínio ativo na sessão, por isso só se expõe o que os handlers usam.
    comCondominioAtivo: (req, res, next) => { req.condominioId = Number(req.session.condominio_ativo_id) || 1; next(); },
    // `routes/condomino.js` fecha a área do condómino ao acesso de suporte com
    // `tenant.semSuporte`. No duplo, o pedido não tem contexto de suporte, pelo
    // que o guard é um no-op (é o que acontece em produção fora do suporte).
    semSuporte: (req, res, next) => next(),
    listarCondominios: async () => ([
      { id: 1, designacao: COND.designacao, morada: COND.morada, codigo_postal: COND.codigo_postal, localidade: COND.localidade, role: 'leitura' },
      { id: 2, designacao: 'Condomínio B', morada: null, codigo_postal: null, localidade: null, role: 'leitura' },
    ]),
    ativo: (req) => Number(req.session.condominio_ativo_id) || null,
    entrarCondominio: async () => true,
    eSuperAdmin: () => false,
    associacaoAtiva: async () => ({ role: 'leitura' }),
    papelNoAtivo: async () => 'leitura',
    eAdminCondominio: async () => false,
    pertenceAoAtivo: () => true,
  },
  '../helpers/recibos': {
    pagoPorQuota: async () => PAGO_POR_QUOTA,
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
  req.isAuthenticated = () => true;
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
// Área pessoal do portal (Fase 2F): perfil e condomínios, no seu próprio router.
app.use('/condomino', require('../routes/condomino-conta'));
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
  ['/condomino/situacao-financeira', 'Situação financeira'],
  ['/condomino/situacao', 'Situação financeira (endereço anterior)'],
  ['/condomino/perfil', 'Meu perfil'],
  ['/condomino/condominios', 'Os meus condomínios'],
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

  // 5. Situação financeira: valores agregados, secções e estados vazios.
  const situacao = await pedir('/condomino/situacao-financeira');
  const antiga = await pedir('/condomino/situacao');
  assert.ok(/<h1>Situação financeira<\/h1>/.test(situacao.html), 'situação: título da página presente');
  for (const seccao of ['Resumo financeiro', 'Execução do orçamento', 'Contas', 'Fundo de reserva',
    'Valores em dívida', 'Evolução do ano', 'Relatório e ações']) {
    assert.ok(situacao.html.includes(seccao), `situação: secção «${seccao}» presente`);
  }
  // Só valores agregados: as duas frações do utilizador aparecem (são suas) e a
  // secção de dívida nunca identifica terceiros — apenas a contagem agregada.
  assert.ok(/1\.º Esq/.test(situacao.html) && /2\.º Dto/.test(situacao.html),
    'situação: mostra a posição das frações do próprio');
  // Dívida de terceiros: nunca identificada, sempre agregada. O bloco da secção
  // é isolado pelo comentário/estado que a vista escreve (sem HTML inventado).
  assert.ok(/Dívida agregada das frações em atraso/.test(situacao.html),
    'situação: a dívida é apresentada como valor agregado');
  assert.ok(/Valor agregado de 1 fração com quota vencida/.test(situacao.html),
    'situação: a dívida de terceiros aparece apenas como contagem');
  assert.ok(/não são identificadas frações nem titulares/.test(situacao.html),
    'situação: a secção de dívida declara que não identifica terceiros');
  assert.ok(!/Fração 3|Fração 4/.test(situacao.html), 'situação: nenhuma fração de terceiros é identificada');
  assert.ok(/12 480,50|12480,50|12.480,50/.test(situacao.html) || /€/.test(situacao.html), 'situação: valores monetários formatados');
  // O endereço anterior continua a responder com a MESMA página.
  assert.strictEqual(antiga.status, 200, 'situação: o endereço anterior responde 200');
  assert.ok(/<h1>Situação financeira<\/h1>/.test(antiga.html), 'situação: o endereço anterior serve a mesma página');

  // 6. Área pessoal (Fase 2F): perfil e condomínios, no portal.
  const perfil = await pedir('/condomino/perfil');
  assert.ok(/<h1>Meu perfil<\/h1>/.test(perfil.html), 'perfil: título da página');
  assert.ok(/ana@exemplo\.pt/.test(perfil.html) && /Ana Teste/.test(perfil.html), 'perfil: dados da conta do próprio');
  assert.ok(/Inativa/.test(perfil.html) && /Ativar 2FA/.test(perfil.html), 'perfil: 2FA inativo com ação de ativação');
  assert.ok(/href="\/conta\/seguranca"/.test(perfil.html), 'perfil: a gestão do 2FA continua na página existente');
  assert.ok(/1\.º Esq/.test(perfil.html) && /2\.º Dto/.test(perfil.html), 'perfil: as frações próprias no condomínio ativo');
  assert.ok(/Condomínio Exemplo/.test(perfil.html), 'perfil: identifica o condomínio ativo');

  const conds = await pedir('/condomino/condominios');
  assert.ok(/<h1>Os meus condomínios<\/h1>/.test(conds.html), 'condomínios: título da página');
  assert.ok(/Condomínio Exemplo/.test(conds.html) && /Condomínio B/.test(conds.html), 'condomínios: lista os condomínios com acesso');
  assert.ok(/Entrar neste condomínio/.test(conds.html), 'condomínios: ação para entrar no outro');
  assert.ok(/action="\/condomino\/condominios\/2\/entrar"/.test(conds.html), 'condomínios: rota do portal para entrar');
  // A área pessoal é do próprio: nada de dados de outras contas.
  for (const html of [perfil.html, conds.html]) {
    assert.ok(!/bruno@exemplo|outro condómino/i.test(html), 'área pessoal: não expõe dados de terceiros');
  }
  // O portal continua só de leitura: a única escrita vive no router da área pessoal.
  const fontePortal = fs.readFileSync(path.join(RAIZ, 'routes', 'condomino.js'), 'utf8');
  assert.ok(!/router\.(post|put|patch|delete)\(/.test(fontePortal),
    'área pessoal: a área do condomínio continua sem rotas de escrita');
  const fonteConta = fs.readFileSync(path.join(RAIZ, 'routes', 'condomino-conta.js'), 'utf8');
  assert.strictEqual((fonteConta.match(/router\.post\(/g) || []).length, 1,
    'área pessoal: uma só rota de escrita (entrar num condomínio)');

  // 7. Recomendação contextual no Início (Fase 2G): aparece porque a condição
  // existe (2FA inativo no utilizador de exemplo). O comportamento completo
  // (dispensa, intervalo, ativação do 2FA) é testado em
  // scripts/test-rotas-recomendacoes.js.
  const inicio = await pedir('/condomino');
  assert.ok(/Reforce a segurança da sua conta com 2FA/.test(inicio.html),
    'Início: recomendação de 2FA apresentada quando a conta não tem 2FA');
  assert.ok(/action="\/condomino\/recomendacoes\/2fa_ativo\/dispensar"/.test(inicio.html),
    'Início: dispensa ligada à recomendação certa');
  assert.strictEqual((inicio.html.match(/portal-recomendacao-titulo/g) || []).length, 1,
    'Início: no máximo uma recomendação apresentada');

  // 8. A correção não pode voltar a depender de uma variável inexistente.
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

// Uma promessa rejeitada fora da cadeia (ex.: erro dentro de um handler Express
// que o erro do router não apanhou) tem de falhar o teste, não passar em claro.
process.on('unhandledRejection', (err) => {
  console.error('✗ promessa rejeitada sem tratamento: ' + (err && err.message));
  process.exit(1);
});
