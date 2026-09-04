'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'pagamentos',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        numero_documento: { type: Sequelize.STRING(40), allowNull: true, unique: true },
        fracao_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'fracoes', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        conta_bancaria_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'contas_bancarias', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        metodo_pagamento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'metodos_pagamento', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        valor: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        data_pagamento: { type: Sequelize.DATEONLY, allowNull: true },
        referencia: { type: Sequelize.STRING(120), allowNull: true },
        observacoes: { type: Sequelize.TEXT, allowNull: true },
        estado: {
          type: Sequelize.ENUM('confirmado', 'anulado'),
          allowNull: false,
          defaultValue: 'confirmado',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('pagamentos');
  },
};
