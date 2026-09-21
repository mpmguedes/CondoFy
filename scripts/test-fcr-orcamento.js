// ═══════════════════════════════════════════════════════════════════
// Percentagem do FCR sobre o orçamento → quota.
//
// Responde, com prova executável, à pergunta: «a percentagem do Fundo Comum
// de Reserva é aplicada ao orçamento e incorporada no valor das quotas?»
//
// O que se prova aqui:
//   1. orçamento SEM FCR (pct 0) → total = despesas, FCR = 0
//   2. orçamento COM FCR 10%    → total = despesas + 10%
//   3. valor anual do FCR       → total × pct/(100+pct)  (= despesas × pct/100)
//   4. total do orçamento + FCR → 12.000 € + 10% = 13.200 €  (exemplo do pedido)
//   5. distribuição pelas frações por permilagem
//   6. soma das quotas = total esperado
//   7. consistência mensal/anual (Σ 12 meses = anual; base + FCR = total)
//   B. configuração por condomínio (onde a percentagem é definida)
//   C. fluxo REAL da rota POST /admin/quotas/gerar (metodo=orcamento):
//      a percentagem chega ao cálculo E à quota gravada
//   D. onde o FCR aparece (e não aparece) na interface
//   E. o caminho do orçamento («Emitir quotas»): o plano passa a representar o
//      TOTAL a cobrar (despesas + FCR) e a emissão grava as componentes
//      (valor_base / valor_fcr / fcr_percentagem)
//   F. fluxo REAL da emissão: plano → POST /orcamento/:id/emitir → quota
//   G. o FCR entra no balancete UMA só vez (dentro da quota), sem dupla
//      contabilização — e o orçamentado (plano, com FCR) coincide com o lançado
//
// Utilização: node scripts/test-fcr-orcamento.js
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

const { toCents, fromCents } = require('../helpers/money');
const {
  calcularQuotasOrcamento,
  calcularQuota,
  dividirComponentesQuota,
  acrescentarFcrAoTotal,
} = require('../helpers/quotas-calc');
// Puros do balancete: permitem provar, sem base de dados, que o fundo não é
// contado duas vezes no relatório financeiro.
const { construirReceitas, receitaPrevistaDoPeriodo } = require('../helpers/relatorio-financeiro');

const stub = (rel, valor) => {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
};

