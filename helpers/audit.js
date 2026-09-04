const { AuditLog } = require('../models');

// Regista uma operação importante no log de auditoria.
// Nunca lança erro para não interromper o fluxo principal.
async function audit({ userId, acao, entidade, entidadeId, detalhes }) {
  try {
    await AuditLog.create({
      user_id: userId || null,
      acao,
      entidade: entidade || null,
      entidade_id: entidadeId || null,
      detalhes: detalhes ? JSON.stringify(detalhes) : null,
    });
  } catch (err) {
    console.error('[auditoria] erro ao registar:', err.message);
  }
}

module.exports = { audit };
