// ═══════════════════════════════════════════════════════════════════
// Painel administrativo — execução REAL do handler (Fase 2H.2).
//
// Monta `routes/admin.js` com duplos de base de dados (sem BD, sem rede) e pede
// `GET /admin` por HTTP: é a única forma de provar que o handler corre, que os
// sinais aparecem com os valores certos e que as ligações são as esperadas.
//
// Cobre: sinais de atenção (com dados e sem nada a tratar), atividade recente,
// próximas assembleias, estado vazio e âmbito por condomínio.
//
// Cobre também (P7): `POST /admin/fracoes/:id/eliminar` — a pré-verificação das
// dependências tem de recusar com a lista exata do que bloqueia, eliminar quando
// não há nada associado, e nunca tocar numa fração de outro condomínio.
//
// Utilização: node scripts/test-rotas-admin-dashboard.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');

const COND = { id: 1, designacao: 'Condomínio Exemplo', morada: 'Rua das Flores 1', codigo_postal: '1000-100', localidade: 'Lisboa', estado: 'ativo', administracao_nome: null };
const ADMIN = { id: 42, nome: 'Ana Gestora', email: 'ana@exemplo.pt', role: 'admin', role_global: null, pessoa_id: 7, ativo: true, email_confirmado: true };
const PESSOA = { id: 7, nome: 'Ana Gestora', condominio_id: 1 };

// O cenário é configurável: com dados (sinais) ou sem nada a tratar.
const CENARIO = process.env.CENARIO_DASH || 'com-dados';
const COM_DADOS = CENARIO === 'com-dados';

// ── Dados de exemplo ───────────────────────────────────────────────
const ANO = new Date().getFullYear();
const MES = new Date().getMonth() + 1;
const HOJE = new Date().toISOString().slice(0, 10);
const QUOTAS = [];
for (let mes = 1; mes <= 12; mes += 1) {
  // Uma quota vencida (mês passado, sem pagamento) e as restantes em ordem.
  const estado = mes === 1 ? 'pendente' : 'paga';
  const vencimento = mes === 1 ? `${ANO}-01-10` : `${ANO}-${String(mes).padStart(2, '0')}-10`;
  if (mes !== MES || COM_DADOS) {
    QUOTAS.push({ id: 200 + mes, condominio_id: 1, fracao_id: 5, ano: ANO, mes, valor: 75, valor_base: 75, valor_fcr: 0, data_vencimento: vencimento, estado });
  }
}
if (!COM_DADOS) {
  // Sem nada a tratar: todas as quotas do ano estão pagas (incluindo as do mês).
  for (const q of QUOTAS) q.estado = 'paga';
}
const ASSEMBLEIAS = COM_DADOS
  ? [
      { id: 30, condominio_id: 1, numero: '2/2026', designacao: 'Assembleia Geral Ordinária', data: `${ANO}-12-12`, hora: '18:30', local: 'Sala comum', estado: 'convocada', toJSON() { return { ...this }; } },
      { id: 31, condominio_id: 1, numero: '3/2026', designacao: 'Assembleia Extraordinária', data: `${ANO}-12-20`, hora: '10:00', local: null, estado: 'agendada', toJSON() { return { ...this }; } },
    ]
  : [];
const AUDITORIA = COM_DADOS
  ? [
      { id: 900, user_id: 42, data_hora: `${HOJE}T10:00:00Z`, acao: 'registar_pagamento', entidade: 'Pagamento', entidade_id: 1, detalhes: '{"valor":75}', user: { id: 42, nome: 'Ana Gestora' }, toJSON() { const { user, ...resto } = this; return resto; } },
      { id: 899, user_id: 42, data_hora: `${HOJE}T09:00:00Z`, acao: 'inicio_sessao', entidade: 'User', entidade_id: 42, detalhes: '{"email":"ana@exemplo.pt"}', user: { id: 42, nome: 'Ana Gestora' }, toJSON() { const { user, ...resto } = this; return resto; } },
      { id: 898, user_id: 42, data_hora: `${HOJE}T08:00:00Z`, acao: 'criar_documento', entidade: 'Documento', entidade_id: 5, detalhes: '{"nome":"Ata.pdf"}', user: { id: 42, nome: 'Ana Gestora' }, toJSON() { const { user, ...resto } = this; return resto; } },
      { id: 897, user_id: 42, data_hora: `${HOJE}T07:00:00Z`, acao: 'gerar_quotas', entidade: 'Quota', entidade_id: null, detalhes: '{"mes":12}', user: { id: 42, nome: 'Ana Gestora' }, toJSON() { const { user, ...resto } = this; return resto; } },
    ]
  : [];

