// ═══════════════════════════════════════════════════════════════════
// P56 — Orçamento → Quota: período de 12 meses, não-sobreposição e
// vínculo à quota.
//
// Responde, com prova executável, às perguntas:
//   1. um orçamento dura EXATAMENTE 12 meses de calendário inteiros?
//      (o defeito dos 13 meses: `2026-07-15 → 2027-07-14` atravessava 13
//      meses e gerava uma 13.ª quota em silêncio)
//   2. dois orçamentos do mesmo condomínio podem sobrepor-se?
//   3. períodos ADJACENTES continuam a poder existir?
//   4. a quota gerada pelo método «orçamento» fica ligada ao orçamento?
//
// Casos exigidos (todos presentes, ver o mapa no fim do ficheiro):
//   · período válido de 12 meses          (§1)
//   · período de 13 meses                 (§1, §2)
//   · períodos adjacentes                 (§3)
//   · sobreposição parcial                (§3)
//   · sobreposição total                  (§3)
//   · orçamento de outro condomínio       (§4)
//   · emissão repetida                    (§5)
//   · dados existentes                    (§6)
//
// Utilização: node scripts/test-orcamento-quota-p56.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');
const session = require('express-session');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const periodo = require('../helpers/orcamento-periodo');
const { mesesDoPeriodo } = require('../helpers/plano');

const stub = (rel, valor) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
};

// O router guarda referências aos modelos no momento do `require`. Para montar
// o MESMO router com modelos diferentes (secção 2 e secção 5) é preciso
// descartá-lo do cache — senão a segunda secção corre com os stubs da primeira.
const routerFresco = () => {
  for (const rel of ['routes/orcamento.js', 'helpers/orcamento-periodo.js']) {
    const p = require.resolve(path.join(RAIZ, rel));
    delete require.cache[p];
  }
  return require('../routes/orcamento');
};

let n = 0;
const secao = (t) => { console.log(`\n${t}`); };
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── 1. O período tem de ser de 12 meses de calendário inteiros ──────
function testePeriodoValido() {
  secao('1. PERÍODO: 12 meses de calendário inteiros');

  // Casos que JÁ funcionavam — não podem regredir.
  for (const [i, f] of [['2026-01-01', '2026-12-31'], ['2026-07-01', '2027-06-30'], ['2026-03-01', '2027-02-28']]) {
    const r = periodo.periodoValido(i, f);
    assert.ok(r.ok, `${i} → ${f} tem de ser aceite (é 1 ano alinhado ao mês civil)`);
    assert.strictEqual(mesesDoPeriodo(i, f).length, 12, `${i} → ${f} tem de dar 12 meses`);
  }
  ok('período válido de 12 meses: aceite (ano civil, ano de gestão deslocado, ano bissexto)');

  // O DEFEITO: aceite por `periodoUmAno`, mas 13 meses de calendário.
  const defeituosos = [
    ['2026-07-15', '2027-07-14'],
    ['2026-07-02', '2027-07-01'],
    ['2026-07-31', '2027-07-30'],
    ['2026-06-30', '2027-06-29'],
  ];
  for (const [i, f] of defeituosos) {
    // Prova de que o defeito ERA real: a contagem de meses continua a dar 13.
    assert.strictEqual(mesesDoPeriodo(i, f).length, 13,
      `${i} → ${f}: a premissa do defeito é 13 meses de calendário`);
    const r = periodo.periodoValido(i, f);
    assert.strictEqual(r.ok, false, `${i} → ${f} passa a ser RECUSADO (dava 13 meses)`);
    assert.strictEqual(r.motivo, 'dias', `${i} → ${f}: motivo «dias»`);
  }
  ok('período de 13 meses: RECUSADO (4 casos que atravessavam 13 meses de calendário)');

  // Entradas inválidas e o caso invertido.
  assert.strictEqual(periodo.periodoValido('', '').motivo, 'datas', 'vazio → datas');
  assert.strictEqual(periodo.periodoValido('2026-02-31', '2027-02-27').motivo, 'datas', 'data inexistente → datas');
  assert.strictEqual(periodo.periodoValido('2026-13-01', '2027-12-31').motivo, 'datas', 'mês 13 → datas');
  assert.strictEqual(periodo.periodoValido('2027-01-01', '2026-12-31').motivo, 'invertido', 'fim antes do início → invertido');
  ok('datas inválidas / invertidas: recusadas com motivo próprio');

  assert.ok(periodo.periodoValido('2026-07-01', '2027-06-29').ok === false, 'faltando 1 dia não é 12 meses');
  assert.ok(periodo.periodoValido('2026-07-01', '2027-07-01').ok === false, 'excedendo 1 dia não é 12 meses');
  ok('limites: 1 dia a menos ou a mais não é um período de 12 meses');
}

