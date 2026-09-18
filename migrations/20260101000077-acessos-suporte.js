'use strict';

// ─────────────────────────────────────────────────────────────────────
// Acessos de suporte — terceiro contexto, separado do papel de condomínio.
//
// Necessidade: até aqui o Super Admin global entrava num condomínio através
// de um bypass incondicional (`if (eSuperAdmin) { req.condominioId = …;
// req.papelCondominio = 'admin'; }`). Esse acesso não tinha âmbito, motivo,
// prazo nem revogação — era permanente e indistinguível de um acesso indevido.
//
// Esta tabela materializa o acesso de suporte como uma CONCESSÃO registada:
// âmbito (um condomínio), motivo, nível, prazo com expiração OBRIGATÓRIA e
// estado explícito. A autorização revalida-se nesta tabela em cada pedido, pelo
// que a BD — e não a sessão — é a fonte de verdade.
//
// Dois pontos deliberados no schema:
//   · `expira_em` é NOT NULL — uma concessão sem fim é exatamente o problema
//     que se está a corrigir. Torná-la obrigatória impede reintroduzir o bypass
//     por descuido.
//   · `nivel` tem default `diagnostico` e o ENUM inclui `operacional`, mas
//     `operacional` NÃO é concedível nesta fase (validado na aplicação): o
//     menor privilégio começa no default, não na interface.
//
// Datas em DATETIME (não DATE): o prazo é ao minuto/segundo — `DATE` truncaria
// para o dia e faria um acesso de 30 minutos durar até 24 horas.
//
// Reversível: o `down` remove a tabela inteira; nenhum dado pré-existente é
// tocado (nada referencia esta tabela).
// ─────────────────────────────────────────────────────────────────────

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('acessos_suporte', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      // Operador: o Super Admin global que abriu o acesso.
      utilizador_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
        comment: 'Super Admin que iniciou o acesso de suporte',
      },
      // Âmbito: um e só um condomínio. Fixo durante o acesso.
      condominio_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'condominios', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
        comment: 'Condomínio concedido — o âmbito do acesso (nunca vem do browser)',
      },
      nivel: {
        type: Sequelize.ENUM('diagnostico', 'operacional'),
        allowNull: false,
        defaultValue: 'diagnostico',
        comment: 'diagnostico = só leitura; operacional = leitura + escrita restrita (não concedível nesta fase)',
      },
      motivo: {
        type: Sequelize.STRING(500),
        allowNull: false,
        comment: 'Motivo obrigatório: uma sessão sem motivo é indistinguível de acesso indevido',
      },
      estado: {
        type: Sequelize.ENUM('pendente_autorizacao', 'ativo', 'expirado', 'terminado', 'revogado'),
        allowNull: false,
        defaultValue: 'ativo',
        comment: 'pendente_autorizacao = à espera do admin do condomínio; expirado/terminado/revogado distinguem-se na auditoria',
      },
      // DATETIME (não DATE) — o prazo é ao segundo.
      iniciado_em: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      expira_em: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'OBRIGATÓRIO e absoluto — nunca renovado por atividade',
      },
      terminado_em: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Preenchido no fim manual, na expiração ou na revogação',
      },
      revogado_por: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Quem revogou (operador ou admin do condomínio)',
      },
      autorizado_por: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Admin do condomínio que autorizou (fluxo híbrido); null quando não existia admin ativo',
      },
      session_id: {
        type: Sequelize.STRING(128),
        allowNull: true,
        comment: 'req.sessionID no arranque — permite detetar sessões paralelas',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Consultas típicas: «há acesso vigente deste utilizador?» e «há algum
    // acesso vigente para este condomínio?».
    await queryInterface.addIndex('acessos_suporte', ['utilizador_id', 'estado'], {
      name: 'acessos_suporte_utilizador_estado',
    });
    await queryInterface.addIndex('acessos_suporte', ['condominio_id', 'estado'], {
      name: 'acessos_suporte_condominio_estado',
    });
    // Formalização do estado «expirado» (job periódico, se existir).
    await queryInterface.addIndex('acessos_suporte', ['expira_em'], {
      name: 'acessos_suporte_expira_em',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('acessos_suporte');
  },
};
