'use strict';

// ─────────────────────────────────────────────────────────────────────
// Fundação multi-condomínio (SaaS) — preserva integralmente os dados atuais.
//
// 1. users: role_global ('super_admin'), email_confirmado, telefone,
//    campos de convite (token/estado/validade);
// 2. condominios: estado (ativo/inativo) — ciclo Ativo → Desativado;
// 3. nova tabela utilizador_condominios (utilizador ↔ condomínio, com papel);
// 4. condominio_id nas tabelas de negócio principais + backfill para o
//    condomínio implícito existente (sem perder nenhuma relação);
// 5. backfill: utilizadores 'admin' → super_admin global + papel 'admin' no
//    condomínio; restantes utilizadores → papel 'leitura'.
// ─────────────────────────────────────────────────────────────────────

const TABELAS_NEGOCIO = [
  'fracoes',
  'pessoas',
  'contactos_pessoa',
  'quotas',
  'pagamentos',
  'recibos',
  'documentos',
  'assembleias',
  'despesas',
  'contas_bancarias',
  'orcamentos',
  'extra_quotas',
  'avisos',
];

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── 1. users — campos globais/de segurança ──────────────────────
    await queryInterface.addColumn('users', 'role_global', {
      type: Sequelize.ENUM('super_admin'),
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'email_confirmado', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true, // utilizadores existentes já confirmados
    });
    await queryInterface.addColumn('users', 'email_confirmado_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'telefone', {
      type: Sequelize.STRING(40),
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'convite_token', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'convite_token_expira', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'convite_estado', {
      type: Sequelize.ENUM('pendente', 'enviado', 'aceite', 'expirado', 'revogado'),
      allowNull: true,
    });
    await queryInterface.addIndex('users', ['role_global']);
    await queryInterface.addIndex('users', ['convite_token']);

    // ── 2. condominios — estado (Ativo → Desativado) ────────────────
    await queryInterface.addColumn('condominios', 'estado', {
      type: Sequelize.ENUM('ativo', 'inativo'),
      allowNull: false,
      defaultValue: 'ativo',
    });

    // Condomínio implícito atual (mantém-se o primeiro existente).
    let condominios = await queryInterface.sequelize.query('SELECT id FROM condominios ORDER BY id ASC LIMIT 1', {
      type: queryInterface.sequelize.QueryTypes.SELECT,
    });
    if (!condominios.length) {
      await queryInterface.sequelize.query(
        "INSERT INTO condominios (designacao, estado, created_at, updated_at) VALUES ('Condomínio', 'ativo', NOW(), NOW())"
      );
      condominios = await queryInterface.sequelize.query('SELECT id FROM condominios ORDER BY id ASC LIMIT 1', {
        type: queryInterface.sequelize.QueryTypes.SELECT,
      });
    }
    const condominioId = condominios[0].id;

    // ── 3. utilizador_condominios ────────────────────────────────────
    await queryInterface.createTable(
      'utilizador_condominios',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        utilizador_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        condominio_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'condominios', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        role: {
          type: Sequelize.ENUM('admin', 'gestor', 'leitura'),
          allowNull: false,
          defaultValue: 'leitura',
        },
        estado: {
          type: Sequelize.ENUM('ativo', 'inativo'),
          allowNull: false,
          defaultValue: 'ativo',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );
    await queryInterface.addIndex('utilizador_condominios', ['condominio_id']);
    await queryInterface.addIndex('utilizador_condominios', ['utilizador_id', 'condominio_id'], { unique: true });

    // Associa todos os utilizadores atuais ao condomínio implícito.
    const utilizadores = await queryInterface.sequelize.query('SELECT id, role FROM users', {
      type: queryInterface.sequelize.QueryTypes.SELECT,
    });
    for (const u of utilizadores) {
      const papelCondominio = u.role === 'admin' ? 'admin' : 'leitura';
      const superAdmin = u.role === 'admin' ? "'super_admin'" : 'NULL';
      await queryInterface.sequelize.query(
        'INSERT INTO utilizador_condominios (utilizador_id, condominio_id, role, estado, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
        { replacements: [u.id, condominioId, papelCondominio, 'ativo'] }
      );
      await queryInterface.sequelize.query(
        `UPDATE users SET role_global = ${superAdmin}, email_confirmado = 1 WHERE id = ?`,
        { replacements: [u.id] }
      );
    }

    // ── 4. condominio_id nas tabelas de negócio + backfill ──────────
    for (const tabela of TABELAS_NEGOCIO) {
      await queryInterface.addColumn(tabela, 'condominio_id', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
      });
      await queryInterface.sequelize.query(`UPDATE ${tabela} SET condominio_id = ? WHERE condominio_id IS NULL`, {
        replacements: [condominioId],
      });
      await queryInterface.addIndex(tabela, ['condominio_id']);
    }

    // NOT NULL apenas depois do backfill (seguro para dados existentes).
    for (const tabela of TABELAS_NEGOCIO) {
      await queryInterface.changeColumn(tabela, 'condominio_id', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
      });
    }
  },

  async down(queryInterface) {
    for (const tabela of TABELAS_NEGOCIO) {
      await queryInterface.removeColumn(tabela, 'condominio_id').catch(() => {});
    }
    await queryInterface.dropTable('utilizador_condominios');
    await queryInterface.removeColumn('condominios', 'estado');
    await queryInterface.removeColumn('users', 'convite_estado');
    await queryInterface.removeColumn('users', 'convite_token_expira');
    await queryInterface.removeColumn('users', 'convite_token');
    await queryInterface.removeColumn('users', 'telefone');
    await queryInterface.removeColumn('users', 'email_confirmado_at');
    await queryInterface.removeColumn('users', 'email_confirmado');
    await queryInterface.removeColumn('users', 'role_global');
  },
};
