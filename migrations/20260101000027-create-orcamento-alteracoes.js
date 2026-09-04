'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'orcamento_alteracoes',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        orcamento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'orcamentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        utilizador_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        data_alteracao: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        tipo_alteracao: { type: Sequelize.STRING(60), allowNull: true },
        entidade_alterada: { type: Sequelize.STRING(120), allowNull: true },
        entidade_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
        valor_anterior: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
        valor_novo: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
        justificacao: { type: Sequelize.TEXT, allowNull: true },
        assembleia_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'assembleias', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        documento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'documentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('orcamento_alteracoes');
  },
};
