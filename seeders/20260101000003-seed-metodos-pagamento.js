'use strict';

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS c FROM metodos_pagamento'
    );
    if (Number(rows[0].c) > 0) {
      return;
    }

    const now = new Date();
    const metodos = [
      { nome: 'Transferência bancária' },
      { nome: 'Multibanco' },
      { nome: 'MB Way' },
      { nome: 'Numerário' },
      { nome: 'Débito direto' },
    ].map((m) => ({ ...m, ativo: 1, created_at: now, updated_at: now }));

    await queryInterface.bulkInsert('metodos_pagamento', metodos);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('metodos_pagamento', null, {});
  },
};
