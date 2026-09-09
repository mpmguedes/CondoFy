// Testes do bloqueio automático da sessão por inatividade.
// Sem base de dados e sem rede: exercita a política pura e os invariantes de
// integração (servidor + cliente).
//
// Utilização: node scripts/test-sessao.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const sessao = require('../helpers/sessao');

const MIN = 60 * 1000;

// ── 1. Política de inatividade ──────────────────────────────────────
function testPolitica() {
  // Defeito: 2 horas (120 minutos) e aviso de 2 minutos.
  assert.strictEqual(sessao.MINUTOS_INATIVIDADE, 120, 'inatividade por defeito: 120 min');
  assert.strictEqual(sessao.IDLE_MS, 120 * MIN, 'IDLE_MS corresponde a 120 min');
  assert.strictEqual(sessao.SEGUNDOS_AVISO, 120, 'aviso por defeito: 120 s');
  assert.strictEqual(sessao.AVISO_MS, 120 * 1000, 'AVISO_MS corresponde a 120 s');
  assert.ok(sessao.AVISO_MS < sessao.IDLE_MS, 'o aviso acontece antes de expirar');

  // Parsing tolerante da configuração por env.
  assert.strictEqual(sessao.minutosDeInatividade('30'), 30, 'valor de env aceite');
  assert.strictEqual(sessao.minutosDeInatividade('0'), 120, 'zero cai no defeito');
  assert.strictEqual(sessao.minutosDeInatividade('abc'), 120, 'texto cai no defeito');
  assert.strictEqual(sessao.minutosDeInatividade(undefined), 120, 'ausente cai no defeito');
  assert.strictEqual(sessao.minutosDeInatividade('99999'), 24 * 60, 'teto de 24 h');
  assert.strictEqual(sessao.segundosDeAviso('60'), 60, 'aviso configurável');
  assert.strictEqual(sessao.segundosDeAviso('-5'), 120, 'negativo cai no defeito');
}

// ── 2. Expiração (marcas na sessão) ─────────────────────────────────
function testExpiracao() {
  const agora = 1_000_000_000_000;

  // Sem marcas (sessão antiga/legada) → não expira (é marcada no 1.º pedido).
  assert.strictEqual(sessao.expirada({}, agora), false, 'sem marca não expira');
  assert.strictEqual(sessao.expirada(null, agora), false, 'sessão ausente não rebenta');
  assert.strictEqual(sessao.expiraEm({}, agora), null, 'sem marca não há instante');

  const s = {};
  sessao.marcarAtividade(s, agora);
  assert.strictEqual(s.sessaoUltimaAtividade, agora, 'marca a última atividade');
  assert.strictEqual(s.sessaoInicio, agora, 'marca o início na primeira vez');
  assert.strictEqual(sessao.expiraEm(s), agora + sessao.IDLE_MS, 'expira após IDLE_MS');

  // Dentro do limite (1 min antes) → válida; 1 min depois → expirada.
  assert.strictEqual(sessao.expirada(s, agora + sessao.IDLE_MS - MIN), false, 'dentro do limite');
  assert.strictEqual(sessao.expirada(s, agora + sessao.IDLE_MS + MIN), true, 'passou do limite');

  // Hibernação: 8 h sem pedidos → expirada, mesmo com o processo vivo.
  assert.strictEqual(sessao.expirada(s, agora + 8 * 60 * MIN), true, 'retoma após hibernação longa expira');

  // Atividade renova a última mas mantém o início (não há limite absoluto).
  const maisTarde = agora + 60 * MIN;
  sessao.marcarAtividade(s, maisTarde);
  assert.strictEqual(s.sessaoInicio, agora, 'início mantém-se');
  assert.strictEqual(s.sessaoUltimaAtividade, maisTarde, 'última atividade atualizada');
  assert.strictEqual(sessao.expirada(s, maisTarde + sessao.IDLE_MS - MIN), false, 'atividade mantém a sessão viva');

  // Sem limite absoluto: passadas muitas horas com atividade contínua, continua válida.
  const muitoDepois = agora + 30 * 60 * MIN;
  sessao.marcarAtividade(s, muitoDepois);
  assert.strictEqual(sessao.expirada(s, muitoDepois + MIN), false, 'sem limite absoluto de duração');

  // limparMarcas remove tudo o que é sensível.
  s.condominio_ativo_id = 7;
  s.pendente2faLogin = 3;
  s.pendente2faAtivar = 4;
  sessao.limparMarcas(s);
  assert.deepStrictEqual(s, {}, 'limparMarcas remove marcas e dados de sessão');
}

