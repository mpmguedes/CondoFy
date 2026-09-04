'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'despesas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        numero_documento: { type: Sequelize.STRING(40), allowNull: true, unique: true },
        descricao: { type: Sequelize.STRING(255), allowNull: false },
        categoria_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'categorias', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        valor: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        data: { type: Sequelize.DATEONLY, allowNull: true },
        competencia_ano: { type: Sequelize.INTEGER, allowNull: true },
        competencia_mes: { type: Sequelize.INTEGER, allowNull: true },
        fornecedor: { type: Sequelize.STRING(191), allowNull: true },
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
        observacoes: { type: Sequelize.TEXT, allowNull: true },
        estado: {
          type: Sequelize.ENUM('registada', 'paga', 'anulada'),
          allowNull: false,
          defaultValue: 'registada',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('despesas');
  },
};
