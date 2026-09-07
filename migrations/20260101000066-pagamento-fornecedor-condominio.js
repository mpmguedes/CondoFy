'use strict';

// Pagamentos a fornecedores passam a pertencer a um condomínio:
// pagamentos_fornecedores.condominio_id.
//
// Mantém a cadeia coerente: condominio_id → Fornecedor → PagamentoFornecedor →
// Documento/comprovativo. Sem isto, um pagamento só estaria ligado ao condomínio
// por relações indiretas (fornecedor/despesa/comprovativo).
//
// Backfill (não-destrutivo): o pagamento recebe o condomínio do seu fornecedor
// (preenchido pela migração 065) quando inequívoco; em falta, usa o comprovativo
// (documento) ou a despesa associada; sem relação ou em conflito → NULL
// (órfão/global, nunca listado nas áreas dos condomínios).

module.exports = {
  async up(queryInterface, Sequelize) {
    const sql = queryInterface.sequelize;

    await queryInterface.addColumn('pagamentos_fornecedores', 'condominio_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      comment: 'Condomínio a que pertence o pagamento a fornecedor (NULL = histórico órfão/ambíguo)',
    });
    await queryInterface.addIndex('pagamentos_fornecedores', ['condominio_id']);

    const [pagamentos] = await sql.query(
      `SELECT pf.id, f.condominio_id AS cond_fornecedor, d.condominio_id AS cond_doc, de.condominio_id AS cond_despesa
         FROM pagamentos_fornecedores pf
         LEFT JOIN fornecedores f ON f.id = pf.fornecedor_id
         LEFT JOIN documentos d ON d.id = pf.comprovativo_documento_id
         LEFT JOIN despesas de ON de.id = pf.despesa_id`
    );
    if (!pagamentos.length) return;

    const updates = [];
    for (const p of pagamentos) {
      const candidatos = new Set();
      if (p.cond_fornecedor) candidatos.add(Number(p.cond_fornecedor));
      if (p.cond_doc) candidatos.add(Number(p.cond_doc));
      if (p.cond_despesa) candidatos.add(Number(p.cond_despesa));
      if (candidatos.size === 1) updates.push([Number(p.id), [...candidatos][0]]);
    }
    for (const [id, cid] of updates) {
      await sql.query('UPDATE pagamentos_fornecedores SET condominio_id = ? WHERE id = ?', {
        replacements: [cid, id],
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('pagamentos_fornecedores', 'pagamentos_fornecedores_condominio_id').catch(() => {});
    await queryInterface.removeColumn('pagamentos_fornecedores', 'condominio_id');
  },
};