// ── 1–7. Aritmética: orçamento (despesas) → total com FCR → quota ──
function testesDeCalculo() {
  const FRACOES = [
    { id: 1, permilagem: '500' },
    { id: 2, permilagem: '500' },
  ];

  // 1. Orçamento SEM FCR.
  const semFcr = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 0 });
  assert.strictEqual(acrescentarFcrAoTotal(toCents('12000.00'), 0), toCents('12000.00'),
    'sem FCR o total a distribuir é exatamente as despesas');
  let soma = 0;
  for (const v of semFcr.values()) soma += v.totalC;
  assert.strictEqual(soma, toCents('12000.00'), 'Σ quotas (ano) = 12.000 € sem FCR');
  for (const v of semFcr.values()) assert.strictEqual(v.fcrC, 0, 'FCR a zero quando a percentagem é 0');

  // 2. Orçamento COM FCR 10% → 13.200 €.
  const despesasC = toCents('12000.00');
  const totalComFcrC = acrescentarFcrAoTotal(despesasC, 10);
  assert.strictEqual(totalComFcrC, toCents('13200.00'),
    '12.000 € de despesas + 10% de FCR = 13.200 € a financiar pelas quotas');

  const comFcr = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10 });
  soma = 0;
  let somaFcr = 0;
  for (const v of comFcr.values()) { soma += v.totalC; somaFcr += v.fcrC; }
  assert.strictEqual(soma, toCents('13200.00'), 'Σ quotas (ano) = 13.200 € com FCR 10%');
  assert.strictEqual(somaFcr, toCents('1200.00'), 'FCR anual total = 1.200 € (= 10% das despesas)');

  // 3. Valor anual do FCR — as duas leituras da MESMA grandeza coincidem.
  const d1 = dividirComponentesQuota(totalComFcrC, 10);
  assert.strictEqual(d1.fcrC, toCents('1200.00'), 'FCR = total × pct/(100+pct) = 13.200 × 10/110');
  assert.strictEqual(Math.round((despesasC * 10) / 100), toCents('1200.00'),
    'FCR = despesas × pct/100 — as duas fórmulas dão o mesmo ao cêntimo');
  assert.strictEqual(d1.baseC, toCents('12000.00'), 'a base do conjunto é exatamente as despesas');
  assert.strictEqual(d1.baseC + d1.fcrC, d1.totalC, 'base + FCR = total (invariante D1)');

  // 4. Fração com 10% da permilagem → a sua parte dos 13.200 €.
  //    (A distribuição é RELATIVA ao conjunto das frações: é preciso o conjunto
  //     todo para que os 100‰ representem 10% do total.)
  const so = calcularQuotasOrcamento({
    fracoes: [{ id: 9, permilagem: '100' }, { id: 10, permilagem: '900' }],
    totalAnual: '12000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  const v9 = so.get(9);
  assert.strictEqual(v9.totalC, toCents('1320.00'), 'fração de 100‰ suporta 1.320 € (10% de 13.200 €)');
  assert.strictEqual(v9.baseC, toCents('1200.00'), '…dos quais 1.200 € de despesas correntes');
  assert.strictEqual(v9.fcrC, toCents('120.00'), '…e 120 € de FCR');
  assert.strictEqual(v9.baseC + v9.fcrC, v9.totalC, 'base + FCR = total na fração');
  assert.strictEqual(so.get(10).totalC, toCents('11880.00'), 'a fração de 900‰ suporta os restantes 11.880 €');
  assert.strictEqual(v9.totalC + so.get(10).totalC, toCents('13200.00'), 'as duas frações fecham os 13.200 €');

  // 5. Distribuição por permilagem (proporcional, com fecho ao cêntimo).
  const tres = calcularQuotasOrcamento({
    fracoes: [{ id: 1, permilagem: '600' }, { id: 2, permilagem: '300' }, { id: 3, permilagem: '100' }],
    totalAnual: '12000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10,
  });
  assert.strictEqual(tres.get(1).totalC, toCents('7920.00'), '600‰ → 60% de 13.200 € = 7.920 €');
  assert.strictEqual(tres.get(2).totalC, toCents('3960.00'), '300‰ → 30% = 3.960 €');
  assert.strictEqual(tres.get(3).totalC, toCents('1320.00'), '100‰ → 10% = 1.320 €');

  // 6. Soma das quotas = total esperado, para vários conjuntos.
  for (const despesas of ['12000.00', '5000.00', '1000.00', '1234.56']) {
    for (const pct of [0, 10, 12.5, 15]) {
      const esperado = acrescentarFcrAoTotal(toCents(despesas), pct);
      const mapa = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: despesas, metodo: 'permilagem', meses: 12, fcrPercentagem: pct });
      let s = 0;
      for (const v of mapa.values()) s += v.totalC;
      assert.strictEqual(s, esperado,
        `Σ quotas = despesas + FCR (despesas ${despesas}, pct ${pct})`);
    }
  }

  // 7. Consistência mensal/anual.
  const m = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 10 });
  for (const [id, v] of m) {
    assert.strictEqual(v.porMes.length, 12, `fração ${id}: 12 meses`);
    const somaMeses = v.porMes.reduce((s, x) => s + x.totalC, 0);
    assert.strictEqual(somaMeses, v.totalC, `fração ${id}: Σ meses = anual`);
    const somaBase = v.porMes.reduce((s, x) => s + x.baseC, 0);
    const somaFcrMes = v.porMes.reduce((s, x) => s + x.fcrC, 0);
    assert.strictEqual(somaBase, v.baseC, `fração ${id}: Σ base(mês) = base(ano)`);
    assert.strictEqual(somaFcrMes, v.fcrC, `fração ${id}: Σ FCR(mês) = FCR(ano)`);
    for (const x of v.porMes) {
      assert.strictEqual(x.baseC + x.fcrC, x.totalC, `fração ${id}: base + FCR = total em cada mês`);
    }
    // 13.200 € / 2 frações / 12 meses = 550 €/mês (500 base + 50 FCR).
    assert.strictEqual(v.porMes[0].totalC, toCents('550.00'), `fração ${id}: mês = 550 €`);
    assert.strictEqual(v.porMes[0].fcrC, toCents('50.00'), `fração ${id}: FCR do mês = 50 €`);
  }
  let anoTotal = 0;
  for (const v of m.values()) anoTotal += v.totalC;
  assert.strictEqual(anoTotal, toCents('13200.00'), 'soma dos 12 meses das 2 frações = 13.200 €');

  // A percentagem é um PARÂMETRO real: mudar a percentagem muda o resultado.
  const p15 = calcularQuotasOrcamento({ fracoes: FRACOES, totalAnual: '12000.00', metodo: 'permilagem', meses: 12, fcrPercentagem: 15 });
  let s15 = 0;
  for (const v of p15.values()) s15 += v.totalC;
  assert.strictEqual(s15, toCents('13800.00'), 'com 15% o total sobe para 13.800 € (a percentagem é usada)');
  assert.notStrictEqual(s15, anoTotal, 'percentagens diferentes dão totais diferentes');

  // Modo preço (`calcularQuota`): `valorPor1000` JÁ inclui o FCR.
  const q = calcularQuota('500', '110.00', 10);
  assert.strictEqual(q.totalC, toCents('55.00'), '500‰ × 110 €/1000‰ = 55 € (total já com FCR)');
  assert.strictEqual(q.baseC, toCents('50.00'), '50 € de despesas correntes');
  assert.strictEqual(q.fcrC, toCents('5.00'), '5 € de FCR');
  assert.strictEqual(q.baseC + q.fcrC, q.totalC, 'base + FCR = total');

  console.log('  ✓ 1–7. orçamento → FCR → quota: 12.000 € + 10% = 13.200 €, com fecho mensal e anual');
}

