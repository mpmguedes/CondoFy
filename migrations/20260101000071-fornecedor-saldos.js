'use strict';

// Saldos iniciais/transitados de fornecedores (por condomínio).
//
// Necessidade: o Balancete Financeiro do condomínio tem de apresentar a dívida
// a fornecedores incluindo o que já vinha de exercícios anteriores à
// plataforma. Até aqui só existiam saldos transitados para contas bancárias
// (contas_bancarias.saldo_inicial), orçamentos (orcamentos.saldo_transitado) e
// frações (fracoes.transitado) — nada para fornecedores.
//
// Deliberadamente NÃO se criam faturas fictícias (despesas) nem pagamentos
// fictícios: o saldo de abertura é um registo próprio, com data, valor, tipo e
// descrição, associado a UM fornecedor e a UM condomínio. Todas as queries do
// relatório filtram por condominio_id (isolamento multi-condomínio).
//
// Reversível: o down remove a tabela por completo (nenhum dado pré-existente é
// tocado).

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('fornecedor_saldos', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'condominios', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      fornecedor_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'fornecedores', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // Data a que se reporta o saldo (início do acompanhamento na plataforma).
      data: { type: Sequelize.DATEONLY, allowNull: true },
      // Sempre positivo; o tipo indica se é dívida da nossa parte ou crédito.
      valor: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      tipo: {
        type: Sequelize.ENUM('saldo_inicial', 'saldo_transitado'),
        allowNull: false,
        defaultValue: 'saldo_inicial',
        comment: 'saldo_inicial = abertura; saldo_transitado = transportado de exercício anterior',
      },
      descricao: { type: Sequelize.STRING(255), allowNull: true },
      created_by: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    await queryInterface.addIndex('fornecedor_saldos', ['condominio_id']);
    await queryInterface.addIndex('fornecedor_saldos', ['fornecedor_id']);
    await queryInterface.addIndex('fornecedor_saldos', ['condominio_id', 'fornecedor_id', 'data']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('fornecedor_saldos');
  },
};
