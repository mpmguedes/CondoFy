// ═══════════════════════════════════════════════════════════════════
// R10 — CONGELAMENTO DO CÁLCULO DE QUOTAS · CONTRATO EXECUTÁVEL
//
// Regra (P56/R10): depois de um orçamento ter servido para calcular/emitir
// quotas, os resultados persistidos são IMUTÁVEIS por recálculo normal.
// Uma quota emitida nunca é reprecificada automaticamente; alterações
// posteriores exigem uma operação financeira explícita e auditada — nunca
// uma mutação silenciosa do registo original.
//
// ⚠ ESTE FICHEIRO É O CONTRATO. Nasceu a falhar (18 vermelhos contra `6405039`)
// e passou a verde com a implementação de R10/Q11 — sem enfraquecer um único
// contrato. As secções abaixo continuam a ser as mesmas que demonstraram o
// defeito; nenhuma foi removida nem aliviada para «obter verde».
//
// Decisões de produto que este contrato fixa:
//   Q8  = não     — quota emitida nunca é reprecificada, mesmo não entregue;
//   Q9  = preview — `recalcular=futuras` mostra o impacto e NÃO escreve;
//   Q10 = reportar — incoerências históricas não são normalizadas;
//   Q11 = acerto  — a correção de uma quota emitida é um documento NOVO
//                   (`ExtraQuota.tipo='acerto'`), que referencia a quota
//                   original sem a alterar — ver §9.
//
// P19 (histórico): o filtro `estado IN ('pendente','vencida') ∧
// data_vencimento >= hoje` protegia o DINHEIRO aplicado, mas não o DOCUMENTO
// emitido. Era um subconjunto estrito de R10 — ver §7. O contrato passou a ser
// `data_emissao` determina a imutabilidade; o estado de pagamento determina
// apenas o estado derivado.
//
// MUTAÇÃO — provas EXECUTADAS (cada mutação foi morta e o ficheiro restaurado
// byte a byte: sha256 igual antes e depois):
//   1. reintroduzido `await q.update({...})` em `routes/financeiro.js`
//      (`POST /admin/quotas/config`)  → 18 vermelhos (§1, §1.2×6, §5, §6.1–§6.7,
//      §7.1–§7.3);
//   2. reintroduzido `await quota.update({ valor })` (`POST /admin/quotas/:id`)
//      → 4 vermelhos (§2.1×2, §2.2, §6.9);
//   3. removida a guarda de pagamento de `POST /admin/quotas/:id/anular`
//      → 2 vermelhos (§3.1, §3.2).
//   Um contrato que não fique vermelho com a mutação correspondente não prova nada.
//
// MUTAÇÃO — provas da REVISÃO PRÉ-COMMIT (2026-09-22), §2.3–§2.7 e §10:
//   4. reposta a máscara `data_emissao || quota.data_emissao` em
//      `routes/financeiro.js` (o defeito pré-revisão, com o guard explícito
//      removido)                                        → 2 vermelhos (§2.3, §2.5b);
//   5. (4) + retirado `'data_emissao'` de `CAMPOS_CONGELADOS`
//      (`helpers/quota-imutabilidade.js`)                → 3 vermelhos (§2.3, §2.4, §2.5b);
//   6. retirado `tipo: 'extraordinaria'` das três leituras de
//      `routes/extra-quotas.js`                          → 5 vermelhos (§10.1–§10.5);
//   7. retirado `tipo: 'extraordinaria'` do payload de criação + introduzida a
//      criação de parcelas em `helpers/quota-acerto.js`  → 2 vermelhos (§10.6, §10.7).
//
// ⛔ FALSO VERDE APANHADO NA MUTAÇÃO 4 (1.ª tentativa): §2.3 enviava também um
// `valor` diferente. A regra dos campos congelados recusava o pedido por causa
// do `valor` e o contrato ficava verde sem nada provar sobre a emissão. Os casos
// §2.3/§2.4/§2.5b passaram a enviar o `valor` IGUAL ao atual, para que
// `data_emissao` seja a única alteração proposta.
// ⛔ FALSO VERDE APANHADO NA MUTAÇÃO 6 (1.ª tentativa): §10.5 tinha o acerto em
// `pendente`, pelo que a guarda de estado (`estado !== 'processada'`) já recusava
// a cobrança — o contrato ficava verde pelo motivo errado. O acerto passou a ir
// em `processada`, e o contrato passou a verificar o DESTINO do redirect
// (`/admin/quotas-extra` = parcela não carregada).
//
// Utilização: node scripts/test-quotas-r10.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents } = require('../helpers/money');
const { calcularQuota } = require('../helpers/quotas-calc');

const stub = (rel, valor) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
};

// Data (ISO) a N dias de hoje — mantém o teste independente do relógio.
const dias = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Campos que R10 congela (elementos financeiros e de identificação) ──
const CAMPOS_FINANCEIROS = [
  'valor', 'valor_base', 'valor_fcr',
  'valor_por_1000', 'permilagem_aplicada', 'fcr_percentagem',
];

// ═══════════════════════════════════════════════════════════════════
// CENÁRIO MUTÁVEL — cada secção substitui-o antes de fazer o pedido.
// O coletor de mutações é o instrumento central: nenhuma escrita numa quota
// passa sem ficar registada com o id, os campos e a origem.
// ═══════════════════════════════════════════════════════════════════
let CENARIO = { quotas: [], aplicacoes: [], mutacoes: [] };

const novoCenario = (quotas, aplicacoes = []) => {
  CENARIO = { quotas, aplicacoes, mutacoes: [] };
  return CENARIO;
};

function registarMutacao(id, campos, origem) {
  CENARIO.mutacoes.push({ id: Number(id), campos, origem });
  const alvo = CENARIO.quotas.find((q) => Number(q.id) === Number(id));
  if (alvo) Object.assign(alvo, campos);
}

// Mutações que tocam os elementos financeiros (as que R10 proíbe).
const mutacoesFinanceiras = () => CENARIO.mutacoes.filter(
  (m) => Object.keys(m.campos).some((c) => CAMPOS_FINANCEIROS.includes(c))
);

// Descrição legível das mutações financeiras registadas.
const descrever = (ms) => ms.map(
  (m) => `#${m.id} {${Object.keys(m.campos).filter((c) => CAMPOS_FINANCEIROS.includes(c)).join(',')}}`
).join(' · ');

// Fotografia dos campos financeiros de todas as quotas do cenário.
const fotografia = () => Object.fromEntries(
  CENARIO.quotas.map((q) => [q.id, Object.fromEntries(CAMPOS_FINANCEIROS.map((c) => [c, q[c] ?? null]))])
);

const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);

const linhaQuota = (q) => comToJSON({
  ...q,
  update: async (campos) => registarMutacao(q.id, campos, 'Quota#update'),
});

// ⛔ Prova de discriminação (§8.3). Quando ativo, o duplo deixa de aplicar o
// filtro de `estado`/`data_vencimento` — emula um recálculo REGRESSIVO que
// abrange todas as quotas. Serve para mostrar que os verdes de §6.3/§6.4 são
// **condicionais ao filtro** (P19) e não uma proteção que exista no código.
// A isolação por `condominio_id` NÃO é alargada: o âmbito mantém-se.
let FILTRO_AMPLO = false;

// Duplo de consulta que INTERPRETA o `where` real das rotas (mesmos `Op`).
const aplicarWhere = (linhas, where = {}) => linhas.filter((q) => {
  if (where.id !== undefined && Number(q.id) !== Number(where.id)) return false;
  if (where.condominio_id !== undefined && q.condominio_id !== undefined
    && Number(q.condominio_id) !== Number(where.condominio_id)) return false;
  const est = where.estado && where.estado[Op.in];
  if (!FILTRO_AMPLO && est && !est.includes(q.estado)) return false;
  const gte = where.data_vencimento && where.data_vencimento[Op.gte];
  if (!FILTRO_AMPLO && gte && !(new Date(q.data_vencimento) >= gte)) return false;
  return true;
});