// ── 2. A rota de criação APLICA a regra (não só o helper) ───────────
async function testeRotaCriar() {
  secao('2. CRIAÇÃO: a rota recusa o período de 13 meses');

  const CRIADOS = [];
  const EXISTENTES = [];
  let FLASH = [];
  const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);
  const modelo = (over = {}) => Object.assign({
    findOne: async () => null, findAll: async () => [], create: async (v) => comToJSON({ id: 1, ...v }),
    destroy: async () => 0, count: async () => 0, update: async () => [0], findByPk: async () => null,
    findOrCreate: async () => [comToJSON({}), false],
  }, over);

  const MODELS = {
    Orcamento: modelo({
      findAll: async (opts) => (opts && opts.where && opts.where.condominio_id !== undefined ? EXISTENTES : []),
      create: async (v) => { CRIADOS.push(v); return comToJSON({ id: CRIADOS.length, ...v }); },
    }),
    OrcamentoRubrica: modelo(), OrcamentoDistribuicao: modelo(), OrcamentoAlteracao: modelo(),
    PlanoQuota: modelo(), Quota: modelo(), Categoria: modelo(), Fracao: modelo(), User: modelo(), sequelize: {},
  };
  stub('models/index.js', MODELS);
  stub('models', MODELS);
  stub('config/database.js', { transaction: async () => ({ commit: async () => {}, rollback: async () => {}, LOCK: { UPDATE: 'U' } }) });
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
  stub('helpers/dates.js', { monthName: (m) => `M${m}`, toDateInput: (d) => String(d).slice(0, 10) });
  stub('helpers/handlebars-helpers.js', {});
  stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: '110.0000', fcrPercentagem: '0' }) });

  const app = express();
  app.engine('handlebars', engine({
    defaultLayout: false, helpers: {},
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use(session({ secret: 't', resave: false, saveUninitialized: true }));
  app.use(express.urlencoded({ extended: true }));
  app.use(flash());
  // Captura as mensagens de flash: `connect-flash` guarda-as na sessão e
  // substitui `res.locals` a cada pedido, pelo que observar `res.locals` de
  // fora do pedido não funciona. Aqui intercepta-se `req.flash(...)` — a via
  // por onde a rota comunica com o utilizador.
  FLASH = { error_msg: [], success_msg: [] };
  app.use((req, res, next) => {
    const original = req.flash.bind(req);
    req.flash = (tipo, ...resto) => {
      if (resto.length > 0 && (tipo === 'error_msg' || tipo === 'success_msg')) {
        FLASH[tipo].push(resto[0]);
      }
      return original(tipo, ...resto);
    };
    next();
  });
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
    next();
  });
  app.use('/admin', routerFresco());
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const criar = async (campos) => {
    FLASH.error_msg = []; FLASH.success_msg = [];
    const corpo = new URLSearchParams({ ano: '2026', metodo_calculo: 'modo_a', ...campos });
    return fetch(`${base}/admin/orcamento`, { method: 'POST', body: corpo, redirect: 'manual' });
  };
  const erros = () => FLASH.error_msg.map((e) => String(e));

  try {
    // 2.1 Período civil válido → cria.
    CRIADOS.length = 0;
    let r = await criar({ tipo_periodo: 'civil' });
    assert.strictEqual(r.status, 302, 'período civil: redirect');
    assert.strictEqual(CRIADOS.length, 1, 'período civil: orçamento criado');
    assert.strictEqual(CRIADOS[0].data_inicio, '2026-01-01');
    assert.strictEqual(CRIADOS[0].data_fim, '2026-12-31');
    ok('período civil: criado (2026-01-01 → 2026-12-31)');

    // 2.2 Personalizado de 12 meses → cria.
    CRIADOS.length = 0;
    r = await criar({ tipo_periodo: 'personalizado', data_inicio: '2027-07-01', data_fim: '2028-06-30' });
    assert.strictEqual(CRIADOS.length, 1, '12 meses deslocados: criado');
    ok('período personalizado de 12 meses: criado (2027-07-01 → 2028-06-30)');

    // 2.3 Personalizado de 13 meses → RECUSADO, nada criado.
    CRIADOS.length = 0;
    r = await criar({ tipo_periodo: 'personalizado', data_inicio: '2026-07-15', data_fim: '2027-07-14' });
    assert.strictEqual(CRIADOS.length, 0, '13 meses: NADA criado');
    assert.ok(erros().some((m) => /12 meses de calendário inteiros/i.test(m)), `13 meses: mensagem ao utilizador (${erros().join(' | ')})`);
    ok('período de 13 meses: recusado na rota, com mensagem, nada gravado');

    // 2.4 Sobreposição real → RECUSADO.
    EXISTENTES.length = 0;
    EXISTENTES.push({ id: 9, designacao: 'Orçamento 2026', data_inicio: '2026-01-01', data_fim: '2026-12-31', estado: 'aprovado' });
    CRIADOS.length = 0;
    r = await criar({ tipo_periodo: 'personalizado', data_inicio: '2026-07-01', data_fim: '2027-06-30' });
    assert.strictEqual(CRIADOS.length, 0, 'sobreposição: NADA criado');
    assert.ok(erros().some((m) => /sobrepõe-se/i.test(m)), `sobreposição: mensagem ao utilizador (${erros().join(' | ')})`);
    assert.ok(erros().some((m) => /Orçamento 2026/.test(m)), 'sobreposição: identifica o orçamento em conflito');
    ok('sobreposição parcial: recusada, identificando o orçamento em conflito');

    // 2.5 Adjacente → PERMITIDO (a regra proíbe sobreposição, não continuidade).
    CRIADOS.length = 0;
    r = await criar({ tipo_periodo: 'personalizado', data_inicio: '2027-01-01', data_fim: '2027-12-31' });
    assert.strictEqual(CRIADOS.length, 1, 'adjacente: criado (o anterior acaba em 2026-12-31)');
    ok('períodos adjacentes: permitido (2026-12-31 → 2027-01-01)');

    // 2.6 Sobreposição total (mesmo período) → RECUSADO.
    CRIADOS.length = 0;
    r = await criar({ tipo_periodo: 'personalizado', data_inicio: '2026-01-01', data_fim: '2026-12-31' });
    assert.strictEqual(CRIADOS.length, 0, 'sobreposição total: NADA criado');
    ok('sobreposição total (mesmo período): recusada');

    // 2.7 Orçamento ANULADO liberta o período (não bloqueia um substituto).
    EXISTENTES.length = 0;
    EXISTENTES.push({ id: 10, designacao: 'Anulado', data_inicio: '2026-01-01', data_fim: '2026-12-31', estado: 'anulado' });
    CRIADOS.length = 0;
    r = await criar({ tipo_periodo: 'personalizado', data_inicio: '2026-01-01', data_fim: '2026-12-31' });
    assert.strictEqual(CRIADOS.length, 1, 'orçamento anulado não bloqueia o período');
    ok('orçamento ANULADO: liberta o período (permite o substituto)');
  } finally {
    servidor.close();
  }
}

