'use strict';

// ─────────────────────────────────────────────────────────────────────
// Histórico de titularidade de frações — `fracao_titularidades`.
//
// Problema que resolve: até aqui a relação entre uma pessoa e uma fração vivia
// apenas em `fracao_pessoas`, sem histórico (uma mudança de proprietário
// substituía o vínculo) e sem que as datas fossem consideradas na autorização
// do portal do condómino. O condomínio e a fração são permanentes; a relação de
// uma pessoa com uma fração é temporal.
//
// O que esta tabela acrescenta:
//   · um registo por período de titularidade (nunca se substitui o anterior);
//   · `data_inicio`/`data_fim` (NULL = titular atual) e `estado` (`ativa`/`cessada`);
//   · ligação opcional à conta de utilizador (`utilizador_id`) e à pessoa do
//     condomínio (`pessoa_id`), para determinar inequivocamente quem tem acesso
//     à fração em cada momento;
//   · `motivo_cessacao` e `created_by` para rastreabilidade.
//
// Nada é alterado nas tabelas existentes: `fracoes`, `pessoas`, `fracao_pessoas`,
// `users` e `utilizador_condominios` ficam como estão, e `fracao_pessoas`
// continua a ser escrita pelo fluxo atual do administrador (em sincronia).
//
// ── Preenchimento inicial (backfill) — regra exata ──────────────────
// Para cada linha existente de `fracao_pessoas` é criada uma titularidade:
//   · condominio_id = condominio da fração;
//   · vinculo       = o da linha (proprietario/arrendatario/usufrutuario);
//   · data_inicio   = data_inicio da linha ou, se vazia, a data de criação da
//                     linha (created_at), truncada ao dia — é a melhor
//                     aproximação disponível e fica registada como tal;
//   · data_fim      = data_fim da linha (NULL = sem fim conhecido);
//   · estado        = 'ativa' quando data_fim é NULL ou está no futuro,
//                     'cessada' quando data_fim já passou;
//   · utilizador_id = a conta ligada àquela pessoa (`users.pessoa_id`) quando a
//                     ligação for inequívoca (exatamente uma conta); com zero ou
//                     mais do que uma conta, fica NULL (nunca se adivinha);
//   · created_by    = NULL (não há autor conhecido para dados históricos).
// O backfill é idempotente: não duplica titularidades já existentes para o
// mesmo (fracao_id, pessoa_id, vinculo, data_inicio).
//
// Reversível: o `down` remove apenas esta tabela (nenhum dado pré-existente é
// tocado), os seus índices e os TIPOS ENUM que a MariaDB cria para as colunas
// `vinculo`/`estado` (sobrevivem ao DROP TABLE e impediriam recriar a tabela).
// Se for preciso voltar atrás depois de a aplicação já ter criado titularidades
// novas, essas linhas perdem-se — são o único registo do género.
// ─────────────────────────────────────────────────────────────────────

