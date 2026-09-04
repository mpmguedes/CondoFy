const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Assembleia = sequelize.define(
    'Assembleia',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      data: { type: DataTypes.DATEONLY, allowNull: true },
      hora: { type: DataTypes.STRING(10), allowNull: true },
      local: { type: DataTypes.STRING(255), allowNull: true },
      ordem_trabalhos: { type: DataTypes.TEXT, allowNull: true },
      estado: {
        type: DataTypes.ENUM('agendada', 'convocada', 'realizada', 'cancelada'),
        allowNull: false,
        defaultValue: 'agendada',
      },
      ata_texto: { type: DataTypes.TEXT, allowNull: true },
      convocatoria_documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      ata_documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'assembleias', underscored: true }
  );
  return Assembleia;
};