// ── B. Onde a percentagem é definida (configuração por condomínio) ──
async function testeConfiguracaoPorCondominio() {
  // `helpers/config.js` é a única porta para a tabela `configuracoes`:
  // substitui-se por um mapa em memória (sem BD).
  const store = new Map();
  stub('helpers/config.js', {
    getConfig: async (chave, fallback = null) => (store.has(chave) ? store.get(chave) : fallback),
    setConfig: async (chave, valor) => { store.set(chave, valor); return { chave, valor }; },
  });
  const cfg = require('../helpers/quotas-config');

  // Sem qualquer configuração → defaults (valor por 1000‰ e mínimo legal 10%).
  let c = await cfg.getQuotaConfig(7);
  assert.strictEqual(c.valorPor1000, cfg.VALOR_POR_1000_PADRAO, 'sem configuração vale o default do valor por 1000‰');
  assert.strictEqual(String(c.fcrPercentagem), String(cfg.FCR_MINIMO_LEGAL), 'sem configuração vale o mínimo legal de 10%');
  assert.strictEqual(cfg.FCR_MINIMO_LEGAL, 10, 'o mínimo legal é 10%');

  // Chave global (comportamento herdado).
  store.set('quota_fcr_percentagem', '12');
  assert.strictEqual(String((await cfg.getQuotaConfig(7)).fcrPercentagem), '12', 'a chave global é herdada');

  // Chave específica do condomínio tem PRECEDÊNCIA sobre a global.
  store.set('quota_fcr_percentagem:c7', '15');
  assert.strictEqual(String((await cfg.getQuotaConfig(7)).fcrPercentagem), '15', 'a chave do condomínio 7 prevalece');
  assert.strictEqual(String((await cfg.getQuotaConfig(8)).fcrPercentagem), '12', 'o condomínio 8 (sem chave própria) herda a global');
  assert.notStrictEqual(String((await cfg.getQuotaConfig(7)).fcrPercentagem), String((await cfg.getQuotaConfig(8)).fcrPercentagem),
    'condomínios diferentes podem ter percentagens diferentes');

  // Escrita: sempre no âmbito do condomínio, com a chave própria.
  await cfg.setQuotaConfig(9, { valorPor1000: '110.0000', fcrPercentagem: '12.5' });
  assert.strictEqual(store.get('quota_fcr_percentagem:c9'), '12.5', 'a percentagem é gravada na chave do condomínio 9');
  assert.strictEqual(store.get('quota_valor_1000:c9'), '110.0000', 'o valor por 1000‰ também');
  assert.strictEqual(store.get('quota_fcr_percentagem'), '12', 'a chave global NÃO é reescrita');
  await assert.rejects(() => cfg.setQuotaConfig(null, { valorPor1000: '1', fcrPercentagem: '10' }),
    /condominioId válido/, 'gravar sem âmbito é recusado (nunca uma configuração de condomínio indefinido)');

  // Validação da percentagem: mínimo legal, máximo 100, decimais com vírgula.
  assert.strictEqual(cfg.validarFcrPercentagem('10').ok, true, '10% é aceite');
  assert.strictEqual(cfg.validarFcrPercentagem('12,5').valor, 12.5, 'decimais com vírgula são aceites');
  assert.strictEqual(cfg.validarFcrPercentagem('100').ok, true, '100% é o máximo aceite');
  for (const [valor, motivo] of [['9,5', 'abaixo_do_minimo'], ['101', 'acima_do_maximo'], ['', 'vazio'], ['abc', 'nao_numerico']]) {
    const r = cfg.validarFcrPercentagem(valor);
    assert.strictEqual(r.ok, false, `"${valor}" é recusado`);
    assert.strictEqual(r.motivo, motivo, `"${valor}" recusado com o motivo "${motivo}"`);
    assert.ok(r.mensagem && r.mensagem.length > 10, `"${valor}" tem mensagem explicativa`);
  }

  // O modelo do orçamento NÃO tem coluna de FCR: não existe percentagem por
  // orçamento/ano (a percentagem é do condomínio).
  const modeloOrcamento = ler('models/Orcamento.js');
  assert.ok(!/fcr/i.test(modeloOrcamento), 'models/Orcamento.js não tem qualquer campo de FCR');
  assert.ok(/receita_quotas_prevista/.test(modeloOrcamento), 'o orçamento guarda apenas a receita prevista (Modo B)');

  console.log('  ✓ B. a percentagem é por CONDOMÍNIO (chave própria + herança global), não por orçamento');
}

