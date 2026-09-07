// Testes de segurança (sem rede/base de dados).
// Utilização: node scripts/test-seguranca.js
const assert = require('assert');
const { createLimiter } = require('../helpers/seguranca');

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

testarLimite();
console.log('✓ Testes de segurança (rate limiting) passaram (sem rede).');
