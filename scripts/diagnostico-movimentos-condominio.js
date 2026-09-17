// ═══════════════════════════════════════════════════════════════════
// Diagnóstico (SOMENTE LEITURA) da tabela `movimentos_bancarios`.
//
// Responde à pergunta central da Fase 2.1:
//   quantos movimentos existem, quantos têm `condominio_id` NULL, a que contas
//   pertencem e se esses NULL são recuperáveis inequivocamente pela conta.
//
// Utilização (no servidor, no diretório da aplicação):
//   node scripts/diagnostico-movimentos-condominio.js
//   docker compose exec app node scripts/diagnostico-movimentos-condominio.js
//
// Este script NÃO escreve na base de dados: só faz SELECT. Não cria quotas,
// movimentos nem índices, não corre jobs, não envia emails, não reinicia
// serviços. É seguro correr em produção.
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();

const { QueryTypes } = require('sequelize');

function linha(titulo) {
  console.log('');
  console.log('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 62 - titulo.length)));
}
function eur(v) {
  const n = Number(v || 0);
  return n.toFixed(2).replace('.', ',') + ' €';
}
function txt(v, largura) {
  const s = v === null || v === undefined ? '—' : String(v);
  return s.length > largura ? s.slice(0, largura - 1) + '…' : s.padEnd(largura);
}
function maskIban(iban) {
  if (!iban) return '—';
  const s = String(iban);
  if (s.length <= 8) return s.slice(0, 2) + '…';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Diagnóstico de movimentos bancários × condomínio (só leitura)');
  console.log('══════════════════════════════════════════════════════════════');

  const sequelize = require('../config/database');

  // Verifica ligação antes de tudo.
  try {
    await sequelize.authenticate();
  } catch (err) {
    console.log('');
    console.log('  Não foi possível ligar à base de dados: ' + err.message);
    console.log('  Execute este script no ambiente onde a aplicação corre');
    console.log('  (com o .env correto) — não faz qualquer escrita.');
    process.exit(1);
  }

  // Só SELECT: nunca há QueryTypes.INSERT/UPDATE/DELETE/BULKUPDATE neste ficheiro.
  const S = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT });

  // ── 1. Inventário global ──────────────────────────────────────────
  linha('1. Inventário global');
  const [total] = await S(`
    SELECT
      COUNT(*) AS n_total,
      SUM(CASE WHEN estado = 'confirmado' THEN 1 ELSE 0 END) AS n_conf,
      SUM(CASE WHEN estado = 'anulado'   THEN 1 ELSE 0 END) AS n_anul,
      SUM(CASE WHEN tipo = 'entrada' THEN 1 ELSE 0 END) AS n_ent,
      SUM(CASE WHEN tipo = 'saida'   THEN 1 ELSE 0 END) AS n_sai,
      SUM(CASE WHEN tipo = 'transferencia' THEN 1 ELSE 0 END) AS n_trf,
      SUM(CASE WHEN condominio_id IS NOT NULL THEN 1 ELSE 0 END) AS n_com_cond,
      SUM(CASE WHEN condominio_id IS NULL     THEN 1 ELSE 0 END) AS n_sem_cond
    FROM movimentos_bancarios
  `);
  const num = (v) => Number(v || 0);
  console.log('  Total movimentos:      ' + num(total.n_total));
  console.log('  Com condominio_id:     ' + num(total.n_com_cond));
  console.log('  Sem condominio_id:     ' + num(total.n_sem_cond));
  console.log('');
  console.log('  Confirmados:           ' + num(total.n_conf));
  console.log('  Anulados:              ' + num(total.n_anul));
  console.log('');
  console.log('  Entradas:              ' + num(total.n_ent));
  console.log('  Saídas:                ' + num(total.n_sai));
  console.log('  Transferências:        ' + num(total.n_trf));
  if (num(total.n_com_cond) + num(total.n_sem_cond) !== num(total.n_total)) {
    console.log('  ATENÇÃO: tipo desconhecido encontrado (soma dos tipos ≠ total).');
  }

  // ── 2. Distribuição por condomínio (pelo condominio_id gravado) ───
  linha('2. Distribuição por condominio_id gravado no movimento');
  const porCond = await S(`
    SELECT
      mb.condominio_id AS cid,
      COALESCE(c.nome, c.designacao, '(removido)') AS nome,
      COUNT(*) AS n,
      SUM(CASE WHEN mb.estado = 'confirmado' THEN 1 ELSE 0 END) AS n_conf,
      SUM(CASE WHEN mb.estado = 'anulado'   THEN 1 ELSE 0 END) AS n_anul,
      SUM(CASE WHEN mb.tipo = 'entrada' AND mb.estado = 'confirmado' THEN mb.valor ELSE 0 END) AS v_ent,
      SUM(CASE WHEN mb.tipo = 'saida'   AND mb.estado = 'confirmado' THEN mb.valor ELSE 0 END) AS v_sai
    FROM movimentos_bancarios mb
    LEFT JOIN condominios c ON c.id = mb.condominio_id
    WHERE mb.condominio_id IS NOT NULL
    GROUP BY mb.condominio_id, nome
    ORDER BY mb.condominio_id ASC
  `);
  console.log('  ' + txt('Cond. ID', 9) + '| ' + txt('Nome', 30) + '| ' +
    txt('Nº', 7) + '| ' + txt('Conf', 6) + '| ' + txt('Anul', 6) + '| ' +
    txt('V. entradas', 14) + '| ' + txt('V. saídas', 14));
  if (!porCond.length) console.log('  (nenhum movimento com condominio_id preenchido)');
  for (const r of porCond) {
    console.log('  ' + txt(r.cid, 9) + '| ' + txt(r.nome, 30) + '| ' +
      txt(r.n, 7) + '| ' + txt(r.n_conf, 6) + '| ' + txt(r.n_anul, 6) + '| ' +
      txt(eur(r.v_ent), 14) + '| ' + txt(eur(r.v_sai), 14));
  }

  console.log('');
  console.log('  Movimentos com condominio_id IS NULL (total): ' + num(total.n_sem_cond));
  if (num(total.n_sem_cond) > 0) {
    const [aggNull] = await S(`
      SELECT
        SUM(CASE WHEN tipo = 'entrada' AND estado = 'confirmado' THEN valor ELSE 0 END) AS v_ent,
        SUM(CASE WHEN tipo = 'saida'   AND estado = 'confirmado' THEN valor ELSE 0 END) AS v_sai,
        SUM(CASE WHEN tipo = 'transferencia' THEN 1 ELSE 0 END) AS n_trf
      FROM movimentos_bancarios WHERE condominio_id IS NULL
    `);
    console.log('    Entradas confirmadas: ' + eur(aggNull.v_ent));
    console.log('    Saídas confirmadas:   ' + eur(aggNull.v_sai));
    console.log('    Transferências:       ' + num(aggNull.n_trf));
  }

  // ── 3. Movimentos NULL por conta bancária (O DIAGNÓSTICO CENTRAL) ─
  linha('3. Movimentos NULL por conta bancária (diagnóstico central)');
  const nullPorConta = await S(`
    SELECT
      mb.conta_bancaria_id AS conta_id,
      cb.nome AS conta,
      cb.condominio_id AS conta_cid,
      COALESCE(c.nome, c.designacao, '(sem condomínio)') AS conta_cond,
      COUNT(*) AS n,
      SUM(CASE WHEN mb.tipo = 'entrada' AND mb.estado = 'confirmado' THEN mb.valor ELSE 0 END) AS v_ent,
      SUM(CASE WHEN mb.tipo = 'saida'   AND mb.estado = 'confirmado' THEN mb.valor ELSE 0 END) AS v_sai,
      MIN(mb.data) AS primeiro,
      MAX(mb.data) AS ultimo
    FROM movimentos_bancarios mb
    LEFT JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
    LEFT JOIN condominios c ON c.id = cb.condominio_id
    WHERE mb.condominio_id IS NULL
    GROUP BY mb.conta_bancaria_id, cb.nome, cb.condominio_id, conta_cond
    ORDER BY n DESC
  `);
  console.log('  ' + txt('Conta ID', 9) + '| ' + txt('Conta', 22) + '| ' +
    txt('Cond.', 7) + '| ' + txt('Condomínio', 26) + '| ' + txt('Nº', 7) + '| ' +
    txt('Entradas', 13) + '| ' + txt('Saídas', 13) + '| ' +
    txt('Primeiro', 11) + '| ' + txt('Último', 11));
  if (!nullPorConta.length) console.log('  (nenhum movimento com condominio_id NULL)');
  for (const r of nullPorConta) {
    console.log('  ' + txt(r.conta_id, 9) + '| ' + txt(r.conta, 22) + '| ' +
      txt(r.conta_cid === null ? 'NULL' : r.conta_cid, 7) + '| ' + txt(r.conta_cond, 26) + '| ' +
      txt(r.n, 7) + '| ' + txt(eur(r.v_ent), 13) + '| ' + txt(eur(r.v_sai), 13) + '| ' +
      txt(r.primeiro, 11) + '| ' + txt(r.ultimo, 11));
  }

  // Irrecuperáveis: conta inexistente OU conta sem condomínio.
  const irrecuperaveis = nullPorConta.filter((r) => r.conta_cid === null || r.conta === null);
  console.log('');
  if (!irrecuperaveis.length) {
    console.log('  RESPOSTA: NÃO existem movimentos NULL cuja conta não permita determinar');
    console.log('            inequivocamente o condomínio. Todos os NULL são recuperáveis');
    console.log('            por conta_bancaria_id → contas_bancarias.condominio_id.');
  } else {
    console.log('  ATENÇÃO — ' + irrecuperaveis.length + ' conta(s) com movimentos NULL e condomínio');
    console.log('            indeterminável (conta inexistente ou sem condominio_id):');
    for (const r of irrecuperaveis) {
      console.log('   · conta ' + r.conta_id + ' (' + (r.conta || 'INEXISTENTE') + ') — ' +
        r.n + ' movimento(s) NULL, ' + eur(Number(r.v_ent) - Number(r.v_sai)) + ' líquido');
    }
  }

  // ── 4. Inconsistências: condomínio do movimento ≠ condomínio da conta ─
  linha('4. Inconsistências movimento.condominio_id ≠ conta.condominio_id');
  const inconsistentes = await S(`
    SELECT
      mb.id, mb.conta_bancaria_id, cb.nome AS conta,
      mb.condominio_id AS mov_cid, cb.condominio_id AS conta_cid,
      mb.data, mb.tipo, mb.valor, mb.estado
    FROM movimentos_bancarios mb
    JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
    WHERE mb.condominio_id IS NOT NULL
      AND (cb.condominio_id IS NULL OR mb.condominio_id <> cb.condominio_id)
    ORDER BY mb.id ASC
    LIMIT 50
  `);
  console.log('  Movimentos com condomínio diferente do da conta: ' + inconsistentes.length +
    (inconsistentes.length === 50 ? ' (limitado a 50 na listagem)' : ''));
  if (!inconsistentes.length) {
    console.log('  Resultado esperado: zero. O vínculo movimento ↔ conta está coerente.');
  } else {
    for (const r of inconsistentes) {
      console.log('   · mov ' + r.id + ' conta ' + r.conta_bancaria_id + ' (' + r.conta + ') — ' +
        'mov.cond=' + r.mov_cid + ' / conta.cond=' + r.conta_cid +
        ' — ' + r.data + ' ' + r.tipo + ' ' + eur(r.valor) + ' [' + r.estado + ']');
    }
    console.log('  (INVESTIGAR: estes casos não são recuperáveis por simples backfill.)');
  }

  // ── 5. Movimentos NULL por origem ─────────────────────────────────
  linha('5. Movimentos NULL por origem (relações presentes)');
  const [origens] = await S(`
    SELECT
      SUM(CASE WHEN pagamento_id IS NOT NULL THEN 1 ELSE 0 END) AS n_pag,
      SUM(CASE WHEN despesa_id IS NOT NULL THEN 1 ELSE 0 END) AS n_desp,
      SUM(CASE WHEN extra_quota_parcela_id IS NOT NULL THEN 1 ELSE 0 END) AS n_extra,
      SUM(CASE WHEN documento_id IS NOT NULL THEN 1 ELSE 0 END) AS n_doc,
      SUM(CASE WHEN deliberacao_id IS NOT NULL THEN 1 ELSE 0 END) AS n_delib,
      SUM(CASE WHEN quota_id IS NOT NULL THEN 1 ELSE 0 END) AS n_quota,
      SUM(CASE WHEN pagamento_id IS NULL AND despesa_id IS NULL
                AND extra_quota_parcela_id IS NULL AND documento_id IS NULL
                AND deliberacao_id IS NULL AND quota_id IS NULL
           THEN 1 ELSE 0 END) AS n_manual
    FROM movimentos_bancarios WHERE condominio_id IS NULL
  `);
  console.log('  Pagamento (pagamento_id):           ' + num(origens.n_pag));
  console.log('  Despesa (despesa_id):               ' + num(origens.n_desp));
  console.log('  Quota extra (extra_quota_parcela):  ' + num(origens.n_extra));
  console.log('  Documento (documento_id):           ' + num(origens.n_doc));
  console.log('  FCR (deliberacao_id):               ' + num(origens.n_delib));
  console.log('  Quota (quota_id):                   ' + num(origens.n_quota));
  console.log('  Manual/outro (sem relação):         ' + num(origens.n_manual));
  console.log('  (as categorias podem sobrepor-se: um movimento pode ter mais de uma relação)');

  // ── 6. Movimentos NULL por ano/mês ────────────────────────────────
  linha('6. Movimentos NULL por ano-mês (coluna data)');
  const porMes = await S(`
    SELECT
      DATE_FORMAT(data, '%Y-%m') AS ym,
      COUNT(*) AS n,
      SUM(CASE WHEN tipo = 'entrada' AND estado = 'confirmado' THEN valor ELSE 0 END) AS v_ent,
      SUM(CASE WHEN tipo = 'saida'   AND estado = 'confirmado' THEN valor ELSE 0 END) AS v_sai
    FROM movimentos_bancarios
    WHERE condominio_id IS NULL
    GROUP BY ym
    ORDER BY ym ASC
  `);
  if (!porMes.length) {
    console.log('  (nenhum movimento NULL)');
  } else {
    console.log('  ' + txt('Ano-Mês', 10) + '| ' + txt('Nº', 7) + '| ' + txt('Entradas', 14) + '| ' + txt('Saídas', 14));
    for (const r of porMes) {
      console.log('  ' + txt(r.ym, 10) + '| ' + txt(r.n, 7) + '| ' + txt(eur(r.v_ent), 14) + '| ' + txt(eur(r.v_sai), 14));
    }
    const primeiro = porMes[0];
    const ultimo = porMes[porMes.length - 1];
    const anoAtual = String(new Date().getFullYear());
    const ymAtual = new Date().toISOString().slice(0, 7);
    console.log('');
    console.log('  Mês MAIS ANTIGO:  ' + primeiro.ym + ' (' + primeiro.n + ' movimentos)');
    console.log('  Mês MAIS RECENTE: ' + ultimo.ym + ' (' + ultimo.n + ' movimentos)');
    console.log('  Ano atual (' + anoAtual + '):  ' +
      porMes.filter((r) => r.ym.startsWith(anoAtual)).reduce((s, r) => s + num(r.n), 0) + ' movimentos NULL');
    const corte12 = new Date();
    corte12.setMonth(corte12.getMonth() - 12);
    const corteYM = corte12.toISOString().slice(0, 7);
    console.log('  Últimos 12 meses (desde ' + corteYM + '): ' +
      porMes.filter((r) => r.ym >= corteYM).reduce((s, r) => s + num(r.n), 0) + ' movimentos NULL');
    if (ultimo.ym >= ymAtual) {
      console.log('  ATENÇÃO: existem movimentos NULL no mês CORRENTE — o problema pode estar ativo.');
    } else if (ultimo.ym >= corteYM) {
      console.log('  NOTA: existem movimentos NULL nos últimos 12 meses — verificar se são anteriores');
      console.log('        ao deploy da migração 74 ou se o problema continua.');
    } else {
      console.log('  Todos os movimentos NULL são históricos (anteriores ao último ano).');
    }
  }

  // ── 7. Movimentos NULL recentes (30) ─────────────────────────────
  linha('7. Últimos 30 movimentos com condominio_id NULL');
  const recentes = await S(`
    SELECT
      mb.id, mb.data, mb.conta_bancaria_id, cb.nome AS conta, cb.condominio_id AS conta_cid,
      mb.tipo, mb.valor, mb.descricao, mb.referencia,
      mb.quota_id, mb.pagamento_id, mb.despesa_id, mb.extra_quota_parcela_id,
      mb.documento_id, mb.deliberacao_id, mb.estado
    FROM movimentos_bancarios mb
    LEFT JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
    WHERE mb.condominio_id IS NULL
    ORDER BY mb.data DESC, mb.id DESC
    LIMIT 30
  `);
  if (!recentes.length) {
    console.log('  (nenhum movimento NULL)');
  } else {
    for (const r of recentes) {
      console.log('   · id ' + String(r.id).padEnd(6) + ' ' + txt(r.data, 11) +
        ' conta ' + txt(r.conta_bancaria_id, 5) + ' ' + txt(r.conta, 20) +
        ' (cond ' + (r.conta_cid === null ? 'NULL' : r.conta_cid) + ')');
      console.log('     ' + txt(r.tipo, 14) + ' ' + txt(eur(r.valor), 13) +
        ' [' + r.estado + ']  ref=' + (r.referencia || '—'));
      console.log('     desc: ' + (r.descricao || '—'));
      console.log('     rel: quota=' + (r.quota_id || '—') + ' pag=' + (r.pagamento_id || '—') +
        ' desp=' + (r.despesa_id || '—') + ' extra=' + (r.extra_quota_parcela_id || '—') +
        ' doc=' + (r.documento_id || '—') + ' delib=' + (r.deliberacao_id || '—'));
    }
  }

  // ── 8. Possíveis duplicados (suspeitos, não confirmados) ─────────
  linha('8. Possíveis duplicados (sinais, não prova)');
  const dups = await S(`
    SELECT
      conta_bancaria_id, data, tipo, valor, descricao, referencia,
      COUNT(*) AS n, GROUP_CONCAT(id ORDER BY id) AS ids
    FROM movimentos_bancarios
    GROUP BY conta_bancaria_id, data, tipo, valor, descricao, referencia
    HAVING n > 1
    ORDER BY n DESC, data DESC
    LIMIT 50
  `);
  const [nDupGrupos] = await S(`
    SELECT COUNT(*) AS n FROM (
      SELECT conta_bancaria_id, data, tipo, valor, descricao, referencia
      FROM movimentos_bancarios
      GROUP BY conta_bancaria_id, data, tipo, valor, descricao, referencia
      HAVING COUNT(*) > 1
    ) t
  `);
  console.log('  Grupos com (conta+data+tipo+valor+descrição+referência) iguais: ' + num(nDupGrupos.n));
  console.log('  (NÃO é prova de duplicação: dois movimentos legítimos podem coincidir.)');
  for (const r of dups) {
    console.log('   · conta ' + r.conta_bancaria_id + ' ' + r.data + ' ' + r.tipo + ' ' +
      eur(r.valor) + ' × ' + r.n + ' — ids: ' + r.ids);
    console.log('     desc: ' + (r.descricao || '—') + ' | ref: ' + (r.referencia || '—'));
  }

  // ── 9. Estado das contas bancárias ───────────────────────────────
  linha('9. Contas bancárias');
  const contas = await S(`
    SELECT
      cb.id, cb.condominio_id AS cid,
      COALESCE(c.nome, c.designacao, '(sem condomínio)') AS cond,
      cb.nome, cb.banco, cb.iban, cb.tipo, cb.saldo_inicial,
      cb.data_saldo_inicial, cb.ativa,
      COUNT(mb.id) AS n_mov,
      SUM(CASE WHEN mb.condominio_id IS NULL THEN 1 ELSE 0 END) AS n_null
    FROM contas_bancarias cb
    LEFT JOIN condominios c ON c.id = cb.condominio_id
    LEFT JOIN movimentos_bancarios mb ON mb.conta_bancaria_id = cb.id
    GROUP BY cb.id, cb.condominio_id, cond, cb.nome, cb.banco, cb.iban,
             cb.tipo, cb.saldo_inicial, cb.data_saldo_inicial, cb.ativa
    ORDER BY cb.condominio_id ASC, cb.id ASC
  `);
  if (!contas.length) console.log('  (nenhuma conta bancária registada)');
  for (const r of contas) {
    console.log('   · conta ' + String(r.id).padEnd(5) +
      ' cond ' + txt(r.cid, 5) + ' ' + txt(r.cond, 26));
    console.log('     ' + txt(r.nome, 26) + ' | ' + txt(r.banco, 20) + ' | ' +
      txt(maskIban(r.iban), 14) + ' | ' + txt(r.tipo, 14));
    console.log('     saldo inicial ' + eur(r.saldo_inicial) + ' (' + (r.data_saldo_inicial || 'sem data') + ')' +
      ' | ativa ' + (r.ativa ? 'sim' : 'NÃO') +
      ' | movimentos ' + r.n_mov + ' (NULL: ' + num(r.n_null) + ')');
  }

  // ── 10. Comparação de saldos ──────────────────────────────────────
  linha('10. Comparação de saldos por conta');
  console.log('  A) por movimentos: saldo_inicial + entradas confirmadas − saídas confirmadas');
  console.log('  B) por pagamentos/despesas: lógica de helpers/saldos.js');
  console.log('');
  const saldoMov = await S(`
    SELECT
      cb.id, cb.nome, cb.saldo_inicial,
      SUM(CASE WHEN mb.tipo = 'entrada' AND mb.estado = 'confirmado' THEN mb.valor ELSE 0 END) AS v_ent,
      SUM(CASE WHEN mb.tipo = 'saida'   AND mb.estado = 'confirmado' THEN mb.valor ELSE 0 END) AS v_sai
    FROM contas_bancarias cb
    LEFT JOIN movimentos_bancarios mb ON mb.conta_bancaria_id = cb.id
    GROUP BY cb.id, cb.nome, cb.saldo_inicial
    ORDER BY cb.id ASC
  `);
  console.log('  ' + txt('Conta', 24) + '| ' + txt('Saldo movimentos', 18) + '| ' +
    txt('Pag. entradas', 15) + '| ' + txt('Desp. saídas', 15) + '| ' + txt('Saída líquida', 15));
  for (const r of saldoMov) {
    const saldoA = Number(r.saldo_inicial || 0) + Number(r.v_ent || 0) - Number(r.v_sai || 0);
    // Pagamentos/despesas atribuídos a ESTA conta (o que helpers/saldos.js NÃO faz).
    const [pg] = await S(`SELECT COALESCE(SUM(valor),0) AS v FROM pagamentos
      WHERE conta_bancaria_id = ${Number(r.id)} AND estado = 'confirmado'`);
    const [dp] = await S(`SELECT COALESCE(SUM(valor),0) AS v FROM despesas
      WHERE conta_bancaria_id = ${Number(r.id)} AND estado <> 'anulada'`);
    console.log('  ' + txt(r.nome, 24) + '| ' + txt(eur(saldoA), 18) + '| ' +
      txt(eur(pg.v), 15) + '| ' + txt(eur(dp.v), 15) + '| ' +
      txt(eur(Number(pg.v || 0) - Number(dp.v || 0)), 15));
  }
  const [globPag] = await S(`SELECT COALESCE(SUM(valor),0) AS v FROM pagamentos WHERE estado = 'confirmado'`);
  const [globDesp] = await S(`SELECT COALESCE(SUM(valor),0) AS v FROM despesas WHERE estado <> 'anulada'`);
  const [globIni] = await S(`SELECT COALESCE(SUM(saldo_inicial),0) AS v FROM contas_bancarias`);
  console.log('');
  console.log('  LIMITAÇÃO IMPORTANTE (resumoCondominio em helpers/saldos.js):');
  console.log('    O "saldoContas" global é calculado como');
  console.log('      Σ saldo_inicial + Σ pagamentos confirmados − Σ despesas não anuladas');
  console.log('    — SEM filtrar por conta bancária. Por isso NÃO é repartível por conta:');
  console.log('    um pagamento sem conta atribuída entra no total, mas em conta nenhuma.');
  console.log('');
  console.log('    Σ saldo_inicial (todas as contas): ' + eur(globIni.v));
  console.log('    Σ pagamentos confirmados:          ' + eur(globPag.v));
  console.log('    Σ despesas não anuladas:           ' + eur(globDesp.v));
  console.log('    → "saldoContas" global:            ' + eur(Number(globIni.v) + Number(globPag.v) - Number(globDesp.v)));
  const [saldoMovGlobal] = await S(`
    SELECT COALESCE(SUM(cb.saldo_inicial),0) AS ini,
           COALESCE(SUM(CASE WHEN mb.tipo='entrada' AND mb.estado='confirmado' THEN mb.valor ELSE 0 END),0) AS ent,
           COALESCE(SUM(CASE WHEN mb.tipo='saida' AND mb.estado='confirmado' THEN mb.valor ELSE 0 END),0) AS sai
    FROM contas_bancarias cb
    LEFT JOIN movimentos_bancarios mb ON mb.conta_bancaria_id = cb.id
  `);
  const saldoB = Number(saldoMovGlobal.ini) + Number(saldoMovGlobal.ent) - Number(saldoMovGlobal.sai);
  const saldoA_global = Number(globIni.v) + Number(globPag.v) - Number(globDesp.v);
  console.log('    → saldo por movimentos (global):   ' + eur(saldoB));
  console.log('');
  console.log('    DIFERENÇA GLOBAL (movimentos − pag/desp): ' + eur(saldoB - saldoA_global));

  // ── 11. Transferências ────────────────────────────────────────────
  linha('11. Transferências (referencia = TRANSF ou tipo = transferencia)');
  const trfs = await S(`
    SELECT mb.id, mb.data, mb.tipo, mb.valor, mb.conta_bancaria_id,
           cb.nome AS conta, cb.condominio_id AS cid, mb.descricao, mb.referencia,
           mb.deliberacao_id, mb.estado
    FROM movimentos_bancarios mb
    LEFT JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
    WHERE mb.referencia = 'TRANSF' OR mb.tipo = 'transferencia'
    ORDER BY mb.data ASC, mb.valor ASC, mb.id ASC
  `);
  console.log('  Total de pontas de transferência: ' + trfs.length);
  const peloTipo = trfs.filter((t) => t.tipo === 'transferencia').length;
  const pelaRef = trfs.filter((t) => t.referencia === 'TRANSF').length;
  console.log('    por tipo = transferencia: ' + peloTipo);
  console.log('    por referencia = TRANSF:  ' + pelaRef);
  console.log('    com deliberacao_id (FCR): ' + trfs.filter((t) => t.deliberacao_id).length);
  const porParear = trfs.filter((t) => t.tipo !== 'transferencia' && t.estado === 'confirmado');
  const usados = new Set();
  let paresOk = 0;
  let pontasSoltas = 0;
  const chave = (t, outra) => t.data === outra.data && Number(t.valor) === Number(outra.valor)
    && t.conta_bancaria_id !== outra.conta_bancaria_id;
  for (const s of porParear.filter((t) => t.tipo === 'saida')) {
    if (usados.has(s.id)) continue;
    const par = porParear.find((e) => e.tipo === 'entrada' && !usados.has(e.id) && chave(s, e));
    if (par) { usados.add(s.id); usados.add(par.id); paresOk += 1; } else { pontasSoltas += 1; }
  }
  console.log('    pares saída/entrada emparelháveis (mesma data+valor, contas diferentes): ' + paresOk);
  console.log('    pontas de saída sem par: ' + pontasSoltas);
  const semCond = trfs.filter((t) => t.estado === 'confirmado').length;
  console.log('    transferências confirmadas: ' + semCond);
  if (trfs.length && trfs.length <= 40) {
    console.log('');
    for (const t of trfs) {
      console.log('   · id ' + String(t.id).padEnd(6) + ' ' + txt(t.data, 11) + ' ' +
        txt(t.tipo, 14) + ' ' + txt(eur(t.valor), 13) +
        ' conta ' + txt(t.conta_bancaria_id, 5) + ' ' + txt(t.conta, 20) +
        ' (cond ' + (t.cid === null ? 'NULL' : t.cid) + ')' +
        (t.deliberacao_id ? ' delib=' + t.deliberacao_id : '') + ' [' + t.estado + ']');
    }
  }

  // ── 12. FCR ───────────────────────────────────────────────────────
  linha('12. FCR — movimentos e agregados');
  const contasFcr = await S(`
    SELECT id, condominio_id AS cid, nome, saldo_inicial FROM contas_bancarias
    WHERE tipo = 'fundo_reserva' ORDER BY id ASC
  `);
  console.log('  Contas do tipo fundo_reserva: ' + contasFcr.length);
  for (const c of contasFcr) {
    const [agg] = await S(`
      SELECT
        COALESCE(SUM(CASE WHEN tipo='entrada' AND estado='confirmado' THEN valor ELSE 0 END),0) AS ent,
        COALESCE(SUM(CASE WHEN tipo='saida' AND estado='confirmado' THEN valor ELSE 0 END),0) AS sai,
        COUNT(*) AS n
      FROM movimentos_bancarios WHERE conta_bancaria_id = ${Number(c.id)}
    `);
    const saldo = Number(c.saldo_inicial) + Number(agg.ent) - Number(agg.sai);
    console.log('   · conta ' + String(c.id).padEnd(5) + ' cond ' + txt(c.cid, 5) + ' ' + txt(c.nome, 26) +
      ' movimentos ' + agg.n + ' | saldo ' + eur(saldo));
  }
  const [fcrAgg] = await S(`
    SELECT
      COUNT(*) AS n_total,
      SUM(CASE WHEN deliberacao_id IS NOT NULL THEN 1 ELSE 0 END) AS n_delib,
      SUM(CASE WHEN deliberacao_id IS NOT NULL AND condominio_id IS NULL THEN 1 ELSE 0 END) AS n_delib_null,
      COALESCE(SUM(CASE WHEN deliberacao_id IS NOT NULL AND tipo='saida' AND estado='confirmado' THEN valor ELSE 0 END),0) AS v_utilizado
    FROM movimentos_bancarios
    WHERE deliberacao_id IS NOT NULL OR referencia = 'TRANSF'
  `);
  console.log('');
  console.log('  Movimentos com deliberacao_id ou referencia TRANSF: ' + num(fcrAgg.n_total));
  console.log('    com deliberacao_id:                    ' + num(fcrAgg.n_delib));
  console.log('    desses, com condominio_id NULL:        ' + num(fcrAgg.n_delib_null));
  console.log('    valor total utilizado do FCR (saídas): ' + eur(fcrAgg.v_utilizado));

  // ── 13. Resumo final ──────────────────────────────────────────────
  linha('13. Resumo para a conclusão');
  console.log('  Total de movimentos:                    ' + num(total.n_total));
  console.log('  Com condominio_id:                      ' + num(total.n_com_cond));
  console.log('  Com condominio_id NULL:                 ' + num(total.n_sem_cond));
  const pct = num(total.n_total) ? ((num(total.n_sem_cond) / num(total.n_total)) * 100).toFixed(1) : '0.0';
  console.log('  Percentagem NULL:                       ' + pct + ' %');
  console.log('  NULL recuperáveis pela conta:           ' +
    (num(total.n_sem_cond) - irrecuperaveis.reduce((s, r) => s + num(r.n), 0)));
  console.log('  NULL NÃO recuperáveis (investigar):     ' +
    irrecuperaveis.reduce((s, r) => s + num(r.n), 0));
  console.log('  Inconsistências movimento≠conta:        ' + inconsistentes.length);
  console.log('  Contas bancárias:                       ' + contas.length);
  console.log('  Pontas de transferência:                ' + trfs.length);
  console.log('  Grupos suspeitos de duplicado:          ' + num(nDupGrupos.n));
  console.log('');
  console.log('  Nenhuma escrita foi feita na base de dados.');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('');
    console.error('Erro no diagnóstico: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
