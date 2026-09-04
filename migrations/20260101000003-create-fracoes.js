'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'fracoes',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        designacao: { type: Sequelize.STRING(120), allowNull: false },
        permilagem: { type: Sequelize.DECIMAL(7, 2), allowNull: true },
        andar: { type: Sequelize.STRING(60), allowNull: true },
        observacoes: { type: Sequelize.TEXT, allowNull: true },
        estado: {
          type: Sequelize.ENUM('ativo', 'inativo'),
          allowNull: false,
          defaultValue: 'ativo',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('fracoes');
  },
};