// ── C. Fluxo REAL: POST /admin/quotas/gerar (metodo=orcamento) ─────
async function testeRotaGerarQuotasDeOrcamento() {
  const RUBRICAS = [
    { id: 11, orcamento_id: 1, descricao: 'Eletricidade', valor_anual: '7000.00', metodo_distribuicao: 'permilagem', periodicidade: 'mensal', ativo: true },
    { id: 12, orcamento_id: 1, descricao: 'Limpeza', valor_anual: '5000.00', metodo_distribuicao: 'permilagem', periodicidade: 'mensal', ativo: true },
    // Inativa: NÃO entra no total de despesas.
    { id: 13, orcamento_id: 1, descricao: 'INATIVA', valor_anual: '9999.00', metodo_distribuicao: 'permilagem', periodicidade: 'mensal', ativo: false },
  ];
  const FRACOES = [
    { id: 21, designacao: 'A', permilagem: '500', estado: 'ativo', condominio_id: 1 },
    { id: 22, designacao: 'B', permilagem: '500', estado: 'ativo', condominio_id: 1 },
  ];
  const ORCAMENTO = { id: 1, condominio_id: 1, designacao: 'Orçamento 2026', estado: 'aprovado', data_inicio: '2026-01-01', data_fim: '2026-12-31' };

  const CRIADOS = [];
  let FCR_ATUAL = '10';
  const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);

  const modelo = (over = {}) => Object.assign({
    findOne: async () => null, findAll: async () => [], create: async (v) => comToJSON({ id: CRIADOS.length + 1, ...v }),
    destroy: async () => 0, count: async () => 0, update: async () => [0], findByPk: async () => null,
    findOrCreate: async () => [comToJSON({}), false], sum: async () => 0, max: async () => null, aggregate: async () => null,
  }, over);

  const MODELS = new Proxy({}, {
    get: (_t, nome) => {
      if (nome === 'sequelize') return {};
      if (nome === 'Orcamento') {
        return modelo({
          findOne: async () => {
            const base = comToJSON({ ...ORCAMENTO });
            base.rubricas = RUBRICAS.map(comToJSON);
            return base;
          },
        });
      }
      if (nome === 'Fracao') {
        return modelo({
          findAll: async (opts) => {
            const cid = opts && opts.where ? opts.where.condominio_id : undefined;
            return FRACOES.filter((f) => (cid === undefined ? true : f.condominio_id === cid)).map(comToJSON);
          },
        });
      }
      if (nome === 'Quota') {
        return modelo({
          findAll: async () => [],
          findOne: async () => null,
          create: async (v) => { CRIADOS.push(v); return comToJSON({ id: CRIADOS.length, ...v }); },
        });
      }
      if (nome === 'Configuracao') return modelo();
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
  stub('helpers/saldos.js', { resumoCondominio: async () => ({ contas: [] }), resumoFracao: async () => ({}), estadoEfetivo: () => 'pendente' });
  stub('helpers/condominio.js', { getCondominio: async () => ({ id: 1, designacao: 'C1' }) });
  // O ÚNICO ponto que decide a percentagem: é este valor que tem de chegar à quota.
  stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: '110.0000', fcrPercentagem: FCR_ATUAL }) });

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
  app.use('/admin', require('../routes/financeiro'));
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const gerar = async () => {
    const corpo = new URLSearchParams({
      escopo: 'mes', metodo: 'orcamento', orcamento_id: '1', ano: '2026', mes: '1', vencimento_dia: '8',
    });
    return fetch(`${base}/admin/quotas/gerar`, { method: 'POST', body: corpo, redirect: 'manual' });
  };

  try {
    // ── C1. FCR 10% ──
    CRIADOS.length = 0;
    FCR_ATUAL = '10';
    const r1 = await gerar();
    assert.strictEqual(r1.status, 302, 'a geração de quotas responde com redirect (não rebenta)');
    assert.strictEqual(CRIADOS.length, 2, 'uma quota por fração ativa (2)');

    // Despesas = 7.000 + 5.000 = 12.000 € (a rubrica inativa não conta).
    // Total a financiar = 12.000 × 1,10 = 13.200 € → 6.600 €/fração/ano → 550 €/mês.
    for (const q of CRIADOS) {
      assert.strictEqual(Number(q.valor), 550, `valor total da quota = 550 € (recebido ${q.valor})`);
      assert.strictEqual(Number(q.valor_base), 500, `valor_base = 500 € (recebido ${q.valor_base})`);
      assert.strictEqual(Number(q.valor_fcr), 50, `valor_fcr = 50 € (recebido ${q.valor_fcr})`);
      assert.strictEqual(Number(q.fcr_percentagem), 10, 'a percentagem aplicada fica registada na quota');
      assert.strictEqual(Number(q.valor_base) + Number(q.valor_fcr), Number(q.valor), 'base + FCR = total');
      // NOTA (achado secundário, não corrigido): no caminho do orçamento o
      // rasto `valor_por_1000` é o valor por 1000‰ do ANO (13.200 €), enquanto
      // `valor` é MENSAL (550 €) — o mensal equivalente seria 1.100 €/1000‰.
      // No caminho «permilagem + FCR» o campo é mensal (110 €). É uma
      // inconsistência do campo de rasto, não do valor cobrado.
      assert.strictEqual(Number(q.valor_por_1000), 13200,
        'valor_por_1000 registado é o total ANUAL por 1000‰ (13.200 €), não o mensal (1.100 €)');
      assert.strictEqual(Number(q.permilagem_aplicada), 500, 'permilagem da fração registada');
      assert.strictEqual(q.condominio_id, 1, 'a quota é do condomínio ativo');
    }
    const somaTotal = CRIADOS.reduce((s, q) => s + Number(q.valor), 0);
    assert.strictEqual(Math.round(somaTotal * 100), toCents('1100.00'),
      'as 2 quotas do mês somam 1.100 €/mês (= 13.200 €/ano ÷ 12)');

    // ── C2. A percentagem vem da CONFIGURAÇÃO (não está fixa no código) ──
    CRIADOS.length = 0;
    FCR_ATUAL = '15';
    await gerar();
    assert.strictEqual(CRIADOS.length, 2, 'nova geração com 15%');
    // 12.000 × 1,15 = 13.800 € → 6.900 €/fração/ano → 575 €/mês (500 base + 75 FCR).
    for (const q of CRIADOS) {
      assert.strictEqual(Number(q.valor), 575, `com 15% a quota é 575 € (recebido ${q.valor})`);
      assert.strictEqual(Number(q.valor_fcr), 75, `com 15% o FCR é 75 € (recebido ${q.valor_fcr})`);
      assert.strictEqual(Number(q.fcr_percentagem), 15, 'a percentagem gravada acompanha a configuração');
    }
    assert.notStrictEqual(Number(CRIADOS[0].valor), 550, 'mudar a configuração muda o valor da quota');

    // ── C3. Sem FCR (0%) → o total é exatamente as despesas ──
    CRIADOS.length = 0;
    FCR_ATUAL = '0';
    await gerar();
    for (const q of CRIADOS) {
      assert.strictEqual(Number(q.valor), 500, 'sem FCR a quota mensal é 500 € (6.000 €/ano)');
      assert.strictEqual(Number(q.valor_fcr), 0, 'sem FCR a componente do fundo é zero');
    }
  } finally {
    servidor.close();
  }

  console.log('  ✓ C. fluxo real: a percentagem do condomínio chega ao cálculo e à quota gravada');
}