// ── 3. Integração no servidor ───────────────────────────────────────
function testServidor() {
  const app = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');
  assert.ok(app.includes("require('./helpers/sessao')"), 'app.js usa o helper de sessão');
  assert.ok(app.includes('app.use(sessao.middlewareSessao)'), 'middleware de inatividade registado');
  assert.ok(app.includes('rolling: true'), 'cookie renovado a cada pedido (rolling)');
  assert.ok(app.includes('maxAge: sessao.IDLE_MS'), 'cookie expira com a inatividade');
  assert.ok(!/maxAge: 1000 \* 60 \* 60 \* 24 \* 7/.test(app), 'cookie de 7 dias removido');
  assert.ok(app.includes('sessaoExpiraEm'), 'locals expõem o instante de expiração');
  assert.ok(app.includes('sessaoAvisoMs') && app.includes('sessaoIdleMs'), 'locals expõem aviso e idle');

  const auth = fs.readFileSync(path.join(raiz, 'routes/auth.js'), 'utf8');
  assert.ok(auth.includes("router.get('/sessao/estado'"), 'rota de estado da sessão existe');
  assert.ok(auth.includes("router.post('/sessao/renovar'"), 'rota de renovação existe');
  assert.ok(auth.includes("req.query.expirada === '1'"), 'login assinala sessão expirada');
  assert.ok(auth.includes('sessao.encerrarPorInatividade(req, res)'), 'estado encerra sessão expirada');

  const middleware = fs.readFileSync(path.join(raiz, 'helpers/sessao.js'), 'utf8');
  assert.ok(middleware.includes("res.redirect('/login?expirada=1')"), 'expiração redireciona para o login');
  assert.ok(middleware.includes('res.status(401).json({ autenticado: false, expirada: true })'), 'pedidos fetch recebem 401');
  assert.ok(middleware.includes('CAMINHO_ESTATICO'), 'estáticos não contam como atividade');
}

