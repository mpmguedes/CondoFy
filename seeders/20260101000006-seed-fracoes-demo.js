'use strict';

// Seed de demonstração: Fração A (500‰) + Fração B (500‰).
// Só insere se ainda não existirem frações (idempotente).
module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS c FROM fracoes'
    );
    if (Number(rows[0].c) > 0) return;

    const now = new Date();
    await queryInterface.bulkInsert('fracoes', [
      {
        designacao: 'Fração A',
        permilagem: '500.00',
        andar: null,
        observacoes: null,
        estado: 'ativo',
        created_at: now,
        updated_at: now,
      },
      {
        designacao: 'Fração B',
        permilagem: '500.00',
        andar: null,
        observacoes: null,
        estado: 'ativo',
        created_at: now,
        updated_at: now,
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('fracoes', { designacao: ['Fração A', 'Fração B'] }, {});
  },
};