// ── D. Onde o FCR aparece (e onde não aparece) na interface ────────
function testeInterface() {
  // Onde se DEFINE a percentagem.
  const listar = ler('views/admin/quotas/listar.handlebars');
  assert.ok(/action="\/admin\/quotas\/config"/.test(listar), 'a configuração das quotas é gravada por /admin/quotas/config');
  assert.ok(/name="fcr_percentagem"/.test(listar), 'o formulário tem o campo da percentagem do FCR');
  assert.ok(/min="10" max="100"/.test(listar), 'o campo respeita o mínimo legal de 10% e o máximo de 100%');
  assert.ok(/{{quotaConfig\.fcrPercentagem}}%/.test(listar), 'a percentagem em vigor é apresentada');

  // Onde o FCR CALCULADO aparece (pré-visualização da geração de quotas).
  const gerar = ler('views/admin/quotas/gerar.handlebars');
  assert.ok(/<th class="text-end">Base<\/th><th class="text-end">FCR<\/th><th class="text-end">Total<\/th>/.test(gerar),
    'a pré-visualização da geração mostra Base / FCR / Total por fração');
  assert.ok(/function totalComFcr\(/.test(gerar) && /despesas \* \(100 \+ p\) \/ 100/.test(gerar),
    'a pré-visualização aplica o FCR sobre as DESPESAS do orçamento');
  assert.ok(/__GESCONDU_DIVIDIR_FCR/.test(gerar), 'a decomposição usa a MESMA função do servidor (sem segunda implementação)');

  // Mapa de quotas.
  const mapa = ler('views/admin/quotas/mapa.handlebars');
  assert.ok(/{{quotaConfig\.fcrPercentagem}}%/.test(mapa), 'o mapa mostra a percentagem do FCR');
  assert.ok(/fcrMensalPrevisto/.test(mapa), 'o mapa mostra o FCR mensal previsto');
  const rotaMapa = ler('routes/quotas-modulo.js');
  assert.ok(/fcrMensalPrevisto/.test(rotaMapa), 'a rota do mapa calcula o FCR mensal previsto');

  // Detalhe da quota: a distinção base / FCR / total fica registada.
  const detalhe = ler('views/admin/quotas/detalhe.handlebars');
  assert.ok(/quota\.valor_fcr/.test(detalhe), 'o detalhe da quota mostra o valor do FCR');
  assert.ok(/quota\.fcr_percentagem/.test(detalhe), 'o detalhe da quota mostra a percentagem aplicada');

  // Formulário do orçamento (Modo B): mostra o split, mas NÃO define a percentagem.
  const form = ler('views/admin/orcamento/form.handlebars');
  assert.ok(/FCR \(' \+ FCR \+ '%\)/.test(form), 'o formulário do orçamento mostra o FCR no cálculo do Modo B');
  assert.ok(/quotaConfig\.fcrPercentagem/.test(form), '…usando a percentagem da configuração do condomínio');
  assert.ok(!/name="fcr_percentagem"/.test(form),
    'a percentagem NÃO é editável no orçamento — é uma configuração do condomínio');

  // Detalhe do orçamento: não mostra FCR nem total a financiar (lacuna de apresentação).
  const detalheOrc = ler('views/admin/orcamento/detalhe.handlebars');
  assert.ok(!/FCR/.test(detalheOrc),
    'o detalhe do orçamento não mostra o FCR nem o total a financiar (só o total das rubricas)');
  assert.ok(/Total do orçamento/.test(detalheOrc), '…apresenta apenas o total das rubricas (despesas)');

  // Plano de quotas do orçamento: identifica a percentagem aplicada, para os
  // valores (despesas + FCR) não parecerem inexplicados.
  const planoVista = ler('views/admin/orcamento/plano.handlebars');
  assert.ok(/quotaConfig\.fcrPercentagem/.test(planoVista), 'o plano identifica a percentagem do FCR aplicada');
  assert.ok(/total a cobrar/.test(planoVista), 'o plano explica que os valores são o total a cobrar');
  const rotaOrc = ler('routes/orcamento.js');
  const blocoGetPlano = /router\.get\('\/orcamento\/:id\/plano'[\s\S]*?\n\}\);/.exec(rotaOrc);
  assert.ok(blocoGetPlano && /quotaConfig/.test(blocoGetPlano[0]), 'a rota do plano passa a configuração à vista');

  // Coerência de rótulos: onde os valores passaram a ser o TOTAL a cobrar
  // (despesas + FCR), o rótulo tem de o dizer — senão a coluna «Receitas» da
  // lista e o saldo positivo do painel parecem receita destinada a despesas.
  const painel = ler('views/admin/dashboard.handlebars');
  assert.ok(/Receitas previstas \(c\/ FCR\)/.test(painel),
    'o painel identifica as receitas previstas como incluindo o FCR');
  assert.ok(/total a cobrar aos condóminos/.test(painel),
    'o painel explica que as receitas previstas são o total a cobrar');
  const listaOrcamentos = ler('views/admin/orcamento/listar.handlebars');
  assert.ok(/Receitas \(c\/ FCR\)/.test(listaOrcamentos),
    'a lista de orçamentos identifica a coluna das receitas como incluindo o FCR');
  assert.ok(/total a cobrar<\/strong>/.test(listaOrcamentos),
    'a lista de orçamentos explica que as receitas são o total a cobrar');
  const balancete = ler('views/admin/relatorios/financeiro.handlebars');
  assert.ok(/Orçamentado \(c\/ FCR\)/.test(balancete),
    'o balancete identifica a coluna orçamentada das receitas como incluindo o FCR');
  assert.ok(/não é contada à parte/.test(balancete),
    'o balancete explica que o FCR não é contado à parte (sem dupla contabilização)');

  console.log('  ✓ D. FCR visível nas quotas (definição, pré-visualização, mapa, detalhe); ausente no detalhe do orçamento');
}

