const { DataTypes } = require('sequelize');

// Acesso de suporte — terceiro contexto da autorização, distinto de:
//   GLOBAL      (`users.role_global`)                → administração da plataforma
//   CONDOMÍNIO  (`utilizador_condominios.role`)      → admin | gestor | leitura
//   PORTAL      (`FracaoTitularidade`)               → área do condómino
//
// Um acesso de suporte NÃO é um papel de condomínio: é uma CONCESSÃO com
// âmbito, motivo, nível e prazo. Por isso nunca produz
// `req.papelCondominio = 'admin'|'gestor'` — ver `helpers/suporte.js`.
//
// A BD é a fonte de verdade (a sessão guarda apenas o id do acesso): como o
// store de sessão é em memória e a expiração pode ocorrer com o browser aberto,
// o estado é revalidado em cada pedido.
module.exports = (sequelize) => {
  const AcessoSuporte = sequelize.define(
    'AcessoSuporte',
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      utilizador_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      condominio_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      // `operacional` existe no ENUM para evolução futura, mas não é concedível
      // nesta fase (validado na aplicação, não apenas na interface).
      nivel: {
        type: DataTypes.ENUM('diagnostico', 'operacional'),
        allowNull: false,
        defaultValue: 'diagnostico',
      },
      motivo: { type: DataTypes.STRING(500), allowNull: false },
      estado: {
        type: DataTypes.ENUM('pendente_autorizacao', 'ativo', 'expirado', 'terminado', 'revogado'),
        allowNull: false,
        defaultValue: 'ativo',
      },
      // DATETIME (não DATE): o prazo é ao segundo. `DATE` truncaria para o dia
      // e faria um acesso de 30 minutos durar até 24 horas.
      iniciado_em: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      expira_em: { type: DataTypes.DATE, allowNull: false },
      terminado_em: { type: DataTypes.DATE, allowNull: true },
      revogado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      autorizado_por: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      session_id: { type: DataTypes.STRING(128), allowNull: true },
    },
    {
      tableName: 'acessos_suporte',
      underscored: true,
      indexes: [
        { fields: ['utilizador_id', 'estado'] },
        { fields: ['condominio_id', 'estado'] },
        { fields: ['expira_em'] },
      ],
    }
  );
  return AcessoSuporte;
};
