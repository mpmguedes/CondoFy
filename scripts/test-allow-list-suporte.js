// ═══════════════════════════════════════════════════════════════════
// ALLOW-LIST do suporte diagnóstico — prova comportamental (sem BD, sem rede).
//
// Monta o router REAL `routes/admin.js` com duplos de base de dados e pede, por
// HTTP, um conjunto de rotas COM contexto de suporte e SEM ele. Prova:
//
//   1. as rotas da allow-list são servidas ao suporte (leitura);
//   2. qualquer rota FORA da allow-list é recusada (302), incluindo as que
//      existem e seriam servidas a um gestor normal;
//   3. um método que altera estado continua barrado mesmo numa rota da lista
//      (a allow-list é de LEITURA, não só de caminhos);
//   4. `/admin` continua INACESSÍVEL ao suporte quando não há pedido admitido;
//   5. um utilizador normal (admin/gestor) não é afetado pela allow-list.
//
// Utilização: node scripts/test-allow-list-suporte.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');

// A chave da sessão onde vive a marca de suporte (espelha `helpers/suporte.js`).
const CHAVE_SESSAO_SUPORTE = 'suporte_ativo_id';

let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const COND = { id: 1, designacao: 'Condomínio Exemplo', estado: 'ativo', administracao_nome: null };
const OPERADOR = { id: 9, nome: 'Sup Ort', email: 'sup@plataforma.pt', role: null, role_global: 'super_admin', pessoa_id: null, ativo: true };

// ── Duplos de modelo: tudo o que o router toca devolve vazio ────────
// Os modelos NÃO são substituídos por um Proxy: o router guarda referências
// diretas, pelo que o duplo tem de ser um objeto com os métodos usados. Um
// `require.cache` do módulo `models` serve todos os consumidores.
const Sequelize = require('sequelize');

// ⛔ `config/database` tem de ser duplicado ANTES de `models`: o
// `require('../models')` seguinte carrega `config/database` a sério e deixa-o
// em cache — a partir daí qualquer `require('../config/database')` DIRETO
// (como o de `routes/quotas-modulo.js:14`) recebe a ligação real e tenta
// `127.0.0.1:3306`. O duplo de `models` só cobre quem desestrutura os modelos;
// não cobre `sequelize.fn/col`, que é como `anosDisponiveis()` constrói o
// `DISTINCT ano`. ESTENDE-SE o módulo REAL (que continua a `define`-ir os
// modelos) e substituem-se só os construtores de SQL `fn`/`col` por marcadores
// inertes — a LIGAÇÃO nunca é exercitada. Mesmo padrão de
// `test-orcamento-distribuicao.js` / `test-fcr-orcamento.js` (que duplicam o
// `config/database` inteiro porque lá não precisam de `define`).
{
  const dbPath = require.resolve(path.join(RAIZ, 'config/database'));
  const dbReal = require(dbPath);
  dbReal.fn = (...a) => ({ _fn: a });
  dbReal.col = (c) => ({ _col: c });
  dbReal.literal = (s) => ({ _literal: s });
  dbReal.query = async () => [];
  dbReal.transaction = async () => ({ commit: async () => {}, rollback: async () => {} });
}

const modelsPath = require.resolve(path.join(RAIZ, 'models'));
const vazio = async () => null;
const lista = async () => [];
const conta = async () => 0;
function modelVazio() {
  return {
    findOne: vazio, findByPk: vazio, findAll: lista, count: conta,
    create: async (d) => d, update: async () => [0], destroy: async () => 0,
    increment: async () => {}, decrement: async () => {}, scope: () => modelVazio(),
    aggregate: async () => null, sum: async () => 0, bulkCreate: async (d) => d,
  };
}
const modelosReais = require(modelsPath);
// Um alvo REAL (não um Proxy puro) para que as substituições feitas mais abaixo
// (`modelosDuplo.UserCondominio = …`) sejam visíveis a quem desestrutura no topo
// (`helpers/tenant.js` faz `const { UserCondominio } = require('../models')`).
// Um Proxy sem alvo devolveria sempre um duplo vazio e ignoraria a substituição.
const modelosAlvo = {};
const modelosDuplo = new Proxy(modelosAlvo, {
  get: (t, k) => {
    if (k in t) return t[k];
    if (k === 'sequelize') return modelosReais.sequelize;
    if (k === 'Sequelize') return Sequelize;
    if (k === 'Op') return Sequelize.Op;
    return modelVazio();
  },
});

// ── Duplos de ajudante ──────────────────────────────────────────────
// Só os ajudantes que TOCAM na BD são substituídos; os puros (money, contactos,
// tenant) correm a sério — é o que garante que os guards são os REAIS e não
// uma reimplementação que poderia divergir.
//
// O acesso de suporte que o duplo devolve quando o âmbito coincide.
const ACESSO = { id: 77, condominio_id: 1, nivel: 'diagnostico', motivo: 'diagnóstico', expira_em: new Date(Date.now() + 3600e3) };

// O `sessionID` é VINCULATIVO: o acesso só é válido na sessão em que foi
// iniciado. O duplo de `vigente` reproduz esse contrato (comparação com
// `req.sessionID`), para que um acesso iniciado numa sessão e usado noutra seja
// recusado — tal como em `helpers/suporte.js`.
let SESSAO_SUPORTE = null;
function sessaoDe(pedido) {
  return pedido && pedido.session && pedido.session.sessao_suporte;
}
function marcarSessao(id) { SESSAO_SUPORTE = id; return id; }
function acessoValidoNaSessao(req) {
  // O vínculo do acesso à sessão é o objeto do bloco §6, que fixa
  // `SESSAO_SUPORTE`. Enquanto ele não estiver fixado, o vínculo NÃO é o que
  // está a ser testado (T1–T5 pedem com sessões novas de cada vez, por
  // construção) — e exigi-lo aqui só testaria o mecanismo de sessão do
  // `express-session`, não a allow-list. O vínculo é provado a sério, com
  // sessões reais, em §6 (e exaustivamente em `scripts/test-suporte.js`).
  if (SESSAO_SUPORTE === null) return true;
  const esperado = SESSAO_SUPORTE;
  if (!esperado || !req.sessionID) return false;
  // O `connect.sid` vem URL-codificado (`s%3A…`) e o `req.sessionID` não
  // (`s:…`). Normaliza-se para uma forma comparável.
  const norm = (v) => {
    let s = String(v);
    try { s = decodeURIComponent(s); } catch (e) { /* mantém */ }
    return s.replace(/^s:/, '').split('.')[0];
  };
  return norm(req.sessionID) === norm(esperado);
}


