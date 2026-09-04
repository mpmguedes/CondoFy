const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ExtraQuotaParcela = sequelize.define(
    'ExtraQuotaParcela',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      extra_quota_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      parcela_numero: { type: DataTypes.INTEGER, allowNull: false },
      valor: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      data_vencimento: { type: DataTypes.DATEONLY, allowNull: true },
      estado: {
        type: DataTypes.ENUM('pendente', 'paga', 'anulada'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      valor_pago: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'extra_quota_parcelas',
      underscored: true,
      indexes: [{ unique: true, fields: ['extra_quota_id', 'fracao_id', 'parcela_numero'] }],
    }
  );
  return ExtraQuotaParcela;
};
