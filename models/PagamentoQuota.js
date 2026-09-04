const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PagamentoQuota = sequelize.define(
    'PagamentoQuota',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      pagamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      quota_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      valor_aplicado: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    },
    { tableName: 'pagamento_quotas', underscored: true }
  );
  return PagamentoQuota;
};
