'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'assembleia_participantes',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        assembleia_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'assembleias', key: 'id' },
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
        presente: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        permilagem: { type: Sequelize.DECIMAL(7, 2), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('assembleia_participantes');
  },
};
