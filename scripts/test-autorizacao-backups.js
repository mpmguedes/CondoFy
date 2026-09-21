// ═══════════════════════════════════════════════════════════════════
// A6.1 — Autorização das operações de backup da INSTALAÇÃO (P9/P10).
//
// Duas rotas atuam sobre a instalação INTEIRA (o dump contém dados de todos os
// condomínios) e por isso só podem ser usadas por um Super Admin
// (`users.role_global = 'super_admin'`):
//
//   P9  POST /admin/config/armazenamento/backups  (destino global dos backups)
//   P10 POST /admin/sistema/backup                (disparo do backup manual)
//
// Este teste monta os DOIS routers reais num servidor Express e faz pedidos
// HTTP a sério. A guarda usada é a REAL (`helpers/tenant.apenasSuperAdmin`) —
// NÃO é substituída por um duplo, senão estaríamos a testar o duplo. Prova:
//   · Super Admin      → P9 permitido  (e o destino é mesmo gravado);
//   · admin condomínio → P9 recusado   (e NADA é gravado);
//   · Super Admin      → P10 permitido (e o backup é mesmo iniciado);
//   · admin condomínio → P10 recusado  (e NADA é iniciado);
//   · a recusa é feita PELA GUARDA: removida do stack, o mesmo pedido passa a
//     ter efeito — é a prova de que o teste morde (e não um falso verde).
//
// Utilização: node scripts/test-autorizacao-backups.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');

const RAIZ = path.join(__dirname, '..');

// ── Registos dos efeitos secundários (o que NÃO pode acontecer) ────
const gravacoesDestino = []; // storage.definirDestinoDeBackup
const backupsIniciados = []; // jobs/backup.executarBackup

// ── Duplos (só o que precisa de BD/IO) ─────────────────────────────
// `../helpers/tenant` NÃO é substituído: é o módulo real, com a guarda real.
const stubs = {
  '../models': {
    // Associação ATIVA com papel de admin — o mesmo cenário para os dois
    // utilizadores, para que a ÚNICA diferença entre eles seja `role_global`.
    UserCondominio: { findOne: async () => ({ role: 'admin', condominio_id: 1 }) },
    Condominio: { findByPk: async () => ({ id: 1, estado: 'ativo' }), findAll: async () => [] },
    BackupLog: { findOne: async () => null, findAll: async () => [] },
    AuditLog: { findAll: async () => [], create: async () => ({}) },
    User: {},
  },
  '../helpers/audit': { audit: async () => ({}) },
  '../helpers/condominio': {
    getCondominio: async () => ({ id: 1, designacao: 'Condomínio de Teste' }),
    clearCondominioCache: () => {},
  },
  '../helpers/config': { getConfig: async () => null, setConfig: async () => ({}) },
  '../helpers/automacoes': { listarAutomacoes: async () => [], guardarAutomacoes: async () => ({}) },
  '../helpers/drive': {},
  '../helpers/storage': {
    provedores: () => ['google_drive', 'dropbox', 'onedrive'],
    obterProvedor: (nome) => (nome ? { nome, rotulo: () => 'Dropbox', icone: () => 'bi bi-dropbox' } : null),
    ligacaoDeBackup: () => ({ condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' }),
    definirDestinoDeBackup: async (nome) => {
      gravacoesDestino.push(nome === undefined ? null : nome);
      return nome;
    },
    destinoDeBackup: async () => 'dropbox',
    estadoDoCondominio: async () => ({}),
    inicializar: async () => {},
    definirPrincipalDoCondominio: async () => {},
  },
  '../helpers/backup-estado': { interpretar: () => ({}) },
  '../helpers/documentos-por-servico': {
    contarPorServico: async () => ({}),
    documentosDoServico: async () => [],
  },
  '../jobs/backup': {
    executarBackup: async (tipo) => {
      backupsIniciados.push(tipo);
      return { estado: 'concluido' };
    },
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// ── A guarda REAL ──────────────────────────────────────────────────
const tenant = require('../helpers/tenant');

// ── App de teste: os DOIS routers reais, no mesmo prefixo do app.js ─
const routerConfiguracao = require('../routes/configuracao');
const routerSistema = require('../routes/sistema');

const SUPER = { id: 9, nome: 'Super Admin', email: 'super@exemplo.pt', role_global: 'super_admin' };
// `role_global` nulo é o caso REAL de um administrador de condomínio (a coluna
// legado `users.role` não decide nada — é o que o teste abaixo confirma).
const ADMIN = { id: 1, nome: 'Admin de Condomínio', email: 'admin@exemplo.pt', role: 'admin', role_global: null };
let UTILIZADOR = ADMIN;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = UTILIZADOR;
  req.session = { condominio_ativo_id: 1 };
  req.flash = () => req;
  res.locals.user = UTILIZADOR;
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.tarefas = null;
  next();
});
app.use('/admin', routerConfiguracao);
app.use('/admin', routerSistema);
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
          headers: dados
            ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) }
            : {},
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

