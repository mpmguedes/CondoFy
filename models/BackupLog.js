const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const BackupLog = sequelize.define(
    'BackupLog',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      tipo: {
        type: DataTypes.ENUM('diario', 'semanal', 'mensal', 'manual'),
        allowNull: false,
        defaultValue: 'manual',
      },
      data: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      estado: {
        type: DataTypes.ENUM('concluido', 'erro', 'em_curso'),
        allowNull: false,
        defaultValue: 'em_curso',
      },
      ficheiro_drive_id: { type: DataTypes.STRING(191), allowNull: true },
      tamanho: { type: DataTypes.BIGINT, allowNull: true },
      erro: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: 'backup_logs', underscored: true }
  );
  return BackupLog;
};
