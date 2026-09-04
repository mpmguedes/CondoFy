const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FracaoPessoa = sequelize.define(
    'FracaoPessoa',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      vinculo: {
        type: DataTypes.ENUM('proprietario', 'arrendatario', 'usufrutuario'),
        allowNull: false,
        defaultValue: 'proprietario',
      },
      data_inicio: { type: DataTypes.DATEONLY, allowNull: true },
      data_fim: { type: DataTypes.DATEONLY, allowNull: true },
    },
    {
      tableName: 'fracao_pessoas',
      underscored: true,
      indexes: [{ unique: true, fields: ['fracao_id', 'pessoa_id', 'vinculo'] }],
    }
  );
  return FracaoPessoa;
};
