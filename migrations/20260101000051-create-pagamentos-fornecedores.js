'use strict';

// Pagamentos a fornecedores (com comprovativo registado como Documento).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'pagamentos_fornecedores',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        fornecedor_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'fornecedores', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        despesa_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'despesas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        valor: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        data_pagamento: { type: Sequelize.DATEONLY, allowNull: true },
        metodo_pagamento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'metodos_pagamento', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        conta_bancaria_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'contas_bancarias', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        iban_utilizado: { type: Sequelize.STRING(40), allowNull: true },
        referencia: { type: Sequelize.STRING(120), allowNull: true },
        observacoes: { type: Sequelize.TEXT, allowNull: true },
        estado: {
          type: Sequelize.ENUM('pendente', 'pago', 'cancelado'),
          allowNull: false,
          defaultValue: 'pendente',
        },
        comprovativo_documento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'documentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
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

    // Tipo "comprovativo" disponível no enum de Documento.
    await queryInterface.changeColumn('documentos', 'tipo', {
      type: Sequelize.ENUM(
        'aviso_quota',
        'recibo',
        'ata',
        'convocatoria',
        'relatorio',
        'fatura',
        'contrato',
        'orcamento',
        'comprovativo',
        'outro'
      ),
      allowNull: false,
      defaultValue: 'outro',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('pagamentos_fornecedores');
    await queryInterface.changeColumn('documentos', 'tipo', {
      type: Sequelize.ENUM(
        'aviso_quota',
        'recibo',
        'ata',
        'convocatoria',
        'relatorio',
        'fatura',
        'contrato',
        'orcamento',
        'outro'
      ),
      allowNull: false,
      defaultValue: 'outro',
    });
  },
};
