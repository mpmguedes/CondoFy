'use strict';

// ─────────────────────────────────────────────────────────────────────
// P13 — segredos de autenticação em repouso.
//
// 1. `users.two_fa_totp_secret` passa a STRING(255).
//    O segredo TOTP deixa de ser guardado em texto simples: a aplicação cifra-o
//    com AES-256-GCM (helpers/segredos.js, chave ENCRYPTION_KEY). O formato
//    cifrado `enc:v1:<kid>:<iv>:<tag>:<ct>` ocupa ~97 caracteres para um segredo
//    Base32 de 32 — não cabia em STRING(64).
//
//    A CIFRAGEM dos valores existentes NÃO é feita aqui (a chave da instalação
//    não existe em SQL): é feita pela aplicação na primeira escrita do segredo,
//    e a leitura continua a aceitar o valor antigo em texto simples entretanto.
//
// 2. `users.convite_token` e `users.reset_token` passam a guardar o DIGEST
//    SHA-256 do token, nunca o token (ver helpers/tokens.js).
//
//    Os valores existentes são convertidos aqui. Como o digest do MESMO token é
//    igual, TODOS os convites e pedidos de reposição em curso continuam válidos
//    — o link enviado por email não muda e o utilizador não nota nada.
//
// ── ORDEM DE APLICAÇÃO ──────────────────────────────────────────────
// Esta migração pressupõe o código novo:
//
//   · código novo + migração por aplicar → tudo funciona (a aplicação aceita o
//     texto simples e converte-o no momento em que o token é usado);
//   · código novo + migração aplicada    → situação final;
//   · código ANTIGO + migração aplicada  → os tokens em curso deixariam de ser
//     encontrados (o código antigo compara texto simples com digest).
//
// Aplicar código e migração na mesma janela. Depois de aplicar, confirmar o
// resultado com `node scripts/verificar-segredos-em-repouso.js`.
//
// ── IRREVERSIBILIDADE ───────────────────────────────────────────────
// Um SHA-256 não se inverte: os tokens originais não voltam. Ver o `down`.
// ─────────────────────────────────────────────────────────────────────
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('users', 'two_fa_totp_secret', {
      type: Sequelize.STRING(255),
      allowNull: true,
      comment: 'Segredo TOTP (Base32), cifrado em repouso (AES-256-GCM)',
    });

    // Conversão dos tokens em curso para digest — sem os invalidar.
    // `LOWER` é explícito: SHA2 devolve hexadecimal maiúsculo e o digest da
    // aplicação é minúsculo (a comparação não pode depender da collation).
    await queryInterface.sequelize.query(
      "UPDATE users SET convite_token = LOWER(SHA2(convite_token, 256)) " +
        "WHERE convite_token IS NOT NULL AND convite_token <> ''"
    );
    await queryInterface.sequelize.query(
      "UPDATE users SET reset_token = LOWER(SHA2(reset_token, 256)) " +
        "WHERE reset_token IS NOT NULL AND reset_token <> ''"
    );
  },

  async down() {
    // Nada é revertido, deliberadamente:
    //
    //   · os digests dos tokens são IRREVERSÍVEIS (um SHA-256 não se inverte) e
    //     continuam a funcionar com o código novo — não há nada a repor;
    //   · reduzir `two_fa_totp_secret` de volta a STRING(64) truncaria os
    //     segredos já cifrados (~97 caracteres) e inutilizaria o 2FA dos
    //     utilizadores afetados. O tipo mais largo é inofensivo.
    //
    // Reverter esta migração implica reverter o CÓDIGO, e nesse caso os valores
    // em texto simples voltam a ser aceites pela versão anterior. Os convites e
    // reposições já convertidos deixam de funcionar nessa versão — é o custo,
    // conhecido e documentado, de guardar tokens como digest.
  },
};