// ── Estado do armazenamento (dois eixos INDEPENDENTES) ────────────
// DOCUMENTOS: serviço principal DESTE condomínio (por condomínio).
// BACKUPS: destino GLOBAL da instalação + a cópia local (sempre existe).
// O cenário «com dados» tem os dois em serviços DIFERENTES (documentos no
// Google Drive, backups no Dropbox) para provar que o painel não os confunde.
const ROTULOS_ARMAZENAMENTO = { google_drive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'Microsoft OneDrive' };
const armazenamento = COM_DADOS
  ? {
      documentosLigado: true,
      // Configurado E utilizável (ligação de plataforma).
      destino: 'dropbox',
      ligacao: { condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' },
    }
  : {
      documentosLigado: true,
      // Sem destino de backups: a cópia local é a única que existe.
      destino: null,
      ligacao: null,
    };

// Último backup: no cenário «com dados» já foi copiado para o Dropbox; no
// cenário calmo existe apenas a cópia local. `let` porque os últimos cenários
// deste teste reescrevem o registo (falha da cópia cloud, erro, sem histórico).
let BACKUP_LOG = COM_DADOS
  ? { id: 1, tipo: 'diario', estado: 'concluido', data: `${HOJE}T03:00:00Z`, ficheiro_drive_id: 'dbx:ficheiro-1', tamanho: 51200, erro: null }
  : { id: 2, tipo: 'diario', estado: 'concluido', data: `${HOJE}T03:00:00Z`, ficheiro_drive_id: null, tamanho: 51200, erro: null };
const DATA_BACKUP = require('../helpers/dates').formatDate(new Date(BACKUP_LOG.data));

function filtro(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && v[String(Symbol.for('op.in'))]) return true; // tratado por consulta
    return true;
  }));
}

// ── Duplos dos modelos (antes de carregar as rotas) ────────────────
const consultas = [];

// Pré-verificação de eliminação de fração (P7). As contagens só respondem
// quando a consulta é por `fracao_id`; as contagens do painel (por condomínio)
// mantêm exatamente o valor de sempre.
const DEP_FRACAO = { quotas: 0, pagamentos: 0, distribuicoes: 0, planos: 0, recibos: 0, titularidades: 0 };
const porFracao = (chave) => (o = {}) => (o.where && o.where.fracao_id !== undefined ? DEP_FRACAO[chave] : 0);
let FRACAO_EXISTE = true;
let eliminacoes = 0;
const FRACAO = {
  id: 5,
  designacao: 'R/C Esquerdo',
  condominio_id: 1,
  async destroy() { eliminacoes += 1; },
};

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    Fracao: {
      count: async (o = {}) => { consultas.push(['Fracao.count', o]); return 8; },
      findAll: async () => [],
      // `carregarFracao` procura pela fração do CONDOMÍNIO ATIVO: um id de outro
      // condomínio (ou inexistente) tem de devolver null.
      findOne: async (o = {}) => (FRACAO_EXISTE && o.where && Number(o.where.id) === FRACAO.id ? FRACAO : null),
    },
    Pessoa: { count: async () => 12, findAll: async () => [PESSOA], findOne: async () => PESSOA },
    UserCondominio: {
      count: async () => 3,
      findAll: async (o = {}) => { consultas.push(['UserCondominio.findAll', o]); return [{ utilizador_id: 42 }, { utilizador_id: 43 }]; },
      findOne: async () => ({ id: 1, role: 'admin', condominio_id: 1 }),
    },
    User: { findByPk: async () => ADMIN, findOne: async () => ADMIN, findAll: async () => [ADMIN], count: async () => 3 },
    Condominio: { findByPk: async () => COND, findOne: async () => COND, findAll: async () => [COND] },
    Quota: {
      findAll: async (o = {}) => { consultas.push(['Quota.findAll', o]); return QUOTAS; },
      count: async (o = {}) => {
        consultas.push(['Quota.count', o]);
        if (o.where && o.where.fracao_id !== undefined) return DEP_FRACAO.quotas;
        return COM_DADOS ? 0 : 8;
      },
      findOne: async () => null, sum: async () => 0,
    },
    Pagamento: {
      findAll: async () => [], findOne: async () => null, sum: async () => 0,
      count: async (o = {}) => {
        consultas.push(['Pagamento.count', o]);
        if (o.where && o.where.fracao_id !== undefined) return DEP_FRACAO.pagamentos;
        return COM_DADOS ? 2 : 0;
      },
    },
    PagamentoQuota: { findAll: async () => [] },
    Despesa: { findAll: async () => [], sum: async () => 0, count: async () => 0 },
    Documento: {
      count: async (o = {}) => { consultas.push(['Documento.count', o]); return COM_DADOS ? 4 : 0; },
      findAll: async () => [], findOne: async () => null,
    },
    Fornecedor: { count: async () => 5, findAll: async () => [], findOne: async () => null },
    PagamentoFornecedor: { count: async (o = {}) => { consultas.push(['PagamentoFornecedor.count', o]); return COM_DADOS ? 2 : 0; } },
    EmailFila: { count: async () => 0, findAll: async () => [] },
    BackupLog: { findOne: async () => (BACKUP_LOG ? { ...BACKUP_LOG } : null) },
    Assembleia: {
      findAll: async (o = {}) => { consultas.push(['Assembleia.findAll', o]); return ASSEMBLEIAS; },
      findOne: async () => null, count: async () => ASSEMBLEIAS.length,
    },
    AuditLog: {
      findAll: async (o = {}) => { consultas.push(['AuditLog.findAll', o]); return AUDITORIA; },
      findOne: async () => null, create: async () => ({}),
    },
    Categoria: { findAll: async () => [], findByPk: async () => null },
    Aviso: { findAll: async () => [], count: async () => 0 },
    AvisoDestinatario: { findAll: async () => [] },
    MetodoPagamento: { findAll: async () => [] },
    ContaBancaria: { findAll: async () => [] },
    Orcamento: { findAll: async () => [], findOne: async () => null, findByPk: async () => null },
    OrcamentoRubrica: { findAll: async () => [] },
    PlanoQuota: { findAll: async () => [], count: porFracao('planos') },
    Recibo: { findAll: async () => [], count: porFracao('recibos') },
    OrcamentoDistribuicao: { count: porFracao('distribuicoes') },
    MovimentoBancario: { findAll: async () => [], sum: async () => 0 },
    FracaoPessoa: { findAll: async () => [] },
    FracaoTitularidade: { findAll: async () => [], count: porFracao('titularidades') },
    // Tips contextuais do painel: o handler lê as dispensas desta conta
    // (`carregarDispensas`). Sem este duplo o bloco dos tips falhava sempre por
    // dentro — em silêncio, porque é tolerante a falhas — e o teste deixava de
    // exercitar o caminho real.
    RecomendacaoEstado: { findAll: async () => [], findOne: async () => null, create: async () => ({}), update: async () => [0] },
    ExtraQuota: { findAll: async () => [], findOne: async () => null },
    ExtraQuotaParcela: { findAll: async () => [] },
  },
};

