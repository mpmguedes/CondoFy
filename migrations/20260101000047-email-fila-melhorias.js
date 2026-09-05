'use strict';

// Melhorias à fila de email:
//  · estado "a_enviar" (envio em curso — evita re-processamento);
//  · tipo normal/teste (o teste nunca entra no fluxo normal da fila);
//  · message_id do fornecedor SMTP;
//  · corpo_html opcional (a fila envia HTML/plano corretamente).

module.exports = {
  async up(queryInterface, Sequelize) {
    // Estado adicionado: 'a_enviar'
    await queryInterface.changeColumn('email_fila', 'estado', {
      type: Sequelize.ENUM('pendente', 'a_enviar', 'enviado', 'erro', 'cancelado'),
      allowNull: false,
      defaultValue: 'pendente',
    });
    await queryInterface.addColumn('email_fila', 'tipo', {
      type: Sequelize.ENUM('normal', 'teste'),
      allowNull: false,
      defaultValue: 'normal',
    });
    await queryInterface.addColumn('email_fila', 'corpo_html', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('email_fila', 'message_id', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('email_fila', 'message_id');
    await queryInterface.removeColumn('email_fila', 'corpo_html');
    await queryInterface.removeColumn('email_fila', 'tipo');
    await queryInterface.changeColumn('email_fila', 'estado', {
      type: Sequelize.ENUM('pendente', 'enviado', 'erro', 'cancelado'),
      allowNull: false,
      defaultValue: 'pendente',
    });
  },
};
