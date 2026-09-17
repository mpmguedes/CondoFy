'use strict';

// Ligação de uma despesa à deliberação de assembleia que autoriza a sua
// utilização do Fundo Comum de Reserva (FCR).
//
// Necessidade: a deliberação (em `agenda_items`) e a utilização do FCR
// (transferência fundo_reserva → conta corrente, ligada por
// `movimentos_bancarios.deliberacao_id`, migração 74) já existiam, mas a
// DESPESA que justifica essa utilização não tinha qualquer ligação ao ponto
// aprovado — não era possível provar, no sistema, que obra/despesa foi
// autorizada por que assembleia.
//
// Campo único, nullable e sem preenchimento retroativo: as despesas já
// existentes ficam com NULL (não se inventam associações). A despesa continua a
// ter o seu próprio `condominio_id`, pelo que não é preciso duplicar nada — a
// deliberação herda o condomínio da assembleia.
//
// ON DELETE SET NULL: eliminar um ponto da ordem de trabalhos nunca apaga uma
// despesa (o histórico financeiro mantém-se); a aplicação impede essa eliminação
// enquanto houver despesas ou movimentos associados.
//
// Reversível: o `down` remove o índice e a coluna; nenhum dado pré-existente é
// tocado.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('despesas', 'deliberacao_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'agenda_items', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      comment: 'Deliberação (agenda_items) que autoriza a despesa com Fundo de Reserva; NULL = despesa corrente',
    });
    await queryInterface.addIndex('despesas', ['deliberacao_id'], {
      name: 'despesas_deliberacao',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('despesas', 'despesas_deliberacao');
    await queryInterface.removeColumn('despesas', 'deliberacao_id');
  },
};
