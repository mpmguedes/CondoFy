'use strict';

// Visibilidade de documentos na área do Condómino.
// Aditivo: default FALSE (documentos manuais não são públicos); os gerados
// pelo sistema para condóminos (convocatórias/atas/assembleias) são marcados.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('documentos', 'disponivel_condominos', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('documentos', 'disponivel_condominos');
  },
};
