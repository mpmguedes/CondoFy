'use strict';

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS c FROM categorias'
    );
    if (Number(rows[0].c) > 0) {
      return;
    }

    const now = new Date();
    const categorias = [
      // Despesas
      { nome: 'Manutenção', tipo: 'despesa', ativa: 1 },
      { nome: 'Limpeza', tipo: 'despesa', ativa: 1 },
      { nome: 'Água', tipo: 'despesa', ativa: 1 },
      { nome: 'Eletricidade', tipo: 'despesa', ativa: 1 },
      { nome: 'Elevador', tipo: 'despesa', ativa: 1 },
      { nome: 'Seguros', tipo: 'despesa', ativa: 1 },
      { nome: 'Administração', tipo: 'despesa', ativa: 1 },
      { nome: 'Outras despesas', tipo: 'despesa', ativa: 1 },
      // Receitas
      { nome: 'Quotas', tipo: 'receita', ativa: 1 },
      { nome: 'Fundo de reserva', tipo: 'receita', ativa: 1 },
      { nome: 'Juros e multas', tipo: 'receita', ativa: 1 },
      { nome: 'Outras receitas', tipo: 'receita', ativa: 1 },
    ].map((c) => ({ ...c, created_at: now, updated_at: now }));

    await queryInterface.bulkInsert('categorias', categorias);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('categorias', null, {});
  },
};
