// ═══════════════════════════════════════════════════════════════════
// Âmbito das ligações ao Google Drive — sem rede/BD.
//
// Regressão que motivou este teste: o Google Drive é o único provedor com
// ligação de PLATAFORMA (a histórica, usada pelos backups) além das ligações
// por condomínio. Em helpers/drive.js o âmbito era ignorado em vários pontos:
//   · `trocarCodigo` guardava sempre na chave da plataforma (ligar uma conta
//     "deste condomínio" ligava, na verdade, a conta da instalação);
//   · `testarLigacao` testava sempre a conta da plataforma;
//   · `encontrarPastaPorNome`/`criarPasta` usavam sempre a conta da plataforma;
//   · `desligar` apagava sempre a ligação da plataforma (no cartão de um
//     condomínio o "Desligar" não removia nada e ainda derrubava a ligação dos
//     backups);
//   · uma autorização revogada limpava sempre a ligação da plataforma.
//
// Aqui verifica-se, com o cliente `googleapis` substituído por um duplo, que
// cada operação usa — e remove — apenas a ligação do âmbito certo.
// Utilização: node scripts/test-drive-ligacoes.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');

// Chave de cifragem de teste (gerada em cada execução — nunca é uma credencial
// real) e credenciais OAuth fictícias, para que a integração se considere
// configurada.
const crypto = require('crypto');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.GOOGLE_DRIVE_ENABLED = 'true';
process.env.GOOGLE_CLIENT_ID = 'cliente-de-teste';
process.env.GOOGLE_CLIENT_SECRET = 'segredo-de-teste';
process.env.GOOGLE_REDIRECT_URI = 'https://exemplo.pt/admin/config/drive/callback';
delete process.env.GOOGLE_REFRESH_TOKEN;
delete process.env.STORAGE_PROVIDER;

// ── Duplos: BD em memória e configurações em memória ────────────────
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    Configuracao: { findAll: async () => [], findOne: async () => null, findOrCreate: async () => [{ valor: null, save: async () => {} }] },
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

// ── Duplo do googleapis ─────────────────────────────────────────────
// Contas fictícias identificadas pelo refresh token usado em cada chamada.
const CONTAS = {
  'tok-c7': 'condominio7@gmail.com',
  'tok-plataforma': 'plataforma@gmail.com',
  'tok-novo': 'novo@gmail.com',
};
const registo = { chamadas: [], erro: null, revogado: false };

class FalsoOAuth2 {
  constructor() {
    this.creds = {};
  }
  setCredentials(c) {
    this.creds = c || {};
  }
  on() {}
  generateAuthUrl() {
    return 'https://accounts.google.com/o/oauth2/auth?falso=1';
  }
  async getToken() {
    return { tokens: { access_token: 'acesso-novo', refresh_token: 'tok-novo', expiry_date: Date.now() + 3600000 } };
  }
  async revokeToken() {
    registo.revogado = true;
  }
}

function apiFalsa(auth) {
  const usar = () => {
    const refresh = (auth && auth.creds && auth.creds.refresh_token) || null;
    registo.chamadas.push(refresh);
    if (registo.erro) {
      const err = new Error(registo.erro.mensagem || 'falha simulada');
      err.code = registo.erro.codigo || 500;
      throw err;
    }
    return refresh;
  };
  return {
    about: {
      get: async () => ({ data: { user: { emailAddress: CONTAS[usar()] || null } } }),
    },
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async () => ({ data: { id: `pasta-${usar() || 'plataforma'}` } }),
      get: async () => ({ data: [] }),
      delete: async () => ({ data: {} }),
    },
  };
}

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true, children: [], paths: [],
  exports: { google: { auth: { OAuth2: FalsoOAuth2 }, drive: (opcoes) => apiFalsa(opcoes && opcoes.auth) } },
};

const drive = require('../helpers/drive');
const ligacoes = require('../helpers/armazenamento/ligacoes');

const CHAVE_PLATAFORMA = ligacoes.chaveTokensPlataforma('google_drive');
const chaveC = (cid) => ligacoes.chaveTokens('google_drive', cid);

// Cada operação tem de usar a conta do âmbito pedido.
function usou(refresh, mensagem) {
  const ultima = registo.chamadas[registo.chamadas.length - 1];
  assert.strictEqual(ultima, refresh, `${mensagem} (usou ${ultima})`);
}

function limpar() {
  loja.clear();
  ligacoes.limparCache();
  registo.chamadas = [];
  registo.erro = null;
  registo.revogado = false;
  delete process.env.GOOGLE_REFRESH_TOKEN;
}

