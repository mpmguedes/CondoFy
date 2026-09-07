// ─────────────────────────────────────────────────────────────────────
// DIAGNÓSTICO (somente leitura) — Recibos antigos vs Biblioteca de Documentos.
// Não cria/altera/apaga registos. Não executa migrations.
// Utilização (no servidor, com BD ligada):
//   node scripts/diagnostico-recibos.js
// ─────────────────────────────────────────────────────────────────────
const sequelize = require('../config/database');

async function q(sql) {
  const [rows] = await sequelize.query(sql);
  return rows;
}

function num(linha) {
  return linha && linha.n !== undefined ? Number(linha.n) : 0;
}

async function main() {
  const [
    totalRecibos,
    porCondominio,
    comDocumentoEntidade,
    semDocumento,
    comDocPorCodigo,
    totalDocsRecibo,
    docsReciboPastaRecibos,
    docsReciboPastaErrada,
    dupEntidade,
    dupCodigo,
    reciboDuplicadosDoc,
    exemplos,
  ] = await Promise.all([
    q('SELECT COUNT(*) AS n FROM recibos'),
    q(`SELECT r.condominio_id, COALESCE(c.designacao, '(sem condomínio)') AS designacao, COUNT(*) AS n
       FROM recibos r LEFT JOIN condominios c ON c.id = r.condominio_id
       GROUP BY r.condominio_id, c.designacao ORDER BY n DESC`),
    // 3) Recibos com Documento ligado por entidade_tipo/entidade_id.
    q(`SELECT COUNT(DISTINCT r.id) AS n
       FROM recibos r
       JOIN documentos d ON d.condominio_id = r.condominio_id
        AND d.entidade_tipo = 'Recibo' AND d.entidade_id = r.id`),
    // 4) Recibos SEM Documento ligado por entidade.
    q(`SELECT COUNT(*) AS n FROM recibos r
       WHERE NOT EXISTS (
         SELECT 1 FROM documentos d
         WHERE d.condominio_id = r.condominio_id AND d.entidade_tipo = 'Recibo' AND d.entidade_id = r.id
       )`),
    // 5) Recibos sem ligação entidade, mas com Documento tipo 'recibo' cujo
    //    numero_documento = código do recibo (candidato legado, com ficheiro).
    q(`SELECT COUNT(DISTINCT r.id) AS n
       FROM recibos r
       JOIN documentos d ON d.condominio_id = r.condominio_id
        AND d.tipo = 'recibo' AND d.numero_documento = r.codigo
       WHERE NOT EXISTS (
         SELECT 1 FROM documentos d2
         WHERE d2.condominio_id = r.condominio_id AND d2.entidade_tipo = 'Recibo' AND d2.entidade_id = r.id
       )`),
    q(`SELECT COUNT(*) AS n FROM documentos WHERE tipo = 'recibo'`),
    q(`SELECT COUNT(*) AS n FROM documentos WHERE tipo = 'recibo' AND pasta = 'recibos'`),
    q(`SELECT COUNT(*) AS n FROM documentos WHERE tipo = 'recibo' AND COALESCE(pasta,'') <> 'recibos'`),
    // 9) Possíveis duplicados.
    q(`SELECT COUNT(*) AS n FROM (
         SELECT condominio_id, entidade_tipo, entidade_id FROM documentos
         WHERE entidade_tipo = 'Recibo' AND entidade_id IS NOT NULL
         GROUP BY condominio_id, entidade_tipo, entidade_id HAVING COUNT(*) > 1
       ) t`),
    q(`SELECT COUNT(*) AS n FROM (
         SELECT condominio_id, numero_documento FROM documentos
         WHERE tipo = 'recibo' AND numero_documento IS NOT NULL
         GROUP BY condominio_id, numero_documento HAVING COUNT(*) > 1
       ) t`),
    q(`SELECT COUNT(*) AS n FROM (
         SELECT d.condominio_id, d.entidade_id FROM documentos d
         WHERE d.entidade_tipo = 'Recibo' AND d.entidade_id IS NOT NULL
         GROUP BY d.condominio_id, d.entidade_id HAVING COUNT(*) > 1
       ) t`),
    // 10) Exemplos de recibos antigos SEM Documento (id/código e metadados).
    q(`SELECT r.id, r.codigo, r.condominio_id, r.estado, r.ano, r.data_emissao, r.created_at,
              EXISTS (SELECT 1 FROM documentos d
                      WHERE d.condominio_id = r.condominio_id AND d.tipo='recibo'
                        AND d.numero_documento = r.codigo AND d.drive_status = 'guardado') AS tem_pdf_codigo
       FROM recibos r
       WHERE NOT EXISTS (
         SELECT 1 FROM documentos d
         WHERE d.condominio_id = r.condominio_id AND d.entidade_tipo = 'Recibo' AND d.entidade_id = r.id
       )
       ORDER BY r.id ASC LIMIT 15`),
  ]);

  const total = num(totalRecibos[0] || {});
  const comDoc = num(comDocumentoEntidade[0] || {});
  const semDoc = num(semDocumento[0] || {});
  // "Sem documento mas com PDF": só conseguimos confirmar ficheiro quando há
  // um Documento candidato por código (drive_status='guardado').
  const semDocMasComPdf = num(comDocPorCodigo[0] || {});
  const semDocSemPdf = Math.max(0, semDoc - semDocMasComPdf);
  const totDocsRecibo = num(totalDocsRecibo[0] || {});
  const docsPastaRecibos = num(docsReciboPastaRecibos[0] || {});
  const docsPastaErrada = num(docsReciboPastaErrada[0] || {});
  const dupsEntidade = num(dupEntidade[0] || {});
  const dupsCodigo = num(dupCodigo[0] || {});
  const dupsReciboComMaisDoc = num(reciboDuplicadosDoc[0] || {});
  const possiveisDuplicados = dupsEntidade + dupsCodigo + dupsReciboComMaisDoc;

  console.log('=== DIAGNÓSTICO — Recibos vs Biblioteca de Documentos (somente leitura) ===\n');

  console.log('Recibos por condomínio:');
  for (const linha of porCondominio) {
    console.log(`  condomínio ${linha.condominio_id || 'NULL'} (${linha.designacao}): ${linha.n}`);
  }
  console.log('');

  const tabela = [
    ['Recibos totais', String(total)],
    ['Com Documento (ligação entidade)', String(comDoc)],
    ['Sem Documento (sem ligação entidade)', String(semDoc)],
    ['Sem Documento mas com PDF/ficheiro (candidato por código, drive guardado)', String(semDocMasComPdf)],
    ['Sem Documento e sem PDF/ficheiro disponível', String(semDocSemPdf)],
    ['Documentos tipo "recibo"', String(totDocsRecibo)],
    ['Documentos tipo "recibo" na pasta "recibos"', String(docsPastaRecibos)],
    ['Documentos tipo "recibo" com pasta errada (≠ recibos)', String(docsPastaErrada)],
    ['Possíveis duplicados (grupos >1 por entidade)', String(dupsEntidade)],
    ['Possíveis duplicados (grupos >1 por código)', String(dupsCodigo)],
    ['Recibos com mais de 1 documento ligado', String(dupsReciboComMaisDoc)],
  ];
  const larg = Math.max(...tabela.map(([a]) => a.length));
  console.log('Resumo:');
  for (const [rotulo, valor] of tabela) {
    console.log(`  ${rotulo.padEnd(larg + 2)}${valor}`);
  }

  console.log('\nExemplos — recibos SEM Documento ligado (primeiros 15; apenas dados técnicos):');
  if (exemplos.length) {
    for (const e of exemplos) {
      console.log(
        `  id=${e.id} codigo=${e.codigo} condominio_id=${e.condominio_id} estado=${e.estado} ` +
          `ano=${e.ano} emissao=${e.data_emissao ? String(e.data_emissao).slice(0, 10) : '?'} ` +
          `tem_pdf_por_codigo=${e.tem_pdf_codigo === 0 || e.tem_pdf_codigo === '0' ? 'não' : 'sim'}`
      );
    }
  } else {
    console.log('  (nenhum)');
  }

  console.log('\nInterpretação rápida:');
  console.log(`  A) antigos com PDF mas sem Documento  → ≈ ${semDocMasComPdf} (confirmáveis por documento-candidato por código)`);
  console.log(`  B) antigos sem PDF/documento físico     → ≈ ${semDocSemPdf} (sem documento-candidato)`);
  console.log(`  C) com Documento mal classificado      → ${docsPastaErrada} documentos tipo recibo fora de "recibos"`);
  console.log(`  D) possíveis duplicados                → ${possiveisDuplicados} (grupos)`);

  await sequelize.close();
}

main().catch((err) => {
  console.error('Erro no diagnóstico:', err.message);
  process.exit(1);
});
