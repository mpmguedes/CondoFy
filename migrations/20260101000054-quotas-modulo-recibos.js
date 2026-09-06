'use strict';

// Módulo Quotas — recibos formais (RCP) + valores transitados + comprovativos.
//  · recibos: recibos emitidos por fração (código único RCP-ANO-NNNN), com
//    histórico: anular não elimina o registo, apenas marca estado='anulado';
//  · recibo_quotas: meses (quotas) abrangidos por cada recibo — um mês coberto
//    por um recibo válido não volta a ser emitível até o recibo ser anulado;
//  · fracoes.transitado: saldo transitado no arranque/configuração do sistema
//    (positivo = a favor do condomínio / dívida da fração);
//  · pagamentos.comprovativo_*: ficheiro de comprovativo anexo ao pagamento
//    com validação (pendente/validado/rejeitado);
//  · numeracoes: novo tipo 'recibo_mensal' para a sequência RCP dos recibos.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'recibos',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        fracao_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'fracoes', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        codigo: { type: Sequelize.STRING(40), allowNull: false, unique: true },
        numero: { type: Sequelize.STRING(12), allowNull: false },
        ano: { type: Sequelize.INTEGER, allowNull: false },
        tipo: {
          type: Sequelize.ENUM('ordinario', 'extraordinario'),
          allowNull: false,
          defaultValue: 'ordinario',
        },
        valor: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        data_emissao: { type: Sequelize.DATEONLY, allowNull: true },
        estado: {
          type: Sequelize.ENUM('emitido', 'anulado'),
          allowNull: false,
          defaultValue: 'emitido',
        },
        motivo_anulacao: { type: Sequelize.TEXT, allowNull: true },
        enviado_at: { type: Sequelize.DATE, allowNull: true },
        created_by: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('recibos', ['fracao_id']);
    await queryInterface.addIndex('recibos', ['ano']);

    await queryInterface.createTable(
      'recibo_quotas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        recibo_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'recibos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        quota_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'quotas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        valor: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        valor_base: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
        valor_fcr: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('recibo_quotas', ['quota_id']);
    await queryInterface.addIndex('recibo_quotas', ['recibo_id', 'quota_id'], { unique: true });

    // Valores transitados por fração (positivo = dívida transitada).
    await queryInterface.addColumn('fracoes', 'transitado', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('fracoes', 'porta', {
      type: Sequelize.STRING(60),
      allowNull: true,
    });

    // Comprovativo de pagamento (anexo + validação).
    await queryInterface.addColumn('pagamentos', 'comprovativo_ficheiro', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('pagamentos', 'comprovativo_nome', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('pagamentos', 'comprovativo_mime', {
      type: Sequelize.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('pagamentos', 'comprovativo_estado', {
      type: Sequelize.ENUM('pendente', 'validado', 'rejeitado'),
      allowNull: true,
    });
    await queryInterface.addColumn('pagamentos', 'comprovativo_motivo', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('pagamentos', 'comprovativo_data', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    // Sequência própria dos recibos (RCP) — não interfere com a numeração
    // dos pagamentos/recibos antigos ('recibo').
    await queryInterface.sequelize.query(
      "ALTER TABLE numeracoes MODIFY COLUMN tipo_documento ENUM('aviso_quota','recibo','despesa','documento_interno','outro','recibo_mensal') NOT NULL"
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "ALTER TABLE numeracoes MODIFY COLUMN tipo_documento ENUM('aviso_quota','recibo','despesa','documento_interno','outro') NOT NULL"
    );
    await queryInterface.removeColumn('pagamentos', 'comprovativo_data');
    await queryInterface.removeColumn('pagamentos', 'comprovativo_motivo');
    await queryInterface.removeColumn('pagamentos', 'comprovativo_estado');
    await queryInterface.removeColumn('pagamentos', 'comprovativo_mime');
    await queryInterface.removeColumn('pagamentos', 'comprovativo_nome');
    await queryInterface.removeColumn('pagamentos', 'comprovativo_ficheiro');
    await queryInterface.removeColumn('fracoes', 'porta');
    await queryInterface.removeColumn('fracoes', 'transitado');
    await queryInterface.dropTable('recibo_quotas');
    await queryInterface.dropTable('recibos');
  },
};
