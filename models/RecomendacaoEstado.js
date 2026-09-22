const { DataTypes } = require('sequelize');

// Estado de apresentação das sugestões DISPENSADAS — recomendações contextuais
// do portal (Fase 2G, `helpers/recomendacoes.js`) e tips contextuais do
// backoffice (`helpers/tips.js`).
//
// Guarda apenas o que NÃO se consegue deduzir do estado atual: que uma sugestão
// foi dispensada por esta conta e até quando pode voltar a aparecer. O
// cumprimento da sugestão não se guarda aqui (exemplo: o 2FA lê-se de
// `users.two_fa_ativo`) — o estado real é sempre a fonte de verdade.
//
// Não tem `condominio_id`: as recomendações do portal são da CONTA e não
// pertencem a um condomínio concreto — trocar de condomínio não deve reabrir
// (nem esconder) uma sugestão que o utilizador já dispensou. As sugestões que
// SÃO por condomínio (os tips do backoffice) trazem o âmbito na própria chave —
// `tip:<id>@c<condominioId>` —, pelo que dispensar num condomínio não esconde o
// mesmo tip noutro. A coluna `recomendacao` guarda a chave completa, e cada
// motor valida-a contra o seu próprio registo (um identificador de um motor
// nunca é aceite pelo outro).
module.exports = (sequelize) => {
  const RecomendacaoEstado = sequelize.define(
    'RecomendacaoEstado',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      recomendacao: { type: DataTypes.STRING(60), allowNull: false },
      dispensada_em: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      dispensada_ate: { type: DataTypes.DATE, allowNull: true },
      intervalo_dias: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    { tableName: 'recomendacao_estados', underscored: true }
  );
  return RecomendacaoEstado;
};
