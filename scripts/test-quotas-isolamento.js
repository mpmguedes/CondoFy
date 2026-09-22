// Testes do isolamento multi-condomínio da configuração de quotas e dos jobs
// automáticos (correção E1 + E2) — sem base de dados.
//
// Utilização: node scripts/test-quotas-isolamento.js
//
// Porque é que estes testes existem: a configuração das quotas (valor por 1000‰
// e percentagem do FCR) é decidida POR CONDOMÍNIO, e os jobs automáticos correm
// fora de qualquer pedido HTTP — não há «condomínio ativo». Antes desta
// correção, ambos liam/escreviam uma única configuração global e uma única
// consulta global de frações, o que misturava condomínios.
//
// Prova-se aqui, sem BD:
//  1. A pode ter `quota_valor_1000` diferente de B;
//  2. A pode ter `quota_fcr_percentagem` diferente de B;
//  3. sem configuração específica, é usado o valor global;
//  4. sem específica nem global, é usado o default do código;
//  5. a geração automática não cria quotas de A em B nem de B em A;
//  6. os lembretes automáticos não selecionam destinatários de outro condomínio;
//  7. instalações existentes (só com chaves globais) continuam compatíveis.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// ── Duplo da tabela `configuracoes` (chave-valor) ───────────────────
// Guarda-se o registo COMPLETO de chaves escritas, para se poder provar que a
// gravação de um condomínio nunca toca nas chaves de outro nem na global.
const valores = {};
const escritas = [];
const configPath = require.resolve(path.join(RAIZ, 'helpers', 'config'));
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, defeito = null) => (chave in valores ? valores[chave] : defeito),
    setConfig: async (chave, valor) => {
      valores[chave] = String(valor);
      escritas.push(chave);
      return { chave, valor: String(valor) };
    },
  },
};

const {
  getQuotaConfig,
  setQuotaConfig,
  chaveDoCondominio,
  VALOR_POR_1000_PADRAO,
  FCR_MINIMO_LEGAL,
} = require('../helpers/quotas-config');

// ── 1. Dois condomínios com configurações diferentes ────────────────
async function testeADiferenteDeB() {
  await setQuotaConfig(1, { valorPor1000: '120.0000', fcrPercentagem: 15 });
  await setQuotaConfig(2, { valorPor1000: '85.5000', fcrPercentagem: 20 });

  const a = await getQuotaConfig(1);
  const b = await getQuotaConfig(2);

  // (1) valor por 1000‰ diferente
  assert.strictEqual(a.valorPor1000, '120.0000', 'A: valor por 1000‰ próprio');
  assert.strictEqual(b.valorPor1000, '85.5000', 'B: valor por 1000‰ próprio e diferente de A');
  assert.notStrictEqual(a.valorPor1000, b.valorPor1000, 'A e B têm valores por 1000‰ diferentes');

  // (2) percentagem de FCR diferente
  assert.strictEqual(a.fcrPercentagem, '15', 'A: FCR próprio (15%)');
  assert.strictEqual(b.fcrPercentagem, '20', 'B: FCR próprio (20%) e diferente de A');
  assert.notStrictEqual(a.fcrPercentagem, b.fcrPercentagem, 'A e B têm percentagens de FCR diferentes');

  // A chave de cada condomínio é distinta e ambas existem em paralelo.
  assert.ok('quota_valor_1000:c1' in valores, 'existe a chave do condomínio 1');
  assert.ok('quota_valor_1000:c2' in valores, 'existe a chave do condomínio 2');
  assert.strictEqual(valores['quota_valor_1000:c1'], '120.0000');
  assert.strictEqual(valores['quota_valor_1000:c2'], '85.5000');
  console.log('  ✓ A e B têm valor por 1000‰ e percentagem de FCR distintos (em paralelo)');
}

