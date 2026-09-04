'use strict';

// Assembleias: número, tipo (ordinária/extraordinária/urgência) e estado
// inicial "rascunho" (antes de agendada).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('assembleias', 'numero', {
      type: Sequelize.STRING(40),
      allowNull: true,
    });
    await queryInterface.addColumn('assembleias', 'tipo', {
      type: Sequelize.ENUM('ordinaria', 'extraordinaria', 'urgencia'),
      allowNull: false,
      defaultValue: 'ordinaria',
    });

    // Alarga o ENUM de estado para incluir 'rascunho'.
    await queryInterface.sequelize.query(
      "ALTER TABLE assembleias MODIFY COLUMN estado ENUM('rascunho','agendada','convocada','realizada','cancelada') NOT NULL DEFAULT 'rascunho'"
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "ALTER TABLE assembleias MODIFY COLUMN estado ENUM('agendada','convocada','realizada','cancelada') NOT NULL DEFAULT 'agendada'"
    );
    await queryInterface.removeColumn('assembleias', 'tipo');
    await queryInterface.removeColumn('assembleias', 'numero');
  },
};
