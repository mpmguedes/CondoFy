// Diagnóstico READ-ONLY: fecho da decomposição da diferença A − B.
//
// Ficheiro NOVO e independente de scripts/diagnostico-movimentos-condominio.js
// (esse mantém-se intocado, com o bug conhecido do SUM(saldo_inicial) sobre o JOIN).
//
// Utilização em produção:
//   cd /opt/condofy && git pull && node scripts/diagnostico-decomposicao-diferenca.js
//
// SEGURANÇA: este ficheiro só executa SELECT. Não existe neste ficheiro qualquer
// INSERT / UPDATE / DELETE / ALTER / DROP / CREATE / TRUNCATE, nem chamada a
// Model.create / .update() / .destroy() / .save() / .upsert() / bulkCreate.
//
// REGRA ANTI-BUG: o saldo_inicial NUNCA é agregado sobre um JOIN com movimentos.
// Todas as agregações globais de saldo_inicial usam subquery escalar.

require('dotenv').config();
const { QueryTypes } = require('sequelize');

function linha(titulo) {
  const barra = '─'.repeat(62);
  console.log('');
  console.log(barra);
  console.log(titulo);
  console.log(barra);
}

function eur(v) {
  return Number(v || 0).toFixed(2).replace('.', ',') + ' €';
}

function num(v) {
  return String(Number(v || 0));
}

function txt(v, largura) {
  const s = String(v === null || v === undefined ? '' : v);
  if (s.length === largura) return s;
  if (s.length < largura) return s + ' '.repeat(largura - s.length);
  return s.slice(0, largura - 1) + '…';
}

