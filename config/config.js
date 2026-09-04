require('dotenv').config();

const base = {
  username: process.env.DB_USER || 'condofy',
  password: process.env.DB_PASS || 'condofy',
  database: process.env.DB_NAME || 'condofy',
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  // Dialect 'mysql' usa o driver mysql2, que é totalmente compatível com MariaDB.
  dialect: 'mysql',
  // O Sequelize executa "SET time_zone = '<valor>'" ao ligar; tem de ser um valor
  // válido. Com nome IANA (com "/") converte para o offset atual de Lisboa.
  timezone: 'Europe/Lisbon',
  logging: process.env.DB_LOGGING === 'true' ? console.log : false,
  define: {
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
    underscored: true,
  },
  dialectOptions: {
    charset: 'utf8mb4',
    // 'local' usa o fuso do processo; datas de negócio usam DATEONLY (sem fuso).
    timezone: 'local',
  },
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
};

module.exports = {
  development: base,
  test: { ...base, database: `${base.database}_test`, logging: false },
  production: base,
};