// Orçamento do ano: o cenário "com dados" tem um orçamento por concluir.
const ORCAMENTO = COM_DADOS
  ? { id: 12, condominio_id: 1, ano: ANO, estado: 'rascunho', data_inicio: `${ANO}-01-01`, data_fim: `${ANO}-12-31`, rubricas: [{ ativo: true, valor_anual: 1000 }], toJSON() { const { rubricas, ...resto } = this; return resto; } }
  : { id: 13, condominio_id: 1, ano: ANO, estado: 'encerrado', data_inicio: `${ANO}-01-01`, data_fim: `${ANO}-12-31`, rubricas: [{ ativo: true, valor_anual: 1000 }], toJSON() { const { rubricas, ...resto } = this; return resto; } };

const stubs = {
  '../helpers/tenant': {
    comCondominioAtivo: (req, res, next) => { req.condominioId = 1; req.papelCondominio = 'admin'; next(); },
    comPapel: () => (req, res, next) => next(),
    // `routes/admin.js` fecha a allow-list do suporte diagnóstico com estes dois
    // guards. Neste teste o pedido é de um `admin` do condomínio (não há
    // `req.suporte`), pelo que ambos são inertes — é o que acontece em produção
    // fora do contexto de suporte.
    comSuporte: () => (req, res, next) => next(),
    semSuporte: (req, res, next) => next(),
    somenteLeitura: (req, res, next) => next(),
    eSuperAdmin: () => false,
    ativo: () => 1,
    listarCondominios: async () => [{ id: 1, designacao: COND.designacao, role: 'admin' }],
    entrarCondominio: async () => true,
    associacaoAtiva: async () => ({ role: 'admin' }),
    papelNoAtivo: async () => 'admin',
    eAdminCondominio: async () => true,
    pertenceAoAtivo: () => true,
    // O painel usa esta função para decidir se mostra os sinais cujo destino
    // exige `admin` (routes/admin.js). Mesma hierarquia de `helpers/tenant.js`.
    papelMaiorOuIgual: (papel, minimo) =>
      ({ admin: 30, gestor: 20, leitura: 10 }[papel] || 0) >=
      ({ admin: 30, gestor: 20, leitura: 10 }[minimo] || 99),
  },
  '../helpers/audit': { audit: async () => ({}), auditSafe: async () => ({}) },
  '../helpers/condominio': { getCondominio: async () => ({ id: 1, designacao: COND.designacao, administracao_nome: null, toJSON() { return { ...COND }; } }) },
  '../helpers/dashboard': {
    // Só o orçamento do ano é substituído; os sinais e a atividade correm a sério.
    ...require(path.join(RAIZ, 'helpers/dashboard')),
    orcamentoDoAno: async () => ORCAMENTO,
  },
  '../helpers/saldos': {
    // Duplo, sem `require` de si próprio (evita recursão): só o que este teste
    // precisa de controlar. O estado efetivo segue a regra real: `vencida` quando
    // o vencimento já passou e a quota não está paga nem anulada.
    estadoEfetivo: (q) => {
      if (!q) return null;
      if (q.estado === 'anulada' || q.estado === 'paga') return q.estado;
      if (q.data_vencimento && new Date(q.data_vencimento) < new Date(HOJE)) return 'vencida';
      return q.estado;
    },
    resumoCondominio: async () => ({ saldoContas: 12480.5, fundoReserva: 3200, receitas: 9000, despesas: 7400, emDividaGlobal: 900, contas: [] }),
    resumoFracao: async () => ({ totalQuotas: 900, totalPago: 825, emDivida: 75 }),
    saldoConta: async (conta) => Number(conta && conta.saldo_inicial) || 0,
    resumoOrcamento: async (ano) => ({ ano, orcamentado: 0, executado: 0, percentagem: 0 }),
    ESTADOS_PENDENTES: ['pendente', 'parcialmente_paga', 'vencida'],
  },
  // Serviços ligados nos dois cenários: o cenário «sem nada a tratar» só pode
  // ficar calmo se o armazenamento dos documentos e o email estiverem ligados
  // (o sinal do armazenamento tem cobertura própria em
  // scripts/test-dashboard-painel.js e a separação documentos/backups em
  // scripts/test-backup-estado.js).
  '../helpers/storage': {
    // DOCUMENTOS: serviço principal do condomínio ativo. O âmbito é exigido:
    // decidir o estado sem condomínio (como fazia a versão anterior) é o defeito
    // que este teste tem de apanhar.
    isConfigured: (condominioId) => {
      assert.strictEqual(condominioId, 1, 'o armazenamento dos documentos resolve-se com o condomínio ativo');
      return armazenamento.documentosLigado;
    },
    // BACKUPS: configuração GLOBAL + ligação que o job consegue usar.
    destinoDeBackup: async () => armazenamento.destino,
    ligacaoDeBackup: () => armazenamento.ligacao,
    obterProvedor: (nome) => (nome
      ? { nome, rotulo: () => ROTULOS_ARMAZENAMENTO[nome] || nome, icone: () => 'bi bi-cloud' }
      : null),
    provedores: () => Object.keys(ROTULOS_ARMAZENAMENTO),
  },
  // Regressão do defeito original: o painel decidia o estado do armazenamento
  // pela ligação da PLATAFORMA. Este duplo rebenta se alguém voltar a usá-lo —
  // o estado tem de vir de `storage` com o condomínio ativo.
  '../helpers/drive': {
    isConfigured: () => { throw new Error('o painel não pode decidir o armazenamento pela ligação da plataforma'); },
    descargarArquivo: async () => null,
  },
  '../helpers/mailer': { smtpConfigured: () => true, sendMail: async () => ({ ok: true }) },
  '../helpers/convites': { estadoDoConvite: () => 'enviado', marcarAceite: async () => ({}) },
  '../helpers/background-jobs': { resumo: () => ({ ativas: 0, emErro: 0 }), registar: () => {} },
  '../helpers/titularidades': {
    fracoesDoUtilizador: async () => ({ fracoes: [], terminadas: [] }),
    historicoDaPessoa: async () => [],
    estaAtiva: () => true,
  },
  '../helpers/contactos': {
    sincronizarContactosPessoa: async () => ({}), parseContactosForm: () => [], validarContactos: () => ({ ok: true, contactos: [] }), contactosParaForm: () => [],
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}
require(path.join(RAIZ, 'config/passport'))(passport);

// ── Aplicação de teste (rota REAL, como no app.js) ────────────────
const { engine } = require('express-handlebars');
const app = express();
app.engine('handlebars', engine({
  // Sem layout: o teste analisa o corpo do painel (o layout tem os seus testes).
  defaultLayout: false,
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
// Avisos (flash) apanhados à mão: as rotas de escrita redirecionam e a mensagem
// viaja na sessão — sem isto não se poderia provar O QUE o utilizador leu.
const FLASHES = [];
app.use((req, res, next) => {
  req.flash = (tipo, msg) => {
    if (msg === undefined) return FLASHES.filter(([t]) => t === tipo).map(([, m]) => m);
    FLASHES.push([tipo, msg]);
    return FLASHES.length;
  };
  next();
});
// O papel do condomínio ativo decide o que o painel mostra. Os testes correm
// com `admin` e repetem as asserções de UI com `gestor` (ver o fim do ficheiro).
let PAPEL = 'admin';
app.use((req, res, next) => {
  req.user = ADMIN;
  req.isAuthenticated = () => true;
  res.locals.user = ADMIN;
  res.locals.isAdmin = true;
  res.locals.tarefas = { ativas: 0, emErro: 0 };
  res.locals.armazenamentoIcone = 'bi bi-cloud';
  res.locals.armazenamentoRotulo = 'Google Drive';
  res.locals.condominioAtivo = { id: 1, designacao: COND.designacao, role: PAPEL };
  res.locals.currentPath = req.path;
  next();
});
app.use('/admin', require('../routes/admin'));
app.use((err, req, res, next) => {
  res.status(500).send('ERRO_NO_HANDLER: ' + err.message);
});

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

// POST (sem corpo): as rotas de escrita redirecionam sempre — o que interessa é
// o código, o destino e o efeito nos duplos dos modelos.
function postar(caminho) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const pedido = http.request(
        { host: '127.0.0.1', port: servidor.address().port, path: caminho, method: 'POST' },
        (res) => {
          res.resume();
          res.on('end', () => {
            servidor.close();
            resolve({ status: res.statusCode, localizacao: res.headers.location, html: '' });
          });
        }
      );
      pedido.on('error', (e) => { servidor.close(); reject(e); });
      pedido.end();
    });
  });
}

