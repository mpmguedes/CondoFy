const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Fracao = sequelize.define(
    'Fracao',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      designacao: { type: DataTypes.STRING(120), allowNull: false },
      permilagem: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      andar: { type: DataTypes.STRING(60), allowNull: true },
      porta: { type: DataTypes.STRING(60), allowNull: true },
      // Saldo transitado no arranque/configuração (positivo = a favor do
      // condomínio — dívida da fração; negativo = crédito a favor da fração).
      transitado: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
      estado: {
        type: DataTypes.ENUM('ativo', 'inativo'),
        allowNull: false,
        defaultValue: 'ativo',
      },
    },
    { tableName: 'fracoes', underscored: true }
  );
  return Fracao;
};