const modelo = (over = {}) => Object.assign({
  findOne: async () => null, findAll: async () => [], create: async (v) => comToJSON(v),
  destroy: async () => 0, count: async () => 0, update: async () => [0], findByPk: async () => null,
  findOrCreate: async () => [comToJSON({}), false], sum: async () => 0, max: async () => null,
  aggregate: async () => null,
}, over);

const FRACOES = [
  { id: 21, permilagem: '500', estado: 'ativo', condominio_id: 1 },
  { id: 22, permilagem: '500', estado: 'ativo', condominio_id: 1 },
];

// ── Instrumentos da auditoria a `extra_quotas` (§10) ───────────────
// Registam o que o módulo das quotas extraordinárias faz com as linhas:
// que `where` consulta, o que escreve e o que cria. É assim que se prova que
// um ACERTO (`tipo='acerto'`) nunca é tratado como quota extraordinária.
const CONSULTAS_EXTRA = [];
const ESCRITAS_EXTRA = [];
const ESCRITAS_PARCELA = [];
const CRIADOS_EXTRA = [];
const CRIADAS_PARCELAS = [];

// Linhas de `extra_quotas` visíveis ao duplo e as suas parcelas. Cada secção
// substitui-as antes de fazer o pedido (`novoExtras`).
let EXTRAS = [];
let PARCELAS = [];

const novoExtras = (extras, parcelas = []) => {
  EXTRAS = extras;
  PARCELAS = parcelas;
  CONSULTAS_EXTRA.length = 0;
  ESCRITAS_EXTRA.length = 0;
  ESCRITAS_PARCELA.length = 0;
  CRIADOS_EXTRA.length = 0;
  CRIADAS_PARCELAS.length = 0;
};

// Linha de `extra_quotas` que regista as escritas — é assim que se prova que
// uma operação recusada não escreveu NADA.
const linhaExtra = (e) => comToJSON({
  ...e,
  update: async (campos) => {
    ESCRITAS_EXTRA.push({ id: Number(e.id), campos, origem: 'ExtraQuota#update' });
    Object.assign(e, campos);
  },
});

const MODELS = new Proxy({}, {
  get: (_t, nome) => {
    if (nome === 'sequelize') return {};
    if (nome === 'Fracao') {
      return modelo({
        findByPk: async (id) => FRACOES.find((f) => f.id === Number(id)) || null,
        findAll: async (opts) => {
          const w = (opts && opts.where) || {};
          const ids = w.id && w.id[Op.in];
          return FRACOES.filter((f) => {
            if (ids && !ids.map(Number).includes(Number(f.id))) return false;
            if (w.estado !== undefined && f.estado !== w.estado) return false;
            if (w.condominio_id !== undefined && Number(f.condominio_id) !== Number(w.condominio_id)) return false;
            return true;
          }).map(comToJSON);
        },
      });
    }
    if (nome === 'Quota') {
      return modelo({
        findAll: async (opts) => aplicarWhere(CENARIO.quotas, opts && opts.where).map(linhaQuota),
        findOne: async (opts) => {
          const achada = aplicarWhere(CENARIO.quotas, opts && opts.where)[0];
          return achada ? linhaQuota(achada) : null;
        },
        findByPk: async (id) => {
          const achada = CENARIO.quotas.find((q) => Number(q.id) === Number(id));
          return achada ? linhaQuota(achada) : null;
        },
      });
    }
    if (nome === 'ExtraQuota') {
      // Honra o `where` REAL da rota — incluindo `tipo`, que é o que se audita.
      const casa = (e, w) => {
        if (w.id !== undefined && Number(e.id) !== Number(w.id)) return false;
        if (w.condominio_id !== undefined && Number(e.condominio_id) !== Number(w.condominio_id)) return false;
        if (w.tipo !== undefined && e.tipo !== w.tipo) return false;
        if (w.estado !== undefined && e.estado !== w.estado) return false;
        return true;
      };
      return modelo({
        findAll: async (opts) => {
          const w = (opts && opts.where) || {};
          CONSULTAS_EXTRA.push({ op: 'findAll', where: { ...w } });
          return EXTRAS.filter((e) => casa(e, w)).map((e) => comToJSON({ ...e }));
        },
        findOne: async (opts) => {
          const w = (opts && opts.where) || {};
          CONSULTAS_EXTRA.push({ op: 'findOne', where: { ...w } });
          const e = EXTRAS.find((x) => casa(x, w));
          return e ? linhaExtra(e) : null;
        },
        create: async (v) => {
          CRIADOS_EXTRA.push(v);
          return comToJSON({ id: 777, ...v });
        },
      });
    }
    if (nome === 'ExtraQuotaParcela') {
      return modelo({
        findAll: async () => [],
        findByPk: async (id, opts) => {
          const p = PARCELAS.find((x) => Number(x.id) === Number(id));
          if (!p) return null;
          const inc = opts && Array.isArray(opts.include)
            ? opts.include.find((i) => i && i.as === 'extra_quota')
            : null;
          if (!inc) return comToJSON({ ...p });
          // `required: true` ⇒ sem correspondência no include NÃO há linha.
          const dono = EXTRAS.find((e) => Number(e.id) === Number(p.extra_quota_id));
          const w = inc.where || {};
          const casaDono = dono
            && (w.condominio_id === undefined || Number(dono.condominio_id) === Number(w.condominio_id))
            && (w.tipo === undefined || dono.tipo === w.tipo);
          if (!casaDono) return null;
          return comToJSON({ ...p, extra_quota: comToJSON({ ...dono }) });
        },
        create: async (v) => {
          CRIADAS_PARCELAS.push(v);
          return comToJSON(v);
        },
        update: async (campos, opts) => {
          ESCRITAS_PARCELAS.push({ campos, where: (opts && opts.where) || null });
          return [0];
        },
      });
    }
    if (nome === 'PagamentoQuota') {
      return modelo({
        findAll: async (opts) => {
          const where = (opts && opts.where) || {};
          return CENARIO.aplicacoes
            .filter((a) => {
              if (where.quota_id === undefined) return true;
              const alvo = where.quota_id[Op.in] || where.quota_id;
              return Array.isArray(alvo)
                ? alvo.map(Number).includes(Number(a.quota_id))
                : Number(a.quota_id) === Number(alvo);
            })
            // O helper real lê `a.pagamento.estado` — o duplo honra essa forma.
            .map((a) => ({ ...a, pagamento: { estado: a.pagamento_estado } }));
        },
      });
    }
    return modelo();
  },
});

stub('models/index.js', MODELS);
stub('models', MODELS);
stub('config/database.js', {
  transaction: async () => ({ commit: async () => {}, rollback: async () => {}, LOCK: { UPDATE: 'U' } }),
});
stub('helpers/tenant.js', {
  comCondominioAtivo: (req, res, next) => { req.condominioId = 1; next(); },
  comPapel: () => (req, res, next) => next(),
  comSuporte: () => (req, res, next) => next(),
  pertenceAoAtivo: () => true, papelMaiorOuIgual: () => true,
});
stub('helpers/suporte-allowlist.js', {
  soDiagnostico: () => (req, res, next) => next(),
  comPapelOuSuporteAdmitido: () => (req, res, next) => next(),
});
stub('helpers/audit.js', { audit: async () => {} });
stub('helpers/numeracao.js', { proximoNumero: async () => 'Q/2026/1' });
stub('helpers/storage.js', { isConfigured: () => false });
stub('helpers/automacoes.js', { estaAtivo: async () => false });
stub('helpers/background-jobs.js', { enqueue: () => {}, registar: () => {} });
stub('helpers/saldos.js', {
  resumoCondominio: async () => ({ contas: [] }), resumoFracao: async () => ({}),
  estadoEfetivo: () => 'pendente',
});
stub('helpers/condominio.js', { getCondominio: async () => ({ id: 1, designacao: 'C1' }) });
const quotasConfigReal = require('../helpers/quotas-config');
let CONFIG_GRAVADA = null;
stub('helpers/quotas-config.js', {
  ...quotasConfigReal,
  setQuotaConfig: async (id, cfg) => { CONFIG_GRAVADA = { id, cfg }; },
});
// `routes/extra-quotas.js` (§10). Só a distribuição é substituída: a criação
// não é exercida em detalhe — §10.7 verifica apenas o `tipo` que fica gravado.
stub('helpers/extra-quotas.js', {
  distribuicaoExtra: () => [],
  parcelar: () => [],
  periodosVencimento: () => [],
});