const avisos = (tipo) => FLASHES.filter(([t]) => t === tipo).map(([, m]) => m).join(' | ');

// ── P7: eliminação de fração com pré-verificação das dependências ──
async function testarEliminacaoFracao() {
  // (a) Fração com dependências → recusa ANTES de tocar na base de dados, com
  //     a lista exata do que a bloqueia (não a mensagem genérica da FK).
  Object.assign(DEP_FRACAO, { quotas: 3, pagamentos: 0, distribuicoes: 0, planos: 0, recibos: 2, titularidades: 1 });
  FRACAO_EXISTE = true;
  eliminacoes = 0;
  FLASHES.length = 0;
  let r = await postar('/admin/fracoes/5/eliminar');
  assert.strictEqual(r.status, 302, 'com dependências: redireciona (não 500)');
  assert.strictEqual(r.localizacao, '/admin/fracoes', 'com dependências: volta à lista');
  assert.strictEqual(eliminacoes, 0, 'com dependências: NÃO eliminou');
  const recusa = avisos('error_msg');
  assert.match(recusa, /R\/C Esquerdo/, 'a recusa nomeia a fração');
  assert.match(recusa, /3 quotas/, 'diz quantas quotas');
  assert.match(recusa, /2 recibos emitidos/, 'diz quantos recibos emitidos');
  assert.match(recusa, /1 período de titularidade/, 'usa o singular quando é 1 (titularidade)');
  assert.ok(!/pode ter registos associados/.test(recusa), 'já não é a mensagem genérica da FK');
  assert.strictEqual(avisos('success_msg'), '', 'não anuncia sucesso nenhum');

  // (b) Fração sem dependências → elimina, como antes.
  Object.assign(DEP_FRACAO, { quotas: 0, pagamentos: 0, distribuicoes: 0, planos: 0, recibos: 0, titularidades: 0 });
  eliminacoes = 0;
  FLASHES.length = 0;
  r = await postar('/admin/fracoes/5/eliminar');
  assert.strictEqual(eliminacoes, 1, 'sem dependências: elimina');
  assert.match(avisos('success_msg'), /R\/C Esquerdo.*eliminada/s, 'anuncia a eliminação com a designação');

  // (c) Isolamento: fração inexistente (ou de OUTRO condomínio) não é eliminada.
  FRACAO_EXISTE = false;
  eliminacoes = 0;
  FLASHES.length = 0;
  r = await postar('/admin/fracoes/99/eliminar');
  assert.strictEqual(eliminacoes, 0, 'fração de outro condomínio: não elimina');
  assert.match(avisos('error_msg'), /não encontrada neste condomínio/i, 'diz que não é deste condomínio');
  FRACAO_EXISTE = true;
}

