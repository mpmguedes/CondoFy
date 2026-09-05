'use strict';

// Fornecedores do condomínio (serviços, faturas, pagamentos).

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'fornecedores',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        nome: { type: Sequelize.STRING(191), allowNull: false },
        nif: { type: Sequelize.STRING(20), allowNull: true },
        morada: { type: Sequelize.STRING(255), allowNull: true },
        codigo_postal: { type: Sequelize.STRING(20), allowNull: true },
        localidade: { type: Sequelize.STRING(120), allowNull: true },
        email: { type: Sequelize.STRING(191), allowNull: true },
        telefone: { type: Sequelize.STRING(40), allowNull: true },
        telemovel: { type: Sequelize.STRING(40), allowNull: true },
        iban: { type: Sequelize.STRING(40), allowNull: true },
        notas: { type: Sequelize.TEXT, allowNull: true },
        ativo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('fornecedores');
  },
};
