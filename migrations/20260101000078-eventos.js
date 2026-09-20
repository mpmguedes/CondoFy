'use strict';

// ─────────────────────────────────────────────────────────────────────
// Eventos ad-hoc do calendário do condomínio.
//
// Âmbito ESTRITAMENTE limitado ao evento de calendário: um acontecimento
// com data (e hora opcional) que pertence a um condomínio e não tem
// módulo de origem próprio (ao contrário das assembleias e das
// comunicações programadas, que já vivem nas suas tabelas).
//
// Deliberadamente NÃO se cria aqui:
//   • associação polimórfica (não há `entidade`/`entidade_id` genéricos);
//   • tabelas de ligação (não há participantes, anexos nem convidados);
//   • campos de assembleia (ordem de trabalhos, estado, número, ata);
//   • campos de FCR/deliberação (esses pertencem a `agenda_items`).
//
// `hora` e `hora_fim` ficam em STRING(10) com o formato 'HH:MM', a mesma
// convenção de `assembleias.hora`. Manter as horas em texto — e não em
// TIME/DATE — impede que o MySQL as devolva como `Date` e reintroduza o
// desvio de um dia que a agregação do calendário evita comparando
// strings ISO (`helpers/calendario.js`).
// ─────────────────────────────────────────────────────────────────────
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('eventos', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      condominio_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'condominios', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      titulo: { type: Sequelize.STRING(255), allowNull: false },
      descricao: { type: Sequelize.TEXT, allowNull: true },
      data: { type: Sequelize.DATEONLY, allowNull: false },
      // 'HH:MM' — opcional. Um evento pode ser de dia inteiro.
      hora: { type: Sequelize.STRING(10), allowNull: true },
      // 'HH:MM' — opcional. Quando presente, é sempre posterior a `hora`
      // (validado no router, não por CHECK: o MySQL 5.7 descarta CHECK).
      hora_fim: { type: Sequelize.STRING(10), allowNull: true },
      local: { type: Sequelize.STRING(255), allowNull: true },
      // Autor da criação (utilizador da sessão). Sem FK: um utilizador
      // eliminado não pode arrastar o evento nem bloquear a sua remoção.
      created_by: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Índice pela chave de isolamento + ordenação natural do calendário.
    await queryInterface.addIndex('eventos', ['condominio_id', 'data'], {
      name: 'eventos_condominio_data',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('eventos');
  },
};
