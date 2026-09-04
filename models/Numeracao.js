const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Numeracao = sequelize.define(
    'Numeracao',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      tipo_documento: {
        type: DataTypes.ENUM('aviso_quota', 'recibo', 'despesa', 'documento_interno', 'outro'),
        allowNull: false,
      },
      ano: { type: DataTypes.INTEGER, allowNull: false },
      sequencia: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      formato: { type: DataTypes.STRING(60), allowNull: false, defaultValue: '{ano}/{sequencia}' },
    },
    {
      tableName: 'numeracoes',
      underscored: true,
      indexes: [{ unique: true, fields: ['tipo_documento', 'ano'] }],
    }
  );
  return Numeracao;
};
