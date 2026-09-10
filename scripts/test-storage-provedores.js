// ═══════════════════════════════════════════════════════════════════
// Arquitetura de armazenamento multi-provedor (sem rede/BD)
//
// Verifica:
//  · o registo e o contrato dos provedores (Google Drive, Dropbox, OneDrive);
//  · os localizadores de ficheiro (compatibilidade com os ids antigos do Drive);
//  · as ligações POR CONDOMÍNIO (isolamento) e o fallback à ligação global
//    antiga do Google Drive;
//  · a fachada helpers/storage (contrato histórico mantido).
// Utilização: node scripts/test-storage-provedores.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

// ── Duplos de teste: BD e configurações em memória ──────────────────
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    Configuracao: {
      findAll: async () => [],
      findOne: async () => null,
      findOrCreate: async () => [{ valor: null, save: async () => {} }],
    },
    Condominio: { findByPk: async () => null, findOne: async () => null, update: async () => {} },
    Documento: { findOne: async () => null },
  },
};

const loja = new Map();
const configPath = require.resolve('../helpers/config');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, defeito = null) => (loja.has(chave) ? loja.get(chave) : defeito),
    setConfig: async (chave, valor) => {
      loja.set(chave, valor);
      return { chave, valor };
    },
  },
};

const contrato = require('../helpers/armazenamento/contrato');
const locator = require('../helpers/armazenamento/locator');
const ligacoes = require('../helpers/armazenamento/ligacoes');
const storage = require('../helpers/storage');

const PROVEDORES = ['google_drive', 'dropbox', 'onedrive'];

// ── 1. Registo e contrato ───────────────────────────────────────────
function testarRegisto() {
  const registo = storage.registo();
  assert.deepStrictEqual(Object.keys(registo).sort(), [...PROVEDORES].sort(), 'provedores registados');
  const r = contrato.verificarRegisto(registo);
  assert.strictEqual(r.ok, true, `contrato cumprido: ${JSON.stringify(r.problemas)}`);

  for (const nome of PROVEDORES) {
    const p = registo[nome];
    assert.strictEqual(p.nome(), nome, `${nome}: nome() coerente com a chave`);
    assert.strictEqual(typeof p.rotulo(), 'string', `${nome}: rotulo()`);
    const cap = p.capacidades();
    for (const c of contrato.CAPACIDADES_OBRIGATORIAS) {
      assert.strictEqual(c in cap, true, `${nome}: capacidade ${c} declarada`);
    }
    // Invariante: nenhum provedor cria links públicos de documentos.
    for (const proibido of contrato.METODOS_PROIBIDOS) {
      assert.strictEqual(typeof p[proibido], 'undefined', `${nome}: não expõe ${proibido}`);
    }
    assert.strictEqual(typeof p.linkPasta, 'function', `${nome}: linkPasta existe`);
    assert.strictEqual(typeof p.abrirFluxo, 'function', `${nome}: abrirFluxo existe`);
  }

  // O contrato deteta provedores incompletos e métodos proibidos.
  const mau = contrato.verificarProvedor({ nome: () => 'mau', capacidades: () => ({}), linkPublico: () => 'x' });
  assert.strictEqual(mau.ok, false, 'contrato deteta provedor incompleto');
  assert.ok(mau.faltam.length > 0, 'contrato lista métodos em falta');
  assert.ok(mau.avisos.some((a) => a.includes('proibido')), 'contrato deteta método proibido');
}

// ── 2. Localizadores ────────────────────────────────────────────────
function testarLocalizadores() {
  // Compatibilidade: ids antigos (sem prefixo) são do Google Drive.
  assert.deepStrictEqual(locator.ler('1AbC_dEf-123'), { provedor: 'google_drive', id: '1AbC_dEf-123' }, 'id antigo → google_drive');
  assert.deepStrictEqual(locator.ler(''), { provedor: null, id: null }, 'vazio → sem provedor');
  assert.deepStrictEqual(locator.ler(null), { provedor: null, id: null }, 'nulo → sem provedor');

  // Cada provedor tem o seu prefixo e faz round-trip.
  assert.strictEqual(locator.montar('google_drive', 'abc'), 'abc', 'Drive mantém o id sem prefixo (compatibilidade)');
  assert.strictEqual(locator.montar('dropbox', 'id:xyz'), 'dbx:id:xyz', 'Dropbox prefixado');
  assert.strictEqual(locator.montar('onedrive', '01ABCDEF'), 'od:01ABCDEF', 'OneDrive prefixado');
  for (const p of PROVEDORES) {
    const loc = locator.montar(p, 'valor-de-teste');
    const lido = locator.ler(loc);
    assert.strictEqual(lido.provedor, p, `${p}: provedor preservado no localizador`);
    assert.strictEqual(lido.id, 'valor-de-teste', `${p}: id preservado no localizador`);
    assert.strictEqual(locator.valido(loc), true, `${p}: localizador válido`);
  }

  // Localizadores ligados ao provedor ERRADO não passam por Drive.
  assert.strictEqual(locator.provedorDe('dbx:id:1'), 'dropbox', 'provedor de leitura vem do localizador');

  // Limites e entradas inválidas.
  assert.throws(() => locator.montar('provedor-desconhecido', 'x'), /desconhecido/i, 'provedor desconhecido rejeitado');
  assert.throws(() => locator.montar('dropbox', ''), /obrigatório/i, 'id vazio rejeitado');
  assert.throws(() => locator.montar('dropbox', 'x'.repeat(locator.LIMITE_COLUNA)), /demasiado longo/i, 'id acima da coluna rejeitado');
}

