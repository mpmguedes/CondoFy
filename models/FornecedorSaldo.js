const { DataTypes } = require('sequelize');

// Saldo inicial/transitado de um fornecedor para com um condomínio.
// Substitui a prática de criar faturas fictícias para transportar dívida de
// exercícios anteriores: é um registo próprio, datado, com tipo e descrição.
module.exports = (sequelize) => {
  const FornecedorSaldo = sequelize.define(
    'FornecedorSaldo',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fornecedor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      data: { type: DataTypes.DATEONLY, allowNull: true },
      valor: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      tipo: {
        type: DataTypes.ENUM('saldo_inicial', 'saldo_transitado'),
        allowNull: false,
        defaultValue: 'saldo_inicial',
      },
      descricao: { type: DataTypes.STRING(255), allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'fornecedor_saldos', underscored: true }
  );
  return FornecedorSaldo;
};
