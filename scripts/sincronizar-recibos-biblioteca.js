// ─────────────────────────────────────────────────────────────────────
// Sincronização única do histórico — Recibos emitidos → Biblioteca de Documentos.
//
// Para cada Recibo com estado='emitido' e SEM Documento associado, gera o PDF
// com a lógica já existente (mesmo output dos recibos), guarda-o no Google
// Drive (se configurado) e cria o Documento:
//   tipo='recibo', pasta='recibos' (via resolverPastaDocumento),
//   condominio_id do recibo, vínculo entidade_tipo='Recibo'/entidade_id.
//
// SEGURANÇA / IDEMPOTÊNCIA:
//  · só processa estado='emitido' (anulados ignorados);
//  · não duplica: salta recibos que já tenham Documento (por vínculo ou código);
//  · re-correr o script não cria nada novo;
//  · sem Google Drive configurado, apenas reporta (não cria documentos "vazios");
//  · executa apenas com o argumento --confirmar; use --listar para pré-visualizar.
// Não altera código da aplicação nem corre migrações.
//
// Utilização (servidor, com BD):
//   node scripts/sincronizar-recibos-biblioteca.js --listar
//   node scripts/sincronizar-recibos-biblioteca.js --confirmar
// ─────────────────────────────────────────────────────────────────────
const sequelize = require('../config/database');
const { Fracao, FracaoPessoa, Pessoa, Quota, Recibo, Documento, Condominio } = require('../models');
const { getCondominio } = require('../helpers/condominio');
const { resumoFracao } = require('../helpers/saldos');
const { gerarReciboPDF } = require('../helpers/pdf');
const recibosHelper = require('../helpers/recibos');
const storage = require('../helpers/storage');
const drive = require('../helpers/drive');
const { PASTAS_BASE, mapaPastas, resolverPastaDocumento } = require('../helpers/documento-pastas');

const CONFIRMAR = process.argv.includes('--confirmar');
const LISTAR = process.argv.includes('--listar');

if (!LISTAR && !CONFIRMAR) {
  console.error('Use --listar (pré-visualização) ou --confirmar (executar).');
  process.exit(1);
}

