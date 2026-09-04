const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AuditLog = sequelize.define(
    'AuditLog',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      data_hora: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      acao: { type: DataTypes.STRING(120), allowNull: false },
      entidade: { type: DataTypes.STRING(120), allowNull: true },
      entidade_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      detalhes: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: 'audit_logs', underscored: true }
  );
  return AuditLog;
};
