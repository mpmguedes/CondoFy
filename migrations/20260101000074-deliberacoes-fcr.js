'use strict';

// Deliberações de assembleia que autorizam a utilização do Fundo Comum de
// Reserva (FCR).
//
// Necessidade: até aqui a deliberação só podia existir como texto livre na ata
// (`assembleias.ata_texto`, que nem sequer é editável na aplicação), pelo que
// era impossível validar automaticamente «existe deliberação válida», «valor
// máximo aprovado» ou «saldo aprovado ainda disponível».
//
// A deliberação NÃO é uma entidade nova: é um atributo da própria linha da
// ordem de trabalhos (`agenda_items`), que já é filha da assembleia e já tem o
// sinal `sujeito_votacao`. Um item = no máximo uma deliberação, sem ambiguidade
// e sem `condominio_id` redundante (o condomínio vem da assembleia).
//
// Por isso cada utilização do FCR (transferência fundo_reserva → conta corrente)
// referencia a deliberação: `movimentos_bancarios.deliberacao_id`. O valor
// utilizado de uma deliberação é a soma das SAÍDAS confirmadas da conta FCR com
// esse `deliberacao_id` (somar os dois movimentos do par contaria duas vezes).
//
// `movimentos_bancarios.condominio_id` é acrescentado pela mesma razão que
// `pagamentos_fornecedores.condominio_id` o foi: os movimentos passam a ser
// filtráveis pelo condomínio sem depender do join à conta. Fica NULL no
// histórico (nunca preenchido retroativamente — não se inventam dados) e é
// preenchido em todas as escritas novas.
//
// Reversível: o `down` remove índices e colunas; nenhum dado pré-existente é
// tocado.

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── 1. Deliberação por ponto da ordem de trabalhos ────────────────
    await queryInterface.addColumn('agenda_items', 'deliberacao_estado', {
      type: Sequelize.ENUM('pendente', 'aprovada', 'rejeitada'),
      allowNull: false,
      defaultValue: 'pendente',
      comment: 'pendente = ainda sem resultado; aprovada = autoriza utilização do FCR; rejeitada = não autoriza',
    });
    await queryInterface.addColumn('agenda_items', 'valor_aprovado', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Valor máximo de FCR aprovado (obrigatório quando deliberacao_estado = aprovada)',
    });
    await queryInterface.addColumn('agenda_items', 'deliberacao_nota', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'Finalidade/descrição da utilização aprovada',
    });
    // Consulta típica: deliberações aprovadas de uma assembleia.
    await queryInterface.addIndex('agenda_items', ['assembleia_id', 'deliberacao_estado'], {
      name: 'agenda_items_assembleia_deliberacao',
    });

    // ── 2. Ligação da utilização do FCR à deliberação ─────────────────
    await queryInterface.addColumn('movimentos_bancarios', 'condominio_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'condominios', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      comment: 'Preenchido nas escritas novas; NULL no histórico anterior a esta migração',
    });
    await queryInterface.addColumn('movimentos_bancarios', 'deliberacao_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'agenda_items', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      comment: 'Deliberação que autoriza a utilização do FCR (transferência fundo_reserva → corrente)',
    });
    await queryInterface.addIndex('movimentos_bancarios', ['condominio_id'], {
      name: 'movimentos_bancarios_condominio',
    });
    // Soma do valor utilizado de uma deliberação: saídas confirmadas com esse id.
    await queryInterface.addIndex('movimentos_bancarios', ['deliberacao_id', 'tipo', 'estado'], {
      name: 'movimentos_bancarios_deliberacao_tipo_estado',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('movimentos_bancarios', 'movimentos_bancarios_deliberacao_tipo_estado');
    await queryInterface.removeIndex('movimentos_bancarios', 'movimentos_bancarios_condominio');
    await queryInterface.removeColumn('movimentos_bancarios', 'deliberacao_id');
    await queryInterface.removeColumn('movimentos_bancarios', 'condominio_id');

    await queryInterface.removeIndex('agenda_items', 'agenda_items_assembleia_deliberacao');
    await queryInterface.removeColumn('agenda_items', 'deliberacao_nota');
    await queryInterface.removeColumn('agenda_items', 'valor_aprovado');
    await queryInterface.removeColumn('agenda_items', 'deliberacao_estado');
  },
};
