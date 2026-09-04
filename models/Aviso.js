const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Aviso = sequelize.define(
    'Aviso',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      tipo: {
        type: DataTypes.ENUM('manual', 'automatico', 'programado'),
        allowNull: false,
        defaultValue: 'manual',
      },
      assunto: { type: DataTypes.STRING(255), allowNull: false },
      mensagem: { type: DataTypes.TEXT, allowNull: true },
      documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      data_programada: { type: DataTypes.DATEONLY, allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'avisos', underscored: true }
  );
  return Aviso;
};
