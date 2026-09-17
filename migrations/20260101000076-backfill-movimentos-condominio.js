'use strict';

// Backfill de `movimentos_bancarios.condominio_id`.
//
// ── Contexto ──────────────────────────────────────────────────────────────
// A coluna `condominio_id` foi acrescentada em 20260101000074 com a nota de
// que «fica NULL no histórico (nunca preenchido retroativamente — não se
// inventam dados)». Os movimentos criados ANTES dessa migração ficaram com
// NULL; os criados depois deviam ter sido preenchidos, mas vários writers
// (`helpers/pagamentos.js` ×3, `sincronizarMovimentoDespesa`) não passavam o
// condomínio — pelo que a coluna continuou a nascer NULL em escritas novas.
//
// O diagnóstico de produção (read-only) quantificou o problema:
//   · 41 movimentos no total
//   · 31 com condominio_id IS NULL
//   · 31 recuperáveis via conta_bancaria_id → contas_bancarias.condominio_id
//   ·  0 não recuperáveis
//   ·  0 incompatibilidades entre o condomínio da conta e o do movimento
//
// O condomínio de um movimento NÃO é um dado inventado: é o da sua conta
// bancária (`movimentos_bancarios.conta_bancaria_id` é NOT NULL e tem FK
// RESTRICT, logo a conta existe sempre). O backfill apenas copia o valor que
// já está determinado e é a única resposta possível — não há ambiguidade.
//
// ── Estratégia: SQL direto (não Sequelize) ────────────────────────────────
// Usa-se um UPDATE ... JOIN, que é atómico e não materializa as linhas em
// memória. A alternativa (findAll + update linha a linha) obrigaria a carregar
// as linhas e a construir N UPDATEs — mais lento e com risco de metade aplicado
// se o processo morrer a meio.
//
// ── Decisão: migração de dados NÃO REVERSÍVEL ─────────────────────────────
// O `down` desta migração é deliberadamente um NO-OP.
//
// Um `down` que repusesse NULL «nos movimentos de uma conta» apagaria
// `condominio_id` legítimos escritos DEPOIS desta migração — porque não há
// forma de distinguir, na base de dados, «NULL porque o writer não preenchia»
// de «NULL porque foi reposto por um rollback». Repor NULL seria destruir
// dados corretos, que é pior do que não reverter.
//
// Reverter esta migração não é necessário para voltar atrás no código: a coluna
// continua a existir e continua a ser lida (e os writers passam a preenchê-la),
// pelo que o `up` seguinte é idempotente. O código anterior a esta fase também
// lê corretamente movimentos com `condominio_id` preenchido — o fallback
// `condominio_id IS NULL` só alarga, nunca restringe.
//
// Portanto: `up` faz o backfill; `down` não faz nada (documentado aqui).
//
// ── Segurança ─────────────────────────────────────────────────────────────
// · Só toca em linhas com `condominio_id IS NULL` — nunca reescreve um valor já
//   preenchido.
// · Só escreve a coluna `condominio_id` — nenhuma outra coluna é alterada
//   (nem valores, nem datas, nem estados).
// · Antes de escrever, verifica se existe alguma linha cuja conta não permita
//   determinar o condomínio; se existir, ABORTA sem escrever nada.

module.exports = {
  async up(queryInterface) {
    const [antes] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n FROM movimentos_bancarios WHERE condominio_id IS NULL`
    );
    const nAntes = Number(antes[0].n);

    // Sem nada para fazer: a migração é idempotente e não deve falhar.
    if (nAntes === 0) {
      console.log('[backfill-movimentos] Nada a fazer: 0 movimentos com condominio_id NULL.');
      return;
    }

    // ── Guarda 1: linhas sem conta associada (não há como determinar) ──
    const [semConta] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n
         FROM movimentos_bancarios mb
         LEFT JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
        WHERE mb.condominio_id IS NULL
          AND cb.id IS NULL`
    );
    if (Number(semConta[0].n) > 0) {
      throw new Error(
        `[backfill-movimentos] ABORTADO: ${semConta[0].n} movimento(s) com condominio_id NULL `
        + 'cuja conta bancária não existe. Não é possível determinar o condomínio. '
        + 'Nenhuma linha foi alterada.'
      );
    }

    // ── Guarda 2: a conta existe mas o próprio condomínio está NULL ──
    // (contas_bancarias.condominio_id é NOT NULL no modelo; se isto disparar,
    //  a base de dados diverge do modelo e queremos parar, não adivinhar.)
    const [contaSemCond] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n
         FROM movimentos_bancarios mb
         JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
        WHERE mb.condominio_id IS NULL
          AND cb.condominio_id IS NULL`
    );
    if (Number(contaSemCond[0].n) > 0) {
      throw new Error(
        `[backfill-movimentos] ABORTADO: ${contaSemCond[0].n} movimento(s) cuja CONTA tem `
        + 'condominio_id NULL. Base de dados inconsistente com o modelo. Nenhuma linha foi alterada.'
      );
    }

    // ── Guarda 3: quantas linhas serão efetivamente alteradas ──────────
    const [recuperaveis] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n
         FROM movimentos_bancarios mb
         JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
        WHERE mb.condominio_id IS NULL
          AND cb.condominio_id IS NOT NULL`
    );
    const nRecuperaveis = Number(recuperaveis[0].n);

    // ── UPDATE: copia o condomínio da conta, só onde está NULL ─────────
    await queryInterface.sequelize.query(
      `UPDATE movimentos_bancarios mb
         JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
          SET mb.condominio_id = cb.condominio_id
        WHERE mb.condominio_id IS NULL
          AND cb.condominio_id IS NOT NULL`
    );

    const [depois] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n FROM movimentos_bancarios WHERE condominio_id IS NULL`
    );
    const nDepois = Number(depois[0].n);

    // ── Verificação pós-condição: tem de ter ficado tudo preenchido ────
    if (nDepois !== 0) {
      throw new Error(
        `[backfill-movimentos] INCONSISTENTE: ${nDepois} movimento(s) continuam com `
        + 'condominio_id NULL depois do backfill. Investigar antes de continuar.'
      );
    }

    console.log(
      `[backfill-movimentos] OK: ${nRecuperaveis} movimento(s) associados ao condomínio `
      + `da respetiva conta (NULL: ${nAntes} → ${nDepois}).`
    );
  },

  // NÃO REVERSÍVEL — ver a explicação no cabeçalho do ficheiro.
  // Repor NULL apagaria `condominio_id` legítimos escritos depois desta migração,
  // porque a base de dados não distingue «nunca preenchido» de «reposto a NULL».
  async down() {
    // Intencionalmente vazio: o backfill é uma correção de integridade de dados,
    // não uma alteração de esquema. Reverter não é possível sem destruir dados.
  },
};
