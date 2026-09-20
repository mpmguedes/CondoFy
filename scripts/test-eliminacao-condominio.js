// ═══════════════════════════════════════════════════════════════════
// Eliminação integral de um condomínio — testes OFFLINE (sem base de dados).
//
// ── Porque existe este teste ─────────────────────────────────────────
// A primeira implementação da eliminação mantinha uma lista ESCRITA À MÃO de
// 13 tabelas. O schema real tem mais, e `movimentos_bancarios` nunca era
// apagada enquanto `contas_bancarias` era — com FK RESTRICT, o DELETE da conta
// violava a FK e a transação revertia: a eliminação falhava SEMPRE em qualquer
// condomínio com contas bancárias. O teste 2 reproduz precisamente esse defeito.
//
// ── Como funciona sem BD ─────────────────────────────────────────────
// Um `sequelize` FALSO responde a `information_schema` com um schema REAL
// (extraído do projeto) e executa os DELETE sobre tabelas em memória com
// filtragem verdadeira. Assim verifica-se de facto:
//   · a descoberta das tabelas com `condominio_id`;
//   · a ordem calculada pelas FKs (filhos antes dos pais);
//   · o isolamento (cada DELETE só toca no condomínio alvo);
//   · o rollback (nenhum dado parcialmente eliminado);
//   · a recusa fail-closed perante uma tabela não tratada.
//
// Utilização: node scripts/test-eliminacao-condominio.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const eliminacao = require(path.join(RAIZ, 'helpers', 'eliminacao-condominio'));

