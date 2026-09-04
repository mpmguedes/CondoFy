const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PlanoQuota = sequelize.define(
    'PlanoQuota',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      orcamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      ano: { type: DataTypes.INTEGER, allowNull: false },
      mes: { type: DataTypes.INTEGER, allowNull: false },
      valor: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      data_vencimento: { type: DataTypes.DATEONLY, allowNull: true },
      estado: {
        type: DataTypes.ENUM('planeada', 'emitida', 'cancelada'),
        allowNull: false,
        defaultValue: 'planeada',
      },
    },
    {
      tableName: 'planos_quota',
      underscored: true,
      indexes: [{ unique: true, fields: ['orcamento_id', 'fracao_id', 'ano', 'mes'] }],
    }
  );
  return PlanoQuota;
};
