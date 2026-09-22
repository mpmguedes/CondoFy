// ─────────────────────────────────────────────────────────────────────
// VERIFICAÇÃO READ-ONLY — segredos de autenticação em repouso (P13/P14).
//
// Porque existe: a migração `20260101000079-segredos-em-repouso.js` converte
// os tokens já existentes em digest e alarga a coluna do segredo TOTP, mas
// **não** consegue cifrar nada (a chave ENCRYPTION_KEY não existe em SQL). A
// cifragem do segredo TOTP e da password SMTP é feita pela aplicação, na
// primeira leitura/escrita. Este script diz, sem alterar nada, o que ainda
// está em texto simples.
//
// Este script NÃO ALTERA NADA. Só faz SELECT. Nenhum INSERT/UPDATE/DELETE/
// ALTER/DROP. Nunca imprime segredos — apenas contagens.
//
// Como ler o resultado:
//   · tokens (convite/reposição) ainda em texto simples → a migração não foi
//     aplicada. Aplicar `npx sequelize-cli db:migrate` (com o código novo já
//     instalado) e repetir. Os tokens em curso continuam válidos;
//   · segredo TOTP / password SMTP em texto simples → falta a chave ou os
//     valores ainda não foram reescritos. Verificar ENCRYPTION_KEY e voltar a
//     guardar a password SMTP em Configuração → Email / SMTP. O segredo TOTP
//     passa a cifrado na próxima escrita desse utilizador (ativar/desativar o
//     2FA por aplicação).
//
// Códigos de saída:
//   0  tudo cifrado/em digest (ou nada a proteger)
//   1  há valores em texto simples que PODEM ser protegidos (há chave)
//   2  base de dados indisponível — nada foi verificado
//
// Utilização: node scripts/verificar-segredos-em-repouso.js
// ─────────────────────────────────────────────────────────────────────
require('dotenv').config();

const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const segredos = require('../helpers/segredos');

const LARGURA = 74;
const linha = (t) => console.log('\n' + t + '\n' + '─'.repeat(LARGURA));

// Digest SHA-256: 64 hexadecimais minúsculos (o formato que a aplicação grava).
const DIGEST = '^[0-9a-f]{64}$';
const PREFIXO_CIFRA = 'enc:v1:%';

async function contar(sql) {
  const [r] = await sequelize.query(sql, { type: QueryTypes.SELECT });
  return Number(r && r.n) || 0;
}

async function main() {
  const estado = segredos.estado();

  linha('Segredos de autenticação em repouso');
  console.log(`Cifra da instalação (ENCRYPTION_KEY): ${estado.cifra ? 'configurada' : 'NÃO configurada'}`);
  if (!estado.cifra) {
    console.log('Sem chave nada pode ser cifrado: os valores abaixo continuam em texto');
    console.log('simples (comportamento anterior, sem regressão). Ver Configurações →');
    console.log('Armazenamento e Backups.');
  }

  // ── 1. Tokens de uso único (devem estar em digest) ────────────────
  linha('1. Tokens de uso único (convite / reposição de palavra-passe)');

  const convitesTotal = await contar(
    "SELECT COUNT(*) AS n FROM users WHERE convite_token IS NOT NULL AND convite_token <> ''"
  );
  const convitesClaro = await contar(
    `SELECT COUNT(*) AS n FROM users WHERE convite_token IS NOT NULL AND convite_token <> '' AND convite_token NOT REGEXP '${DIGEST}'`
  );
  const resetTotal = await contar(
    "SELECT COUNT(*) AS n FROM users WHERE reset_token IS NOT NULL AND reset_token <> ''"
  );
  const resetClaro = await contar(
    `SELECT COUNT(*) AS n FROM users WHERE reset_token IS NOT NULL AND reset_token <> '' AND reset_token NOT REGEXP '${DIGEST}'`
  );

  console.log(`Convites por usar: ${convitesTotal} (${convitesClaro} ainda em texto simples)`);
  console.log(`Reposições em curso: ${resetTotal} (${resetClaro} ainda em texto simples)`);

  // ── 2. Segredo TOTP e password SMTP (devem estar cifrados) ────────
  linha('2. Segredos em colunas (devem estar cifrados)');

  const totpTotal = await contar(
    "SELECT COUNT(*) AS n FROM users WHERE two_fa_totp_secret IS NOT NULL AND two_fa_totp_secret <> ''"
  );
  const totpClaro = await contar(
    `SELECT COUNT(*) AS n FROM users WHERE two_fa_totp_secret IS NOT NULL AND two_fa_totp_secret <> '' AND two_fa_totp_secret NOT LIKE '${PREFIXO_CIFRA}'`
  );
  const smtpTotal = await contar(
    "SELECT COUNT(*) AS n FROM configuracoes WHERE chave = 'smtp_pass' AND valor IS NOT NULL AND valor <> ''"
  );
  const smtpClaro = await contar(
    `SELECT COUNT(*) AS n FROM configuracoes WHERE chave = 'smtp_pass' AND valor IS NOT NULL AND valor <> '' AND valor NOT LIKE '${PREFIXO_CIFRA}'`
  );

  console.log(`Segredos TOTP guardados: ${totpTotal} (${totpClaro} ainda em texto simples)`);
  console.log(`Password SMTP guardada: ${smtpTotal ? 'sim' : 'não'}${smtpClaro ? ' — ainda em texto simples' : ''}`);

  // ── 3. Conclusão ─────────────────────────────────────────────────
  const emClaro = convitesClaro + resetClaro + totpClaro + smtpClaro;
  linha('Conclusão');

  if (emClaro === 0) {
    console.log('Tudo em digest/cifrado. Nada a fazer.');
    return 0;
  }
  if (!estado.cifra) {
    console.log(`${emClaro} valor(es) em texto simples, mas a chave ENCRYPTION_KEY não está`);
    console.log('configurada — não há nada que possa ser protegido nesta instalação.');
    return 0;
  }
  console.log(`${emClaro} valor(es) ainda em texto simples e a chave ESTÁ configurada.`);
  if (convitesClaro + resetClaro > 0) {
    console.log('  · tokens: aplicar a migração 20260101000079-segredos-em-repouso.js');
    console.log('    (`npx sequelize-cli db:migrate`) e voltar a correr este script.');
  }
  if (smtpClaro > 0) {
    console.log('  · password SMTP: voltar a guardá-la em Configuração → Email / SMTP');
    console.log('    (é cifrada ao guardar; o valor introduzido é o mesmo).');
  }
  if (totpClaro > 0) {
    console.log('  · segredos TOTP: ficam cifrados na próxima escrita de cada utilizador');
    console.log('    (ativar/desativar o 2FA por aplicação na respetiva conta).');
  }
  return 1;
}

main()
  .then((codigo) => {
    process.exitCode = codigo;
  })
  .catch((err) => {
    // Degradação: sem BD não se verifica nada e diz-se isso mesmo.
    console.error('\n✗ Não foi possível verificar (base de dados indisponível ou sem permissões).');
    console.error('  ' + (err && err.message ? err.message : err));
    process.exitCode = 2;
  })
  .finally(() => {
    sequelize.close().catch(() => {});
  });
