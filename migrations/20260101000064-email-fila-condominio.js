'use strict';

// EmailFila passa a pertencer a um condomínio: email_fila.condominio_id.
//
// Motivo: a Central de Emails vive dentro de um condomínio (comCondominioAtivo)
// e a listagem/contagens/ações têm de estar isoladas por condomínio. Em vez de
// descobrir o condomínio por várias relações indiretas a cada leitura, a relação
// fica PERSISTIDA na fila quando o email é criado.
//
// Backfill (não-destrutivo): cada email histórico só recebe condominio_id se as
// relações seguras que possui (documento/aviso/entidade com condominio_id)
// apontarem todas para UM MESMO condomínio. Sem relação ou com relações em
// conflito → fica NULL (global/órfão) e NUNCA aparece nas áreas dos condomínios
// (as queries filtram condominio_id = ativo, excluindo NULL). Nada é inventado,
// nada é atribuído ao "primeiro condomínio" nem ao condomínio ativo da sessão.

module.exports = {
  async up(queryInterface, Sequelize) {
    const sql = queryInterface.sequelize;

    await queryInterface.addColumn('email_fila', 'condominio_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      comment: 'Condomínio a que pertence o email (NULL = global/órfão histórico, nunca listado nas áreas dos condomínios)',
    });
    await queryInterface.addIndex('email_fila', ['condominio_id']);

    // ── Backfill por relações inequívocas ────────────────────────────
    // Mapa entidade_tipo → tabela com condominio_id (mesmas entidades que a
    // aplicação usa na fila). 'PagamentoFornecedor' resolve via comprovativo
    // (documentos) ou despesa associada.
    const TABELA_ENTIDADE = {
      Documento: 'documentos',
      Aviso: 'avisos',
      Quota: 'quotas',
      Pagamento: 'pagamentos',
      Recibo: 'recibos',
      Despesa: 'despesas',
      ExtraQuota: 'extra_quotas',
      Assembleia: 'assembleias',
    };

    const [linhas] = await sql.query(
      'SELECT id, documento_id, aviso_id, entidade_tipo, entidade_id FROM email_fila'
    );
    if (!linhas.length) return;

    const idsDocumentos = new Set();
    const idsAvisos = new Set();
    const idsPagFornecedor = new Set();
    const idsPorTabela = new Map(); // tabela → Set de ids
    for (const l of linhas) {
      if (l.documento_id) idsDocumentos.add(Number(l.documento_id));
      if (l.aviso_id) idsAvisos.add(Number(l.aviso_id));
      if (l.entidade_tipo === 'PagamentoFornecedor' && l.entidade_id) {
        idsPagFornecedor.add(Number(l.entidade_id));
      } else if (l.entidade_tipo && l.entidade_id) {
        const tabela = TABELA_ENTIDADE[l.entidade_tipo];
        if (tabela) {
          if (!idsPorTabela.has(tabela)) idsPorTabela.set(tabela, new Set());
          idsPorTabela.get(tabela).add(Number(l.entidade_id));
        }
      }
    }

    // Carrega mapas id → condominio_id (apenas os ids presentes).
    async function mapaCondominio(tabela, ids) {
      const mapa = new Map();
      const lista = [...ids];
      if (!lista.length) return mapa;
      for (let i = 0; i < lista.length; i += 500) {
        const fatia = lista.slice(i, i + 500);
        const [rows] = await sql.query(
          `SELECT id, condominio_id FROM ${tabela} WHERE id IN (:ids)`,
          { replacements: { ids: fatia } }
        );
        for (const r of rows) if (r.condominio_id) mapa.set(Number(r.id), Number(r.condominio_id));
      }
      return mapa;
    }

    const condDocs = await mapaCondominio('documentos', idsDocumentos);
    const condAvisos = await mapaCondominio('avisos', idsAvisos);

    const condPorTabela = new Map();
    for (const [tabela, ids] of idsPorTabela) {
      condPorTabela.set(tabela, await mapaCondominio(tabela, ids));
    }

    // PagamentoFornecedor: comprovativo (documento) e/ou despesa → condomínio.
    const condPagFornecedor = new Map();
    if (idsPagFornecedor.size) {
      const lista = [...idsPagFornecedor];
      for (let i = 0; i < lista.length; i += 500) {
        const fatia = lista.slice(i, i + 500);
        const [rows] = await sql.query(
          `SELECT pf.id, d.condominio_id AS cond_doc, de.condominio_id AS cond_despesa
             FROM pagamentos_fornecedores pf
             LEFT JOIN documentos d ON d.id = pf.comprovativo_documento_id
             LEFT JOIN despesas de ON de.id = pf.despesa_id
            WHERE pf.id IN (:ids)`,
          { replacements: { ids: fatia } }
        );
        for (const r of rows) {
          const candidatos = new Set();
          if (r.cond_doc) candidatos.add(Number(r.cond_doc));
          if (r.cond_despesa) candidatos.add(Number(r.cond_despesa));
          if (candidatos.size === 1) condPagFornecedor.set(Number(r.id), [...candidatos][0]);
        }
      }
    }

    // Atualização por linha: só quando TODAS as fontes apontam para o mesmo
    // condomínio (ambiguidade → NULL).
    const updates = [];
    for (const l of linhas) {
      const candidatos = new Set();
      const add = (mapa, id) => {
        if (!id) return;
        const cid = mapa.get(Number(id));
        if (cid) candidatos.add(cid);
      };
      add(condDocs, l.documento_id);
      add(condAvisos, l.aviso_id);
      if (l.entidade_tipo === 'PagamentoFornecedor') {
        add(condPagFornecedor, l.entidade_id);
      } else if (l.entidade_tipo && l.entidade_id) {
        const mapa = condPorTabela.get(TABELA_ENTIDADE[l.entidade_tipo]);
        if (mapa) add(mapa, l.entidade_id);
      }
      if (candidatos.size === 1) updates.push([Number(l.id), [...candidatos][0]]);
    }

    for (let i = 0; i < updates.length; i += 200) {
      const fatia = updates.slice(i, i + 200);
      for (const [id, cid] of fatia) {
        await sql.query('UPDATE email_fila SET condominio_id = ? WHERE id = ?', {
          replacements: [cid, id],
        });
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('email_fila', 'email_fila_condominio_id').catch(() => {});
    await queryInterface.removeColumn('email_fila', 'condominio_id');
  },
};
