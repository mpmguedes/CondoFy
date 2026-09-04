'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'documentos',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        tipo: {
          type: Sequelize.ENUM(
            'aviso_quota',
            'recibo',
            'ata',
            'convocatoria',
            'relatorio',
            'fatura',
            'contrato',
            'orcamento',
            'outro'
          ),
          allowNull: false,
          defaultValue: 'outro',
        },
        numero_documento: { type: Sequelize.STRING(40), allowNull: true },
        nome: { type: Sequelize.STRING(255), allowNull: false },
        drive_file_id: { type: Sequelize.STRING(191), allowNull: true },
        mime_type: { type: Sequelize.STRING(120), allowNull: true },
        tamanho: { type: Sequelize.BIGINT, allowNull: true },
        data: { type: Sequelize.DATEONLY, allowNull: true },
        entidade_tipo: { type: Sequelize.STRING(60), allowNull: true },
        entidade_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
        url: { type: Sequelize.STRING(500), allowNull: true },
        created_by: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'users', key: 'id' },
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
    await queryInterface.dropTable('documentos');
  },
};
