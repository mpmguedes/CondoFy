const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Categoria = sequelize.define(
    'Categoria',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      nome: { type: DataTypes.STRING(120), allowNull: false },
      tipo: {
        type: DataTypes.ENUM('despesa', 'receita'),
        allowNull: false,
        defaultValue: 'despesa',
      },
      ativa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'categorias', underscored: true }
  );
  return Categoria;
};