// ── Estrutura: a guarda está MESMO presa às duas rotas ────────────
function rotaDe(router, caminho) {
  const camada = router.stack.find((l) => l.route && l.route.path === caminho);
  assert.ok(camada, `a rota ${caminho} existe`);
  return camada.route;
}

function verificarGuardaPresa(router, caminho, rotulo) {
  const rota = rotaDe(router, caminho);
  assert.strictEqual(rota.stack.length, 2, `${rotulo}: a rota tem exatamente guarda + handler`);
  assert.strictEqual(
    rota.stack[0].handle,
    tenant.apenasSuperAdmin,
    `${rotulo}: o primeiro handler é a guarda REAL de helpers/tenant (não um duplo)`
  );
  assert.strictEqual(
    rota.stack[0].handle.name,
    'apenasSuperAdmin',
    `${rotulo}: o primeiro handler é a guarda apenasSuperAdmin`
  );
  return rota;
}

// ── A guarda distingue mesmo Super Admin de admin de condomínio? ──
function testeGuardas() {
  assert.strictEqual(tenant.eSuperAdmin({ role_global: 'super_admin' }), true, 'super_admin é Super Admin');
  assert.strictEqual(tenant.eSuperAdmin({ role_global: 'admin' }), false, 'role_global=admin NÃO é Super Admin');
  // A coluna LEGADO `users.role` nunca decide autorização global.
  assert.strictEqual(tenant.eSuperAdmin({ role: 'admin', role_global: null }), false, 'a coluna legado role não promove');
  assert.strictEqual(tenant.eSuperAdmin(null), false, 'sem utilizador não há Super Admin');
  console.log('  ✓ a guarda decide por `role_global` (a coluna legado não promove)');
}

