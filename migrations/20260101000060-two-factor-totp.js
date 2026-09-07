'use strict';

// 2FA — segunda opção: Aplicação autenticadora (TOTP, RFC 6238).
// Aditivo e seguro: não altera nada das migrações já aplicadas.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'two_fa_totp_secret', {
      type: Sequelize.STRING(64),
      allowNull: true,
      comment: 'Segredo TOTP (Base32) da aplicação autenticadora',
    });
    await queryInterface.changeColumn('users', 'two_fa_metodo', {
      type: Sequelize.ENUM('email', 'totp'),
      allowNull: false,
      defaultValue: 'email',
    });
  },

  async down(queryInterface) {
    await queryInterface.changeColumn('users', 'two_fa_metodo', {
      type: Sequelize.ENUM('email'),
      allowNull: false,
      defaultValue: 'email',
    });
    await queryInterface.removeColumn('users', 'two_fa_totp_secret');
  },
};