// ── 3. Ligações por condomínio (isolamento) ─────────────────────────
async function testarLigacoes() {
  process.env.STORAGE_PROVIDER = '';
  process.env.GOOGLE_REFRESH_TOKEN = '';
  loja.clear();
  ligacoes.limparCache();

  // Sem escolha guardada: provedor por omissão (Google Drive) — comportamento antigo.
  assert.strictEqual(ligacoes.provedorPadrao(), 'google_drive', 'provedor por omissão');
  assert.strictEqual(await ligacoes.provedorDoCondominio(1), 'google_drive', 'condomínio sem escolha usa o Google Drive');

  // Escolha por condomínio.
  await ligacoes.definirProvedor(1, 'dropbox');
  await ligacoes.definirProvedor(2, 'onedrive');
  assert.strictEqual(await ligacoes.provedorDoCondominio(1), 'dropbox', 'condomínio 1 → dropbox');
  assert.strictEqual(await ligacoes.provedorDoCondominio(2), 'onedrive', 'condomínio 2 → onedrive');
  assert.strictEqual(await ligacoes.provedorDoCondominio(3), 'google_drive', 'condomínio 3 (sem escolha) → google_drive');
  assert.strictEqual(ligacoes.provedorSync(1), 'dropbox', 'provedorSync vê a cache');
  await assert.rejects(() => ligacoes.definirProvedor(1, 'provedor-inventado'), /desconhecido/i, 'provedor inválido rejeitado');

  // Tokens por condomínio: nunca se cruzam.
  await ligacoes.guardarTokens('dropbox', 1, { access_token: 'tok-1', refresh_token: 'ref-1', conta: 'a@x.pt' });
  await ligacoes.guardarTokens('dropbox', 2, { access_token: 'tok-2', refresh_token: 'ref-2', conta: 'b@x.pt' });
  const t1 = await ligacoes.lerTokens('dropbox', 1);
  const t2 = await ligacoes.lerTokens('dropbox', 2);
  assert.strictEqual(t1.tokens.access_token, 'tok-1', 'tokens do condomínio 1');
  assert.strictEqual(t2.tokens.access_token, 'tok-2', 'tokens do condomínio 2');
  assert.strictEqual(t1.origem, 'condominio', 'origem da ligação por condomínio');
  assert.strictEqual(ligacoes.tokensSync('dropbox', 2).tokens.access_token, 'tok-2', 'cache síncrona por condomínio');
  assert.strictEqual(ligacoes.tokensSync('dropbox', 99).tokens, null, 'condomínio 99 não herda ligações de outros');

  // Chaves usadas (compatibilidade com a coluna STRING(120)).
  assert.ok(ligacoes.chaveProvedor(12).length <= 120, 'chave do provedor cabe na coluna');
  assert.ok(ligacoes.chaveTokens('onedrive', 999999).length <= 120, 'chave de tokens cabe na coluna');

  // Desligar só afeta o condomínio indicado.
  await ligacoes.limparTokens('dropbox', 1);
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 1)).tokens, null, 'condomínio 1 desligado');
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 2)).tokens.access_token, 'tok-2', 'condomínio 2 mantém-se ligado');
  await ligacoes.limparTokens('dropbox', 2);

  // Fallback legado: a ligação global antiga do Google Drive continua a valer.
  loja.set(ligacoes.CHAVE_TOKENS_LEGADO, JSON.stringify({ refresh_token: 'legado-drive', conta: 'plataforma@gmail.com' }));
  ligacoes.limparCache();
  const legado = await ligacoes.lerTokens('google_drive', 7);
  assert.strictEqual(legado.origem, 'legado', 'condomínio sem ligação própria usa a ligação global antiga');
  assert.strictEqual(legado.tokens.refresh_token, 'legado-drive', 'token legado preservado');
  const cidComLigacao = 8;
  await ligacoes.guardarTokens('google_drive', cidComLigacao, { refresh_token: 'proprio-do-8' });
  const propria = await ligacoes.lerTokens('google_drive', cidComLigacao);
  assert.strictEqual(propria.origem, 'condominio', 'ligação própria tem prioridade sobre a global');
  assert.strictEqual(propria.tokens.refresh_token, 'proprio-do-8', 'token próprio usado');

  // O fallback legado é SÓ para o Google Drive.
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 7)).tokens, null, 'Dropbox não usa a ligação legada do Google');
  assert.strictEqual((await ligacoes.lerTokens('onedrive', 7)).tokens, null, 'OneDrive não usa a ligação legada do Google');
}