// ── P9 — destino global dos backups ───────────────────────────────
async function testeP9() {
  const rota = verificarGuardaPresa(routerConfiguracao, '/config/armazenamento/backups', 'P9');

  // (a) Admin de CONDOMÍNIO: recusado pela guarda e SEM efeito secundário.
  // O destino '/admin' é o da guarda — `comPapel` redirecionaria para '/', pelo
  // que o destino prova QUAL guarda recusou.
  UTILIZADOR = ADMIN;
  gravacoesDestino.length = 0;
  let r = await pedir('POST', '/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  assert.strictEqual(r.status, 302, 'P9: admin de condomínio é recusado');
  assert.strictEqual(r.location, '/admin', 'P9: recusado pela guarda de Super Admin (e não por outra)');
  assert.deepStrictEqual(gravacoesDestino, [], 'P9: o destino global NÃO é alterado por um admin de condomínio');

  // (b) Super Admin: permitido, e o destino é mesmo gravado.
  UTILIZADOR = SUPER;
  gravacoesDestino.length = 0;
  r = await pedir('POST', '/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  assert.strictEqual(r.status, 302, 'P9: Super Admin é aceite');
  assert.strictEqual(r.location, '/admin/config/armazenamento', 'P9: Super Admin volta à página de armazenamento');
  assert.deepStrictEqual(gravacoesDestino, ['dropbox'], 'P9: o Super Admin grava o destino');

  // (c) Prova de que é a GUARDA que recusa: retirada do stack, o MESMO pedido
  // de um admin de condomínio passa a ter efeito. Depois repõe-se e confirma-se.
  const original = rota.stack.slice();
  rota.stack = rota.stack.filter((h) => h.handle !== tenant.apenasSuperAdmin);
  UTILIZADOR = ADMIN;
  gravacoesDestino.length = 0;
  r = await pedir('POST', '/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  assert.deepStrictEqual(
    gravacoesDestino,
    ['dropbox'],
    'P9: sem a guarda o pedido teria efeito — logo é ELA que recusa'
  );
  rota.stack = original;
  assert.strictEqual(rotaDe(routerConfiguracao, '/config/armazenamento/backups').stack[0].handle, tenant.apenasSuperAdmin,
    'P9: a guarda foi reposta');

  console.log('  ✓ P9: Super Admin grava o destino; admin de condomínio é recusado sem o alterar');
}

// ── P10 — disparo do backup manual da instalação ──────────────────
async function testeP10() {
  const rota = verificarGuardaPresa(routerSistema, '/sistema/backup', 'P10');

  // (a) Admin de CONDOMÍNIO: recusado e o backup NÃO é iniciado.
  // Aqui o destino do redirect é o mesmo do handler ('/admin'), pelo que a
  // prova de que a guarda recusou é a AUSÊNCIA do efeito secundário.
  UTILIZADOR = ADMIN;
  backupsIniciados.length = 0;
  let r = await pedir('POST', '/admin/sistema/backup', {});
  assert.strictEqual(r.status, 302, 'P10: admin de condomínio é recusado');
  assert.strictEqual(r.location, '/admin', 'P10: recusado pela guarda de Super Admin');
  assert.deepStrictEqual(backupsIniciados, [], 'P10: um admin de condomínio NÃO inicia um backup da instalação');

  // (b) Super Admin: permitido e o backup é mesmo iniciado.
  UTILIZADOR = SUPER;
  backupsIniciados.length = 0;
  r = await pedir('POST', '/admin/sistema/backup', {});
  assert.strictEqual(r.status, 302, 'P10: Super Admin é aceite');
  assert.strictEqual(r.location, '/admin', 'P10: Super Admin volta ao painel');
  assert.deepStrictEqual(backupsIniciados, ['manual'], 'P10: o Super Admin inicia o backup manual');

  // (c) Prova de que é a GUARDA que recusa.
  const original = rota.stack.slice();
  rota.stack = rota.stack.filter((h) => h.handle !== tenant.apenasSuperAdmin);
  UTILIZADOR = ADMIN;
  backupsIniciados.length = 0;
  await pedir('POST', '/admin/sistema/backup', {});
  assert.deepStrictEqual(
    backupsIniciados,
    ['manual'],
    'P10: sem a guarda o pedido teria efeito — logo é ELA que recusa'
  );
  rota.stack = original;
  assert.strictEqual(rotaDe(routerSistema, '/sistema/backup').stack[0].handle, tenant.apenasSuperAdmin,
    'P10: a guarda foi reposta');

  console.log('  ✓ P10: Super Admin inicia o backup; admin de condomínio é recusado sem o iniciar');
}

// ── As outras rotas do mesmo router NÃO foram afetadas ────────────
async function testeSemRegressao() {
  // A guarda é ROTA A ROTA, não do router inteiro: só as duas operações de
  // backup da instalação a levam. As restantes rotas (incluindo as de um admin
  // de condomínio) ficam exatamente como estavam.
  const comGuarda = [];
  for (const router of [routerConfiguracao, routerSistema]) {
    for (const camada of router.stack) {
      if (!camada.route) continue;
      if (camada.route.stack.some((h) => h.handle === tenant.apenasSuperAdmin)) {
        comGuarda.push(`${Object.keys(camada.route.methods)[0].toUpperCase()} ${camada.route.path}`);
      }
    }
  }
  assert.deepStrictEqual(
    comGuarda.sort(),
    ['POST /config/armazenamento/backups', 'POST /sistema/backup'].sort(),
    'só as duas operações de backup da instalação levam a guarda'
  );

  // O router de Configurações mantém os seus dois middlewares de isolamento
  // (condomínio ativo + papel): a guarda nova não os substituiu nem se somou.
  const middlewares = routerConfiguracao.stack.filter((l) => !l.route).length;
  assert.strictEqual(middlewares, 2, 'o router mantém o isolamento por condomínio e papel');
  console.log('  ✓ a guarda é rota a rota: as restantes rotas mantêm-se inalteradas');
}

(async () => {
  testeGuardas();
  await testeP9();
  await testeP10();
  await testeSemRegressao();
  console.log('✓ Testes de autorização das operações de backup da instalação passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
