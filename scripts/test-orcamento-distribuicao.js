// ═══════════════════════════════════════════════════════════════════
// Distribuição do orçamento pelas quotas — gravação (POST
// /admin/orcamento/:id/distribuicao).
//
// DEFEITO CORRIGIDO
// Os campos do formulário eram `dist[<rubricaId>][<fracaoId>]`. O body-parser
// (`qs`, via `express.urlencoded({ extended: true })`) interpreta chaves
// numéricas ABAIXO de `arrayLimit` (100) como ÍNDICES DE ARRAY. Com ids < 100
// o corpo era convertido em `[[…],[…]]`, os ids desapareciam e a gravação
// tentava `rubrica_id = 0` → o MySQL recusava com `ER_NO_REFERENCED_ROW_2`
// (FK `rubrica_id` → `orcamento_rubricas`). O utilizador via apenas o aviso
// genérico «Erro ao guardar a distribuição.».
//
// A correção usa prefixos não numéricos (`dist[r<id>][f<id>]`) e valida o
// âmbito (rubrica deste orçamento, fração do condomínio ativo).
//
// Utilização: node scripts/test-orcamento-distribuicao.js
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

// ── 1. A CAUSA RAIZ: o body-parser destrói ids numéricos < 100 ─────
// Prova-se com o MESMO parser do app (`express.urlencoded({extended:true})`),
// não com uma suposição sobre o comportamento do `qs`.
async function testeCausaRaizDoParser() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.post('/t', (req, res) => res.json({ dist: req.body.dist }));
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const enviar = async (corpo) => {
    const r = await fetch(`${base}/t`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: corpo,
    });
    return (await r.json()).dist;
  };
  try {
    // Nomes ANTIGOS, ids < 100: os ids perdem-se (vira array).
    const antigo = await enviar('dist[11][21]=100&dist[12][22]=200');
    assert.ok(Array.isArray(antigo),
      'nomes antigos com ids < 100 → o corpo vira ARRAY (os ids perdem-se)');
    assert.deepStrictEqual(Object.keys(antigo), ['0', '1'],
      'as chaves passam a ser índices 0,1 — os ids 11,12,21,22 desaparecem');
    // É daqui que vinha o `rubrica_id = 0`: Number('0') === 0.
    assert.strictEqual(Number(Object.keys(antigo)[0]), 0,
      'a primeira chave é "0" → Number() dá 0 → rubrica_id = 0 → FK recusa');

    // Nomes NOVOS (prefixados): os ids chegam intactos.
    const novo = await enviar('dist[r11][f21]=100&dist[r12][f22]=200');
    assert.ok(!Array.isArray(novo), 'nomes prefixados → objeto (não array)');
    assert.deepStrictEqual(Object.keys(novo), ['r11', 'r12'], 'as rubricas chegam com o id preservado');
    assert.deepStrictEqual(Object.keys(novo.r11), ['f21'], 'as frações chegam com o id preservado');
    assert.strictEqual(novo.r11.f21, '100', 'o valor chega intacto');
  } finally {
    servidor.close();
  }
  console.log('  ✓ 1. causa raiz: chaves numéricas < 100 são interpretadas como índices de array');
}

// ── 2. A vista usa nomes prefixados ───────────────────────────────
function testeVistaUsaPrefixo() {
  const vista = ler('views/admin/orcamento/distribuicao.handlebars');
  assert.ok(/name="dist\[r\{\{rubricaId\}\}\]\[f\{\{\.\.\/id\}\}\]"/.test(vista),
    'a vista emite dist[r<rubricaId>][f<fracaoId>]');
  assert.ok(!/name="dist\[\{\{rubricaId\}\}\]\[\{\{\.\.\/id\}\}\]"/.test(vista),
    'a vista já não emite dist[<rubricaId>][<fracaoId>] (nomes que o parser destruía)');
  console.log('  ✓ 2. a vista usa nomes de campo prefixados');
}

// ── 3. A rota interpreta os prefixos e valida o âmbito ────────────
function testeRotaInterpretaPrefixo() {
  const rota = ler('routes/orcamento.js');
  assert.ok(/replace\(\/\^r\/, ''\)/.test(rota), 'a rota remove o prefixo `r` da rubrica');
  assert.ok(/replace\(\/\^f\/, ''\)/.test(rota), 'a rota remove o prefixo `f` da fração');
  assert.ok(/Array\.isArray\(corpo\)/.test(rota),
    'a rota deteta o corpo em array (formulário antigo) e não grava lixo');
  assert.ok(/rubricasDoOrcamento/.test(rota), 'a rota valida a rubrica contra o orçamento');
  assert.ok(/fracoesDoAtivo/.test(rota), 'a rota valida a fração contra o condomínio ativo');
  assert.ok(/ER_NO_REFERENCED_ROW_2/.test(rota),
    'a rota reconhece o erro de FK e explica a causa ao utilizador');
  assert.ok(/sqlMessage/.test(rota), 'a rota regista o erro real do MySQL (não só a mensagem genérica)');
  console.log('  ✓ 3. a rota interpreta os prefixos, valida o âmbito e explica a falha');
}

