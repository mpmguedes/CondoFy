const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AgendaItem = sequelize.define(
    'AgendaItem',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      assembleia_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      ordem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      descricao: { type: DataTypes.STRING(255), allowNull: false },
      sujeito_votacao: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'agenda_items', underscored: true }
  );
  return AgendaItem;
};