// ── 2. Gravar um condomínio não toca nos outros nem na global ──────
async function testeEscritaNaoContamina() {
  // Estado herdado: instalação antiga com valores globais gravados.
  valores['quota_valor_1000'] = '100.0000';
  valores['quota_fcr_percentagem'] = '10';
  escritas.length = 0;

  await setQuotaConfig(7, { valorPor1000: '130.0000', fcrPercentagem: 25 });

  // Só foram escritas chaves do condomínio 7 — nunca a global nem a de outro.
  assert.deepStrictEqual(
    escritas.filter((c) => !c.endsWith(':c7')),
    [],
    'gravar o condomínio 7 não escreve chaves globais nem de outros condomínios'
  );
  assert.strictEqual(valores['quota_valor_1000'], '100.0000', 'a chave global herdada mantém-se intacta');
  assert.strictEqual(valores['quota_fcr_percentagem'], '10', 'a chave global herdada mantém-se intacta');
  assert.strictEqual(valores['quota_valor_1000:c1'], '120.0000', 'a configuração de outro condomínio mantém-se intacta');

  // O condomínio 7 usa o PRÓPRIO valor; o 1 continua com o seu; e a global
  // continua a valer como herança para quem não tenha valor próprio.
  assert.strictEqual((await getQuotaConfig(7)).valorPor1000, '130.0000', '7 usa o seu valor');
  assert.strictEqual((await getQuotaConfig(1)).valorPor1000, '120.0000', '1 mantém o seu valor');
  assert.strictEqual((await getQuotaConfig(99)).valorPor1000, '100.0000', '99 herda a global');
  console.log('  ✓ gravar num condomínio não reescreve a global nem os restantes condomínios');
}

// ── 3. Sem configuração específica → usa a global ─────────────────
async function testeFallbackGlobal() {
  valores['quota_valor_1000'] = '95.0000';
  valores['quota_fcr_percentagem'] = '12';
  delete valores['quota_valor_1000:c50'];
  delete valores['quota_fcr_percentagem:c50'];

  const c = await getQuotaConfig(50);
  assert.strictEqual(c.valorPor1000, '95.0000', 'sem valor próprio, herda o valor global');
  assert.strictEqual(c.fcrPercentagem, '12', 'sem percentagem própria, herda a global');
  console.log('  ✓ sem configuração específica, é usado o valor global');
}

// ── 4. Sem específica nem global → usa o default do código ────────
async function testeFallbackDefault() {
  delete valores['quota_valor_1000'];
  delete valores['quota_fcr_percentagem'];
  delete valores['quota_valor_permilagem'];
  delete valores['quota_valor_1000:c60'];
  delete valores['quota_fcr_percentagem:c60'];

  const c = await getQuotaConfig(60);
  assert.strictEqual(c.valorPor1000, VALOR_POR_1000_PADRAO, 'sem nada configurado, usa o default do valor por 1000‰');
  assert.strictEqual(c.fcrPercentagem, String(FCR_MINIMO_LEGAL), 'sem nada configurado, o FCR é o mínimo legal (10%)');
  console.log(`  ✓ sem específica nem global, usa os defaults (${VALOR_POR_1000_PADRAO} e ${FCR_MINIMO_LEGAL}%)`);
}

// ── 5. Precedência: específica > global > default ──────────────────
async function testePrecedencia() {
  // global + específica → ganha a específica
  valores['quota_valor_1000'] = '100.0000';
  valores['quota_fcr_percentagem'] = '10';
  await setQuotaConfig(1, { valorPor1000: '120.0000', fcrPercentagem: 15 });
  const c = await getQuotaConfig(1);
  assert.strictEqual(c.valorPor1000, '120.0000', 'precedência: específica ganha à global (valor)');
  assert.strictEqual(c.fcrPercentagem, '15', 'precedência: específica ganha à global (FCR)');

  // A mistura é resolvida chave a chave: valor próprio + FCR herdado da global.
  valores['quota_valor_1000:c70'] = '77.0000';
  delete valores['quota_fcr_percentagem:c70'];
  const misto = await getQuotaConfig(70);
  assert.strictEqual(misto.valorPor1000, '77.0000', 'precedência chave a chave: valor próprio');
  assert.strictEqual(misto.fcrPercentagem, '10', 'precedência chave a chave: FCR herdado da global');

  // Chave específica vazia não conta como configuração: cai para a global.
  valores['quota_valor_1000:c71'] = '';
  valores['quota_valor_1000'] = '88.0000';
  assert.strictEqual((await getQuotaConfig(71)).valorPor1000, '88.0000', 'chave específica vazia → usa a global');
  console.log('  ✓ precedência: específica → global → default (resolvida chave a chave)');
}

