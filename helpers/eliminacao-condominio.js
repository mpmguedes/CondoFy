// ─────────────────────────────────────────────────────────────────────
// Eliminação integral de um condomínio — descoberta de dependências a
// partir do SCHEMA REAL.
//
// ── Porque existe este módulo ─────────────────────────────────────────
// A primeira implementação (routes/global-admin.js) mantinha uma lista
// ESCRITA À MÃO de 13 tabelas (`TABELAS_ELIMINAR`). O schema real tem
// mais tabelas com `condominio_id`, e a lista ficou desalinhada em
// silêncio: a eliminação só funcionava em condomínios sem dados
// financeiros. Duas consequências concretas:
//
//   · `movimentos_bancarios` nunca era apagada, mas `contas_bancarias`
//     era — e a FK `movimentos_bancarios.conta_bancaria_id` tem
//     ON DELETE RESTRICT. O DELETE da conta rebentava com violação de
//     FK e a transação fazia rollback: a eliminação falhava SEMPRE em
//     qualquer condomínio com contas bancárias.
//   · Nas tabelas esquecidas ficavam dados órfãos (ou eram apagados por
//     CASCADE sem intenção explícita).
//
// A correção elimina a CLASSE do erro: em vez de uma lista, o módulo
// DESCUBRE as tabelas a partir do catálogo da própria BD
// (`information_schema`). Uma tabela nova com `condominio_id` criada
// por uma migration futura é detetada automaticamente — e, se não for
// tratável, a operação ABORTA em vez de continuar em silêncio.
//
// ── Princípio: fail-closed ────────────────────────────────────────────
// Perante QUALQUER incerteza, a resposta é NÃO ELIMINAR: rollback +
// erro explícito que nomeia a tabela/relação não tratada.
// Segurança e integridade dos dados têm prioridade sobre conseguir
// executar a eliminação.
//
// ── Âmbito ────────────────────────────────────────────────────────────
// Este módulo NÃO decide autorização nem pré-condições de negócio (isso
// é da rota). Recebe uma transação já aberta e, ou completa, ou lança.
// Nunca faz commit nem rollback: quem abriu a transação é quem a fecha.
// ─────────────────────────────────────────────────────────────────────

// Tabelas que NUNCA são eliminadas por fazerem parte da plataforma
// partilhada: não pertencem a um condomínio, mesmo que uma FK aponte
// para lá. Estão aqui por EXCEÇÃO EXPLÍCITA e documentada — a lista é
// curta e fechada de propósito, para que a decisão de as excluir seja
// sempre uma decisão consciente e não o efeito de um esquecimento.
//
// `users`    — contas globais; um utilizador pertence a VÁRIOS
//              condomínios. Eliminar o condomínio remove apenas a
//              associação (`utilizador_condominios`), nunca o utilizador.
// `condominios` — é a própria raiz que se está a eliminar.
// `audit_logs`  — registo de auditoria da plataforma: append-only. Não
//              se destrói a auditoria de um condomínio ao eliminá-lo —
//              é precisamente o registo que prova o que aconteceu.
const TABELAS_PLATAFORMA = ['users', 'condominios', 'audit_logs'];

// Tabelas partilhadas entre condomínios (catálogos da plataforma). NÃO
// têm `condominio_id` e não são alcançáveis por FK a partir de uma
// entidade do condomínio, logo nunca entram no fecho de dependências.
// Ficam declaradas para que a ausência seja uma afirmação verificada e
// não uma suposição.
//
// `backup_logs` — registo global de backups (não por condomínio).
const TABELAS_PARTILHADAS = ['backup_logs'];

// Tabelas cujo `condominio_id` é NULLABLE e cujas linhas com NULL são
// INTENCIONAIS e ficam fora do âmbito da eliminação. Não são «não
// tratadas»: são tratadas por decisão explícita — ficam como estão.
//
// `fornecedores`  — migração 65: NULL = histórico ambíguo/global, «não
//                   listado nos condomínios». Não pertence ao
//                   condomínio que se elimina, por isso não se apaga.
// `email_fila`    — migração 64: NULL = global/órfão histórico, «nunca
//                   listado nas áreas dos condomínios».
// `movimentos_bancarios` — migração 74: NULL no histórico anterior;
//                   migração 76 preencheu-os via conta bancária.
//
// ⛔ Uma tabela NOVA com `condominio_id` nullable NÃO entra aqui sem
// decisão humana: a ausência desta linha é o que faz a eliminação
// recusar e nomear a tabela.
const TOLERADAS_COM_NULL = new Set(['fornecedores', 'email_fila', 'movimentos_bancarios']);

