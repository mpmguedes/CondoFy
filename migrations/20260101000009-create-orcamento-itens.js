'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'orcamento_itens',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        ano: { type: Sequelize.INTEGER, allowNull: false },
        categoria_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'categorias', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        valor_orcamentado: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('orcamento_itens', ['ano', 'categoria_id'], {
      unique: true,
      name: 'orcamento_itens_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('orcamento_itens');
  },
};
