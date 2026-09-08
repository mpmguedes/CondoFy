const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ExtraQuota = sequelize.define(
    'ExtraQuota',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
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
        type: DataTypes.ENUM('pendente', 'aprovada', 'processada', 'anulada'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      // Auditoria do ciclo de vida (quem/quando aprovou e processou).
      aprovado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      aprovado_em: { type: DataTypes.DATEONLY, allowNull: true },
      processado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      processado_em: { type: DataTypes.DATEONLY, allowNull: true },
    },
    { tableName: 'extra_quotas', underscored: true }
  );
  return ExtraQuota;
};
