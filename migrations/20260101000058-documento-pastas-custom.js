'use strict';

// Pastas personalizadas da biblioteca de documentos, guardadas no condomínio
// como JSON (lista de { key, nome }). A pasta "outros" é obrigatória e faz
// parte das pastas base — nunca é apagável.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('condominios', 'documento_pastas', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'JSON: pastas personalizadas da biblioteca de documentos do condomínio',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('condominios', 'documento_pastas');
  },
};
