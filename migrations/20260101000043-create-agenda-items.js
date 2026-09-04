'use strict';

// Itens da ordem de trabalhos de uma assembleia (pontos ordenados, com
// indicação de sujeição a votação). Substitui o campo de texto livre.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('agenda_items', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
      },
      assembleia_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'assembleias', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      ordem: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      descricao: { type: Sequelize.STRING(255), allowNull: false },
      sujeito_votacao: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('agenda_items');
  },
};
