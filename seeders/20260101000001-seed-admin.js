'use strict';

const bcrypt = require('bcryptjs');

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"
    );
    if (Number(rows[0].c) > 0) {
      return;
    }

    const email = process.env.ADMIN_EMAIL || 'admin@condofy.local';
    const password = process.env.ADMIN_PASSWORD || 'Admin123!';
    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();

    await queryInterface.bulkInsert('users', [
      {
        email,
        password_hash: passwordHash,
        nome: 'Administrador',
        role: 'admin',
        provider: 'local',
        ativo: 1,
        created_at: now,
        updated_at: now,
      },
    ]);

    console.log('────────────────────────────────────────────────────────');
    console.log('  Administrador criado (seed)');
    console.log(`  Email:    ${email}`);
    console.log(`  Palavra-passe: ${password}  (altere após o primeiro login)`);
    console.log('────────────────────────────────────────────────────────');
  },

  async down(queryInterface) {
    const email = process.env.ADMIN_EMAIL || 'admin@condofy.local';
    await queryInterface.bulkDelete('users', { email }, {});
  },
};
