const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Quota = sequelize.define(
    'Quota',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      numero_documento: { type: DataTypes.STRING(40), allowNull: true, unique: true },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      orcamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      ano: { type: DataTypes.INTEGER, allowNull: false },
      mes: { type: DataTypes.INTEGER, allowNull: false },
      periodo: { type: DataTypes.DATEONLY, allowNull: true },
      valor: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      valor_base: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      valor_fcr: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      valor_por_1000: { type: DataTypes.DECIMAL(10, 4), allowNull: true },
      permilagem_aplicada: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      fcr_percentagem: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      data_emissao: { type: DataTypes.DATEONLY, allowNull: true },
      data_vencimento: { type: DataTypes.DATEONLY, allowNull: true },
      estado: {
        type: DataTypes.ENUM('pendente', 'parcialmente_paga', 'paga', 'vencida', 'anulada'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      tableName: 'quotas',
      underscored: true,
      indexes: [{ unique: true, fields: ['fracao_id', 'ano', 'mes'] }],
    }
  );
  return Quota;
};
