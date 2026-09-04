'use strict';

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS c FROM condominios'
    );
    if (Number(rows[0].c) > 0) {
      return;
    }

    const now = new Date();
    await queryInterface.bulkInsert('condominios', [
      {
        designacao: 'Condomínio Exemplo',
        identidade_visual: 'designacao',
        created_at: now,
        updated_at: now,
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('condominios', null, {});
  },
};
