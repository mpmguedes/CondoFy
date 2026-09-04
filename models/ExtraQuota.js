const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ExtraQuota = sequelize.define(
    'ExtraQuota',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      designacao: { type: DataTypes.STRING(191), allowNull: false },
      valor_total: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      metodo_divisao: {
        type: DataTypes.ENUM('permilagem', 'igual'),
        allowNull: false,
        defaultValue: 'permilagem',
      },
      mes_inicio: { type: DataTypes.INTEGER, allowNull: false },
      ano_inicio: { type: DataTypes.INTEGER, allowNull: false },
      numero_parcelas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      periodicidade: {
        type: DataTypes.ENUM('mensal', 'bimestral', 'trimestral', 'semestral', 'anual'),
        allowNull: false,
        defaultValue: 'mensal',
      },
      estado: {
        type: DataTypes.ENUM('ativa', 'anulada'),
        allowNull: false,
        defaultValue: 'ativa',
      },
    },
    { tableName: 'extra_quotas', underscored: true }
  );
  return ExtraQuota;
};
