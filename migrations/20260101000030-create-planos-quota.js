'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'planos_quota',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        orcamento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'orcamentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        fracao_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'fracoes', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        ano: { type: Sequelize.INTEGER, allowNull: false },
        mes: { type: Sequelize.INTEGER, allowNull: false },
        valor: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        data_vencimento: { type: Sequelize.DATEONLY, allowNull: true },
        estado: {
          type: Sequelize.ENUM('planeada', 'emitida', 'cancelada'),
          allowNull: false,
          defaultValue: 'planeada',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('planos_quota', ['orcamento_id', 'fracao_id', 'ano', 'mes'], {
      unique: true,
      name: 'planos_quota_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('planos_quota');
  },
};
