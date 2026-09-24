// ═══════════════════════════════════════════════════════════════════
// A6.1 / C1 — Autorização das operações de backup (P9/P10).
//
// Há DOIS eixos, e o teste cobre os dois:
//
//   (A) OPERAÇÕES DA INSTALAÇÃO — o dump contém dados de todos os condomínios,
//       por isso só um Super Admin (`users.role_global = 'super_admin'`) as pode
//       usar:
//         P9  POST /admin/config/armazenamento/backups  (destino global)
//         P10 POST /admin/sistema/backup                (disparo manual)
//
//   (B) OPERAÇÕES DO CONDOMÍNIO ATIVO — a gestão do armazenamento do próprio
//       condomínio. Aqui o eixo é o PAPEL no condomínio (comPapel('admin')) e o
//       Super Admin NÃO tem atalho: sem associação real ou suporte vigente, não
//       entra; e o suporte, mesmo vigente, não herda papel de admin.
//
// Este teste monta os DOIS routers reais num servidor Express e faz pedidos
// HTTP a sério. As guardas são as REAIS (`helpers/tenant`) — NÃO são
// substituídas por duplos, senão estaríamos a testar o duplo. Prova:
//   · Super Admin      → P9/P10 permitido (e o efeito acontece mesmo);
//   · admin condomínio → P9/P10 recusado   (e NADA acontece);
//   · admin condomínio → operações do condomínio permitidas;
//   · gestor/leitura, outro condomínio, sem associação, sem sessão → recusados;
//   · Super Admin sem associação nem suporte → recusado (não há atalho global);
//   · Super Admin com suporte vigente → recusado nestas rotas (o suporte não
//     herda papel de admin);
//   · `condominio_id` no corpo é ignorado (o âmbito vem da SESSÃO);
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
const principaisDefinidos = []; // storage.definirPrincipalDoCondominio

// ── Duplos (só o que precisa de BD/IO) ─────────────────────────────
// `../helpers/tenant` NÃO é substituído: é o módulo real, com a guarda real.
//
// C1: a associação e o acesso de suporte passam a ser CONTROLÁVEIS por caso, para
// se poder exercitar o eixo do condomínio (papel, condomínio errado, sem
// associação, suporte) sem sair do router real. Os valores por omissão
// reproduzem o cenário original (associação de admin), pelo que os casos de
// P9/P10 acima ficam com o mesmo comportamento de antes.
let ASSOC = { utilizador_id: null, condominio_id: 1, estado: 'ativo', role: 'admin' };
let SUPORTE_VIGENTE = null;

