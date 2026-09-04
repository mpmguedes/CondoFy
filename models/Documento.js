const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Documento = sequelize.define(
    'Documento',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      tipo: {
        type: DataTypes.ENUM(
          'aviso_quota',
          'recibo',
          'ata',
          'convocatoria',
          'relatorio',
          'fatura',
          'contrato',
          'orcamento',
          'outro'
        ),
        allowNull: false,
        defaultValue: 'outro',
      },
      numero_documento: { type: DataTypes.STRING(40), allowNull: true },
      nome: { type: DataTypes.STRING(255), allowNull: false },
      drive_file_id: { type: DataTypes.STRING(191), allowNull: true },
      mime_type: { type: DataTypes.STRING(120), allowNull: true },
      tamanho: { type: DataTypes.BIGINT, allowNull: true },
      data: { type: DataTypes.DATEONLY, allowNull: true },
      entidade_tipo: { type: DataTypes.STRING(60), allowNull: true },
      entidade_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      url: { type: DataTypes.STRING(500), allowNull: true },
      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'documentos', underscored: true }
  );
  return Documento;
};
