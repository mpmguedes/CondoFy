const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Recibo = sequelize.define(
    'Recibo',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      // Código único e legível, ex.: RCP-2026-0006.
      codigo: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      // Código de verificação (autenticidade), ex.: 2026-E8D57089.
      codigo_verificacao: { type: DataTypes.STRING(40), allowNull: false },
      // Número sequencial do ano (ex.: 0006).
      numero: { type: DataTypes.STRING(12), allowNull: false },
      ano: { type: DataTypes.INTEGER, allowNull: false },
      tipo: {
        type: DataTypes.ENUM('ordinario', 'extraordinario'),
        allowNull: false,
        defaultValue: 'ordinario',
      },
      valor: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      data_emissao: { type: DataTypes.DATEONLY, allowNull: true },
      estado: {
        type: DataTypes.ENUM('emitido', 'anulado'),
        allowNull: false,
        defaultValue: 'emitido',
      },
      motivo_anulacao: { type: DataTypes.TEXT, allowNull: true },
      enviado_at: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'recibos',
      underscored: true,
      indexes: [{ fields: ['fracao_id'] }, { fields: ['ano'] }],
    }
  );
  return Recibo;
};
