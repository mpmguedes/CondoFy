'use strict';

// Parcelas individuais de cada fração dentro de uma quota extra.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('extra_quota_parcelas', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
      },
      extra_quota_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      parcela_numero: { type: Sequelize.INTEGER, allowNull: false },
      valor: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      data_vencimento: { type: Sequelize.DATEONLY, allowNull: true },
      estado: {
        type: Sequelize.ENUM('pendente', 'paga', 'anulada'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      valor_pago: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('extra_quota_parcelas', ['extra_quota_id', 'fracao_id', 'parcela_numero'], {
      unique: true,
      name: 'uq_extra_parcela_fracao_numero',
    });
    await queryInterface.addConstraint('extra_quota_parcelas', {
      fields: ['extra_quota_id'],
      type: 'foreign key',
      name: 'fk_extra_parcela_extra_quota',
      references: { table: 'extra_quotas', field: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addConstraint('extra_quota_parcelas', {
      fields: ['fracao_id'],
      type: 'foreign key',
      name: 'fk_extra_parcela_fracao',
      references: { table: 'fracoes', field: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('extra_quota_parcelas');
  },
};