// ── 6. Instalações existentes continuam compatíveis ───────────────
async function testeCompatibilidade() {
  // (a) Instalação que só tem as chaves globais: comporta-se como antes e NÃO
  //     exige qualquer escrita na BD.
  for (const k of Object.keys(valores)) delete valores[k];
  valores['quota_valor_1000'] = '100.0000';
  valores['quota_fcr_percentagem'] = '10';
  escritas.length = 0;

  const antes = await getQuotaConfig(1);
  assert.strictEqual(antes.valorPor1000, '100.0000', 'instalação só-global: lê o valor global');
  assert.strictEqual(antes.fcrPercentagem, '10', 'instalação só-global: lê a percentagem global');
  assert.deepStrictEqual(escritas, [], 'ler a configuração não escreve nada (sem migração de dados)');

  // (b) Chave legada (€ por 1‰, anterior à migração 40): converte-se para
  //     valor por 1000‰ apenas quando não há nem específica nem global.
  for (const k of Object.keys(valores)) delete valores[k];
  valores['quota_valor_permilagem'] = '0.1'; // 0,1 € por 1‰ → 100 € por 1000‰
  const legado = await getQuotaConfig(1);
  assert.strictEqual(legado.valorPor1000, '100.0000', 'chave legada é convertida (0,1 €/1‰ → 100 €/1000‰)');
  assert.strictEqual(legado.fcrPercentagem, '10', 'sem FCR configurado, o legado usa o mínimo legal');

  // (c) Sem âmbito utilizável: a leitura cai nas chaves globais (nunca inventa
  //     um âmbito) e a escrita é recusada — não se grava configuração órfã.
  valores['quota_valor_1000'] = '100.0000';
  valores['quota_fcr_percentagem'] = '10';
  const semAmb = await getQuotaConfig(null);
  assert.strictEqual(semAmb.valorPor1000, '100.0000', 'sem âmbito: leitura cai nas chaves globais');
  await assert.rejects(
    () => setQuotaConfig(null, { valorPor1000: '1.0000', fcrPercentagem: 10 }),
    /condominioId válido/,
    'sem âmbito: a gravação é recusada (nunca grava configuração sem dono)'
  );
  await assert.rejects(
    () => setQuotaConfig(0, { valorPor1000: '1.0000', fcrPercentagem: 10 }),
    /condominioId válido/,
    'id 0: a gravação é recusada'
  );
  console.log('  ✓ instalações existentes compatíveis (globais e chave legada), sem escrita na leitura');
}

