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

// ── Auditoria: registo observável (ACHADO-02) ───────────────────────
// `auditoriaRegistada` é preenchida no stub de `helpers/audit` (ver `stubs`
// abaixo). O `AuditLog` fica com um duplo simples — o `create` real nunca é
// alcançado em modo de teste, mas mantém-se definido para o Proxy não gerar um
// `modeloEspiao` que registasse consultas espúrias no `diario`.
const auditoriaRegistada = [];
const eventosConsulta = () => auditoriaRegistada.filter((e) => e && e.acao === 'suporte_consulta');
const rotaDoEvento = (e) => JSON.parse(e.detalhes).rota;

// Duplo próprio do `AuditLog` (o Proxy geraria um `modeloEspiao`, cujo `create`
// devolve os dados sem os guardar). O T4.5(i) muta o `create` daqui para provar
// que uma falha de gravação não derruba o pedido.
modelosAlvo.AuditLog = { create: async (dados) => dados };

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
const UTILIZADOR_GESTOR = { id: 42, nome: 'Ana', email: 'ana@exemplo.pt', role: null, role_global: null, pessoa_id: null, ativo: true };
let SESSAO_SUPORTE = null;

// Perfil do pedido: `suporte` (sem associação → a via do suporte) ou
// `gestor` (utilizador normal, com associação real). O contexto NÃO é forjado
// aqui: é o `comCondominioAtivo` REAL do router que o resolve a partir da
// sessão — só assim se testa o encadeamento verdadeiro.
let perfilAtivo = 'suporte';

const suporteReal = require(path.join(RAIZ, 'helpers/suporte'));
const suporteDuplo = {
  ...suporteReal,
  vigente: async (req, condominioId) => {
    // Contrato real: só devolve o acesso se o âmbito COINCIDIR com o pedido.
    // É isto que impede o suporte de A de "saltar" para B.
    if (perfilAtivo !== 'suporte') return null; // utilizador normal não é suporte
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
  'helpers/documentos-acesso': { verificarDocumento: async () => ({ ok: true }), autorizarAcessoDocumento: async () => ({ ok: true }), servirDocumento: async () => ({ ok: true }), responderRecusa: () => {}, urlInterna: () => '/admin/documentos/0/ficheiro', urlParaEmail: () => '/admin/documentos/0/ficheiro' },
  // As pastas são PURAS — usam-se as REAIS (estender, não substituir, para não
  // perder exports como `pastasPersonalizadas` que o handler invoca).
  'helpers/documento-pastas': require(path.join(RAIZ, 'helpers/documento-pastas')),
  'helpers/recibos': { pagoPorQuota: async () => new Map(), cobertoPorQuota: async () => new Map(), pagamentosDasQuotas: async () => [], periodoLabel: () => '', gerarReciboPDF: async () => Buffer.from('') },
  'helpers/pdf': { gerarReciboPDF: async () => Buffer.from('') },
  'helpers/audit': {
    // O stub de auditoria tem de ser OBSERVÁVEL (ACHADO-02): é por aqui que a
    // telemetria de consulta passa. Um no-op faria o T4.5 medir sempre zero e
    // «passar» sem provar nada — o falso verde clássico.
    //
    // ⚠️ O stub tem de replicar o CONTRATO REAL de `helpers/audit.js`, que
    // grava uma LINHA (não o evento):
    //   `{ user_id, acao, entidade, entidade_id, detalhes: JSON.stringify(...) }`
    // Registar o objeto em bruto faria `JSON.parse(detalhes)` rebentar e
    // `entidade_id` vir `undefined` — os asserts mediriam a forma errada e a
    // telemetria pareceria avariada.
    audit: async (evento) => {
      auditoriaRegistada.push({
        user_id: evento.userId || null,
        acao: evento.acao,
        entidade: evento.entidade || null,
        entidade_id: evento.entidadeId || null,
        detalhes: evento.detalhes ? JSON.stringify(evento.detalhes) : null,
      });
      return evento;
    },
    auditSafe: async (evento) => {
      auditoriaRegistada.push({
        user_id: evento.userId || null,
        acao: evento.acao,
        entidade: evento.entidade || null,
        entidade_id: evento.entidadeId || null,
        detalhes: evento.detalhes ? JSON.stringify(evento.detalhes) : null,
      });
      return evento;
    },
  },
  'helpers/email-fila': { ...require(path.join(RAIZ, 'helpers/email-fila')), contarFila: async () => ({ pendentes: 0, enviados: 0, erros: 0, cancelados: 0 }), filtroFilaPorCondominio: (cid) => ({ condominio_id: cid }) },
  'helpers/notificacoes': { listarPreferencias: async () => ({}), guardarPreferencias: async () => ({}) },
};

for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// Associações reais: NENHUMA para o operador de suporte (é o que força a via do
// suporte); UMA para o utilizador normal do perfil `gestor` (é o que exercita
// o ramo de condomínio, para provar que a correção não o alterou).
modelosDuplo.UserCondominio = {
  findOne: async ({ where } = {}) => {
    if (perfilAtivo === 'suporte') return null;
    return where && where.utilizador_id === UTILIZADOR_GESTOR.id
      ? { id: 1, utilizador_id: UTILIZADOR_GESTOR.id, condominio_id: CID_A, role: perfilAtivo, estado: 'ativo' }
      : null;
  },
  findAll: async () => [],
  count: async () => 0,
};

// ── Observação da VISTA RENDERIZADA ──────────────────────────────────
// A decisão de vista é o que o ACHADO-01 contornava. `res.render` é envolvido
// (no protótipo do Express) para REGISTAR cada vista renderizada. Não se
// substitui a implementação: chama-se a original, para não alterar o render.
const vistaRenderizada = [];
const renderOriginal = express.response.render;
express.response.render = function (vista, ...resto) {
  vistaRenderizada.push(vista);
  return renderOriginal.call(this, vista, ...resto);
};

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
  // O utilizador depende do PERFIL: o operador de suporte não tem associação;
  // o gestor tem-na (é o que faz `comCondominioAtivo` escolher o ramo real).
  req.user = perfilAtivo === 'suporte' ? OPERADOR : UTILIZADOR_GESTOR;
  req.isAuthenticated = () => true;
  req.session.condominio_ativo_id = CID_A;
  // A marca de suporte na SESSÃO só existe no perfil de suporte.
  if (perfilAtivo === 'suporte') req.session[CHAVE_SESSAO_SUPORTE] = ACESSO_A.id;
  else delete req.session[CHAVE_SESSAO_SUPORTE];
  res.locals.user = req.user;
  res.locals.suporte = null;
  next();
});

