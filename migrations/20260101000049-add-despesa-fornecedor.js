'use strict';

// Liga a Despesa a um Fornecedor (estruturado) mantendo o campo de texto
// legado `fornecedor` para compatibilidade de apresentação.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('despesas', 'fornecedor_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'fornecedores', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('despesas', ['fornecedor_id']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('despesas', 'despesas_fornecedor_id');
    await queryInterface.removeColumn('despesas', 'fornecedor_id');
  },
};
