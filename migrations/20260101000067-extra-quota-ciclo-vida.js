'use strict';

// Quotas Extra — ciclo de vida: aprovação e processamento.
//
// estado passa de ENUM('ativa','anulada') para
// ENUM('pendente','aprovada','processada','anulada'):
//  · 'pendente'   — criada, aguarda aprovação (não cobrável);
//  · 'aprovada'   — autorizada para cobrança, aguarda processamento;
//  · 'processada' — pronta para cobrança (parcelas elegíveis para aviso/pagamento);
//  · 'anulada'    — histórico, não cobrável.
// Campos novos registam quem/quando aprovou e processou (auditoria).
//
// Compatibilidade: registos existentes ('ativa' = cobráveis no fluxo antigo)
// são migrados para 'processada' — continuam elegíveis, sem inventar dados.
// Idempotente/seguro: nenhuma eliminação.

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Alarga o ENUM mantendo 'ativa' (para não invalidar dados existentes).
    await queryInterface.changeColumn('extra_quotas', 'estado', {
      type: Sequelize.ENUM('ativa', 'pendente', 'aprovada', 'processada', 'anulada'),
      allowNull: false,
      defaultValue: 'pendente',
    });
    // 2. Migra o valor antigo (ativas = já em cobrança) para 'processada'.
    await queryInterface.sequelize.query(
      "UPDATE extra_quotas SET estado = 'processada' WHERE estado = 'ativa'"
    );
    // 3. Remove 'ativa' do ENUM (deixa de existir como estado de escrita).
    await queryInterface.changeColumn('extra_quotas', 'estado', {
      type: Sequelize.ENUM('pendente', 'aprovada', 'processada', 'anulada'),
      allowNull: false,
      defaultValue: 'pendente',
    });
    // 4. Auditoria: quem/quando aprovou e processou.
    await queryInterface.addColumn('extra_quotas', 'aprovado_por', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn('extra_quotas', 'aprovado_em', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.addColumn('extra_quotas', 'processado_por', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn('extra_quotas', 'processado_em', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('extra_quotas', 'processado_em').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'processado_por').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'aprovado_em').catch(() => {});
    await queryInterface.removeColumn('extra_quotas', 'aprovado_por').catch(() => {});
    await queryInterface.changeColumn('extra_quotas', 'estado', {
      type: Sequelize.ENUM('ativa', 'pendente', 'aprovada', 'processada', 'anulada'),
      allowNull: false,
      defaultValue: 'ativa',
    });
    await queryInterface.sequelize.query(
      "UPDATE extra_quotas SET estado = 'ativa' WHERE estado <> 'anulada'"
    );
    await queryInterface.changeColumn('extra_quotas', 'estado', {
      type: Sequelize.ENUM('ativa', 'anulada'),
      allowNull: false,
      defaultValue: 'ativa',
    });
  },
};