(async () => {
  const r = await pedir('/admin');
  assert.strictEqual(r.status, 200, 'painel: responde 200');
  assert.ok(!/ERRO_NO_HANDLER/.test(r.html), 'painel: o handler não lança exceção');
  assert.ok(!/ReferenceError|is not defined/.test(r.html), 'painel: sem erros de referência');

  if (COM_DADOS) {
    // ── Sinais ────────────────────────────────────────────────────
    assert.ok(/Precisa de atenção/.test(r.html), 'painel: secção «Precisa de atenção» presente');
    const itens = r.html.match(/class="atencao-item"/g) || [];
    assert.ok(itens.length >= 5, `painel: vários sinais apresentados (${itens.length})`);
    assert.ok(/1 quota\(s\) em atraso/.test(r.html), 'painel: sinal de quotas em atraso');
    assert.ok(/2 comprovativo\(s\) por validar/.test(r.html), 'painel: sinal de comprovativos por validar');
    assert.ok(/Quotas do mês ainda não geradas/.test(r.html), 'painel: sinal das quotas do mês');
    assert.ok(/2 pagamento\(s\) a fornecedores pendentes/.test(r.html), 'painel: sinal de fornecedores');
    assert.ok(/4 documento\(s\) deste ano ainda não disponibilizados/.test(r.html), 'painel: sinal de documentos');
    assert.ok(/Orçamento de \d{4} em rascunho/.test(r.html), 'painel: sinal do orçamento por concluir');
    // ⛔ A14 §9 — a assembleia futura NÃO é sinal: já tem cartão próprio no
    // painel. Um sinal aqui repetia a informação.
    assert.ok(!/Assembleia a \d{2}\/\d{2}\/\d{4}/.test(r.html), 'painel: a assembleia futura não entra na lista de sinais');
    // Ligações diretas de cada sinal (a da assembleia sai: já não há sinal).
    for (const url of ['/admin/quotas', '/admin/quotas/comprovativos', '/admin/quotas/gerar', '/admin/fornecedores',
      '/admin/documentos', '/admin/orcamento/12']) {
      assert.ok(r.html.includes(`href="${url}"`), `painel: ligação direta para ${url}`);
    }

    // ── A14 §9: as DUAS listas, separadas na prática ───────────────
    // «Ainda não configurou X» nunca aparece ao lado de «existe um problema».
    const iAtencao = r.html.indexOf('Precisa de atenção');
    const iPreparacao = r.html.indexOf('Preparação do condomínio');
    const iTop = r.html.indexOf('Top devedores');
    assert.ok(iAtencao >= 0 && iPreparacao > iAtencao && iTop > iPreparacao,
      'painel: as três âncoras (atenção, preparação, devedores) na ordem esperada');
    const blocoAtencao = r.html.slice(iAtencao, iPreparacao);
    const blocoPreparacao = r.html.slice(iPreparacao, iTop);
    // O orçamento por concluir é PREPARAÇÃO, não um problema.
    assert.ok(/Orçamento de \d{4} em rascunho/.test(blocoPreparacao), 'painel: o orçamento por concluir está na PREPARAÇÃO');
    assert.ok(!/Orçamento de \d{4} em rascunho/.test(blocoAtencao), 'painel: o orçamento por concluir NÃO está na atenção');
    assert.ok(/Requer configuração|Por concluir/.test(blocoPreparacao), 'painel: a preparação diz o estado por TEXTO (não só cor)');
    // Os problemas reais ficam na ATENÇÃO e nunca na preparação.
    for (const problema of ['1 quota(s) em atraso', '2 comprovativo(s) por validar', 'Quotas do mês ainda não geradas',
      '2 pagamento(s) a fornecedores pendentes', '4 documento(s) deste ano ainda não disponibilizados']) {
      assert.ok(blocoAtencao.includes(problema), `painel: «${problema}» está na ATENÇÃO`);
      assert.ok(!blocoPreparacao.includes(problema), `painel: «${problema}» NÃO está na preparação`);
    }
    assert.ok(!/Nada a tratar neste momento/.test(r.html), 'painel: com sinais não mostra o estado tranquilo');

    // ── Atividade recente ─────────────────────────────────────────
    assert.ok(/Atividade recente/.test(r.html), 'painel: bloco de atividade presente');
    assert.ok(/Pagamento registado/.test(r.html) && /Documento criado/.test(r.html) && /Quotas geradas/.test(r.html),
      'painel: eventos úteis apresentados');
    assert.ok(!/Sessão iniciada|inicio_sessao/.test(r.html), 'painel: a sessão não entra na atividade');
    assert.ok(!/ana@exemplo\.pt/.test(r.html), 'painel: a atividade não expõe emails');
    assert.ok(/Ana Gestora/.test(r.html), 'painel: a atividade identifica quem fez a ação');
    const linhasAtividade = (r.html.match(/painel-linha-titulo/g) || []).length;
    assert.ok(linhasAtividade >= 3 && linhasAtividade <= 6, `painel: atividade limitada (${linhasAtividade} linhas)`);

    // ── Próximas assembleias ──────────────────────────────────────
    assert.ok(/Próximas assembleias/.test(r.html), 'painel: bloco de próximas assembleias');
    assert.ok(/Assembleia 2\/2026/.test(r.html) && /Assembleia 3\/2026/.test(r.html), 'painel: as duas assembleias futuras');
    assert.ok(/Convocada/.test(r.html) && /Agendada/.test(r.html), 'painel: estado de cada assembleia');
    assert.ok(/12\/12\/\d{4}/.test(r.html), 'painel: data da assembleia formatada');
    assert.ok(/href="\/admin\/assembleias\/31"/.test(r.html), 'painel: ligação a cada assembleia');
  } else {
    // ── Sem nada a tratar ─────────────────────────────────────────
    assert.ok(/Nada a tratar neste momento\./.test(r.html), 'painel: estado tranquilo quando não há sinais');
    const itens = r.html.match(/class="atencao-item"/g) || [];
    assert.strictEqual(itens.length, 0, `painel: sem sinais, nenhuma linha (${itens.length})`);
    // A secção de sinais não contém nenhuma frase de pendência (numa instalação
    // em ordem, é a única coisa que aparece ali).
    const blocoAtencao = r.html.slice(r.html.indexOf('Precisa de atenção'), r.html.indexOf('Top devedores'));
    for (const pendencia of ['em atraso', 'por validar', 'ainda não geradas', 'por concluir', 'não disponibilizados', 'com erro', 'desligado', 'não configurado']) {
      assert.ok(!blocoAtencao.includes(pendencia), `painel: sem sinais não menciona «${pendencia}»`);
    }
    assert.ok(/Sem assembleias futuras agendadas\./.test(r.html), 'painel: estado vazio das assembleias');
    assert.ok(/Sem atividade registada neste condomínio\./.test(r.html), 'painel: estado vazio da atividade');
    // O que já existia continua a aparecer.
    assert.ok(/O condomínio em resumo|Estado do condomínio/.test(r.html), 'painel: resumo do condomínio intacto');
    assert.ok(/Top devedores/.test(r.html), 'painel: bloco de devedores intacto');
  }

  // ── Estado do condomínio: documentos e backups em linhas separadas ─
  // O defeito original: o rótulo era o do serviço do CONDOMÍNIO e o estado vinha
  // da ligação da PLATAFORMA — um condomínio com o Drive ligado via
  // «Google Drive: ○ Desligado».
  assert.ok(r.html.includes('Documentos: <span class="text-success">● Google Drive</span>'),
    'painel: documentos ligados nomeiam o serviço do condomínio');
  assert.ok(r.html.includes('Cópias de segurança:'), 'painel: linha própria para as cópias de segurança');
  assert.ok(r.html.includes('Email/SMTP: <span class="text-success">● Configurado</span>'),
    'painel: linha do email mantida');
  assert.ok(!/○ Desligado/.test(r.html), 'painel: nunca apresenta o armazenamento como «Desligado»');
  assert.ok(r.html.includes(`Último backup: <span class="text-success">● Concluído</span> · ${DATA_BACKUP}`),
    'painel: o último backup apresenta o estado e a data');
  if (COM_DADOS) {
    // Documentos no Google Drive, backups no Dropbox: o painel mostra os dois
    // serviços, porque são escolhas independentes.
    assert.ok(r.html.includes('Cópias de segurança: <i class="bi bi-cloud me-1"></i><span class="text-success">● Dropbox</span>'),
      'painel: a cópia cloud é o serviço configurado para backups (≠ do dos documentos)');
  } else {
    assert.ok(r.html.includes('Cópias de segurança: <span class="text-muted">○ Apenas local</span>'),
      'painel: sem cloud de backups mostra «Apenas local»');
  }

  // ── Âmbito por condomínio (todas as consultas novas) ─────────────
  const porNome = (nome) => consultas.filter((c) => c[0] === nome).map((c) => c[1]);
  for (const nome of ['Fracao.count', 'Quota.findAll', 'Quota.count', 'Pagamento.count', 'Documento.count', 'Assembleia.findAll', 'PagamentoFornecedor.count']) {
    const ocorrencias = porNome(nome);
    assert.ok(ocorrencias.length, `painel: ${nome} foi consultado`);
    for (const o of ocorrencias) {
      assert.strictEqual(o.where && o.where.condominio_id, 1, `painel: ${nome} filtrado pelo condomínio ativo`);
    }
  }
  const auditoria = porNome('AuditLog.findAll')[0];
  assert.ok(auditoria, 'painel: consultou a auditoria');
  // A condição vem como `{ user_id: { [Op.in]: [42, 43] } }` (a chave é um símbolo).
  const valoresCondicao = (obj) => (obj && typeof obj === 'object' ? Object.getOwnPropertySymbols(obj).map((s) => obj[s]) : []);
  const condicao = auditoria.where && auditoria.where.user_id ? auditoria.where.user_id : {};
  const ids = Array.isArray(condicao) ? condicao : valoresCondicao(condicao).find((v) => Array.isArray(v));
  assert.ok(ids, `painel: auditoria limitada aos utilizadores do condomínio (${JSON.stringify(condicao)})`);
  assert.ok(ids.includes(42) && ids.includes(43), `painel: auditoria restrita aos utilizadores associados (${ids})`);

  // ── UI por papel: gestor não recebe links para módulos de admin ───
  // As guards ficaram intocadas; o que se garante aqui é que o painel não
  // oferece ao gestor ligações que o expulsariam para `/`. O critério é
  // `condominioAtivo.role` (associação do condomínio ativo), não `users.role`.
  const ADMIN_ONLY = ['/admin/emails', '/admin/config/auditoria', '/admin/config/automacoes'];
  PAPEL = 'admin';
  const rAdmin = await pedir('/admin');
  assert.strictEqual(rAdmin.status, 200, 'painel (admin): responde 200');
  for (const url of ADMIN_ONLY) {
    assert.ok(rAdmin.html.includes(`href="${url}"`), `painel (admin): mantém a ligação para ${url}`);
  }

  PAPEL = 'gestor';
  const rGestor = await pedir('/admin');
  assert.strictEqual(rGestor.status, 200, 'painel (gestor): responde 200');
  for (const url of ADMIN_ONLY) {
    assert.ok(!rGestor.html.includes(`href="${url}"`), `painel (gestor): SEM ligação para ${url}`);
  }
  // O gestor não perde nada que consiga mesmo usar.
  for (const url of ['/admin/documentos', '/admin/fornecedores']) {
    assert.ok(rGestor.html.includes(`href="${url}"`), `painel (gestor): mantém a ligação para ${url}`);
  }
  assert.ok(/Fila de emails:/.test(rGestor.html) === /Fila de emails:/.test(rAdmin.html),
    'painel: a linha «Fila de emails» depende só dos dados, não do papel');
  PAPEL = 'admin';

  // ── Separação documentos/backups: estados que não podem ser confundidos ──
  // 1. Destino de backups configurado mas SEM ligação utilizável. O job ignora-o
  //    (ver scripts/test-backup-estado.js), por isso o painel não pode anunciar
  //    uma cópia cloud que nunca acontece.
  armazenamento.destino = 'onedrive';
  armazenamento.ligacao = null;
  const rSemLigacao = await pedir('/admin');
  assert.ok(rSemLigacao.html.includes('Cópias de segurança: <span class="text-muted">○ Apenas local</span>'),
    'painel: destino sem ligação utilizável não é anunciado como cópia cloud');
  assert.ok(!/● Microsoft OneDrive/.test(rSemLigacao.html),
    'painel: não anuncia como ativo um serviço que o job não consegue usar');

  // 2. Documentos sem serviço ligado: linha própria e sinal de atenção — mas o
  //    estado dos BACKUPS não depende disso (a cópia local continua a existir).
  armazenamento.destino = null;
  armazenamento.documentosLigado = false;
  const rSemDocs = await pedir('/admin');
  assert.ok(rSemDocs.html.includes('Documentos: <span class="text-muted">○ Sem serviço ligado</span>'),
    'painel: documentos sem serviço ligado');
  assert.ok(rSemDocs.html.includes('Sem serviço de armazenamento para os documentos'),
    'painel: sinal de atenção para os documentos');
  assert.ok(rSemDocs.html.includes('○ Apenas local'),
    'painel: o estado dos backups não depende do estado dos documentos');

  // 3. Último backup concluído mas com a cópia cloud falhada: a cópia LOCAL
  //    existe e o painel di-lo — sem transformar um backup válido em «Erro».
  armazenamento.documentosLigado = true;
  BACKUP_LOG.ficheiro_drive_id = null;
  BACKUP_LOG.erro = 'Cópia cloud não criada: 503 service unavailable';
  const rCloudFalhou = await pedir('/admin');
  assert.ok(rCloudFalhou.html.includes(`Último backup: <span class="text-warning">● Concluído</span> · ${DATA_BACKUP}`),
    'painel: cópia cloud falhada mantém o backup como concluído');
  assert.ok(rCloudFalhou.html.includes('(cópia cloud falhou)'), 'painel: identifica a falha da cópia cloud');
  assert.ok(rCloudFalhou.html.includes('A cópia cloud do último backup não foi criada (a cópia local existe)'),
    'painel: sinal de atenção da cópia cloud');
  assert.ok(!/503 service unavailable/.test(rCloudFalhou.html),
    'painel: o sinal não despeja a mensagem técnica do fornecedor');

  // 4. Backup em erro: não há cópia nenhuma e o painel diz «Erro».
  BACKUP_LOG.estado = 'erro';
  BACKUP_LOG.tamanho = null;
  BACKUP_LOG.erro = 'mysqldump: command not found';
  const rBackupErro = await pedir('/admin');
  assert.ok(rBackupErro.html.includes(`Último backup: <span class="text-danger">● Erro</span> · ${DATA_BACKUP}`),
    'painel: backup em erro é apresentado como erro');
  assert.ok(rBackupErro.html.includes('O último backup falhou'), 'painel: sinal de atenção do backup em erro');

  // 5. Backup a correr: nem sucesso nem falha.
  BACKUP_LOG.estado = 'em_curso';
  BACKUP_LOG.erro = null;
  const rEmCurso = await pedir('/admin');
  assert.ok(rEmCurso.html.includes(`Último backup: <span class="text-warning">● Em curso</span> · ${DATA_BACKUP}`),
    'painel: backup a correr é apresentado como «Em curso»');

  // 6. Sem histórico de backups: estado vazio explícito — nunca «Desligado»,
  //    porque não é a mesma coisa não haver backups e não haver destino.
  BACKUP_LOG = null;
  const rSemHistorico = await pedir('/admin');
  assert.ok(rSemHistorico.html.includes('Último backup: <span class="text-muted">○ Sem backups</span>'),
    'painel: sem histórico de backups mostra «Sem backups»');
  assert.ok(rSemHistorico.html.includes('Cópias de segurança: <span class="text-muted">○ Apenas local</span>'),
    'painel: sem histórico, a cópia local continua a ser o destino');

  // ── P7: eliminação de fração (pré-verificação das dependências) ──
  await testarEliminacaoFracao();

  console.log(`✓ Testes das rotas do painel passaram (cenário «${CENARIO}», sem base de dados).`);
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('✗ promessa rejeitada sem tratamento: ' + (err && err.message));
  process.exit(1);
});
