'use strict';

// Liga movimentos bancários a parcelas de quotas extraordinárias.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('movimentos_bancarios', 'extra_quota_parcela_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('movimentos_bancarios', 'extra_quota_parcela_id');
  },
};
