'use strict';

// Quotas Extraordinárias: despesas pontuais distribuídas pelas frações com parcelamento.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('extra_quotas', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
      },
      designacao: { type: Sequelize.STRING(191), allowNull: false },
      valor_total: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      metodo_divisao: {
        type: Sequelize.ENUM('permilagem', 'igual'),
        allowNull: false,
        defaultValue: 'permilagem',
      },
      mes_inicio: { type: Sequelize.INTEGER, allowNull: false },
      ano_inicio: { type: Sequelize.INTEGER, allowNull: false },
      numero_parcelas: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      periodicidade: {
        type: Sequelize.ENUM('mensal', 'bimestral', 'trimestral', 'semestral', 'anual'),
        allowNull: false,
        defaultValue: 'mensal',
      },
      estado: {
        type: Sequelize.ENUM('ativa', 'anulada'),
        allowNull: false,
        defaultValue: 'ativa',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('extra_quotas');
  },
};
