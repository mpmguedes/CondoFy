const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      email: { type: DataTypes.STRING(191), allowNull: false, unique: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: true },
      nome: { type: DataTypes.STRING(191), allowNull: false },
      role: {
        type: DataTypes.ENUM('admin', 'condomino'),
        allowNull: false,
        defaultValue: 'condomino',
      },
      // provider prepara a autenticação para OAuth/Google no futuro,
      // sem reescrever o sistema de utilizadores.
      provider: {
        type: DataTypes.ENUM('local', 'google'),
        allowNull: false,
        defaultValue: 'local',
      },
      google_id: { type: DataTypes.STRING(191), allowNull: true },
      pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      reset_token: { type: DataTypes.STRING(255), allowNull: true },
      reset_token_expires: { type: DataTypes.DATE, allowNull: true },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'users', underscored: true }
  );
  return User;
};
