'use strict';

// EmailFila — suporte a anexos persistidos (PDF por destinatário).
// O ficheiro é guardado localmente (pasta privada) quando o email é
// enfileirado e anexado no momento do envio, sem depender do Drive.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('email_fila', 'anexo_nome', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('email_fila', 'anexo_caminho', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('email_fila', 'anexo_caminho');
    await queryInterface.removeColumn('email_fila', 'anexo_nome');
  },
};
