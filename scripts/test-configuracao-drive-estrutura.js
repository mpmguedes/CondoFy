// ═══════════════════════════════════════════════════════════════════
// `POST /admin/config/drive/estrutura` — ÂMBITO da verificação
//
// Regressão de ISOLAMENTO (armadilha documentada): `isConfigured()` SEM
// condomínio responde pela ligação da **PLATAFORMA** (a conta que serve os
// backups e os condomínios sem conta própria). A árvore de pastas, porém, é
// criada para o CONDOMÍNIO ATIVO. Verificar a plataforma e criar no condomínio
// recusava («Google Drive não está ligado») um condomínio que tem a SUA conta
// Google — só porque a instalação não tinha conta de plataforma.
//
// Este teste monta o router REAL (`routes/configuracao.js`) com duplos de BD e
// substitui `helpers/drive` por um observador que REGISTA com que âmbito a
// rota pergunta. É isso que prova a correção: o argumento tem de ser o id do
// condomínio, não `undefined`.
//
// Utilização: node scripts/test-configuracao-drive-estrutura.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');

const RAIZ = path.join(__dirname, '..');
const CONDOMINIO_ATIVO = 7;

// Última mensagem `req.flash(tipo, msg)` emitida pela rota.
let ULTIMO_FLASH = null;

// ── Observador: o que a rota pediu e o que criou ────────────────────
const perguntasIsConfigured = []; // argumentos passados a drive.isConfigured
const estruturasCriadas = []; // argumentos passados a criarEstruturaPastas
// Estado simulado: o condomínio TEM conta Google; a plataforma NÃO tem.
// (É exatamente o cenário que o defeito recusava.)
let ligadoParaOcondominio = true;

const stubs = {
  '../models': {
    Condominio: { findByPk: async () => ({ id: CONDOMINIO_ATIVO }), findAll: async () => [] },
    BackupLog: { findAll: async () => [], findOne: async () => null },
    AuditLog: { create: async () => ({}) },
    User: {},
  },
  // Guardas pass-through: este teste é sobre o ÂMBITO da verificação de
  // armazenamento, não sobre autorização (essa tem teste próprio).
  '../helpers/tenant': {
    comCondominioAtivo: (req, res, next) => {
      req.condominioId = CONDOMINIO_ATIVO;
      next();
    },
    comPapel: () => (req, res, next) => next(),
    apenasSuperAdmin: (req, res, next) => next(),
  },
  '../helpers/audit': { audit: async () => ({}) },
  '../helpers/condominio': { getCondominio: async () => ({ id: CONDOMINIO_ATIVO, designacao: 'Alfa' }), clearCondominioCache: () => {} },
  '../helpers/config': {
    getConfig: async (chave, defeito = null) => defeito,
    setConfig: async (chave, valor) => ({ chave, valor }),
  },
  '../helpers/automacoes': { listarAutomacoes: async () => [], guardarAutomacoes: async () => ({}) },
  '../helpers/documentos-por-servico': { contarPorServico: async () => ({}), documentosDoServico: () => 0 },
  '../helpers/mailer': { obterEstadoSmtp: async () => ({ configurado: false }) },
  '../helpers/tips/contexto': { tipsDaPagina: async () => ({ tips: [], dispensa: {} }) },
  '../helpers/storage': {
    obterProvedor: () => null,
    isConfigured: () => false,
    estadoDoCondominio: async () => ({ provedores: [] }),
    destinoDeBackup: async () => null,
    ligacaoDeBackup: () => null,
    definirPrincipalDoCondominio: async () => {},
    inicializar: async () => {},
  },
  // ⛔ O observador. Regista o âmbito de cada pergunta.
  '../helpers/drive': {
    isConfigured: (condominioId) => {
      perguntasIsConfigured.push(condominioId);
      // Ligado apenas quando a pergunta é feita PARA O CONDOMÍNIO.
      return condominioId === CONDOMINIO_ATIVO && ligadoParaOcondominio;
    },
    criarEstruturaPastas: async (condominioId) => {
      estruturasCriadas.push(condominioId);
      return { raizId: 'r', condominioFolderId: 'c', anoId: 'a', subpastas: {}, backupsId: 'b' };
    },
    estadoLigacao: async () => ({ ativo: true, credenciais: true, ligado: ligadoParaOcondominio, viaEnv: false, conta: null }),
    inicializar: async () => {},
    testarLigacao: async () => ({ ok: ligadoParaOcondominio, conta: 'x@exemplo.pt' }),
    obterRedirectUri: () => 'http://127.0.0.1/cb',
    construirUrlAutorizacao: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    trocarCodigo: async () => ({ conta: null }),
    desligar: async () => {},
    obterNomeRaiz: async () => 'GesCondu',
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// ── Aplicação de teste (router REAL) ───────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.user = { id: 1, nome: 'Admin' };
  req.isAuthenticated = () => true;
  // `connect-flash` mínimo: guarda a última mensagem para o teste a poder ler.
  // (O router responde com redirect, pelo que um middleware POSTERIOR já não
  // corre — a captura tem de acontecer aqui.)
  req.flash = (tipo, msg) => {
    if (msg) ULTIMO_FLASH = { tipo, msg };
    return [];
  };
  res.locals.user = req.user;
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.tarefas = { ativas: 0, emErro: 0 };
  next();
});
app.use('/admin', require('../routes/configuracao'));
app.use((err, req, res, next) => res.status(500).send(`ERRO_NO_HANDLER: ${err.message}`));

