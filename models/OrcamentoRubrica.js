const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const OrcamentoRubrica = sequelize.define(
    'OrcamentoRubrica',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      orcamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      categoria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      descricao: { type: DataTypes.STRING(191), allowNull: false },
      valor_anual: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      metodo_distribuicao: {
        type: DataTypes.ENUM('permilagem', 'igual', 'valor_fixo'),
        allowNull: false,
        defaultValue: 'permilagem',
      },
      periodicidade: {
        type: DataTypes.ENUM('mensal', 'trimestral', 'semestral', 'anual', 'unica'),
        allowNull: false,
        defaultValue: 'mensal',
      },
      ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'orcamento_rubricas', underscored: true }
  );
  return OrcamentoRubrica;
};
