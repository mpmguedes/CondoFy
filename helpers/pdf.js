const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatEUR } = require('./money');
const { formatDate } = require('./dates');

// ── Constantes de layout (sem números mágicos espalhados) ──────────
const T = {
  MARGEM: 50,
  LARGURA_PAGINA: 595.28,
  LARGURA_CONTEUDO: 495, // LARGURA_PAGINA - 2*MARGEM
  PADDING: 12, // margem interna das caixas
  LIMITE_INFERIOR: 778, // onde começa o rodapé
  TEXTO_SIZE: 10,
  TEXTO_SIZE_SMALL: 9,
  TITULO_DOC_SIZE: 18,
  TITULO_CAIXA_SIZE: 10,
  FONTE: 'Helvetica',
  FONTE_BOLD: 'Helvetica-Bold',
  COR_PRIMARIA: '#2563eb',
  COR_TEXTO: '#111827',
  COR_MUTED: '#555555',
  COR_SUCESSO: '#0f766e',
  COR_ALERTA: '#b45309',
  COR_VERDE: '#16a34a',
  COR_FUNDO_CAIXA: '#f8fafc',
  COR_FUNDO_VERDE: '#f0fdf4',
  LARGURA_ROTULO: 200,
  GAP_ROTULO: 20,
};

// Resolve o caminho físico do logótipo (guardado como nome de ficheiro em public/uploads).
function caminhoLogotipo(condominio) {
  if (!condominio || !condominio.logotipo) return null;
  const caminho = path.join(__dirname, '..', 'public', 'uploads', condominio.logotipo);
  return fs.existsSync(caminho) ? caminho : null;
}

