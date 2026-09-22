'use strict';

// Q11 / R10 — o ACERTO de uma quota emitida é um DOCUMENTO NOVO, nunca um
// `UPDATE` da quota original.
//
// `extra_quotas` passa a poder representar explicitamente um acerto:
//  · orcamento_id   — orçamento de origem, quando aplicável (vínculo histórico);
//  · tipo           — 'extraordinaria' (comportamento anterior) | 'acerto';
//  · quota_id       — quota ORIGINAL que o acerto corrige. É uma REFERÊNCIA:
//                     o acerto nunca altera a quota apontada (R10);
//  · justificacao   — motivo da operação (obrigatório na operação de acerto);
//  · valor_anterior — o que a quota valia;
//  · valor_novo     — o que passa a valer (é este o valor a cobrar);
//  · criado_por     — autor/responsável da operação.
//
// Compatibilidade e integridade:
//  · todas as colunas são NULL-áveis ou têm omissão ⇒ os registos existentes
//    ficam com tipo='extraordinaria' e sem vínculo, sem inventar dados;
//  · esta migration NÃO altera nenhum valor histórico (nem quotas, nem
//    `extra_quotas`): só acrescenta colunas e índices.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('extra_quotas', 'tipo', {
      type: Sequelize.ENUM('extraordinaria', 'acerto'),
      allowNull: false,
      defaultValue: 'extraordinaria',
    });
    await queryInterface.addColumn('extra_quotas', 'orcamento_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'orcamentos', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('extra_quotas', 'quota_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'quotas', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('extra_quotas', 'justificacao', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('extra_quotas', 'valor_anterior', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('extra_quotas', 'valor_novo', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('extra_quotas', 'criado_por', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });

    // Índices de consulta: «que acertos existem sobre esta quota?» e «que
    // acertos nasceram deste orçamento?».
    await queryInterface.addIndex('extra_quotas', ['quota_id'], { name: 'extra_quotas_quota_id_idx' });
    await queryInterface.addIndex('extra_quotas', ['orcamento_id'], { name: 'extra_quotas_orcamento_id_idx' });
    await queryInterface.addIndex('extra_quotas', ['tipo'], { name: 'extra_quotas_tipo_idx' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('extra_quotas', 'extra_quotas_tipo_idx').catch(() => {});
    await queryInterface.removeIndex('extra_quotas', 'extra_quotas_orcamento_id_idx').catch(() => {});
    await queryInterface.removeIndex('extra_quotas', 'extra_quotas_quota_id_idx').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'criado_por').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'valor_novo').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'valor_anterior').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'justificacao').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'quota_id').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'orcamento_id').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'tipo').catch(() => {});
  },
};
