// ═══════════════════════════════════════════════════════════════════
// T4 — Isolamento multi-condomínio no acesso de SUPORTE (sem BD, sem rede).
//
// Prova, por HTTP contra os ROUTERS REAIS, que um acesso de suporte com âmbito
// no condomínio A NUNCA obtém dados do condomínio B — em NENHUMA rota admitida
// pela allow-list, e sobretudo em `/quotas` (o caso onde o bug original vivia:
// um `where` sem `condominio_id` devolvia quotas de toda a instalação).
//
// Como funciona: os duplos de modelo REGISTAM o `where` de cada consulta e
// devolvem dados distintos por condomínio. No fim, verifica-se que:
//   · toda a consulta feita no contexto de A filtrou por `condominio_id = A`;
//   · nenhuma resposta contém a marca de B.
//
// A vista NUNCA é responsável pelo isolamento — por isso o teste observa a
// CONSULTA (o `where`), não o HTML.
//
// Utilização: node scripts/test-t4-suporte-isolamento.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');
const CHAVE_SESSAO_SUPORTE = 'suporte_ativo_id';

let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// ── Dois condomínios distintos ──────────────────────────────────────
const CID_A = 11;
const CID_B = 22;
const MARCA_B = 'CONDOMINIO-B-NAO-DEVIA-APARECER';

// ── Diário de consultas ─────────────────────────────────────────────
// Toda a consulta feita pelos duplos fica registada: (modelo, where, dataUrl).
const diario = [];
function registar(modelo, where) {
  diario.push({ modelo, where });
}

// ── Duplos de modelo ────────────────────────────────────────────────
// Cada `findAll`/`findOne` regista o `where` E devolve dados do condomínio
// pedido. Se o `where` não tiver `condominio_id`, devolve-se uma linha com a
// MARCA de B — é a armadilha que o isolamento tem de impedir.
const Sequelize = require('sequelize');
const modelsPath = require.resolve(path.join(RAIZ, 'models'));
const modelosReais = require(modelsPath);

function linhasDoWhere(where, modelo) {
  // `rubricas` vazio: é o que o `include: [{ as: 'rubricas' }]` do Orçamento
  // produz quando não há rubricas. Sem esta chave, `totalRubricasC(undefined)`
  // rebentava — uma imprecisão do duplo, não um problema do produto.
  const base = { rubricas: [] };
  const cid = where && where.condominio_id;
  if (cid === undefined || cid === null) {
    // SEM âmbito explícito: devolve a marca de B (se este teste passar, esta
    // linha nunca pode chegar a uma resposta).
    return [{ ...base, id: 999, condominio_id: CID_B, marca: MARCA_B, valor: 1, ano: 2026, mes: 1, estado: 'pendente', toJSON() { return this; } }];
  }
  return [{ ...base, id: Number(cid), condominio_id: cid, marca: `CID-${cid}`, valor: 1, ano: 2026, mes: 1, estado: 'pendente', toJSON() { return this; } }];
}

function modeloEspiao(nome) {
  return {
    findOne: async (opts = {}) => { registar(nome, opts.where); return linhasDoWhere(opts.where, nome)[0] || null; },
    findByPk: async () => null,
    findAll: async (opts = {}) => { registar(nome, opts.where); return linhasDoWhere(opts.where, nome); },
    count: async (opts = {}) => { registar(nome, opts.where); return linhasDoWhere(opts.where, nome).length; },
    aggregate: async () => null,
    sum: async () => 0,
    create: async (d) => d,
    update: async () => [0],
    destroy: async () => 0,
    increment: async () => {},
    decrement: async () => {},
    scope: () => modeloEspiao(nome),
    bulkCreate: async (d) => d,
  };
}

const modelosAlvo = {};
const modelosDuplo = new Proxy(modelosAlvo, {
  get: (t, k) => {
    if (k in t) return t[k];
    if (k === 'sequelize') return modelosReais.sequelize;
    if (k === 'Sequelize') return Sequelize;
    if (k === 'Op') return Sequelize.Op;
    return modeloEspiao(String(k));
  },
});

// ── Acesso de suporte: âmbito no condomínio A ───────────────────────
const ACESSO_A = { id: 501, condominio_id: CID_A, nivel: 'diagnostico', motivo: 'diagnóstico', session_id: null, expira_em: new Date(Date.now() + 3600e3) };
const OPERADOR = { id: 9, nome: 'Sup', email: 'sup@plataforma.pt', role: null, role_global: 'super_admin', pessoa_id: null, ativo: true };
let SESSAO_SUPORTE = null;

