// ═══════════════════════════════════════════════════════════════════
// Duplo de transação REVERSÍVEL — partilhado pelas suítes P56.
//
// O padrão vem de `scripts/test-despesa-transacao.js` (P16) e existe por uma
// razão específica: provar por COMPORTAMENTO que uma escrita viajou na mesma
// transação do seu chamador, e não numa escrita autónoma.
//
// Modelo:
//   · as escritas aplicam-se IMEDIATAMENTE a `db` (é o estado que o pedido
//     seguinte observa — a base de dados «vê-se» a meio da transação);
//   · cada transação mantém um DIÁRIO DE DESFAZER com as escritas que recebeu
//     COM `{ transaction }`;
//   · `commit()`   descarta o diário (as escritas ficam);
//   · `rollback()` executa-o ao contrário (essas escritas desaparecem).
//
// Uma escrita que NÃO receba a transação não entra no diário: é autocommit e
// SOBREVIVE ao rollback. É assim que se distingue «propagou a transação» de
// «não propagou» — por comportamento, não por inspeção de código.
//
// Um teste que se limitasse a afirmar `rollback() foi chamado` não provaria
// nada: o duplo registaria a chamada e o efeito ficaria. Aqui o efeito TEM de
// desaparecer.
// ═══════════════════════════════════════════════════════════════════
const { Op } = require('sequelize');

// ── Diário de desfazer ─────────────────────────────────────────────
function registarDesfazer(opcoes, tabela, fn) {
  const t = opcoes && opcoes.transaction;
  if (t && Array.isArray(t.desfazer) && !t.concluida) {
    t.desfazer.push({ tabela, fn });
    return true;
  }
  return false;
}

function aplicarDesfazer(t) {
  const ops = t.desfazer.slice().reverse();
  t.desfazer.length = 0;
  for (const op of ops) op.fn();
}

// Caixa de ferramentas de uma execução: guarda o estado, os id automáticos e as
// injeções de falha. Cada suíte cria a sua (não há estado global partilhado).
function criarBancada({ tabelas }) {
  const db = {};
  for (const t of tabelas) db[t] = [];
  const proximoId = {};
  for (const t of tabelas) proximoId[t] = 0;

  // Injeções de falha (armadas por cenário).
  const falhas = {};

  // Observabilidade.
  const auditorias = [];
  const consultas = [];

  function reiniciar() {
    for (const t of tabelas) { db[t] = []; proximoId[t] = 0; }
    for (const k of Object.keys(falhas)) delete falhas[k];
    auditorias.length = 0;
    consultas.length = 0;
  }

  async function abrirTransacao() {
    const t = {
      LOCK: { UPDATE: 'UPDATE' },
      desfazer: [],
      concluida: false,
      async commit() {
        if (t.concluida) return;
        const gatilho = falhas.aoCommit;
        if (typeof gatilho === 'function' && gatilho(t)) {
          aplicarDesfazer(t);
          t.concluida = true;
          throw new Error('ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; try restarting transaction');
        }
        t.concluida = true;
      },
      async rollback() {
        if (t.concluida) return;
        aplicarDesfazer(t);
        t.concluida = true;
      },
    };
    return t;
  }

  // ── Predicado `where` (honra os operadores que as rotas usam) ─────
  function onde(linhas, where) {
    if (!where) return linhas;
    return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
      if (v === null) return l[k] === null || l[k] === undefined;
      if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].map(String).includes(String(l[k]));
      if (v && typeof v === 'object' && v[Op.notIn]) return !v[Op.notIn].map(String).includes(String(l[k]));
      if (v && typeof v === 'object' && v[Op.ne] !== undefined) return String(l[k]) !== String(v[Op.ne]);
      if (v && typeof v === 'object' && v[Op.or]) return v[Op.or].some((c) => onde([l], c).length === 1);
      return String(l[k]) === String(v);
    }));
  }

  // Escrita de campos: regista o estado anterior no diário e só depois aplica.
  // Sem transação (ou com transação já fechada) é autocommit.
  function atualizarCampos(linha, valores, opcoes, tabela) {
    const antes = {};
    for (const k of Object.keys(valores)) antes[k] = linha[k];
    registarDesfazer(opcoes, tabela, () => Object.assign(linha, antes));
    Object.assign(linha, valores);
    return linha;
  }

  function criarLinha(tabela, linha, opcoes) {
    db[tabela].push(linha);
    registarDesfazer(opcoes, tabela, () => {
      const i = db[tabela].indexOf(linha);
      if (i >= 0) db[tabela].splice(i, 1);
    });
    return linha;
  }

  // Envolve uma linha com os métodos que as rotas chamam. A linha continua a
  // ser o objeto simples de `db` (o teste lê os campos diretamente), mas ganha
  // `toJSON`/`update` — e é o `update` que honra a transação.
  const comMetodos = (tabela) => (l) => (l ? (Object.assign(l, {
    update: async (v, o = {}) => atualizarCampos(l, v, o, tabela),
    toJSON: () => ({ ...l }),
    destroy: async () => {},
  }), l) : null);

  // ── Fábrica de modelos ────────────────────────────────────────────
  // `tabela`    — nome do array em `db`.
  // `iniciais`  — campos por omissão do `create` (estado, etc.).
  // `aoCriar`   — gancho de injeção de falha ({falhas}) => void.
  function modelo(tabela, { iniciais = {}, aoCriar = null, extras = {} } = {}) {
    const comLinha = comMetodos(tabela);
    const m = {
      findAll: async (o = {}) => {
        consultas.push({ nome: tabela + '.findAll', where: o.where });
        return onde(db[tabela], o.where).map(comLinha);
      },
      findOne: async (o = {}) => {
        consultas.push({ nome: tabela + '.findOne', where: o.where });
        return comLinha(onde(db[tabela], o.where)[0]) || null;
      },
      count: async (o = {}) => onde(db[tabela], o.where).length,
      sum: async (campo, o = {}) => onde(db[tabela], o.where).reduce((s, l) => s + Number(l[campo] || 0), 0),
      create: async (d, o = {}) => {
        if (aoCriar) aoCriar({ falhas, d, o, db });
        const linha = criarLinha(tabela, { id: ++proximoId[tabela], ...iniciais, ...d }, o);
        return comLinha(linha);
      },
      update: async () => [0],
      findByPk: async (id) => comLinha(db[tabela].find((l) => String(l.id) === String(id))) || null,
      findOrCreate: async (opcoes) => {
        const achada = onde(db[tabela], opcoes.where)[0];
        if (achada) return [comLinha(achada), false];
        const nova = criarLinha(tabela, { id: ++proximoId[tabela], ...iniciais, ...opcoes.defaults }, opcoes);
        return [comLinha(nova), true];
      },
    };
    return Object.assign(m, extras);
  }

  return {
    db, proximoId, falhas, auditorias, consultas,
    reiniciar, abrirTransacao, onde, registarDesfazer, aplicarDesfazer,
    atualizarCampos, criarLinha, comMetodos, modelo,
  };
}

module.exports = { criarBancada, registarDesfazer, aplicarDesfazer };
