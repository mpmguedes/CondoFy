const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const OrcamentoItem = sequelize.define(
    'OrcamentoItem',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      ano: { type: DataTypes.INTEGER, allowNull: false },
      categoria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      valor_orcamentado: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'orcamento_itens',
      underscored: true,
      indexes: [{ unique: true, fields: ['ano', 'categoria_id'] }],
    }
  );
  return OrcamentoItem;
};