// ── E. O caminho do orçamento («Emitir quotas») aplica o FCR ───────
// Antes: `helpers/plano.js` distribuía só as despesas e
// `POST /orcamento/:id/emitir` gravava apenas `valor` — a quota emitida a
// partir do orçamento ficava SEM componente de fundo (`valor_fcr` nulo).
function testesDoCaminhoDoOrcamento() {
  const { calcularPlano } = require('../helpers/plano');
  const ORC = { data_inicio: '2026-01-01', data_fim: '2026-12-31' };
  const RUBRICAS = [{ id: 11, periodicidade: 'mensal' }];
  const DISTRIBUICOES = [
    { rubrica_id: 11, fracao_id: 21, valor_anual: '6000.00' },
    { rubrica_id: 11, fracao_id: 22, valor_anual: '6000.00' },
  ];
  const FRACOES = [{ id: 21 }, { id: 22 }];
  const soma = (p) => p.reduce((s, x) => s + toCents(x.valor), 0);

  // E1. Sem percentagem → o plano continua a ser exatamente as despesas
  //     (comportamento anterior preservado: retrocompatível).
  const semFcr = calcularPlano({ orcamento: ORC, rubricas: RUBRICAS, distribuicoes: DISTRIBUICOES, fracoes: FRACOES });
  assert.strictEqual(soma(semFcr), toCents('12000.00'),
    'sem percentagem o plano distribui as despesas (12.000 €) — comportamento anterior intacto');
  assert.strictEqual(calcularPlano({ orcamento: ORC, rubricas: RUBRICAS, distribuicoes: DISTRIBUICOES, fracoes: FRACOES, fcrPercentagem: 0 }).length,
    semFcr.length, 'percentagem 0 e omissa dão o mesmo plano');

  // E2. Com 10% → o plano é o TOTAL a cobrar (13.200 €), célula a célula.
  const comFcr = calcularPlano({ orcamento: ORC, rubricas: RUBRICAS, distribuicoes: DISTRIBUICOES, fracoes: FRACOES, fcrPercentagem: 10 });
  assert.strictEqual(soma(comFcr), toCents('13200.00'),
    'com 10% o plano passa a representar o total a financiar (13.200 €)');
  assert.strictEqual(comFcr.length, 24, '2 frações × 12 meses');
  for (const linha of comFcr) {
    // 6.000 €/ano ÷ 12 = 500 € de despesas → 550 € com FCR 10%.
    assert.strictEqual(toCents(linha.valor), toCents('550.00'), `célula ${linha.fracaoId}|${linha.mes} = 550 €`);
    const partes = dividirComponentesQuota(toCents(linha.valor), 10);
    assert.strictEqual(partes.baseC, toCents('500.00'), 'a base da célula são as despesas (500 €)');
    assert.strictEqual(partes.fcrC, toCents('50.00'), 'o FCR da célula é 50 €');
    assert.strictEqual(partes.baseC + partes.fcrC, partes.totalC, 'base + FCR = total em cada célula');
  }
  for (const id of [21, 22]) {
    const doAno = comFcr.filter((p) => p.fracaoId === id);
    assert.strictEqual(soma(doAno), toCents('6600.00'), `fração ${id}: 6.600 €/ano = 13.200 € ÷ 2`);
  }

  // E2b. Valores não divisíveis: o acréscimo é POR CÉLULA (cada quota é
  //      individualmente correta) e o desvio acumulado é limitado a 1 cêntimo
  //      por célula — não há «resto atirado à última».
  const NRedondo = calcularPlano({
    orcamento: ORC,
    rubricas: RUBRICAS,
    distribuicoes: [{ rubrica_id: 11, fracao_id: 21, valor_anual: '1234.56' }],
    fracoes: [{ id: 21 }],
    fcrPercentagem: 10,
  });
  const semFcrMesmo = calcularPlano({
    orcamento: ORC,
    rubricas: RUBRICAS,
    distribuicoes: [{ rubrica_id: 11, fracao_id: 21, valor_anual: '1234.56' }],
    fracoes: [{ id: 21 }],
  });
  assert.strictEqual(NRedondo.length, 12, '12 meses');
  const alvoC = acrescentarFcrAoTotal(soma(semFcrMesmo), 10);
  const desvio = Math.abs(soma(NRedondo) - alvoC);
  assert.ok(desvio <= NRedondo.length,
    `desvio acumulado (${desvio} cêntimos) dentro do limite de 1 cêntimo por célula`);
  const unicos = new Set(NRedondo.map((x) => x.valor));
  assert.strictEqual(unicos.size, 1, 'todos os meses valem o mesmo (sem mês inflacionado)');
  for (const linha of NRedondo) {
    const partes = dividirComponentesQuota(toCents(linha.valor), 10);
    assert.strictEqual(partes.baseC + partes.fcrC, partes.totalC, 'base + FCR = total em cada célula');
  }

  // E3. Fonte: um único ponto do acréscimo e a decomposição D1 na emissão.
  const fontePlano = ler('helpers/plano.js');
  assert.ok(/acrescentarFcrAoTotal/.test(fontePlano),
    'o plano usa o MESMO ponto do acréscimo do FCR (nunca uma segunda fórmula)');
  assert.ok(/fcrPercentagem/.test(fontePlano), 'o plano recebe a percentagem explicitamente');
  assert.ok(!/100 \+ pct|pct \/ 100|× pct/.test(fontePlano), 'o plano não reimplementa a fórmula do FCR');

  const rota = ler('routes/orcamento.js');
  const blocoEmitir = /router\.post\('\/orcamento\/:id\/emitir'[\s\S]*?\n\}\);/.exec(rota);
  assert.ok(blocoEmitir, 'a rota POST /orcamento/:id/emitir existe');
  for (const campo of ['valor_base', 'valor_fcr', 'fcr_percentagem', 'permilagem_aplicada']) {
    assert.ok(blocoEmitir[0].includes(campo), `a emissão grava ${campo} na quota`);
  }
  assert.ok(/dividirComponentesQuota/.test(blocoEmitir[0]),
    'a emissão decompõe com a MESMA regra D1 do cálculo das quotas');
  assert.ok(/getQuotaConfig/.test(blocoEmitir[0]),
    'a percentagem da emissão vem da configuração do condomínio');
  const blocoPlano = /router\.post\('\/orcamento\/:id\/plano'[\s\S]*?\n\}\);/.exec(rota);
  assert.ok(blocoPlano && /fcrPercentagem/.test(blocoPlano[0]),
    'a geração do plano passa a percentagem ao cálculo do plano');

  console.log('  ✓ E. «Emitir quotas» do orçamento aplica o FCR (plano e quota, com D1)');
}