module.exports = {
  async up(queryInterface, Sequelize) {
    const sql = queryInterface.sequelize;

    await queryInterface.createTable(
      'fracao_titularidades',
      {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        condominio_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
        fracao_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false,
          references: { model: 'fracoes', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        pessoa_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'pessoas', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        utilizador_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        vinculo: {
          type: Sequelize.ENUM('proprietario', 'arrendatario', 'usufrutuario'),
          allowNull: false,
          defaultValue: 'proprietario',
        },
        data_inicio: { type: Sequelize.DATEONLY, allowNull: true },
        // NULL = titular atual (a relação ainda não terminou).
        data_fim: { type: Sequelize.DATEONLY, allowNull: true },
        estado: {
          type: Sequelize.ENUM('ativa', 'cessada'),
          allowNull: false,
          defaultValue: 'ativa',
          comment: 'ativa = período em curso; cessada = período encerrado (a linha nunca é apagada)',
        },
        motivo_cessacao: { type: Sequelize.STRING(120), allowNull: true },
        created_by: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      },
      { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    );

    // Índices: consultas por fração (histórico), por utilizador e por pessoa
    // (autorização). Sem unique: o histórico exige vários períodos por titular.
    await queryInterface.addIndex('fracao_titularidades', ['condominio_id', 'fracao_id', 'estado'], { name: 'ft_condominio_fracao_estado' });
    await queryInterface.addIndex('fracao_titularidades', ['utilizador_id', 'estado'], { name: 'ft_utilizador_estado' });
    await queryInterface.addIndex('fracao_titularidades', ['pessoa_id', 'estado'], { name: 'ft_pessoa_estado' });

    // ── Preenchimento inicial a partir de fracao_pessoas ──────────────
    const [ligacoes] = await sql.query(
      `SELECT fp.id, fp.fracao_id, fp.pessoa_id, fp.vinculo, fp.data_inicio, fp.data_fim,
              DATE(fp.created_at) AS criada_em, f.condominio_id
         FROM fracao_pessoas fp
         JOIN fracoes f ON f.id = fp.fracao_id`
    );
    if (!ligacoes.length) return;

    // Contas por pessoa: só se liga quando for inequívoca (exatamente uma).
    const [contas] = await sql.query(
      'SELECT pessoa_id, COUNT(*) AS n, MIN(id) AS id FROM users WHERE pessoa_id IS NOT NULL GROUP BY pessoa_id'
    );
    const contaUnica = new Map();
    for (const c of contas) {
      if (Number(c.n) === 1) contaUnica.set(Number(c.pessoa_id), Number(c.id));
    }

    const hoje = new Date().toISOString().slice(0, 10);
    let criadas = 0;
    for (const l of ligacoes) {
      const dataInicio = l.data_inicio || l.criada_em || null;
      const dataFim = l.data_fim || null;
      const cessada = Boolean(dataFim && String(dataFim).slice(0, 10) < hoje);

      // Idempotência: não duplica uma titularidade equivalente já existente.
      const [existe] = await sql.query(
        `SELECT id FROM fracao_titularidades
          WHERE fracao_id = ? AND vinculo = ?
            AND ((pessoa_id = ?) OR (pessoa_id IS NULL AND ? IS NULL))
            AND ((data_inicio = ?) OR (data_inicio IS NULL AND ? IS NULL))
          LIMIT 1`,
        { replacements: [l.fracao_id, l.vinculo, l.pessoa_id, l.pessoa_id, dataInicio, dataInicio] }
      );
      if (existe.length) continue;

      await sql.query(
        `INSERT INTO fracao_titularidades
           (condominio_id, fracao_id, pessoa_id, utilizador_id, vinculo, data_inicio, data_fim, estado,
            motivo_cessacao, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        {
          replacements: [
            l.condominio_id,
            l.fracao_id,
            l.pessoa_id,
            contaUnica.get(Number(l.pessoa_id)) || null,
            l.vinculo,
            dataInicio,
            dataFim,
            cessada ? 'cessada' : 'ativa',
            cessada ? 'Preenchimento inicial (histórico anterior à tabela de titularidades)' : null,
          ],
        }
      );
      criadas += 1;
    }
    console.log(`[migração] fracao_titularidades: ${criadas} registo(s) de histórico inicial criados a partir de fracao_pessoas.`);
  },

  async down(queryInterface) {
    for (const nome of ['ft_condominio_fracao_estado', 'ft_utilizador_estado', 'ft_pessoa_estado']) {
      await queryInterface.removeIndex('fracao_titularidades', nome).catch(() => {});
    }
    await queryInterface.dropTable('fracao_titularidades');
    // A MariaDB cria um TIPO para cada coluna ENUM e o tipo sobrevive ao
    // DROP TABLE: sem esta limpeza, um `db:migrate:undo` seguido de novo
    // `db:migrate` falharia ao recriar a tabela ("type already exists").
    // Em MySQL 8 `DROP TYPE` não existe e o erro é ignorado de propósito.
    for (const tipo of ['fracao_titularidades_vinculo', 'fracao_titularidades_estado']) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS \`${tipo}\``).catch(() => {});
    }
  },
};
