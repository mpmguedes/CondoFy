const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ReciboQuota = sequelize.define(
    'ReciboQuota',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      recibo_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      quota_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      valor: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      valor_base: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      valor_fcr: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    },
    {
      tableName: 'recibo_quotas',
      underscored: true,
      indexes: [{ fields: ['quota_id'] }, { unique: true, fields: ['recibo_id', 'quota_id'] }],
    }
  );
  return ReciboQuota;
};