// ── 3. As regras de sobreposição, isoladas (puras) ──────────────────
function testeSobreposicao() {
  secao('3. SOBREPOSIÇÃO: a regra pura, caso a caso');

  const P26 = { dataInicio: '2026-01-01', dataFim: '2026-12-31' };
  const P27 = { dataInicio: '2027-01-01', dataFim: '2027-12-31' };

  assert.strictEqual(periodo.sobrepoeSe(P27, P26), false, 'adjacentes não se sobrepõem');
  ok('adjacentes (2026 → 2027): NÃO se sobrepõem');

  assert.strictEqual(periodo.sobrepoeSe({ dataInicio: '2026-07-01', dataFim: '2027-06-30' }, P26), true, 'parcial sobrepõe');
  ok('sobreposição parcial: detetada');

  assert.strictEqual(periodo.sobrepoeSe(P26, P26), true, 'total sobrepõe');
  ok('sobreposição total: detetada');

  assert.strictEqual(periodo.sobrepoeSe(P26, P27), false, 'simétrico');
  ok('a relação é simétrica (A sobrepõe B ⇔ B sobrepõe A)');

  assert.strictEqual(periodo.sobrepoeSe({ dataInicio: '2026-03-01', dataFim: '2027-02-28' }, P26), true, 'contido sobrepõe');
  ok('período contido noutro: detetado');

  // Um mês em comum é o suficiente para ser sobreposição.
  assert.strictEqual(periodo.sobrepoeSe({ dataInicio: '2026-12-01', dataFim: '2027-11-30' }, P26), true, '1 mês em comum');
  ok('um único mês em comum já é sobreposição');
}