async function main() {
  const sequelize = require('../config/database');

  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error('');
    console.error('Não foi possível ligar à base de dados.');
    console.error('  ' + (err && err.message ? err.message : err));
    console.error('');
    console.error('Este script tem de correr no servidor de produção (/opt/condofy),');
    console.error('onde a base de dados está acessível. Nenhum dado foi lido nem alterado.');
    process.exit(1);
  }

  // ── Só SELECT ──────────────────────────────────────────────────────
  const S = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' DECOMPOSIÇÃO DA DIFERENÇA A − B   (read-only, só SELECT)');
  console.log('═══════════════════════════════════════════════════════════════');

  // ══════════════════════════════════════════════════════════════════
  // 1. OS DOIS SALDOS
  // ══════════════════════════════════════════════════════════════════
  linha('1A. Saldo A — por movimentos, POR CONTA');
  console.log('  Fórmula: saldo_inicial + entradas_confirmadas − saidas_confirmadas');
  console.log('  (GROUP BY na conta: cada conta devolve UMA linha — sem multiplicação)');
  console.log('');

  const porConta = await S(`
    SELECT
      cb.id,
      cb.condominio_id,
      cb.nome,
      cb.tipo,
      cb.ativa,
      cb.saldo_inicial,
      COALESCE(SUM(CASE WHEN mb.tipo='entrada' AND mb.estado='confirmado' THEN mb.valor ELSE 0 END), 0) AS entradas,
      COALESCE(SUM(CASE WHEN mb.tipo='saida'   AND mb.estado='confirmado' THEN mb.valor ELSE 0 END), 0) AS saidas,
      COUNT(mb.id) AS n_mov
    FROM contas_bancarias cb
    LEFT JOIN movimentos_bancarios mb ON mb.conta_bancaria_id = cb.id
    GROUP BY cb.id, cb.condominio_id, cb.nome, cb.tipo, cb.ativa, cb.saldo_inicial
    ORDER BY cb.id ASC
  `);

  console.log('  ' + txt('id', 5) + txt('cond', 6) + txt('conta', 24) + txt('ativa', 7) +
    txt('saldo_ini', 13) + txt('entradas', 13) + txt('saidas', 13) + txt('saldo', 13));
  let somaSaldosTodos = 0;
  let somaSaldosAtivas = 0;
  let somaIniAtivas = 0;
  let somaEntAtivas = 0;
  let somaSaiAtivas = 0;
  for (const c of porConta) {
    const saldo = Number(c.saldo_inicial || 0) + Number(c.entradas || 0) - Number(c.saidas || 0);
    somaSaldosTodos += saldo;
    if (c.ativa) {
      somaSaldosAtivas += saldo;
      somaIniAtivas += Number(c.saldo_inicial || 0);
      somaEntAtivas += Number(c.entradas || 0);
      somaSaiAtivas += Number(c.saidas || 0);
    }
    console.log('  ' + txt(c.id, 5) + txt(c.condominio_id === null ? 'NULL' : c.condominio_id, 6) +
      txt(c.nome, 24) + txt(c.ativa ? 'sim' : 'NAO', 7) +
      txt(eur(c.saldo_inicial), 13) + txt(eur(c.entradas), 13) +
      txt(eur(c.saidas), 13) + txt(eur(saldo), 13) + '  (' + c.n_mov + ' mov)');
  }
  console.log('');
  console.log('  Soma dos saldos — TODAS as contas:  ' + eur(somaSaldosTodos));
  console.log('  Soma dos saldos — só ATIVAS:        ' + eur(somaSaldosAtivas));
  console.log('');
  console.log('  >>> SALDO A (movimentos, contas ativas) = ' + eur(somaSaldosAtivas));

  linha('1B. Saldo B — lógica de helpers/saldos.js (resumoCondominio)');
  console.log('  Fórmula: Σ saldo_inicial(contas ATIVAS) + Σ pagamentos confirmados');
  console.log('           − Σ despesas não anuladas');
  console.log('  Nota: NÃO filtra por conta bancária. Aplica-se o mesmo âmbito `onde`');
  console.log('        (condominio_id) a contas, pagamentos e despesas.');
  console.log('');

  // Reprodução fiel, com subquery escalar para o saldo_inicial.
  const [bini] = await S(`SELECT COALESCE(SUM(saldo_inicial),0) AS v FROM contas_bancarias WHERE ativa = 1`);
  const [bpag] = await S(`SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM pagamentos WHERE estado = 'confirmado'`);
  const [bdes] = await S(`SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM despesas WHERE estado <> 'anulada'`);

  console.log('  Σ saldo_inicial (contas ATIVAS)      : ' + eur(bini.v));
  console.log('  Σ pagamentos confirmados (' + num(bpag.n) + ')          : ' + eur(bpag.v));
  console.log('  Σ despesas não anuladas (' + num(bdes.n) + ')          : ' + eur(bdes.v));
  console.log('');
  const saldoB = Number(bini.v) + Number(bpag.v) - Number(bdes.v);
  console.log('  >>> SALDO B = ' + eur(saldoB) + '   (= ' + eur(bini.v) + ' + ' + eur(bpag.v) + ' − ' + eur(bdes.v) + ')');

  // Variante: se existirem contas inativas, mostrar o impacto.
  const [biniTodas] = await S(`SELECT COALESCE(SUM(saldo_inicial),0) AS v FROM contas_bancarias`);
  if (Number(biniTodas.v) !== Number(bini.v)) {
    const saldoBTodas = Number(biniTodas.v) + Number(bpag.v) - Number(bdes.v);
    console.log('');
    console.log('  ATENÇÃO: Σ saldo_inicial TODAS as contas = ' + eur(biniTodas.v) +
      ' (diferença vs ativas: ' + eur(Number(biniTodas.v) - Number(bini.v)) + ')');
    console.log('  Saldo B se incluísse contas inativas = ' + eur(saldoBTodas));
  }

  // ── Fecho A − B ───────────────────────────────────────────────────
  const saldoA = somaSaldosAtivas;
  linha('1C. FECHO A − B');
  console.log('  Saldo A (movimentos, contas ativas)  = ' + eur(saldoA));
  console.log('  Saldo B (pagamentos/despesas)        = ' + eur(saldoB));
  console.log('  A − B                                = ' + eur(saldoA - saldoB));
  console.log('');
  console.log('  (valores por confirmar contra produção — este script produz os números reais)');

  // ══════════════════════════════════════════════════════════════════
  // 2. DECOMPOSIÇÃO EXATA
  // ══════════════════════════════════════════════════════════════════
  linha('2.1. PAGAMENTOS — decomposição');

  const [pagTot] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM pagamentos WHERE estado='confirmado'`);
  const [pagComConta] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM pagamentos
    WHERE estado='confirmado' AND conta_bancaria_id IS NOT NULL`);
  const [pagSemConta] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM pagamentos
    WHERE estado='confirmado' AND conta_bancaria_id IS NULL`);
  const [movEntPag] = await S(`
    SELECT COALESCE(SUM(mb.valor),0) AS v, COUNT(*) AS n
    FROM movimentos_bancarios mb
    WHERE mb.pagamento_id IS NOT NULL AND mb.tipo='entrada' AND mb.estado='confirmado'`);

  // Pagamentos confirmados COM conta mas SEM movimento de entrada confirmado.
  const pagComContaSemMov = await S(`
    SELECT p.id, p.condominio_id, p.valor, p.data_pagamento, p.conta_bancaria_id
    FROM pagamentos p
    WHERE p.estado='confirmado' AND p.conta_bancaria_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM movimentos_bancarios mb
        WHERE mb.pagamento_id = p.id AND mb.tipo='entrada' AND mb.estado='confirmado'
      )
    ORDER BY p.data_pagamento ASC, p.id ASC`);

  // Pagamentos confirmados SEM conta (logo, sem movimento possível).
  const pagSemContaLista = await S(`
    SELECT p.id, p.condominio_id, p.valor, p.data_pagamento
    FROM pagamentos p
    WHERE p.estado='confirmado' AND p.conta_bancaria_id IS NULL
    ORDER BY p.data_pagamento ASC, p.id ASC`);

  const somaPagComContaSemMov = pagComContaSemMov.reduce((s, r) => s + Number(r.valor || 0), 0);
  const somaPagSemConta = pagSemContaLista.reduce((s, r) => s + Number(r.valor || 0), 0);

  console.log('  Total confirmados                : ' + num(pagTot.n) + '  ' + eur(pagTot.v));
  console.log('    com conta_bancaria_id          : ' + num(pagComConta.n) + '  ' + eur(pagComConta.v));
  console.log('    sem conta_bancaria_id          : ' + num(pagSemConta.n) + '  ' + eur(pagSemConta.v));
  console.log('');
  console.log('  Movimentos de ENTRADA com pagamento_id : ' + num(movEntPag.n) + '  ' + eur(movEntPag.v));
  console.log('');
  console.log('  Confirmados COM conta mas SEM movimento : ' + pagComContaSemMov.length + '  ' + eur(somaPagComContaSemMov));
  console.log('  Confirmados SEM conta (logo sem mov.)   : ' + pagSemContaLista.length + '  ' + eur(somaPagSemConta));
  console.log('');
  console.log('  >>> Impacto em A−B: pagamentos sem movimento NÃO existem em A,');
  console.log('      mas existem em B  →  empurram  A − B  para BAIXO (A < B).');

  if (pagComContaSemMov.length && pagComContaSemMov.length <= 30) {
    console.log('');
    console.log('    Pagamentos confirmados com conta mas sem movimento:');
    for (const p of pagComContaSemMov) {
      console.log('     · id ' + txt(p.id, 7) + ' cond ' + txt(p.condominio_id === null ? 'NULL' : p.condominio_id, 6) +
        ' ' + txt(p.data_pagamento, 12) + ' ' + txt(eur(p.valor), 13) + ' conta ' + p.conta_bancaria_id);
    }
  } else if (pagComContaSemMov.length) {
    console.log('    (' + pagComContaSemMov.length + ' linhas — omitidas para não poluir; ver query em 2.1)');
  }

  linha('2.2. DESPESAS — decomposição por estado');

  const despPorEstado = await S(`
    SELECT estado, COUNT(*) AS n, COALESCE(SUM(valor),0) AS v
    FROM despesas GROUP BY estado ORDER BY estado ASC`);
  console.log('  Por estado:');
  for (const d of despPorEstado) {
    console.log('    ' + txt(d.estado, 12) + num(d.n).padStart(5) + '  ' + eur(d.v));
  }

  console.log('');
  console.log('  Detalhe por estado × conta_bancaria_id:');
  const despCross = await S(`
    SELECT
      estado,
      CASE WHEN conta_bancaria_id IS NULL THEN 'sem_conta' ELSE 'com_conta' END AS tem_conta,
      COUNT(*) AS n,
      COALESCE(SUM(valor),0) AS v
    FROM despesas
    GROUP BY estado, tem_conta
    ORDER BY estado ASC, tem_conta ASC`);
  for (const d of despCross) {
    console.log('    ' + txt(d.estado, 12) + txt(d.tem_conta, 12) + num(d.n).padStart(5) + '  ' + eur(d.v));
  }

  console.log('');
  console.log('  Despesas PAGAS com conta mas SEM movimento de saída confirmado:');
  const despPagasSemMov = await S(`
    SELECT d.id, d.condominio_id, d.valor, d.data, d.conta_bancaria_id, d.estado
    FROM despesas d
    WHERE d.estado = 'paga' AND d.conta_bancaria_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM movimentos_bancarios mb
        WHERE mb.despesa_id = d.id AND mb.tipo='saida' AND mb.estado='confirmado'
      )
    ORDER BY d.data ASC, d.id ASC`);
  const somaDespPagasSemMov = despPagasSemMov.reduce((s, r) => s + Number(r.valor || 0), 0);
  console.log('    quantidade: ' + despPagasSemMov.length + '   valor: ' + eur(somaDespPagasSemMov));

  console.log('');
  console.log('  Despesas PAGAS sem conta (logo sem movimento possível):');
  const despPagasSemConta = await S(`
    SELECT d.id, d.condominio_id, d.valor, d.data
    FROM despesas d
    WHERE d.estado = 'paga' AND d.conta_bancaria_id IS NULL
    ORDER BY d.data ASC, d.id ASC`);
  const somaDespPagasSemConta = despPagasSemConta.reduce((s, r) => s + Number(r.valor || 0), 0);
  console.log('    quantidade: ' + despPagasSemConta.length + '   valor: ' + eur(somaDespPagasSemConta));

  console.log('');
  console.log('  Despesas REGISTADAS (entram em B, não geram movimento):');
  const [despReg] = await S(`
    SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS v FROM despesas WHERE estado='registada'`);
  console.log('    quantidade: ' + num(despReg.n) + '   valor: ' + eur(despReg.v));
  console.log('    → este valor está a DIMINUIR B sem contrapartida em A');

  console.log('');
  console.log('  Despesas ANULADAS com movimento de saída CONFIRMADO (potencial incoerência):');
  const despAnuladasComMov = await S(`
    SELECT d.id, d.condominio_id, d.valor, d.estado AS estado_despesa,
           mb.id AS movimento_id, mb.valor AS mov_valor, mb.estado AS mov_estado
    FROM despesas d
    JOIN movimentos_bancarios mb ON mb.despesa_id = d.id
    WHERE d.estado = 'anulada' AND mb.tipo='saida' AND mb.estado='confirmado'
    ORDER BY d.id ASC, mb.id ASC`);
  const somaDespAnulComMov = despAnuladasComMov.reduce((s, r) => s + Number(r.mov_valor || 0), 0);
  console.log('    ocorrências: ' + despAnuladasComMov.length + '   valor dos movimentos: ' + eur(somaDespAnulComMov));
  if (despAnuladasComMov.length) {
    for (const r of despAnuladasComMov) {
      console.log('     · despesa ' + txt(r.id, 7) + ' (' + eur(r.valor) + ', ' + r.estado_despesa +
        ') → movimento ' + txt(r.movimento_id, 7) + ' ' + eur(r.mov_valor) + ' [' + r.mov_estado + ']');
    }
  }

  linha('2.3. MOVIMENTOS — classificação por origem');

  const movClass = await S(`
    SELECT
      CASE
        WHEN pagamento_id IS NOT NULL THEN 'pagamento'
        WHEN despesa_id IS NOT NULL THEN 'despesa'
        WHEN extra_quota_parcela_id IS NOT NULL THEN 'quota_extra'
        WHEN referencia = 'TRANSF' OR tipo = 'transferencia' THEN 'transferencia'
        WHEN deliberacao_id IS NOT NULL THEN 'deliberacao_fcr'
        ELSE 'outro_manual'
      END AS origem,
      tipo, estado,
      COUNT(*) AS n,
      COALESCE(SUM(valor),0) AS v
    FROM movimentos_bancarios
    GROUP BY origem, tipo, estado
    ORDER BY origem ASC, tipo ASC, estado ASC`);

  console.log('  ' + txt('origem', 17) + txt('tipo', 15) + txt('estado', 12) + txt('n', 6) + 'valor');
  for (const m of movClass) {
    console.log('  ' + txt(m.origem, 17) + txt(m.tipo, 15) + txt(m.estado, 12) +
      num(m.n).padStart(4) + '  ' + eur(m.v));
  }

  console.log('');
  console.log('  Coerência movimento ↔ origem (movimentos CONFIRMADOS):');
  const [incPagAnul] = await S(`
    SELECT COUNT(*) AS n, COALESCE(SUM(mb.valor),0) AS v
    FROM movimentos_bancarios mb JOIN pagamentos p ON p.id = mb.pagamento_id
    WHERE mb.tipo='entrada' AND mb.estado='confirmado' AND p.estado='anulado'`);
  console.log('    entrada confirmada c/ pagamento ANULADO : ' + num(incPagAnul.n) + '  ' + eur(incPagAnul.v));

  const [incDespAnul] = await S(`
    SELECT COUNT(*) AS n, COALESCE(SUM(mb.valor),0) AS v
    FROM movimentos_bancarios mb JOIN despesas d ON d.id = mb.despesa_id
    WHERE mb.tipo='saida' AND mb.estado='confirmado' AND d.estado='anulada'`);
  console.log('    saida confirmada c/ despesa ANULADA     : ' + num(incDespAnul.n) + '  ' + eur(incDespAnul.v));

  const [incDespReg] = await S(`
    SELECT COUNT(*) AS n, COALESCE(SUM(mb.valor),0) AS v
    FROM movimentos_bancarios mb JOIN despesas d ON d.id = mb.despesa_id
    WHERE mb.tipo='saida' AND mb.estado='confirmado' AND d.estado='registada'`);
  console.log('    saida confirmada c/ despesa REGISTADA    : ' + num(incDespReg.n) + '  ' + eur(incDespReg.v));

  // ══════════════════════════════════════════════════════════════════
  // 3. TRANSFERÊNCIAS
  // ══════════════════════════════════════════════════════════════════
  linha('3. TRANSFERÊNCIAS — impacto líquido');

  const [trfSai] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM movimentos_bancarios
    WHERE referencia='TRANSF' AND tipo='saida' AND estado='confirmado'`);
  const [trfEnt] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM movimentos_bancarios
    WHERE referencia='TRANSF' AND tipo='entrada' AND estado='confirmado'`);
  // O ENUM 'transferencia' é legado: o código atual escreve referencia='TRANSF' com
  // tipo 'saida'/'entrada'. Pode devolver 0 linhas → guardar o ARRAY, não a 1.ª linha.
  const trfTipo = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n, tipo FROM movimentos_bancarios
    WHERE tipo='transferencia' GROUP BY tipo`);

  console.log('  Saídas TRANSF confirmadas : ' + num(trfSai.n) + '  ' + eur(trfSai.v));
  console.log('  Entradas TRANSF confirmadas: ' + num(trfEnt.n) + '  ' + eur(trfEnt.v));
  console.log('  Diferença líquida          : ' + eur(Number(trfEnt.v) - Number(trfSai.v)));
  console.log('');
  console.log('  Movimentos com tipo = transferencia (legado): ' +
    (trfTipo.length ? num(trfTipo[0].n) + '  ' + eur(trfTipo[0].v) : '0  0,00 €'));
  console.log('');
  console.log('  >>> Se saídas = entradas, a transferência é NEUTRA em A e não existe em B');
  console.log('      → contribuição para A − B = 0,00 €. Confirmar com os números acima.');

  // ══════════════════════════════════════════════════════════════════
  // 4. FECHO DA EQUAÇÃO
  // ══════════════════════════════════════════════════════════════════
  linha('4. FECHO DA EQUAÇÃO A − B');

  const z = saldoA - saldoB;

  // Componentes que explicam a diferença.
  // A = Σ ini_ativas + entradas_conf − saidas_conf
  // B = Σ ini_ativas + pag_conf − desp_nao_anuladas
  // => A − B = (entradas_conf − pag_conf) − (saidas_conf − desp_nao_anuladas)

  const [todasEnt] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM movimentos_bancarios
    WHERE tipo='entrada' AND estado='confirmado'`);
  const [todasSai] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM movimentos_bancarios
    WHERE tipo='saida' AND estado='confirmado'`);

  // entradas confirmadas que NÃO têm pagamento associado
  const [entSemPag] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM movimentos_bancarios
    WHERE tipo='entrada' AND estado='confirmado' AND pagamento_id IS NULL`);
  // saídas confirmadas que NÃO têm despesa associada
  const [saiSemDesp] = await S(`
    SELECT COALESCE(SUM(valor),0) AS v, COUNT(*) AS n FROM movimentos_bancarios
    WHERE tipo='saida' AND estado='confirmado' AND despesa_id IS NULL`);
  // saídas confirmadas associadas a despesa ANULADA
  const [saiDespAnulada] = await S(`
    SELECT COALESCE(SUM(mb.valor),0) AS v, COUNT(*) AS n
    FROM movimentos_bancarios mb JOIN despesas d ON d.id = mb.despesa_id
    WHERE mb.tipo='saida' AND mb.estado='confirmado' AND d.estado='anulada'`);

  console.log('');
  console.log('  ' + txt('Componente', 46) + txt('impacto A', 13) + txt('impacto B', 13) + 'impacto A−B');
  console.log('  ' + '─'.repeat(84));

  function comp(nome, impA, impB) {
    const d = Number(impA || 0) - Number(impB || 0);
    console.log('  ' + txt(nome, 46) + txt(eur(impA), 13) + txt(eur(impB), 13) + eur(d));
    return d;
  }

  let somaComp = 0;
  somaComp += comp('Σ saldo_inicial (contas ativas) — cancela', somaIniAtivas, Number(bini.v));
  somaComp += comp('Entradas confirmadas vs Pagamentos confirmados', Number(todasEnt.v), Number(bpag.v));
  somaComp += comp('Saídas confirmadas vs Despesas não anuladas', -Number(todasSai.v), -Number(bdes.v));

  console.log('  ' + '─'.repeat(84));
  console.log('  ' + txt('TOTAL (deve igualar A − B)', 46) + txt('', 13) + txt('', 13) + eur(somaComp));
  console.log('');
  console.log('  A − B calculado diretamente : ' + eur(z));
  console.log('  Soma dos componentes        : ' + eur(somaComp));
  console.log('  DESVIO                      : ' + eur(z - somaComp) +
    (Math.abs(z - somaComp) < 0.005 ? '   ✅ fecha' : '   ❌ NÃO FECHA — investigar'));

  console.log('');
  console.log('  Detalhe dos componentes "não-pagamento" / "não-despesa":');
  console.log('    entradas confirmadas SEM pagamento_id : ' + num(entSemPag.n) + '  ' + eur(entSemPag.v));
  console.log('    saídas confirmadas SEM despesa_id     : ' + num(saiSemDesp.n) + '  ' + eur(saiSemDesp.v));
  console.log('    saídas confirmadas c/ despesa anulada : ' + num(saiDespAnulada.n) + '  ' + eur(saiDespAnulada.v));

  console.log('');
  console.log('  Totais absolutos (para referência):');
  console.log('    entradas confirmadas : ' + num(todasEnt.n) + '  ' + eur(todasEnt.v));
  console.log('    saídas confirmadas   : ' + num(todasSai.n) + '  ' + eur(todasSai.v));

  // ══════════════════════════════════════════════════════════════════
  // 5. OS 31 NULL
  // ══════════════════════════════════════════════════════════════════
  linha('5. Movimentos com condominio_id NULL');

  const [nNull] = await S(`
    SELECT COUNT(*) AS n FROM movimentos_bancarios WHERE condominio_id IS NULL`);
  const [nTotalMov] = await S(`
    SELECT COUNT(*) AS n FROM movimentos_bancarios`);
  const [nRecup] = await S(`
    SELECT COUNT(*) AS n FROM movimentos_bancarios mb
    JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
    WHERE mb.condominio_id IS NULL AND cb.condominio_id IS NOT NULL`);
  const [nIrrecup] = await S(`
    SELECT COUNT(*) AS n FROM movimentos_bancarios mb
    LEFT JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
    WHERE mb.condominio_id IS NULL AND (cb.condominio_id IS NULL OR cb.id IS NULL)`);
  const [nIncons] = await S(`
    SELECT COUNT(*) AS n FROM movimentos_bancarios mb
    JOIN contas_bancarias cb ON cb.id = mb.conta_bancaria_id
    WHERE mb.condominio_id IS NOT NULL AND mb.condominio_id <> cb.condominio_id`);

  console.log('  Total de movimentos            : ' + num(nTotalMov.n));
  console.log('  Com condominio_id NULL          : ' + num(nNull.n));
  console.log('  Recuperáveis pela conta         : ' + num(nRecup.n));
  console.log('  NÃO recuperáveis                : ' + num(nIrrecup.n));
  console.log('  Incompatibilidades mov ≠ conta  : ' + num(nIncons.n));
  console.log('');
  console.log('  Nenhum movimento foi alterado.');

  // ══════════════════════════════════════════════════════════════════
  // 7. RESPOSTAS
  // ══════════════════════════════════════════════════════════════════
  linha('7. RESPOSTAS OBJETIVAS');

  console.log('  1. Saldo bancário real (movimentos)      : ' + eur(saldoA));
  console.log('  2. Saldo atual do Dashboard (lógica B)   : ' + eur(saldoB));
  console.log('  3. Diferença exata A − B                 : ' + eur(z));
  console.log('  4. Composição                            : ver tabela da secção 4');
  console.log('     (Σsaldo_inicial cancela; diferença = entradas/pagamentos + saídas/despesas)');
  console.log('  5. Pagamentos/despesas sem correspondência bancária:');
  console.log('       pagamentos confirmados sem movimento : ' + (pagSemContaLista.length + pagComContaSemMov.length) +
    '  ' + eur(somaPagSemConta + somaPagComContaSemMov));
  console.log('       despesas pagas sem movimento         : ' + (despPagasSemConta.length + despPagasSemMov.length) +
    '  ' + eur(somaDespPagasSemConta + somaDespPagasSemMov));
  console.log('  6. Movimentos sem origem operacional     :');
  console.log('       entradas sem pagamento_id            : ' + num(entSemPag.n) + '  ' + eur(entSemPag.v));
  console.log('       saídas sem despesa_id                : ' + num(saiSemDesp.n) + '  ' + eur(saiSemDesp.v));
  console.log('  7. Movimentos anulados a afetar saldos   :');
  console.log('       (saldos só contam estado=confirmado → anulados são ignorados)');
  console.log('       despesas anuladas c/ movimento confirmado: ' + num(incDespAnul.n) + '  ' + eur(incDespAnul.v));

  console.log('');
  console.log('  ═══════════════════════════════════════════════════════════');
  console.log('  NENHUMA ESCRITA FOI FEITA NA BASE DE DADOS.');
  console.log('  Apenas SELECT. Nenhuma linha foi criada, alterada ou removida.');
  console.log('  ═══════════════════════════════════════════════════════════');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('');
    console.error('Erro no diagnóstico: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
