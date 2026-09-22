// ═══════════════════════════════════════════════════════════════════
// Pendências de quotas: recálculo de configuração (R10/Q9) e fecho do plano (P22).
//
// R10 — O recálculo em massa (POST /admin/quotas/config com `recalcular=futuras`)
//       deixou de ser um recálculo: passou a PRÉ-VISUALIZAÇÃO SEM ESCRITA (Q9).
//       Uma quota EMITIDA (`data_emissao` preenchida) é um DOCUMENTO e os seus
//       valores são imutáveis: nenhuma configuração, recálculo ou edição os
//       altera. O antigo filtro P19 (por `estado` + `data_vencimento`) era um
//       SUBCONJUNTO ESTRITO desta regra — protegia o dinheiro aplicado, mas
//       deixava passar o documento emitido ainda `pendente` e protegia «por
//       acidente» as quotas com vencimento no passado.
//
// P22 — `calcularPlano` fecha ao cêntimo com o orçamento. O `dividirEm` antigo
//       (`Math.round(totalC / n)` repetido n vezes) multiplicava o erro de
//       arredondamento por n — medido na auditoria de 2026-09-20: +0,08 €/ano
//       num orçamento de 10.000 € repartido por 3 frações.
//
// Testes DB-free: os modelos são duplos estadeufais instalados via
// `require.cache` (mesmo padrão de `test-fcr-orcamento.js`). O duplo de
// `Quota.findAll` interpreta o `where` REAL que a rota construiu, usando os
// mesmos símbolos `Op` do Sequelize — é isso que faz o teste morder quando o
// filtro da rota muda.
//
// Utilização: node scripts/test-quotas-recalculo-plano.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const { toCents, fromCents } = require('../helpers/money');
const { calcularPlano } = require('../helpers/plano');
const { distribuirValorAnual } = require('../helpers/distribuicao');
const { parcelar } = require('../helpers/extra-quotas');

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

