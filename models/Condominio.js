const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Condominio = sequelize.define(
    'Condominio',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      designacao: { type: DataTypes.STRING(191), allowNull: false },
      nif: { type: DataTypes.STRING(20), allowNull: true },
      morada: { type: DataTypes.STRING(255), allowNull: true },
      codigo_postal: { type: DataTypes.STRING(20), allowNull: true },
      localidade: { type: DataTypes.STRING(120), allowNull: true },
      email: { type: DataTypes.STRING(191), allowNull: true },
      telefone: { type: DataTypes.STRING(40), allowNull: true },
      iban_principal: { type: DataTypes.STRING(40), allowNull: true },
      outros_meios_pagamento: { type: DataTypes.TEXT, allowNull: true },
      dados_bancarios_adicionais: { type: DataTypes.TEXT, allowNull: true },
      logotipo: { type: DataTypes.STRING(255), allowNull: true },
      cabecalho_imagem: { type: DataTypes.STRING(255), allowNull: true },
      identidade_visual: {
        type: DataTypes.ENUM('logo', 'designacao'),
        allowNull: false,
        defaultValue: 'designacao',
      },
    },
    { tableName: 'condominios', underscored: true }
  );
  return Condominio;
};
