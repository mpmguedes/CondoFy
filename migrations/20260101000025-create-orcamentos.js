'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'orcamentos',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        designacao: { type: Sequelize.STRING(120), allowNull: false },
        data_inicio: { type: Sequelize.DATEONLY, allowNull: false },
        data_fim: { type: Sequelize.DATEONLY, allowNull: false },
        estado: {
          type: Sequelize.ENUM('rascunho', 'aprovado', 'em_execucao', 'encerrado', 'anulado'),
          allowNull: false,
          defaultValue: 'rascunho',
        },
        data_aprovacao: { type: Sequelize.DATEONLY, allowNull: true },
        aprovado_por: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        observacoes: { type: Sequelize.TEXT, allowNull: true },
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
    await queryInterface.dropTable('orcamentos');
  },
};