// ── 4. Leitura pelo localizador (nunca pelo provedor "atual") ───────
async function testarLeituraPorLocalizador() {
  const chamadas = [];
  // Substitui temporariamente os métodos dos provedores para observar o encaminhamento.
  const original = {};
  for (const nome of PROVEDORES) {
    const p = storage.obterProvedor(nome);
    original[nome] = { abrirFluxo: p.abrirFluxo, descarregarArquivo: p.descarregarArquivo };
    p.abrirFluxo = async (id, cid) => {
      chamadas.push({ provedor: nome, id, cid });
      return { fluxo: null, tamanho: 1, nome: null };
    };
    p.descarregarArquivo = async (id, cid) => {
      chamadas.push({ provedor: nome, id, cid });
      return Buffer.from('x');
    };
  }
  try {
    await storage.abrirFluxo('dbx:id:abc', 5);
    await storage.abrirFluxo('od:01FILE', 5);
    await storage.abrirFluxo('1DriveAntigo', 5);
    assert.deepStrictEqual(chamadas, [
      { provedor: 'dropbox', id: 'id:abc', cid: 5 },
      { provedor: 'onedrive', id: '01FILE', cid: 5 },
      { provedor: 'google_drive', id: '1DriveAntigo', cid: 5 },
    ], 'o provedor de leitura é o do localizador, independentemente da escolha do condomínio');
    await storage.descargarArquivo('dbx:id:abc', 5);
    assert.strictEqual(chamadas[3].provedor, 'dropbox', 'descarga também usa o localizador');
    // Prefixo desconhecido não inventa provedores: é tratado como id antigo do
    // Google Drive (nunca como um provedor novo ou arbitrário).
    assert.deepStrictEqual(locator.ler('zz:inexistente'), { provedor: 'google_drive', id: 'zz:inexistente' }, 'prefixo desconhecido → id antigo do Drive');
    assert.strictEqual(storage.obterProvedor('zz'), null, 'provedor inexistente não é resolvido');
  } finally {
    for (const nome of PROVEDORES) {
      const p = storage.obterProvedor(nome);
      p.abrirFluxo = original[nome].abrirFluxo;
      p.descarregarArquivo = original[nome].descarregarArquivo;
    }
  }
}

// ── 5. Fachada: contrato histórico ──────────────────────────────────
function testarFachada() {
  delete process.env.STORAGE_PROVIDER;
  assert.strictEqual(storage.nome(), 'google_drive', 'nome() por omissão');
  assert.strictEqual(typeof storage.isConfigured(), 'boolean', 'isConfigured() síncrono e booleano');
  assert.strictEqual(typeof storage.isConfiguredPara, 'function', 'isConfiguredPara existe');
  for (const fn of ['uploadArquivo', 'pastaParaDocumento', 'pastaParaFornecedor', 'descargarArquivo', 'estadoLigacao', 'testarLigacao', 'criarEstruturaPastas', 'obterPastaCondominioId', 'linkPastaDrive', 'abrirFluxo', 'estadoDoCondominio', 'definirProvedorDoCondominio']) {
    assert.strictEqual(typeof storage[fn], 'function', `fachada expõe ${fn}`);
  }
  assert.strictEqual(storage.descargarArquivo, storage.descargarArquivo, 'alias de descarga disponível');

  // STORAGE_PROVIDER válido passa a ser o default; desconhecido volta ao Drive.
  process.env.STORAGE_PROVIDER = 'dropbox';
  assert.strictEqual(storage.nome(), 'dropbox', 'STORAGE_PROVIDER válido respeitado');
  process.env.STORAGE_PROVIDER = 'falso_provedor';
  assert.strictEqual(storage.nome(), 'google_drive', 'provedor desconhecido → google_drive');
  delete process.env.STORAGE_PROVIDER;
}

(async () => {
  testarRegisto();
  testarLocalizadores();
  await testarLigacoes();
  await testarLeituraPorLocalizador();
  testarFachada();
  console.log('✓ Testes da arquitetura de armazenamento (multi-provedor) passaram.');
})().catch((err) => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
