'use strict';

// Parcelas de Quota Extra — novo estado 'cobrada'.
//
// 'cobrada' = a parcela foi incluída num aviso de cobrança (fica "a cobrar"),
// garantindo que não volta a ser oferecida automaticamente para inclusão em
// avisos posteriores (anti-duplicação). 'paga' continua a desbloquear recibo.
// O estado 'pendente' de parcela significa "disponível para cobrança".
//
// Compatibilidade: estados existentes ('pendente','paga','anulada') mantêm-se.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('extra_quota_parcelas', 'estado', {
      type: Sequelize.ENUM('pendente', 'cobrada', 'paga', 'anulada'),
      allowNull: false,
      defaultValue: 'pendente',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('extra_quota_parcelas', 'estado', {
      type: Sequelize.ENUM('pendente', 'paga', 'anulada'),
      allowNull: false,
      defaultValue: 'pendente',
    });
  },
};
