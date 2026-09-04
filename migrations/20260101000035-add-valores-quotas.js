'use strict';

// Expande quotas para guardar separadamente valor base, FCR e total.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('quotas', 'valor_base', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('quotas', 'valor_fcr', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
    // Backfill: quotas existentes têm base = valor atual e FCR = 0.
    await queryInterface.sequelize.query(
      'UPDATE quotas SET valor_base = valor, valor_fcr = 0 WHERE valor_base IS NULL'
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('quotas', 'valor_fcr');
    await queryInterface.removeColumn('quotas', 'valor_base');
  },
};
