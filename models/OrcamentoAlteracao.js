const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const OrcamentoAlteracao = sequelize.define(
    'OrcamentoAlteracao',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      orcamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      utilizador_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      data_alteracao: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      tipo_alteracao: { type: DataTypes.STRING(60), allowNull: true },
      entidade_alterada: { type: DataTypes.STRING(120), allowNull: true },
      entidade_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      valor_anterior: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      valor_novo: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      justificacao: { type: DataTypes.TEXT, allowNull: true },
      assembleia_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'orcamento_alteracoes', underscored: true }
  );
  return OrcamentoAlteracao;
};
