'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contas_bancarias', 'data_inicio', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.addColumn('contas_bancarias', 'data_saldo_inicial', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('contas_bancarias', 'data_saldo_inicial');
    await queryInterface.removeColumn('contas_bancarias', 'data_inicio');
  },
};
