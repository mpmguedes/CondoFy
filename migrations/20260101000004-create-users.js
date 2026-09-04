'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'users',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        email: { type: Sequelize.STRING(191), allowNull: false, unique: true },
        password_hash: { type: Sequelize.STRING(255), allowNull: true },
        nome: { type: Sequelize.STRING(191), allowNull: false },
        role: {
          type: Sequelize.ENUM('admin', 'condomino'),
          allowNull: false,
          defaultValue: 'condomino',
        },
        provider: {
          type: Sequelize.ENUM('local', 'google'),
          allowNull: false,
          defaultValue: 'local',
        },
        google_id: { type: Sequelize.STRING(191), allowNull: true },
        pessoa_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'pessoas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        ativo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        reset_token: { type: Sequelize.STRING(255), allowNull: true },
        reset_token_expires: { type: Sequelize.DATE, allowNull: true },
        last_login_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('users');
  },
};
