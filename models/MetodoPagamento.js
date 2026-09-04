const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const MetodoPagamento = sequelize.define(
    'MetodoPagamento',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      nome: { type: DataTypes.STRING(120), allowNull: false },
      ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'metodos_pagamento', underscored: true }
  );
  return MetodoPagamento;
};
