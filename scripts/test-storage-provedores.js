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

// Chave de cifragem de teste (as credenciais passaram a ser cifradas em repouso):
// gerada aleatoriamente em cada execução — nunca é uma credencial real.
process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
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

  // Registos antigos que guardaram o LINK em vez do id: o identificador é
  // extraído do link (sem isto o fornecedor responde "não encontrado" e o
  // documento aparece como 502 na interface).
  const ID = '1AbCdEfGhIjKlMnOp';
  const comLink = {
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`]: ID,
    [`https://drive.google.com/open?id=${ID}`]: ID,
    [`https://docs.google.com/document/d/${ID}/edit`]: ID,
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`]: ID,
    [`https://drive.google.com/drive/folders/${ID}`]: ID,
    [`gd:https://drive.google.com/file/d/${ID}/view`]: ID,
  };
  for (const [link, esperado] of Object.entries(comLink)) {
    assert.strictEqual(locator.ler(link).id, esperado, `id extraído do link (${link.slice(0, 40)}…)`);
    assert.strictEqual(locator.ler(link).provedor, 'google_drive', 'link do Drive lido como Google Drive');
  }
  // Um id normal nunca é tocado, e um link de outro fornecedor não é inventado.
  assert.strictEqual(locator.idDeLink('1AbCdEfGhIjKlMnOp'), '1AbCdEfGhIjKlMnOp', 'id normal inalterado');
  assert.strictEqual(locator.ler('dbx:https://www.dropbox.com/scl/fi/xyz/doc.pdf').id, 'https://www.dropbox.com/scl/fi/xyz/doc.pdf', 'link do Dropbox mantido (id opaco da API)');
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

  // Fallback à ligação de PLATAFORMA: a conta global do Google Drive (chave
  // histórica) continua a valer para os condomínios sem conta própria.
  loja.set(ligacoes.CHAVE_TOKENS_LEGADO, JSON.stringify({ refresh_token: 'legado-drive', conta: 'plataforma@gmail.com' }));
  ligacoes.limparCache();
  const legado = await ligacoes.lerTokens('google_drive', 7);
  assert.strictEqual(legado.origem, 'plataforma_fallback', 'condomínio sem ligação própria usa a ligação da plataforma');
  assert.strictEqual(legado.tokens.refresh_token, 'legado-drive', 'token da plataforma preservado');
  const cidComLigacao = 8;
  await ligacoes.guardarTokens('google_drive', cidComLigacao, { refresh_token: 'proprio-do-8' });
  const propria = await ligacoes.lerTokens('google_drive', cidComLigacao);
  assert.strictEqual(propria.origem, 'condominio', 'ligação própria tem prioridade sobre a global');
  assert.strictEqual(propria.tokens.refresh_token, 'proprio-do-8', 'token próprio usado');

  // O fallback legado é SÓ para o Google Drive.
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 7)).tokens, null, 'Dropbox não usa a ligação legada do Google');
  assert.strictEqual((await ligacoes.lerTokens('onedrive', 7)).tokens, null, 'OneDrive não usa a ligação legada do Google');
}

