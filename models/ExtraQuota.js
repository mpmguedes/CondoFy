const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ExtraQuota = sequelize.define(
    'ExtraQuota',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      designacao: { type: DataTypes.STRING(191), allowNull: false },
      // Q11/R10 — natureza da operação:
      //  · 'extraordinaria' — quota extra normal (comportamento anterior);
      //  · 'acerto'         — correção de uma quota EMITIDA. É um documento
      //                       NOVO: nunca altera a quota original (`quota_id`
      //                       é uma referência, não um alvo de escrita).
      tipo: {
        type: DataTypes.ENUM('extraordinaria', 'acerto'),
        allowNull: false,
        defaultValue: 'extraordinaria',
      },
      // Orçamento de origem, quando aplicável (vínculo histórico).
      orcamento_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      // Quota ORIGINAL corrigida por um acerto — só leitura, nunca escrita.
      quota_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      // Motivo da operação (obrigatório num acerto).
      justificacao: { type: DataTypes.TEXT, allowNull: true },
      // O que a quota valia e o que passa a valer (valor a cobrar = valor_novo).
      valor_anterior: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      valor_novo: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      valor_total: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      metodo_divisao: {
        type: DataTypes.ENUM('permilagem', 'igual'),
        allowNull: false,
        defaultValue: 'permilagem',
      },
      mes_inicio: { type: DataTypes.INTEGER, allowNull: false },
      ano_inicio: { type: DataTypes.INTEGER, allowNull: false },
      numero_parcelas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      periodicidade: {
        type: DataTypes.ENUM('mensal', 'bimestral', 'trimestral', 'semestral', 'anual'),
        allowNull: false,
        defaultValue: 'mensal',
      },
      estado: {
        type: DataTypes.ENUM('pendente', 'aprovada', 'processada', 'anulada'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      // Autor/responsável da criação da operação (a auditoria transversal
      // regista a ação; este campo torna o próprio registo auto-explicativo).
      criado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      // Auditoria do ciclo de vida (quem/quando aprovou e processou).
      aprovado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      aprovado_em: { type: DataTypes.DATEONLY, allowNull: true },
      processado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      processado_em: { type: DataTypes.DATEONLY, allowNull: true },
    },
    { tableName: 'extra_quotas', underscored: true }
  );
  return ExtraQuota;
};