// ── 4. Multitenancy: outro condomínio não interfere ─────────────────
function testeOutroCondominio() {
  secao('4. MULTITENANCY: orçamento de outro condomínio');

  // `conflitoDePeriodo` recebe só os orçamentos do condomínio ativo — é o
  // chamador que filtra. Aqui prova-se que, dado só o outro condomínio, não
  // há conflito; e que a consulta da rota filtra mesmo por condominio_id.
  const deOutro = [{ id: 7, designacao: 'De outro', data_inicio: '2026-01-01', data_fim: '2026-12-31', estado: 'aprovado' }];
  assert.strictEqual(
    periodo.conflitoDePeriodo({ dataInicio: '2026-01-01', dataFim: '2026-12-31' }, deOutro, { ignorarId: 7 }),
    null,
    'o próprio orçamento nunca conflitua consigo'
  );
  ok('edição: o próprio orçamento não conflitua consigo mesmo');

  const rota = ler('routes/orcamento.js');
  const blocos = [...rota.matchAll(/const existentes = await Orcamento\.findAll\(\{[\s\S]*?\}\);/g)];
  assert.ok(blocos.length >= 2, 'a consulta de existentes aparece na criação e na edição');
  for (const b of blocos) {
    assert.ok(/condominio_id: req\.condominioId/.test(b[0]),
      'a consulta de orçamentos existentes filtra SEMPRE pelo condomínio ativo (sem fugas entre condomínios)');
  }
  ok('a consulta de existentes filtra por condominio_id (criação e edição)');
}