// ── 7. Geração automática isolada por condomínio (E2) ─────────────
// Carrega `jobs/automatizacao.js` com modelos e helpers substituídos por
// duplos, para observar EXATAMENTE o que é lido e criado.
async function testeGeracaoAutomaticaIsolada() {
  const modelsPath = require.resolve(path.join(RAIZ, 'models'));
  const origModels = require.cache[modelsPath];
  const origSeq = require.cache[require.resolve(path.join(RAIZ, 'config', 'database'))];
  const origNum = require.cache[require.resolve(path.join(RAIZ, 'helpers', 'numeracao'))];

  // Configuração a observar: A (1) = 120 €/1000‰ a 15%; B (2) = 85,5 €/1000‰ a 20%.
  for (const k of Object.keys(valores)) delete valores[k];
  await setQuotaConfig(1, { valorPor1000: '120.0000', fcrPercentagem: 15 });
  await setQuotaConfig(2, { valorPor1000: '85.5000', fcrPercentagem: 20 });

  const CONDOMINIOS = [
    { id: 1, estado: 'ativo' },
    { id: 2, estado: 'ativo' },
    { id: 3, estado: 'inativo' }, // inativo: nunca entra no âmbito
  ];
  const FRACOES = [
    { id: 101, condominio_id: 1, estado: 'ativo', permilagem: '500' },
    { id: 102, condominio_id: 1, estado: 'ativo', permilagem: '500' },
    { id: 201, condominio_id: 2, estado: 'ativo', permilagem: '250' },
    { id: 301, condominio_id: 3, estado: 'ativo', permilagem: '1000' }, // de condomínio inativo
  ];

  const consultasFracao = [];
  const criadas = []; // cada { ...dados, transaction }
  const configUsadas = []; // argumento passado a getQuotaConfig

  const fakeModels = {
    Condominio: {
      async findAll({ where }) {
        return CONDOMINIOS.filter((c) => !where || !where.estado || c.estado === where.estado);
      },
    },
    Fracao: {
      async findAll({ where }) {
        consultasFracao.push({ ...where });
        return FRACOES.filter((f) => f.estado === where.estado && f.condominio_id === where.condominio_id);
      },
    },
    Quota: {
      async findOne() { return null; }, // nada gerado ainda → idempotência não bloqueia
      async create(dados, opcoes) { criadas.push({ dados, opcoes }); return dados; },
    },
    Configuracao: {
      async findOne() { return null; },
    },
  };

  // getQuotaConfig é observado sem alterar o comportamento: envolve-se o módulo
  // real, para provar que o job passa SEMPRE o condomínio a processar.
  const qcPath = require.resolve(path.join(RAIZ, 'helpers', 'quotas-config'));
  const qcReal = require('../helpers/quotas-config');
  const qcObservado = {
    ...qcReal,
    async getQuotaConfig(condominioId) {
      configUsadas.push(condominioId);
      return qcReal.getQuotaConfig(condominioId);
    },
  };

  require.cache[modelsPath] = {
    id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [], exports: fakeModels,
  };
  require.cache[require.resolve(path.join(RAIZ, 'config', 'database'))] = {
    id: 'db', filename: 'db', loaded: true, children: [], paths: [],
    exports: { transaction: async () => ({ commit: async () => {}, rollback: async () => {} }) },
  };
  require.cache[require.resolve(path.join(RAIZ, 'helpers', 'numeracao'))] = {
    id: 'num', filename: 'num', loaded: true, children: [], paths: [],
    exports: { proximoNumero: async () => 'Q-000' },
  };
  require.cache[qcPath] = {
    id: qcPath, filename: qcPath, loaded: true, children: [], paths: [], exports: qcObservado,
  };
  const jobPath = require.resolve(path.join(RAIZ, 'jobs', 'automatizacao'));
  delete require.cache[jobPath];
  const job = require('../jobs/automatizacao');

  let resultado;
  try {
    resultado = await job.gerarQuotasAutomaticas();
  } finally {
    // Restaura o cache para não contaminar os testes seguintes.
    if (origModels) require.cache[modelsPath] = origModels; else delete require.cache[modelsPath];
    if (origSeq) require.cache[require.resolve(path.join(RAIZ, 'config', 'database'))] = origSeq;
    if (origNum) require.cache[require.resolve(path.join(RAIZ, 'helpers', 'numeracao'))] = origNum;
    delete require.cache[qcPath];
    require('../helpers/quotas-config');
    delete require.cache[jobPath];
  }

  // (a) As frações foram consultadas por condomínio (uma consulta escopada cada),
  //     nunca numa consulta global sem condominio_id.
  assert.deepStrictEqual(
    consultasFracao.map((w) => Number(w.condominio_id)).sort((x, y) => x - y),
    [1, 2],
    'a geração consulta as frações uma vez por condomínio ATIVO (nunca global, nunca o inativo)'
  );
  assert.ok(
    consultasFracao.every((w) => w.condominio_id !== undefined),
    'nenhuma consulta de frações é feita sem condominio_id'
  );

  // (b) A configuração foi lida com o condomínio de cada fração.
  assert.deepStrictEqual(
    configUsadas.slice().sort((x, y) => x - y),
    [1, 2],
    'a geração lê a configuração de cada condomínio (nunca uma única global)'
  );

  // (c) Cada quota criada pertence à fração DO MESMO condomínio (A não cria em B).
  assert.strictEqual(criadas.length, 3, 'foram criadas 3 quotas: 2 de A + 1 de B (a de C, inativo, não)');
  const donoDaFracao = { 101: 1, 102: 1, 201: 2, 301: 3 };
  for (const { dados } of criadas) {
    assert.strictEqual(
      dados.condominio_id, donoDaFracao[dados.fracao_id],
      `quota da fração ${dados.fracao_id} fica no condomínio ${donoDaFracao[dados.fracao_id]} (nunca noutro)`
    );
  }
  assert.ok(!criadas.some((c) => c.dados.condominio_id === 3), 'não é criada qualquer quota para o condomínio inativo');
  const idsB = criadas.filter((c) => c.dados.condominio_id === 2).map((c) => c.dados.fracao_id);
  assert.deepStrictEqual(idsB, [201], 'B só gera para as suas próprias frações');

  // (d) Os VALORES aplicados são os de cada condomínio (prova de que a
  //     configuração não foi trocada entre eles).
  const quotaA = criadas.find((c) => c.dados.fracao_id === 101).dados;
  const quotaB = criadas.find((c) => c.dados.fracao_id === 201).dados;
  assert.strictEqual(String(quotaA.valor_por_1000), '120', 'A usa o seu valor por 1000‰ (120)');
  assert.strictEqual(String(quotaA.fcr_percentagem), '15', 'A usa o seu FCR (15%)');
  assert.strictEqual(String(quotaB.valor_por_1000), '85.5', 'B usa o seu valor por 1000‰ (85,5) — não o de A');
  assert.strictEqual(String(quotaB.fcr_percentagem), '20', 'B usa o seu FCR (20%) — não o de A');
  assert.notStrictEqual(String(quotaA.valor_por_1000), String(quotaB.valor_por_1000), 'A e B não partilham o valor por 1000‰');

  // (e) Cada condomínio tem a sua própria transação (uma falha não arrasta os outros).
  const transacoes = new Set(criadas.map((c) => c.opcoes && c.opcoes.transaction));
  assert.strictEqual(transacoes.size, 2, 'há uma transação por condomínio (isolamento de falhas)');

  // (f) O resultado reporta o detalhe por condomínio.
  assert.strictEqual(resultado.geradas, 3, 'total de quotas geradas');
  assert.strictEqual(resultado.condominios, 2, 'dois condomínios processados');
  assert.deepStrictEqual(
    resultado.porCondominio.map((p) => [p.condominioId, p.geradas]),
    [[1, 2], [2, 1]],
    'o detalhe por condomínio é correto'
  );
  console.log('  ✓ geração automática: config e frações por condomínio; A nunca cria quotas em B (nem vice-versa)');
}

