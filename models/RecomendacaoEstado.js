const { DataTypes } = require('sequelize');

// Estado de apresentação das recomendações contextuais do portal (Fase 2G).
//
// Guarda apenas o que NÃO se consegue deduzir do estado atual: que uma
// recomendação foi dispensada por esta conta e até quando pode voltar a
// aparecer. O cumprimento da recomendação não se guarda aqui (exemplo: o 2FA
// lê-se de `users.two_fa_ativo`) — o estado real é sempre a fonte de verdade.
//
// Não tem `condominio_id`: uma recomendação sobre a CONTA não pertence a um
// condomínio concreto. Trocar de condomínio não deve reabrir (nem esconder)
// uma recomendação que o utilizador já dispensou.
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
