'use strict';

// 2FA por código de email + códigos de recuperação (hash) — colunas em users.
// Ativação só depois de validar um código gerado; recuperação por códigos únicos
// mostrados uma única vez na ativação.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'two_fa_ativo', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('users', 'two_fa_metodo', {
      type: Sequelize.ENUM('email'),
      allowNull: false,
      defaultValue: 'email',
    });
    // Código de email atual (hash SHA-256), expiração e tentativas.
    await queryInterface.addColumn('users', 'two_fa_email_codigo_hash', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'two_fa_email_codigo_expira', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'two_fa_email_tentativas', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    // Códigos de recuperação guardados como hashes SHA-256 (separados por '|').
    await queryInterface.addColumn('users', 'two_fa_recovery_hash', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'two_fa_recovery_hash');
    await queryInterface.removeColumn('users', 'two_fa_email_tentativas');
    await queryInterface.removeColumn('users', 'two_fa_email_codigo_expira');
    await queryInterface.removeColumn('users', 'two_fa_email_codigo_hash');
    await queryInterface.removeColumn('users', 'two_fa_metodo');
    await queryInterface.removeColumn('users', 'two_fa_ativo');
  },
};