// ── 1. Operações usam a conta do âmbito ─────────────────────────────
async function testarUsoDaConta() {
  limpar();
  await ligacoes.guardarTokens('google_drive', null, { refresh_token: 'tok-plataforma', conta: CONTAS['tok-plataforma'] });
  await ligacoes.guardarTokens('google_drive', 7, { refresh_token: 'tok-c7', conta: CONTAS['tok-c7'] });

  // Testar a ligação do condomínio 7 usa a conta do condomínio...
  const r7 = await drive.testarLigacao(7);
  assert.strictEqual(r7.ok, true, 'testar a ligação do condomínio funciona');
  assert.strictEqual(r7.conta, CONTAS['tok-c7'], 'testar usa a conta do condomínio');
  usou('tok-c7', 'testar a ligação do condomínio usou a conta errada');

  // ... e a da plataforma usa a conta da instalação.
  const rP = await drive.testarLigacao(null);
  assert.strictEqual(rP.conta, CONTAS['tok-plataforma'], 'testar a ligação da plataforma usa a conta da instalação');
  usou('tok-plataforma', 'testar a ligação da plataforma usou a conta errada');

  // Criar a árvore de pastas de um condomínio usa a conta desse condomínio
  // (antes criava pastas na conta da plataforma).
  await drive.encontrarOuCriarPasta('Backups', null, 7);
  usou('tok-c7', 'pastas do condomínio criadas na conta errada');
  await drive.encontrarOuCriarPasta('Backups', null, null);
  usou('tok-plataforma', 'pastas da plataforma criadas na conta errada');

  // O condomínio sem conta própria usa a ligação da plataforma (fallback,
  // comportamento histórico mantido).
  const r9 = await drive.testarLigacao(9);
  assert.strictEqual(r9.conta, CONTAS['tok-plataforma'], 'condomínio sem conta própria usa a da plataforma');
}

// ── 2. Autorização revogada remove só a ligação usada ───────────────
async function testarRevogacaoPorAmbito() {
  limpar();
  await ligacoes.guardarTokens('google_drive', null, { refresh_token: 'tok-plataforma', conta: CONTAS['tok-plataforma'] });
  await ligacoes.guardarTokens('google_drive', 7, { refresh_token: 'tok-c7', conta: CONTAS['tok-c7'] });
  registo.erro = { codigo: 401, mensagem: 'invalid_grant: token has been expired or revoked' };

  const r7 = await drive.testarLigacao(7);
  assert.strictEqual(r7.ok, false, 'ligação revogada do condomínio falha o teste');
  assert.ok(/revogada|expirou/i.test(r7.erro), 'mensagem explica que a ligação foi revogada');
  assert.strictEqual(loja.get(chaveC(7)), null, 'tokens do condomínio removidos');
  assert.ok(loja.get(CHAVE_PLATAFORMA), 'ligação da plataforma preservada quando só um condomínio foi revogado');

  // Um condomínio que usa a ligação da plataforma: a revogação é da plataforma
  // (é a mesma conta), por isso é essa que passa a "não ligado".
  const r9 = await drive.testarLigacao(9);
  assert.strictEqual(r9.ok, false, 'condomínio com fallback falha quando a plataforma foi revogada');
  assert.strictEqual(loja.get(CHAVE_PLATAFORMA), null, 'ligação da plataforma removida (era a conta usada)');
}

// ── 3. Ligação definida no .env não é removida pela aplicação ───────
async function testarLigacaoAmbiente() {
  limpar();
  process.env.GOOGLE_REFRESH_TOKEN = 'tok-plataforma';
  registo.erro = { codigo: 401, mensagem: 'invalid_grant' };
  const r = await drive.testarLigacao(9);
  assert.strictEqual(r.ok, false, 'ligação do .env revogada falha o teste');
  assert.strictEqual(loja.size, 0, 'nada é apagado quando a ligação vem do .env');
  delete process.env.GOOGLE_REFRESH_TOKEN;
}

// ── 4. Ligar guarda na chave do âmbito pedido ───────────────────────
async function testarLigarPorAmbito() {
  limpar();
  await drive.trocarCodigo({ code: 'codigo', redirectUri: 'https://exemplo.pt/cb', condominioId: 7 });
  assert.ok(loja.get(chaveC(7)), 'ligar com condomínio guarda a conta do condomínio');
  assert.ok(String(loja.get(chaveC(7))).startsWith('enc:v1:'), 'credenciais guardadas cifradas');
  assert.strictEqual(loja.get(CHAVE_PLATAFORMA), undefined, 'ligar com condomínio não toca na ligação da plataforma');

  await drive.trocarCodigo({ code: 'codigo', redirectUri: 'https://exemplo.pt/cb' });
  assert.ok(loja.get(CHAVE_PLATAFORMA), 'ligar sem condomínio guarda a ligação da plataforma (fluxo dos backups)');
}

// ── 5. Desligar respeita o âmbito (e nunca derruba a plataforma) ─────
async function testarDesligarPorAmbito() {
  limpar();
  await ligacoes.guardarTokens('google_drive', null, { refresh_token: 'tok-plataforma', conta: CONTAS['tok-plataforma'] });
  await ligacoes.guardarTokens('google_drive', 7, { refresh_token: 'tok-c7', conta: CONTAS['tok-c7'] });

  await drive.desligar(7);
  assert.strictEqual(loja.get(chaveC(7)), null, 'desligar remove a ligação do condomínio');
  assert.ok(loja.get(CHAVE_PLATAFORMA), 'desligar o condomínio não derruba a ligação da plataforma');

  await assert.rejects(() => drive.desligar(null), /condominioId é obrigatório/i, 'desligar a plataforma exige âmbito explícito');
  assert.ok(loja.get(CHAVE_PLATAFORMA), 'tentativa sem âmbito não remove a ligação da plataforma');

  await drive.desligar(null, { plataforma: true });
  assert.strictEqual(loja.get(CHAVE_PLATAFORMA), null, 'desligar a plataforma com âmbito explícito remove a ligação');
}

(async () => {
  await testarUsoDaConta();
  await testarRevogacaoPorAmbito();
  await testarLigacaoAmbiente();
  await testarLigarPorAmbito();
  await testarDesligarPorAmbito();
  console.log('✓ Testes do âmbito das ligações ao Google Drive (condomínio vs plataforma) passaram.');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
