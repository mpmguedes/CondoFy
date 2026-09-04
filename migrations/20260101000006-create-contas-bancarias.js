'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'contas_bancarias',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        nome: { type: Sequelize.STRING(120), allowNull: false },
        banco: { type: Sequelize.STRING(120), allowNull: true },
        iban: { type: Sequelize.STRING(40), allowNull: true },
        tipo: {
          type: Sequelize.ENUM('corrente', 'poupanca', 'fundo_reserva', 'outro'),
          allowNull: false,
          defaultValue: 'corrente',
        },
        saldo_inicial: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        ativa: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('contas_bancarias');
  },
};