// ── F. Fluxo REAL da emissão: plano → POST /orcamento/:id/emitir ───
async function testeRotaEmitirQuotas() {
  const PLANO = [
    { id: 1, orcamento_id: 1, fracao_id: 21, ano: 2026, mes: 1, valor: '550.00', data_vencimento: '2026-01-08', estado: 'planeada', update: async () => {} },
    { id: 2, orcamento_id: 1, fracao_id: 22, ano: 2026, mes: 1, valor: '550.00', data_vencimento: '2026-01-08', estado: 'planeada', update: async () => {} },
  ];
  const FRACOES = [
    { id: 21, permilagem: '500', condominio_id: 1 },
    { id: 22, permilagem: '500', condominio_id: 1 },
  ];
  const ORCAMENTO = { id: 1, condominio_id: 1, designacao: 'Orçamento 2026', estado: 'aprovado', data_inicio: '2026-01-01', data_fim: '2026-12-31' };
  const CRIADOS = [];
  let FCR_ATUAL = '10';

  const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);
  const modelo = (over = {}) => Object.assign({
    findOne: async () => null, findAll: async () => [], create: async (v) => comToJSON({ id: 1, ...v }),
    destroy: async () => 0, count: async () => 0, update: async () => [0], findByPk: async () => null,
    findOrCreate: async () => [comToJSON({}), false],
  }, over);

  const MODELS = {
    Orcamento: modelo({ findOne: async () => comToJSON({ ...ORCAMENTO, update: async () => {} }) }),
    OrcamentoRubrica: modelo(),
    OrcamentoDistribuicao: modelo(),
    OrcamentoAlteracao: modelo(),
    PlanoQuota: modelo({ findAll: async (opts) => (opts && opts.where && opts.where.estado === 'planeada' ? PLANO : PLANO) }),
    Quota: modelo({ create: async (v) => { CRIADOS.push(v); return comToJSON({ id: CRIADOS.length, ...v }); } }),
    Categoria: modelo(),
    Fracao: modelo({ findAll: async () => FRACOES.map(comToJSON) }),
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
  stub('helpers/suporte-allowlist.js', {
    soDiagnostico: () => (req, res, next) => next(),
    comPapelOuSuporteAdmitido: () => (req, res, next) => next(),
  });
  stub('helpers/audit.js', { audit: async () => {} });
  stub('helpers/numeracao.js', { proximoNumero: async () => 'Q/2026/1' });
  stub('helpers/dates.js', { monthName: (m) => `M${m}`, toDateInput: (d) => String(d).slice(0, 10) });
  stub('helpers/handlebars-helpers.js', {});
  stub('helpers/quotas-config.js', { getQuotaConfig: async () => ({ valorPor1000: '110.0000', fcrPercentagem: FCR_ATUAL }) });

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
    next();
  });
  app.use('/admin', require('../routes/orcamento'));
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const emitir = async () => {
    const corpo = new URLSearchParams({ periodo: '2026-1' });
    return fetch(`${base}/admin/orcamento/1/emitir`, { method: 'POST', body: corpo, redirect: 'manual' });
  };

  try {
    // F1. FCR 10%: o plano traz 550 € (total) → quota 550 = 500 base + 50 FCR.
    CRIADOS.length = 0;
    FCR_ATUAL = '10';
    const r1 = await emitir();
    assert.strictEqual(r1.status, 302, 'a emissão responde com redirect (não rebenta)');
    assert.strictEqual(CRIADOS.length, 2, 'uma quota por linha do plano');
    for (const q of CRIADOS) {
      assert.strictEqual(Number(q.valor), 550, `valor = 550 € (recebido ${q.valor})`);
      assert.strictEqual(Number(q.valor_base), 500, `valor_base = 500 € (recebido ${q.valor_base})`);
      assert.strictEqual(Number(q.valor_fcr), 50, `valor_fcr = 50 € (recebido ${q.valor_fcr})`);
      assert.strictEqual(Number(q.valor_base) + Number(q.valor_fcr), Number(q.valor), 'base + FCR = total');
      assert.strictEqual(Number(q.fcr_percentagem), 10, 'a percentagem aplicada fica registada');
      assert.strictEqual(Number(q.permilagem_aplicada), 500, 'permilagem da fração registada');
      assert.strictEqual(Number(q.orcamento_id), 1, 'a quota fica ligada ao orçamento');
      assert.ok(q.valor_fcr > 0, 'ANTES desta correção valor_fcr era nulo — a quota não alimentava o fundo');
    }

    // F2. A percentagem vem da configuração: 0% → quota igual às despesas.
    CRIADOS.length = 0;
    FCR_ATUAL = '0';
    await emitir();
    for (const q of CRIADOS) {
      assert.strictEqual(Number(q.valor), 550, 'o valor do plano é o total; com 0% a base absorve-o');
      assert.strictEqual(Number(q.valor_fcr), 0, 'com 0% não há componente de fundo');
      assert.strictEqual(Number(q.valor_base), 550, 'base = total quando não há FCR');
    }
  } finally {
    servidor.close();
  }

  console.log('  ✓ F. fluxo real: plano → emissão → quota com base, FCR e percentagem gravados');
}

