'use strict';

// ─────────────────────────────────────────────────────────────────────
// P58 (ACHADO-04) — um só acesso de suporte VIGENTE por (utilizador, condomínio).
//
// Antes: `iniciar()` criava sempre um registo novo e deixava o anterior `ativo`
// até expirar. Dois acessos vivos do mesmo operador no mesmo condomínio davam a
// impressão de dois operadores em diagnóstico, e a sessão guardava só o último
// id — o anterior ficava inalcançável, nem o operador o conseguia fechar. A
// tabela tinha três índices, mas NENHUM era `unique`: nada impedia o estado
// inválido, nem a nível de aplicação nem de BD.
//
// ── Porque é que a unicidade é obtida com uma coluna GERADA ──────────
// O MariaDB não tem índices PARCIAIS (`... UNIQUE WHERE estado = 'ativo'`). Tem,
// porém, colunas GERADAS — e por aí obtém-se exatamente o mesmo efeito:
// `vigente_chave` vale 1 nos estados VIVOS e NULL nos TERMINAIS. Num índice
// único, NULL não colide com NULL (semântica SQL), pelo que:
//
//   · muitos acessos TERMINAIS do mesmo par  → permitidos (é HISTÓRICO);
//   · mais de um acesso VIVO do mesmo par    → RECUSADO pela BD.
//
// `PERSISTENT` (e não `VIRTUAL`) para o valor ser materializado e o índice
// construir-se diretamente sobre a coluna.
//
// Os estados TERMINAIS aqui repetidos são os de `helpers/suporte.js`
// (`ESTADOS_TERMINAIS`): a migration é um artefacto congelado no tempo e não
// pode importar o helper — um `require` do código de aplicação ligaria o
// histórico do schema à evolução do ficheiro. Se um estado novo entrar no ENUM,
// uma migration NOVA decide o que ele significa para a unicidade.
//
// ── SEGURANÇA SOBRE OS DADOS EXISTENTES ──────────────────────────────
// Se já existirem duplicados vivos, criar o índice FALHARIA e a migration
// ficaria a meio (coluna criada, índice em falta). Por isso o `up` começa por
// RESOLVER os duplicados: mantém o acesso mais recente de cada par (`MAX(id)`,
// que é precisamente o id que a sessão guarda) e termina os restantes, com a
// mesma transição da aplicação (`terminado` + `terminado_em`).
//
// ⚠️ Isto NÃO apaga nada: muda o ESTADO de acessos que já estavam duplicados.
// O histórico continua integral e reconstituível.
//
// Reversível: o `down` remove o índice e a coluna. Nenhum acesso é apagado em
// nenhum dos sentidos — nem no `up` nem no `down`.
// ─────────────────────────────────────────────────────────────────────

// Os três estados terminais, escritos uma vez. Mantidos como literal (e não
// interpolados a partir de uma lista JS) para que o SQL gerado seja exatamente
// o que se lê aqui.
const NAO_TERMINAIS = "estado NOT IN ('expirado','terminado','revogado')";
const E_TERMINAL = "estado IN ('expirado','terminado','revogado')";
const NOME_INDICE = 'acessos_suporte_um_vigente_por_par';

module.exports = {
  async up(queryInterface) {
    // 1. Resolver duplicados vivos ANTES de exigir unicidade.
    //    Sem este passo, o índice único falharia num clone com dados.
    await queryInterface.sequelize.query(
      'UPDATE acessos_suporte AS a '
      + '  JOIN ( '
      + '    SELECT utilizador_id, condominio_id, MAX(id) AS manter_id '
      + '    FROM acessos_suporte '
      + `    WHERE ${NAO_TERMINAIS} `
      + '    GROUP BY utilizador_id, condominio_id '
      + '    HAVING COUNT(*) > 1 '
      + '  ) AS d '
      + '    ON a.utilizador_id = d.utilizador_id '
      + '   AND a.condominio_id = d.condominio_id '
      + "SET a.estado = 'terminado', "
      + '    a.terminado_em = COALESCE(a.terminado_em, NOW()), '
      + '    a.updated_at = NOW() '
      + `WHERE ${NAO_TERMINAIS} `
      + '  AND a.id <> d.manter_id'
    );

    // 2. Coluna gerada: 1 quando VIVO, NULL quando TERMINAL.
    //    Os parênteses em volta do `CASE` são obrigatórios na gramática do
    //    MariaDB para colunas geradas.
    await queryInterface.sequelize.query(
      'ALTER TABLE acessos_suporte '
      + '  ADD COLUMN vigente_chave TINYINT(1) '
      + `    AS (CASE WHEN ${E_TERMINAL} THEN NULL ELSE 1 END) `
      + '    PERSISTENT'
    );

    // 3. O índice único que passa a ser o árbitro da invariante.
    await queryInterface.addIndex(
      'acessos_suporte',
      ['utilizador_id', 'condominio_id', 'vigente_chave'],
      { unique: true, name: NOME_INDICE }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('acessos_suporte', NOME_INDICE);
    await queryInterface.sequelize.query('ALTER TABLE acessos_suporte DROP COLUMN vigente_chave');
  },
};
