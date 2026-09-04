'use strict';

// Preenche movimentos_bancarios a partir dos dados existentes:
// - pagamentos confirmados com conta → entradas
// - despesas pagas com conta → saídas
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO movimentos_bancarios
        (conta_bancaria_id, data, tipo, valor, descricao, referencia, pagamento_id, estado, created_at, updated_at)
      SELECT p.conta_bancaria_id, COALESCE(p.data_pagamento, CURDATE()), 'entrada', p.valor,
             CONCAT('Pagamento ', COALESCE(p.numero_documento, p.id)), p.referencia, p.id, 'confirmado', NOW(), NOW()
      FROM pagamentos p
      WHERE p.estado = 'confirmado' AND p.conta_bancaria_id IS NOT NULL
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO movimentos_bancarios
        (conta_bancaria_id, data, tipo, valor, descricao, despesa_id, estado, created_at, updated_at)
      SELECT d.conta_bancaria_id, COALESCE(d.data, CURDATE()), 'saida', d.valor, d.descricao, d.id, 'confirmado', NOW(), NOW()
      FROM despesas d
      WHERE d.estado = 'paga' AND d.conta_bancaria_id IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DELETE FROM movimentos_bancarios');
  },
};
