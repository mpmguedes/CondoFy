const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const MovimentoBancario = sequelize.define(
    'MovimentoBancario',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      conta_bancaria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      data: { type: DataTypes.DATEONLY, allowNull: false },
      tipo: {
        type: DataTypes.ENUM('entrada', 'saida', 'transferencia'),
        allowNull: false,
      },
      // Sempre positivo; o sinal é dado pelo tipo (entrada/saída).
      valor: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      descricao: { type: DataTypes.STRING(255), allowNull: true },
      referencia: { type: DataTypes.STRING(120), allowNull: true },
      categoria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      quota_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      pagamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      despesa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      extra_quota_parcela_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      estado: {
        type: DataTypes.ENUM('confirmado', 'anulado'),
        allowNull: false,
        defaultValue: 'confirmado',
      },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'movimentos_bancarios', underscored: true }
  );
  return MovimentoBancario;
};
