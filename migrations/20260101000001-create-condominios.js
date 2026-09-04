'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'condominios',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        designacao: { type: Sequelize.STRING(191), allowNull: false },
        nif: { type: Sequelize.STRING(20), allowNull: true },
        morada: { type: Sequelize.STRING(255), allowNull: true },
        codigo_postal: { type: Sequelize.STRING(20), allowNull: true },
        localidade: { type: Sequelize.STRING(120), allowNull: true },
        email: { type: Sequelize.STRING(191), allowNull: true },
        telefone: { type: Sequelize.STRING(40), allowNull: true },
        iban_principal: { type: Sequelize.STRING(40), allowNull: true },
        outros_meios_pagamento: { type: Sequelize.TEXT, allowNull: true },
        dados_bancarios_adicionais: { type: Sequelize.TEXT, allowNull: true },
        logotipo: { type: Sequelize.STRING(255), allowNull: true },
        cabecalho_imagem: { type: Sequelize.STRING(255), allowNull: true },
        identidade_visual: {
          type: Sequelize.ENUM('logo', 'designacao'),
          allowNull: false,
          defaultValue: 'designacao',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('condominios');
  },
};
