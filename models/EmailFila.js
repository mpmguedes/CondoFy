const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const EmailFila = sequelize.define(
    'EmailFila',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      destinatario_email: { type: DataTypes.STRING(191), allowNull: false },
      destinatario_nome: { type: DataTypes.STRING(191), allowNull: true },
      assunto: { type: DataTypes.STRING(255), allowNull: false },
      corpo: { type: DataTypes.TEXT, allowNull: true },
      corpo_html: { type: DataTypes.TEXT, allowNull: true },
      documento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      aviso_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      entidade_tipo: { type: DataTypes.STRING(60), allowNull: true },
      entidade_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      tipo: {
        type: DataTypes.ENUM('normal', 'teste'),
        allowNull: false,
        defaultValue: 'normal',
      },
      estado: {
        type: DataTypes.ENUM('pendente', 'a_enviar', 'enviado', 'erro', 'cancelado'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      data_prevista: { type: DataTypes.DATEONLY, allowNull: true },
      data_enviada: { type: DataTypes.DATE, allowNull: true },
      erro: { type: DataTypes.TEXT, allowNull: true },
      tentativas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      message_id: { type: DataTypes.STRING(255), allowNull: true },
    },
    { tableName: 'email_fila', underscored: true }
  );
  return EmailFila;
};
