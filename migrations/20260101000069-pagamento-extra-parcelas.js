'use strict';

// Ligação Pagamento ↔ Parcela de Quota Extra (análoga a PagamentoQuota).
//
// Permite pagar Quotas Extra através do sistema de Pagamentos existente
// (número de documento, movimento bancário, histórico e recibos), sem criar
// um sistema paralelo. `estado_anterior` preserva se a parcela estava
// 'pendente' ou 'cobrada' antes do pagamento — ao anular o pagamento, o
// estado original é reposto (uma parcela que tinha sido cobrada num aviso
// volta a 'cobrada', nunca a 'pendente').

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'pagamento_extra_parcelas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        pagamento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'pagamentos', key: 'id' },
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
        valor_aplicado: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        estado_anterior: {
          type: Sequelize.STRING(20),
          allowNull: true,
          comment: "Estado da parcela antes do pagamento ('pendente'|'cobrada')",
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('pagamento_extra_parcelas', ['pagamento_id']);
    await queryInterface.addIndex('pagamento_extra_parcelas', ['extra_quota_parcela_id']);
    await queryInterface.addIndex('pagamento_extra_parcelas', ['pagamento_id', 'extra_quota_parcela_id'], {
      unique: true,
      name: 'uq_pagamento_extra_parcela',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('pagamento_extra_parcelas');
  },
};
