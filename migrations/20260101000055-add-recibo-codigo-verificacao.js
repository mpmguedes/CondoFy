'use strict';
const crypto = require('crypto');

// Código de verificação do recibo — estável e único (deriva do código RCP,
// nunca é regenerado). Mesma regra do helpers/recibos.js.
function gerarCodigoVerificacao(ano, codigo) {
  const hash = crypto.createHash('sha1').update(`gescondu:recibo:${codigo}`).digest('hex').slice(0, 8).toUpperCase();
  return `${ano}-${hash}`;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('recibos', 'codigo_verificacao', {
      type: Sequelize.STRING(40),
      allowNull: true,
    });

    // Backfill dos recibos existentes (compatibilidade — nada é destruído).
    const linhas = await queryInterface.sequelize.query('SELECT id, codigo, ano FROM recibos', {
      type: queryInterface.sequelize.QueryTypes.SELECT,
    });
    for (const r of linhas) {
      await queryInterface.sequelize.query('UPDATE recibos SET codigo_verificacao = ? WHERE id = ?', {
        replacements: [gerarCodigoVerificacao(r.ano, r.codigo), r.id],
      });
    }

    await queryInterface.changeColumn('recibos', 'codigo_verificacao', {
      type: Sequelize.STRING(40),
      allowNull: false,
    });
    await queryInterface.addIndex('recibos', ['codigo_verificacao'], { unique: true });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('recibos', 'codigo_verificacao').catch(() => {});
    await queryInterface.removeColumn('recibos', 'codigo_verificacao');
  },
};
