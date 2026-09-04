'use strict';

// Dados da administração de condomínio (empresa/gestão) usados no cabeçalho
// dos documentos (ex.: convocatória).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('condominios', 'administracao_nome', {
      type: Sequelize.STRING(191),
      allowNull: true,
    });
    await queryInterface.addColumn('condominios', 'website', {
      type: Sequelize.STRING(191),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('condominios', 'website');
    await queryInterface.removeColumn('condominios', 'administracao_nome');
  },
};
