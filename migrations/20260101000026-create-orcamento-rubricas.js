'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'orcamento_rubricas',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        orcamento_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'orcamentos', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        categoria_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'categorias', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        descricao: { type: Sequelize.STRING(191), allowNull: false },
        valor_anual: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        metodo_distribuicao: {
          type: Sequelize.ENUM('permilagem', 'igual', 'valor_fixo'),
          allowNull: false,
          defaultValue: 'permilagem',
        },
        periodicidade: {
          type: Sequelize.ENUM('mensal', 'trimestral', 'semestral', 'anual', 'unica'),
          allowNull: false,
          defaultValue: 'mensal',
        },
        ativo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('orcamento_rubricas');
  },
};
