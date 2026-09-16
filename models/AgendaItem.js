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
      // ── Deliberação deste ponto (nunca votação eletrónica: o resultado é
      // registado manualmente pelo gestor, com rasto de auditoria) ──────
      // É aqui, e não numa tabela nova, porque a deliberação PERTENCE ao ponto
      // da ordem de trabalhos: um item = no máximo uma deliberação. O
      // condomínio é sempre o da assembleia (nunca duplicado aqui).
      deliberacao_estado: {
        type: DataTypes.ENUM('pendente', 'aprovada', 'rejeitada'),
        allowNull: false,
        defaultValue: 'pendente',
      },
      // Valor MÁXIMO de FCR aprovado (obrigatório quando aprovada).
      valor_aprovado: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      // Finalidade/descrição da utilização aprovada (texto humano).
      deliberacao_nota: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: 'agenda_items', underscored: true }
  );
  return AgendaItem;
};
