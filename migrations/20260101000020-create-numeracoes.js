'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'numeracoes',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        tipo_documento: {
          type: Sequelize.ENUM('aviso_quota', 'recibo', 'despesa', 'documento_interno', 'outro'),
          allowNull: false,
        },
        ano: { type: Sequelize.INTEGER, allowNull: false },
        sequencia: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        formato: { type: Sequelize.STRING(60), allowNull: false, defaultValue: '{ano}/{sequencia}' },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('numeracoes', ['tipo_documento', 'ano'], {
      unique: true,
      name: 'numeracoes_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('numeracoes');
  },
};