// ── 4. Integração no cliente ────────────────────────────────────────
function testCliente() {
  const layout = fs.readFileSync(path.join(raiz, 'views/layouts/main.handlebars'), 'utf8');
  assert.ok(layout.includes('window.__SESSAO__'), 'layout injeta a configuração da sessão');
  assert.ok(layout.includes("'/sessao/renovar'") && layout.includes("'/sessao/estado'"), 'endpoints corretos');
  assert.ok(layout.includes('/js/sessao.js'), 'layout carrega o script da sessão');

  const login = fs.readFileSync(path.join(raiz, 'views/auth/login.handlebars'), 'utf8');
  assert.ok(login.includes('{{#if expirada}}'), 'login mostra aviso de expiração');
  assert.ok(login.includes('expirou por inatividade'), 'mensagem clara para o utilizador');

  const cliente = fs.readFileSync(path.join(raiz, 'public/js/sessao.js'), 'utf8');
  assert.ok(cliente.includes('renovarUrl') && cliente.includes('estadoUrl'), 'script usa os endpoints recebidos');
  assert.ok(cliente.includes('cfg.renovar') && cliente.includes('cfg.estado'), 'endpoints preferem a configuração injetada (fallback local)');
  assert.ok(cliente.includes("addEventListener('visibilitychange'"), 'verifica ao voltar de hibernação');
  assert.ok(cliente.includes("addEventListener('focus'") && cliente.includes("addEventListener('pageshow'"), 'verifica na retoma da janela');
  assert.ok(cliente.includes('Continuar sessão'), 'botão para renovar');
  assert.ok(cliente.includes("setAttribute('role', 'alert')"), 'aviso acessível a leitores de ecrã');
  assert.ok(cliente.includes('INTERVALO_PING_MS'), 'renovação limitada em frequência');
  assert.ok(!/https?:\/\//.test(cliente), 'sem chamadas externas');
  assert.ok(!/\brequire\(/.test(cliente.replace(/\/\*[\s\S]*?\*\//g, '')), 'sem dependências');

  const css = fs.readFileSync(path.join(raiz, 'public/css/styles.css'), 'latin1');
  assert.ok(css.includes('.sessao-aviso'), 'estilo do aviso existe');
  assert.ok(css.includes('env(safe-area-inset-bottom'), 'aviso não tapa a barra mobile');

  const env = fs.readFileSync(path.join(raiz, '.env.example'), 'utf8');
  assert.ok(env.includes('SESSION_IDLE_MINUTOS') && env.includes('SESSION_AVISO_SEGUNDOS'), 'configuração documentada');
}

// ── 5. Middleware: comportamento ────────────────────────────────────
async function testMiddleware() {
  const chamar = (sessaoObj, extras) => new Promise((resolve) => {
    const req = Object.assign({
      session: sessaoObj,
      path: '/admin',
      headers: {},
      isAuthenticated: () => true,
      logout: (cb) => { req._logout = true; cb(); },
    }, extras || {});
    const res = {
      redirect: (url) => resolve({ tipo: 'redirect', url, logout: !!req._logout }),
      status: (c) => ({ json: (b) => resolve({ tipo: 'json', codigo: c, body: b, logout: !!req._logout }) }),
    };
    sessao.middlewareSessao(req, res, () => resolve({ tipo: 'next', session: req.session }));
  });

  // Sessão sem marca (primeiro pedido autenticado) → marca e segue.
  const semMarca = await chamar({});
  assert.strictEqual(semMarca.tipo, 'next', 'primeiro pedido segue');
  assert.ok(semMarca.session.sessaoUltimaAtividade, 'primeiro pedido marca atividade');

  // Sessão ativa dentro do limite → segue e renova.
  const ativa = { sessaoUltimaAtividade: Date.now() - 5 * MIN };
  const dentro = await chamar(ativa);
  assert.strictEqual(dentro.tipo, 'next', 'dentro do limite segue');
  assert.ok(ativa.sessaoUltimaAtividade > Date.now() - 2000, 'atividade renovada');

  // Expirada → logout + redirect para o login.
  const expirada = { sessaoUltimaAtividade: Date.now() - (sessao.IDLE_MS + MIN), condominio_ativo_id: 3 };
  const fora = await chamar(expirada);
  assert.strictEqual(fora.tipo, 'redirect', 'expirada redireciona');
  assert.strictEqual(fora.url, '/login?expirada=1', 'destino correto');
  assert.strictEqual(fora.logout, true, 'sessão encerrada (logout)');
  assert.ok(!expirada.condominio_ativo_id, 'dados da sessão limpos');

  // Expirada em pedido fetch → 401 JSON (o cliente redireciona).
  const expiradaFetch = { sessaoUltimaAtividade: Date.now() - (sessao.IDLE_MS + MIN) };
  const json = await chamar(expiradaFetch, { headers: { accept: 'application/json' } });
  assert.strictEqual(json.tipo, 'json', 'fetch recebe JSON');
  assert.strictEqual(json.codigo, 401, 'código 401');
  assert.strictEqual(json.body.expirada, true, 'indica expiração');

  // Estáticos não contam como atividade nem bloqueiam.
  const estatico = { sessaoUltimaAtividade: Date.now() - (sessao.IDLE_MS + MIN) };
  const css = await chamar(estatico, { path: '/css/styles.css' });
  assert.strictEqual(css.tipo, 'next', 'estático não é bloqueado');
  assert.ok(!estatico.sessaoUltimaAtividade || estatico.sessaoUltimaAtividade < Date.now() - MIN, 'estático não renova a sessão');

  // Consulta de estado nunca renova (para poder detetar a expiração).
  const consulta = { sessaoUltimaAtividade: Date.now() - 5 * MIN };
  const estado = await chamar(consulta, { path: '/sessao/estado' });
  assert.strictEqual(estado.tipo, 'next', 'consulta de estado segue');
  assert.ok(consulta.sessaoUltimaAtividade < Date.now() - MIN, 'consulta não renova a sessão');

  // Não autenticado → não é afetado.
  const anon = await chamar({}, { isAuthenticated: () => false });
  assert.strictEqual(anon.tipo, 'next', 'sem autenticação segue sem mexer');
}

(async () => {
  testPolitica();
  testExpiracao();
  testServidor();
  testCliente();
  await testMiddleware();
  console.log('✓ Testes do bloqueio automático de sessão por inatividade passaram (sem base de dados, sem rede).');
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