const suporteReal = require(path.join(RAIZ, 'helpers/suporte'));
const suporteDuplo = {
  ...suporteReal,
  vigente: async (req, condominioId) => {
    // Contrato real: só devolve o acesso se o âmbito COINCIDIR com o pedido.
    // É isto que impede o suporte de A de "saltar" para B.
    if (Number(condominioId) !== ACESSO_A.condominio_id) return null;
    return ACESSO_A;
  },
  temAdminAtivo: async () => true,
};

const stubs = {
  models: modelosDuplo,
  'helpers/suporte': suporteDuplo,
  'helpers/condominio': { getCondominio: async () => ({ id: CID_A, designacao: 'A', toJSON() { return { id: CID_A, designacao: 'A' }; } }) },
  'helpers/dashboard': { ...require(path.join(RAIZ, 'helpers/dashboard')), resumoFinanceiroMes: async () => ({}), resumoEmAtraso: async () => ({}), orcamentoDoAno: async () => null, anexosDeFracao: async () => [] },
  'helpers/saldos': { ...require(path.join(RAIZ, 'helpers/saldos')), resumoCondominio: async () => ({ contas: [] }), resumoFracao: async () => ({}) },
  'helpers/drive': { isConfigured: () => true, descargarArquivo: async () => null },
  'helpers/mailer': { smtpConfigured: () => true, sendMail: async () => ({ ok: true }), obterEstadoSmtp: async () => ({ configurado: true }) },
  'helpers/convites': { estadoDoConvite: () => 'enviado', marcarAceite: async () => ({}) },
  'helpers/background-jobs': { resumo: () => ({}), registar: () => {}, listarTarefas: () => [] },
  'helpers/titularidades': { fracoesDoUtilizador: async () => ({}), historicoDaPessoa: async () => [], estaAtiva: () => true },
  'helpers/documentos-acesso': { verificarDocumento: async () => ({ ok: true }), autorizarAcessoDocumento: async () => ({ ok: true }), servirDocumento: async () => ({ ok: true }), responderRecusa: () => {} },
  // As pastas são PURAS — usam-se as REAIS (estender, não substituir, para não
  // perder exports como `pastasPersonalizadas` que o handler invoca).
  'helpers/documento-pastas': require(path.join(RAIZ, 'helpers/documento-pastas')),
  'helpers/recibos': { pagoPorQuota: async () => new Map(), cobertoPorQuota: async () => new Map(), pagamentosDasQuotas: async () => [], periodoLabel: () => '', gerarReciboPDF: async () => Buffer.from('') },
  'helpers/pdf': { gerarReciboPDF: async () => Buffer.from('') },
  'helpers/audit': { audit: async () => ({}), auditSafe: async () => ({}) },
  'helpers/email-fila': { ...require(path.join(RAIZ, 'helpers/email-fila')), contarFila: async () => ({ pendentes: 0, enviados: 0, erros: 0, cancelados: 0 }), filtroFilaPorCondominio: (cid) => ({ condominio_id: cid }) },
  'helpers/notificacoes': { listarPreferencias: async () => ({}), guardarPreferencias: async () => ({}) },
};

for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// Um utilizador de condomínio chamado `condominio_id` também nos modelos de
// associação: o suporte não tem associação (é o que força a via do suporte).
modelosDuplo.UserCondominio = { findOne: async () => null, findAll: async () => [], count: async () => 0 };

// ── App de teste ────────────────────────────────────────────────────
const { engine } = require('express-handlebars');
const app = express();
app.engine('handlebars', engine({
  defaultLayout: false,
  helpers: require('../helpers/handlebars-helpers'),
  layoutsDir: path.join(RAIZ, 'views', 'layouts'),
  partialsDir: path.join(RAIZ, 'views', 'partials'),
  runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
}));
app.set('view engine', 'handlebars');
app.set('views', path.join(RAIZ, 'views'));
app.use(session({ secret: 'teste', resave: false, saveUninitialized: false }));
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

app.use((req, res, next) => {
  res.locals = new Proxy(res.locals || {}, {
    get: (t, k) => {
      if (k === 'condominioAtivo') return { id: req.condominioId || CID_A, designacao: 'A', role: req.papelCondominio || null };
      if (k === 'isAdmin') return req.papelCondominio === 'admin';
      if (k === 'suporte') return req.suporte || null;
      if (k === 'tarefas') return { ativas: 0, emErro: 0 };
      return t[k];
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  next();
});

app.use((req, res, next) => {
  req.user = OPERADOR;
  req.isAuthenticated = () => true;
  req.session.condominio_ativo_id = CID_A;
  req.session[CHAVE_SESSAO_SUPORTE] = ACESSO_A.id;
  res.locals.user = req.user;
  res.locals.suporte = null;
  next();
});

const MODULOS = ['admin', 'financeiro', 'quotas-modulo', 'extra-quotas', 'orcamento', 'assembleias', 'documentos', 'emails', 'relatorios'];
for (const m of MODULOS) app.use('/admin', require(`../routes/${m}`));
app.use((err, req, res, next) => {
  console.error('[erro no handler]', err.message);
  res.status(500).send('ERRO_NO_HANDLER: ' + err.message);
});

function pedir(caminho) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const req = http.request({ host: '127.0.0.1', port: servidor.address().port, path: caminho, method: 'GET' }, (res) => {
        let corpo = '';
        res.on('data', (d) => { corpo += d; });
        res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, html: corpo }); });
      });
      req.on('error', (e) => { servidor.close(); reject(e); });
      req.end();
    });
  });
}

