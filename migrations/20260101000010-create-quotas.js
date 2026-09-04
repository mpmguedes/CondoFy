'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'quotas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        numero_documento: { type: Sequelize.STRING(40), allowNull: true, unique: true },
        fracao_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'fracoes', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        ano: { type: Sequelize.INTEGER, allowNull: false },
        mes: { type: Sequelize.INTEGER, allowNull: false },
        periodo: { type: Sequelize.DATEONLY, allowNull: true },
        valor: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        data_emissao: { type: Sequelize.DATEONLY, allowNull: true },
        data_vencimento: { type: Sequelize.DATEONLY, allowNull: true },
        estado: {
          type: Sequelize.ENUM('pendente', 'parcialmente_paga', 'paga', 'vencida', 'anulada'),
          allowNull: false,
          defaultValue: 'pendente',
        },
        observacoes: { type: Sequelize.TEXT, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('quotas', ['fracao_id', 'ano', 'mes'], {
      unique: true,
      name: 'quotas_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('quotas');
  },
};
