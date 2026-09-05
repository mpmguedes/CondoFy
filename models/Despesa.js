const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Despesa = sequelize.define(
    'Despesa',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      numero_documento: { type: DataTypes.STRING(40), allowNull: true, unique: true },
      descricao: { type: DataTypes.STRING(255), allowNull: false },
      categoria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      valor: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      data: { type: DataTypes.DATEONLY, allowNull: true },
      competencia_ano: { type: DataTypes.INTEGER, allowNull: true },
      competencia_mes: { type: DataTypes.INTEGER, allowNull: true },
      fornecedor: { type: DataTypes.STRING(191), allowNull: true },
      fornecedor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      conta_bancaria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      metodo_pagamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
      estado: {
        type: DataTypes.ENUM('registada', 'paga', 'anulada'),
        allowNull: false,
        defaultValue: 'registada',
      },
    },
    { tableName: 'despesas', underscored: true }
  );
  return Despesa;
};
