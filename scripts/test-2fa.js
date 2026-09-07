// Testes do 2FA (código por email + códigos de recuperação) — sem BD.
// Utilização: node scripts/test-2fa.js
const assert = require('assert');
const doisFatores = require('../helpers/doisfatores');

function testarCodigoEmail() {
  const c1 = doisFatores.gerarCodigo();
  const c2 = doisFatores.gerarCodigo();
  assert.ok(/^\d{6}$/.test(c1), 'código com 6 dígitos');
  assert.notStrictEqual(c1, c2, 'códigos diferentes');

  const hash = doisFatores.hashCodigo(c1);
  assert.strictEqual(hash.length, 64, 'hash SHA-256 (64 hex)');
  assert.strictEqual(hash, doisFatores.hashCodigo(c1), 'hash determinístico');
  assert.notStrictEqual(hash, c1, 'nunca guarda o código em claro');

  const exp = doisFatores.codigoExpiracao();
  assert.ok(exp.getTime() > Date.now() + 9 * 60 * 1000, 'expiração ~10 minutos');
}

function testarRecovery() {
  const codigos = doisFatores.gerarRecoveryCodes(10);
  assert.strictEqual(codigos.length, 10, '10 códigos');
  assert.ok(codigos.every((c) => /^\d{5}-\d{5}$/.test(c)), 'formato XXXXX-XXXXX');
  assert.strictEqual(new Set(codigos).size, 10, 'códigos únicos');

  const hashArmazenado = doisFatores.hashRecovery(codigos);
  assert.ok(!hashArmazenado.includes(codigos[0]), 'códigos guardados apenas em hash');

  // Consumo: o código usado desaparece; os outros permanecem.
  const restante = doisFatores.consumirRecovery(hashArmazenado, codigos[0]);
  assert.notStrictEqual(restante, null, 'recuperação com código válido');
  assert.ok(!restante.includes(doisFatores.hashCodigo(codigos[0])), 'código consumido removido');
  assert.ok(restante.includes(doisFatores.hashCodigo(codigos[1])), 'outros códigos mantêm-se');

  // Reutilização falha.
  assert.strictEqual(doisFatores.consumirRecovery(restante, codigos[0]), null, 'código usado não volta a funcionar');

  // Código errado devolve null e não altera.
  assert.strictEqual(doisFatores.consumirRecovery(hashArmazenado, '00000-00000'), null, 'código errado rejeitado');
}

testarCodigoEmail();
testarRecovery();
console.log('✓ Testes de 2FA passaram (sem base de dados).');