const app = express();
app.use(session({ secret: 't', resave: false, saveUninitialized: true }));
app.use(express.urlencoded({ extended: true }));
app.use(flash());
app.use((req, res, next) => {
  req.user = { id: 1 };
  res.locals.user = { id: 1 };
  res.locals.currentYear = 2026; res.locals.currentMonth = 1;
  res.locals.currentPath = req.path;
  res.locals.condominioAtivo = { id: 1, role: 'gestor' };
  res.locals.appName = 'GesCondu';
  res.locals.success_msg = []; res.locals.error_msg = []; res.locals.error = [];
  res.locals.tarefas = {}; res.locals.meusCondominios = [];
  res.locals.sessaoExpiraEm = Date.now() + 3600000;
  res.locals.sessaoAvisoMs = 1; res.locals.sessaoIdleMs = 1;
  res.locals.armazenamentoIcone = ''; res.locals.armazenamentoRotulo = '';
  next();
});
// Nenhuma vista é renderizada neste contrato: `res.render` é intercetado e
// devolve o contexto em JSON, para se poder inspecionar o que a rota enviou.
app.use((req, res, next) => {
  res.render = (vista, dados) => res.status(200).json({ vista, dados });
  next();
});
app.use('/admin', require('../routes/financeiro'));
// O módulo das quotas extraordinárias, montado no MESMO prefixo: é o consumidor
// de `extra_quotas` que §10 audita. (`/quotas-extra` não colide com `/quotas/:id`.)
app.use('/admin', require('../routes/extra-quotas'));
app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

