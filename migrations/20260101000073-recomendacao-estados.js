'use strict';

// ─────────────────────────────────────────────────────────────────────
// Estado de apresentação das recomendações contextuais do portal (Fase 2G).
//
// Problema que resolve: as recomendações do portal («Reforce a segurança da sua
// conta com 2FA», e as que vierem depois) têm de poder ser dispensadas sem
// desaparecer para sempre, e sem que o sistema invente factos. Era preciso
// guardar, POR CONTA, uma única coisa: «esta recomendação foi dispensada e só
// volta a poder aparecer depois de X».
//
// Porque é uma tabela nova e não uma reutilização:
//   · `configuracoes` é chave/valor GLOBAL (não tem dono) — não serve para uma
//     preferência por utilizador, e guardar aqui chaves por conta poluiria uma
//     tabela de administração;
//   · `audit_logs` é um registo de eventos (append-only, para auditoria), não um
//     estado atual — a decisão de apresentação não se pode basear num histórico
//     de ações do próprio (e o utilizador pode dispensar várias vezes);
//   · não existe qualquer tabela de preferências de utilizador nem estado de
//     notificações. `aviso_destinatarios` regista destinatários de avisos (não
//     tem estado próprio, e este é um assunto diferente).
//
// O que fica guardado é apenas o que NÃO se deduz do estado atual:
//   · recomendacao   → qual (identificador fixo do motor, helpers/recomendacoes.js);
//   · dispensada_em  → quando (rastreabilidade);
//   · dispensada_ate → até quando não pode voltar a aparecer;
//   · intervalo_dias → intervalo aplicado (permite mudar a política no futuro
//                      sem reinterpretar registos antigos).
// NÃO se guarda «2FA concluído» nem nada do género: isso já existe em
// `users.two_fa_ativo`, e uma recomendação nunca aparece quando a sua condição
// deixou de ser verdadeira (o estado real vence o histórico de dispensa).
//
// Sem `condominio_id` de propósito: a recomendação é sobre a CONTA. Mudar de
// condomínio não deve reabrir (nem esconder) o que já foi dispensado.
//
// Reversível: o `down` remove apenas esta tabela (nenhum dado pré-existente é
// tocado).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('recomendacao_estados', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      recomendacao: {
        type: Sequelize.STRING(60),
        allowNull: false,
        comment: 'Identificador fixo da recomendação no motor (helpers/recomendacoes.js)',
      },
      dispensada_em: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      dispensada_ate: { type: Sequelize.DATE, allowNull: true, comment: 'Fim do intervalo de reapresentação (NULL = a decidir pelo intervalo)' },
      intervalo_dias: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true, comment: 'Intervalo aplicado nesta dispensa, em dias' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    // Uma conta tem, no máximo, um estado por recomendação (idempotência da
    // dispensa: dispensar duas vezes não cria registos paralelos).
    await queryInterface.addIndex('recomendacao_estados', ['user_id', 'recomendacao'], {
      unique: true,
      name: 'recomendacao_estados_user_recomendacao_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('recomendacao_estados');
  },
};