// ── G. O FCR no balancete: UMA só vez (sem dupla contabilização) ────
//
// O plano e a quota passaram a valer o TOTAL a cobrar (despesas + FCR). A
// pergunta legítima é: o relatório financeiro passa a contar o fundo DUAS
// vezes — uma dentro do valor da quota e outra como linha própria?
// Esta secção prova que NÃO: `lancadoC` já contém o FCR (é o valor da quota,
// que é o total) e `fcrC` é apenas a sua decomposição, nunca um segundo
// addend. Prova-se também que o «orçamentado» do plano (com FCR) coincide com
// o «lançado» quando as quotas foram emitidas — sem variância falsa.
function testeSemDuplaContagem() {
  const ymInicio = 202601;
  const ymFim = 202601;
  const orcamentosPeriodo = [
    { id: 1, ano: 2026, data_inicio: '2026-01-01', data_fim: '2026-12-31', rubricas: [] },
  ];
  const planos = [
    { orcamento_id: 1, fracao_id: 21, ano: 2026, mes: 1, valor: '550.00', estado: 'planeada' },
    { orcamento_id: 1, fracao_id: 22, ano: 2026, mes: 1, valor: '550.00', estado: 'planeada' },
  ];
  // Quotas emitidas a partir desse plano: 550 = 500 (base) + 50 (FCR).
  const quotas = [
    { id: 1, fracao_id: 21, ano: 2026, mes: 1, valor: '550.00', valor_base: '500.00', valor_fcr: '50.00' },
    { id: 2, fracao_id: 22, ano: 2026, mes: 1, valor: '550.00', valor_base: '500.00', valor_fcr: '50.00' },
  ];
  const dados = {
    quotas,
    extras: [],
    parcelas: [],
    pagoQ: new Map(),
    pagoP: new Map(),
    intervalo: { ymInicio, ymFim },
  };

  const receitaPrevista = receitaPrevistaDoPeriodo({ orcamentosPeriodo, planos, ymInicio, ymFim });
  const receitas = construirReceitas({ dados, receitaPrevista });

  assert.strictEqual(receitaPrevista.origem, 'plano_quotas', 'a previsão vem do plano de quotas (com FCR)');
  assert.strictEqual(receitaPrevista.valorC, 110000, 'plano: 2 × 550 € = 1.100 € (total a cobrar)');

  const t = receitas.totais;
  assert.strictEqual(t.lancadoC, 110000, 'lançado = 1.100 € — o FCR NÃO é somado por cima (seria 1.210 €)');
  assert.strictEqual(t.fcrC, 10000, 'FCR contabilizado = 100 € (2 × 50 €)');
  assert.strictEqual(t.lancadoC - t.fcrC, 100000, 'lançado − FCR = Σ valor_base (500 € × 2) ⇒ o FCR está DENTRO');
  assert.strictEqual(t.orcamentadoC, 110000, 'orçamentado (plano, com FCR) = lançado ⇒ sem variância falsa');
  assert.strictEqual(t.emDividaC, 110000, 'em dívida = lançado − recebido (nada recebido)');

  // A mesma prova a partir do que está gravado na quota: com dupla contagem o
  // lançado seria Σ base + 2 × Σ FCR.
  const somaBase = quotas.reduce((s, q) => s + toCents(q.valor_base), 0);
  const somaFcr = quotas.reduce((s, q) => s + toCents(q.valor_fcr), 0);
  const somaTotal = quotas.reduce((s, q) => s + toCents(q.valor), 0);
  assert.strictEqual(somaBase + somaFcr, somaTotal, 'invariante da quota: base + FCR = total');
  assert.strictEqual(t.lancadoC, somaTotal, 'o lançado é Σ valor (uma vez) — não Σ base + Σ FCR extra');
  assert.notStrictEqual(t.lancadoC, somaBase + 2 * somaFcr, 'NÃO há dupla contagem do fundo');

  // Não existe uma linha de receita autónoma para o FCR (que seria a 2.ª soma):
  // as quotas ordinárias são a única rubrica de receita do período.
  assert.strictEqual(receitas.rubricas.length, 1, 'uma única rubrica de receita no período');
  assert.strictEqual(receitas.rubricas[0].tipo, 'quotas_ordinarias', 'é a rubrica das quotas ordinárias');
  assert.strictEqual(
    receitas.rubricas.filter((l) => /fcr|fundo/i.test(String(l.designacao))).length,
    0,
    'nenhuma rubrica de receita dedicada ao FCR (não há segunda soma)'
  );

  // Limite conhecido, documentado e NÃO é defeito: quando ainda não existe plano
  // de quotas, a previsão cai na receita configurada (modo B, que já é o total
  // com FCR) ou na soma das rubricas do orçamento (modo A = só despesas, sem
  // FCR). Neste último caso o orçamentado fica sem fundo e o lançado tem-no.
  const semPlano = receitaPrevistaDoPeriodo({
    orcamentosPeriodo: [{
      id: 1, data_inicio: '2026-01-01', data_fim: '2026-12-31', receita_quotas_prevista: null,
      rubricas: [{ ativo: true, valor_anual: '12000.00', periodicidade: 'mensal' }],
    }],
    planos: [],
    ymInicio,
    ymFim,
  });
  assert.strictEqual(semPlano.origem, 'rubricas_orcamento', 'sem plano, a previsão cai nas rubricas (só despesas)');
  assert.strictEqual(semPlano.valorC, 100000, 'rubricas: 12.000 € / 12 = 1.000 € no mês (sem FCR)');

  const modoB = receitaPrevistaDoPeriodo({
    orcamentosPeriodo: [{
      id: 1, data_inicio: '2026-01-01', data_fim: '2026-12-31', receita_quotas_prevista: '13200.00',
      rubricas: [],
    }],
    planos: [],
    ymInicio,
    ymFim,
  });
  assert.strictEqual(modoB.origem, 'receita_quotas_prevista', 'modo B: a receita configurada é o total');
  assert.strictEqual(modoB.valorC, 110000, 'modo B: 13.200 € / 12 = 1.100 € no mês (já inclui o FCR)');

  console.log('  ✓ G. o FCR entra no balancete uma só vez (dentro da quota), sem dupla contabilização');
}

(async () => {
  console.log('Percentagem do FCR sobre o orçamento — auditoria com prova\n');
  testesDeCalculo();
  await testeConfiguracaoPorCondominio();
  await testeRotaGerarQuotasDeOrcamento();
  testeInterface();
  testesDoCaminhoDoOrcamento();
  await testeRotaEmitirQuotas();
  testeSemDuplaContagem();
  console.log('\n✓ Testes da percentagem do FCR sobre o orçamento passaram (sem base de dados).');
})().catch((e) => {
  console.error('\n✗ FALHA:', e.message);
  console.error(e.stack);
  process.exit(1);
});
