'use strict';

// Many-to-many Documento ↔ Categoria. As categorias de documentos usam o tipo
// 'documento' na tabela categorias (mantém-se o catálogo partilhado do operador).

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('categorias', 'tipo', {
      type: Sequelize.ENUM('despesa', 'receita', 'documento'),
      allowNull: false,
      defaultValue: 'despesa',
    });
    await queryInterface.createTable('documento_categorias', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      documento_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      categoria_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('documento_categorias', ['documento_id']);
    await queryInterface.addIndex('documento_categorias', ['categoria_id']);
    await queryInterface.addIndex('documento_categorias', ['documento_id', 'categoria_id'], { unique: true });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('documento_categorias');
    await queryInterface.changeColumn('categorias', 'tipo', {
      type: Sequelize.ENUM('despesa', 'receita'),
      allowNull: false,
      defaultValue: 'despesa',
    });
  },
};
