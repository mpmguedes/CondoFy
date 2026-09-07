// Testes dos convites (tokens, validade, estados) — sem base de dados.
// Utilização: node scripts/test-convites.js
const assert = require('assert');
const convites = require('../helpers/convites');

function testarTokens() {
  const t1 = convites.gerarToken();
  const t2 = convites.gerarToken();
  assert.ok(t1 && t1.length >= 40, 'token não vazio e longo');
  assert.notStrictEqual(t1, t2, 'tokens únicos');

  // Validade por omissão: 30 dias; configurável via env.
  assert.strictEqual(convites.diasValidade(), 30, 'validade por omissão 30 dias');
  const ant = process.env.CONVITE_VALIDADE_DIAS;
  process.env.CONVITE_VALIDADE_DIAS = '7';
  try {
    assert.strictEqual(convites.diasValidade(), 7, 'validade configurável (env)');
  } finally {
    if (ant === undefined) delete process.env.CONVITE_VALIDADE_DIAS;
    else process.env.CONVITE_VALIDADE_DIAS = ant;
  }

  const exp = convites.calcularExpiracao(30);
  const diff = exp.getTime() - Date.now();
  assert.ok(diff > 29 * 24 * 60 * 60 * 1000 && diff <= 31 * 24 * 60 * 60 * 1000, 'expiração ~30 dias');
}

function testarEstados() {
  const futuro = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const passado = new Date(Date.now() - 1000).toISOString();

  assert.strictEqual(convites.estadoDoConvite({}), null, 'sem token → não é convite');
  assert.strictEqual(convites.estadoDoConvite({ convite_token: 'x', convite_estado: 'aceite' }), 'aceite', 'aceite mantém');
  assert.strictEqual(convites.estadoDoConvite({ convite_token: 'x', convite_estado: 'revogado' }), 'revogado', 'revogado mantém');
  assert.strictEqual(convites.estadoDoConvite({ convite_token: 'x', convite_estado: 'expirado' }), 'expirado', 'expirado mantém');
  assert.strictEqual(
    convites.estadoDoConvite({ convite_token: 'x', convite_estado: 'enviado', convite_token_expira: futuro }),
    'enviado',
    'enviado válido'
  );
  assert.strictEqual(
    convites.estadoDoConvite({ convite_token: 'x', convite_estado: 'pendente', convite_token_expira: futuro }),
    'pendente',
    'pendente válido'
  );
  assert.strictEqual(
    convites.estadoDoConvite({ convite_token: 'x', convite_estado: 'enviado', convite_token_expira: passado }),
    'expirado',
    'expiração passada → expirado'
  );
}

testarTokens();
testarEstados();
console.log('✓ Testes de convites passaram (sem base de dados).');
