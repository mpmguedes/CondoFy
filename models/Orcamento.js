const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Orcamento = sequelize.define(
    'Orcamento',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      designacao: { type: DataTypes.STRING(120), allowNull: false },
      ano: { type: DataTypes.INTEGER, allowNull: true },
      saldo_transitado: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      data_inicio: { type: DataTypes.DATEONLY, allowNull: false },
      data_fim: { type: DataTypes.DATEONLY, allowNull: false },
      metodo_calculo: {
        type: DataTypes.ENUM('modo_a', 'modo_b'),
        allowNull: false,
        defaultValue: 'modo_a',
      },
      receita_quotas_prevista: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      estado: {
        type: DataTypes.ENUM('rascunho', 'aprovado', 'em_execucao', 'encerrado', 'anulado'),
        allowNull: false,
        defaultValue: 'rascunho',
      },
      data_aprovacao: { type: DataTypes.DATEONLY, allowNull: true },
      aprovado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      observacoes: { type: DataTypes.TEXT, allowNull: true },
      assembleia_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'orcamentos', underscored: true }
  );
  return Orcamento;
};