// ── 8. Lembretes automáticos não cruzam destinatários (E2) ────────
async function testeLembretesIsolados() {
  const modelsPath = require.resolve(path.join(RAIZ, 'models'));
  const origModels = require.cache[modelsPath];
  const origAvisos = require.cache[require.resolve(path.join(RAIZ, 'helpers', 'avisos'))];
  const origFila = require.cache[require.resolve(path.join(RAIZ, 'helpers', 'email-fila'))];
  const origNotif = require.cache[require.resolve(path.join(RAIZ, 'helpers', 'notificacoes'))];

  const hojeISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dLembrete = new Date(hoje); dLembrete.setDate(dLembrete.getDate() + 5);
  const lembreteISO = hojeISO(dLembrete);

  const QUOTAS = [
    { id: 1, condominio_id: 1, fracao_id: 101, ano: 2026, mes: 9, valor: '60.00', data_vencimento: lembreteISO, estado: 'pendente', fracao: { designacao: 'A-1' } },
    { id: 2, condominio_id: 2, fracao_id: 201, ano: 2026, mes: 9, valor: '42.75', data_vencimento: lembreteISO, estado: 'pendente', fracao: { designacao: 'B-1' } },
  ];

  const filtrosQuota = [];
  const chamadasDest = []; // { selecao, condominioId }
  const enfileirados = []; // { destinatario_email, condominioId }

  // Mapa fração → condomínio e destinatários distintos por condomínio: se o job
  // perdesse o âmbito, o contacto de B apareceria no aviso de A.
  const FRACAO_COND = { 101: 1, 201: 2 };
  const DESTINATARIOS = {
    1: [{ pessoa_id: 11, email: 'a@exemplo.pt', nome: 'Titular A' }],
    2: [{ pessoa_id: 22, email: 'b@exemplo.pt', nome: 'Titular B' }],
  };

  const fakeModels = {
    Configuracao: { async findOne() { return null; } },
    Condominio: { async findAll() { return [{ id: 1 }, { id: 2 }]; } },
    Fracao: {},
    Quota: {
      async findAll({ where }) {
        filtrosQuota.push(where);
        return QUOTAS.filter((q) => !where.condominio_id || where.condominio_id[require('sequelize').Op.in].includes(Number(q.condominio_id)));
      },
    },
    // O job consulta o MARCADOR de envio na fila (uma linha por quota+assunto já
    // despachada) — o duplo tem de modelar o que o código usa, senão o teste
    // falha por uma dependência em falta e não pelo que quer provar. Vazio =
    // nada despachado, que é o cenário deste teste (ambas as quotas entram).
    EmailFila: { async findAll() { return []; } },
  };

  require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [], exports: fakeModels };
  require.cache[require.resolve(path.join(RAIZ, 'helpers', 'avisos'))] = {
    id: 'avisos', filename: 'avisos', loaded: true, children: [], paths: [],
    exports: {
      async resolverDestinatarios(selecao, condominioId) {
        chamadasDest.push({ selecao, condominioId });
        // Só devolve destinatários do condomínio pedido (como o helper real).
        return condominioId ? (DESTINATARIOS[Number(condominioId)] || []) : Object.values(DESTINATARIOS).flat();
      },
    },
  };
  require.cache[require.resolve(path.join(RAIZ, 'helpers', 'email-fila'))] = {
    id: 'fila', filename: 'fila', loaded: true, children: [], paths: [],
    exports: { async enfileirarEmail(payload) { enfileirados.push(payload); return payload; } },
  };
  require.cache[require.resolve(path.join(RAIZ, 'helpers', 'notificacoes'))] = {
    id: 'notif', filename: 'notif', loaded: true, children: [], paths: [],
    exports: { async estaAtivo() { return true; } },
  };

  const jobPath = require.resolve(path.join(RAIZ, 'jobs', 'automatizacao'));
  delete require.cache[jobPath];
  const job = require('../jobs/automatizacao');

  let resultado;
  try {
    resultado = await job.enviarLembretesAutomaticos();
  } finally {
    if (origModels) require.cache[modelsPath] = origModels; else delete require.cache[modelsPath];
    if (origAvisos) require.cache[require.resolve(path.join(RAIZ, 'helpers', 'avisos'))] = origAvisos;
    if (origFila) require.cache[require.resolve(path.join(RAIZ, 'helpers', 'email-fila'))] = origFila;
    if (origNotif) require.cache[require.resolve(path.join(RAIZ, 'helpers', 'notificacoes'))] = origNotif;
    delete require.cache[jobPath];
  }

  // (a) A consulta de quotas já vem limitada aos condomínios ativos (a 3.ª
  //     quota de um condomínio inativo nunca chega a ser considerada).
  assert.strictEqual(filtrosQuota.length, 1, 'uma única consulta de quotas');
  assert.ok(filtrosQuota[0].condominio_id, 'a consulta de quotas é limitada por condominio_id (nunca global)');

  // (b) Cada destinatário foi resolvido com o condomínio DA PRÓPRIA quota.
  assert.strictEqual(chamadasDest.length, 2, 'destinatários resolvidos para as duas quotas');
  for (const { selecao, condominioId } of chamadasDest) {
    const fracaoId = Number(selecao.fracoes[0]);
    assert.ok(condominioId, `destinatários da fração ${fracaoId}: âmbito explícito (nunca desligado)`);
    assert.strictEqual(
      Number(condominioId), FRACAO_COND[fracaoId],
      `destinatários da fração ${fracaoId} resolvidos no seu condomínio (${FRACAO_COND[fracaoId]})`
    );
  }

  // (c) Cada email vai para um contacto do condomínio certo E é persistido no
  //     condomínio certo — nenhum aviso de A é enviado a um contacto de B.
  assert.strictEqual(enfileirados.length, 2, 'dois emails enfileirados');
  const emailDeA = enfileirados.find((e) => Number(e.condominioId) === 1);
  const emailDeB = enfileirados.find((e) => Number(e.condominioId) === 2);
  assert.strictEqual(emailDeA.destinatario_email, 'a@exemplo.pt', 'o aviso de A vai para o titular de A');
  assert.strictEqual(emailDeB.destinatario_email, 'b@exemplo.pt', 'o aviso de B vai para o titular de B');
  assert.ok(
    enfileirados.every((e) => e.destinatario_email !== 'b@exemplo.pt' || Number(e.condominioId) === 2),
    'nenhum destinatário de B é usado fora do condomínio B'
  );

  // (d) O email fica ligado à quota (relação segura), para o envio derivar o
  //     condomínio do registo — nunca do assunto nem do nome.
  for (const e of enfileirados) {
    assert.strictEqual(e.entidade_tipo, 'Quota', 'o email fica ligado à quota');
    assert.ok(e.condominioId, 'a fila recebe o condominioId (o remetente é o condomínio certo)');
  }

  // (e) O total reportado corresponde ao que foi efetivamente enfileirado.
  assert.strictEqual(resultado.enviados, enfileirados.length, 'o total enviado conta só o que foi enfileirado');
  assert.strictEqual(resultado.alvos, 2, 'dois alvos considerados (só de condomínios ativos)');
  console.log('  ✓ lembretes: destinatários e remetente sempre do condomínio da própria quota');
}

