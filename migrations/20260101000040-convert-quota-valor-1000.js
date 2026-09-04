'use strict';

// Muda a semântica da configuração de quotas: passa de "valor por 1‰" para
// "valor por 1000‰" (o total do condomínio), conforme a especificação.
// O valor antigo (por 1‰) é multiplicado por 1000 para manter o mesmo efeito.
module.exports = {
  async up(queryInterface) {
    const [existe] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS c FROM configuracoes WHERE chave = 'quota_valor_1000'"
    );
    if (Number(existe[0].c) > 0) return;

    const [antigo] = await queryInterface.sequelize.query(
      "SELECT valor FROM configuracoes WHERE chave = 'quota_valor_permilagem'"
    );
    const valor = antigo.length ? parseFloat(antigo[0].valor) : 0.1;
    const valor1000 = Number.isFinite(valor) ? (valor * 1000).toFixed(4) : '100.0000';

    await queryInterface.sequelize.query(
      "INSERT INTO configuracoes (chave, valor, created_at, updated_at) VALUES ('quota_valor_1000', ?, NOW(), NOW())",
      { replacements: [valor1000] }
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "DELETE FROM configuracoes WHERE chave = 'quota_valor_1000'"
    );
  },
};
