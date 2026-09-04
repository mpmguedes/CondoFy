const sequelize = require('../config/database');
const { Numeracao } = require('../models');

// Gera o próximo número de documento de forma persistente e única.
// Ex.: tipo 'aviso_quota', ano 2026 → "2026/0001", "2026/0002", ...
// A sequência é independente do id interno e nunca é reutilizada.
async function proximoNumero(tipoDocumento, { ano, transaction } = {}) {
  const anoNum = ano || new Date().getFullYear();
  const t = transaction || (await sequelize.transaction());
  let own = false;
  if (!transaction) {
    own = true;
  }
  try {
    let numeracao = await Numeracao.findOne({
      where: { tipo_documento: tipoDocumento, ano: anoNum },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!numeracao) {
      numeracao = await Numeracao.create(
        { tipo_documento: tipoDocumento, ano: anoNum, sequencia: 0, formato: '{ano}/{sequencia}' },
        { transaction: t }
      );
    }

    const sequencia = numeracao.sequencia + 1;
    await numeracao.update({ sequencia }, { transaction: t });

    const formato = numeracao.formato || '{ano}/{sequencia}';
    const numero = formato
      .replace('{ano}', String(anoNum))
      .replace('{sequencia}', String(sequencia).padStart(4, '0'));

    if (own) {
      await t.commit();
    }
    return numero;
  } catch (err) {
    if (own) {
      await t.rollback();
    }
    throw err;
  }
}

module.exports = { proximoNumero };
