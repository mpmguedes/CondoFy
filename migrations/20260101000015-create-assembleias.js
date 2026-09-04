'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'assembleias',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        data: { type: Sequelize.DATEONLY, allowNull: true },
        hora: { type: Sequelize.STRING(10), allowNull: true },
        local: { type: Sequelize.STRING(255), allowNull: true },
        ordem_trabalhos: { type: Sequelize.TEXT, allowNull: true },
        estado: {
          type: Sequelize.ENUM('agendada', 'convocada', 'realizada', 'cancelada'),
          allowNull: false,
          defaultValue: 'agendada',
        },
        convocatoria_documento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'documentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        ata_documento_id: {
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
    await queryInterface.dropTable('assembleias');
  },
};
