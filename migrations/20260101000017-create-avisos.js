'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'avisos',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        tipo: {
          type: Sequelize.ENUM('manual', 'automatico', 'programado'),
          allowNull: false,
          defaultValue: 'manual',
        },
        assunto: { type: Sequelize.STRING(255), allowNull: false },
        mensagem: { type: Sequelize.TEXT, allowNull: true },
        documento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'documentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        data_programada: { type: Sequelize.DATEONLY, allowNull: true },
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
    await queryInterface.dropTable('avisos');
  },
};