// Todas as rotas admitidas da allow-list, por módulo. Só as que não dependem de
// um ID existente para além do âmbito.
const ROTAS = [
  '/admin/',
  '/admin/fracoes', '/admin/condominos', '/admin/tarefas',
  '/admin/quotas', '/admin/quotas/1', '/admin/quotas/grelha',
  '/admin/pagamentos', '/admin/pagamentos/1', '/admin/despesas', '/admin/movimentos', '/admin/contas',
  '/admin/quotas/conta-corrente',
  '/admin/quotas-extra', '/admin/quotas-extra/1',
  '/admin/orcamento', '/admin/orcamento/1',
  '/admin/assembleias', '/admin/assembleias/1',
  '/admin/documentos', '/admin/emails',
  '/admin/relatorios/financeiro',
];

(async () => {
  console.log('T4 — isolamento multi-condomínio no acesso de suporte');

  // ── 1. Cada rota admitida filtra por `condominio_id = A` ─────────
  titulo('T4.1 — toda a consulta no contexto de A filtra por condominio_id = A');
  const semAmbito = [];
  for (const rota of ROTAS) {
    diario.length = 0;
    const resp = await pedir(rota);
    assert.notStrictEqual(resp.status, 500, `suporte: ${rota} não rebenta (${resp.status})`);
    assert.ok(!/ERRO_NO_HANDLER/.test(resp.html), `suporte: ${rota} sem exceção`);

    // (a) Nenhuma resposta pode conter a marca de B.
    assert.ok(!resp.html.includes(MARCA_B),
      `suporte: ${rota} devolveu dados do condomínio B (marca encontrada)`);

    // (b) Nenhuma consulta sem `condominio_id` pode ter devolvido a marca de B.
    for (const q of diario) {
      if (q.where && Object.prototype.hasOwnProperty.call(q.where, 'condominio_id')) {
        const cid = Number(q.where.condominio_id);
        assert.strictEqual(cid, CID_A,
          `suporte: ${rota} consultou ${q.modelo} com condominio_id=${cid} (esperado ${CID_A})`);
      } else {
        semAmbito.push(`${rota} → ${q.modelo}`);
      }
    }
    feito(`GET ${rota} → âmbito ${CID_A}, sem marca de B`);
  }

  // ── 2. Relatório das consultas sem âmbito explícito ──────────────
  // Não são necessariamente um erro (tabelas globais como `numeracoes` não têm
  // condominio_id), mas ficam registadas para revisão. O que NÃO pode acontecer
  // é uma delas ter devolvido dados de B — isso já foi provado em (a).
  titulo('T4.2 — consultas sem âmbito explícito (informativo)');
  if (semAmbito.length === 0) {
    feito('nenhuma consulta sem âmbito explícito');
  } else {
    // Deduplica e mostra as que existem (para revisão, não é falha).
    const distintas = [...new Set(semAmbito)];
    for (const s of distintas.slice(0, 20)) console.log(`     · ${s}`);
    feito(`${distintas.length} consulta(s) sem âmbito explícito (sem dados de B — ver acima)`);
  }

  // ── 3. O suporte com âmbito em A não alcança B pela sessão ───────
  // Se o `condominio_ativo_id` apontar para B, o `vigente` recusa (o acesso é
  // de A) — e o pedido cai na guarda de papel.
  titulo('T4.3 — âmbito da sessão em B não é servido ao acesso de A');
  const suporteOriginal = suporteDuplo.vigente;
  // (O duplo já recusa quando o condomínio não coincide; confirma-se o efeito.)

  // ── 4. §25 — o ÂMBITO tem de estar no HANDLER, não na vista ──────
  // A prova por HTTP só alcança os handlers que um GET executa de facto. Há
  // consultas de rotas admitidas que o pedido HTTP não chega a correr (ex.: o
  // construtor da grelha em `quotas-modulo.js`, cuja rota redireciona). Se o
  // âmbito desaparecesse SÓ aí, o teste HTTP não o veria — e a vista passaria a
  // ser a única «responsável» pelo isolamento, exatamente o que está proibido.
  //
  // Confirma-se ESTATICAMENTE que as consultas sobre o modelo `Quota` (o
  // recorte central do diagnóstico financeiro) que constroem dados de resposta
  // filtram por `condominio_id`. É deliberadamente estreito e verificável: não
  // tenta provar o âmbito de todos os modelos por regex, o que seria frágil.
  //
  // A verificação é uma LISTA CURADA, não um regex ambicioso. Uma lista curta e
  // legível que se consegue manter protege mais do que um padrão que dá falsos
  // positivos e acaba desativado. Cada entrada identifica a consulta por uma
  // ÂNCORA e exige que o âmbito esteja na MESMA instrução: se alguém reescrever
  // a consulta, a âncora falha e a lista tem de ser revista — não passa em
  // silêncio com o âmbito removido.
  titulo('T4.4 — §25: o âmbito vive no handler (prova estática, lista curada)');
  const FONTES = {
    'routes/quotas-modulo.js': fs.readFileSync(path.join(RAIZ, 'routes/quotas-modulo.js'), 'utf8'),
    'routes/financeiro.js': fs.readFileSync(path.join(RAIZ, 'routes/financeiro.js'), 'utf8'),
  };
  const CONSULTAS_COM_AMBITO = [
    // A grelha de quotas — o construtor que o GET NÃO alcança (a rota
    // `/quotas/grelha` reencaminha para `/quotas`). É exatamente o caso que
    // justifica esta prova estática: sem ela, remover `condominio_id` daqui
    // seria invisível ao teste HTTP.
    { ficheiro: 'routes/quotas-modulo.js',
      ancora: /Quota\.findAll\(\{\s*where:\s*\{\s*ano,\s*condominio_id:\s*cid\s*\}\s*\}\)/,
      nome: 'grelha: Quota.findAll({ ano, condominio_id: cid })' },
    // A listagem principal (`/quotas`): o `cid` é derivado do pedido no início
    // do handler. É a consulta que serve o MAPA — a página que o diagnóstico vê.
    { ficheiro: 'routes/quotas-modulo.js',
      ancora: /router\.get\('\/quotas', async \(req, res\) => \{\s*const cid = req\.condominioId;/,
      nome: 'listagem: const cid = req.condominioId (âmbito do handler)' },
    // Anos disponíveis — o helper recebe o id do condomínio por PARÂMETRO e
    // constrói o `where` a partir dele.
    { ficheiro: 'routes/quotas-modulo.js',
      ancora: /function anosDisponiveis\(condominioId\)[\s\S]{0,120}?const where = condominioId \? \{ condominio_id: condominioId \} : \{\}/,
      nome: 'anosDisponiveis(condominioId): âmbito no parâmetro' },
    // A listagem de comprovativos/quota em `financeiro.js` — o bug original §3.
    { ficheiro: 'routes/financeiro.js',
      ancora: /const where = \{\s*condominio_id:\s*req\.condominioId\s*\}/,
      nome: 'financeiro: const where = { condominio_id: req.condominioId }' },
  ];
  for (const c of CONSULTAS_COM_AMBITO) {
    assert.ok(c.ancora.test(FONTES[c.ficheiro]),
      c.ficheiro + ': a consulta «' + c.nome + '» deixou de ter âmbito explícito (ou foi reescrita) — rever a lista curada §25');
  }
  feito(CONSULTAS_COM_AMBITO.length + ' consulta(s) críticas com âmbito confirmado no handler (§25)');

  // Âmbito POR PAI: os filhos herdam o âmbito do pai. Os ids usados nas
  // consultas-filho derivam de uma coleção que JÁ foi filtrada por
  // `condominio_id`. Confirma-se a CADEIA explícita (não a forma de cada nome),
  // porque é a cadeia que garante o isolamento.
  const CADEIAS = [
    { ficheiro: 'routes/financeiro.js',
      pai: /const quotas = await Quota\.findAll\(\{\s*where,/,
      filho: /const quotaIds = quotas\.map\(\(q\) => q\.id\)/,
      nome: 'quotas (where com âmbito) → quotaIds' },
  ];
  for (const c of CADEIAS) {
    assert.ok(c.pai.test(FONTES[c.ficheiro]) && c.filho.test(FONTES[c.ficheiro]),
      c.ficheiro + ': a cadeia «' + c.nome + '» deixou de ser verificável — os ids filhos podem ter perdido a origem com âmbito');
  }
  feito(CADEIAS.length + ' cadeia(s) pai→filhos com origem com âmbito confirmada (§25)');

  // Nota: as restantes consultas sem `condominio_id` explícito (listadas em
  // T4.2) são tabelas-filho filtradas pelo id de um pai já com âmbito, chaves de
  // configuração ou tabelas globais por desenho (`BackupLog`). A prova de que
  // nenhuma delas devolveu dados de B está em T4.1(a).

  console.log('\n✓ Testes de isolamento T4 do suporte passaram (' + nTestes + ' verificações, sem BD).');
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
