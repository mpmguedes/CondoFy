'use strict';

// Configuração inicial das quotas: valor por permilagem e % do FCR.
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const configs = [
      { chave: 'quota_valor_permilagem', valor: '0.1000' },
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
      "DELETE FROM configuracoes WHERE chave IN ('quota_valor_permilagem', 'quota_fcr_percentagem')"
    );
  },
};
