const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const DocumentoCategoria = sequelize.define(
    'DocumentoCategoria',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      categoria_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    },
    {
      tableName: 'documento_categorias',
      underscored: true,
      indexes: [{ unique: true, fields: ['documento_id', 'categoria_id'] }],
    }
  );
  return DocumentoCategoria;
};
