// Testes de segurança (sem rede/base de dados).
// Utilização: node scripts/test-seguranca.js
const assert = require('assert');
const { createLimiter, protegerOrigem } = require('../helpers/seguranca');

function novoLimiter(max, janelaMs = 60 * 1000) {
  return createLimiter({ rotulo: `teste-${Math.random().toString(36).slice(2)}`, max, janelaMs, msg: 'limitado' });
}

function pedido(ip) {
  return { ip, originalUrl: '/login', flash: () => {} };
}
function resposta() {
  return {
    statusCode: 200,
    redirectUrl: null,
    status(c) { this.statusCode = c; return this; },
    redirect(u) { this.redirectUrl = u; },
  };
}

function testarLimite() {
  const lim = novoLimiter(2);
  let avancos = 0;
  const next = () => { avancos += 1; };

  const req1 = pedido('1.2.3.4');
  const res1 = resposta();
  lim(req1, res1, next);
  assert.strictEqual(avancos, 1, 'primeiro pedido avança');

  const req2 = pedido('1.2.3.4');
  const res2 = resposta();
  lim(req2, res2, next);
  assert.strictEqual(avancos, 2, 'segundo pedido (dentro do limite) avança');

  const req3 = pedido('1.2.3.4');
  const res3 = resposta();
  lim(req3, res3, next);
  assert.strictEqual(avancos, 2, 'pedido acima do limite NÃO avança');
  assert.strictEqual(res3.statusCode, 429, 'resposta 429');
  assert.strictEqual(res3.redirectUrl, '/login', 'redireciona para o login');

  // IP diferente não é afetado pelo limite do anterior.
  const outro = novoLimiter(1);
  let avancosOutro = 0;
  const nextO = () => { avancosOutro += 1; };
  outro(pedido('5.6.7.8'), resposta(), nextO);
  outro(pedido('5.6.7.9'), resposta(), nextO);
  assert.strictEqual(avancosOutro, 2, 'limites independentes por IP');
}

function testarCSRF() {
  const base = (extra) => ({
    method: 'POST',
    protocol: 'https',
    get: (h) => (h === 'host' ? 'gescondu.pt' : undefined),
    headers: {},
    ...extra,
  });
  const resposta403 = () => {
    const res = { enviado: null, status(c) { this.enviado = c; return this; }, send() {} };
    return res;
  };
  const verificaAvanco = (tipo) => (req) => {
    let avancou = false;
    protegerOrigem(req, resposta403(), () => { avancou = true; });
    assert.ok(avancou, `${tipo}: pedido avança`);
  };

  // Sem Origin/Referer → avança (SameSite cobre o CSRF clássico).
  verificaAvanco('sem origem')(base());
  // Origin igual ao host → avança.
  verificaAvanco('mesma origem')(base({ headers: { origin: 'https://gescondu.pt' } }));
  // Referer do próprio host → avança.
  verificaAvanco('referer próprio')(base({ headers: { referer: 'https://gescondu.pt/admin/quotas' } }));
  // GET nunca é bloqueado.
  verificaAvanco('GET')(base({ method: 'GET', headers: { origin: 'https://inimigo.example' } }));

  // Origem diferente → 403 e não avança.
  const reqMau = base({ headers: { origin: 'https://inimigo.example' } });
  let avancouMau = false;
  const resMau = { enviado: null, status(c) { this.enviado = c; return this; }, send() {} };
  protegerOrigem(reqMau, resMau, () => { avancouMau = true; });
  assert.strictEqual(avancouMau, false, 'origem diferente não avança');
  assert.strictEqual(resMau.enviado, 403, 'origem diferente → 403');
}

testarLimite();
testarCSRF();
console.log('✓ Testes de segurança (rate limiting) passaram (sem rede).');
