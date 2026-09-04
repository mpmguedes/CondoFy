const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AssembleiaParticipante = sequelize.define(
    'AssembleiaParticipante',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      assembleia_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      presente: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      permilagem: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
    },
    { tableName: 'assembleia_participantes', underscored: true }
  );
  return AssembleiaParticipante;
};