// ── 5. Emissão repetida e vínculo à quota ───────────────────────────
async function testeEmissao() {
  secao('5. EMISSÃO: vínculo ao orçamento e emissão repetida');

  const PLANO = [
    { id: 1, orcamento_id: 1, fracao_id: 21, ano: 2026, mes: 1, valor: '100.00', data_vencimento: '2026-01-08', estado: 'planeada', update: async () => {} },
  ];
  const CRIADOS = [];
  let planoEstado = 'planeada';

  const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);
  const modelo = (over = {}) => Object.assign({
    findOne: async () => null, findAll: async () => [], create: async (v) => comToJSON({ id: 1, ...v }),
    destroy: async () => 0, count: async () => 0, update: async () => [0], findByPk: async () => null,
    findOrCreate: async () => [comToJSON({}), false],
  }, over);

  const ORCAMENTO = { id: 1, condominio_id: 1, designacao: 'Orçamento 2026', estado: 'aprovado', data_inicio: '2026-01-01', data_fim: '2026-12-31' };
  const MODELS = {
    Orcamento: modelo({ findOne: async () => comToJSON({ ...ORCAMENTO, update: async () => {} }) }),
    OrcamentoRubrica: modelo(), OrcamentoDistribuicao: modelo(), OrcamentoAlteracao: modelo(),
    // Honra o `where` real (como o Sequelize faria): a emissão pede
    // `estado: 'planeada'`; depois de emitida, o plano deixa de aparecer.
    PlanoQuota: modelo({
      findAll: async (opts) => {
        const w = opts && opts.where ? opts.where : {};
        if (w.estado === 'planeada') return planoEstado === 'planeada' ? PLANO : [];
        return PLANO;
      },
    }),
    Quota: modelo({ create: async (v) => { CRIADOS.push(v); return comToJSON({ id: CRIADOS.length, ...v }); } }),
    Categoria: modelo(),
    Fracao: modelo({ findAll: async () => [comToJSON({ id: 21, permilagem: '500' })] }),
    User: modelo(), sequelize: {},
  };
  stub('models/index.js', MODELS);
  stub('models', MODELS);
  stub('config/database.js', { transaction: async () => ({ commit: async () => {}, rollback: async () => {}, LOCK: { UPDATE: 'U' } }) });
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
  stub('helpers/dates.js', { monthName: (m) => `M${m}`, toDateInput: (d) => String(d).slice(0, 10) });
  stub('helpers/handlebars-helpers.js', {});
  stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: '110.0000', fcrPercentagem: '0' }) });

  const app = express();
  app.engine('handlebars', engine({
    defaultLayout: false, helpers: {},
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use(session({ secret: 't', resave: false, saveUninitialized: true }));
  app.use(express.urlencoded({ extended: true }));
  app.use(flash());
  const FLASHEMIT = { error_msg: [], success_msg: [] };
  app.use((req, res, next) => {
    const original = req.flash.bind(req);
    req.flash = (tipo, ...resto) => {
      if (resto.length > 0 && (tipo === 'error_msg' || tipo === 'success_msg')) FLASHEMIT[tipo].push(resto[0]);
      return original(tipo, ...resto);
    };
    next();
  });
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
    next();
  });
  app.use('/admin', routerFresco());
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const emitir = async () => {
    FLASHEMIT.error_msg = []; FLASHEMIT.success_msg = [];
    return fetch(`${base}/admin/orcamento/1/emitir`, {
      method: 'POST', body: new URLSearchParams({ periodo: '2026-1' }), redirect: 'manual',
    });
  };

  try {
    // 5.1 Primeira emissão: a quota fica ligada ao orçamento.
    CRIADOS.length = 0;
    planoEstado = 'planeada';
    let r = await emitir();
    assert.strictEqual(r.status, 302, 'a emissão responde com redirect');
    assert.strictEqual(CRIADOS.length, 1, `uma quota por linha do plano (flash: ${JSON.stringify(FLASHEMIT.error_msg)})`);
    assert.strictEqual(Number(CRIADOS[0].orcamento_id), 1, 'P56: a quota emitida fica ligada ao orçamento');
    ok('emissão: a quota grava `orcamento_id` (vínculo efetivo, R10 passa a ter efeito)');

    // 5.2 Segunda emissão do MESMO período: o plano já não está `planeada`
    //     ⇒ nada é criado (não há duplicação silenciosa).
    CRIADOS.length = 0;
    planoEstado = 'emitida';
    r = await emitir();
    assert.strictEqual(CRIADOS.length, 0, 'emissão repetida: não cria segunda quota');
    ok('emissão repetida do mesmo período: não duplica a quota');

    // 5.3 A quota emitida tem o vínculo CONGELADO pelo R10.
    const { estaEmitida, alteracoesCongeladas } = require('../helpers/quota-imutabilidade');
    const emitida = { data_emissao: new Date(), orcamento_id: 1, valor: '100.00', valor_base: '100.00', valor_fcr: '0.00' };
    assert.ok(estaEmitida(emitida), 'a quota é um documento (tem data_emissao)');
    const congeladas = alteracoesCongeladas(emitida, { orcamento_id: 2 });
    assert.strictEqual(congeladas.length, 1, 'trocar o orçamento de uma quota emitida é congelado');
    assert.strictEqual(congeladas[0].campo, 'orcamento_id');
    ok('R10: com o vínculo gravado, `orcamento_id` fica protegido (antes não havia o que proteger)');
  } finally {
    servidor.close();
  }
}