// Uma FK com ON DELETE RESTRICT/CASCADE na direção filho→pai significa
// que o PAI não pode ser apagado enquanto existirem filhos. Para apagar
// o pai, os filhos têm de sair PRIMEIRO. É esta a regra que dá a ordem.
const RESTRITIVAS = ['RESTRICT', 'NO ACTION'];

/**
 * Descobre, a partir do catálogo da BD, todas as tabelas que têm uma
 * coluna `condominio_id` e todas as FKs do schema.
 *
 * Devolve { comCondominioId: Set, fks: Array<{tabela, coluna, alvo, onDelete}> }.
 *
 * Usa `information_schema`, que existe em MySQL/MariaDB (o dialeto do
 * projeto). Uma tabela nova com `condominio_id` aparece aqui sem que
 * ninguém tenha de atualizar uma lista.
 */
async function descobrirSchema(sequelize, { schema } = {}) {
  const QueryTypes = sequelize.constructor.QueryTypes || require('sequelize').QueryTypes;
  const baseDados = schema || (await sequelize.query('SELECT DATABASE() AS db', { type: QueryTypes.SELECT }))[0].db;

  const colunas = await sequelize.query(
    `SELECT TABLE_NAME AS tabela, COLUMN_NAME AS coluna, IS_NULLABLE AS anulavel
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = :baseDados`,
    { type: QueryTypes.SELECT, replacements: { baseDados } }
  );

  const comCondominioId = new Set(
    colunas.filter((c) => c.coluna === 'condominio_id').map((c) => c.tabela)
  );

  // Colunas `condominio_id` que aceitam NULL — ver `TOLERADAS_COM_NULL`.
  const nullable = new Set(
    colunas
      .filter((c) => c.coluna === 'condominio_id' && String(c.anulavel || '').toUpperCase() === 'YES')
      .map((c) => c.tabela)
  );

  const fksBrutas = await sequelize.query(
    `SELECT TABLE_NAME AS tabela,
            COLUMN_NAME AS coluna,
            REFERENCED_TABLE_NAME AS alvo,
            REFERENCED_COLUMN_NAME AS alvoColuna,
            DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
      WHERE k.TABLE_SCHEMA = :baseDados
        AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    { type: QueryTypes.SELECT, replacements: { baseDados } }
  );

  const fks = fksBrutas.map((f) => ({
    tabela: f.tabela,
    coluna: f.coluna,
    alvo: f.alvo,
    alvoColuna: f.alvoColuna,
    onDelete: String(f.onDelete || '').toUpperCase(),
  }));

  return { comCondominioId, fks, nullable, baseDados };
}

/**
 * Calcula o fecho de dependências de um condomínio.
 *
 * Devolve:
 *   raizes   — tabelas com `condominio_id` (eliminadas por
 *              `WHERE condominio_id = ?`)
 *   indirectas — tabelas SEM `condominio_id` mas alcançáveis por FK a
 *              partir de uma raiz (eliminadas por subconsulta à FK)
 *   ordem    — ordem de eliminação: filhos antes dos pais
 *   naoTratadas — tabelas em `comCondominioId` que não foi possível
 *              classificar (⇒ falha)
 */
function calcularDependencias({ comCondominioId, fks, nullable = new Set() }) {
  const plataforma = new Set(TABELAS_PLATAFORMA);

  // Todas as tabelas do schema (derivadas das FKs + das com condominio_id).
  const tabelas = new Set([...comCondominioId]);
  for (const fk of fks) {
    if (!plataforma.has(fk.tabela)) tabelas.add(fk.tabela);
    if (!plataforma.has(fk.alvo)) tabelas.add(fk.alvo);
  }

  // ── 1. Raízes: têm condominio_id e não são tabelas de plataforma ──
  const raizes = [...comCondominioId].filter((t) => !plataforma.has(t)).sort();

  // ── 2. Fecho: filhos sem condominio_id alcançáveis a partir das raízes ──
  // Repete-se até estabilizar, porque a cadeia pode ter vários níveis
  // (ex.: recibo_quotas → recibos → [condominio_id]).
  const noFecho = new Set(raizes);
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const fk of fks) {
      if (plataforma.has(fk.tabela)) continue;
      if (!tabelas.has(fk.tabela)) continue;
      if (noFecho.has(fk.tabela)) continue;
      if (noFecho.has(fk.alvo)) {
        noFecho.add(fk.tabela);
        mudou = true;
      }
    }
  }

  const indirectas = [...noFecho].filter((t) => !raizes.includes(t)).sort();

  // ── 3. Verificação fail-closed ────────────────────────────────────
  // A descoberta automática torna quase impossível «esquecer» uma tabela
  // com `condominio_id`: ela entra como raiz sem ninguém a declarar. O
  // risco REAL deixou de ser a lista incompleta e passou a ser outro,
  // mais subtil: uma tabela cuja coluna `condominio_id` é NULLABLE e que
  // tenha linhas com `condominio_id IS NULL`. Essas linhas não pertencem
  // a nenhum condomínio (histórico ambíguo/global), mas também não são
  // da plataforma — um `WHERE condominio_id = ?` não as apanha e ficam
  // órfãs em silêncio. É exatamente o caso de `fornecedores` e
  // `email_fila`, cujo `condominio_id` nasceu NULLABLE e cujo backfill
  // deixou NULL onde não havia prova inequívoca.
  //
  // Por isso a verificação é sobre a FORMA da coluna (nullable?) e não
  // sobre o valor das linhas: uma decisão de schema, não de negócio.
  // Uma tabela nullable entra em `naoTratadas` a menos que esteja em
  // `TOLERADAS_COM_NULL` — a lista de exceções CONSCIENTES e declaradas.
  const naoTratadas = [...comCondominioId]
    .filter((t) => !plataforma.has(t) && nullable.has(t) && !TOLERADAS_COM_NULL.has(t))
    .sort();

  // ── 4. Ordem: filhos antes dos pais ───────────────────────────────
  // Kahn sobre o grafo invertido (aresta filho→pai). Uma tabela só pode
  // ser eliminada quando tudo o que a referencia já saiu.
  const arestas = new Map(); // tabela → Set de tabelas que a referenciam
  for (const t of noFecho) arestas.set(t, new Set());
  for (const fk of fks) {
    if (!noFecho.has(fk.tabela) || !noFecho.has(fk.alvo)) continue;
    if (fk.tabela === fk.alvo) continue; // auto-referência: ignora
    // fk.tabela referencia fk.alvo ⇒ fk.tabela tem de sair PRIMEIRO.
    arestas.get(fk.alvo).add(fk.tabela);
  }

  const ordem = [];
  const removidas = new Set();
  let progresso = true;
  while (progresso) {
    progresso = false;
    for (const t of [...noFecho].sort()) {
      if (removidas.has(t)) continue;
      const pendentes = [...arestas.get(t)].filter((f) => !removidas.has(f));
      if (pendentes.length === 0) {
        ordem.push(t);
        removidas.add(t);
        progresso = true;
      }
    }
  }

  // Ciclo de FKs ⇒ impossível determinar ordem segura.
  const ciclo = [...noFecho].filter((t) => !removidas.has(t)).sort();

  return { raizes, indirectas, ordem, naoTratadas, ciclo, fks };
}

/**
 * Elimina todos os dados do condomínio dentro de uma transação JÁ ABERTA.
 *
 * Recebe `{ sequelize, condominioId, transaction, log }` e devolve um
 * resumo `{ porTabela: { tabela: n }, total }`.
 *
 * NUNCA faz commit/rollback. Se algo não for tratável, lança
 * `ErroEliminacao` — a transação de quem chamou reverte.
 *
 * Cada DELETE é sempre limitado ao condomínio alvo:
 *   · tabela com `condominio_id` → `WHERE condominio_id = :id`
 *   · tabela sem `condominio_id` → `WHERE <fk> IN (SELECT id FROM pai …)`,
 *     recursivamente, até chegar a uma tabela com `condominio_id`.
 */
class ErroEliminacao extends Error {
  constructor(mensagem, detalhes = {}) {
    super(mensagem);
    this.name = 'ErroEliminacao';
    this.detalhes = detalhes;
  }
}

async function eliminarDadosDoCondominio({ sequelize, condominioId, transaction, log = () => {} }) {
  const QueryTypes = require('sequelize').QueryTypes;
  const id = Number(condominioId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ErroEliminacao('Identificador de condomínio inválido.', { condominioId });
  }

  const schema = await descobrirSchema(sequelize);
  const plano = calcularDependencias(schema);
  // ── Fail-closed: recusar se algo não estiver tratado ──────────────
  if (plano.naoTratadas.length) {
    throw new ErroEliminacao(
      `O schema tem ${plano.naoTratadas.length} tabela(s) com «condominio_id» que este eliminador não sabe tratar: ` +
        `${plano.naoTratadas.join(', ')}. A eliminação foi recusada (nada foi apagado). ` +
        'É preciso declarar a tabela no eliminador antes de a poder eliminar.',
      { tabelas: plano.naoTratadas }
    );
  }
  if (plano.ciclo.length) {
    throw new ErroEliminacao(
      `Dependências circulares detetadas entre ${plano.ciclo.join(', ')}; não é possível determinar uma ordem segura. ` +
        'A eliminação foi recusada (nada foi apagado).',
      { tabelas: plano.ciclo }
    );
  }

  const QueryTypesApagar = QueryTypes;
  const porTabela = {};
  let total = 0;

  // Expressão SQL que devolve os ids da tabela-alvo para um condomínio.
  // `subselect(tabela)` devolve o SQL que seleciona os ids existentes
  // dessa tabela pertencentes ao condomínio alvo (objectivo: eliminar
  // apenas o condomínio alvo, nunca globalmente).
  const cacheSub = new Map();
  function selectDoCondominio(tabela) {
    if (cacheSub.has(tabela)) return cacheSub.get(tabela);
    let sql;
    if (schema.comCondominioId.has(tabela)) {
      sql = `SELECT id FROM \`${tabela}\` WHERE condominio_id = ${sequelize.escape(id)}`;
    } else {
      // Sobe pela FK de maior precedência que conduza a uma tabela já
      // resolvível. Usa a primeira FK cujo alvo seja alcançável.
      const candidatas = schema.fks.filter((f) => f.tabela === tabela);
      const via = candidatas.find((f) => cacheSub.has(f.alvo) || schema.comCondominioId.has(f.alvo));
      if (!via) {
        // Sem caminho conhecido: incógnita. Deixa o chamador decidir.
        sql = null;
      } else {
        sql = `SELECT id FROM \`${tabela}\` WHERE \`${via.coluna}\` IN (${selectDoCondominio(via.alvo)})`;
      }
    }
    cacheSub.set(tabela, sql);
    return sql;
  }

  for (const tabela of plano.ordem) {
    const alvo = selectDoCondominio(tabela);
    if (!alvo) {
      throw new ErroEliminacao(
        `Não foi possível determinar como eliminar «${tabela}» (sem «condominio_id» e sem FK que conduza ao condomínio). ` +
          'A eliminação foi recusada (nada foi apagado).',
        { tabela }
      );
    }
    const [resultado] = await sequelize.query(`DELETE FROM \`${tabela}\` WHERE id IN (${alvo})`, {
      type: QueryTypesApagar.DELETE,
      transaction,
    });
    const n = Number(resultado && resultado.affectedRows ? resultado.affectedRows : 0);
    porTabela[tabela] = n;
    total += n;
    log(`  ${tabela.padEnd(28)} ${String(n).padStart(6)} linha(s)`);
  }

  return { porTabela, total, plano };
}

/**
 * Elimina o próprio condomínio (a linha raiz). Separado porque a ordem
 * o coloca no fim de tudo.
 */
async function eliminarCondominio({ sequelize, condominioId, transaction }) {
  const QueryTypes = require('sequelize').QueryTypes;
  const [r] = await sequelize.query('DELETE FROM `condominios` WHERE id = :id', {
    type: QueryTypes.DELETE,
    replacements: { id: Number(condominioId) },
    transaction,
  });
  return Number(r && r.affectedRows ? r.affectedRows : 0);
}

module.exports = {
  TABELAS_PLATAFORMA,
  TABELAS_PARTILHADAS,
  TOLERADAS_COM_NULL,
  RESTRITIVAS,
  ErroEliminacao,
  descobrirSchema,
  calcularDependencias,
  eliminarDadosDoCondominio,
  eliminarCondominio,
};
