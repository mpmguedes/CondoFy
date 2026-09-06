'use strict';

// Contactos flexíveis por condómino (vários emails/telefones).
// Migração segura: copia os valores atuais de pessoas.email/telefone para a
// nova tabela (principal=1, ativo=1) — sem apagar os campos antigos.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'contactos_pessoa',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        pessoa_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'pessoas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        tipo: {
          type: Sequelize.ENUM('telefone', 'email'),
          allowNull: false,
        },
        valor: { type: Sequelize.STRING(255), allowNull: false },
        principal: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        etiqueta: { type: Sequelize.STRING(60), allowNull: true },
        ativo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );

    // Migra os contactos existentes (email e telefone) — nunca os apaga.
    await queryInterface.sequelize.query(
      "INSERT INTO contactos_pessoa (pessoa_id, tipo, valor, principal, etiqueta, ativo, created_at, updated_at) " +
        "SELECT id, 'email', email, 1, NULL, 1, NOW(), NOW() FROM pessoas WHERE email IS NOT NULL AND email <> ''"
    );
    await queryInterface.sequelize.query(
      "INSERT INTO contactos_pessoa (pessoa_id, tipo, valor, principal, etiqueta, ativo, created_at, updated_at) " +
        "SELECT id, 'telefone', telefone, 1, NULL, 1, NOW(), NOW() FROM pessoas WHERE telefone IS NOT NULL AND telefone <> ''"
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('contactos_pessoa');
  },
};