// ── 4. Armazenamento principal: um só, por condomínio ───────────────
async function testarPrincipal() {
  loja.clear();
  ligacoes.limparCache();
  process.env.STORAGE_PROVIDER = '';
  // Credenciais técnicas da instalação (no Google Drive são variáveis de
  // ambiente globais — não são configuração por condomínio).
  const envAntes = {
    GOOGLE_DRIVE_ENABLED: process.env.GOOGLE_DRIVE_ENABLED,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    ONEDRIVE_ENABLED: process.env.ONEDRIVE_ENABLED,
    ONEDRIVE_CLIENT_ID: process.env.ONEDRIVE_CLIENT_ID,
    ONEDRIVE_CLIENT_SECRET: process.env.ONEDRIVE_CLIENT_SECRET,
    DROPBOX_ENABLED: process.env.DROPBOX_ENABLED,
    DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
  };
  process.env.GOOGLE_DRIVE_ENABLED = 'true';
  process.env.GOOGLE_CLIENT_ID = 'cliente-teste';
  process.env.GOOGLE_CLIENT_SECRET = 'segredo-teste';
  process.env.ONEDRIVE_ENABLED = 'true';
  process.env.ONEDRIVE_CLIENT_ID = 'cliente-teste';
  process.env.ONEDRIVE_CLIENT_SECRET = 'segredo-teste';
  process.env.DROPBOX_ENABLED = 'true';
  process.env.DROPBOX_APP_KEY = 'chave-teste';
  process.env.DROPBOX_APP_SECRET = 'segredo-teste';

  // Vários serviços ligados ao mesmo tempo, mas um único principal.
  await ligacoes.definirPrincipal(1, 'google_drive');
  await ligacoes.guardarTokens('google_drive', 1, { refresh_token: 'gd-1' });
  await ligacoes.guardarTokens('dropbox', 1, { refresh_token: 'dbx-1' });
  assert.strictEqual(await storage.nomePrincipalDoCondominio(1), 'google_drive', 'principal do condomínio 1');
  assert.strictEqual(storage.isConfigured(1), true, 'serviço principal ligado');
  // Escolher o Dropbox como principal não desliga o Google Drive.
  await ligacoes.definirPrincipal(1, 'dropbox');
  assert.strictEqual(await storage.nomePrincipalDoCondominio(1), 'dropbox', 'principal passou a Dropbox');
  assert.strictEqual((await ligacoes.lerTokens('google_drive', 1)).tokens.refresh_token, 'gd-1', 'ligação anterior mantida');

  // A escolha é por condomínio (isolamento).
  await ligacoes.definirPrincipal(2, 'onedrive');
  await ligacoes.guardarTokens('onedrive', 2, { refresh_token: 'od-2' });
  assert.strictEqual(await storage.nomePrincipalDoCondominio(2), 'onedrive', 'principal do condomínio 2');
  assert.strictEqual(await storage.nomePrincipalDoCondominio(1), 'dropbox', 'condomínio 1 não foi afetado');
  assert.strictEqual(await storage.nomePrincipalDoCondominio(3), 'google_drive', 'condomínio sem escolha usa o serviço por omissão');

  // Chave antiga (`storage:provedor:c<id>`) continua a ser lida (compatibilidade).
  loja.delete(ligacoes.chavePrincipal(9));
  loja.set(ligacoes.chaveProvedor(9), 'onedrive');
  ligacoes.limparCache();
  assert.strictEqual(await storage.nomePrincipalDoCondominio(9), 'onedrive', 'chave antiga do provedor continua a valer');
  // Recarrega a cache de tokens do condomínio 2 (limparCache acima esvaziou-a).
  await ligacoes.lerTokens('onedrive', 2);

  // Escritas usam o principal; leituras usam o localizador.
  const chamadas = [];
  const originais = {};
  for (const nome of PROVEDORES) {
    const p = storage.obterProvedor(nome);
    originais[nome] = { uploadArquivo: p.uploadArquivo, pastaParaDocumento: p.pastaParaDocumento };
    p.uploadArquivo = async (opcoes) => {
      chamadas.push(['upload', nome, opcoes.condominioId]);
      // O adaptador devolve o id em BRUTO (é a fachada que acrescenta o prefixo).
      return { provedorFileId: 'x', localizador: 'x', tamanho: 1, pastaId: 'p' };
    };
    p.pastaParaDocumento = async (tipo, ano, cid) => {
      chamadas.push(['pasta', nome, cid]);
      return 'pasta-do-provedor';
    };
  }
  try {
    await storage.pastaParaDocumento('recibo', 2026, 2);
    const up = await storage.uploadArquivo({ nome: 'r.pdf', buffer: Buffer.from('x'), parentFolderId: 'pasta-do-provedor', condominioId: 2 });
    assert.deepStrictEqual(chamadas, [['pasta', 'onedrive', 2], ['upload', 'onedrive', 2]], 'escritas vão para o armazenamento principal do condomínio');
    // O localizador devolvido pela FACHADA tem de trazer o prefixo do provedor:
    // sem ele, um ficheiro guardado fora do Drive seria lido como se fosse Drive.
    assert.strictEqual(up.localizador, 'od:x', 'fachada devolve o localizador com prefixo do provedor');
    assert.strictEqual(locator.ler(up.localizador).provedor, 'onedrive', 'localizador identifica o provedor correto');
    assert.strictEqual(locator.ler(up.localizador).id, 'x', 'id do provedor preservado');
  } finally {
    for (const nome of PROVEDORES) {
      const p = storage.obterProvedor(nome);
      p.uploadArquivo = originais[nome].uploadArquivo;
      p.pastaParaDocumento = originais[nome].pastaParaDocumento;
    }
  }

  // Serviço principal desligado: a escrita falha com mensagem clara (nunca
  // grava no serviço errado).
  await ligacoes.limparTokens('onedrive', 2);
  await assert.rejects(
    () => storage.uploadArquivo({ nome: 'r.pdf', buffer: Buffer.from('x'), condominioId: 2 }),
    /não está ligado/i,
    'sem ligação no principal, o upload é recusado'
  );

  for (const [k, v] of Object.entries(envAntes)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── 5. Backups: destino separado, com ligação de plataforma ─────────
async function testarBackups() {
  loja.clear();
  ligacoes.limparCache();

  // Sem configuração: segue o comportamento antigo (Drive da plataforma).
  loja.set(ligacoes.CHAVE_TOKENS_LEGADO, JSON.stringify({ refresh_token: 'plataforma-drive' }));
  ligacoes.limparCache();
  await ligacoes.inicializar();
  assert.strictEqual(await storage.destinoDeBackup(), 'google_drive', 'sem escolha, destino por omissão é o Drive da plataforma');

  // Destino diferente do armazenamento dos documentos.
  await ligacoes.definirPrincipal(4, 'google_drive');
  await ligacoes.guardarTokens('dropbox', null, { refresh_token: 'plataforma-dropbox' }); // ligação de PLATAFORMA
  await ligacoes.guardarTokens('dropbox', 4, { refresh_token: 'conta-do-condominio-4' }); // ligação do condomínio
  ligacoes.limparCache();
  await ligacoes.inicializar();

  await storage.definirDestinoDeBackup('dropbox');
  assert.strictEqual(await storage.destinoDeBackup(), 'dropbox', 'backups num serviço diferente dos documentos');
  assert.strictEqual(await storage.nomePrincipalDoCondominio(4), 'google_drive', 'documentos continuam no principal');

  // Os tokens de plataforma são distintos dos do condomínio.
  assert.strictEqual((await ligacoes.lerTokens('dropbox', null, { plataforma: true })).tokens.refresh_token, 'plataforma-dropbox', 'tokens de plataforma isolados');
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 4)).tokens.refresh_token, 'conta-do-condominio-4', 'tokens do condomínio isolados');
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 5)).tokens, null, 'condomínio sem conta Dropbox não usa a conta de plataforma nem a de outro condomínio');

  // Chaves de plataforma: o Drive mantém a chave histórica; os outros têm a sua.
  assert.strictEqual(ligacoes.chaveTokensPlataforma('google_drive'), 'google_drive_tokens', 'chave histórica do Drive preservada');
  assert.strictEqual(ligacoes.chaveTokensPlataforma('dropbox'), 'storage:tokens:dropbox:plataforma', 'chave de plataforma do Dropbox');
  assert.strictEqual(ligacoes.chaveTokensPlataforma('dropbox'), ligacoes.chaveTokensPlataforma('dropbox'), 'chave de plataforma estável');

  // A pasta de backups existe em todos os provedores.
  for (const nome of PROVEDORES) {
    assert.strictEqual(typeof storage.obterProvedor(nome).pastaDeBackups, 'function', `${nome}: pasta de backups disponível`);
  }

  // Sem destino configurado → backups locais.
  await storage.definirDestinoDeBackup(null);
  loja.set('drive_auto_backups', '0');
  ligacoes.limparCache();
  assert.strictEqual(await storage.destinoDeBackup(), null, 'destino desligado → backups locais');
}

