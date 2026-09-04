'use strict';

// Histórico das quotas: guarda o valor por 1000‰ e a permilagem/FCR utilizados
// no momento da geração, para que alterações futuras de configuração NUNCA
// alterem quotas antigas.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('quotas', 'valor_por_1000', {
      type: Sequelize.DECIMAL(10, 4),
      allowNull: true,
    });
    await queryInterface.addColumn('quotas', 'permilagem_aplicada', {
      type: Sequelize.DECIMAL(7, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('quotas', 'fcr_percentagem', {
      type: Sequelize.DECIMAL(5, 2),
      allowNull: true,
    });

    // Backfill: permilagem aplicada vem da fração associada.
    await queryInterface.sequelize.query(
      'UPDATE quotas q JOIN fracoes f ON f.id = q.fracao_id SET q.permilagem_aplicada = f.permilagem WHERE q.permilagem_aplicada IS NULL'
    );
    // Backfill: valor por 1000‰ = valor_base × 1000 / permilagem (quando possível).
    await queryInterface.sequelize.query(
      "UPDATE quotas SET valor_por_1000 = ROUND(valor_base * 1000 / permilagem_aplicada, 4) WHERE valor_por_1000 IS NULL AND permilagem_aplicada > 0 AND valor_base IS NOT NULL"
    );
    // Backfill: FCR% = valor_fcr / valor_base × 100.
    await queryInterface.sequelize.query(
      'UPDATE quotas SET fcr_percentagem = ROUND(valor_fcr / valor_base * 100, 2) WHERE fcr_percentagem IS NULL AND valor_base > 0 AND valor_fcr IS NOT NULL'
    );
    await queryInterface.sequelize.query(
      'UPDATE quotas SET fcr_percentagem = 0 WHERE fcr_percentagem IS NULL'
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('quotas', 'fcr_percentagem');
    await queryInterface.removeColumn('quotas', 'permilagem_aplicada');
    await queryInterface.removeColumn('quotas', 'valor_por_1000');
  },
};
