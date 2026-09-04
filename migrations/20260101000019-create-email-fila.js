'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'email_fila',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        destinatario_email: { type: Sequelize.STRING(191), allowNull: false },
        destinatario_nome: { type: Sequelize.STRING(191), allowNull: true },
        assunto: { type: Sequelize.STRING(255), allowNull: false },
        corpo: { type: Sequelize.TEXT, allowNull: true },
        documento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'documentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        aviso_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'avisos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        estado: {
          type: Sequelize.ENUM('pendente', 'enviado', 'erro', 'cancelado'),
          allowNull: false,
          defaultValue: 'pendente',
        },
        data_prevista: { type: Sequelize.DATEONLY, allowNull: true },
        data_enviada: { type: Sequelize.DATE, allowNull: true },
        erro: { type: Sequelize.TEXT, allowNull: true },
        tentativas: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('email_fila');
  },
};
