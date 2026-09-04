'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'aviso_destinatarios',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        aviso_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'avisos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        fracao_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'fracoes', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        pessoa_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'pessoas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        user_id: {
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
    await queryInterface.dropTable('aviso_destinatarios');
  },
};
