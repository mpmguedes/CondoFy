'use strict';

// Configuração inicial das quotas: valor por 1000‰ (total do condomínio) e % do FCR.
// Exemplo: valor por 1000‰ = 100 €; fração de 500‰ → base 50 € (+10% FCR = 55 €).
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const configs = [
      { chave: 'quota_valor_1000', valor: '100.0000' },
      { chave: 'quota_fcr_percentagem', valor: '10' },
    ];
    for (const c of configs) {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id FROM configuracoes WHERE chave = ?',
        { replacements: [c.chave] }
      );
      if (!rows || !rows.length) {
        await queryInterface.bulkInsert('configuracoes', [{ ...c, created_at: now, updated_at: now }]);
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "DELETE FROM configuracoes WHERE chave IN ('quota_valor_1000', 'quota_fcr_percentagem')"
    );
  },
};