// ── 6. Estado para a interface (mensagem amigável) ──────────────────
async function testarEstadoInterface() {
  loja.clear();
  ligacoes.limparCache();
  ligacoes.limparCache();
  process.env.GOOGLE_DRIVE_ENABLED = 'false';
  const estado = await storage.estadoDoCondominio(3);
  assert.strictEqual(estado.provedores.length, PROVEDORES.length, 'um cartão por serviço');
  for (const p of estado.provedores) {
    assert.strictEqual(typeof p.disponivel, 'boolean', `${p.nome}: disponibilidade declarada à interface`);
    assert.strictEqual(typeof p.ligado, 'boolean', `${p.nome}: estado ligado`);
    assert.strictEqual(typeof p.principal, 'boolean', `${p.nome}: principal`);
  }
  assert.strictEqual(estado.provedores.filter((p) => p.principal).length, 1, 'exatamente um serviço principal');
  assert.ok('destino' in estado.backup, 'estado dos backups presente');
  assert.strictEqual(estado.provedores.find((p) => p.nome === 'google_drive').disponivel, false, 'sem credenciais → não disponível');
  delete process.env.GOOGLE_DRIVE_ENABLED;
}

// ── 8. Âmbito de plataforma (backups): ligar e desligar ─────────────
// Regressão: a rota de "Desligar (plataforma)" não passava o âmbito e a
// ligação de backups ficava sempre como ligada.
async function testarAmbitoPlataforma() {
  loja.clear();
  ligacoes.limparCache();
  const fetchReal = global.fetch;
  // Sem rede nos testes: a revogação/renovação é melhor esforço e é ignorada.
  global.fetch = async () => { throw new Error('rede desativada nos testes'); };
  try {
    const dropbox = storage.obterProvedor('dropbox');
    const chavePlataforma = ligacoes.chaveTokensPlataforma('dropbox');

    await ligacoes.guardarTokens('dropbox', null, { refresh_token: 'plataforma-tok', conta: 'backups@exemplo.pt' });
    assert.strictEqual((await ligacoes.lerTokens('dropbox', null, { plataforma: true })).tokens.refresh_token, 'plataforma-tok', 'ligação de plataforma guardada');

    // Sem âmbito explícito, desligar sem condomínio NÃO apaga nada (protege a
    // ligação de um condomínio de ser removida por engano).
    await dropbox.desligar(null);
    assert.ok(loja.get(chavePlataforma), 'desligar sem âmbito não apaga a ligação de plataforma');

    // Com o âmbito (o que a rota passa agora), remove os tokens.
    await dropbox.desligar(null, { plataforma: true });
    assert.strictEqual((await ligacoes.lerTokens('dropbox', null, { plataforma: true })).tokens, null, 'desligar com âmbito de plataforma remove os tokens');
    assert.strictEqual(ligacoes.tokensSync('dropbox', null, { plataforma: true }).tokens, null, 'cache sem tokens após desligar');

    await ligacoes.inicializar();
    assert.strictEqual(ligacoes.tokensSync('dropbox', null, { plataforma: true }).tokens, null, 'sem cache obsoleta depois de reinicializar');

    // No âmbito de documentos continua a ser obrigatório o condomínio.
    await assert.rejects(
      () => dropbox.trocarCodigo({ code: 'x', redirectUri: 'https://exemplo.pt/cb' }),
      /condominioId é obrigatório/i,
      'ligação de documentos exige condomínio'
    );
  } finally {
    global.fetch = fetchReal;
  }
}