// O duplo parte do MÓDULO REAL (que é seguro carregar: não toca na BD no
// `require`) e substitui só o que consulta a BD e o que precisa de um acesso
// fixo. Assim, qualquer exportação nova do módulo continua a existir aqui — e o
// teste não fica frágil a cada acrescento.
const suporteReal = require(path.join(RAIZ, 'helpers/suporte'));
const suporteDuplo = {
  ...suporteReal,
  // O que se testa aqui é a ALLOW-LIST do router, não o ciclo de vida do acesso
  // (coberto exaustivamente em scripts/test-suporte.js). O duplo respeita o
  // contrato: `vigente(req, condominioId)` só devolve o acesso quando o
  // condomínio coincide — é isso que faz o `comCondominioAtivo` REAL entrar no
  // contexto de suporte com `req.papelCondominio = null`.
  vigente: async (req, condominioId) => {
    if (!acessoValidoNaSessao(req)) return null;
    if (Number(condominioId) !== ACESSO.condominio_id) return null;
    return ACESSO;
  },
  temAdminAtivo: async () => true,
  iniciar: async () => ({ ok: false }),
  autorizar: async () => ({ ok: false, erro: 'estado_invalido' }),
  recusar: async () => ({ ok: false, erro: 'estado_invalido' }),
  revogar: async () => ({ ok: false, erro: 'estado_invalido' }),
  terminar: async () => ({ ok: false, erro: 'nao_encontrado' }),
  terminarPorSessao: async () => ({ ok: false, erro: 'sem_acesso' }),
  vigentesDe: async () => [],
  contagemPendentes: async () => 0,
  pendentesDe: async () => [],
  ativosDe: async () => [],
  historicoDe: async () => [],
  expirados: async () => 0,
};

const stubs = {
  models: modelosDuplo,
  'helpers/suporte': suporteDuplo,
  'helpers/condominio': { getCondominio: async () => ({ ...COND, toJSON: () => ({ ...COND }) }) },
  'helpers/dashboard': {
    // Só as funções que consultam a BD são substituídas; as puras (sinais,
    // atividade) correm a sério, para o handler não rebentar por falta de uma
    // exportação que não seja relevante para a allow-list.
    ...require(path.join(RAIZ, 'helpers/dashboard')),
    resumoFinanceiroMes: async () => ({ orcamentado: 0, executado: 0, percentagem: 0 }),
    resumoEmAtraso: async () => ({ total: 0, quotas: 0 }),
    orcamentoDoAno: async () => null,
    anexosDeFracao: async () => [],
  },
  'helpers/saldos': {
    ...require(path.join(RAIZ, 'helpers/saldos')),
    resumoCondominio: async () => ({ contas: [] }),
    resumoFracao: async () => ({ totalQuotas: 0, totalPago: 0, emDivida: 0 }),
  },
  'helpers/drive': { isConfigured: () => true, descargarArquivo: async () => null },
  // Estende o módulo real: só o envio/estado que toca na rede é substituído; a
  // superfície do módulo (ex.: `obterEstadoSmtp`) mantém-se intacta. A vista de
  // suporte de `/emails` NÃO expõe a configuração SMTP — expõe apenas o estado.
  'helpers/mailer': {
    ...require(path.join(RAIZ, 'helpers/mailer')),
    smtpConfigured: () => true,
    obterEstadoSmtp: async () => ({ configurado: true, ok: true, erro: null }),
    sendMail: async () => ({ ok: true }),
  },
  'helpers/convites': { estadoDoConvite: () => 'enviado', marcarAceite: async () => ({}) },
  'helpers/background-jobs': { resumo: () => ({ ativas: 0, emErro: 0 }), registar: () => {}, listarTarefas: () => [] },
  'helpers/titularidades': { fracoesDoUtilizador: async () => ({ fracoes: [], terminadas: [] }), historicoDaPessoa: async () => [], estaAtiva: () => true },
  'helpers/documentos-acesso': { verificarDocumento: async () => ({ ok: true }), autorizarAcessoDocumento: async () => ({ ok: true }), servirDocumento: async () => ({ ok: true }), responderRecusa: () => {} },
  // As pastas são PURAS (derivam do registo do condomínio) — correm a sério. Só
  // o que toca na BD fica de fora. Estender o módulo real (em vez de o
  // substituir) evita que um export novo deixe o teste frágil.
  'helpers/documento-pastas': require(path.join(RAIZ, 'helpers/documento-pastas')),
  // `detalhePorEmitir` entrou com o C6. Antes dele, este teste monta
  // `financeiro` ANTES de `quotas-modulo`, pelo que `GET /admin/quotas` era
  // servido pelo handler de `financeiro` — que em produção está SOMBREADO e é
  // código morto. Com a rota morta removida, o pedido chega finalmente ao
  // handler REAL (`quotas-modulo.js`, quem o serve em produção), e o stub tem
  // de cobrir o que ele usa. Um stub incompleto aqui era cobertura enganadora.
  'helpers/recibos': { pagoPorQuota: async () => new Map(), cobertoPorQuota: async () => new Map(), pagamentosDasQuotas: async () => [], periodoLabel: () => '', gerarReciboPDF: async () => Buffer.from(''), detalhePorEmitir: async () => [] },
  'helpers/pdf': { gerarReciboPDF: async () => Buffer.from('') },
  'helpers/audit': { audit: async () => ({}), auditSafe: async () => ({}) },
};

for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// `utilizador_condominios`: nenhuma associação real (é o que força a via do
// suporte em `comCondominioAtivo`). O duplo do `models` já devolve vazio, mas
// `associacaoAtiva` é chamada via `helpers/tenant` — que corre a sério, logo
// usa o duplo de `models`. Confirmado pelo comportamento abaixo.

// ── Aplicação de teste ──────────────────────────────────────────────
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