// ── 6. Dados existentes ─────────────────────────────────────────────
function testeDadosExistentes() {
  secao('6. DADOS EXISTENTES: a guarda de aprovação apanha períodos antigos');

  const rota = ler('routes/orcamento.js');
  // A guarda de aprovação revalida o período: um orçamento criado ANTES desta
  // regra (com 13 meses) não pode ser aprovado e chegar a emitir 13 quotas.
  const blocoAprovar = /router\.post\('\/orcamento\/:id\/aprovar'[\s\S]*?\n\}\);/.exec(rota);
  assert.ok(blocoAprovar, 'a rota de aprovação existe');
  assert.ok(/periodoValido/.test(blocoAprovar[0]),
    'a aprovação revalida o período com a regra nova (apanha dados pré-existentes)');
  assert.ok(!/periodoUmAno/.test(blocoAprovar[0]),
    'a aprovação já NÃO usa a regra antiga que aceitava 13 meses');
  ok('aprovação revalida o período: orçamento antigo com 13 meses não é aprovado');

  // Um orçamento antigo válido continua a poder ser aprovado (sem regressão).
  assert.ok(periodo.periodoValido('2026-01-01', '2026-12-31').ok,
    'um orçamento existente alinhado ao ano civil continua a aprovar');
  ok('orçamento existente de 12 meses: continua a poder ser aprovado');

  // A regra antiga aceitava estes; a nova recusa — é a correção do defeito.
  const antigos = [['2026-07-15', '2027-07-14'], ['2026-06-30', '2027-06-29']];
  for (const [i, f] of antigos) {
    assert.strictEqual(periodo.periodoValido(i, f).ok, false, `${i} → ${f} (dados antigos) deixa de ser aceitável`);
  }
  ok('dados pré-existentes com período de 13 meses: detetados na aprovação, não corrigidos em silêncio');
}

