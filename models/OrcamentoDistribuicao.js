const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const OrcamentoDistribuicao = sequelize.define(
    'OrcamentoDistribuicao',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      orcamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      rubrica_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      valor_anual: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'orcamento_distribuicoes',
      underscored: true,
      indexes: [{ unique: true, fields: ['orcamento_id', 'rubrica_id', 'fracao_id'] }],
    }
  );
  return OrcamentoDistribuicao;
};