// ═══════════════════════════════════════════════════════════════════
// A. P22 — o plano fecha ao cêntimo
// ═══════════════════════════════════════════════════════════════════
function testesDoPlano() {
  const ORC = { data_inicio: '2026-01-01', data_fim: '2026-12-31' };
  const somaC = (plano) => plano.reduce((s, p) => s + toCents(p.valor), 0);

  // A1. Exemplo 2 da auditoria: 10.000 € por 3 frações, rubrica mensal.
  //     O orçamento divide-se em 3333,33 + 3333,33 + 3333,34 — nenhum valor é
  //     divisível por 12, pelo que o `dividirEm` antigo inflacionava.
  {
    const distribuicoes = [
      { rubrica_id: 11, fracao_id: 21, valor_anual: '3333.33' },
      { rubrica_id: 11, fracao_id: 22, valor_anual: '3333.33' },
      { rubrica_id: 11, fracao_id: 23, valor_anual: '3333.34' },
    ];
    const fracoes = [{ id: 21 }, { id: 22 }, { id: 23 }];
    const plano = calcularPlano({
      orcamento: ORC,
      rubricas: [{ id: 11, periodicidade: 'mensal' }],
      distribuicoes,
      fracoes,
    });

    assert.strictEqual(plano.length, 36, '3 frações × 12 meses = 36 células');
    assert.strictEqual(somaC(plano), toCents('10000.00'),
      'P22: o plano fecha EXATAMENTE com o orçamento (10.000 €), sem a inflação de +0,08 €');

    // E o defeito era real: a fórmula antiga NÃO fechava neste caso.
    const antigoC = distribuicoes.reduce((s, d) => s + Math.round(toCents(d.valor_anual) / 12) * 12, 0);
    assert.strictEqual(antigoC, toCents('10000.08'),
      'a fórmula antiga inflacionava para 10.000,08 € (é este o defeito corrigido)');

    // Fecho por fração: Σ meses = valor anual distribuído.
    for (const d of distribuicoes) {
      const daFracao = plano.filter((p) => p.fracaoId === d.fracao_id);
      assert.strictEqual(daFracao.reduce((s, p) => s + toCents(p.valor), 0), toCents(d.valor_anual),
        `fração ${d.fracao_id}: Σ meses = valor anual (${d.valor_anual} €)`);
    }
    console.log('  ✓ A1. plano fecha ao cêntimo com o orçamento (exemplo 2 da auditoria)');
  }

  // A2. Nenhuma célula fica inflacionada: as partes diferem no máximo 1 cêntimo
  //     e o cêntimo sobrante não é «atirado» à última.
  {
    const plano = calcularPlano({
      orcamento: ORC,
      rubricas: [{ id: 11, periodicidade: 'mensal' }],
      distribuicoes: [{ rubrica_id: 11, fracao_id: 21, valor_anual: '3333.33' }],
      fracoes: [{ id: 21 }],
    });
    const valores = plano.map((p) => toCents(p.valor));
    const min = Math.min(...valores);
    const max = Math.max(...valores);
    assert.ok(max - min <= 1, `meses dentro de 1 cêntimo (min=${min}, max=${max})`);
    assert.strictEqual(valores[valores.length - 1] - valores[0] <= 1, true,
      'a última célula não é privilegiada nem penalizada');
    console.log('  ✓ A2. meses diferem no máximo 1 cêntimo (sem mês inflacionado)');
  }

  // A3. Varrimento: qualquer combinação de valores não divisíveis fecha exato.
  {
    const casos = [
      { valor: '1000.00', n: 3, per: 'mensal' },
      { valor: '1234.56', n: 7, per: 'mensal' },
      { valor: '9999.99', n: 12, per: 'mensal' },
      { valor: '100.01', n: 4, per: 'trimestral' },
      { valor: '77.77', n: 2, per: 'semestral' },
      { valor: '1.01', n: 1, per: 'anual' },
    ];
    for (const c of casos) {
      const fracoes = Array.from({ length: c.n }, (_, i) => ({ id: 100 + i }));
      const distribuicoes = fracoes.map((f) => ({ rubrica_id: 11, fracao_id: f.id, valor_anual: c.valor }));
      const plano = calcularPlano({
        orcamento: ORC,
        rubricas: [{ id: 11, periodicidade: c.per }],
        distribuicoes,
        fracoes,
      });
      const esperado = toCents(c.valor) * c.n;
      assert.strictEqual(somaC(plano), esperado,
        `${c.n} × ${c.valor} € (${c.per}) fecha exato (esperado ${esperado} cêntimos, obtido ${somaC(plano)})`);
    }
    console.log('  ✓ A3. varrimento de valores não divisíveis fecha sempre exato');
  }

  // A4. Com FCR, o plano continua a representar o TOTAL (despesas + FCR) e a
  //     decomposição base + FCR fecha em cada célula.
  {
    const { dividirComponentesQuota, acrescentarFcrAoTotal } = require('../helpers/quotas-calc');
    const distribuicoes = [{ rubrica_id: 11, fracao_id: 21, valor_anual: '3333.33' }];
    const semFcr = calcularPlano({
      orcamento: ORC, rubricas: [{ id: 11, periodicidade: 'mensal' }],
      distribuicoes, fracoes: [{ id: 21 }],
    });
    const comFcr = calcularPlano({
      orcamento: ORC, rubricas: [{ id: 11, periodicidade: 'mensal' }],
      distribuicoes, fracoes: [{ id: 21 }], fcrPercentagem: 10,
    });
    assert.strictEqual(somaC(semFcr), toCents('3333.33'), 'sem FCR o plano são as despesas exatas');
    // O acréscimo do FCR é POR CÉLULA (validado em test-fcr-orcamento.js E2b):
    // o desvio acumulado fica limitado a 1 cêntimo por célula.
    const alvoC = acrescentarFcrAoTotal(somaC(semFcr), 10);
    assert.ok(Math.abs(somaC(comFcr) - alvoC) <= comFcr.length,
      `com FCR o desvio acumulado (${somaC(comFcr) - alvoC} cêntimos) fica dentro de 1 cêntimo por célula`);
    for (const linha of comFcr) {
      const partes = dividirComponentesQuota(toCents(linha.valor), 10);
      assert.strictEqual(partes.baseC + partes.fcrC, partes.totalC, 'base + FCR = total em cada célula');
    }
    console.log('  ✓ A4. com FCR: total por célula e base + FCR = total preservados');
  }
}