const stubs = {
  '../models': {
    // Associação ATIVA com papel de admin — o mesmo cenário para os dois
    // utilizadores, para que a ÚNICA diferença entre eles seja `role_global`.
    // `utilizador_id: null` funciona como curinga.
    UserCondominio: {
      // O duplo HONRA o `where`. Um duplo que devolvesse sempre a associação
      // daria um FALSO VERDE no caso do condomínio errado: a guarda parece
      // recusar, mas é o duplo que nunca chega a ver o pedido.
      findOne: async (opts) => {
        const w = (opts && opts.where) || {};
        if (!ASSOC) return null;
        if (ASSOC.utilizador_id != null && Number(w.utilizador_id) !== Number(ASSOC.utilizador_id)) return null;
        if (Number(w.condominio_id) !== Number(ASSOC.condominio_id)) return null;
        if (w.estado && w.estado !== ASSOC.estado) return null;
        return ASSOC;
      },
      findAll: async () => [],
    },
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
    obterProvedor: (nome) =>
      nome ? { nome, rotulo: () => 'Dropbox', icone: () => 'bi bi-dropbox', isConfigured: () => true } : null,
    ligacaoDeBackup: () => ({ condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' }),
    definirDestinoDeBackup: async (nome) => {
      gravacoesDestino.push(nome === undefined ? null : nome);
      return nome;
    },
    destinoDeBackup: async () => 'dropbox',
    estadoDoCondominio: async () => ({}),
    inicializar: async () => {},
    definirPrincipalDoCondominio: async (condominioId, nome) => {
      principaisDefinidos.push({ condominioId, nome });
    },
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
  // O mecanismo de suporte é controlado por `SUPORTE_VIGENTE`. Só
  // `helpers/tenant.js` consome este módulo — e só estas três coisas —, pelo que
  // o duplo é exaustivo para o que está em teste. O mecanismo de suporte em si
  // tem suite própria (`scripts/test-allow-list-suporte.js`).
  '../helpers/suporte': {
    vigente: async () => SUPORTE_VIGENTE,
    paraContexto: (acesso) =>
      acesso
        ? { id: acesso.id, condominioId: Number(acesso.condominio_id), nivel: acesso.nivel, motivo: acesso.motivo, expiraEm: acesso.expira_em }
        : null,
    CHAVE_SESSAO: 'suporte_ativo_id',
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
// C1: sessão e autenticação controláveis por caso (o âmbito vem SEMPRE da
// sessão — é isso que o caso 7 confirma).
let AUTENTICADO = true;
let SESSAO = { condominio_ativo_id: 1 };

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.isAuthenticated = () => AUTENTICADO;
  req.user = UTILIZADOR;
  req.session = { ...SESSAO };
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

// ═══════════════════════════════════════════════════════════════════
// C1 — Operações de backup do CONDOMÍNIO ATIVO
// ═══════════════════════════════════════════════════════════════════
// A rota escolhida é representativa do eixo: `POST /config/armazenamento/principal`
// configura o armazenamento do condomínio ATIVO e está guardada ao nível do
// router por `comCondominioAtivo` + `comPapel('admin')` (as guardas REAIS, sem
// duplos). O efeito observável é `storage.definirPrincipalDoCondominio(id, nome)`
// — é por ele que se prova que a operação ACONTECEU (ou não).
const ROTA_CONDOMINIO = '/admin/config/armazenamento/principal';
const ASSOC_ADMIN = { utilizador_id: null, condominio_id: 1, estado: 'ativo', role: 'admin' };
const assocComPapel = (papel, condominioId = 1) => ({ utilizador_id: null, condominio_id: condominioId, estado: 'ativo', role: papel });

// Corre um caso e devolve o observado; repõe sempre o cenário por omissão.
async function casoCondominio({
  user = ADMIN,
  auth = true,
  sessao = { condominio_ativo_id: 1 },
  assoc = ASSOC_ADMIN,
  suporte = null,
  corpo = { provedor: 'dropbox' },
} = {}) {
  UTILIZADOR = user;
  AUTENTICADO = auth;
  SESSAO = sessao;
  ASSOC = assoc;
  SUPORTE_VIGENTE = suporte;
  principaisDefinidos.length = 0;
  const r = await pedir('POST', ROTA_CONDOMINIO, corpo);
  const observado = { status: r.status, location: r.location, efeito: principaisDefinidos.slice() };
  UTILIZADOR = ADMIN;
  AUTENTICADO = true;
  SESSAO = { condominio_ativo_id: 1 };
  ASSOC = ASSOC_ADMIN;
  SUPORTE_VIGENTE = null;
  return observado;
}

async function testeOperacoesDoCondominio() {
  // A guarda de âmbito está MESMO no router (não substituída por um duplo).
  const camadas = routerConfiguracao.stack.filter((l) => !l.route);
  assert.strictEqual(camadas.length, 2, 'o router tem exatamente as duas guardas de âmbito');

  // (1) ADMIN do condomínio → PERMITIDO, e a operação acontece no condomínio 1.
  let o = await casoCondominio({ assoc: assocComPapel('admin') });
  assert.strictEqual(o.status, 302, 'admin do condomínio é aceite');
  assert.strictEqual(o.location, '/admin/config/armazenamento', 'admin volta à página de armazenamento');
  assert.deepStrictEqual(o.efeito, [{ condominioId: 1, nome: 'dropbox' }], 'admin do condomínio configura o SEU condomínio');

  // (2) GESTOR e LEITURA → recusados. `comPapel('admin')` exige admin; o destino
  //     `/` (e não `/condominios`) é o da guarda de papel.
  for (const papel of ['gestor', 'leitura']) {
    o = await casoCondominio({ assoc: assocComPapel(papel) });
    assert.strictEqual(o.location, '/', `${papel}: recusado pela guarda de papel`);
    assert.deepStrictEqual(o.efeito, [], `${papel}: não altera nada`);
  }

  // (3) OUTRO condomínio (associação a 2, sessão em 1) → recusado.
  o = await casoCondominio({ assoc: assocComPapel('admin', 2) });
  assert.strictEqual(o.location, '/condominios', 'associação a outro condomínio é recusada');
  assert.deepStrictEqual(o.efeito, [], 'não altera nada do condomínio ativo');

  // (4) SEM ASSOCIAÇÃO → recusado.
  o = await casoCondominio({ assoc: null });
  assert.strictEqual(o.location, '/condominios', 'sem associação é recusado');
  assert.deepStrictEqual(o.efeito, [], 'não altera nada');

  // (5) SUPER ADMIN **sem** associação nem suporte → RECUSADO. É o essencial:
  //     `role_global` NÃO dá acesso aos dados de um condomínio.
  o = await casoCondominio({ user: SUPER, assoc: null });
  assert.strictEqual(o.location, '/condominios', 'Super Admin sem associação NÃO entra no condomínio');
  assert.deepStrictEqual(o.efeito, [], 'o privilégio global não substitui a associação');

  // (5b) Super Admin COM associação real de admin → permitido. Não é atalho:
  //      entra pelo mesmo caminho que qualquer membro do condomínio.
  o = await casoCondominio({ user: SUPER, assoc: assocComPapel('admin') });
  assert.deepStrictEqual(o.efeito, [{ condominioId: 1, nome: 'dropbox' }], 'com associação real, entra como membro (não por ser Super Admin)');

  // (6) SUPER ADMIN **com suporte vigente** → RECUSADO nestas rotas: o acesso de
  //     suporte tem `req.papelCondominio = null`, pelo que `comPapel` recusa por
  //     construção. O suporte NÃO herda o backoffice.
  o = await casoCondominio({ user: SUPER, assoc: null, suporte: { id: 5, nivel: 'completo', condominio_id: 1 } });
  assert.strictEqual(o.location, '/', 'o suporte não herda papel de admin');
  assert.deepStrictEqual(o.efeito, [], 'um acesso de suporte não configura o armazenamento do condomínio');

  // (7) `condominio_id` no CORPO não muda o âmbito: o alvo vem da SESSÃO.
  o = await casoCondominio({ assoc: assocComPapel('admin'), corpo: { provedor: 'dropbox', condominio_id: '2' } });
  assert.deepStrictEqual(
    o.efeito,
    [{ condominioId: 1, nome: 'dropbox' }],
    'o condominio_id do corpo é ignorado — o âmbito vem da sessão (nunca do browser)'
  );

  // (8) SEM AUTENTICAÇÃO → recusado no primeiro passo da guarda.
  o = await casoCondominio({ auth: false, assoc: null });
  assert.strictEqual(o.location, '/login', 'sem sessão autenticada é recusado no login');
  assert.deepStrictEqual(o.efeito, [], 'não altera nada');

  console.log('  ✓ C1: admin do condomínio permitido; gestor/leitura, outro condomínio, sem associação,');
  console.log('        Super Admin sem suporte, Super Admin com suporte e sem sessão → recusados;');
  console.log('        `condominio_id` do corpo ignorado (âmbito vem da sessão)');
}

// ── Prova de mutação do eixo do condomínio ────────────────────────
// A regressão a provar: retirada a guarda de PAPEL, um GESTOR passa a poder
// configurar o condomínio. Se o teste acima não detetasse isto, seria um falso
// verde — estaria a passar por acidente, não por a guarda funcionar.
async function testeMutacaoGuardaDePapel() {
  const camadas = routerConfiguracao.stack.filter((l) => !l.route);
  const original = routerConfiguracao.stack.slice();
  // A 2.ª camada do router é `comPapel('admin')` (a 1.ª é `comCondominioAtivo`).
  const guardaDePapel = camadas[1];
  routerConfiguracao.stack = routerConfiguracao.stack.filter((l) => l !== guardaDePapel);

  const mutado = await casoCondominio({ assoc: assocComPapel('gestor') });
  assert.deepStrictEqual(
    mutado.efeito,
    [{ condominioId: 1, nome: 'dropbox' }],
    'mutação: SEM a guarda de papel o gestor teria efeito — logo é ELA que recusa'
  );

  routerConfiguracao.stack = original;
  const reposto = await casoCondominio({ assoc: assocComPapel('gestor') });
  assert.deepStrictEqual(reposto.efeito, [], 'com a guarda reposta, o gestor volta a ser recusado');
  assert.strictEqual(routerConfiguracao.stack.filter((l) => !l.route).length, 2, 'as duas guardas foram repostas');
  console.log('  ✓ mutação: sem `comPapel(\'admin\')` o gestor teria efeito — a guarda é o que recusa');
}

(async () => {
  testeGuardas();
  await testeP9();
  await testeP10();
  await testeSemRegressao();
  await testeOperacoesDoCondominio();
  await testeMutacaoGuardaDePapel();
  console.log('✓ Testes de autorização das operações de backup (instalação e condomínio) passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