function formatarPermilagem(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const n = Number(valor) || 0;
  const partes = n.toFixed(3).split('.');
  partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${partes.join(',')} ‰`;
}

async function nomeMorador(fracaoId) {
  const vinculo = await FracaoPessoa.findOne({
    where: { fracao_id: fracaoId, vinculo: 'proprietario' },
    include: [{ model: Pessoa, as: 'pessoa' }],
  });
  if (vinculo && vinculo.pessoa) return vinculo.pessoa.nome;
  const qualquer = await FracaoPessoa.findOne({
    where: { fracao_id: fracaoId },
    include: [{ model: Pessoa, as: 'pessoa' }],
  });
  return qualquer && qualquer.pessoa ? qualquer.pessoa.nome : null;
}

async function gerarPdfRecibo(recibo, condRow) {
  const morador = await nomeMorador(recibo.fracao_id);
  const resumo = await resumoFracao(recibo.fracao_id);
  const fracao = recibo.fracao || null;
  const quotas = (recibo.quotas || []).slice().sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
  const pagamentos = await recibosHelper.pagamentosDasQuotas(quotas.map((q) => q.id));
  const fracaoDesig = fracao ? fracao.designacao : '—';
  const cpLocalidade = [condRow.codigo_postal, condRow.localidade].filter(Boolean).join(' ');
  const destinatario = {
    nome: morador || null,
    fracao: fracao ? fracao.designacao : null,
    morada: condRow.morada || null,
    codigoPostalLocalidade: cpLocalidade || null,
  };
  return gerarReciboPDF(condRow, {
    numero: recibo.codigo,
    codigoVerificacao: recibo.codigo_verificacao,
    data: recibo.data_emissao || new Date(),
    condominoNome: morador || 'Condómino',
    destinatario,
    fracaoDesignacao: fracaoDesig,
    fracaoPermilagem: fracao && fracao.permilagem !== null && fracao.permilagem !== undefined ? formatarPermilagem(fracao.permilagem) : null,
    valor: recibo.valor,
    saldoAposPagamento: resumo ? resumo.emDivida : 0,
    anulado: false,
    pagamentos,
    quotas: quotas.map((q) => ({
      numero: q.numero_documento || '',
      periodo: recibosHelper.periodoLabel([{ ano: q.ano, mes: q.mes }]),
      valorAplicado: q.ReciboQuota ? q.ReciboQuota.valor : q.valor,
    })),
  });
}

async function main() {
  // Standalone: carrega os tokens do Google Drive guardados na BD (na app é
  // feito no arranque). Sem isto, isConfigured() devolve sempre false.
  await drive.inicializar();

  const recibos = await Recibo.findAll({
    where: { estado: 'emitido' },
    include: [
      { model: Fracao, as: 'fracao' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor', 'valor_base', 'valor_fcr'] } },
    ],
    order: [['id', 'ASC']],
  });

  const alvos = [];
  for (const recibo of recibos) {
    const ja =
      (await Documento.findOne({
        where: { condominio_id: recibo.condominio_id, entidade_tipo: 'Recibo', entidade_id: recibo.id },
      })) ||
      (await Documento.findOne({
        where: { condominio_id: recibo.condominio_id, tipo: 'recibo', numero_documento: recibo.codigo },
      }));
    if (!ja) alvos.push(recibo);
  }

  const condIds = [...new Set(alvos.map((r) => r.condominio_id))];
  const conds = await Condominio.findAll({ where: { id: condIds } });
  const condPorId = new Map(conds.map((c) => [c.id, c]));

  console.log(`Recibos emitidos: ${recibos.length} | sem Documento (alvos): ${alvos.length}`);
  console.log(`Drive configurado: ${storage.isConfigured() ? 'sim' : 'não'}`);

  if (LISTAR || !storage.isConfigured()) {
    for (const r of alvos.slice(0, 25)) {
      const cond = condPorId.get(r.condominio_id);
      console.log(`  - codigo=${r.codigo} id=${r.id} condominio_id=${r.condominio_id} (${cond ? cond.designacao : '?'})`);
    }
    if (alvos.length > 25) console.log(`  … (+${alvos.length - 25})`);
    if (!CONFIRMAR) console.log('\nModo pré-visualização: nada foi criado.');
    if (!storage.isConfigured()) {
      console.log('\nGoogle Drive NÃO está configurado — não é possível guardar os PDFs. Nada foi criado.');
    }
    await sequelize.close();
    return;
  }

  // Execução real (--confirmar + Drive configurado).
  let criados = 0;
  let erros = 0;
  for (const recibo of alvos) {
    try {
      const condRowObjeto = condPorId.get(recibo.condominio_id);
      const cond = condRowObjeto && condRowObjeto.toJSON ? condRowObjeto.toJSON() : condRowObjeto || {};
      const decisao = resolverPastaDocumento({
        tipo: 'recibo',
        pastaEscolhida: null,
        pastasValidas: Object.keys(mapaPastas(condRowObjeto)),
      });
      const buffer = await gerarPdfRecibo(recibo, cond);
      const ano = recibo.data_emissao ? new Date(recibo.data_emissao).getFullYear() : new Date().getFullYear();
      const pastaDrive = await storage.pastaParaDocumento('recibo', ano);
      const up = await storage.uploadArquivo({
        nome: `Recibo ${recibo.codigo}.pdf`,
        mimeType: 'application/pdf',
        buffer,
        parentFolderId: pastaDrive,
      });
      await Documento.create({
        condominio_id: recibo.condominio_id,
        tipo: 'recibo',
        numero_documento: recibo.codigo,
        nome: `Recibo ${recibo.codigo}`,
        pasta: decisao.pasta,
        drive_file_id: up.driveFileId,
        drive_folder_id: pastaDrive,
        mime_type: 'application/pdf',
        tamanho: up.tamanho,
        data: recibo.data_emissao || new Date(),
        url: up.url,
        drive_status: 'guardado',
        drive_uploaded_at: new Date(),
        entidade_tipo: 'Recibo',
        entidade_id: recibo.id,
        created_by: null,
      });
      criados++;
      console.log(`  + ${recibo.codigo} (Documento criado na pasta ${decisao.pasta})`);
    } catch (err) {
      erros++;
      console.error(`  ! ${recibo.codigo}: ${err.message}`);
    }
  }
  console.log(`\nConcluído: ${criados} documento(s) criado(s); ${erros} erro(s).`);
  await sequelize.close();
}

main().catch((err) => {
  console.error('Erro na sincronização:', err.message);
  process.exit(1);
});