// ═══════════════════════════════════════════════════════════════════
// B. R10 — o recálculo de configuração é PRÉ-VISUALIZAÇÃO: não escreve nada
//
// O contrato antigo (P19) protegia o DINHEIRO aplicado filtrando por `estado`
// e por `data_vencimento`. Era um SUBCONJUNTO ESTRITO de R10: deixava passar o
// DOCUMENTO emitido ainda `pendente`, e protegia «por acidente» as quotas com
// vencimento no passado. O contrato passou a ser:
//
//   `data_emissao` determina a imutabilidade financeira;
//   o estado de pagamento determina apenas o estado DERIVADO.
//
// Consequência direta: `POST /admin/quotas/config` com `recalcular=futuras`
// deixou de fazer `q.update(...)` sobre quotas existentes. Calcula o impacto e
// mostra-o (pré-visualização, Q9); a nova configuração só produz efeitos nas
// gerações FUTURAS de quotas (`POST /quotas/gerar`), nunca reescrevendo o que
// já existe — emitido ou não.
// ═══════════════════════════════════════════════════════════════════
async function testeDoRecalculo() {
  const FRACOES = [
    { id: 21, permilagem: '500', estado: 'ativo', condominio_id: 1 },
    { id: 22, permilagem: '500', estado: 'ativo', condominio_id: 1 },
  ];
  // EMITIDAS (com `data_emissao`) — documentos: congeladas por R10, seja qual
  // for o estado ou a data de vencimento.
  const emitida = (id, fracaoId, mes, estado, vencimento) => ({
    id,
    fracao_id: fracaoId,
    ano: 2026,
    mes,
    estado,
    data_emissao: dias(-5),
    data_vencimento: vencimento,
    valor: '110.00',
    valor_base: '100.00',
    valor_fcr: '10.00',
    valor_por_1000: '110.0000',
    permilagem_aplicada: '500.00',
    fcr_percentagem: '10.00',
  });
  const QUOTAS = [
    emitida(1, 21, 1, 'pendente', dias(+30)),          // emitida, por pagar
    emitida(2, 22, 1, 'parcialmente_paga', dias(+30)), // emitida, dinheiro aplicado
    emitida(3, 21, 2, 'paga', dias(+30)),              // emitida, paga
    emitida(4, 22, 2, 'pendente', dias(-30)),          // emitida, vencimento no PASSADO
    emitida(5, 21, 3, 'vencida', dias(+30)),           // emitida, estado derivado
    emitida(6, 22, 3, 'anulada', dias(+30)),           // emitida, anulada (fora do âmbito)
    // NÃO emitida — a única classe que uma nova configuração pode vir a
    // calcular, e fá-lo-á na GERAÇÃO SEGUINTE (não reescrevendo esta linha).
    {
      id: 7,
      fracao_id: 21,
      ano: 2026,
      mes: 4,
      estado: 'pendente',
      data_emissao: null,
      data_vencimento: dias(+30),
      valor: '110.00',
      valor_base: '100.00',
      valor_fcr: '10.00',
      valor_por_1000: '110.0000',
      permilagem_aplicada: '500.00',
      fcr_percentagem: '10.00',
    },
  ];
  const ATUALIZADAS = [];

  const comToJSON = (o) => Object.assign(Object.create({ toJSON() { return { ...this }; } }), o);

  // Duplo de findAll que INTERPRETA o `where` real da rota (mesmos `Op`).
  // Honrar o `where` é o que faz o teste morder: se a consulta da rota mudar, o
  // universo medido muda com ela.
  const aplicarWhere = (linhas, where = {}) => linhas.filter((q) => {
    if (where.condominio_id !== undefined && q.condominio_id !== undefined
      && q.condominio_id !== where.condominio_id) return false;
    const est = where.estado && where.estado[Op.in];
    if (est && !est.includes(q.estado)) return false;
    const estNe = where.estado && where.estado[Op.ne];
    if (estNe !== undefined && q.estado === estNe) return false;
    if (where.data_emissao === null && q.data_emissao) return false;
    const gte = where.data_vencimento && where.data_vencimento[Op.gte];
    if (gte && !(new Date(q.data_vencimento) >= gte)) return false;
    return true;
  });

  const modelo = (over = {}) => Object.assign({
    findOne: async () => null, findAll: async () => [], create: async (v) => comToJSON(v),
    destroy: async () => 0, count: async () => 0, update: async () => [0], findByPk: async () => null,
    findOrCreate: async () => [comToJSON({}), false], sum: async () => 0, max: async () => null,
    aggregate: async () => null,
  }, over);

  // Aplicações confirmadas — só para provar que o PAGAMENTO continua a
  // atualizar apenas o estado DERIVADO, nunca um valor (R10).
  const APLICACOES = [
    { id: 1, quota_id: 1, valor_aplicado: '110.00', pagamento_estado: 'confirmado' },
  ];

  const MODELS = new Proxy({}, {
    get: (_t, nome) => {
      if (nome === 'sequelize') return {};
      if (nome === 'Fracao') {
        return modelo({ findByPk: async (id) => FRACOES.find((f) => f.id === Number(id)) || null });
      }
      if (nome === 'Quota') {
        // Cada linha devolve um `update` que REGISTA a escrita (é o instrumento
        // que mede o defeito) e a aplica ao fixture, para o estado final poder
        // ser lido depois.
        const linha = (q) => comToJSON({
          ...q,
          update: async (campos) => {
            ATUALIZADAS.push({ id: q.id, estado: q.estado, campos });
            Object.assign(q, campos);
          },
        });
        return modelo({
          findAll: async (opts) => aplicarWhere(QUOTAS, opts && opts.where).map(linha),
          findByPk: async (id) => {
            const achada = QUOTAS.find((q) => Number(q.id) === Number(id));
            return achada ? linha(achada) : null;
          },
        });
      }
      if (nome === 'PagamentoQuota') {
        return modelo({
          findAll: async (opts) => {
            const where = (opts && opts.where) || {};
            const alvo = where.quota_id;
            const ids = Array.isArray(alvo) ? alvo.map(Number)
              : alvo === undefined ? null : [Number(alvo)];
            return APLICACOES
              .filter((a) => ids === null || ids.includes(Number(a.quota_id)))
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
  stub('helpers/saldos.js', { resumoCondominio: async () => ({ contas: [] }), resumoFracao: async () => ({}), estadoEfetivo: () => 'pendente' });
  stub('helpers/condominio.js', { getCondominio: async () => ({ id: 1, designacao: 'C1' }) });
  // A configuração é o que está a ser GRAVADO: a leitura real não interessa aqui.
  const quotasConfigReal = require('../helpers/quotas-config');
  let GRAVADO = null;
  stub('helpers/quotas-config.js', {
    ...quotasConfigReal,
    setQuotaConfig: async (id, cfg) => { GRAVADO = { id, cfg }; },
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
  app.use('/admin', require('../routes/financeiro'));
  app.use((err, req, res, next) => res.status(500).send('ERRO_500: ' + err.message));

  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;

  try {
    const corpo = new URLSearchParams({
      valor_1000: '110.0000', fcr_percentagem: '10', recalcular: 'futuras',
    });
    const r = await fetch(`${base}/admin/quotas/config`, { method: 'POST', body: corpo, redirect: 'manual' });
    assert.strictEqual(r.status, 302, 'a gravação da configuração responde com redirect');
    assert.ok(GRAVADO, 'a configuração foi gravada no âmbito do condomínio ativo');
    assert.strictEqual(GRAVADO.id, 1, 'a configuração é gravada no condomínio ativo (âmbito explícito)');

    // ── B1. O recálculo de configuração não escreve em quota nenhuma ──
    const ids = ATUALIZADAS.map((a) => a.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [],
      'R10/Q9: `recalcular=futuras` é PRÉ-VISUALIZAÇÃO e não pode gravar nenhuma quota '
      + `(esperado: nenhuma; obtido: [${ids.join(', ')}])`);
    console.log('  ✓ B1. `recalcular=futuras` não escreve em quota nenhuma (pré-visualização, Q9)');

    // ── B2. As quotas EMITIDAS mantêm os snapshots intactos ──
    // A fronteira é `data_emissao`: estado e vencimento não decidem nada.
    const CAMPOS = ['valor', 'valor_base', 'valor_fcr', 'valor_por_1000', 'permilagem_aplicada', 'fcr_percentagem'];
    const ESPERADO = {
      valor: '110.00', valor_base: '100.00', valor_fcr: '10.00',
      valor_por_1000: '110.0000', permilagem_aplicada: '500.00', fcr_percentagem: '10.00',
    };
    const emitidas = QUOTAS.filter((q) => q.data_emissao);
    assert.strictEqual(emitidas.length, 6, 'pré-condição: 6 quotas emitidas no fixture');
    for (const q of emitidas) {
      for (const c of CAMPOS) {
        assert.strictEqual(String(q[c]), ESPERADO[c],
          `quota emitida #${q.id} (${q.estado}): o campo ${c} tem de ficar intacto (R10)`);
      }
    }
    // Os dois casos que o antigo filtro P19 deixava passar / protegia por acidente:
    assert.strictEqual(QUOTAS.find((q) => q.id === 1).valor, '110.00',
      'a quota emitida e ainda `pendente` (#1) fica intacta — P19 deixava-a passar');
    assert.strictEqual(QUOTAS.find((q) => q.id === 4).valor, '110.00',
      'a quota emitida com vencimento no PASSADO (#4) fica intacta pela razão certa (estar emitida)');
    console.log('  ✓ B2. quotas emitidas (pendentes, pagas, parciais e vencidas) mantêm os snapshots');

    // ── B3. As quotas NÃO emitidas são o universo da pré-visualização ──
    // Continuam a poder ser CALCULADAS (é o que a pré-visualização mostra), mas
    // não são reescritas: a nova configuração aplica-se à geração seguinte.
    const { previsaoRecalculo } = require('../helpers/quotas-previsao');
    const previa = await previsaoRecalculo({
      condominioId: 1, valorPor1000: '110.0000', fcrPercentagem: '10',
    });
    assert.deepStrictEqual(previa.afetadas.map((a) => a.id), [7],
      'só a quota NÃO emitida (#7) é candidata a cálculo com a nova configuração');
    assert.strictEqual(previa.afetadas[0].para, 55,
      'a pré-visualização mostra o valor que a nova configuração produziria (500‰ a 110 €/1000‰ → 55 €)');
    assert.deepStrictEqual(previa.protegidas.map((p) => p.id).sort((a, b) => a - b), [1, 2, 3, 4, 5],
      'as 5 quotas emitidas não anuladas são reportadas como PROTEGIDAS (R10)');
    assert.strictEqual(QUOTAS.find((q) => q.id === 7).valor, '110.00',
      'a pré-visualização NÃO reescreve a quota não emitida (só mostra o impacto)');
    console.log('  ✓ B3. pré-visualização: não emitidas calculadas e mostradas, sem escrita');

    // ── B4. O pagamento continua a atualizar APENAS o estado derivado ──
    const { recalcularEstadoQuota } = require('../helpers/pagamentos');
    const antes4 = { ...QUOTAS.find((q) => q.id === 1) };
    await recalcularEstadoQuota(1, {});
    const q1 = QUOTAS.find((q) => q.id === 1);
    assert.strictEqual(q1.estado, 'paga',
      'com 110 € confirmados sobre 110 €, o estado derivado é `paga`');
    for (const c of CAMPOS) {
      assert.strictEqual(String(q1[c]), String(antes4[c]),
        `o pagamento não pode tocar no campo ${c} (só o estado derivado muda)`);
    }
    assert.ok(
      ATUALIZADAS.every((a) => Object.keys(a.campos).join(',') === 'estado'),
      'a única escrita que o pagamento pode fazer é `estado`'
    );
    console.log('  ✓ B4. pagamento atualiza apenas o estado derivado (nenhum valor é tocado)');
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }
}

// ═══════════════════════════════════════════════════════════════════
// C. Ordem determinística nas distribuições por maior-resto
//
// `distribuirPorPesos` (helpers/distribuicao.js) fecha a soma pelo método do
// maior resto e desempata com `sort((a,b) => b.frac - a.frac)`. O `sort` do
// JavaScript é ESTÁVEL: em empate (método `igual`, ou frações com a mesma
// permilagem), a ordem do array decide quem paga o cêntimo sobrante. Uma
// consulta sem `order` faz depender de uma ordem NÃO ESPECIFICADA da base de
// dados algo que é dinheiro — a soma mantém-se, mas quem paga varia.
// ═══════════════════════════════════════════════════════════════════
function testesDeDeterminismo() {
  const somaC = (l) => l.reduce((s, x) => s + toCents(x.valor), 0);
  const cent = (l, id) => toCents(l.find((x) => x.fracaoId === id).valor);

  // C1. O risco é real: a mesma distribuição, em duas ordens, dá cêntimos
  //     diferentes a cada fração — com a soma exata nas duas.
  {
    const f = (id) => ({ id, permilagem: '500' });
    const ordemA = distribuirValorAnual('100.00', [f(21), f(22), f(23)], 'igual');
    const ordemB = distribuirValorAnual('100.00', [f(23), f(22), f(21)], 'igual');

    assert.strictEqual(somaC(ordemA), toCents('100.00'), 'soma exata na ordem A');
    assert.strictEqual(somaC(ordemB), toCents('100.00'), 'soma exata na ordem B');
    assert.notStrictEqual(cent(ordemA, 21), cent(ordemB, 21),
      'com empate de pesos, é a ORDEM do array que decide quem recebe o cêntimo sobrante');
    console.log('  ✓ C1. maior-resto desempata pela ordem (prova do risco de uma consulta sem `order`)');
  }

  // C2. O orçamento distribui dinheiro por frações em mais do que um ponto
  //     (`distribuirValorAnual`). Em TODOS eles a lista tem de ter ordem fixa —
  //     verificar só o primeiro deixaria o outro descoberto.
  {
    const src = fs.readFileSync(path.join(RAIZ, 'routes/orcamento.js'), 'utf8');
    const chamadas = [...src.matchAll(/distribuirValorAnual\(/g)].map((m) => m.index);
    assert.ok(chamadas.length >= 2,
      `routes/orcamento.js distribui por frações em mais do que um ponto (encontrados: ${chamadas.length})`);

    for (const iDist of chamadas) {
      // A lista que chega à chamada é a ÚLTIMA consulta a `Fracao` antes dela.
      const iFrac = src.lastIndexOf('const fracoes = await Fracao.findAll({', iDist);
      assert.ok(iFrac > 0, `a lista de frações é lida antes da distribuição (offset ${iDist})`);
      const bloco = src.slice(iFrac, src.indexOf('});', iFrac) + 3);
      assert.ok(/order:\s*\[\['designacao',\s*'ASC'\]\]/.test(bloco),
        `a distribuição por frações (offset ${iDist}) tem de fixar a ordem da lista ` +
        "(`order: [['designacao', 'ASC']]`) — sem ela o cêntimo do maior-resto vai para quem a base de dados puser primeiro");
    }
    console.log(`  ✓ C2. as ${chamadas.length} distribuições por frações do orçamento fixam a ordem`);
  }

  // C3. As DUAS pontas da geração de quotas (pré-visualização e gravação)
  //     ordenam da MESMA forma — senão o maior-resto do método orçamento
  //     poderia dar o cêntimo a outra fração e a pré-visualização mentiria.
  {
    const src = fs.readFileSync(path.join(RAIZ, 'routes/financeiro.js'), 'utf8');
    const blocos = src.split('router.get(\'/quotas/gerar\'').pop();
    const iPrevia = blocos.indexOf('Fracao.findAll({');
    const blocoPrevia = blocos.slice(iPrevia, blocos.indexOf('});', iPrevia) + 3);
    assert.ok(/order:\s*\[\['designacao',\s*'ASC'\]\]/.test(blocoPrevia),
      'GET /quotas/gerar: a lista que alimenta a pré-visualização tem ordem fixa');

    const iGravacao = src.indexOf('router.post(\'/quotas/gerar\'');
    const iFracGrav = src.indexOf('const fracoes = await Fracao.findAll({', iGravacao);
    const blocoGrav = src.slice(iFracGrav, src.indexOf('});', iFracGrav) + 3);
    assert.ok(/order:\s*\[\['designacao',\s*'ASC'\]\]/.test(blocoGrav),
      'POST /quotas/gerar: a lista que alimenta a gravação tem a MESMA ordem');
    console.log('  ✓ C3. pré-visualização e gravação ordenam as frações da mesma forma');
  }
}

// ═══════════════════════════════════════════════════════════════════
// D. Quotas EXTRAORDINÁRIAS — parcelas e ordem da distribuição
//
// Duas inconsistências da mesma família das anteriores, na via das quotas
// extraordinárias: (1) `parcelar` atirava TODO o resto para a última parcela
// (até 0,59 € com 60 parcelas) contra a promessa de «parcelas iguais»;
// (2) a lista de frações que alimenta `distribuicaoExtra` não fixava `order`,
// logo o cêntimo do maior-resto ia para quem a base de dados puser primeiro.
// ═══════════════════════════════════════════════════════════════════
function testesDeQuotasExtra() {
  // D1. As parcelas fecham exatamente E são iguais dentro de 1 cêntimo.
  {
    const valorC = toCents('1000.01');
    const n = 60;
    const parcelas = parcelar(valorC, n);

    assert.strictEqual(parcelas.length, n, '60 parcelas');
    assert.strictEqual(parcelas.reduce((s, v) => s + v, 0), valorC,
      'a soma das parcelas é EXATAMENTE o valor da fração (nenhum cêntimo perdido nem inventado)');

    const min = Math.min(...parcelas);
    const max = Math.max(...parcelas);
    assert.ok(max - min <= 1,
      `parcelas iguais dentro de 1 cêntimo (min=${min}, max=${max}, diferença=${max - min})`);

    // A regra antiga (resto todo na última) dava um desvio MUITO maior — é o
    // defeito corrigido, medido no mesmo caso.
    const antigo = new Array(n).fill(Math.floor(valorC / n));
    antigo[n - 1] += valorC - Math.floor(valorC / n) * n;
    assert.strictEqual(antigo[n - 1] - antigo[0], 41,
      'a regra antiga punha 41 cêntimos (0,41 €) numa parcela só');
    assert.ok(max - min < antigo[n - 1] - antigo[0],
      'a correção reduz o desvio entre parcelas');
    console.log('  ✓ D1. parcelas de quota extra: soma exata e diferença ≤1 cêntimo (antes: 0,41 €)');
  }

  // D1b. Varrimento: qualquer valor × qualquer n fecha e não privilegia a última.
  {
    for (const [valor, n] of [['100.00', 3], ['999.99', 7], ['0.05', 60], ['12345.67', 12], ['10.00', 1]]) {
      const valorC = toCents(valor);
      const parcelas = parcelar(valorC, n);
      assert.strictEqual(parcelas.reduce((s, v) => s + v, 0), valorC,
        `${valor} € em ${n} parcelas: soma exata`);
      assert.ok(Math.max(...parcelas) - Math.min(...parcelas) <= 1,
        `${valor} € em ${n} parcelas: diferença ≤1 cêntimo`);
    }
    console.log('  ✓ D1b. varrimento de valores × n.º de parcelas: soma exata e diferença ≤1 cêntimo');
  }

  // D2. A distribuição do total pelas frações tem de partir de uma lista com
  //     ordem fixa (mesma razão da C2).
  {
    const src = fs.readFileSync(path.join(RAIZ, 'routes/extra-quotas.js'), 'utf8');
    const iDist = src.indexOf('distribuicaoExtra(');
    assert.ok(iDist > 0, 'routes/extra-quotas.js usa distribuicaoExtra');
    const iFrac = src.lastIndexOf('const fracoes = await Fracao.findAll({', iDist);
    assert.ok(iFrac > 0, 'a lista de frações é lida antes da distribuição');
    const bloco = src.slice(iFrac, src.indexOf('});', iFrac) + 3);
    assert.ok(/order:\s*\[\['designacao',\s*'ASC'\]\]/.test(bloco),
      'a distribuição da quota extraordinária fixa a ordem das frações');
    console.log('  ✓ D2. quota extraordinária: distribuição com ordem fixa');
  }
}

// ═══════════════════════════════════════════════════════════════════
(async () => {
  console.log('Pendências de quotas — recálculo de configuração (R10/Q9) e fecho do plano (P22)');
  testesDoPlano();
  testesDeDeterminismo();
  testesDeQuotasExtra();
  await testeDoRecalculo();
  console.log('\n✓ Testes do recálculo e do fecho do plano passaram (sem base de dados).');
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