// ── 4. Fluxo REAL ponta a ponta (formulário → rota → create) ──────
async function testeFluxoReal() {
  const stub = (rel, valor) => {
    const p = require.resolve(path.join(RAIZ, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
  };

  // Fixtures: ids PEQUENOS (< 100) — é o caso que rebentava em produção.
  const RUBRICAS = [
    { id: 11, orcamento_id: 1, descricao: 'Eletricidade', valor_anual: '600.00', metodo_distribuicao: 'permilagem', periodicidade: 'mensal', ativo: true },
    { id: 12, orcamento_id: 1, descricao: 'Diversos', valor_anual: '400.00', metodo_distribuicao: 'permilagem', periodicidade: 'mensal', ativo: true },
    { id: 99, orcamento_id: 2, descricao: 'DE OUTRO ORÇAMENTO', valor_anual: '1.00', metodo_distribuicao: 'permilagem', periodicidade: 'mensal', ativo: true },
  ];
  const FRACOES = [
    { id: 21, designacao: 'A', permilagem: '600', estado: 'ativo', condominio_id: 1 },
    { id: 22, designacao: 'B', permilagem: '400', estado: 'ativo', condominio_id: 1 },
    { id: 77, designacao: 'X', permilagem: '100', estado: 'ativo', condominio_id: 2 },
  ];
  const ORCAMENTO = { id: 1, condominio_id: 1, estado: 'rascunho', data_inicio: '2026-01-01', data_fim: '2026-12-31' };

  const CRIADOS = [];
  const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);
  const rubricaIdsValidos = new Set([11, 12, 99]);
  const fracaoIdsValidos = new Set([21, 22, 77]);

  // Rubricas DESTE orçamento (1). A 99 pertence ao orçamento 2 — existe na BD
  // (a FK aceitá-la-ia), mas não pode ser usada nesta distribuição.
  const doOrcamento1 = () => RUBRICAS.filter((r) => r.orcamento_id === 1).map(comToJSON);

  const modelo = (over = {}) => Object.assign({
    findOne: async () => {
      const base = comToJSON({ ...ORCAMENTO });
      base.rubricas = doOrcamento1();
      return base;
    },
    findAll: async () => [],
    create: async (vals) => {
      CRIADOS.push(vals);
      // A FK, tal como o MySQL a aplica.
      if (vals.rubrica_id !== undefined && !rubricaIdsValidos.has(Number(vals.rubrica_id))) {
        const e = new Error('FK rubrica_id');
        e.code = 'ER_NO_REFERENCED_ROW_2'; e.errno = 1452; e.sqlMessage = 'FK rubrica_id';
        throw e;
      }
      if (vals.fracao_id !== undefined && !fracaoIdsValidos.has(Number(vals.fracao_id))) {
        const e = new Error('FK fracao_id');
        e.code = 'ER_NO_REFERENCED_ROW_2'; e.errno = 1452; e.sqlMessage = 'FK fracao_id';
        throw e;
      }
      return comToJSON({ id: CRIADOS.length, ...vals });
    },
    destroy: async () => 0, count: async () => 0, update: async () => [0],
    findOrCreate: async () => [comToJSON({}), false], findByPk: async () => null,
  }, over);

  const MODELS = {
    Orcamento: modelo(),
    OrcamentoRubrica: modelo({
      // Honra o filtro por orçamento, como o Sequelize faria.
      findAll: async (opts) => {
        const oid = opts && opts.where ? opts.where.orcamento_id : null;
        return RUBRICAS.filter((r) => (oid === undefined ? true : r.orcamento_id === oid)).map(comToJSON);
      },
    }),
    OrcamentoDistribuicao: modelo(),
    OrcamentoAlteracao: modelo(), PlanoQuota: modelo(), Quota: modelo(),
    Categoria: modelo(),
    Fracao: modelo({
      // Só o condomínio ATIVO (1) — a rota pede o filtro explicitamente.
      findAll: async (opts) => {
        const cid = opts && opts.where ? opts.where.condominio_id : null;
        return FRACOES.filter((f) => (cid === undefined ? true : f.condominio_id === cid)).map(comToJSON);
      },
    }),
    User: modelo(), sequelize: {},
  };
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
  stub('helpers/audit.js', { audit: async () => {} });
  stub('helpers/suporte-allowlist.js', {
    soDiagnostico: () => (req, res, next) => next(),
    comPapelOuSuporteAdmitido: () => (req, res, next) => next(),
  });
  stub('helpers/numeracao.js', { proximoNumero: async () => 'Q/1' });
  stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: 10, fcrPercentagem: 10 }) });
  stub('helpers/dates.js', { monthName: (m) => `M${m}` });
  stub('helpers/handlebars-helpers.js', {});

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
  app.use(express.urlencoded({ extended: true }));   // MESMA configuração do app.js
  app.use(flash());
  app.use((req, res, next) => {
    req.user = { id: 1 };
    res.locals.user = { id: 1 };
    res.locals.currentYear = 2026;
    res.locals.currentPath = req.path;
    res.locals.condominioAtivo = { id: 1, role: 'gestor' };
    res.locals.appName = 'GesCondu';
    res.locals.success_msg = []; res.locals.error_msg = []; res.locals.error = [];
    res.locals.tarefas = {}; res.locals.meusCondominios = [];
    res.locals.sessaoExpiraEm = Date.now() + 3600000;
    res.locals.sessaoAvisoMs = 1; res.locals.sessaoIdleMs = 1;
    next();
  });
  let ULTIMO_ERRO = null;
  app.use('/admin', (req, res, next) => {
    if (req.method === 'POST') ULTIMO_ERRO = null;
    next();
  });
  app.use('/admin', require('../routes/orcamento'));
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    // ── 4a. GET: os nomes de campo que o browser enviaria ──
    const r1 = await fetch(`${base}/admin/orcamento/1/distribuicao`);
    assert.strictEqual(r1.status, 200, 'a página de distribuição renderiza (HTTP 200)');
    const html = await r1.text();
    const nomes = [...html.matchAll(/name="(dist\[[^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(nomes.sort(),
      ['dist[r11][f21]', 'dist[r11][f22]', 'dist[r12][f21]', 'dist[r12][f22]'],
      'o formulário emite um campo por (rubrica × fração), com ids prefixados');

    // ── 4b. POST com esses MESMOS nomes (o que o browser faz) ──
    const corpo = new URLSearchParams();
    for (const n of nomes) corpo.append(n, '100.00');
    CRIADOS.length = 0;
    const r2 = await fetch(`${base}/admin/orcamento/1/distribuicao`, {
      method: 'POST', body: corpo, redirect: 'manual',
    });
    assert.strictEqual(r2.status, 302, 'a gravação responde com redirect (não rebenta)');
    assert.strictEqual(CRIADOS.length, 4, 'são gravadas as 4 distribuições (2 rubricas × 2 frações)');
    const pares = CRIADOS.map((c) => `${c.rubrica_id}|${c.fracao_id}`).sort();
    assert.deepStrictEqual(pares, ['11|21', '11|22', '12|21', '12|22'],
      'cada create recebe o rubrica_id e o fracao_id CORRETOS (nunca 0)');
    for (const c of CRIADOS) {
      assert.ok(c.rubrica_id > 0 && c.fracao_id > 0,
        `rubrica_id/fracao_id positivos (recebido ${c.rubrica_id}/${c.fracao_id}) — era aqui que dava 0`);
      assert.strictEqual(c.orcamento_id, 1, 'o orçamento é o do condomínio ativo');
      assert.strictEqual(c.valor_anual, 100, 'o valor é o submetido');
    }

    // ── 4c. Âmbito: rubrica de outro orçamento e fração de outro condomínio ──
    CRIADOS.length = 0;
    const corpoMau = new URLSearchParams();
    corpoMau.append('dist[r11][f21]', '50.00');   // válido
    corpoMau.append('dist[r99][f21]', '50.00');   // rubrica de OUTRO orçamento
    corpoMau.append('dist[r11][f77]', '50.00');   // fração de OUTRO condomínio
    corpoMau.append('dist[r0][f0]', '50.00');     // ids 0 (o defeito antigo)
    const r3 = await fetch(`${base}/admin/orcamento/1/distribuicao`, {
      method: 'POST', body: corpoMau, redirect: 'manual',
    });
    assert.strictEqual(r3.status, 302, 'o pedido com âmbito inválido não rebenta');
    assert.strictEqual(CRIADOS.length, 1, 'só a entrada válida é gravada');
    assert.deepStrictEqual([CRIADOS[0].rubrica_id, CRIADOS[0].fracao_id], [11, 21],
      'a rubrica de outro orçamento e a fração de outro condomínio são recusadas (isolamento)');

    // ── 4d. Formulário ANTIGO (corpo já em array) → recusado, não FK crash ──
    CRIADOS.length = 0;
    const corpoAntigo = new URLSearchParams();
    corpoAntigo.append('dist[11][21]', '100.00');   // nomes antigos → vira array
    const r4 = await fetch(`${base}/admin/orcamento/1/distribuicao`, {
      method: 'POST', body: corpoAntigo, redirect: 'manual',
    });
    assert.strictEqual(r4.status, 302, 'o corpo em formato antigo é tratado (sem 500)');
    assert.strictEqual(CRIADOS.length, 0,
      'não grava nada a partir de um corpo com os ids perdidos (antes tentava rubrica_id = 0)');
  } finally {
    servidor.close();
  }
  console.log('  ✓ 4. fluxo real: formulário → rota → create com ids corretos; âmbito validado');
}

