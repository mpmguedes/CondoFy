// ─────────────────────────────────────────────────────────────────────
// 2FA — código por email + códigos de recuperação.
// Os códigos nunca são guardados em claro: apenas hashes SHA-256.
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// Código numérico de 6 dígitos (crypto — não usa Math.random).
function gerarCodigo() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function hashCodigo(valor) {
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
}

// Duração de um código de email (10 minutos).
function codigoExpiracao() {
  return new Date(Date.now() + 10 * 60 * 1000);
}

// Gera N códigos de recuperação (legíveis, em grupos).
function gerarRecoveryCodes(n = 10) {
  const codigos = [];
  for (let i = 0; i < n; i++) {
    const bloco = () => crypto.randomInt(0, 100000).toString().padStart(5, '0');
    codigos.push(`${bloco()}-${bloco()}`);
  }
  return codigos;
}

// Guarda os códigos de recuperação como hashes separados por '|'.
function hashRecovery(codigos) {
  return codigos.map((c) => hashCodigo(c)).join('|');
}

// Consome um código de recuperação: devolve o texto de hashes sem o usado,
// ou null se nenhum corresponder.
function consumirRecovery(hashArmazenado, codigo) {
  if (!hashArmazenado || !codigo) return null;
  const alvo = hashCodigo(String(codigo).trim());
  const hashes = String(hashArmazenado).split('|');
  const idx = hashes.findIndex((h) => h === alvo);
  if (idx === -1) return null;
  hashes.splice(idx, 1);
  return hashes.join('|');
}

module.exports = { gerarCodigo, hashCodigo, codigoExpiracao, gerarRecoveryCodes, hashRecovery, consumirRecovery };
