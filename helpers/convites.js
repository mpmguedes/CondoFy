// ─────────────────────────────────────────────────────────────────────
// Convites de ativação — tokens únicos com validade configurável.
// Estados (modelo User.convite_estado):
//   pendente → enviado → aceite | expirado | revogado
// Validade por omissão: 30 dias (configurável via CONVITE_VALIDADE_DIAS).
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// Validade em dias: env CONVITE_VALIDADE_DIAS (padrão 30).
function diasValidade() {
  const n = parseInt(process.env.CONVITE_VALIDADE_DIAS, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// Gera um token de convite (hex seguro, ~48 bytes).
function gerarToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Data de expiração do convite (agora + validade).
function calcularExpiracao(dias = diasValidade()) {
  return new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
}

// Estado de um convite a partir do token/expiração guardados:
//  'aceite'/'revogado' → devolvidos como estão; 'enviado'/'pendente' com
//  expiração passada → 'expirado'; sem token → null (não é convite).
function estadoDoConvite({ convite_token, convite_token_expira, convite_estado } = {}) {
  if (!convite_token) return null;
  if (convite_estado === 'aceite' || convite_estado === 'revogado') return convite_estado;
  if (convite_estado === 'expirado') return 'expirado';
  if (!convite_token_expira || new Date(convite_token_expira) < new Date()) return 'expirado';
  return convite_estado === 'enviado' ? 'enviado' : 'pendente';
}

module.exports = { diasValidade, gerarToken, calcularExpiracao, estadoDoConvite };
