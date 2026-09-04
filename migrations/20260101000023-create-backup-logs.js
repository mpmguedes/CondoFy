'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'backup_logs',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        tipo: {
          type: Sequelize.ENUM('diario', 'semanal', 'mensal', 'manual'),
          allowNull: false,
          defaultValue: 'manual',
        },
        data: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        estado: {
          type: Sequelize.ENUM('concluido', 'erro', 'em_curso'),
          allowNull: false,
          defaultValue: 'em_curso',
        },
        ficheiro_drive_id: { type: Sequelize.STRING(191), allowNull: true },
        tamanho: { type: Sequelize.BIGINT, allowNull: true },
        erro: { type: Sequelize.TEXT, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('backup_logs');
  },
};
