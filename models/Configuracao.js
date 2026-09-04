const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Configuracao = sequelize.define(
    'Configuracao',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      chave: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      valor: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: 'configuracoes', underscored: true }
  );
  return Configuracao;
};
