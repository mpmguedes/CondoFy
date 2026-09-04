const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Pagamento = sequelize.define(
    'Pagamento',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      numero_documento: { type: DataTypes.STRING(40), allowNull: true, unique: true },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      conta_bancaria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      metodo_pagamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      valor: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      data_pagamento: { type: DataTypes.DATEONLY, allowNull: true },
      referencia: { type: DataTypes.STRING(120), allowNull: true },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
      estado: {
        type: DataTypes.ENUM('confirmado', 'anulado'),
        allowNull: false,
        defaultValue: 'confirmado',
      },
    },
    { tableName: 'pagamentos', underscored: true }
  );
  return Pagamento;
};
