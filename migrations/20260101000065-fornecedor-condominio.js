'use strict';

// Fornecedores passam a pertencer a um condomínio: fornecedores.condominio_id.
//
// Cada condomínio possui a sua própria lista de fornecedores (dois "Fornecedor X"
// em condomínios diferentes são registos distintos). Todas as operações usam o
// condomínio ativo do backend (req.condominioId).
//
// Backfill (não-destrutivo): cada fornecedor existente só recebe condominio_id
// se TODAS as provas (despesas com condominio_id, documentos com
// entidade_tipo='Fornecedor', pagamentos a fornecedores com comprovativo/despesa)
// apontarem para UM MESMO condomínio. Fornecedores sem provas ou com provas em
// conflito (realmente partilhados/ambíguos) ficam NULL — não aparecem nas listas
// de nenhum condomínio (as queries filtram condominio_id = ativo) e exigem uma
// decisão manual de migração (relatório); nada é atribuído arbitrariamente.

module.exports = {
  async up(queryInterface, Sequelize) {
    const sql = queryInterface.sequelize;

    await queryInterface.addColumn('fornecedores', 'condominio_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      comment: 'Condomínio dono do fornecedor (NULL = histórico ambíguo/global, não listado nos condomínios)',
    });
    await queryInterface.addIndex('fornecedores', ['condominio_id']);

    // ── Backfill por provas inequívocas ──────────────────────────────
    const [fornecedores] = await sql.query('SELECT id FROM fornecedores');
    if (!fornecedores.length) return;
    const ids = fornecedores.map((f) => Number(f.id));

    const provasPorFornecedor = new Map(); // fornecedor_id → Set<condominio_id>
    const juntar = (rows, campoFornecedor) => {
      for (const r of rows) {
        if (!r[campoFornecedor] || !r.condominio_id) continue;
        const fid = Number(r[campoFornecedor]);
        if (!provasPorFornecedor.has(fid)) provasPorFornecedor.set(fid, new Set());
        provasPorFornecedor.get(fid).add(Number(r.condominio_id));
      }
    };

    // 1) Despesas registadas com este fornecedor (despesas.condominio_id).
    for (let i = 0; i < ids.length; i += 500) {
      const fatia = ids.slice(i, i + 500);
      const [rows] = await sql.query(
        'SELECT fornecedor_id, condominio_id FROM despesas WHERE fornecedor_id IS NOT NULL AND fornecedor_id IN (:ids)',
        { replacements: { ids: fatia } }
      );
      juntar(rows, 'fornecedor_id');
    }

    // 2) Documentos de fornecedor (documentos.entidade_tipo='Fornecedor').
    for (let i = 0; i < ids.length; i += 500) {
      const fatia = ids.slice(i, i + 500);
      const [rows] = await sql.query(
        "SELECT entidade_id AS fornecedor_id, condominio_id FROM documentos WHERE entidade_tipo = 'Fornecedor' AND entidade_id IN (:ids)",
        { replacements: { ids: fatia } }
      );
      juntar(rows, 'fornecedor_id');
    }

    // 3) Pagamentos a fornecedores: comprovativo (documentos) e/ou despesa.
    for (let i = 0; i < ids.length; i += 500) {
      const fatia = ids.slice(i, i + 500);
      const [rows] = await sql.query(
        `SELECT pf.fornecedor_id, d.condominio_id AS cond_doc, de.condominio_id AS cond_despesa
           FROM pagamentos_fornecedores pf
           LEFT JOIN documentos d ON d.id = pf.comprovativo_documento_id
           LEFT JOIN despesas de ON de.id = pf.despesa_id
          WHERE pf.fornecedor_id IN (:ids)`,
        { replacements: { ids: fatia } }
      );
      for (const r of rows) {
        const fid = Number(r.fornecedor_id);
        const candidatos = new Set();
        if (r.cond_doc) candidatos.add(Number(r.cond_doc));
        if (r.cond_despesa) candidatos.add(Number(r.cond_despesa));
        for (const c of candidatos) {
          if (!provasPorFornecedor.has(fid)) provasPorFornecedor.set(fid, new Set());
          provasPorFornecedor.get(fid).add(c);
        }
      }
    }

    // Só atribui quando existe UMA E UMA prova/condomínio distinto.
    const updates = [];
    for (const f of fornecedores) {
      const candidatos = provasPorFornecedor.get(Number(f.id));
      if (candidatos && candidatos.size === 1) updates.push([Number(f.id), [...candidatos][0]]);
    }
    for (const [id, cid] of updates) {
      await sql.query('UPDATE fornecedores SET condominio_id = ? WHERE id = ?', {
        replacements: [cid, id],
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('fornecedores', 'fornecedores_condominio_id').catch(() => {});
    await queryInterface.removeColumn('fornecedores', 'condominio_id');
  },
};
