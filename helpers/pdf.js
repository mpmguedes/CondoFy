const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatEUR } = require('./money');
const { formatDate } = require('./dates');

// Resolve o caminho físico do logótipo (guardado como nome de ficheiro em public/uploads).
function caminhoLogotipo(condominio) {
  if (!condominio || !condominio.logotipo) return null;
  const caminho = path.join(__dirname, '..', 'public', 'uploads', condominio.logotipo);
  return fs.existsSync(caminho) ? caminho : null;
}

// Cria um documento A4 com margens e paginação.
function criarDocumento() {
  return new PDFDocument({
    size: 'A4',
    margin: 50,
    bufferPages: true,
    info: { Title: 'Condofy', Author: 'Condofy' },
  });
}

function desenharCabecalho(doc, condominio, titulo) {
  const logo = caminhoLogotipo(condominio);
  let xTexto = 50;

  if (logo && condominio.identidade_visual === 'logo') {
    try {
      doc.image(logo, 50, 40, { height: 55 });
      xTexto = 120;
    } catch (err) {
      xTexto = 50;
    }
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(15)
    .text(condominio.designacao || 'Condomínio', xTexto, 42, { width: 300, lineBreak: false });

  const morada = [
    condominio.morada,
    [condominio.codigo_postal, condominio.localidade].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#555555')
    .text(morada, xTexto, 62, { width: 300 });
  if (condominio.nif) {
    doc.text(`NIF: ${condominio.nif}`, xTexto, 76, { width: 300 });
  }

  // Título do documento à direita
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor('#1f2937')
    .text(titulo, 300, 45, { width: 245, align: 'right' });

  doc
    .moveTo(50, 108)
    .lineTo(545, 108)
    .lineWidth(1.2)
    .strokeColor('#2563eb')
    .stroke();
}

function desenharRodape(doc, condominio) {
  const rodape = `Condomínio ${condominio.designacao || ''} · Documento gerado por Condofy`;
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#888888')
    .text(rodape, 50, 790, { width: 400, align: 'left' });
}

function finalizarPaginacao(doc, condominio) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .moveTo(50, 782)
      .lineTo(545, 782)
      .lineWidth(0.5)
      .strokeColor('#cccccc')
      .stroke();
    desenharRodape(doc, condominio);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#888888')
      .text(`Página ${i + 1} de ${range.count}`, 450, 790, { width: 95, align: 'right' });
  }
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// Rótulo:valor em duas colunas
function linha(doc, y, rotulo, valor, x1 = 50, x2 = 300, width = 245, cor = '#111827') {
  doc.font('Helvetica').fontSize(10).fillColor('#555555').text(rotulo, x1, y, { width: 200 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(cor).text(valor, x2, y, { width, align: 'right' });
}

function caixa(doc, y, altura, titulo, cor = '#2563eb') {
  doc.roundedRect(50, y, 495, altura, 6).fillAndStroke('#f8fafc', cor);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(cor).text(titulo, 62, y + 8);
}

// ═══════════════════════════════════════════════════════════════════
// AVISO DE QUOTA
// ═══════════════════════════════════════════════════════════════════
async function gerarAvisoQuotaPDF(condominio, d) {
  const doc = criarDocumento();
  desenharCabecalho(doc, condominio, 'AVISO DE QUOTA');

  let y = 130;

  // Destinatário
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Destinatário', 50, y);
  y += 16;
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(d.destinatarioNome || '—', 50, y);
  y += 14;
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#555555')
    .text(`Fração: ${d.fracaoDesignacao || ''}`, 50, y);
  y += 14;
  if (d.fracaoMorada) {
    doc.text(d.fracaoMorada, 50, y);
    y += 14;
  }

  y += 8;

  // Informação da quota
  caixa(doc, y, 92, 'Informação da quota');
  y += 22;
  linha(doc, y, 'Número do aviso', d.numero || '—');
  y += 16;
  linha(doc, y, 'Período', d.periodo || '—');
  y += 16;
  linha(doc, y, 'Data de emissão', formatDate(d.dataEmissao));
  y += 16;
  linha(doc, y, 'Data de vencimento', formatDate(d.dataVencimento));
  y += 16;
  linha(doc, y, 'Valor da quota', formatEUR(d.valor));
  y += 100;

  // Situação financeira
  caixa(doc, y, 108, 'Situação financeira', '#0f766e');
  y += 22;
  linha(doc, y, 'Saldo anterior', formatEUR(d.saldoAnterior), 50, 300, 245, '#0f766e');
  y += 16;
  const ult = d.ultimoPagamento
    ? `${formatEUR(d.ultimoPagamentoValor)} — ${formatDate(d.ultimoPagamentoData)}`
    : '—';
  linha(doc, y, 'Último pagamento', ult, 50, 300, 245, '#0f766e');
  y += 16;
  linha(doc, y, 'Em dívida (antes desta quota)', formatEUR(d.emDivida), 50, 300, 245, '#0f766e');
  y += 16;
  linha(doc, y, 'Quota atual', formatEUR(d.valor), 50, 300, 245, '#0f766e');
  y += 16;
  linha(doc, y, 'Total a pagar', formatEUR(d.totalAPagar), 50, 300, 245, '#0f766e');
  y += 110;

  // Pagamento
  caixa(doc, y, 96, 'Pagamento', '#b45309');
  y += 22;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('IBAN:', 62, y);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#b45309').text(d.iban || '—', 105, y - 2);
  y += 26;
  if (d.outrosMeiosPagamento) {
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(d.outrosMeiosPagamento, 62, y, { width: 470 });
    y += 20;
  }
  if (d.referencia) {
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Referência: ${d.referencia}`, 62, y);
    y += 16;
  }
  if (d.instrucoesPagamento) {
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(d.instrucoesPagamento, 62, y, { width: 470 });
  }

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ═══════════════════════════════════════════════════════════════════
// RECIBO
// ═══════════════════════════════════════════════════════════════════
async function gerarReciboPDF(condominio, d) {
  const doc = criarDocumento();
  desenharCabecalho(doc, condominio, 'RECIBO');

  let y = 130;

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Recibo n.º ' + (d.numero || '—'), 50, y);
  y += 16;
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Data: ${formatDate(d.data)}`, 50, y);
  y += 20;

  caixa(doc, y, 80, 'Dados do pagamento');
  y += 22;
  linha(doc, y, 'Condómino', d.condominoNome || '—');
  y += 16;
  linha(doc, y, 'Fração', d.fracaoDesignacao || '—');
  y += 16;
  linha(doc, y, 'Data do pagamento', formatDate(d.dataPagamento));
  y += 16;
  linha(doc, y, 'Método de pagamento', d.metodoPagamento || '—');
  y += 16;
  linha(doc, y, 'Referência', d.referencia || '—');
  y += 88;

  // Distribuição pelas quotas
  if (d.quotas && d.quotas.length) {
    caixa(doc, y, 30 + d.quotas.length * 16, 'Distribuição pelas quotas', '#0f766e');
    y += 22;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text('Quota', 62, y);
    doc.text('Período', 250, y);
    doc.text('Valor aplicado', 400, y, { width: 130, align: 'right' });
    y += 14;
    for (const q of d.quotas) {
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(q.numero || '', 62, y);
      doc.text(q.periodo || '', 250, y);
      doc.text(formatEUR(q.valorAplicado), 400, y, { width: 130, align: 'right' });
      y += 16;
    }
    y += 24;
  }

  // Total
  doc.roundedRect(50, y, 495, 54, 6).fillAndStroke('#f0fdf4', '#16a34a');
  y += 16;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#166534').text('Valor recebido', 62, y);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#166534').text(formatEUR(d.valor), 400, y - 2, { width: 130, align: 'right' });
  y += 24;
  doc.font('Helvetica').fontSize(9).fillColor('#166534').text(`Saldo após pagamento: ${formatEUR(d.saldoAposPagamento)}`, 62, y);
  y += 60;

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ═══════════════════════════════════════════════════════════════════
// CONVOCATÓRIA
// ═══════════════════════════════════════════════════════════════════
async function gerarConvocatoriaPDF(condominio, d) {
  const doc = criarDocumento();
  desenharCabecalho(doc, condominio, 'CONVOCATÓRIA');

  let y = 130;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Assembleia de condóminos', 50, y);
  y += 22;

  caixa(doc, y, 70, 'Informações');
  y += 22;
  linha(doc, y, 'Data', formatDate(d.data));
  y += 16;
  linha(doc, y, 'Hora', d.hora || '—');
  y += 16;
  linha(doc, y, 'Local', d.local || '—');
  y += 80;

  caixa(doc, y, 30 + Math.max(1, (d.ordemTrabalhos || []).length) * 16, 'Ordem de trabalhos', '#0f766e');
  y += 24;
  if (d.ordemTrabalhos && d.ordemTrabalhos.length) {
    let n = 1;
    for (const ponto of d.ordemTrabalhos) {
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`${n}. ${ponto}`, 62, y, { width: 470 });
      y += 16;
      n++;
    }
  } else {
    doc.font('Helvetica').fontSize(10).fillColor('#888888').text('(sem pontos definidos)', 62, y);
  }

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ═══════════════════════════════════════════════════════════════════
// ATA
// ═══════════════════════════════════════════════════════════════════
async function gerarAtaPDF(condominio, d) {
  const doc = criarDocumento();
  desenharCabecalho(doc, condominio, 'ATA');

  let y = 130;
  caixa(doc, y, 86, 'Identificação');
  y += 22;
  linha(doc, y, 'Data', formatDate(d.data));
  y += 16;
  linha(doc, y, 'Hora', d.hora || '—');
  y += 16;
  linha(doc, y, 'Local', d.local || '—');
  y += 16;
  linha(doc, y, 'Presentes / permilagem', d.presentes || '—');
  y += 94;

  if (d.ordemTrabalhos && d.ordemTrabalhos.length) {
    caixa(doc, y, 24 + d.ordemTrabalhos.length * 16, 'Ordem de trabalhos', '#0f766e');
    y += 24;
    let n = 1;
    for (const ponto of d.ordemTrabalhos) {
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`${n}. ${ponto}`, 62, y, { width: 470 });
      y += 16;
      n++;
    }
    y += 20;
  }

  caixa(doc, y, 24, 'Deliberações', '#b45309');
  y += 24;
  const texto = d.ataTexto || '(sem conteúdo registado)';
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(texto, 62, y, { width: 470 });

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

module.exports = { gerarAvisoQuotaPDF, gerarReciboPDF, gerarConvocatoriaPDF, gerarAtaPDF };