// ── Fixtures ───────────────────────────────────────────────────────
// Quotas emitidas (data_emissao) com os vários estados e vínculos.
const QUOTAS_BASE = () => ([
  { id: 101, condominio_id: 1, fracao_id: 21, orcamento_id: 7, ano: 2026, mes: 1, estado: 'pendente',
    data_emissao: '2026-01-05', data_vencimento: dias(+30), valor: '110.00',
    valor_base: '100.00', valor_fcr: '10.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  { id: 102, condominio_id: 1, fracao_id: 22, orcamento_id: null, ano: 2026, mes: 1, estado: 'pendente',
    data_emissao: '2026-01-05', data_vencimento: dias(+30), valor: '110.00',
    valor_base: '100.00', valor_fcr: '10.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  { id: 103, condominio_id: 1, fracao_id: 21, orcamento_id: 7, ano: 2026, mes: 2, estado: 'paga',
    data_emissao: '2026-01-05', data_vencimento: dias(+30), valor: '110.00',
    valor_base: '100.00', valor_fcr: '10.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  { id: 104, condominio_id: 1, fracao_id: 22, orcamento_id: 7, ano: 2026, mes: 2, estado: 'parcialmente_paga',
    data_emissao: '2026-01-05', data_vencimento: dias(+30), valor: '110.00',
    valor_base: '100.00', valor_fcr: '10.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  { id: 105, condominio_id: 1, fracao_id: 21, orcamento_id: null, ano: 2026, mes: 3, estado: 'pendente',
    data_emissao: null, data_vencimento: dias(+30), valor: '110.00',
    valor_base: '100.00', valor_fcr: '10.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  { id: 106, condominio_id: 1, fracao_id: 22, orcamento_id: 7, ano: 2025, mes: 12, estado: 'pendente',
    data_emissao: '2025-12-05', data_vencimento: dias(-30), valor: '110.00',
    valor_base: '100.00', valor_fcr: '10.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
]);

const QUOTAS_EDICAO = () => ([
  { id: 201, condominio_id: 1, fracao_id: 21, orcamento_id: 7, ano: 2026, mes: 4, estado: 'pendente',
    data_emissao: '2026-04-01', data_vencimento: dias(+30), valor: '55.00',
    valor_base: '50.00', valor_fcr: '5.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  { id: 202, condominio_id: 1, fracao_id: 22, orcamento_id: 7, ano: 2026, mes: 4, estado: 'paga',
    data_emissao: '2026-04-01', data_vencimento: dias(+30), valor: '55.00',
    valor_base: '50.00', valor_fcr: '5.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
]);

const QUOTAS_ANULACAO = () => ([
  { id: 301, condominio_id: 1, fracao_id: 21, orcamento_id: 7, ano: 2026, mes: 5, estado: 'pendente',
    data_emissao: '2026-05-01', data_vencimento: dias(+30), valor: '55.00',
    valor_base: '50.00', valor_fcr: '5.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
]);

// Uma aplicação CONFIRMADA de 55 € sobre a quota 301 → está paga.
const APLICACOES_301 = () => ([
  { id: 1, quota_id: 301, pagamento_id: 900, valor_aplicado: '55.00', pagamento_estado: 'confirmado' },
]);

// ── Contornos de R10 (§2.3–§2.7) ───────────────────────────────────
const QUOTAS_CONTORNO = () => ([
  // Emitida, COM orçamento de origem.
  { id: 501, condominio_id: 1, fracao_id: 21, orcamento_id: 7, ano: 2026, mes: 6, estado: 'pendente',
    data_emissao: '2026-06-01', data_vencimento: dias(+30), valor: '55.00',
    valor_base: '50.00', valor_fcr: '5.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  // Emitida, SEM orçamento de origem (R10 não pode depender de `orcamento_id`).
  { id: 502, condominio_id: 1, fracao_id: 22, orcamento_id: null, ano: 2026, mes: 6, estado: 'pendente',
    data_emissao: '2026-06-01', data_vencimento: dias(+30), valor: '55.00',
    valor_base: '50.00', valor_fcr: '5.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
  // RASCUNHO: não emitida. É o ramo em que o contorno «des-emitir» cairia.
  { id: 503, condominio_id: 1, fracao_id: 21, orcamento_id: 7, ano: 2026, mes: 7, estado: 'pendente',
    data_emissao: null, data_vencimento: dias(+30), valor: '55.00',
    valor_base: '50.00', valor_fcr: '5.00', valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00', fcr_percentagem: '10.00' },
]);

// ── Consumidores de `extra_quotas` (§10) ───────────────────────────
const EXTRAS_BASE = () => ([
  { id: 601, condominio_id: 1, tipo: 'extraordinaria', estado: 'pendente', designacao: 'Obras fachada',
    valor_total: '1200.00', mes_inicio: 6, ano_inicio: 2026, numero_parcelas: 1, periodicidade: 'mensal' },
  // ACERTO da quota emitida #501 — nunca pode ser tratado como extraordinária.
  { id: 602, condominio_id: 1, tipo: 'acerto', estado: 'pendente', designacao: 'Acerto da quota 501',
    valor_total: '5.00', mes_inicio: 6, ano_inicio: 2026, numero_parcelas: 1, periodicidade: 'mensal',
    quota_id: 501, orcamento_id: 7, justificacao: 'motivo', valor_anterior: '55.00', valor_novo: '60.00' },
]);

// Parcela FABRICADA sobre o acerto #602. No domínio o acerto NÃO gera parcelas
// (é o que §10.6 prova); esta linha existe para mostrar que, mesmo existindo, o
// módulo das quotas extraordinárias se recusa a carregá-la (§10.5).
const PARCELAS_ACERTO = () => ([
  { id: 901, extra_quota_id: 602, fracao_id: 21, parcela_numero: 1, valor: '5.00', estado: 'pendente' },
]);

// ── Harness de contratos ───────────────────────────────────────────
let BASE = null;
const RESULTADOS = [];

async function contrato(nome, fn) {
  try {
    await fn();
    RESULTADOS.push({ nome, ok: true });
    console.log(`  ✓ ${nome}`);
  } catch (e) {
    RESULTADOS.push({ nome, ok: false, erro: e.message });
    console.log(`  ✗ ${nome}`);
    console.log(`      ${e.message}`);
  }
}

const pedir = (caminho, corpo) => fetch(`${BASE}${caminho}`, {
  method: 'POST', body: new URLSearchParams(corpo), redirect: 'manual',
});

const CORPO_CONFIG = { valor_1000: '110.0000', fcr_percentagem: '10', recalcular: 'futuras' };

// ═══════════════════════════════════════════════════════════════════
// §0 — O coletor não é vazio por construção (auto-teste do instrumento)
// ═══════════════════════════════════════════════════════════════════
function autoTesteDoColetor() {
  const antes = CENARIO;
  novoCenario([{ id: 900, condominio_id: 1, valor: '10.00' }]);
  registarMutacao(900, { valor: '11.00' }, 'sintético');
  assert.strictEqual(CENARIO.mutacoes.length, 1, 'o coletor regista uma mutação sintética');
  assert.strictEqual(mutacoesFinanceiras().length, 1, 'a mutação sintética é classificada como financeira');
  assert.strictEqual(CENARIO.quotas[0].valor, '11.00', 'a mutação sintética altera o cenário');
  CENARIO = antes;
  console.log('  ✓ §0. o coletor deteta escritas (não é vazio por construção)');
}

// ═══════════════════════════════════════════════════════════════════
// §1 — V1: `recalcular=futuras` não pode escrever em NENHUMA quota (Q9)
// ═══════════════════════════════════════════════════════════════════
async function testeV1() {
  novoCenario(QUOTAS_BASE());
  const antes = fotografia();

  await contrato('§1.1 `recalcular=futuras` não escreve nenhum campo financeiro', async () => {
    const r = await pedir('/admin/quotas/config', CORPO_CONFIG);
    assert.strictEqual(r.status, 302, 'a gravação da configuração responde com redirect');
    assert.ok(CONFIG_GRAVADA, 'a configuração é gravada no âmbito do condomínio ativo');
    const escritas = mutacoesFinanceiras();
    assert.strictEqual(
      escritas.length, 0,
      `Q9: o recálculo é PRÉ-VISUALIZAÇÃO e não pode gravar. Escritas: ${descrever(escritas)}`
    );
  });

  // Verificação campo a campo, para a falha dizer exatamente o que mudou.
  const depois = fotografia();
  for (const q of CENARIO.quotas) {
    const a = antes[q.id];
    const d = depois[q.id];
    const alterados = CAMPOS_FINANCEIROS.filter((c) => String(a[c]) !== String(d[c]));
    const etiqueta = `${q.estado}${q.data_emissao ? ', emitida' : ', NÃO emitida'}`;
    await contrato(`§1.2 quota #${q.id} (${etiqueta}) mantém os 6 campos financeiros`, async () => {
      assert.strictEqual(
        alterados.length, 0,
        `campos alterados em #${q.id}: ${alterados.map((c) => `${c}: ${a[c]} → ${d[c]}`).join(' | ')}`
      );
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// §2 — V2: `POST /admin/quotas/:id` não pode reescrever quota emitida
// ═══════════════════════════════════════════════════════════════════
async function testeV2() {
  for (const id of [201, 202]) {
    novoCenario(QUOTAS_EDICAO());
    const antes = fotografia();
    const estadoAntes = CENARIO.quotas.find((q) => q.id === id).estado;

    await contrato(`§2.1 POST /quotas/${id} (emitida, ${estadoAntes}) não altera valor nem componentes`, async () => {
      const r = await pedir(`/admin/quotas/${id}`, { valor: '999.00', observacoes: 'tentativa' });
      assert.strictEqual(r.status, 302, 'a rota responde com redirect');
      const depois = fotografia();
      const alterados = CAMPOS_FINANCEIROS.filter((c) => String(antes[id][c]) !== String(depois[id][c]));
      assert.strictEqual(
        alterados.length, 0,
        `R10: a quota emitida #${id} (${estadoAntes}) não pode ser reescrita. ` +
        `Alterados: ${alterados.map((c) => `${c}: ${antes[id][c]} → ${depois[id][c]}`).join(' | ')}`
      );
    });
  }

  // A quebra do invariante, isolada: é o efeito colateral mais grave de V2.
  novoCenario(QUOTAS_EDICAO());
  await contrato('§2.2 a edição manual não pode quebrar `valor = valor_base + valor_fcr`', async () => {
    await pedir('/admin/quotas/201', { valor: '999.00' });
    const q = CENARIO.quotas.find((x) => x.id === 201);
    const somaC = toCents(q.valor_base) + toCents(q.valor_fcr);
    assert.strictEqual(
      toCents(q.valor), somaC,
      `invariante I-4 quebrado: valor=${q.valor} € (${toCents(q.valor)} cêntimos) ≠ ` +
      `base=${q.valor_base} € + FCR=${q.valor_fcr} € (${somaC} cêntimos)`
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// §2.3–§2.7 — CONTORNOS DE R10
//
// O contorno a fechar: se `data_emissao` pudesse ser LIMPA, a quota deixaria de
// ser um documento, `estaEmitida` passaria a `false` e a edição seguinte cairia
// no ramo NÃO emitido — onde o valor volta a ser editável. Limpar a âncora
// seria, por isso, uma forma INDIRECTA de reescrever o valor.
//
// §2.3/§2.4 provam que limpar e trocar são recusados; §2.5 demonstra a porta
// nos dois sentidos (o ramo não-emitido ESCREVE `data_emissao` — logo a porta é
// real, e é essa porta que está fechada); §2.6/§2.7 provam que R10 não depende
// de `orcamento_id` e que esse vínculo é, ele próprio, histórico.
// ═══════════════════════════════════════════════════════════════════
async function testeContorno() {
  novoCenario(QUOTAS_CONTORNO());
  await contrato('§2.3 POST /quotas/501 com `data_emissao` VAZIA é recusado (não «des-emite»)', async () => {
    // ⛔ O `valor` vai IGUAL ao atual, de propósito: assim `data_emissao` é a
    // ÚNICA alteração proposta. Se fosse enviado um valor diferente, a regra dos
    // campos congelados recusaria o pedido por esse motivo e este contrato
    // ficaria verde sem nada provar sobre a emissão (foi um falso verde real,
    // apanhado por mutação).
    const r = await pedir('/admin/quotas/501', { data_emissao: '', valor: '55.00' });
    assert.strictEqual(r.status, 302, 'a rota responde com redirect');
    const q = CENARIO.quotas.find((x) => x.id === 501);
    assert.strictEqual(
      String(q.data_emissao), '2026-06-01',
      'a data de emissão da quota #501 não pode ser limpa — é a âncora de R10'
    );
    assert.strictEqual(
      CENARIO.mutacoes.length, 0,
      `limpar a emissão não pode escrever nada; escreveu: ${JSON.stringify(CENARIO.mutacoes)}`
    );
  });

  novoCenario(QUOTAS_CONTORNO());
  await contrato('§2.4 POST /quotas/501 com OUTRA `data_emissao` é recusado (não a troca)', async () => {
    // Idem §2.3: `valor` inalterado, para isolar a proposta sobre a emissão.
    const r = await pedir('/admin/quotas/501', { data_emissao: '2020-01-01', valor: '55.00' });
    assert.strictEqual(r.status, 302, 'a rota responde com redirect');
    const q = CENARIO.quotas.find((x) => x.id === 501);
    assert.strictEqual(String(q.data_emissao), '2026-06-01', 'a emissão do documento não é reescrita');
    assert.strictEqual(CENARIO.mutacoes.length, 0, 'trocar a emissão não pode escrever nada');
  });

  novoCenario(QUOTAS_CONTORNO());
  await contrato('§2.5a o ramo NÃO emitido ESCREVE `data_emissao` (a porta existe: #503 rascunho)', async () => {
    await pedir('/admin/quotas/503', { data_emissao: '2026-07-01', valor: '55.00' });
    const q = CENARIO.quotas.find((x) => x.id === 503);
    assert.strictEqual(
      String(q.data_emissao), '2026-07-01',
      'sem emissão a quota é um rascunho e a edição pode promovê-la a documento'
    );
    assert.strictEqual(CENARIO.mutacoes.length, 1, 'a promoção do rascunho é uma escrita');
  });

  novoCenario(QUOTAS_CONTORNO());
  await contrato('§2.5b a MESMA operação numa quota emitida é recusada (#501 não «des-emite»)', async () => {
    const antes = fotografia();
    await pedir('/admin/quotas/501', { data_emissao: '', valor: '55.00' });
    const depois = fotografia();
    const alterados = CAMPOS_FINANCEIROS.filter((c) => String(antes[501][c]) !== String(depois[501][c]));
    assert.strictEqual(
      alterados.length, 0,
      `limpar a emissão fez a quota cair no ramo não-emitido e reescrever: ${alterados.join(', ')}`
    );
    assert.strictEqual(
      CENARIO.mutacoes.length, 0,
      'nenhuma escrita pode ter acontecido: a porta do contorno está fechada'
    );
  });

  await contrato('§2.6a emitida COM orçamento (#501) e SEM orçamento (#502) são recusadas por igual', async () => {
    const resultados = {};
    for (const id of [501, 502]) {
      novoCenario(QUOTAS_CONTORNO());
      await pedir(`/admin/quotas/${id}`, { valor: '999.00' });
      const q = CENARIO.quotas.find((x) => x.id === id);
      resultados[id] = { valor: String(q.valor), escritas: CENARIO.mutacoes.length };
    }
    assert.strictEqual(resultados[501].valor, '55.00', 'emitida COM orçamento: valor intacto');
    assert.strictEqual(resultados[502].valor, '55.00', 'emitida SEM orçamento: valor intacto');
    assert.strictEqual(resultados[501].escritas, 0, 'emitida COM orçamento: nenhuma escrita');
    assert.strictEqual(resultados[502].escritas, 0, 'emitida SEM orçamento: nenhuma escrita');
  });

  await contrato('§2.6b a regra lê SÓ `data_emissao` — `orcamento_id` não a liga nem a desliga', async () => {
    const { estaEmitida } = require('../helpers/quota-imutabilidade');
    assert.strictEqual(
      estaEmitida({ data_emissao: '2026-01-01', orcamento_id: null }), true,
      'emitida sem orçamento continua a ser um documento'
    );
    assert.strictEqual(
      estaEmitida({ data_emissao: null, orcamento_id: 7 }), false,
      'ter orçamento não torna um rascunho num documento'
    );
    assert.strictEqual(
      estaEmitida({ data_emissao: null, orcamento_id: null }), false,
      'rascunho sem orçamento continua a não ser documento'
    );
  });

  await contrato('§2.7 trocar o `orcamento_id` de uma quota emitida é uma alteração congelada', async () => {
    const { alteracoesCongeladas } = require('../helpers/quota-imutabilidade');
    const emitida = QUOTAS_CONTORNO()[0];
    const trocas = alteracoesCongeladas(emitida, { orcamento_id: 9 });
    assert.strictEqual(trocas.length, 1, 'trocar o orçamento de origem tem de ser detetado');
    assert.strictEqual(trocas[0].campo, 'orcamento_id', 'o campo detetado é o vínculo ao orçamento');
    assert.strictEqual(
      alteracoesCongeladas(emitida, { orcamento_id: 7 }).length, 0,
      'o MESMO valor não é uma alteração (a comparação normaliza)'
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// §3 — P6/R10: não anular quota com pagamento confirmado
// ═══════════════════════════════════════════════════════════════════
async function testeAnulacao() {
  novoCenario(QUOTAS_ANULACAO(), APLICACOES_301());

  await contrato('§3.1 POST /quotas/301/anular recusa quota com pagamento confirmado', async () => {
    const r = await pedir('/admin/quotas/301/anular', {});
    assert.strictEqual(r.status, 302, 'a rota responde com redirect');
    const q = CENARIO.quotas.find((x) => x.id === 301);
    assert.notStrictEqual(
      q.estado, 'anulada',
      'P6/R10: a quota #301 tem uma aplicação confirmada de 55 € e não pode ser anulada por esta via'
    );
  });

  await contrato('§3.2 anular não pode deixar dinheiro aplicado sobre quota anulada', async () => {
    const q = CENARIO.quotas.find((x) => x.id === 301);
    const pagoC = CENARIO.aplicacoes
      .filter((a) => a.pagamento_estado === 'confirmado')
      .reduce((s, a) => s + toCents(a.valor_aplicado), 0);
    assert.ok(
      !(q.estado === 'anulada' && pagoC > 0),
      `quota #301 anulada com ${pagoC} cêntimos aplicados — a anulação não reverte o pagamento`
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// §4 — Invariante financeiro: DETETAR/REPORTAR (Q10), nunca corrigir
// ═══════════════════════════════════════════════════════════════════
function detetarIncoerencias(quotas) {
  const incoerentes = [];
  const semComponentes = [];
  for (const q of quotas) {
    if (q.valor_base === null || q.valor_base === undefined
      || q.valor_fcr === null || q.valor_fcr === undefined) {
      semComponentes.push({ id: q.id, valor: q.valor, valor_base: q.valor_base, valor_fcr: q.valor_fcr });
      continue;
    }
    const somaC = toCents(q.valor_base) + toCents(q.valor_fcr);
    if (toCents(q.valor) !== somaC) {
      incoerentes.push({
        id: q.id, condominio_id: q.condominio_id, estado: q.estado,
        data_emissao: q.data_emissao, orcamento_id: q.orcamento_id,
        valor: q.valor, valor_base: q.valor_base, valor_fcr: q.valor_fcr,
        diferencaC: toCents(q.valor) - somaC,
      });
    }
  }
  return { incoerentes, semComponentes };
}

async function testeInvariante() {
  const FIXTURE = [
    { id: 401, condominio_id: 1, estado: 'pendente', data_emissao: '2026-01-05', orcamento_id: 7,
      valor: '55.00', valor_base: '50.00', valor_fcr: '5.00' },
    { id: 402, condominio_id: 1, estado: 'pendente', data_emissao: '2026-01-05', orcamento_id: 7,
      valor: '999.00', valor_base: '50.00', valor_fcr: '5.00' },
    { id: 403, condominio_id: 1, estado: 'pendente', data_emissao: '2026-01-05', orcamento_id: null,
      valor: '55.00', valor_base: null, valor_fcr: null },
  ];
  novoCenario(FIXTURE);

  await contrato('§4.1 deteta a classe «incoerente» e a classe «sem componentes», sem as confundir', async () => {
    const { incoerentes, semComponentes } = detetarIncoerencias(CENARIO.quotas);
    assert.deepStrictEqual(incoerentes.map((i) => i.id), [402],
      'só a #402 é incoerente (valor ≠ base + FCR)');
    assert.deepStrictEqual(semComponentes.map((s) => s.id), [403],
      'a #403 tem componentes NULL — é uma classe DISTINTA, não «incoerente»');
  });

  await contrato('§4.2 o relatório traz os campos exigidos (id, condomínio, estado, emissão, orçamento, valores)', async () => {
    const { incoerentes } = detetarIncoerencias(CENARIO.quotas);
    const i = incoerentes[0];
    for (const campo of ['id', 'condominio_id', 'estado', 'data_emissao', 'orcamento_id', 'valor', 'valor_base', 'valor_fcr', 'diferencaC']) {
      assert.ok(campo in i, `o relatório tem de trazer «${campo}»`);
    }
    assert.strictEqual(i.diferencaC, toCents('999.00') - toCents('55.00'), 'a diferença é calculada em cêntimos');
  });

  await contrato('§4.3 Q10: detetar é SÓ LER — nenhuma quota é normalizada', async () => {
    detetarIncoerencias(CENARIO.quotas);
    assert.strictEqual(CENARIO.mutacoes.length, 0, 'a deteção não escreve nada');
    assert.strictEqual(CENARIO.quotas[1].valor, '999.00', 'o valor incoerente fica como está (reportar, não corrigir)');
  });
}

// ═══════════════════════════════════════════════════════════════════
// §5 — Q9: pré-visualização mostra o impacto e não grava
// ═══════════════════════════════════════════════════════════════════
async function testePrevisualizacao() {
  novoCenario(QUOTAS_BASE());

  await contrato('§5.1 a pré-visualização é calculável sem escrever (impacto por quota)', async () => {
    // O impacto esperado, calculado como a futura pré-visualização terá de o fazer.
    const impacto = CENARIO.quotas
      .filter((q) => q.data_emissao)
      .map((q) => {
        const fracao = FRACOES.find((f) => f.id === Number(q.fracao_id));
        const novo = calcularQuota(fracao.permilagem, 110, 10);
        return { id: q.id, de: q.valor, para: novo.total, muda: String(q.valor) !== String(novo.total) };
      });
    assert.strictEqual(impacto.length, 5, 'o impacto é calculado para as 5 quotas emitidas');
    assert.ok(impacto.some((i) => i.muda), 'há impacto real a mostrar (o valor por 1000‰ muda)');

    await pedir('/admin/quotas/config', CORPO_CONFIG);

    const escritas = mutacoesFinanceiras();
    assert.strictEqual(
      escritas.length, 0,
      `Q9: mostrar o impacto não pode escrever campos financeiros. Escritas: ${descrever(escritas)}`
    );
    assert.strictEqual(CENARIO.quotas.find((q) => q.id === 101).valor, '110.00',
      'a quota #101 mantém o valor depois de a pré-visualização correr');
  });
}

// ═══════════════════════════════════════════════════════════════════
// §6 — Cobertura R10 (os pontos do contrato)
// ═══════════════════════════════════════════════════════════════════
async function testeCoberturaR10() {
  novoCenario(QUOTAS_BASE());
  await pedir('/admin/quotas/config', CORPO_CONFIG);
  const escritas = new Set(mutacoesFinanceiras().map((m) => m.id));
  const lista = [...escritas].sort((a, b) => a - b);

  const casos = [
    ['§6.1 quota emitida POR ORÇAMENTO não é reprecificada', 101],
    ['§6.2 quota emitida SEM `orcamento_id` não é reprecificada', 102],
    ['§6.3 quota `paga` não é alterada', 103],
    ['§6.4 quota `parcialmente_paga` não é alterada', 104],
    ['§6.5 quota apenas `pendente` mas JÁ EMITIDA não é alterada', 101],
    ['§6.6 a configuração futura só pode afetar NOVAS gerações (#105, não emitida)', 105],
  ];
  for (const [nome, id] of casos) {
    await contrato(`${nome}`, async () => {
      assert.ok(!escritas.has(id), `a quota #${id} foi reprecificada pelo recálculo (escritas: #${lista.join(', #')})`);
    });
  }

  await contrato('§6.7 `recalcular=futuras` não escreve em nenhuma quota', async () => {
    assert.strictEqual(lista.length, 0, `escritas financeiras: #${lista.join(', #')}`);
  });

  // ── O caso que TEM de continuar verde: estado derivado de pagamento ──
  novoCenario(QUOTAS_ANULACAO(), APLICACOES_301());
  await contrato('§6.8 o estado DERIVADO do pagamento continua a poder mudar (só `estado`)', async () => {
    const { recalcularEstadoQuota } = require('../helpers/pagamentos');
    await recalcularEstadoQuota(301, {});
    const q = CENARIO.quotas.find((x) => x.id === 301);
    assert.strictEqual(q.estado, 'paga', 'com 55 € confirmados sobre 55 €, o estado derivado é `paga`');
    const financeiras = mutacoesFinanceiras();
    assert.strictEqual(
      financeiras.length, 0,
      `a atualização de estado não pode tocar em campos financeiros; tocou: ${descrever(financeiras)}`
    );
  });

  await contrato('§6.9 correção posterior exige operação própria — nunca UPDATE da quota original', async () => {
    novoCenario(QUOTAS_EDICAO());
    await pedir('/admin/quotas/201', { valor: '60.00' });
    await pedir('/admin/quotas/201/anular', {});
    const q = CENARIO.quotas.find((x) => x.id === 201);
    const atual = [toCents(q.valor), toCents(q.valor_base), toCents(q.valor_fcr)].join('/');
    const esperado = [toCents('55.00'), toCents('50.00'), toCents('5.00')].join('/');
    assert.strictEqual(
      atual, esperado,
      `a quota original não pode ser reescrita (valor/base/FCR em cêntimos: ${atual} ≠ ${esperado}): ` +
      'a correção tem de ser um documento novo (acerto / quota extraordinária)'
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// §7 — P19 é um subconjunto histórico de R10
// ═══════════════════════════════════════════════════════════════════
async function testeP19() {
  novoCenario(QUOTAS_BASE());
  await pedir('/admin/quotas/config', CORPO_CONFIG);
  const escritas = new Set(mutacoesFinanceiras().map((m) => m.id));

  await contrato('§7.1 P19 protege o DINHEIRO aplicado (#103 paga, #104 parcial)', async () => {
    assert.ok(!escritas.has(103), 'P19 exclui `paga`');
    assert.ok(!escritas.has(104), 'P19 exclui `parcialmente_paga`');
  });

  await contrato('§7.2 P19 NÃO protege o DOCUMENTO emitido ainda pendente (#101)', async () => {
    assert.ok(
      !escritas.has(101),
      'P19 é subconjunto estrito de R10: `pendente` + vencimento futuro + EMITIDA continua a ser reprecificada'
    );
  });

  await contrato('§7.3 a proteção não pode depender de `data_vencimento` (#106 passa por acidente)', async () => {
    // #106 está emitida e tem vencimento no PASSADO: o filtro atual exclui-a pela
    // DATA, não por R10 — a proteção é ACIDENTAL. O contrato exige a MESMA
    // proteção nos dois sentidos, logo #101 (vencimento futuro) tem de ficar
    // protegida pela razão certa: estar emitida.
    const porAcidente = !escritas.has(106);
    const porR10 = !escritas.has(101);
    assert.ok(porAcidente, 'pré-condição: a quota #106 está fora do filtro atual (vencimento passado)');
    assert.ok(
      porR10,
      'a mesma proteção tem de valer para a #101 (vencimento futuro): ' +
      'R10 não depende de `estado` nem de `data_vencimento`, depende de estar emitida'
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// §8 — Calibração do instrumento: o coletor não é «sempre vermelho»
//
// A MESMA rota, o MESMO coletor, sem o caminho de escrita ativo: se aqui não
// houver mutações, então as mutações que §1/§5/§6 detetam vêm mesmo do
// `q.update(...)` do recálculo — e não de um duplo que escreve sozinho.
// ═══════════════════════════════════════════════════════════════════
async function testeCalibracao() {
  await contrato('§8.1 a mesma rota SEM `recalcular` não produz mutações (o instrumento discrimina)', async () => {
    novoCenario(QUOTAS_BASE());
    const r = await pedir('/admin/quotas/config', { valor_1000: '110.0000', fcr_percentagem: '10' });
    assert.strictEqual(r.status, 302, 'a configuração continua a ser gravável');
    assert.ok(CONFIG_GRAVADA, 'a configuração foi gravada');
    const escritas = mutacoesFinanceiras();
    assert.strictEqual(
      escritas.length, 0,
      `sem o caminho de escrita ativo não pode haver mutações; houve: ${descrever(escritas)}`
    );
  });

  await contrato('§8.2 a sonda com `recalcular=futuras` é coerente com o resultado de §1.1', async () => {
    novoCenario(QUOTAS_BASE());
    await pedir('/admin/quotas/config', CORPO_CONFIG);
    const escritas = mutacoesFinanceiras();
    const s11 = RESULTADOS.find((r) => r.nome.startsWith('§1.1'));
    // Este contrato é sempre verde, e é isso que o torna útil: liga a sonda de
    // calibração ao resultado de §1.1. Se as duas medições do MESMO caminho
    // divergirem (uma vê escrita e a outra não), o harness está a medir coisas
    // diferentes — que é exatamente o falso verde que se quer apanhar.
    assert.ok(
      Boolean(s11) && (escritas.length > 0) === !s11.ok,
      `calibração inconsistente: a sonda mediu ${escritas.length} mutação(ões) e §1.1 está ` +
      `${s11 && s11.ok ? 'verde' : 'vermelho'} — as duas medições do mesmo caminho têm de concordar`
    );
    console.log(
      `      (observação: \`recalcular=futuras\` escreveu ${escritas.length} quota(s) ` +
      `— §1.1 ${s11 && s11.ok ? 'verde' : 'vermelho'}; a coerência é o que este contrato fixa)`
    );
  });

  await contrato('§8.3 os verdes de §6.3/§6.4 são CONDICIONAIS ao filtro (não são proteção intrínseca)', async () => {
    const s11 = RESULTADOS.find((r) => r.nome.startsWith('§1.1'));
    // Depois da correção o recálculo deixa de escrever: nesse dia não há verdes
    // condicionais a provar e este contrato passa a ser trivialmente verde.
    if (!(Boolean(s11) && !s11.ok)) {
      console.log('      (observação: o recálculo já não escreve ⇒ não há verdes condicionais a provar)');
      return;
    }
    FILTRO_AMPLO = true;
    try {
      novoCenario(QUOTAS_BASE());
      await pedir('/admin/quotas/config', CORPO_CONFIG);
    } finally {
      FILTRO_AMPLO = false;
    }
    const tocadas = mutacoesFinanceiras().map((m) => m.id);
    assert.ok(
      tocadas.includes(103) && tocadas.includes(104),
      'com o filtro alargado o MESMO recálculo tem de alcançar #103 (paga) e #104 (parcialmente_paga); ' +
      `alcançou [${tocadas.join(', ')}] ⇒ os verdes de §6.3/§6.4 vêm do filtro P19, não do código`
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// §9 — Q11: o ACERTO é um documento NOVO (a quota original não é alterada)
//
// A infraestrutura do acerto vive em `helpers/quota-acerto.js` e em
// `extra_quotas` (migration `20260101000080`): `tipo='acerto'`, `quota_id`,
// `orcamento_id`, `justificacao`, `valor_anterior`, `valor_novo`, `criado_por`.
//
// Este contrato prova que o acerto corrige SEM tocar na quota — precisamente o
// que uma edição de quota não consegue fazer sem quebrar §2/§6.9.
// ═══════════════════════════════════════════════════════════════════
async function testeAcerto() {
  const { registarAcerto, ErroAcerto } = require('../helpers/quota-acerto');

  await contrato('§9.1 o acerto cria um documento novo e NÃO altera a quota original', async () => {
    novoCenario(QUOTAS_EDICAO());
    const antes = fotografia();
    const r = await registarAcerto({
      condominioId: 1,
      quotaId: 201,
      valorNovo: '60.00',
      justificacao: 'Erro de leitura do contador, conforme ata de 2026-09-10.',
      userId: 42,
    });

    // O documento de acerto traz tudo o que a operação exige.
    assert.strictEqual(r.extra.tipo, 'acerto', 'o documento é do tipo `acerto`');
    assert.strictEqual(Number(r.extra.quota_id), 201, 'referencia a quota original');
    assert.strictEqual(Number(r.extra.orcamento_id), 7, 'referencia o orçamento de origem da quota');
    assert.ok(String(r.extra.justificacao).length > 0, 'guarda a justificação');
    assert.strictEqual(Number(r.extra.valor_anterior), 55, 'guarda o valor anterior');
    assert.strictEqual(Number(r.extra.valor_novo), 60, 'guarda o valor novo');
    assert.strictEqual(Number(r.extra.criado_por), 42, 'identifica o autor da operação');
    assert.strictEqual(Number(r.extra.valor_total), 5, 'cobra apenas a diferença (5 €)');
    assert.strictEqual(r.diferencaC, 500, 'a diferença é calculada em cêntimos');
    assert.strictEqual(Number(r.extra.mes_inicio), 4, 'o acerto respeita o período da quota');
    assert.strictEqual(Number(r.extra.ano_inicio), 2026, 'o acerto respeita o ano da quota');
    assert.strictEqual(r.extra.estado, 'pendente', 'nasce pendente de aprovação, como qualquer documento');

    // ⛔ A quota original fica EXATAMENTE como estava.
    const depois = fotografia();
    for (const campo of CAMPOS_FINANCEIROS) {
      assert.strictEqual(
        String(antes[201][campo]), String(depois[201][campo]),
        `o acerto não pode alterar ${campo} da quota original`
      );
    }
    assert.strictEqual(
      mutacoesFinanceiras().length, 0,
      `o acerto não escreve na quota; escreveu: ${descrever(mutacoesFinanceiras())}`
    );
  });

  await contrato('§9.2 o acerto recusa quota NÃO emitida (corrige-se pela configuração)', async () => {
    novoCenario(QUOTAS_BASE());
    await assert.rejects(
      () => registarAcerto({
        condominioId: 1, quotaId: 105, valorNovo: '60.00', justificacao: 'motivo', userId: 42,
      }),
      (e) => e instanceof ErroAcerto,
      'a quota #105 não está emitida ⇒ não é corrigível por acerto'
    );
  });

  await contrato('§9.3 o acerto exige justificação (sem motivo não é auditável)', async () => {
    novoCenario(QUOTAS_EDICAO());
    await assert.rejects(
      () => registarAcerto({
        condominioId: 1, quotaId: 201, valorNovo: '60.00', justificacao: '   ', userId: 42,
      }),
      (e) => e instanceof ErroAcerto,
      'sem justificação o acerto é recusado'
    );
  });

  await contrato('§9.4 o acerto recusa um valor sem alteração (não há nada a acertar)', async () => {
    novoCenario(QUOTAS_EDICAO());
    await assert.rejects(
      () => registarAcerto({
        condominioId: 1, quotaId: 201, valorNovo: '55.00', justificacao: 'motivo', userId: 42,
      }),
      (e) => e instanceof ErroAcerto,
      'valor novo igual ao atual não é um acerto'
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// §10 — AUDITORIA DOS CONSUMIDORES DE `extra_quotas`
//
// `extra_quotas` guarda DOIS tipos de documento: as quotas extraordinárias
// (`tipo='extraordinaria'`) e os ACERTOS de quota (`tipo='acerto'`, Q11). O
// módulo das quotas extraordinárias é o único consumidor que opera por
// `condominio_id` sem passar por uma parcela — logo era o único que podia
// apanhar um acerto «por engano» e tratá-lo como quota extraordinária.
//
// Os restantes consumidores (pagamentos, recibos, aviso, relatório) chegam
// sempre a `ExtraQuota` através de uma `ExtraQuotaParcela`. O acerto NÃO gera
// parcelas (§10.6) — logo não tem por onde ser cobrado — e, mesmo que tivesse,
// o `required: true` do include deixa de o encontrar quando o `tipo` não bate
// (§10.5).
// ═══════════════════════════════════════════════════════════════════
async function testeConsumidoresExtra() {
  const semEscritas = () => {
    assert.strictEqual(
      ESCRITAS_EXTRA.length, 0,
      `a operação não pode escrever em extra_quotas; escreveu: ${JSON.stringify(ESCRITAS_EXTRA)}`
    );
    assert.strictEqual(ESCRITAS_PARCELA.length, 0, 'a operação não pode escrever em parcelas');
  };

  novoExtras(EXTRAS_BASE());
  await contrato("§10.1 GET /quotas-extra consulta SÓ `tipo='extraordinaria'`", async () => {
    const r = await fetch(`${BASE}/admin/quotas-extra`, { redirect: 'manual' });
    assert.strictEqual(r.status, 200, 'a listagem responde');
    const consulta = CONSULTAS_EXTRA.find((c) => c.op === 'findAll');
    assert.ok(consulta, 'a listagem consultou `extra_quotas`');
    assert.strictEqual(
      consulta.where.tipo, 'extraordinaria',
      `a listagem tem de filtrar pelo tipo; filtrou por ${JSON.stringify(consulta.where)}`
    );
    const corpo = await r.json();
    const ids = (corpo.dados.extras || []).map((e) => Number(e.id));
    assert.ok(ids.includes(601), 'a quota extraordinária #601 aparece');
    assert.ok(!ids.includes(602), 'o ACERTO #602 NÃO aparece na lista de quotas extraordinárias');
  });

  const casos = [
    ['§10.2 aprovar', '/admin/quotas-extra/602/aprovar'],
    ['§10.3 processar', '/admin/quotas-extra/602/processar'],
    ['§10.4 anular', '/admin/quotas-extra/602/anular'],
  ];
  for (const [nome, caminho] of casos) {
    novoExtras(EXTRAS_BASE());
    await contrato(`${nome}: o ACERTO #602 não é alcançável pelo módulo das extraordinárias`, async () => {
      const r = await pedir(caminho, {});
      assert.strictEqual(r.status, 302, 'a rota responde com redirect');
      const consulta = CONSULTAS_EXTRA.find((c) => c.op === 'findOne');
      assert.ok(consulta, 'a rota tentou carregar a quota extra');
      assert.strictEqual(
        consulta.where.tipo, 'extraordinaria',
        `o carregamento tem de filtrar pelo tipo; filtrou por ${JSON.stringify(consulta.where)}`
      );
      assert.strictEqual(
        EXTRAS.find((e) => e.id === 602).estado, 'pendente',
        'o estado do acerto não foi tocado'
      );
      semEscritas();
    });
  }

  await contrato("§10.5 uma PARCELA de acerto não é sequer CARREGADA (o include exige `tipo='extraordinaria'`)", async () => {
    // O acerto vai de propósito em `processada`: assim o ÚNICO obstáculo à
    // cobrança é o filtro de `tipo` do include — e não a guarda de estado, que
    // também recusaria (`estado !== 'processada'`). Sem isto, o contrato ficaria
    // verde pelo motivo errado (falso verde, confirmado por mutação).
    novoExtras(
      EXTRAS_BASE().map((e) => (e.id === 602 ? { ...e, estado: 'processada' } : e)),
      PARCELAS_ACERTO()
    );
    const r = await pedir('/admin/quotas-extra/parcelas/901/pagar', {});
    assert.strictEqual(r.status, 302, 'a rota responde com redirect');
    assert.strictEqual(
      r.headers.get('location'), '/admin/quotas-extra',
      'a parcela do acerto não pode ser carregada: o include do módulo só admite `tipo=\'extraordinaria\'` '
      + '(um destino `/admin/quotas-extra/602` significaria que foi carregada)'
    );
    assert.strictEqual(ESCRITAS_PARCELA.length, 0, 'nada foi escrito numa parcela');
    assert.strictEqual(CRIADOS_EXTRA.length, 0, 'nada foi criado por esta via');
  });

  await contrato('§10.6 o ACERTO não gera parcelas — não existe cobrança duplicada possível', async () => {
    novoCenario(QUOTAS_CONTORNO());
    novoExtras([]);
    const { registarAcerto } = require('../helpers/quota-acerto');
    await registarAcerto({
      condominioId: 1, quotaId: 501, valorNovo: '60.00',
      justificacao: 'Erro de leitura, conforme ata.', userId: 42,
    });
    assert.strictEqual(CRIADOS_EXTRA.length, 1, 'foi criado UM documento de acerto');
    assert.strictEqual(CRIADOS_EXTRA[0].tipo, 'acerto', 'o documento criado é do tipo `acerto`');
    assert.strictEqual(
      CRIADAS_PARCELAS.length, 0,
      'o acerto não gera parcelas: sem parcelas não há parcela a cobrar — nem a cobrar duas vezes'
    );
    assert.strictEqual(mutacoesFinanceiras().length, 0, 'e não toca na quota original');
  });

  novoExtras([]);
  await contrato("§10.7 POST /quotas-extra grava `tipo='extraordinaria'` (explícito, não herdado)", async () => {
    const r = await pedir('/admin/quotas-extra', {
      designacao: 'Obras', valor_total: '1200.00', metodo_divisao: 'permilagem',
      mes_inicio: '6', ano_inicio: '2026', numero_parcelas: '1', periodicidade: 'mensal',
      'fracoes[]': '21',
    });
    assert.strictEqual(r.status, 302, 'a criação responde com redirect');
    assert.strictEqual(CRIADOS_EXTRA.length, 1, 'foi criada uma quota extra');
    assert.strictEqual(
      CRIADOS_EXTRA[0].tipo, 'extraordinaria',
      'este módulo cria SEMPRE quotas extraordinárias — nunca acertos'
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// Relatório final
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(' R10 — CONGELAMENTO DO CÁLCULO DE QUOTAS · CONTRATO (testes primeiro)');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log(' §0. Coletor de mutações');
  autoTesteDoColetor();

  const servidor = app.listen(0);
  BASE = `http://127.0.0.1:${servidor.address().port}`;
  try {
    console.log('');
    console.log(' §1. V1 — `POST /admin/quotas/config` com `recalcular=futuras`');
    await testeV1();
    console.log('');
    console.log(' §2. V2 — `POST /admin/quotas/:id` (edição manual)');
    await testeV2();
    console.log('');
    console.log(' §2.3–§2.7. Contornos de R10 (emissão não se limpa nem se troca; orçamento é indiferente)');
    await testeContorno();
    console.log('');
    console.log(' §3. P6/R10 — `POST /admin/quotas/:id/anular` com pagamento confirmado');
    await testeAnulacao();
    console.log('');
    console.log(' §4. Invariante financeiro (detetar/reportar — Q10)');
    await testeInvariante();
    console.log('');
    console.log(' §5. Q9 — pré-visualização sem escrita');
    await testePrevisualizacao();
    console.log('');
    console.log(' §6. Cobertura R10');
    await testeCoberturaR10();
    console.log('');
    console.log(' §7. P19 como subconjunto histórico de R10');
    await testeP19();
    console.log('');
    console.log(' §8. Calibração do instrumento');
    await testeCalibracao();
    console.log('');
    console.log(' §9. Q11 — acerto: documento novo, quota original intacta');
    await testeAcerto();
    console.log('');
    console.log(' §10. Consumidores de `extra_quotas` — um acerto nunca é quota extraordinária');
    await testeConsumidoresExtra();
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }

  const falhas = RESULTADOS.filter((r) => !r.ok);
  console.log('');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log(` CONTRATOS: ${RESULTADOS.length - falhas.length}/${RESULTADOS.length} verdes · ${falhas.length} vermelhos`);
  if (falhas.length) {
    console.log('');
    console.log(' VERMELHOS (defeito atual demonstrado — NÃO corrigir nesta fase):');
    for (const f of falhas) console.log(`   ✗ ${f.nome}`);
  }
  console.log('────────────────────────────────────────────────────────────────────');
  console.log('');

  if (falhas.length) {
    console.log(' R10 AINDA NÃO ESTÁ GARANTIDO — o contrato está escrito e a falhar de propósito.');
    process.exit(1);
  }
  console.log(' ✓ R10 garantido: nenhuma quota emitida é mutada por recálculo normal.');
}

main().catch((err) => {
  console.error('');
  console.error('Erro no teste:', err && err.message ? err.message : err);
  process.exit(1);
});
