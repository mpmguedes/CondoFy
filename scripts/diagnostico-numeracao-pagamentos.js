// ═══════════════════════════════════════════════════════════════════
// Diagnóstico (SOMENTE LEITURA) da numeração dos documentos de PAGAMENTO.
//
// Contexto — erro de produção (2026-09):
//   SequelizeUniqueConstraintError: numero_documento must be unique
//   MySQL: Duplicate entry '2026/0004' for key 'numero_documento'
//   Vários pagamentos DIFERENTES falhavam todos com o MESMO número.
//
// Causa: a série `numeracoes`('recibo', <ano>) — a série dos PAGAMENTOS —
// ficou ATRASADA em relação aos números já gravados em `pagamentos`, e o
// incremento vivia dentro da transação do pagamento (o rollback desfazia-o,
// pelo que a série ficava presa e o erro era permanente, não transitório).
//
// Este script responde a três perguntas, sem escrever nada:
//   1. Qual é o desalinhamento real (sequência vs. maior documento gravado)?
//   2. Que número cada registo seguinte vai tentar usar?
//   3. Com a correção (`jaUsado`), que número vai efetivamente usar?
//
// Utilização (no servidor, no diretório da aplicação):
//   node scripts/diagnostico-numeracao-pagamentos.js
//   docker compose exec app node scripts/diagnostico-numeracao-pagamentos.js
//
// ⛔ NÃO escreve na base de dados: só faz SELECT. Não cria quotas, pagamentos
// nem índices, não corre jobs, não envia emails, não reinicia serviços e não
// executa migrations. É seguro correr em produção.
// ⛔ NÃO imprime segredos nem dados pessoais: só ids, números de documento,
// datas e valores.
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();

const { QueryTypes } = require('sequelize');