// ── 9. Invariantes de código (não pode reaparecer chamada sem âmbito) ──
function testeInvariantesDeCodigo() {
  const helper = ler('helpers/quotas-config.js');
  // O helper não lê sessão nem pedido: o âmbito recebe-se por parâmetro.
  assert.ok(/async function getQuotaConfig\(condominioId\)/.test(helper), 'getQuotaConfig recebe o condomínio');
  assert.ok(/async function setQuotaConfig\(condominioId, \{/.test(helper), 'setQuotaConfig recebe o condomínio');
  assert.ok(!/req\.|session/.test(helper.replace(/\/\/.*$/gm, '')), 'o helper não lê sessão nem pedido HTTP');
  assert.ok(/quota_valor_1000:c\$\{id\}|chaveDoCondominio/.test(helper), 'as chaves têm sufixo de condomínio');

  // Os consumidores ativos passam sempre o condomínio ativo/em processamento.
  const consumidores = {
    'routes/orcamento.js': /getQuotaConfig\(req\.condominioId\)/,
    'routes/quotas-modulo.js': /getQuotaConfig\(cid\)/,
    'jobs/automatizacao.js': /getQuotaConfig\(condominioId\)/,
  };
  for (const [ficheiro, padrao] of Object.entries(consumidores)) {
    assert.ok(padrao.test(ler(ficheiro)), `${ficheiro}: passa o condomínio a getQuotaConfig`);
    assert.ok(!/getQuotaConfig\(\)/.test(ler(ficheiro)), `${ficheiro}: sem chamada a getQuotaConfig() sem âmbito`);
    assert.ok(!/setQuotaConfig\(\{/.test(ler(ficheiro)), `${ficheiro}: sem setQuotaConfig({...}) sem âmbito`);
  }

  // `routes/financeiro.js` tem 4 chamadas ATIVAS com âmbito. A antiga chamada
  // sem âmbito da rota sombreada (`GET /quotas` em financeiro.js, servida na
  // verdade por quotas-modulo.js) foi ELIMINADA: mesmo sendo código morto por
  // sombreamento, ficava à espera de que uma reordenação da montagem a
  // reativasse com o default global em vez do condomínio ativo.
  const financeiro = ler('routes/financeiro.js');
  assert.strictEqual(
    (financeiro.match(/getQuotaConfig\(req\.condominioId\)/g) || []).length, 4,
    'financeiro: 4 leituras ativas com condomínio ativo'
  );
  assert.strictEqual(
    (financeiro.match(/setQuotaConfig\(req\.condominioId,/g) || []).length, 1,
    'financeiro: gravação com condomínio ativo'
  );
  assert.strictEqual(
    (financeiro.match(/getQuotaConfig\(\)/g) || []).length, 0,
    'financeiro: NENHUMA chamada sem âmbito — a do código morto E3 foi corrigida, não reativada'
  );

  // O job nunca aplica uma configuração global nem consulta frações sem âmbito.
  const job = ler('jobs/automatizacao.js');
  assert.ok(!/getQuotaConfig\(\)/.test(job), 'job: nunca lê configuração sem condomínio');
  assert.ok(/condominio_id: condominioId/.test(job), 'job: filtra por condominio_id');
  assert.ok(/resolverDestinatarios\(\s*\{ modo: 'fracoes'[\s\S]{0,80}\},\s*condominioId\s*\)/.test(job),
    'job: resolve destinatários com o condomínio da quota');

  // A geração continua idempotente (chave fração+ano+mês+condomínio).
  assert.ok(/where: \{ fracao_id: f\.id, ano, mes, condominio_id: condominioId \}/.test(job),
    'job: a verificação de duplicados inclui o condomínio');
  console.log('  ✓ invariantes: nenhum consumidor chama a configuração sem âmbito (incl. o código morto E3, agora corrigido)');
}

(async () => {
  await testeADiferenteDeB();
  await testeEscritaNaoContamina();
  await testeFallbackGlobal();
  await testeFallbackDefault();
  await testePrecedencia();
  await testeCompatibilidade();
  await testeGeracaoAutomaticaIsolada();
  await testeLembretesIsolados();
  testeInvariantesDeCodigo();
  console.log('✓ Testes de isolamento das quotas/jobs passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