function pedir(metodo, caminho, corpo = null) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const dados = corpo ? new URLSearchParams(corpo).toString() : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: servidor.address().port,
          path: caminho,
          method: metodo,
          headers: dados ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) } : {},
        },
        (res) => {
          let texto = '';
          res.on('data', (c) => { texto += c; });
          res.on('end', () => {
            servidor.close();
            resolve({ status: res.statusCode, location: res.headers.location || null, texto });
          });
        }
      );
      req.on('error', (e) => { servidor.close(); reject(e); });
      if (dados) req.write(dados);
      req.end();
    });
  });
}

(async () => {
  // 1. O CONDOMÍNIO tem conta Google; a PLATAFORMA não.
  //    A rota tem de criar a estrutura — o defeito recusava-a.
  ULTIMO_FLASH = null;
  perguntasIsConfigured.length = 0;
  estruturasCriadas.length = 0;
  const r1 = await pedir('POST', '/admin/config/drive/estrutura');
  assert.strictEqual(r1.status, 302, 'a rota responde sempre com redirect');
  assert.ok(
    perguntasIsConfigured.includes(CONDOMINIO_ATIVO),
    `a verificação é feita PARA O CONDOMÍNIO ATIVO (${CONDOMINIO_ATIVO}), não para a plataforma`
  );
  assert.ok(
    !perguntasIsConfigured.some((c) => c === undefined || c === null),
    'nenhuma verificação é feita sem condomínio (âmbito da PLATAFORMA)'
  );
  assert.deepStrictEqual(estruturasCriadas, [CONDOMINIO_ATIVO], 'a estrutura é criada para o condomínio ativo');
  assert.ok(!ULTIMO_FLASH || ULTIMO_FLASH.tipo !== 'error_msg', 'não é recusada: o condomínio está ligado');
  console.log('  ✓ a estrutura é criada para um condomínio com conta própria, mesmo sem conta de plataforma');

  // 2. O condomínio NÃO está ligado ⇒ recusa (e nada é criado).
  ligadoParaOcondominio = false;
  ULTIMO_FLASH = null;
  estruturasCriadas.length = 0;
  const r2 = await pedir('POST', '/admin/config/drive/estrutura');
  assert.strictEqual(r2.status, 302);
  assert.deepStrictEqual(estruturasCriadas, [], 'sem ligação não se cria nada');
  assert.ok(ULTIMO_FLASH && ULTIMO_FLASH.tipo === 'error_msg', 'é recusada com uma mensagem de erro');
  assert.ok(/não está ligado/.test(ULTIMO_FLASH.msg), 'a mensagem diz que o Drive não está ligado');
  ligadoParaOcondominio = true;
  console.log('  ✓ sem ligação a rota recusa e não cria pastas');

  console.log('✓ Testes do âmbito de POST /admin/config/drive/estrutura passaram.');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