// `res.locals.condominioAtivo` é usado pelas vistas. No app real é preenchido
// DEPOIS de `comCondominioAtivo` resolver o contexto; aqui resolve-se com um
// `getter` que lê o pedido no momento da renderização — a ordem deixa de
// importar e o valor é sempre o que o guard REAL tiver resolvido.
Object.defineProperty(app, 'locals', { value: app.locals });
app.use((req, res, next) => {
  res.locals = new Proxy(res.locals, {
    get: (t, k) => {
      if (k === 'condominioAtivo') {
        return { id: req.condominioId || 1, designacao: COND.designacao, role: req.papelCondominio || null };
      }
      if (k === 'isAdmin') return req.papelCondominio === 'admin';
      if (k === 'suporte') return req.suporte || null;
      if (k === 'tarefas') return { ativas: 0, emErro: 0 };
      return t[k];
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  next();
});

// Perfil do pedido: `suporte` (sem associação → a via do suporte) ou
// `admin`/`gestor` (utilizador normal). O contexto NÃO é forjado aqui: é o
// `comCondominioAtivo` REAL do router que o resolve, a partir da sessão — só
// assim se testa o encadeamento verdadeiro (e a ordem da allow-list face aos
// guards reais).
let PERFIL = 'suporte';
app.use((req, res, next) => {
  req.user = PERFIL === 'suporte'
    ? OPERADOR
    : { id: 42, nome: 'Ana', role_global: null, ativo: true, email: 'ana@exemplo.pt' };
  req.isAuthenticated = () => true;
  // O condomínio ativo vem da SESSÃO (como em produção).
  req.session.condominio_ativo_id = 1;
  // A marca de suporte na SESSÃO (a única coisa que a sessão de suporte guarda).
  // É o que a guarda GLOBAL de `/condomino` lê — ela corre antes de qualquer
  // router, quando `req.suporte` ainda não existe. Só no perfil de suporte.
  if (PERFIL === 'suporte') req.session[CHAVE_SESSAO_SUPORTE] = ACESSO.id;
  else delete req.session[CHAVE_SESSAO_SUPORTE];
  res.locals.user = req.user;
  res.locals.tarefas = { ativas: 0, emErro: 0 };
  res.locals.currentPath = req.path;
  res.locals.suporte = null;
  next();
});

// Associações reais: nenhuma para o operador de suporte; uma para o utilizador
// normal. `helpers/tenant` (REAL) lê-as pelo duplo de `models`.
const UserCondominioDuplo = {
  findOne: async ({ where }) => {
    if (PERFIL === 'suporte') return null; // sem associação → via do suporte
    return where && where.utilizador_id === 42
      ? { id: 1, utilizador_id: 42, condominio_id: 1, role: PERFIL, estado: 'ativo' }
      : null;
  },
  findAll: async () => [],
  count: async () => 0,
};
modelosDuplo.UserCondominio = UserCondominioDuplo;

// Uma fração mínima: a ficha (`/fracoes/:id`) devolve 302 se não a encontrar —
// e o que aqui se testa é o ACESSO à rota, não o conteúdo. Com uma fração
// presente, a rota permitida conclui o pedido.
modelosDuplo.Fracao = {
  ...modelVazio(),
  findOne: async () => ({ id: 5, condominio_id: 1, identificacao: 'A', pessoas: [], toJSON() { return { id: 5, condominio_id: 1, identificacao: 'A' }; } }),
};
// Uma quota mínima: `financeiro GET /quotas/:id` faz `Quota.findOne` com âmbito
// e, SEM registo, devolve 302 para `/admin/quotas` — o que aqui se leria como
// «recusado» quando é, na verdade, «admitido mas inexistente». Com a quota
// presente, o handler RENDERIZA e o pedido conclui como admissão real. (É o
// mesmo raciocínio do `Fracao` acima: testa-se o ACESSO à rota, não o conteúdo.)
// ⚠️ A quota traz `condominio_id: 1` para casar com o âmbito do `where` — o
// handler filtra por `{ id, condominio_id }` e um stub sem o campo devolveria
// o mesmo 302. `toJSON` mantém o contrato do modelo real.
modelosDuplo.Quota = {
  ...modelVazio(),
  findOne: async () => ({
    id: 1, condominio_id: 1, fracao_id: 5, valor: 25, ano: 2026, mes: 1,
    estado: 'pendente', numero_documento: 'Q/2026/1', data_vencimento: null,
    toJSON() { return { id: 1, condominio_id: 1, fracao_id: 5, valor: 25 }; },
  }),
};
// Rotas admitidas do módulo `admin` — espelha `LISTA.admin`. `/fracoes/:id`
// NÃO consta (deliberadamente excluído: ficha que junta identidade e finanças).
const ROTAS_PERMITIDAS_ADMIN = ['/', '/fracoes', '/condominos', '/tarefas'];

// ── Todos os routers de `/admin` (T1/T2/T3/T4 por módulo) ───────────
// Cada módulo é um ROUTER SEPARADO com a sua própria admissão. A allow-list só
// é verdadeiramente fechada se TODOS eles forem montados — daí este mapa.
// `rotas`: caminhos do módulo que DEVEM ser servidos ao suporte (da `LISTA`).
// `fora`: caminhos do mesmo módulo que DEVEM ser recusados (existem, mas não
//         constam da lista).
const MODULOS = [
  { ficheiro: 'admin', rotas: ['/', '/fracoes', '/condominos', '/tarefas'],
    fora: ['/fracoes/nova', '/fracoes/5', '/fracoes/5/editar', '/condominos/nova', '/condominos/5/editar', '/utilizadores', '/utilizadores/nova', '/suporte'] },
  // ⛔ A ORDEM DESTA LISTA É A ORDEM DE MONTAGEM (ver o `for` abaixo) e TEM DE
  // ESPELHAR `app.js`: `quotas-modulo` é montado ANTES de `financeiro`. É essa
  // ordem que torna `GET /quotas` de `financeiro` código morto — foi por isso
  // que o C6 (`809e92f`) o removeu. Montar `financeiro` primeiro (como este
  // teste fazia) punha o pedido a cair no handler REAL de `quotas-modulo`, que
  // consulta a BD a sério: um ECONNREFUSED a esconder um problema de ORDEM, não
  // de dados. `/quotas` deixa de constar de `financeiro` (já não vive lá).
  { ficheiro: 'quotas-modulo', rotas: ['/quotas', '/quotas/grelha', '/quotas/conta-corrente'],
    fora: ['/quotas/comprovativos', '/quotas/recibos', '/quotas/transitados'] },
  { ficheiro: 'financeiro', rotas: ['/quotas/1', '/quotas/grelha', '/pagamentos', '/pagamentos/1', '/despesas', '/movimentos', '/contas'],
    fora: ['/quotas/gerar', '/quotas/enviar', '/pagamentos/nova', '/despesas/nova', '/contas/nova', '/contas/transferir-fcr', '/categorias'] },
  { ficheiro: 'extra-quotas', rotas: ['/quotas-extra', '/quotas-extra/1'],
    fora: ['/quotas-extra/nova', '/quotas-extra/1/editar'] },
  { ficheiro: 'orcamento', rotas: ['/orcamento', '/orcamento/1'],
    fora: ['/orcamento/nova', '/orcamento/1/editar', '/orcamento/1/distribuicao', '/orcamento/1/plano', '/orcamento/1/emitir', '/orcamento/1/historico'] },
  { ficheiro: 'assembleias', rotas: ['/assembleias', '/assembleias/1'],
    fora: ['/assembleias/nova', '/assembleias/1/editar', '/assembleias/1/convocatoria', '/assembleias/1/ata'] },
  { ficheiro: 'documentos', rotas: ['/documentos'],
    fora: ['/documentos/nova', '/documentos/1/ficheiro', '/documentos/drive/pasta', '/documentos/1/email'] },
  { ficheiro: 'emails', rotas: ['/emails'],
    // Escrita da Central de Emails (reenviar/cancelar/notificações): existe no
    // módulo mas NÃO consta da allow-list — o suporte diagnostica, não opera.
    // (A configuração SMTP e o envio de teste já não vivem neste módulo: foram
    // para Configuração → Email/SMTP, fora de qualquer admissão de suporte.)
    fora: ['/emails/notificacoes', '/emails/1/reenviar', '/emails/1/cancelar'] },
  { ficheiro: 'relatorios', rotas: ['/relatorios/financeiro'], fora: [] },
];

for (const m of MODULOS) {
  app.use('/admin', require(`../routes/${m.ficheiro}`));
}

// ── A ORDEM acima TEM DE ser a de `app.js` ─────────────────────────
// A allow-list admite por CAMINHO, não por router — logo um caminho admitido
// pode ser servido por um router diferente do que o teste tem em mente, e o
// que decide qual é a ORDEM de montagem. Montar por uma ordem diferente da de
// produção testava um encadeamento que NÃO existe: com `financeiro` antes de
// `quotas-modulo`, `GET /admin/quotas` caía no handler REAL de `quotas-modulo`
// (que consulta a BD) em vez do `financeiro` (que já não o tinha) — o teste
// passava a exercitar um pedido que produção nunca faz. Guarda-se a
// invariante, tal como `test-quotas-isolamento.js` a guarda em `app.js`.
{
  const fonteApp = require('fs').readFileSync(path.join(RAIZ, 'app.js'), 'utf8');
  const ordemApp = fonteApp
    .match(/app\.use\('\/admin',\s*require\('\.\/routes\/[a-z-]+'\)\)/g)
    .map((s) => s.match(/routes\/([a-z-]+)/)[1]);
  const montados = MODULOS.map((m) => m.ficheiro);
  const soOrdenaveis = montados.filter((f) => ordemApp.includes(f));
  assert.deepStrictEqual(
    soOrdenaveis,
    ordemApp.filter((f) => montados.includes(f)),
    'a ORDEM de montagem de `MODULOS` tem de ser a de `app.js` — sem isso o '
    + 'teste exercita um encadeamento que produção não faz (era o defeito que '
    + 'escondia `GET /admin/quotas` atrás de um ECONNREFUSED)'
  );
}

// ── Coerência: a lista montada AQUI tem de ser a `LISTA` real ──────
// Este teste mantém a sua própria lista de módulos (precisa de saber que
// ficheiro montar), mas essa lista NÃO pode divergir da `LISTA` — senão um
// módulo admitido ao suporte simplesmente deixaria de ser exercitado por HTTP,
// com o teste a continuar verde. É a mesma classe de defeito do front-gate:
// código correto que ninguém verifica. Deriva-se da FONTE ÚNICA.
const allowlistReal = require(path.join(RAIZ, 'helpers', 'suporte-allowlist'));

// (a) todo o módulo da LISTA é montado aqui, e cada router montado existe;
// (b) nenhum módulo extra é montado só neste teste;
// (c) cada módulo da LISTA declara router (ou seja, é verificável).
{
  const modulosDaLista = allowlistReal.MODULOS.slice().sort();
  const modulosMontados = MODULOS.map((m) => m.ficheiro).sort();
  assert.deepStrictEqual(
    modulosMontados,
    modulosDaLista,
    `test-allow-list: os módulos montados (${modulosMontados.join(', ')}) têm de coincidir `
    + `com a LISTA (${modulosDaLista.join(', ')}). Um módulo novo na LISTA tem de ser `
    + 'acrescentado a `MODULOS` neste teste e ao mapa `ROUTERS` do allow-list.'
  );

  const co = allowlistReal.incoerencias((f) => require('fs').existsSync(path.join(RAIZ, f)));
  assert.deepStrictEqual(co.semRouter, [], `módulos da LISTA sem router declarado: ${co.semRouter.join(', ')}`);
  assert.deepStrictEqual(
    co.ficheiroInexistente, [],
    `módulos da LISTA com router inexistente: ${co.ficheiroInexistente.map((x) => x.modulo).join(', ')}`
  );
  assert.deepStrictEqual(co.routersOrfaos, [], `routers declarados sem módulo na LISTA: ${co.routersOrfaos.join(', ')}`);

  // Cada módulo da LISTA tem de ter também as rotas admitidas declaradas aqui,
  // para serem realmente pedidas por HTTP (não bastar estar na LISTA).
  //
  // A comparação é de PADRÕES, não de caminhos literais: a `LISTA` guarda
  // `rotulo` (`/quotas/:id`) e este teste pede o caminho concreto (`/quotas/1`).
  // Normaliza-se o literal para o rótulo (`\d+` → `:id`) antes de comparar.
  const comoRotulo = (p) => p.replace(/\/\d+$/, '/:id');
  for (const m of MODULOS) {
    const doModulo = allowlistReal.caminhosDo(m.ficheiro).slice().sort();
    const doTeste = m.rotas.map(comoRotulo).sort();
    assert.deepStrictEqual(
      doTeste,
      doModulo,
      `test-allow-list: as rotas de «${m.ficheiro}» neste teste (${doTeste.join(', ')}) `
      + `têm de coincidir com a LISTA (${doModulo.join(', ')})`
    );
  }
  feito(`coerência LISTA↔teste: ${modulosDaLista.length} módulos e todas as rotas coincidem`);
}

// ── A exceção do módulo `emails` tem de ser CONSCIENTE, não acidental ──
// `/emails` é o único módulo admitido cujo router exige o papel `admin` do
// condomínio (os outros exigem `gestor`), pelo que o nível `diagnostico`
// alcança aqui algo que um gestor do próprio condomínio não alcança. A decisão
// foi mantê-lo (ver a justificação em `helpers/suporte-allowlist.js`).
//
// Esta asserção NÃO afirma que o mínimo é `gestor` — seria falso para `emails`
// e faria o teste mentir. Afirma o que interessa: que a lista de módulos que
// exigem `admin` é EXATAMENTE a esperada. Se alguém admitir mais um módulo
// `admin` sem o declarar aqui, isto falha e obriga a uma decisão explícita.
{
  const fs = require('fs');
  const EXCECOES_ADMIN = ['emails'];
  const deAdmin = [];
  for (const modulo of allowlistReal.MODULOS) {
    const fonte = fs.readFileSync(path.join(RAIZ, allowlistReal.routerDo(modulo)), 'utf8');
    const guarda = fonte.match(/comPapelOuSuporteAdmitido\('([a-z]+)'\)/);
    assert.ok(guarda, `routes/${modulo}: tem de montar a guarda condicional (comPapelOuSuporteAdmitido)`);
    if (guarda[1] === 'admin') deAdmin.push(modulo);
  }
  assert.deepStrictEqual(
    deAdmin.sort(),
    EXCECOES_ADMIN.slice().sort(),
    'os módulos admitidos que exigem `admin` do condomínio mudaram '
    + `(${deAdmin.join(', ') || 'nenhum'}). Se for intencional, atualize EXCECOES_ADMIN `
    + 'NESTE teste e justifique em `helpers/suporte-allowlist.js`; se não, o módulo '
    + 'não devia ser admitido ao suporte (nível `diagnostico` acima do gestor).'
  );
  feito(`exceção de privilégio consciente: só ${EXCECOES_ADMIN.join(', ')} exige admin do condomínio`);
}

// A guarda GLOBAL de `/condomino` (espelha `app.js`): o suporte é recusado antes
// de qualquer router do portal, e é reencaminhado para `/admin`. Usa a guarda
// REAL do `tenant` — que lê a marca da SESSÃO, porque `req.suporte` só existe
// depois de um router montar `comCondominioAtivo` (e esta corre antes disso).
app.use('/condomino', require(path.join(RAIZ, 'helpers/tenant')).bloqueioSuporteNaSessao);
app.use('/condomino', require('../routes/condomino'));
app.use((err, req, res, next) => {
  console.error('[erro no handler]', err.message);
  res.status(500).send('ERRO_NO_HANDLER: ' + err.message);
});

function pedir(caminho, metodo = 'GET', cookie = null) {
  return new Promise((resolve, reject) => {
    const cabecalhos = {};
    if (cookie) cabecalhos.cookie = cookie;
    const servidor = app.listen(0, '127.0.0.1', () => {
      const req = http.request({ host: '127.0.0.1', port: servidor.address().port, path: caminho, method: metodo, headers: cabecalhos }, (res) => {
        let corpo = '';
        res.on('data', (d) => { corpo += d; });
        res.on('end', () => {
          servidor.close();
          resolve({
            status: res.statusCode,
            local: res.headers.location,
            html: corpo,
            setCookie: res.headers['set-cookie'] || [],
          });
        });
      });
      req.on('error', (e) => { servidor.close(); reject(e); });
      req.end();
    });
  });
}

// Extrai o `connect.sid` de uma resposta (para reutilizar a MESMA sessão).
function cookieDe(resp) {
  const linha = (resp.setCookie || []).find((c) => /^connect\.sid=/.test(c));
  return linha ? linha.split(';')[0] : null;
}

// Cria uma sessão real e devolve o cookie com que a reutilizar.
async function criarSessao(caminho = '/admin/') {
  const r = await pedir(caminho);
  const cookie = cookieDe(r);
  if (!cookie) throw new Error('não foi possível obter o cookie de sessão');
  return cookie;
}

// ─────────────────────────────────────────────────────────────────────
(async () => {
  // ── 1. As rotas da allow-list são servidas ao suporte ─────────────
  titulo('Allow-list: rotas servidas ao suporte (módulo admin)');
  PERFIL = 'suporte';
  for (const r of ROTAS_PERMITIDAS_ADMIN) {
    const resp = await pedir(`/admin${r}`);
    assert.notStrictEqual(resp.status, 500, `suporte: ${r} não rebenta o handler`);
    assert.ok(!/ERRO_NO_HANDLER/.test(resp.html), `suporte: ${r} sem exceção no handler`);
    feito(`GET /admin${r} → servido ao diagnóstico (${resp.status})`);
  }

  // ── 2. Rotas FORA da allow-list são recusadas (módulo admin) ──────
  // Cada uma destas existe mesmo e seria servida a um gestor normal — o que se
  // prova é que o SUPORTE não a alcança.
  titulo('Allow-list: rotas fora da lista recusadas (módulo admin)');
  const FORA = [
    '/fracoes/nova', '/fracoes/5', '/fracoes/5/editar', '/condominos/nova',
    '/condominos/5/editar', '/utilizadores', '/utilizadores/nova', '/suporte',
  ];
  for (const r of FORA) {
    const resp = await pedir(`/admin${r}`);
    assert.strictEqual(resp.status, 302, `suporte: ${r} é recusado (302)`);
    // O destino é o da guarda de papel do backoffice (`tenant.comPapel`, que
    // reencaminha para `/`): a recusa é a MESMA que um utilizador sem papel
    // sofre. Não se fixa aqui um destino próprio do suporte — não existe.
    assert.ok(resp.local && resp.local !== `/admin${r}`,
      `suporte: ${r} NÃO é servido (reencaminhado para ${resp.local})`);
    feito(`GET /admin${r} → recusado (302 ${resp.local})`);
  }

  // ── 2-bis. T1 POR MÓDULO: admitido vs. recusado, router a router ──
  // A allow-list só vale se CADA router de `/admin` a montar. Aqui prova-se,
  // por HTTP, que em CADA módulo as rotas da `LISTA` são servidas e as restantes
  // (que existem de verdade) são recusadas. É esta prova que falha se um router
  // deixar de montar `soDiagnostico`, ou se alguém acrescentar uma rota e a
  // listar por engano.
  titulo('T1 — allow-list por módulo (router a router)');
  PERFIL = 'suporte';
  for (const m of MODULOS) {
    for (const r of m.rotas) {
      const resp = await pedir(`/admin${r}`);
      assert.notStrictEqual(resp.status, 500, `suporte [${m.ficheiro}]: ${r} não rebenta`);
      assert.ok(!/ERRO_NO_HANDLER/.test(resp.html), `suporte [${m.ficheiro}]: ${r} sem exceção`);
      // ADMITIDO = de facto servido ao suporte. Uma rota que caia na guarda de
      // papel devolve 302 para `/`/`/condominios`/`/login` — e a REDE DE
      // SEGURANÇA de `routes/admin.js` (:1688) devolve 302 para `/admin`
      // EXATO. Nenhum destes é uma admissão: é uma RECUSA, e não pode passar
      // por admissão (era o ponto cego que deixava uma remoção da allow-list
      // passar despercebida).
      //
      // ⛔ A comparção com o destino de recusa tem de ser EXATA e incluir
      // `/admin` (bare): a rede de segurança redireciona para lá. Um
      // `startsWith('/admin')` daria este destino por «admitido» e cegava o
      // teste à mutação #7 de `test-mutacao-suporte.js` (falso verde detetado).
      //
      // Passando esse crivo, o destino é uma página SERVIDA da aplicação — a
      // própria rota admitida, um caminho admitido de OUTRO módulo (a admissão
      // é por CAMINHO, não por router: `/quotas/grelha` é servido por
      // `quotas-modulo` e reencaminha para `/quotas`), ou um redirecionamento
      // de compatibilidade do backoffice (ex.: `/pagamentos` →
      // `/admin/quotas/comprovativos`, que por decisão não está na lista).
      if (resp.status === 302) {
        const destino = resp.local || '';
        const RECUSAS = ['/', '/admin', '/condominios', '/login'];
        const semAdmin = destino.replace(/^\/admin/, '') || '/';
        const eAdmitido = !RECUSAS.includes(destino)
          && (destino === `/admin${r}`
            || allowlistReal.caminhoAdmitidoEmAlgumModulo(semAdmin)
            // Página concreta do backoffice (uma SUBROTA de `/admin`) —
            // exclui o próprio `/admin` e já está fora das RECUSAS acima.
            || /^\/admin\/[a-z-]/.test(destino));
        assert.ok(eAdmitido,
          `suporte [${m.ficheiro}]: ${r} foi RECUSADO (302 ${destino}) — não é admitido`);
      }
      feito(`[${m.ficheiro}] GET /admin${r} → admitido (${resp.status}${resp.local ? ' ' + resp.local : ''})`);
    }
    for (const r of m.fora) {
      const resp = await pedir(`/admin${r}`);
      assert.strictEqual(resp.status, 302,
        `suporte [${m.ficheiro}]: ${r} tem de ser recusado (302, recebeu ${resp.status})`);
      assert.ok(resp.local && resp.local !== `/admin${r}`,
        `suporte [${m.ficheiro}]: ${r} não é servido`);
      feito(`[${m.ficheiro}] GET /admin${r} → recusado (302 ${resp.local})`);
    }
  }

  // ── 2-ter. T1: uma rota NOVA (não listada) nasce inacessível ──────
  // A propriedade que faz a lista envelhecer bem: o caminho é comparado por
  // PADRÃO COMPLETO. Uma rota que partilhe o prefixo de uma admitida
  // (`/quotas/qualquer-coisa-nova`) fica FORA por omissão.
  titulo('T1 — rota nova não listada nasce inacessível');
  for (const r of ['/quotas/rota-nova-inexistente', '/pagamentos/1/extra', '/documentos/1/qualquer', '/emails/1/qualquer']) {
    const resp = await pedir(`/admin${r}`);
    assert.strictEqual(resp.status, 302,
      `suporte: rota nova ${r} tem de cair (302, recebeu ${resp.status})`);
    feito(`GET /admin${r} → fora da lista (302)`);
  }

  // ── 2-quater. T5: o suporte NUNCA entra no portal do condómino ────
  // O portal tem quatro routers. Aqui prova-se a negação GLOBAL (montada em
  // `app.js` antes das montagens) — que é a que sobrevive a uma reordenação.
  titulo('T5 — portal do condómino fechado ao suporte');
  for (const r of ['/condomino', '/condomino/perfil', '/condomino/documentos', '/condomino/quotas',
    '/condomino/recibos', '/condomino/assembleias', '/condomino/avisos', '/condomino/orcamento', '/condomino/saida']) {
    const resp = await pedir(r);
    assert.strictEqual(resp.status, 302, `suporte: ${r} tem de ser recusado (302, recebeu ${resp.status})`);
    assert.strictEqual(resp.local, '/admin', `suporte: ${r} redireciona para /admin (recebeu ${resp.local})`);
    feito(`GET ${r} → recusado (302 /admin)`);
  }

  // ── 3. A allow-list é de LEITURA: um método de escrita cai ────────
  // Duas guardas concorrem aqui (defesa em profundidade): o crivo de leitura
  // (`somenteLeitura`) e a guarda de papel do router. Em produção, um POST de
  // suporte é recusado por AMBAS. Para que o teste detete a remoção de QUALQUER
  // uma delas, a recusa é verificada por DOIS ângulos:
  //
  //   (a) nenhum handler de escrita é alcançado por HTTP;
  //   (b) o crivo de leitura é exercitado ISOLADAMENTE (com um pedido que NÃO
  //       tem papel de condomínio, logo sem a segunda guarda a ajudar) — é esta
  //       alínea que falha se `somenteLeitura` for retirado do `soDiagnostico`.
  titulo('Allow-list: método de escrita barrado mesmo em caminho da lista');
  for (const r of ROTAS_PERMITIDAS_ADMIN) {
    const resp = await pedir(`/admin${r}`, 'POST');
    assert.strictEqual(resp.status, 302, `suporte: POST /admin${r} é recusado (302)`);
    assert.ok(!/ERRO_NO_HANDLER/.test(resp.html), `suporte: POST /admin${r} não chega a um handler`);
    feito(`POST /admin${r} → recusado (302 ${resp.local})`);
  }

  // (b) O crivo de leitura sozinho. Reproduz-se o encadeamento REAL do
  // `soDiagnostico` (o guard do router) sobre um pedido de suporte com método
  // de escrita, e observa-se se o pedido fica ADMITIDO. Com a guarda, não fica;
  // sem ela, ficaria — e o teste falha.
  titulo('Allow-list: o crivo de leitura nega por si só (sem depender do papel)');
  const tenantReal = require(path.join(RAIZ, 'helpers/tenant'));
  function pedidoDeSuporte(method, caminho) {
    const req = {
      suporte: { id: 1, condominioId: 1, nivel: 'diagnostico' },
      method, path: caminho, originalUrl: `/admin${caminho}`,
      papelCondominio: null, flash: () => {}, get: () => '/',
      session: {},
    };
    const res = { destino: null, redirect(u) { this.destino = u; return this; } };
    return { req, res };
  }
  // GET é admitido; POST não. O crivo é o mesmo guard que o router usa.
  const getOk = pedidoDeSuporte('GET', '/fracoes');
  tenantReal.somenteLeitura(getOk.req, getOk.res, () => {});
  assert.strictEqual(getOk.res.destino, null, 'GET é admitido pelo crivo de leitura');
  const postNegado = pedidoDeSuporte('POST', '/fracoes');
  tenantReal.somenteLeitura(postNegado.req, postNegado.res, () => {});
  assert.ok(postNegado.res.destino, 'POST é negado pelo crivo de leitura (recusa explícita)');
  feito('o crivo de leitura nega um método de escrita, isoladamente');

  // (c) A recusa de um POST sobre um caminho da lista tem de vir do CRIVO DE
  // LEITURA e não apenas da guarda de papel. Prova-se pelo ENCADEAMENTO REAL:
  // exercita-se o guard `soDiagnostico` do router com um POST e um `comPapel`
  // que ADMITE tudo. Sem o crivo de leitura, o pedido seria marcado como
  // ADMITIDO e chegaria ao handler; com o crivo, é reencaminhado antes.
  //
  // É esta alínea que MORDE na mutação «remover a guarda de leitura»: com o
  // crivo removido, `admitido` passa a `true` e o teste falha.
  titulo('Allow-list: a recusa de escrita vem do CRIVO, não só do papel');

  // O `soDiagnostico` do router é o único sítio onde o crivo de leitura é
  // aplicado à admissão. Desde a extração, a função vive em
  // `helpers/suporte-allowlist.js` (fonte única). Extrai-se de LÁ a FUNÇÃO REAL
  // (via `vm`) e exercita-se com um `req` de suporte e um POST. O `comSuporte`
  // interno é substituído por um que ADMITE tudo — de modo a isolar o crivo de
  // leitura: se ele existir, o pedido é recusado ANTES de chegar ao papel; se
  // tiver sido removido, a admissão marca o pedido e o teste falha.
  const vm = require('vm');
  const allowlistSrc = require('fs').readFileSync(
    path.join(RAIZ, 'helpers', 'suporte-allowlist.js'), 'utf8');
  const fonte = allowlistSrc;
  // Isola o bloco `function soDiagnostico(...) { ... }` (balanceando chavetas).
  const inicio = fonte.indexOf('function soDiagnostico(');
  assert.ok(inicio > 0, 'suporte-allowlist.js: `soDiagnostico` tem de existir (crivo de admissão)');
  let i = fonte.indexOf('{', inicio);
  let nivel = 0;
  let fim = i;
  for (; fim < fonte.length; fim += 1) {
    if (fonte[fim] === '{') nivel += 1;
    else if (fonte[fim] === '}') { nivel -= 1; if (nivel === 0) { fim += 1; break; } }
  }
  const corpo = fonte.slice(inicio, fim);

  // O crivo de leitura tem de estar REFERENCIADO dentro do crivo de admissão.
  // É uma verificação estática, mas o comportamento abaixo confirma-a.
  assert.ok(/somenteLeitura\s*\(/.test(corpo),
    'suporte-allowlist.js: o crivo de admissão TEM de invocar o crivo de leitura (foi removido)');

  // Executa o crivo real num sandbox, com o `tenant` REAL (crivo de leitura
  // verdadeiro) e o resto instrumental. A lista e o `caminhoAdmitido` reais vêm
  // do módulo — a admissão só marca quando o caminho consta da lista DE VERDADE.
  const caminhoAdmitido = (modulo, caminho) =>
    require(path.join(RAIZ, 'helpers', 'suporte-allowlist')).caminhoAdmitido(modulo, caminho);
  // O guard de `admin` consulta a união da lista (é o router PRIMEIRO montado
  // sob `/admin` e a sua guarda de papel corre para todos os caminhos). O
  // sandbox executa o corpo REAL do guard, pelo que esta função tem de estar
  // presente — e é a REAL, não uma reimplementação.
  const caminhoAdmitidoEmAlgumModulo = (caminho) =>
    require(path.join(RAIZ, 'helpers', 'suporte-allowlist')).caminhoAdmitidoEmAlgumModulo(caminho);
  const eSuporteDiagnostico = (req) => Boolean(req && req.suporte && req.suporte.nivel === 'diagnostico');
  const NIVEIS_ADMITIDOS = ['diagnostico'];
  const tenant = {
    comSuporte: () => (req, res, next) => next(), // isola o crivo de leitura
    somenteLeitura: tenantReal.somenteLeitura,
    // ACHADO-02: o guard registra a consulta DEPOIS de admitir. Aqui o objetivo
    // é isolar o crivo de LEITURA, pelo que a telemetria é um no-op — mas tem
    // de existir, senão o corpo real do guard rebentaria no sandbox (a chamada
    // existe no código REAL, que é o que este teste executa).
    auditarConsulta: () => false,
  };
  const ADMITIDO_SUPORTE = Symbol('marca');
  // ACHADO-02: o guard marca o pedido como JÁ AUDITADO (idempotência por pedido,
  // não agregação) e o corpo REAL do guard referencia este símbolo — logo tem de
  // existir no sandbox, com o MESMO nome da fonte real.
  const AUDITADO_SUPORTE = Symbol('marca-auditado');
  const sandbox = {
    LISTA: require(path.join(RAIZ, 'helpers', 'suporte-allowlist')).LISTA,
    NIVEIS_ADMITIDOS,
    caminhoAdmitido,
    caminhoAdmitidoEmAlgumModulo,
    eSuporteDiagnostico,
    tenant,
    ADMITIDO_SUPORTE,
    AUDITADO_SUPORTE,
    process, console,
    req: null, res: null, next: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${corpo}; __guard = soDiagnostico;`, sandbox);
  const guardReal = sandbox.__guard('admin');
  assert.strictEqual(typeof guardReal, 'function', 'suporte-allowlist.js: guard de admissão extraído');

  async function admitir(method, caminho) {
    const req = {
      suporte: { id: 1, condominioId: 1, nivel: 'diagnostico' },
      method, path: caminho, originalUrl: `/admin${caminho}`,
      papelCondominio: null, get: () => '/', flash: () => {}, session: {},
    };
    let recusado = null;
    const res = { redirect(u) { recusado = u; return this; } };
    let seguiu = false;
    await new Promise((resolve) => {
      guardReal(req, res, () => { seguiu = true; resolve(); });
      setTimeout(resolve, 5);
    });
    return { admitido: seguiu && req[ADMITIDO_SUPORTE] === true, recusado, req };
  }

  const getAdmitido = await admitir('GET', '/fracoes');
  assert.ok(getAdmitido.admitido, 'crivo real: GET num caminho da lista é ADMITIDO');
  const postBarrado = await admitir('POST', '/fracoes');
  assert.ok(!postBarrado.admitido,
    'crivo real: POST num caminho da lista NÃO é admitido (guarda de leitura ativa)');
  assert.ok(postBarrado.recusado, 'crivo real: POST é recusado explicitamente');
  const foraBarrado = await admitir('GET', '/utilizadores');
  assert.ok(!foraBarrado.admitido, 'crivo real: caminho fora da lista não é admitido');
  feito('a recusa de escrita é atribuível ao crivo de leitura (e a remoção é detetável)');

  // ── 4. Um utilizador normal não é afetado ─────────────────────────
  titulo('Utilizador normal: comportamento inalterado');
  PERFIL = 'admin';
  for (const r of ROTAS_PERMITIDAS_ADMIN) {
    const resp = await pedir(`/admin${r}`);
    assert.notStrictEqual(resp.status, 302, `admin: ${r} continua acessível (${resp.status})`);
  }
  // E continua a alcançar o que o suporte NÃO alcança.
  for (const r of ['/utilizadores', '/suporte']) {
    const resp = await pedir(`/admin${r}`);
    assert.notStrictEqual(resp.status, 302, `admin: ${r} continua acessível (${resp.status})`);
    feito(`admin: GET /admin${r} continua acessível`);
  }

  // Um gestor continua a entrar nas rotas de leitura (não foi tocado).
  PERFIL = 'gestor';
  for (const r of ROTAS_PERMITIDAS_ADMIN) {
    const resp = await pedir(`/admin${r}`);
    assert.notStrictEqual(resp.status, 302, `gestor: ${r} continua acessível (${resp.status})`);
  }
  feito('gestor: rotas de leitura continuam acessíveis');

  // ── 5. Âmbitos do suporte: nível e vínculo não são contornáveis ───
  titulo('Suporte: contexto ausente não abre a allow-list');
  // Sem `req.suporte`, mas também sem papel de condomínio → nenhum contexto.
  PERFIL = 'nenhum';
  const semContexto = await pedir('/admin/fracoes');
  assert.strictEqual(semContexto.status, 302, 'sem contexto: /admin/fracoes recusa');
  feito('sem contexto (nem suporte nem papel) → recusa');

  // ── 6. O `session_id` do acesso é VINCULATIVO à sessão ────────────
  // Um acesso de suporte só serve na sessão em que foi iniciado. Testa-se o
  // encadeamento REAL do router (via HTTP, com sessões de verdade): o mesmo
  // cookie é servido; um cookie diferente (outra sessão) não.
  titulo('Suporte: o acesso está vinculado à sessão que o iniciou');
  PERFIL = 'suporte';

  // A sessão A é criada primeiro e é nela que o acesso é «iniciado»; o seu
  // `connect.sid` (a parte anterior a `s:` e à assinatura) identifica a sessão,
  // tal como `req.sessionID` do express-session.
  const cookieA = await criarSessao('/admin/');
  const idDeCookie = (c) => c.replace(/^connect\.sid=/, '').replace(/^s:/, '').split('.')[0];
  SESSAO_SUPORTE = idDeCookie(cookieA);

  // Na MESMA sessão, a allow-list serve.
  const mesmaSessao = await pedir('/admin/fracoes', 'GET', cookieA);
  assert.notStrictEqual(mesmaSessao.status, 302,
    'suporte: na mesma sessão, /admin/fracoes é servido');
  feito('mesma sessão → acesso admitido');

  // Noutra sessão (outro cookie), o acesso não vale.
  const cookieB = await criarSessao('/admin/fracoes');
  assert.notStrictEqual(cookieB, cookieA, 'as duas sessões são distintas');
  const outraSessao = await pedir('/admin/fracoes', 'GET', cookieB);
  assert.strictEqual(outraSessao.status, 302,
    'suporte: noutra sessão, o mesmo acesso é recusado');
  feito('sessão diferente → acesso recusado');

  // Sem cookie nenhum: também não vale (fail-closed).
  const semCookie = await pedir('/admin/fracoes', 'GET');
  assert.strictEqual(semCookie.status, 302, 'suporte: sem sessão, o acesso é recusado');
  feito('sem sessão → acesso recusado');

  console.log(`\n✓ Testes da allow-list do suporte passaram (${nTestes} verificações, sem BD).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