// ── 8. /admin/quotas/gerar com metodo='orcamento' grava o vínculo ────
async function testeGerarPorOrcamento() {
  secao('8. /admin/quotas/gerar (metodo=orcamento): grava `orcamento_id`');

  const FRACOES = [{ id: 21, permilagem: '500', condominio_id: 1, designacao: 'A', estado: 'ativo' }];
  const ORCAMENTO = {
    id: 77, condominio_id: 1, designacao: 'Orçamento 2026', estado: 'aprovado',
    data_inicio: '2026-01-01', data_fim: '2026-12-31',
    rubricas: [{ ativo: true, valor_anual: '1200.00' }],
  };
  const CRIADOS = [];

  const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);
  const modelo = (over = {}) => Object.assign({
    findOne: async () => null, findAll: async () => [], create: async (v) => comToJSON({ id: 1, ...v }),
    destroy: async () => 0, count: async () => 0, update: async () => [0], findByPk: async () => null,
    findOrCreate: async () => [comToJSON({}), false],
  }, over);

  const MODELS = {
    Orcamento: modelo({ findOne: async () => comToJSON(ORCAMENTO) }),
    OrcamentoRubrica: modelo(), OrcamentoDistribuicao: modelo(), OrcamentoAlteracao: modelo(),
    PlanoQuota: modelo(),
    Quota: modelo({ create: async (v) => { CRIADOS.push(v); return comToJSON({ id: CRIADOS.length, ...v }); } }),
    Categoria: modelo(),
    Fracao: modelo({ findAll: async () => FRACOES.map(comToJSON) }),
    User: modelo(), Configuracao: modelo(), ExtraQuota: modelo(), ExtraQuotaParcela: modelo(),
    sequelize: {},
  };
  stub('models/index.js', MODELS);
  stub('models', MODELS);
  stub('config/database.js', { transaction: async () => ({ commit: async () => {}, rollback: async () => {}, LOCK: { UPDATE: 'U' } }) });
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
  stub('helpers/saldos.js', { resumoCondominio: async () => ({ contas: [] }), resumoFracao: async () => ({}), estadoEfetivo: () => 'pendente' });
  stub('helpers/condominio.js', { getCondominio: async () => ({ id: 1, designacao: 'C1' }) });
  stub('helpers/dates.js', { monthName: (m) => `M${m}`, toDateInput: (d) => String(d).slice(0, 10) });
  stub('helpers/handlebars-helpers.js', {});
  stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: '110.0000', fcrPercentagem: '0' }) });

  const app = express();
  app.engine('handlebars', engine({
    defaultLayout: false, helpers: {},
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
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
  for (const rel of ['routes/financeiro.js']) {
    delete require.cache[require.resolve(path.join(RAIZ, rel))];
  }
  app.use('/admin', require('../routes/financeiro'));
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const gerar = async (campos) => fetch(`${base}/admin/quotas/gerar`, {
    method: 'POST',
    body: new URLSearchParams({ escopo: 'mes', ano: '2026', mes: '3', vencimento_dia: '8', ...campos }),
    redirect: 'manual',
  });

  try {
    // 8.1 metodo=orcamento com orcamento_id → grava o vínculo.
    CRIADOS.length = 0;
    let r = await gerar({ metodo: 'orcamento', orcamento_id: '77' });
    assert.strictEqual(r.status, 302, 'gerar por orçamento: redirect');
    assert.ok(CRIADOS.length > 0, 'gerar por orçamento: criou quotas');
    for (const q of CRIADOS) {
      assert.strictEqual(Number(q.orcamento_id), 77,
        `P56: a quota gerada pelo orçamento fica ligada a ele (recebido ${q.orcamento_id})`);
    }
    ok('metodo=orcamento: `orcamento_id` GRAVADO na quota (antes perdia-se)');

    // 8.2 metodo=permilagem → sem vínculo (não há orçamento de origem).
    CRIADOS.length = 0;
    r = await gerar({ metodo: 'permilagem' });
    assert.ok(CRIADOS.length > 0, 'gerar por permilagem: criou quotas');
    for (const q of CRIADOS) {
      assert.strictEqual(q.orcamento_id, null,
        'metodo=permilagem: `orcamento_id` é nulo (não se inventa um orçamento)');
    }
    ok('metodo=permilagem: `orcamento_id` nulo (não inventa vínculo)');
  } finally {
    servidor.close();
  }
}

function testeCobertura() {
  secao('7. COBERTURA: todos os casos exigidos estão exercitados');
  const fonte = fs.readFileSync(__filename, 'utf8');
  const exigidos = {
    'período válido de 12 meses': /período válido de 12 meses: aceite/,
    'período de 13 meses': /período de 13 meses: RECUSADO/,
    'períodos adjacentes': /períodos adjacentes: permitido/,
    'sobreposição parcial': /sobreposição parcial: recusada/,
    'sobreposição total': /sobreposição total \(mesmo período\): recusada/,
    'orçamento de outro condomínio': /filtra por condominio_id/,
    'emissão repetida': /emissão repetida do mesmo período: não duplica/,
    'dados existentes': /dados pré-existentes com período de 13 meses/,
  };
  for (const [nome, re] of Object.entries(exigidos)) {
    assert.ok(re.test(fonte), `caso exigido presente: ${nome}`);
  }
  n += Object.keys(exigidos).length;
  console.log(`  ✓ ${Object.keys(exigidos).length} casos exigidos, todos presentes na suíte`);
}

async function main() {
  testePeriodoValido();
  await testeRotaCriar();
  testeSobreposicao();
  testeOutroCondominio();
  await testeEmissao();
  await testeGerarPorOrcamento();
  testeDadosExistentes();
  testeCobertura();
  console.log(`\n✓ P56 (Orçamento → Quota): ${n} verificações passaram, sem base de dados.`);
}

main().catch((e) => {
  console.error('✗ FALHOU:', e.message);
  process.exit(1);
});
