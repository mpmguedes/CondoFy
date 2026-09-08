const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PagamentoExtraParcela = sequelize.define(
    'PagamentoExtraParcela',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      pagamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      extra_quota_parcela_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      valor_aplicado: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      // Estado da parcela antes do pagamento ('pendente'|'cobrada') — reposto
      // quando o pagamento é anulado.
      estado_anterior: { type: DataTypes.STRING(20), allowNull: true },
    },
    {
      tableName: 'pagamento_extra_parcelas',
      underscored: true,
      indexes: [{ unique: true, fields: ['pagamento_id', 'extra_quota_parcela_id'] }],
    }
  );
  return PagamentoExtraParcela;
};