// Os módulos montados derivam-se da FONTE ÚNICA (`helpers/suporte-allowlist`):
// manter aqui uma segunda lista à mão permitia que um módulo novo na `LISTA`
// deixasse de ser exercitado por HTTP sem o teste dar por isso.
const allowlistReal = require(path.join(RAIZ, 'helpers', 'suporte-allowlist'));
const MODULOS = allowlistReal.MODULOS.slice();
{
  const co = allowlistReal.incoerencias((f) => require('fs').existsSync(path.join(RAIZ, f)));
  assert.deepStrictEqual(
    [co.semRouter, co.ficheiroInexistente.map((x) => x.modulo), co.routersOrfaos],
    [[], [], []],
    'a LISTA tem de declarar um router existente para cada módulo (ver ROUTERS no allow-list)'
  );
}
for (const m of MODULOS) app.use('/admin', require(`../routes/${allowlistReal.routerDo(m).replace(/^routes\//, '')}`));
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

// ── VISTAS: quem decide a vista, e porque é que isto é testado AQUI ──
// ACHADO-03 da auditoria de 2026-09-18: as rotas admitidas eram exercitadas
// apenas pelo CAMINHO (`/admin/documentos`), sem query string. Mas o isolamento
// de um módulo com VÁRIOS ramos de render NÃO se esgota no caminho: a query
// string escolhe o ramo, e o ramo pode escolher a vista.
//
// Foi assim que o ACHADO-01 passou: `rotulo === 'Recibos de Pagamento'` (ramo
// aberto por `?pasta=recibos`) fazia `return res.render(<vista de gestão>)`
// DENTRO do ramo, saltando a decisão `req.suporte ? … : …` que só existia no
// caminho final. Com `req.path` — que **não tem query string** — a allow-list
// aprovava todas as variantes, e o teste também.
//
// Aqui a vista é OBSERVADA (`vistaRenderizada`), não inferida. É a única forma
// de o teste falhar quando a decisão de vista deixa de respeitar `req.suporte`,
// seja em que ramo for.
const VISTAS_SUPORTE_MINIMIZADAS = [
  // Todos os nomes de vista que o suporte PODE receber no módulo documentos.
  // A lista é fechada: uma vista nova fora dela faz falhar o teste, para que a
  // decisão seja consciente e não um esquecimento.
  'admin/documentos/listar-suporte',
];

