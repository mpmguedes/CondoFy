const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ReciboExtraParcela = sequelize.define(
    'ReciboExtraParcela',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      recibo_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      extra_quota_parcela_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      valor: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'recibo_extra_parcelas',
      underscored: true,
      indexes: [{ unique: true, fields: ['recibo_id', 'extra_quota_parcela_id'] }],
    }
  );
  return ReciboExtraParcela;
};
