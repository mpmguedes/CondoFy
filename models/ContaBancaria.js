const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ContaBancaria = sequelize.define(
    'ContaBancaria',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      nome: { type: DataTypes.STRING(120), allowNull: false },
      banco: { type: DataTypes.STRING(120), allowNull: true },
      iban: { type: DataTypes.STRING(40), allowNull: true },
      tipo: {
        type: DataTypes.ENUM('corrente', 'poupanca', 'fundo_reserva', 'outro'),
        allowNull: false,
        defaultValue: 'corrente',
      },
      saldo_inicial: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      data_inicio: { type: DataTypes.DATEONLY, allowNull: true },
      data_saldo_inicial: { type: DataTypes.DATEONLY, allowNull: true },
      ativa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'contas_bancarias', underscored: true }
  );
  return ContaBancaria;
};