// ── 5. A mensagem de erro é útil (não só a genérica) ──────────────
function testeMensagemUtil() {
  const rota = ler('routes/orcamento.js');
  assert.ok(/causa/.test(rota) && /recarregue a página/i.test(rota),
    'a falha de FK explica ao utilizador o que verificar');
  assert.ok(!/req\.flash\('error_msg', 'Erro ao guardar a distribuição\.'\)/.test(rota),
    'já não existe o aviso genérico isolado, sem causa');
  // O erro real fica registado com o código do MySQL.
  assert.ok(/code: err\.code/.test(rota) && /errno: err\.errno/.test(rota),
    'o log inclui code/errno do MySQL');
  console.log('  ✓ 5. a falha passa a ter causa explícita no aviso e no log');
}

// ── 6. Caso negativo: o defeito, se voltasse, seria detetado ──────
function testeCasoNegativo() {
  // O parser converte `dist[11][21]=100&dist[12][22]=200` (ids pequenos) em
  // `[["100.00"],["200.00"]]` — verificado no teste 1.
  const destruido = [['100.00'], ['200.00']];

  // Lógica ANTIGA aplicada a esse corpo.
  const antigos = [];
  for (const [rubricaId, frac] of Object.entries(destruido)) {
    for (const [fracaoId, valor] of Object.entries(frac)) {
      antigos.push({ rubrica_id: Number(rubricaId), fracao_id: Number(fracaoId), valor_anual: valor });
    }
  }
  const idsReais = new Set([11, 12, 21, 22]);
  assert.ok(antigos.length > 0, 'a lógica antiga produzia registos a partir do corpo destruído');
  assert.ok(antigos.every((a) => !idsReais.has(a.rubrica_id) && !idsReais.has(a.fracao_id)),
    'nenhum id REAL sobrevive: passam todos a índices de array (0, 1, …)');
  assert.strictEqual(antigos[0].rubrica_id, 0,
    'o primeiro registo tenta rubrica_id = 0 → ER_NO_REFERENCED_ROW_2 (o erro de produção)');
  assert.strictEqual(antigos[0].fracao_id, 0, 'e fracao_id = 0');

  // Lógica NOVA: o corpo em array é detetado ANTES de qualquer INSERT.
  assert.strictEqual(Array.isArray(destruido), true,
    'o corpo destruído é detetável (Array.isArray) → recusado antes do INSERT');
  const rota = ler('routes/orcamento.js');
  assert.ok(/Array\.isArray\(corpo\)/.test(rota), 'a rota testa explicitamente o corpo em array');
  assert.ok(/Recarregue a página e volte a guardar/.test(rota),
    'a rota pede o reenvio em vez de gravar lixo a partir de um corpo sem ids');
  console.log('  ✓ 6. caso negativo: o defeito antigo é detetado, não reproduzido');
}

(async () => {
  console.log('Distribuição do orçamento pelas quotas — gravação\n');
  await testeCausaRaizDoParser();
  testeVistaUsaPrefixo();
  testeRotaInterpretaPrefixo();
  await testeFluxoReal();
  testeMensagemUtil();
  testeCasoNegativo();
  console.log('\n✓ Testes da gravação da distribuição passaram (sem base de dados).');
})().catch((e) => {
  console.error('\n✗ FALHA:', e.message);
  process.exit(1);
});