// ── 8.1 Âmbito no Google Drive: a ligação do condomínio e a da plataforma ──
// Regressão grave: drive.desligar() não recebia âmbito nenhum — apagava sempre a
// ligação da PLATAFORMA (a dos backups). No cartão de um condomínio com conta
// própria, "Desligar" não removia nada (a página continuava a mostrar
// "Ligado ✓") e ainda derrubava a ligação usada por todos os condomínios.
async function testarAmbitoPlataformaDrive() {
  loja.clear();
  ligacoes.limparCache();
  const amb = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,
  };
  // Sem credenciais OAuth a revogação no Google é ignorada: o teste fica offline
  // e verifica apenas QUAL das ligações é removida.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  try {
    const driveProv = storage.obterProvedor('google_drive');
    const chaveCondominio = ligacoes.chaveTokens('google_drive', 7);
    const chavePlataforma = ligacoes.chaveTokensPlataforma('google_drive');

    await ligacoes.guardarTokens('google_drive', null, { refresh_token: 'plataforma-tok', conta: 'plataforma@gmail.com' });
    await ligacoes.guardarTokens('google_drive', 7, { refresh_token: 'condominio-tok', conta: 'condominio@gmail.com' });

    // Desligar a conta de um condomínio remove só a ligação desse condomínio.
    await driveProv.desligar(7);
    assert.strictEqual(loja.get(chaveCondominio), null, 'Drive: ligação do condomínio removida');
    assert.ok(loja.get(chavePlataforma), 'Drive: ligação da plataforma preservada ao desligar um condomínio');

    // Desligar a plataforma exige âmbito explícito (protege os backups).
    await assert.rejects(
      () => driveProv.desligar(null),
      /condominioId é obrigatório/i,
      'Drive: sem âmbito não desliga a ligação da instalação'
    );
    assert.ok(loja.get(chavePlataforma), 'Drive: ligação da plataforma intacta após tentativa sem âmbito');

    await driveProv.desligar(null, { plataforma: true });
    assert.strictEqual(loja.get(chavePlataforma), null, 'Drive: ligação da plataforma removida com âmbito explícito');
    assert.strictEqual(ligacoes.tokensSync('google_drive', null, { plataforma: true }).tokens, null, 'Drive: cache sem tokens da plataforma');
    await ligacoes.inicializar();
    assert.strictEqual(ligacoes.tokensSync('google_drive', null, { plataforma: true }).tokens, null, 'Drive: sem cache obsoleta depois de reinicializar');
  } finally {
    for (const [k, v] of Object.entries(amb)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── 8.2 Etiqueta técnica dos erros da Dropbox ───────────────────────
// As mensagens da Dropbox têm a forma `path/not_found/...`; o sanitizador de
// mensagens (que esconde caminhos) transformava tudo em `path/…` e a causa
// ficava indistinguível nos registos. A etiqueta preserva a CAUSA sem revelar
// caminhos nem ids.
function testarEtiquetasDropbox() {
  const dropbox = storage.obterProvedor('dropbox');
  assert.strictEqual(typeof dropbox.etiquetaErro, 'function', 'Dropbox expõe a etiqueta de erro (diagnóstico)');
  const casos = {
    'path/not_found/..': 'path/not_found',
    'path/not_file/..': 'path/not_file',
    'path/no_permission/..': 'path/no_permission',
    'invalid_access_token/': 'invalid_access_token',
    'too_many_write_operations/..': 'too_many_write_operations',
  };
  for (const [resumo, esperado] of Object.entries(casos)) {
    assert.strictEqual(
      dropbox.etiquetaErro({ dados: { error_summary: resumo } }),
      esperado,
      `etiqueta extraída de "${resumo}"`
    );
  }
  // Um caminho real da conta NUNCA é devolvido como etiqueta (privacidade).
  assert.strictEqual(dropbox.etiquetaErro({ dados: { error_summary: '/Apps/GesCondu/Recibos 2026/r.pdf' } }), null, 'caminho real não é etiqueta');
  assert.strictEqual(dropbox.etiquetaErro({ dados: {} }), null, 'sem resumo → sem etiqueta');
  assert.strictEqual(dropbox.etiquetaErro(null), null, 'sem resposta → sem etiqueta');
}

// ── 9. URL de autorização: pede sempre a escolha da conta ───────────
function testarUrlAutorizacao() {
  const envAntes = {
    DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
    ONEDRIVE_CLIENT_ID: process.env.ONEDRIVE_CLIENT_ID,
    ONEDRIVE_CLIENT_SECRET: process.env.ONEDRIVE_CLIENT_SECRET,
  };
  process.env.DROPBOX_APP_KEY = 'chave-teste';
  process.env.DROPBOX_APP_SECRET = 'segredo-teste';
  process.env.ONEDRIVE_CLIENT_ID = 'cliente-teste';
  process.env.ONEDRIVE_CLIENT_SECRET = 'segredo-teste';
  try {
    const dropbox = storage.obterProvedor('dropbox');
    const urlDropbox = dropbox.urlAutorizacao({ redirectUri: 'https://exemplo.pt/cb', state: 'abc', condominioId: 1 });
    assert.ok(urlDropbox.includes('force_reauthenticate=true'), 'Dropbox pede reautenticação/escolha da conta');
    assert.ok(urlDropbox.includes('token_access_type=offline'), 'Dropbox mantém o refresh token (offline)');
    assert.ok(urlDropbox.includes('state=abc'), 'Dropbox mantém o state');

    const onedrive = storage.obterProvedor('onedrive');
    const urlOneDrive = onedrive.urlAutorizacao({ redirectUri: 'https://exemplo.pt/cb', state: 'abc', condominioId: 1 });
    assert.ok(urlOneDrive.includes('prompt=select_account'), 'OneDrive pede a escolha da conta');
    assert.ok(urlOneDrive.includes('scope=offline_access%20Files.ReadWrite'), 'OneDrive mantém os scopes (espaço como %20)');
    assert.ok(urlOneDrive.includes('response_mode=query'), 'OneDrive mantém response_mode=query');
  } finally {
    for (const [k, v] of Object.entries(envAntes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── 10. Leitura pelo localizador (nunca pelo provedor "atual") ───────
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
  await testarPrincipal();
  await testarBackups();
  await testarEstadoInterface();
  await testarAmbitoPlataforma();
  await testarAmbitoPlataformaDrive();
  testarEtiquetasDropbox();
  testarUrlAutorizacao();
  await testarLeituraPorLocalizador();
  testarFachada();
  console.log('✓ Testes da arquitetura de armazenamento (multi-provedor) passaram.');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
