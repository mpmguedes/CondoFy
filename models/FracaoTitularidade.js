const { DataTypes } = require('sequelize');

// Histórico de titularidade de uma fração: quem esteve (ou está) ligado a esta
// fração, com que vínculo e em que período.
//
// Regras:
//  · o condomínio e a fração são permanentes; esta relação é temporal;
//  · uma linha NUNCA é apagada nem substituída — quando a relação termina,
//    preenche-se `data_fim` e `estado = 'cessada'`;
//  · `data_fim` NULL significa titular atual; por isso o acesso é sempre
//    determinado por `estado = 'ativa'` e pelas datas, e nunca pelo mero facto
//    de existir uma linha;
//  · o histórico financeiro e documental do condomínio não está aqui e nunca é
//    tocado por mudanças de titularidade.
module.exports = (sequelize) => {
  const FracaoTitularidade = sequelize.define(
    'FracaoTitularidade',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      fracao_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      // Pessoa do condomínio e conta de acesso: qualquer dos dois pode faltar
      // (há titulares sem conta na plataforma e contas sem pessoa associada).
      pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      utilizador_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      vinculo: {
        type: DataTypes.ENUM('proprietario', 'arrendatario', 'usufrutuario'),
        allowNull: false,
        defaultValue: 'proprietario',
      },
      data_inicio: { type: DataTypes.DATEONLY, allowNull: true },
      data_fim: { type: DataTypes.DATEONLY, allowNull: true },
      estado: {
        type: DataTypes.ENUM('ativa', 'cessada'),
        allowNull: false,
        defaultValue: 'ativa',
      },
      motivo_cessacao: { type: DataTypes.STRING(120), allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: 'fracao_titularidades',
      underscored: true,
      indexes: [
        { fields: ['condominio_id', 'fracao_id', 'estado'] },
        { fields: ['utilizador_id', 'estado'] },
        { fields: ['pessoa_id', 'estado'] },
      ],
    }
  );
  return FracaoTitularidade;
};