function criarDocumento() {
  return new PDFDocument({
    size: 'A4',
    margin: T.MARGEM,
    bufferPages: true,
    info: { Title: 'Condofy', Author: 'Condofy' },
  });
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

// ── Layout: controla o cursor vertical, quebras de página e caixas ──
class Layout {
  constructor(doc, condominio, titulo) {
    this.doc = doc;
    this.condominio = condominio || {};
    this.titulo = titulo;
    this.y = 0;
    this.medindo = false;
    this.cx = T.MARGEM; // x do conteúdo (recuado dentro de caixas)
    this.cw = T.LARGURA_CONTEUDO; // largura do conteúdo
    this.desenharCabecalho();
  }

  desenharCabecalho() {
    const logo = caminhoLogotipo(this.condominio);
    let xTexto = T.MARGEM;

    if (logo && this.condominio.identidade_visual === 'logo') {
      try {
        this.doc.image(logo, T.MARGEM, 38, { height: 48 });
        xTexto = T.MARGEM + 66;
      } catch (err) {
        xTexto = T.MARGEM;
      }
    }

    this.doc
      .font(T.FONTE_BOLD)
      .fontSize(15)
      .fillColor(T.COR_TEXTO)
      .text(this.condominio.designacao || 'Condomínio', xTexto, 42, { width: 250, lineBreak: false });

    const morada = [
      this.condominio.morada,
      [this.condominio.codigo_postal, this.condominio.localidade].filter(Boolean).join(' '),
    ]
      .filter(Boolean)
      .join(', ');

    this.doc
      .font(T.FONTE)
      .fontSize(T.TEXTO_SIZE_SMALL)
      .fillColor(T.COR_MUTED)
      .text(morada, xTexto, 62, { width: 250 });
    if (this.condominio.nif) {
      this.doc.text(`NIF: ${this.condominio.nif}`, xTexto, 74, { width: 250 });
    }

    this.doc
      .font(T.FONTE_BOLD)
      .fontSize(T.TITULO_DOC_SIZE)
      .fillColor(T.COR_TEXTO)
      .text(this.titulo, 300, 45, { width: 245, align: 'right' });

    this.doc
      .moveTo(T.MARGEM, 96)
      .lineTo(T.MARGEM + T.LARGURA_CONTEUDO, 96)
      .lineWidth(1.2)
      .strokeColor(T.COR_PRIMARIA)
      .stroke();

    this.y = 108;
  }

  garantirEspaco(altura) {
    if (this.medindo) return;
    if (this.y + altura > T.LIMITE_INFERIOR) {
      this.doc.addPage();
      this.desenharCabecalho();
    }
  }

  espaco(n) {
    this.y += n;
  }

  texto(texto, opts = {}) {
    const fontSize = opts.fontSize || T.TEXTO_SIZE;
    const bold = opts.bold;
    const width = opts.width || this.cw;
    const h =
      this.doc.font(bold ? T.FONTE_BOLD : T.FONTE).heightOfString(String(texto ?? ''), { width, fontSize }) + 4;
    this.garantirEspaco(h);
    if (!this.medindo) {
      this.doc
        .font(bold ? T.FONTE_BOLD : T.FONTE)
        .fontSize(fontSize)
        .fillColor(opts.cor || T.COR_TEXTO)
        .text(String(texto ?? ''), this.cx, this.y, { width, lineGap: opts.lineGap || 2 });
    }
    this.y += h;
  }

  linha(rotulo, valor, opts = {}) {
    const fontSize = opts.fontSize || T.TEXTO_SIZE;
    const largValor = this.cw - T.LARGURA_ROTULO - T.GAP_ROTULO;
    const xValor = this.cx + T.LARGURA_ROTULO + T.GAP_ROTULO;
    const h =
      Math.max(
        this.doc.font(T.FONTE).heightOfString(String(rotulo ?? ''), { width: T.LARGURA_ROTULO, fontSize }),
        this.doc.font(T.FONTE_BOLD).heightOfString(String(valor ?? ''), { width: largValor, fontSize })
      ) + 4;
    this.garantirEspaco(h);
    if (!this.medindo) {
      this.doc
        .font(T.FONTE)
        .fontSize(fontSize)
        .fillColor(T.COR_MUTED)
        .text(String(rotulo ?? ''), this.cx, this.y, { width: T.LARGURA_ROTULO, lineGap: 1 });
      this.doc
        .font(T.FONTE_BOLD)
        .fontSize(fontSize)
        .fillColor(opts.cor || T.COR_TEXTO)
        .text(String(valor ?? ''), xValor, this.y, { width: largValor, align: 'right', lineGap: 1 });
    }
    this.y += h;
  }

  tabela(colunas, linhas) {
    const fontSize = T.TEXTO_SIZE_SMALL;
    const medir = (txt, c) =>
      this.doc.font(T.FONTE).heightOfString(String(txt ?? ''), { width: c.width, fontSize }) + 6;

    if (!this.medindo) {
      this.doc.font(T.FONTE_BOLD).fontSize(fontSize).fillColor(T.COR_MUTED);
      colunas.forEach((c) => this.doc.text(c.titulo, this.cx + c.x, this.y, { width: c.width, align: c.align || 'left' }));
    }
    this.y += 14;

    for (const linha of linhas) {
      const h = Math.max(...linha.map((cell, i) => medir(cell, colunas[i])));
      this.garantirEspaco(h);
      if (!this.medindo) {
        this.doc.font(T.FONTE).fontSize(fontSize).fillColor(T.COR_TEXTO);
        linha.forEach((cell, i) =>
          this.doc.text(String(cell ?? ''), this.cx + colunas[i].x, this.y, { width: colunas[i].width, align: colunas[i].align || 'left' })
        );
      }
      this.y += h;
    }
  }

  caixa(titulo, corpo, cor = T.COR_PRIMARIA, fundo = T.COR_FUNDO_CAIXA) {
    const yInicio = this.y;
    const prevCx = this.cx;
    const prevCw = this.cw;
    this.cx = T.MARGEM + T.PADDING;
    this.cw = T.LARGURA_CONTEUDO - 2 * T.PADDING;

    // mede o corpo
    this.medindo = true;
    const yMedida = this.y;
    corpo(this);
    const alturaCorpo = this.y - yMedida;
    this.medindo = false;
    this.y = yInicio;

    const alturaTotal = T.PADDING + 12 + 4 + alturaCorpo + T.PADDING;
    this.garantirEspaco(alturaTotal);

    this.doc.roundedRect(T.MARGEM, this.y, T.LARGURA_CONTEUDO, alturaTotal, 6).fillAndStroke(fundo, cor);
    this.y += T.PADDING;
    this.doc
      .font(T.FONTE_BOLD)
      .fontSize(T.TITULO_CAIXA_SIZE)
      .fillColor(cor)
      .text(titulo, T.MARGEM + T.PADDING, this.y, { width: T.LARGURA_CONTEUDO - 2 * T.PADDING });
    this.y += 12 + 4;

    corpo(this);

    this.y += T.PADDING;
    this.cx = prevCx;
    this.cw = prevCw;
  }
}

// ── Rodapé + paginação ─────────────────────────────────────────────
function finalizarPaginacao(doc, condominio) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .moveTo(T.MARGEM, 782)
      .lineTo(T.MARGEM + T.LARGURA_CONTEUDO, 782)
      .lineWidth(0.5)
      .strokeColor('#cccccc')
      .stroke();
    doc
      .font(T.FONTE)
      .fontSize(8)
      .fillColor('#888888')
      .text(`Condomínio ${condominio.designacao || ''} · Documento gerado por Condofy`, T.MARGEM, 790, { width: 400, align: 'left' });
    doc
      .font(T.FONTE)
      .fontSize(8)
      .fillColor('#888888')
      .text(`Página ${i + 1} de ${range.count}`, 450, 790, { width: 95, align: 'right' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// AVISO DE QUOTA
// ═══════════════════════════════════════════════════════════════════
async function gerarAvisoQuotaPDF(condominio, d) {
  const doc = criarDocumento();
  const L = new Layout(doc, condominio, 'AVISO DE QUOTA');

  L.texto('Destinatário', { bold: true, fontSize: 11 });
  L.texto(d.destinatarioNome || '—');
  L.texto(`Fração: ${d.fracaoDesignacao || ''}`, { fontSize: T.TEXTO_SIZE_SMALL, cor: T.COR_MUTED });
  if (d.fracaoMorada) {
    L.texto(d.fracaoMorada, { fontSize: T.TEXTO_SIZE_SMALL, cor: T.COR_MUTED });
  }
  L.espaco(10);

  L.caixa('Informação da quota', (C) => {
    C.linha('Número do aviso', d.numero || '—');
    C.linha('Período', d.periodo || '—');
    C.linha('Data de emissão', formatDate(d.dataEmissao));
    C.linha('Data de vencimento', formatDate(d.dataVencimento));
    C.linha('Valor da quota', formatEUR(d.valor));
  });

  L.caixa(
    'Situação financeira',
    (C) => {
      C.linha('Saldo anterior', formatEUR(d.saldoAnterior), { cor: T.COR_SUCESSO });
      const ult = d.ultimoPagamento
        ? `${formatEUR(d.ultimoPagamentoValor)} — ${formatDate(d.ultimoPagamentoData)}`
        : '—';
      C.linha('Último pagamento', ult, { cor: T.COR_SUCESSO });
      C.linha('Em dívida (antes desta quota)', formatEUR(d.emDivida), { cor: T.COR_SUCESSO });
      C.linha('Quota atual', formatEUR(d.valor), { cor: T.COR_SUCESSO });
      C.linha('Total a pagar', formatEUR(d.totalAPagar), { cor: T.COR_SUCESSO });
    },
    T.COR_SUCESSO
  );

  L.caixa(
    'Pagamento',
    (C) => {
      C.linha('IBAN', d.iban || '—', { fontSize: 12 });
      if (d.outrosMeiosPagamento) {
        C.texto(d.outrosMeiosPagamento, { fontSize: T.TEXTO_SIZE_SMALL, cor: T.COR_MUTED });
      }
      if (d.referencia) {
        C.texto(`Referência: ${d.referencia}`, { fontSize: T.TEXTO_SIZE_SMALL, cor: T.COR_MUTED });
      }
      if (d.instrucoesPagamento) {
        C.texto(d.instrucoesPagamento, { fontSize: T.TEXTO_SIZE_SMALL, cor: T.COR_MUTED });
      }
    },
    T.COR_ALERTA
  );

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ═══════════════════════════════════════════════════════════════════
// RECIBO
// ═══════════════════════════════════════════════════════════════════
async function gerarReciboPDF(condominio, d) {
  const doc = criarDocumento();
  const L = new Layout(doc, condominio, 'RECIBO');

  L.texto(`Recibo n.º ${d.numero || '—'}`, { bold: true, fontSize: 12 });
  L.texto(`Data: ${formatDate(d.data)}`, { cor: T.COR_MUTED });
  L.espaco(6);

  L.caixa('Dados do pagamento', (C) => {
    C.linha('Condómino', d.condominoNome || '—');
    C.linha('Fração', d.fracaoDesignacao || '—');
    C.linha('Data do pagamento', formatDate(d.dataPagamento));
    C.linha('Método de pagamento', d.metodoPagamento || '—');
    C.linha('Referência', d.referencia || '—');
  });

  if (d.quotas && d.quotas.length) {
    L.caixa(
      'Distribuição pelas quotas',
      (C) => {
        C.tabela(
          [
            { titulo: 'Quota', x: 0, width: 120 },
            { titulo: 'Período', x: 130, width: 150 },
            { titulo: 'Valor aplicado', x: 300, width: 160, align: 'right' },
          ],
          d.quotas.map((q) => [q.numero || '', q.periodo || '', formatEUR(q.valorAplicado)])
        );
      },
      T.COR_SUCESSO
    );
  }

  // Total
  L.garantirEspaco(70);
  const yTotal = L.y;
  L.doc.roundedRect(T.MARGEM, yTotal, T.LARGURA_CONTEUDO, 64, 6).fillAndStroke(T.COR_FUNDO_VERDE, T.COR_VERDE);
  L.doc.font(T.FONTE_BOLD).fontSize(11).fillColor('#166534').text('Valor recebido', T.MARGEM + T.PADDING, yTotal + 14);
  L.doc
    .font(T.FONTE_BOLD)
    .fontSize(16)
    .fillColor('#166534')
    .text(formatEUR(d.valor), 300, yTotal + 12, { width: 220, align: 'right' });
  L.doc
    .font(T.FONTE)
    .fontSize(T.TEXTO_SIZE_SMALL)
    .fillColor('#166534')
    .text(`Saldo após pagamento: ${formatEUR(d.saldoAposPagamento)}`, T.MARGEM + T.PADDING, yTotal + 40);
  L.espaco(76);

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ═══════════════════════════════════════════════════════════════════
// CONVOCATÓRIA
// ═══════════════════════════════════════════════════════════════════
async function gerarConvocatoriaPDF(condominio, d) {
  const doc = criarDocumento();
  const L = new Layout(doc, condominio, 'CONVOCATÓRIA');

  L.texto('Assembleia de condóminos', { bold: true, fontSize: 11 });
  L.espaco(6);

  L.caixa('Identificação', (C) => {
    C.linha('Número', d.numero || '—');
    C.linha('Tipo', d.tipo || '—');
    C.linha('Data', formatDate(d.data));
    C.linha('Hora (1.ª convocatória)', d.hora || '—');
    C.linha('Hora (2.ª convocatória)', d.horaSegunda || '—');
    C.linha('Local', d.local || '—');
  });

  L.caixa(
    'Ordem de trabalhos',
    (C) => {
      if (d.ordemTrabalhos && d.ordemTrabalhos.length) {
        let n = 1;
        for (const ponto of d.ordemTrabalhos) {
          C.texto(`${n}. ${ponto}`);
          n++;
        }
      } else {
        C.texto('(sem pontos definidos)', { cor: T.COR_MUTED });
      }
    },
    T.COR_SUCESSO
  );

  L.caixa(
    'Convocações e quórum',
    (C) => {
      C.texto('1.ª convocatória — a assembleia reúne à hora indicada desde que estejam presentes condóminos que representem, pelo menos, metade do valor total do edifício.');
      C.espaco(2);
      C.texto('2.ª convocatória — decorridos 30 minutos, a assembleia pode deliberar com qualquer número de presentes, nos termos do artigo 1432.º do Código Civil.');
    },
    T.COR_ALERTA
  );

  L.caixa(
    'Representação (procuração)',
    (C) => {
      C.texto('Os condóminos podem fazer-se representar por procuração escrita, dirigida ao presidente da mesa da assembleia, nos termos legais.');
    },
    T.COR_PRIMARIA
  );

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ═══════════════════════════════════════════════════════════════════
// ATA
// ═══════════════════════════════════════════════════════════════════
async function gerarAtaPDF(condominio, d) {
  const doc = criarDocumento();
  const L = new Layout(doc, condominio, 'ATA');

  L.caixa('Identificação', (C) => {
    C.linha('Data', formatDate(d.data));
    C.linha('Hora', d.hora || '—');
    C.linha('Local', d.local || '—');
    C.linha('Presentes / permilagem', d.presentes || '—');
  });

  if (d.ordemTrabalhos && d.ordemTrabalhos.length) {
    L.caixa(
      'Ordem de trabalhos',
      (C) => {
        let n = 1;
        for (const ponto of d.ordemTrabalhos) {
          C.texto(`${n}. ${ponto}`);
          n++;
        }
      },
      T.COR_SUCESSO
    );
  }

  // Deliberações em texto livre (flui por várias páginas sem cortar)
  L.texto('Deliberações', { bold: true, fontSize: 11, cor: T.COR_ALERTA });
  L.espaco(2);
  L.texto(d.ataTexto || '(sem conteúdo registado)');

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

module.exports = { gerarAvisoQuotaPDF, gerarReciboPDF, gerarConvocatoriaPDF, gerarAtaPDF };