function linha(titulo) {
  console.log('');
  console.log('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 62 - titulo.length)));
}

// ── Parsing do número do documento ──────────────────────────────────
// '2026/0004'        → { ano: 2026, sequencia: 4 }   (série dos PAGAMENTOS)
// 'RCP-2026-0009'    → { ano: 2026, sequencia: 9 }   (série dos RECIBOS)
function analisarNumero(numero) {
  if (!numero) return { ano: null, sequencia: null };
  const s = String(numero).trim();
  let m = s.match(/^(\d{4})\s*\/\s*(\d+)$/);
  if (m) return { ano: Number(m[1]), sequencia: Number(m[2]) };
  m = s.match(/^RCP-(\d{4})-(\d+)$/i);
  if (m) return { ano: Number(m[1]), sequencia: Number(m[2]) };
  return { ano: null, sequencia: null };
}

function compor(formato, ano, sequencia) {
  return String(formato || '{ano}/{sequencia}')
    .replace('{ano}', String(ano))
    .replace('{sequencia}', String(sequencia).padStart(4, '0'));
}

// Próximo número que o gerador devolveria, saltando os já ocupados.
// É a réplica da lógica corrigida de `helpers/numeracao.js` (predicado `jaUsado`).
function proximoLivre(formato, sequenciaAtual, ano, ocupados) {
  let seq = sequenciaAtual + 1;
  let numero = compor(formato, ano, seq);
  while (ocupados.has(numero)) {
    seq += 1;
    numero = compor(formato, ano, seq);
  }
  return { numero, sequencia: seq, saltos: seq - (sequenciaAtual + 1) };
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Numeração dos documentos de PAGAMENTO (só leitura)');
  console.log('══════════════════════════════════════════════════════════════');

  const sequelize = require('../config/database');

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
  const num = (v) => Number(v || 0);

  // ── 1. Todas as séries de numeração ───────────────────────────────
  linha('1. Séries em `numeracoes` (a tabela é GLOBAL — não tem condominio_id)');
  const series = await S(`
    SELECT tipo_documento, ano, sequencia, formato
    FROM numeracoes
    ORDER BY tipo_documento ASC, ano DESC
  `);
  if (!series.length) {
    console.log('  (tabela vazia — nenhuma série foi ainda criada)');
  } else {
    console.log('  ' + 'TIPO'.padEnd(20) + 'ANO'.padEnd(7) + 'SEQUÊNCIA'.padEnd(11) + 'FORMATO');
    for (const s of series) {
      console.log(
        '  ' +
          String(s.tipo_documento).padEnd(20) +
          String(s.ano).padEnd(7) +
          String(s.sequencia).padEnd(11) +
          String(s.formato || '{ano}/{sequencia}')
      );
    }
    console.log('');
    console.log("  ⚠ 'recibo' = série dos PAGAMENTOS ({ano}/{sequencia})");
    console.log("    'recibo_mensal' = série dos RECIBOS (RCP-{ano}-{sequencia})");
  }

  // ── 2. Números já gravados em `pagamentos` ────────────────────────
  linha('2. Números de documento já gravados em `pagamentos`');
  const porAno = await S(`
    SELECT
      CAST(SUBSTRING_INDEX(numero_documento, '/', 1) AS UNSIGNED) AS ano,
      COUNT(*) AS n,
      MIN(numero_documento) AS menor,
      MAX(numero_documento) AS maior,
      MAX(CAST(SUBSTRING_INDEX(numero_documento, '/', -1) AS UNSIGNED)) AS maior_seq
    FROM pagamentos
    WHERE numero_documento REGEXP '^[0-9]{4}/[0-9]+$'
    GROUP BY ano
    ORDER BY ano DESC
  `);
  if (!porAno.length) {
    console.log('  (nenhum pagamento com número no formato {ano}/{sequência})');
  } else {
    console.log('  ' + 'ANO'.padEnd(7) + 'Nº DOCS'.padEnd(10) + 'MENOR'.padEnd(14) + 'MAIOR'.padEnd(14) + 'MAIOR SEQ');
    for (const a of porAno) {
      console.log(
        '  ' +
          String(a.ano).padEnd(7) +
          String(a.n).padEnd(10) +
          String(a.menor).padEnd(14) +
          String(a.maior).padEnd(14) +
          String(num(a.maior_seq))
      );
    }
  }

  const semNumero = await S(`
    SELECT COUNT(*) AS n FROM pagamentos WHERE numero_documento IS NULL OR numero_documento = ''
  `);
  console.log('');
  console.log('  Pagamentos sem número de documento: ' + num(semNumero[0] && semNumero[0].n));

  const duplicados = await S(`
    SELECT numero_documento, COUNT(*) AS n
    FROM pagamentos
    WHERE numero_documento IS NOT NULL AND numero_documento <> ''
    GROUP BY numero_documento
    HAVING COUNT(*) > 1
  `);
  if (duplicados.length) {
    console.log('  ⛔ DUPLICADOS em `pagamentos` (a UNIQUE não devia permitir):');
    for (const d of duplicados) console.log('     ' + d.numero_documento + ' → ' + d.n + ' linhas');
  } else {
    console.log('  Duplicados em `pagamentos`: nenhum (coerente com a UNIQUE)');
  }

  // ── 3. Diagnóstico do desalinhamento da série dos PAGAMENTOS ──────
  linha('3. Desalinhamento da série `recibo` (pagamentos)');
  const seriePag = series.find((s) => s.tipo_documento === 'recibo');

  if (!seriePag) {
    console.log('  ⛔ Não existe a série `recibo` para o ano corrente.');
    console.log('     O primeiro pagamento criará a série e começará em 2026/0001.');
    console.log('     Se já existirem pagamentos numerados, a verificação `jaUsado`');
    console.log('     (após a correção) salta para o primeiro número livre.');
  } else {
    const ano = Number(seriePag.ano);
    const formato = seriePag.formato || '{ano}/{sequencia}';
    const seq = num(seriePag.sequencia);

    // Todos os números ocupados desse ano (para simular o `jaUsado`).
    const ocupadosRows = await S(`
      SELECT numero_documento FROM pagamentos WHERE numero_documento IS NOT NULL
    `);
    const ocupados = new Set(ocupadosRows.map((r) => String(r.numero_documento).trim()));

    const linhaAno = porAno.find((a) => num(a.ano) === ano);
    const maiorSeq = linhaAno ? num(linhaAno.maior_seq) : 0;

    console.log('  Série `recibo` ano ' + ano + ': sequência gravada = ' + seq);
    console.log('  Maior documento de pagamento nesse ano = ' + maiorSeq);
    console.log('');

    if (maiorSeq === 0) {
      console.log('  → Série sem documentos gravados: coerente.');
    } else if (seq < maiorSeq) {
      console.log('  ⛔ ATRASADA em ' + (maiorSeq - seq) + ' número(s).');
      console.log('     ESTE é o estado que produziu o erro de produção:');
      console.log('     o gerador antigo devolveria ' + compor(formato, ano, seq + 1) + ', já ocupado.');
    } else if (seq === maiorSeq) {
      console.log('  → Alinhada (sequência = maior documento gravado).');
    } else {
      console.log(
        '  ⚠ ADIANTADA em ' + (seq - maiorSeq) + ' número(s) — há números queimados ' +
          '(não é erro; os números nunca são reutilizados).'
      );
    }

    // ── 4. Previsão: o que o registo seguinte vai fazer ─────────────
    linha('4. Previsão do próximo registo de pagamento');
    const antigo = { numero: compor(formato, ano, seq + 1), colide: ocupados.has(compor(formato, ano, seq + 1)) };
    const livre = proximoLivre(formato, seq, ano, ocupados);

    console.log('  ANTES da correção (sem verificação de número livre):');
    console.log(
      '    tentaria ' +
        antigo.numero +
        (antigo.colide
          ? '  ⛔ JÁ OCUPADO → Duplicate entry / numero_documento must be unique'
          : '  ✓ livre')
    );
    console.log('');
    console.log('  DEPOIS da correção (`jaUsado` salta os ocupados):');
    console.log('    usaria ' + livre.numero + '  (saltou ' + livre.saltos + ' número(s) ocupado(s))');
    console.log('    e a sequência ficaria em ' + livre.sequencia);
    console.log('');
    if (antigo.colide && livre.saltos > 0) {
      console.log('  ⇒ A correção desbloqueia o registo de pagamentos SEM tocar na');
      console.log('    base de dados: a série reconcilia-se sozinha no primeiro registo.');
    } else if (!antigo.colide) {
      console.log('  ⇒ Não há colisão pendente. A correção é preventiva (importação,');
      console.log('    restauro de backup ou alinhamento manual da sequência).');
    }
  }

  // ── 5. Série dos RECIBOS (controlo cruzado) ───────────────────────
  linha('5. Série `recibo_mensal` (recibos) — controlo cruzado');
  const serieRec = series.find((s) => s.tipo_documento === 'recibo_mensal');
  const maxRecibo = await S(`
    SELECT
      CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(codigo, '-', 2), '-', -1) AS UNSIGNED) AS ano,
      COUNT(*) AS n,
      MAX(CAST(SUBSTRING_INDEX(codigo, '-', -1) AS UNSIGNED)) AS maior_seq
    FROM recibos
    WHERE codigo REGEXP '^RCP-[0-9]{4}-[0-9]+$'
    GROUP BY ano
    ORDER BY ano DESC
    LIMIT 5
  `);
  if (!maxRecibo.length) {
    console.log('  (nenhum recibo com código RCP-{ano}-{sequência})');
  } else {
    console.log('  ' + 'ANO'.padEnd(7) + 'Nº RECIBOS'.padEnd(13) + 'MAIOR SEQ'.padEnd(12) + 'SEQUÊNCIA GRAVADA');
    for (const r of maxRecibo) {
      const s = series.find((x) => x.tipo_documento === 'recibo_mensal' && num(x.ano) === num(r.ano));
      console.log(
        '  ' +
          String(r.ano).padEnd(7) +
          String(r.n).padEnd(13) +
          String(num(r.maior_seq)).padEnd(12) +
          (s ? String(num(s.sequencia)) : '— (sem série)')
      );
    }
  }
  if (serieRec) {
    console.log('');
    console.log('  ⚠ A série dos recibos NÃO tem verificação de número livre');
    console.log('    (`helpers/recibos.js:proximoReciboNumero`) — se ficar atrasada,');
    console.log('    `recibos.codigo` (UNIQUE) recusa a gravação do mesmo modo.');
  }

  // ── 6. Últimos pagamentos (padrão de numeração) ───────────────────
  linha('6. Últimos 10 pagamentos (padrão de numeração)');
  const ultimos = await S(`
    SELECT id, condominio_id, numero_documento, data_pagamento, estado
    FROM pagamentos
    ORDER BY id DESC
    LIMIT 10
  `);
  if (!ultimos.length) {
    console.log('  (nenhum pagamento)');
  } else {
    for (const p of ultimos) {
      const a = analisarNumero(p.numero_documento);
      console.log(
        '  id=' +
          String(p.id).padEnd(6) +
          ' condominio_id=' +
          String(p.condominio_id === null ? '—' : p.condominio_id).padEnd(6) +
          ' numero=' +
          String(p.numero_documento || '— (sem número)').padEnd(14) +
          ' data=' +
          String(p.data_pagamento ? String(p.data_pagamento).slice(0, 10) : '—').padEnd(12) +
          ' estado=' +
          String(p.estado) +
          (a.ano === null && p.numero_documento ? '  ⚠ formato inesperado' : '')
      );
    }
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Fim. Nada foi escrito na base de dados.');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  await sequelize.close();
}

main().catch((err) => {
  console.error('Erro no diagnóstico:', err.message);
  process.exit(1);
});
