'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'pessoas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        nome: { type: Sequelize.STRING(191), allowNull: false },
        email: { type: Sequelize.STRING(191), allowNull: true },
        telefone: { type: Sequelize.STRING(40), allowNull: true },
        nif: { type: Sequelize.STRING(20), allowNull: true },
        tipo: {
          type: Sequelize.ENUM('proprietario', 'arrendatario', 'outro'),
          allowNull: false,
          defaultValue: 'proprietario',
        },
        observacoes: { type: Sequelize.TEXT, allowNull: true },
        ativo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('pessoas');
  },
};
