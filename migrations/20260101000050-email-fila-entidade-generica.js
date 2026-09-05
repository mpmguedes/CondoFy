'use strict';

// Campos genéricos na fila de email:
//  · entidade_tipo/entidade_id → associação a QUALQUER entidade
//    (ex.: Quota, Recibo/Pagamento, Fornecedor, Despesa) sem criar novas
//    tabelas de envio — o EmailFila é o histórico único de envios.
//  · user_id → quem iniciou o envio (para mostrar "por Utilizador").
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('email_fila', 'entidade_tipo', {
      type: Sequelize.STRING(60),
      allowNull: true,
    });
    await queryInterface.addColumn('email_fila', 'entidade_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn('email_fila', 'user_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('email_fila', ['entidade_tipo', 'entidade_id']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('email_fila', 'email_fila_entidade_tipo_entidade_id');
    await queryInterface.removeColumn('email_fila', 'user_id');
    await queryInterface.removeColumn('email_fila', 'entidade_id');
    await queryInterface.removeColumn('email_fila', 'entidade_tipo');
  },
};
