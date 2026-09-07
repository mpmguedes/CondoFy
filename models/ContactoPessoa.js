const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ContactoPessoa = sequelize.define(
    'ContactoPessoa',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      tipo: {
        type: DataTypes.ENUM('telefone', 'email'),
        allowNull: false,
      },
      valor: { type: DataTypes.STRING(255), allowNull: false },
      principal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      etiqueta: { type: DataTypes.STRING(60), allowNull: true },
      ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'contactos_pessoa', underscored: true }
  );
  return ContactoPessoa;
};