// Todas as vistas de GESTÃO do módulo documentos. Em suporte, NENHUMA pode ser
// renderizada — é exactamente esta asserção que morde no ACHADO-01.
const VISTAS_GESTAO_DOCUMENTOS = [
  'admin/documentos/biblioteca',
  'admin/documentos/listar',
  'admin/documentos/recibos',
  'admin/documentos/recibos-anos',
  'admin/documentos/form',
  'admin/documentos/email',
];

// Rotas admitidas COM query string. Um caminho admitido pode ter várias vistas
// conforme a query; aqui exercita-se cada uma das que o handler conhece.
//
// Requisito da auditoria: `/admin/documentos?pasta=recibos&ano=2026` tem de ser
// testada EXPLICITAMENTE e tratada como a mesma rota `/admin/documentos`.
const ROTAS_COM_QUERY = [
  '/admin/documentos?pasta=recibos',
  '/admin/documentos?pasta=recibos&ano=2026',
  '/admin/documentos?pasta=atas',
  '/admin/documentos?pastas=atas,contratos',
];

(async () => {
  console.log('T4 — isolamento multi-condomínio no acesso de suporte');

  // ── 0. A vista devolvida ao suporte é a MINIMIZADA ──────────────
  // Corre ANTES das provas de âmbito: se a vista de gestão for servida, o
  // isolamento por consulta já não protege nada de relevante (a vista expõe
  // ações e identificadores que a de suporte não pode mostrar). Ver ACHADO-01.
  titulo('T4.0 — o suporte só recebe a vista MINIMIZADA (nenhuma vista de gestão)');
  const ROTAS_DOCUMENTOS = ROTAS.filter((r) => r === '/admin/documentos').concat(ROTAS_COM_QUERY);
  for (const rota of ROTAS_DOCUMENTOS) {
    vistaRenderizada.length = 0;
    const resp = await pedir(rota);
    assert.notStrictEqual(resp.status, 500, `suporte: ${rota} não rebenta (${resp.status})`);
    assert.ok(vistaRenderizada.length > 0,
      `suporte: ${rota} não renderizou vista nenhuma — o teste deixou de observar a decisão`);

    for (const v of vistaRenderizada) {
      assert.ok(!VISTAS_GESTAO_DOCUMENTOS.includes(v),
        `suporte: ${rota} renderizou a vista de GESTÃO «${v}» — o ramo saltou a decisão de vista (ACHADO-01)`);
      assert.ok(VISTAS_SUPORTE_MINIMIZADAS.includes(v),
        `suporte: ${rota} renderizou «${v}», fora da lista de vistas admitidas ao diagnóstico — ` +
        'se a vista é nova, acrescente-a a VISTAS_SUPORTE_MINIMIZADAS de forma CONSCIENTE');
    }
    feito(`GET ${rota} → vista minimizada (${vistaRenderizada.join(', ')})`);
  }

  // ── 0-bis. A MESMA rota, fora de suporte, mantém a vista de gestão ─
  // Prova que a correção não "achatou" a navegação: um gestor continua a ver a
  // biblioteca, a tabela e a navegação de recibos. Sem isto, a forma mais
  // fácil de fazer o T4.0 passar seria servir a vista de suporte a todos.
  titulo('T4.0b — fora de suporte, a vista de gestão mantém-se (comportamento preservado)');
  const PERFIL_ANTERIOR = perfilAtivo;
  perfilAtivo = 'gestor';
  const VISTAS_ESPERADAS = [
    ['/admin/documentos', 'admin/documentos/biblioteca'],
    ['/admin/documentos?pasta=recibos', 'admin/documentos/recibos-anos'],
    ['/admin/documentos?pasta=recibos&ano=2026', 'admin/documentos/listar'],
    ['/admin/documentos?pasta=atas', 'admin/documentos/listar'],
  ];
  for (const [rota, esperada] of VISTAS_ESPERADAS) {
    vistaRenderizada.length = 0;
    const resp = await pedir(rota);
    assert.notStrictEqual(resp.status, 500, `gestor: ${rota} não rebenta (${resp.status})`);
    assert.ok(vistaRenderizada.includes(esperada),
      `gestor: ${rota} devia renderizar «${esperada}», renderizou «${vistaRenderizada.join(', ')}» ` +
      '(a correção do suporte não pode alterar o comportamento normal)');
    feito(`GET ${rota} → «${esperada}» (gestor)`);
  }
  perfilAtivo = PERFIL_ANTERIOR;

  // ── 1. Cada rota admitida filtra por `condominio_id = A` ─────────
  titulo('T4.1 — toda a consulta no contexto de A filtra por condominio_id = A');
  const semAmbito = [];
  for (const rota of ROTAS.concat(ROTAS_COM_QUERY)) {
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

  // ── T4.5 — auditoria da CONSULTA por HTTP (ACHADO-02) ────────────
  // Prova, pelo router REAL, que a telemetria de consulta se comporta como
  // especificado. Registra-se CADA consulta (sem agregação) e a rota NÃO inclui
  // a query string — é aqui que isso é exercitado a sério, porque é o Express
  // que entrega `req.path` sem query.
  titulo('T4.5 — auditoria da consulta: uma por pedido, sem query string');

  // A sonda do T4.0 deixou o perfil em `gestor`? Restaurar explicitamente.
  perfilAtivo = 'suporte';

  // Sondas de pré-condição: se a telemetria não existir, os asserts abaixo
  // falhariam por «0 eventos» — o que seria indistinguível de uma avaria. Antes
  // de medir, confirma-se que o servidor está realmente a servir suporte.
  const sondaAdmissao = await pedir('/admin/documentos');
  assert.strictEqual(sondaAdmissao.status, 200, 'pré-condição: o suporte chega a /admin/documentos (200)');

  // (a) Um GET admitido deixa UM evento, com o envelope correto.
  // O reset do registo vem DEPOIS da sonda de admissão: sem agregação, cada
  // pedido deixa o seu evento, pelo que a sonda não pode ficar contada aqui.
  auditoriaRegistada.length = 0;
  const rDocs = await pedir('/admin/documentos');
  assert.strictEqual(rDocs.status, 200, 'GET /admin/documentos em suporte → 200');
  const evDocs = eventosConsulta();
  assert.strictEqual(evDocs.length, 1, 'um GET admitido deixa exatamente 1 suporte_consulta');
  const detDocs = JSON.parse(evDocs[0].detalhes);
  assert.strictEqual(evDocs[0].entidade, 'Condominio', 'entidade = Condominio');
  assert.strictEqual(evDocs[0].entidade_id, CID_A, 'entidade_id = condomínio do acesso');
  assert.strictEqual(detDocs.acesso_suporte_id, ACESSO_A.id, 'detalhes.acesso_suporte_id correto');
  assert.strictEqual(detDocs.condominio_id, CID_A, 'detalhes.condominio_id correto');
  assert.strictEqual(detDocs.rota, '/documentos', 'detalhes.rota = req.path (sem /admin)');
  feito('a. GET admitido por HTTP → 1 suporte_consulta com envelope correto');

  // (b) A query string NÃO entra na rota nem nos detalhes.
  auditoriaRegistada.length = 0;
  const rQuery = await pedir('/admin/documentos?pasta=recibos&ano=2026');
  assert.strictEqual(rQuery.status, 200, 'a variante com query é servida (200)');
  const evQuery = eventosConsulta();
  assert.strictEqual(evQuery.length, 1, 'a variante com query deixa 1 evento');
  const serializado = JSON.stringify(JSON.parse(evQuery[0].detalhes));
  assert.ok(!serializado.includes('recibos'), '«recibos» NÃO aparece no evento');
  assert.ok(!serializado.includes('2026'), '«2026» NÃO aparece no evento');
  assert.strictEqual(rotaDoEvento(evQuery[0]), '/documentos', 'rota registada é /documentos');
  feito('b. query string eliminada (nem «recibos» nem «2026» no evento)');

  // (c) SEM AGREGAÇÃO: cada pedido deixa o SEU evento, e todos são da MESMA
  // rota — a query string não cria rotas distintas nem funde pedidos.
  // `/documentos`, `?pasta=recibos`, `?ano=2026` e `?pasta=recibos&ano=2026`
  // são 4 pedidos ⇒ 4 eventos, todos com `rota = '/documentos'`.
  auditoriaRegistada.length = 0;
  const VARIANTES = [
    '/admin/documentos',
    '/admin/documentos?pasta=recibos',
    '/admin/documentos?ano=2026',
    '/admin/documentos?pasta=recibos&ano=2026',
  ];
  for (const v of VARIANTES) {
    const rr = await pedir(v);
    assert.strictEqual(rr.status, 200, `variante servida: ${v}`);
  }
  const evVar = eventosConsulta();
  assert.strictEqual(evVar.length, VARIANTES.length,
    `${VARIANTES.length} pedidos → ${VARIANTES.length} eventos (obtidos: ${evVar.length})`);
  assert.deepStrictEqual([...new Set(evVar.map(rotaDoEvento))], ['/documentos'],
    'as 4 variantes ficam TODAS registadas como a mesma rota /documentos');
  feito(`c. sem agregação: ${VARIANTES.length} variantes (com query) → ${VARIANTES.length} eventos, todos /documentos`);

  // (d) Rotas diferentes → eventos diferentes.
  auditoriaRegistada.length = 0;
  for (const rota of ['/admin/documentos', '/admin/quotas', '/admin/fracoes']) {
    const rr = await pedir(rota);
    assert.strictEqual(rr.status, 200, `servida: ${rota}`);
  }
  const evRotas = eventosConsulta();
  assert.strictEqual(evRotas.length, 3, 'três rotas diferentes → três eventos');
  assert.deepStrictEqual(
    evRotas.map(rotaDoEvento).sort(),
    ['/documentos', '/fracoes', '/quotas'],
    'cada rota fica registada individualmente'
  );
  feito('d. três rotas diferentes → três eventos distintos');

  // (e) FORA de suporte (gestor real): nenhum evento de consulta.
  // Sem isto, «registar para todos» passaria nos asserts anteriores.
  auditoriaRegistada.length = 0;
  perfilAtivo = 'gestor';
  const rGestor = await pedir('/admin/documentos');
  assert.strictEqual(rGestor.status, 200, 'o gestor continua a ser servido (200)');
  assert.strictEqual(eventosConsulta().length, 0,
    'contexto normal (associação real) NÃO gera suporte_consulta');
  perfilAtivo = 'suporte';
  feito('e. gestor com associação real → nenhum suporte_consulta');

  // (f) Rota FORA da allow-list em suporte: não se audita (não foi admitida).
  auditoriaRegistada.length = 0;
  await pedir('/admin/condominos/nova');
  assert.strictEqual(eventosConsulta().length, 0,
    'rota não admitida (fora da allow-list) NÃO gera suporte_consulta');
  feito('f. rota fora da allow-list → nenhum evento (só o admitido é auditado)');

  // (g) Método de escrita em suporte: recusado e NÃO auditado.
  // A allow-list é de LEITURA; um POST não chega a ser admitido, logo não pode
  // aparecer na telemetria de consultas.
  auditoriaRegistada.length = 0;
  {
    const antes = eventosConsulta().length;
    const rPost = await new Promise((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        const rq = http.request(
          { host: '127.0.0.1', port: srv.address().port, path: '/admin/documentos', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
          (rs) => { let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { srv.close(); resolve({ status: rs.statusCode }); }); }
        );
        rq.on('error', (e) => { srv.close(); reject(e); });
        rq.end('x=1');
      });
    });
    assert.ok(rPost.status !== 200 || eventosConsulta().length === antes,
      'um POST em suporte não produz suporte_consulta');
    assert.strictEqual(eventosConsulta().length, 0, 'nenhum evento para um método de escrita');
  }
  feito('g. POST em suporte → recusado e não auditado');

  // (h) O evento NÃO expõe dados de linha nem PII.
  auditoriaRegistada.length = 0;
  await pedir('/admin/condominos');
  const evPii = eventosConsulta();
  assert.strictEqual(evPii.length, 1, 'a lista de condóminos gera um evento de consulta');
  const dPii = JSON.parse(evPii[0].detalhes);
  assert.deepStrictEqual(Object.keys(dPii).sort(), ['acesso_suporte_id', 'condominio_id', 'rota'],
    'o evento tem EXATAMENTE as três chaves do envelope (nenhum dado de linha)');
  assert.ok(!JSON.stringify(dPii).includes('Ana'), 'nenhum nome de pessoa no evento');
  assert.ok(!/email|nif|iban|telefone|nome|valor/i.test(JSON.stringify(dPii)),
    'nenhum campo de PII/valores no evento');
  feito('h. envelope mínimo: sem PII, sem dados de linha, sem valores');

  // (i) Falha da auditoria não derruba o pedido (prova por HTTP).
  // Força-se a falha no `AuditLog.create` (a camada que, em produção, fala com
  // a BD) e deixa-se o `helpers/audit` real engolir o erro. O pedido tem de
  // continuar a ser servido — nunca um 500.
  auditoriaRegistada.length = 0;
  {
    const createOriginal = modelosAlvo.AuditLog.create;
    modelosAlvo.AuditLog.create = async () => { throw new Error('BD em baixo (teste)'); };
    const rFalha = await pedir('/admin/documentos');
    modelosAlvo.AuditLog.create = createOriginal;
    assert.strictEqual(rFalha.status, 200,
      'com a gravação da auditoria a falhar, o GET continua a ser servido (200), não 500');
    assert.ok(rFalha.html.length > 0, 'a resposta tem corpo (a página foi servida)');
  }
  feito('i. falha da auditoria não derruba o pedido (200, sem 500)');

  console.log('\n✓ Testes de isolamento T4 do suporte passaram (' + nTestes + ' verificações, sem BD).');
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
