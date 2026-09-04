'use strict';

// Migra os dados de orcamento_itens (ano + categoria + valor) para o novo modelo
// (orcamentos + orcamento_rubricas). A tabela antiga é mantida (não apagada).
module.exports = {
  async up(queryInterface) {
    const [itens] = await queryInterface.sequelize.query(
      `SELECT oi.ano, oi.categoria_id, oi.valor_orcamentado,
              COALESCE(c.nome, CONCAT('Categoria ', oi.categoria_id)) AS descricao
       FROM orcamento_itens oi
       LEFT JOIN categorias c ON c.id = oi.categoria_id
       ORDER BY oi.ano, oi.categoria_id`
    );
    if (!itens || itens.length === 0) return;

    const anos = [...new Set(itens.map((i) => i.ano))];
    for (const ano of anos) {
      await queryInterface.sequelize.query(
        'INSERT INTO orcamentos (designacao, data_inicio, data_fim, estado, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
        { replacements: [`Orçamento ${ano}`, `${ano}-01-01`, `${ano}-12-31`, 'em_execucao'] }
      );
      const [rows] = await queryInterface.sequelize.query('SELECT LAST_INSERT_ID() AS id');
      const orcamentoId = rows[0].id;

      for (const item of itens.filter((i) => i.ano === ano)) {
        await queryInterface.sequelize.query(
          `INSERT INTO orcamento_rubricas
             (orcamento_id, categoria_id, descricao, valor_anual, metodo_distribuicao, periodicidade, ativo, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'permilagem', 'mensal', 1, NOW(), NOW())`,
          { replacements: [orcamentoId, item.categoria_id, item.descricao, item.valor_orcamentado] }
        );
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DELETE FROM orcamento_rubricas');
    await queryInterface.sequelize.query('DELETE FROM orcamentos');
  },
};
