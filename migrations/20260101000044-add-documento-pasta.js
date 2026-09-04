'use strict';

// Documentos: acrescenta "pasta" para organizar a biblioteca do condomínio
// (atas, convocatórias, contratos, regulamentos, recibos, seguros, faturas…).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('documentos', 'pasta', {
      type: Sequelize.STRING(60),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('documentos', 'pasta');
  },
};
