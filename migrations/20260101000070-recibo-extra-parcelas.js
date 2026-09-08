'use strict';

// Ligação Recibo ↔ Parcela de Quota Extra (análoga a ReciboQuota).
//
// Permite que um recibo (RCP-ANO-NNNN) discrimine valores de Quotas Extra:
// cada linha do recibo corresponde a uma quota normal (ReciboQuota) ou a uma
// parcela de quota extra (ReciboExtraParcela) com o seu valor, mantendo a
// soma sempre igual ao valor total do recibo.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'recibo_extra_parcelas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        recibo_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'recibos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        extra_quota_parcela_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'extra_quota_parcelas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        valor: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('recibo_extra_parcelas', ['recibo_id']);
    await queryInterface.addIndex('recibo_extra_parcelas', ['extra_quota_parcela_id']);
    await queryInterface.addIndex('recibo_extra_parcelas', ['recibo_id', 'extra_quota_parcela_id'], {
      unique: true,
      name: 'uq_recibo_extra_parcela',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('recibo_extra_parcelas');
  },
};
