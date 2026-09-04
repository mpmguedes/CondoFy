'use strict';

// Orçamento: adiciona ano (exercício), saldo transitado e método de cálculo
// (Modo A — valor por 1000‰ da configuração; Modo B — orçamento define receita).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orcamentos', 'ano', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('orcamentos', 'saldo_transitado', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('orcamentos', 'metodo_calculo', {
      type: Sequelize.ENUM('modo_a', 'modo_b'),
      allowNull: false,
      defaultValue: 'modo_a',
    });
    await queryInterface.addColumn('orcamentos', 'receita_quotas_prevista', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
    });

    // Backfill: ano = ano de início do período existente.
    await queryInterface.sequelize.query(
      'UPDATE orcamentos SET ano = YEAR(data_inicio) WHERE ano IS NULL'
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('orcamentos', 'receita_quotas_prevista');
    await queryInterface.removeColumn('orcamentos', 'metodo_calculo');
    await queryInterface.removeColumn('orcamentos', 'saldo_transitado');
    await queryInterface.removeColumn('orcamentos', 'ano');
  },
};
