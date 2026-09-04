const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Pessoa = sequelize.define(
    'Pessoa',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      nome: { type: DataTypes.STRING(191), allowNull: false },
      email: { type: DataTypes.STRING(191), allowNull: true },
      telefone: { type: DataTypes.STRING(40), allowNull: true },
      nif: { type: DataTypes.STRING(20), allowNull: true },
      tipo: {
        type: DataTypes.ENUM('proprietario', 'arrendatario', 'outro'),
        allowNull: false,
        defaultValue: 'proprietario',
      },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
      ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'pessoas', underscored: true }
  );
  return Pessoa;
};
