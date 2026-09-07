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

// ═════════════════════════════════════════════════════════════════════
// TOTP (RFC 6238) — Aplicação autenticadora (Google Authenticator, etc.)
// Implementado sem dependências (HMAC-SHA1 via crypto).
// ═════════════════════════════════════════════════════════════════════

const B32_ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function bytesParaBase32(bytes) {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += B32_ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += B32_ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

function base32ParaBytes(segredo) {
  const limpo = String(segredo).replace(/=+$/g, '').toUpperCase().replace(/\s/g, '');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of limpo) {
    const idx = B32_ALFABETO.indexOf(ch);
    if (idx === -1) continue; // tolera caracteres inválidos
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Gera um segredo TOTP (20 bytes → 32 chars Base32, sem padding).
function gerarSegredoTOTP() {
  return bytesParaBase32(crypto.randomBytes(20));
}

// URI otpauth para importar na aplicação autenticadora.
function otpauthURI({ segredo, email, emissor = 'GesCondu' }) {
  const rotulo = `${emissor}:${email}`;
  const params = new URLSearchParams({ secret: segredo, issuer: emissor, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(rotulo)}?${params.toString()}`;
}

// Código TOTP de 6 dígitos para um contador (período de 30 s).
function totpParaContador(segredo, contador) {
  const chave = base32ParaBytes(segredo);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', chave).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// Verifica um código TOTP com janela ±1 período (30 s).
function verificarTOTP(segredo, codigo, { agora = Date.now(), janela = 1 } = {}) {
  if (!segredo || !codigo) return false;
  const alvo = String(codigo).trim();
  const contadorAtual = Math.floor(agora / 1000 / 30);
  for (let desvio = -janela; desvio <= janela; desvio++) {
    if (totpParaContador(segredo, contadorAtual + desvio) === alvo) return true;
  }
  return false;
}

module.exports = {
  gerarCodigo,
  hashCodigo,
  codigoExpiracao,
  gerarRecoveryCodes,
  hashRecovery,
  consumirRecovery,
  bytesParaBase32,
  base32ParaBytes,
  gerarSegredoTOTP,
  otpauthURI,
  totpParaContador,
  verificarTOTP,
};
