const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Fornecedor = sequelize.define(
    'Fornecedor',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      nome: { type: DataTypes.STRING(191), allowNull: false },
      nif: { type: DataTypes.STRING(20), allowNull: true },
      morada: { type: DataTypes.STRING(255), allowNull: true },
      codigo_postal: { type: DataTypes.STRING(20), allowNull: true },
      localidade: { type: DataTypes.STRING(120), allowNull: true },
      email: { type: DataTypes.STRING(191), allowNull: true },
      telefone: { type: DataTypes.STRING(40), allowNull: true },
      telemovel: { type: DataTypes.STRING(40), allowNull: true },
      iban: { type: DataTypes.STRING(40), allowNull: true },
      notas: { type: DataTypes.TEXT, allowNull: true },
      ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'fornecedores', underscored: true }
  );
  return Fornecedor;
};
