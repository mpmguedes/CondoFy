const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AvisoDestinatario = sequelize.define(
    'AvisoDestinatario',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      aviso_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'aviso_destinatarios', underscored: true }
  );
  return AvisoDestinatario;
};