let ok = 0;
function titulo(t) {
  console.log('\n── ' + t);
}
function feito(t) {
  ok += 1;
  console.log('  ✓ ' + t);
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA REAL do projeto (o que os testes devem exercitar)
// — derivado dos modelos/migrations; inclui as tabelas com condominio_id,
//   as suas filhas indirectas e as FKs relevantes.
// ═══════════════════════════════════════════════════════════════════
const COM_CONDOMINIO_ID = [
  'acessos_suporte', 'assembleias', 'avisos', 'contactos_pessoa', 'contas_bancarias',
  'despesas', 'documentos', 'email_fila', 'extra_quotas', 'fornecedor_saldos',
  'fornecedores', 'fracao_titularidades', 'fracoes', 'movimentos_bancarios',
  'orcamentos', 'pagamentos', 'pagamentos_fornecedores', 'pessoas', 'quotas',
  'recibos', 'utilizador_condominios',
];

// FK: [tabela, coluna, alvo, onDelete]
const FKS = [
  ['movimentos_bancarios', 'conta_bancaria_id', 'contas_bancarias', 'RESTRICT'],
  ['movimentos_bancarios', 'quota_id', 'quotas', 'SET NULL'],
  ['movimentos_bancarios', 'pagamento_id', 'pagamentos', 'SET NULL'],
  ['movimentos_bancarios', 'despesa_id', 'despesas', 'SET NULL'],
  ['movimentos_bancarios', 'deliberacao_id', 'agenda_items', 'SET NULL'],
  ['agenda_items', 'assembleia_id', 'assembleias', 'CASCADE'],
  ['assembleia_participantes', 'assembleia_id', 'assembleias', 'CASCADE'],
  ['assembleia_participantes', 'fracao_id', 'fracoes', 'SET NULL'],
  ['assembleia_participantes', 'pessoa_id', 'pessoas', 'SET NULL'],
  ['aviso_destinatarios', 'aviso_id', 'avisos', 'CASCADE'],
  ['aviso_destinatarios', 'fracao_id', 'fracoes', 'SET NULL'],
  ['contactos_pessoa', 'pessoa_id', 'pessoas', 'CASCADE'],
  ['fracao_pessoas', 'fracao_id', 'fracoes', 'CASCADE'],
  ['fracao_pessoas', 'pessoa_id', 'pessoas', 'CASCADE'],
  ['fracao_titularidades', 'fracao_id', 'fracoes', 'CASCADE'],
  ['fracao_titularidades', 'pessoa_id', 'pessoas', 'SET NULL'],
  ['fornecedor_saldos', 'fornecedor_id', 'fornecedores', 'CASCADE'],
  ['pagamentos_fornecedores', 'fornecedor_id', 'fornecedores', 'CASCADE'],
  ['pagamentos_fornecedores', 'despesa_id', 'despesas', 'SET NULL'],
  ['pagamentos_fornecedores', 'conta_bancaria_id', 'contas_bancarias', 'SET NULL'],
  ['pagamentos', 'fracao_id', 'fracoes', 'RESTRICT'],
  ['pagamentos', 'conta_bancaria_id', 'contas_bancarias', 'SET NULL'],
  ['pagamento_quotas', 'pagamento_id', 'pagamentos', 'CASCADE'],
  ['pagamento_quotas', 'quota_id', 'quotas', 'RESTRICT'],
  ['pagamento_extra_parcelas', 'pagamento_id', 'pagamentos', 'CASCADE'],
  ['pagamento_extra_parcelas', 'parcela_id', 'extra_quota_parcelas', 'RESTRICT'],
  ['quota', '0', 'fracao', 'skip'],
  ['quotas', 'fracao_id', 'fracoes', 'RESTRICT'],
  ['extra_quota_parcelas', 'extra_quota_id', 'extra_quotas', 'CASCADE'],
  ['recibo_quotas', 'recibo_id', 'recibos', 'CASCADE'],
  ['recibo_quotas', 'quota_id', 'quotas', 'CASCADE'],
  ['recibo_extra_parcelas', 'recibo_id', 'recibos', 'CASCADE'],
  ['recibo_extra_parcelas', 'parcela_id', 'extra_quota_parcelas', 'RESTRICT'],
  ['recibos', 'fracao_id', 'fracoes', 'CASCADE'],
  ['orcamento_rubricas', 'orcamento_id', 'orcamentos', 'CASCADE'],
  ['orcamento_alteracoes', 'orcamento_id', 'orcamentos', 'CASCADE'],
  ['orcamento_alteracoes', 'assembleia_id', 'assembleias', 'SET NULL'],
  ['orcamento_distribuicoes', 'orcamento_id', 'orcamentos', 'CASCADE'],
  ['orcamento_distribuicoes', 'rubrica_id', 'orcamento_rubricas', 'CASCADE'],
  ['orcamento_distribuicoes', 'fracao_id', 'fracoes', 'RESTRICT'],
  ['planos_quota', 'orcamento_id', 'orcamentos', 'CASCADE'],
  ['planos_quota', 'fracao_id', 'fracoes', 'RESTRICT'],
  ['despesas', 'conta_bancaria_id', 'contas_bancarias', 'SET NULL'],
  ['despesas', 'fornecedor_id', 'fornecedores', 'SET NULL'],
  ['despesas', 'deliberacao_id', 'agenda_items', 'SET NULL'],
  ['utilizador_condominios', 'utilizador_id', 'users', 'CASCADE'],
  ['utilizador_condominios', 'condominio_id', 'condominios', 'CASCADE'],
  ['acessos_suporte', 'utilizador_id', 'users', 'CASCADE'],
  ['acessos_suporte', 'condominio_id', 'condominios', 'CASCADE'],
  ['fornecedor_saldos', 'condominio_id', 'condominios', 'CASCADE'],
  ['agenda_items', 'assembleia_id', 'assembleias', 'CASCADE'],
].filter((f) => f[3] !== 'skip');

// Tabelas cujo `condominio_id` é NULLABLE no schema real (migrações 64/65/74).
// São as que o eliminador tem de reconhecer como «toleradas» — uma tabela
// nullable NOVA e não declarada faz a eliminação recusar (teste 11).
const NULLABLE_REAIS = ['email_fila', 'fornecedores', 'movimentos_bancarios'];

// ═══════════════════════════════════════════════════════════════════
// BD em memória
// ═══════════════════════════════════════════════════════════════════
function criarBD() {
  const bd = {};
  for (const t of COM_CONDOMINIO_ID) bd[t] = [];
  for (const t of ['agenda_items', 'assembleia_participantes', 'aviso_destinatarios',
    'extra_quota_parcelas', 'fracao_pessoas', 'orcamento_alteracoes', 'orcamento_distribuicoes',
    'orcamento_rubricas', 'pagamento_extra_parcelas', 'pagamento_quotas', 'planos_quota',
    'recibo_extra_parcelas', 'recibo_quotas', 'users', 'condominios', 'audit_logs']) {
    if (!bd[t]) bd[t] = [];
  }
  return bd;
}

// Executa um DELETE ... WHERE id IN (subselect) sobre a BD em memória.
// Interpreta o SQL gerado pelo eliminador — prova que o filtro é o correto.
function executarDelete(bd, sql, fks) {
  const m = sql.match(/^DELETE FROM `([a-z_]+)` WHERE id IN \((.*)\)$/);
  assert.ok(m, 'SQL de DELETE inesperado: ' + sql);
  const tabela = m[1];
  const seletores = m[2];

  const idsAlvo = resolverSubselect(bd, tabela, seletores, fks);
  const antes = bd[tabela].length;
  bd[tabela] = bd[tabela].filter((r) => !idsAlvo.has(Number(r.id)));
  return antes - bd[tabela].length;
}

// Interpreta SELECT id FROM `t` WHERE condominio_id = N
// ou SELECT id FROM `t` WHERE `fk` IN (…)
function resolverSubselect(bd, tabela, seletores, fks) {
  const semCond = seletores.match(/^SELECT id FROM `([a-z_]+)` WHERE condominio_id = '?(\d+)'?$/);
  if (semCond) {
    const t = semCond[1];
    const cid = Number(semCond[2]);
    return new Set(bd[t].filter((r) => Number(r.condominio_id) === cid).map((r) => Number(r.id)));
  }
  const viaFk = seletores.match(/^SELECT id FROM `([a-z_]+)` WHERE `([a-z_]+)` IN \((.*)\)$/);
  if (viaFk) {
    const t = viaFk[1];
    const coluna = viaFk[2];
    const interno = resolverSubselect(bd, t, viaFk[3], fks);
    return new Set(bd[t].filter((r) => interno.has(Number(r[coluna]))).map((r) => Number(r.id)));
  }
  throw new Error('subselect não interpretável: ' + seletores);
}

// `sequelize` falso: responde ao information_schema e executa os DELETE.
function criarSequelize(bd, { schemaExtra = [], fksExtra = [], falharEm = null, nullableExtra = [] } = {}) {
  const comCond = [...COM_CONDOMINIO_ID, ...schemaExtra];
  const fks = [...FKS, ...fksExtra];
  // Tabelas cujo `condominio_id` é NULLABLE no schema real.
  const tblNullable = new Set([...NULLABLE_REAIS, ...nullableExtra]);
  const registo = [];

  const sequ = {
    _bd: bd,
    _registo: registo,
    escape(v) {
      return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
    },
    async query(sql, opcoes = {}) {
      const s = sql.replace(/\s+/g, ' ').trim();

      // information_schema.COLUMNS — inclui IS_NULLABLE (o eliminador usa-o
      // para detetar tabelas cujo `condominio_id` aceita NULL).
      if (/FROM information_schema\.COLUMNS/i.test(s)) {
        const linhas = [];
        for (const t of comCond) {
          // nullable = as tabelas conhecidas cujo condominio_id nasceu NULLABLE.
          const anulavel = tblNullable.has(t) ? 'YES' : 'NO';
          linhas.push({ tabela: t, coluna: 'id', anulavel: 'NO' });
          linhas.push({ tabela: t, coluna: 'condominio_id', anulavel });
        }
        // Tabelas sem condominio_id relevantes para o fecho.
        for (const t of ['agenda_items', 'pagamento_quotas', 'recibo_quotas', 'users', 'condominios', 'audit_logs']) {
          linhas.push({ tabela: t, coluna: 'id', anulavel: 'NO' });
        }
        return linhas;
      }

      // information_schema.KEY_COLUMN_USAGE + REFERENTIAL_CONSTRAINTS
      if (/KEY_COLUMN_USAGE/i.test(s)) {
        return fks.map(([tabela, coluna, alvo, onDelete]) => ({ tabela, coluna, alvo, alvoColuna: 'id', onDelete }));
      }

      if (/SELECT DATABASE\(\)/i.test(s)) return [{ db: 'teste' }];

      // A raiz: DELETE FROM `condominios` WHERE id = :id
      const mDelRaiz = s.match(/^DELETE FROM `condominios` WHERE id = :id$/);
      if (mDelRaiz) {
        const cid = Number((opcoes.replacements || {}).id);
        const antes = bd.condominios.length;
        bd.condominios = bd.condominios.filter((r) => Number(r.id) !== cid);
        const n = antes - bd.condominios.length;
        registo.push({ tabela: 'condominios', n });
        return [{ affectedRows: n }, n];
      }

      const mDel = s.match(/^DELETE FROM `([a-z_]+)`/);
      if (mDel) {
        const tabela = mDel[1];
        if (falharEm && tabela === falharEm) {
          const e = new Error(`falha simulada ao eliminar ${tabela}`);
          e.simulada = true;
          throw e;
        }
        const n = executarDelete(bd, s, fks);
        registo.push({ tabela, n });
        // Sequelize devolve [result, metadata] para DELETE.
        return [{ affectedRows: n }, n];
      }

      throw new Error('query não suportada no teste: ' + s);
    },
  };
  return sequ;
}

// Transação falsa que reverte por snapshot (prova o rollback).
function criarTransacao(bd) {
  const copia = JSON.parse(JSON.stringify(bd));
  return {
    async commit() {
      /* nada: o snapshot deixa de ser restaurado */
    },
    async rollback() {
      for (const t of Object.keys(bd)) {
        bd[t] = copia[t] ? JSON.parse(JSON.stringify(copia[t])) : [];
      }
      // copia é restaurada para a BD partilhada
      for (const t of Object.keys(copia)) bd[t] = JSON.parse(JSON.stringify(copia[t]));
    },
  };
}

// Semeia um condomínio com dados mínimos por tabela.
function semear(bd, cid, { tabelas = null } = {}) {
  const alvo = (tabelas || COM_CONDOMINIO_ID).filter((t) => t !== 'utilizador_condominios');
  let seq = cid * 1000;
  for (const t of alvo) {
    bd[t].push({ id: (seq += 1), condominio_id: cid });
  }
  // A própria raiz tem de existir para o DELETE final ter efeito.
  bd.condominios.push({ id: cid, designacao: `Condomínio ${cid}` });
  return alvo;
}

// ═══════════════════════════════════════════════════════════════════
async function correr() {
  console.log('═══ Eliminação de condomínio — testes offline ═══');

  // ── 1. Condomínio simples ─────────────────────────────────────────
  titulo('1. Condomínio simples — eliminado integralmente');
  {
    const bd = criarBD();
    semear(bd, 1);
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    const r = await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();

    assert.ok(r.total > 0, 'deve eliminar linhas');
    assert.strictEqual(sequ._bd.audit_logs.length, 0, 'audit_logs não é tocada por esta função');
    const restos = COM_CONDOMINIO_ID.filter((tb) => tb !== 'utilizador_condominios')
      .filter((tb) => sequ._bd[tb].some((x) => Number(x.condominio_id) === 1));
    assert.deepStrictEqual(restos, [], 'nenhuma linha do condomínio 1 pode sobrar');
    feito(`condomínio simples eliminado (${r.total} linhas, ${r.plano.ordem.length} tabelas)`);
  }

  // ── 2. Condomínio FINANCEIRO — reproduz o defeito ─────────────────
  titulo('2. Condomínio com conta bancária + movimento (defeito reproduzido)');
  {
    const bd = criarBD();
    // conta e movimento: o movimento TEM de sair antes da conta.
    bd.contas_bancarias.push({ id: 7001, condominio_id: 1 });
    bd.movimentos_bancarios.push({ id: 7101, condominio_id: 1, conta_bancaria_id: 7001 });
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    const r = await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();

    assert.strictEqual(sequ._bd.movimentos_bancarios.length, 0, 'movimento eliminado');
    assert.strictEqual(sequ._bd.contas_bancarias.length, 0, 'conta eliminada');
    const iMov = r.plano.ordem.indexOf('movimentos_bancarios');
    const iConta = r.plano.ordem.indexOf('contas_bancarias');
    assert.ok(iMov !== -1 && iConta !== -1 && iMov < iConta,
      'movimentos_bancarios TEM de ser eliminada ANTES de contas_bancarias (era aqui que rebentava)');
    feito('conta bancária + movimento: eliminados, e o movimento saiu antes da conta');
  }

  // ── 3. Fornecedores ───────────────────────────────────────────────
  titulo('3. Fornecedor + saldo + pagamento a fornecedor');
  {
    const bd = criarBD();
    bd.fornecedores.push({ id: 8001, condominio_id: 1 });
    bd.fornecedor_saldos.push({ id: 8101, condominio_id: 1, fornecedor_id: 8001 });
    bd.pagamentos_fornecedores.push({ id: 8201, condominio_id: 1, fornecedor_id: 8001 });
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();
    assert.strictEqual(sequ._bd.fornecedores.length, 0, 'fornecedor eliminado');
    assert.strictEqual(sequ._bd.fornecedor_saldos.length, 0, 'saldo eliminado');
    assert.strictEqual(sequ._bd.pagamentos_fornecedores.length, 0, 'pagamento a fornecedor eliminado');
    feito('fornecedor + saldo + pagamento eliminados');
  }

  // ── 4. Titularidades ──────────────────────────────────────────────
  titulo('4. Fração + pessoa + titularidade');
  {
    const bd = criarBD();
    bd.fracoes.push({ id: 9001, condominio_id: 1 });
    bd.pessoas.push({ id: 9101, condominio_id: 1 });
    bd.fracao_titularidades.push({ id: 9201, condominio_id: 1, fracao_id: 9001, pessoa_id: 9101 });
    bd.fracao_pessoas.push({ id: 9301, fracao_id: 9001, pessoa_id: 9101 });
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();
    for (const tb of ['fracoes', 'pessoas', 'fracao_titularidades', 'fracao_pessoas']) {
      assert.strictEqual(sequ._bd[tb].length, 0, `${tb} eliminada`);
    }
    feito('fração + pessoa + titularidade (+ fracao_pessoas) eliminados');
  }

  // ── 5. Assembleias + agenda_items + deliberações ──────────────────
  titulo('5. Assembleia + agenda_items + deliberação (agenda_items SEM condominio_id)');
  {
    const bd = criarBD();
    bd.assembleias.push({ id: 4001, condominio_id: 1 });
    bd.agenda_items.push({ id: 4101, assembleia_id: 4001 }); // sem condominio_id!
    bd.documentos.push({ id: 4201, condominio_id: 1 });
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    const r = await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();
    assert.strictEqual(sequ._bd.assembleias.length, 0, 'assembleia eliminada');
    assert.strictEqual(sequ._bd.agenda_items.length, 0,
      'agenda_items (sem condominio_id) eliminada via FK à assembleia');
    assert.ok(r.plano.indirectas.includes('agenda_items'), 'agenda_items classificada como indirecta');
    const iAg = r.plano.ordem.indexOf('agenda_items');
    const iAs = r.plano.ordem.indexOf('assembleias');
    assert.ok(iAg < iAs, 'agenda_items sai antes de assembleias');
    feito('assembleia + agenda_items: indirecta eliminada antes do pai');
  }

  // ── 6. email_fila ─────────────────────────────────────────────────
  titulo('6. email_fila');
  {
    const bd = criarBD();
    bd.email_fila.push({ id: 5001, condominio_id: 1 });
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();
    assert.strictEqual(sequ._bd.email_fila.length, 0, 'email_fila eliminada');
    feito('email_fila eliminada');
  }

  // ── 7. acessos_suporte ────────────────────────────────────────────
  titulo('7. acesso de suporte');
  {
    const bd = criarBD();
    bd.acessos_suporte.push({ id: 6001, condominio_id: 1 });
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();
    assert.strictEqual(sequ._bd.acessos_suporte.length, 0, 'acesso de suporte eliminado');
    assert.strictEqual(sequ._bd.users.length, 0, 'nenhum utilizador é criado/apagado por esta via');
    feito('acessos_suporte eliminados; utilizadores intactos');
  }

  // ── 8. ISOLAMENTO A vs B (obrigatório) ────────────────────────────
  titulo('8. Isolamento: eliminar A não toca em B (obrigatório)');
  {
    const bd = criarBD();
    semear(bd, 1);
    semear(bd, 2);
    const snapB = {};
    for (const t of Object.keys(bd)) snapB[t] = JSON.stringify(bd[t].filter((r) => Number(r.condominio_id) === 2));

    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();

    for (const tb of COM_CONDOMINIO_ID) {
      const restA = sequ._bd[tb].filter((r) => Number(r.condominio_id) === 1);
      assert.strictEqual(restA.length, 0, `A: nada pode sobrar em ${tb}`);
      const agoraB = JSON.stringify(sequ._bd[tb].filter((r) => Number(r.condominio_id) === 2));
      assert.strictEqual(agoraB, snapB[tb], `B: ${tb} tem de ficar EXATAMENTE igual`);
    }
    feito('A eliminado, B intacto byte a byte em todas as tabelas');
  }

  // ── 9. ROLLBACK ───────────────────────────────────────────────────
  titulo('9. Rollback: falha a meio não deixa eliminação parcial');
  {
    const bd = criarBD();
    semear(bd, 1);
    const antes = JSON.parse(JSON.stringify(bd));

    // Falha explícita ao chegar a uma tabela concreta.
    const sequ = criarSequelize(bd, { falharEm: 'contas_bancarias' });
    const t = criarTransacao(bd);
    let falhou = false;
    try {
      await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
      await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
      await t.commit();
    } catch (e) {
      falhou = true;
      await t.rollback();
    }
    assert.ok(falhou, 'a operação tinha de falhar');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(bd)), antes,
      'NADA pode ter sido eliminado: rollback íntegro');
    feito('falha a meio → rollback total, dados exatamente como estavam');
  }

  // ── 10. Utilizador multi-condomínio ───────────────────────────────
  titulo('10. Utilizador em A e B: eliminar A mantém o utilizador e a associação a B');
  {
    const bd = criarBD();
    // Utilizador 99 associado a A(1) e B(2).
    bd.users.push({ id: 99, nome: 'Admin' });
    bd.utilizador_condominios.push({ id: 1001, utilizador_id: 99, condominio_id: 1 });
    bd.utilizador_condominios.push({ id: 1002, utilizador_id: 99, condominio_id: 2 });
    bd.fracoes.push({ id: 2001, condominio_id: 1 });

    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    // A rota apaga as associações do ALVO antes de delegar.
    bd.utilizador_condominios = bd.utilizador_condominios.filter((r) => Number(r.condominio_id) !== 1);
    await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await eliminacao.eliminarCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();

    assert.strictEqual(sequ._bd.users.length, 1, 'o utilizador NUNCA é apagado');
    assert.strictEqual(sequ._bd.utilizador_condominios.length, 1, 'sobra exatamente uma associação');
    assert.strictEqual(Number(sequ._bd.utilizador_condominios[0].condominio_id), 2, 'a que sobra é a de B');
    feito('associação a A removida; associação a B e o utilizador permanecem');
  }

  // ── 11. Schema com tabela NÃO tratada (fail-closed) ───────────────
  titulo('11. Schema futuro com tabela nullable não declarada → recusa + rollback + erro explícito');
  {
    const bd = criarBD();
    semear(bd, 1);
    // Tabela nova, com `condominio_id` NULLABLE, que o eliminador não
    // conhece. É o cenário real de uma migration futura: a coluna nasce
    // nullable (como nasceram email_fila/fornecedores) e pode conter
    // linhas com NULL que `WHERE condominio_id = ?` não apanharia.
    bd.tabela_nova_futura = [{ id: 1, condominio_id: 1 }, { id: 2, condominio_id: null }];
    const antes = JSON.parse(JSON.stringify(bd));

    const sequ = criarSequelize(bd, {
      schemaExtra: ['tabela_nova_futura'],
      nullableExtra: ['tabela_nova_futura'],
    });

    // A descoberta apanha a tabela nova sem ninguém a declarar…
    const schema = await eliminacao.descobrirSchema(sequ);
    assert.ok(schema.comCondominioId.has('tabela_nova_futura'), 'a descoberta apanha a tabela nova');
    assert.ok(schema.nullable.has('tabela_nova_futura'), 'a descoberta vê que é nullable');

    // …e o cálculo RECUSA, porque não está em TOLERADAS_COM_NULL.
    const plano = eliminacao.calcularDependencias(schema);
    assert.deepStrictEqual(plano.naoTratadas, ['tabela_nova_futura'],
      'a tabela nova tem de ser reportada como não tratada');

    const t = criarTransacao(bd);
    let erro = null;
    try {
      await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
      await t.commit();
    } catch (e) {
      erro = e;
      await t.rollback();
    }
    assert.ok(erro, 'a operação tinha de ser recusada');
    assert.strictEqual(erro.name, 'ErroEliminacao', 'erro do tipo de recusa de segurança');
    assert.ok(/tabela_nova_futura/.test(erro.message), 'a mensagem NOMEIA a tabela não tratada');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(bd)), antes, 'nada foi apagado');
    feito('tabela nullable não declarada → recusa nomeada, rollback, nada apagado');
  }

  // ── 11-bis. As nullable CONHECIDAS não bloqueiam ──────────────────
  titulo('11-bis. As tabelas nullable conhecidas NÃO bloqueiam a eliminação');
  {
    const sequ = criarSequelize(criarBD());
    const schema = await eliminacao.descobrirSchema(sequ);
    const plano = eliminacao.calcularDependencias(schema);
    assert.deepStrictEqual(plano.naoTratadas, [],
      'email_fila/fornecedores/movimentos_bancarios estão declaradas em TOLERADAS_COM_NULL');
    for (const t of NULLABLE_REAIS) {
      assert.ok(eliminacao.TOLERADAS_COM_NULL.has(t), `${t} declarada como tolerada`);
      assert.ok(plano.ordem.includes(t), `${t} continua a ser eliminada`);
    }
    feito('nullable conhecidas (email_fila, fornecedores, movimentos_bancarios) são eliminadas');
  }

  // ── Extra: a descoberta vem do schema, não de uma lista ───────────
  titulo('Extra A. A lista de tabelas vem do SCHEMA (não de uma lista à mão)');
  {
    const sequ = criarSequelize(criarBD());
    const schema = await eliminacao.descobrirSchema(sequ);
    for (const t of COM_CONDOMINIO_ID) {
      assert.ok(schema.comCondominioId.has(t), `${t} tem de ser descoberta pelo schema`);
    }
    const plano = eliminacao.calcularDependencias(schema);
    assert.deepStrictEqual(plano.naoTratadas, [], 'todas as tabelas reais são tratáveis');
    assert.deepStrictEqual(plano.ciclo, [], 'sem ciclos');
    assert.ok(plano.ordem.length >= 22, 'a ordem cobre todas as tabelas do fecho');
    feito(`${schema.comCondominioId.size} tabelas descobertas do schema; ordem de ${plano.ordem.length} passos`);
  }

  // ── Extra: nenhuma tabela de plataforma é eliminada ───────────────
  titulo('Extra B. Tabelas de plataforma nunca entram na ordem');
  {
    const sequ = criarSequelize(criarBD());
    const schema = await eliminacao.descobrirSchema(sequ);
    const plano = eliminacao.calcularDependencias(schema);
    for (const t of eliminacao.TABELAS_PLATAFORMA) {
      assert.ok(!plano.ordem.includes(t), `${t} não pode ser eliminada`);
    }
    assert.ok(!plano.ordem.includes('users'), 'users nunca é eliminada');
    assert.ok(!plano.ordem.includes('audit_logs'), 'audit_logs nunca é eliminada');
    feito('users, condominios e audit_logs excluídos da eliminação');
  }

  // ── Extra: cada DELETE é limitado ao condomínio alvo ──────────────
  titulo('Extra C. Todos os DELETE são limitados ao condomínio alvo');
  {
    const bd = criarBD();
    semear(bd, 1);
    semear(bd, 2);
    const sequ = criarSequelize(bd);
    const t = criarTransacao(bd);
    await eliminacao.eliminarDadosDoCondominio({ sequelize: sequ, condominioId: 1, transaction: t });
    await t.commit();
    // Nenhum DELETE pode ter apagado uma linha do condomínio 2.
    for (const tb of COM_CONDOMINIO_ID) {
      const b = sequ._bd[tb].filter((r) => Number(r.condominio_id) === 2).length;
      const seed = tb === 'utilizador_condominios' ? 0 : 1;
      assert.strictEqual(b, seed, `${tb}: condomínio 2 intacto`);
    }
    feito('nenhum DELETE tocou no condomínio não alvo');
  }

  console.log('');
  console.log(`✓ Testes de eliminação de condomínio passaram (${ok} verificações, sem BD).`);
}

correr().catch((e) => {
  console.error('\n✗ FALHA: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
