// Testes do fluxo "LOGIN → Os meus condomínios" — sem base de dados.
// Utilização: node scripts/test-home-selecao.js
const assert = require('assert');
const { destinoAposLogin } = require('../routes/index');

function testar() {
  // 1. Um único condomínio e SEM ativo → NUNCA entra direto.
  let d = destinoAposLogin({ meus: [{ id: 3 }], ativo: null, user: { role: 'admin' } });
  assert.strictEqual(d.redirecionar, '/condominios', 'sem ativo → seleção (mesmo com 1 condomínio)');

  // 2. Ativo válido → dashboard conforme o papel.
  d = destinoAposLogin({ meus: [{ id: 3 }], ativo: 3, user: { role: 'admin' } });
  assert.strictEqual(d.redirecionar, '/admin', 'com ativo escolhido → dashboard admin');
  d = destinoAposLogin({ meus: [{ id: 3 }, { id: 5 }], ativo: 5, user: { role: 'condomino' } });
  assert.strictEqual(d.redirecionar, '/condomino', 'vários com ativo → área do condómino');

  // 3. Ativo inválido (não associado) → limpa e pede seleção.
  d = destinoAposLogin({ meus: [{ id: 3 }], ativo: 99, user: { role: 'admin' } });
  assert.strictEqual(d.redirecionar, '/condominios', 'ativo inválido → seleção');
  assert.strictEqual(d.limparAtivo, true, 'ativo inválido é limpo');

  // 4. Super Admin sem associações mas sem ativo → /condominios (seleção).
  d = destinoAposLogin({ meus: [], ativo: null, user: { role: 'condomino', role_global: 'super_admin' } });
  assert.strictEqual(d.redirecionar, '/condominios', 'super admin sem ativo → seleção');
}

testar();
console.log('✓ Testes do fluxo de seleção de condomínio passaram (sem BD).');
