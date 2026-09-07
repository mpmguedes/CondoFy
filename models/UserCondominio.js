const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserCondominio = sequelize.define(
    'UserCondominio',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      utilizador_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      role: {
        type: DataTypes.ENUM('admin', 'gestor', 'leitura'),
        allowNull: false,
        defaultValue: 'leitura',
      },
      estado: {
        type: DataTypes.ENUM('ativo', 'inativo'),
        allowNull: false,
        defaultValue: 'ativo',
      },
    },
    {
      tableName: 'utilizador_condominios',
      underscored: true,
      indexes: [{ fields: ['condominio_id'] }, { unique: true, fields: ['utilizador_id', 'condominio_id'] }],
    }
  );
  return UserCondominio;
};
