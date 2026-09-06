const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatEUR } = require('./money');
const { formatDate, formatDateExtenso } = require('./dates');
const { gerarConvocatoriaCartaPDF } = require('./pdf-convocatoria');

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

// Margens do documento: superior/laterais 50 e fundo 36 — reserva explícita do
// rodapé (a 782-792pt) sem nunca ultrapassar a área útil da página A4, o que
// evita que o PDFKit crie páginas extra por overflow do próprio rodapé.
const MARGEM_INFERIOR = 36;

function criarDocumento() {
  return new PDFDocument({
    size: 'A4',
    // PDFKit espera um número em "margin" ou um objeto em "margins"; o fundo
    // (36) reserva explicitamente o espaço do rodapé (782–792pt) sem nunca
    // ultrapassar a área útil — impede páginas extra por overflow do rodapé.
    margins: { top: T.MARGEM, right: T.MARGEM, bottom: MARGEM_INFERIOR, left: T.MARGEM },
    bufferPages: true,
    info: { Title: 'GesCondu', Author: 'GesCondu' },
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
  constructor(doc, condominio, titulo, cabecalhoDireita = null) {
    this.doc = doc;
    this.condominio = condominio || {};
    this.titulo = titulo;
    // Coluna direita opcional do cabeçalho: [{texto, tamanho, negrito, cor}]
    this.cabecalhoDireita = cabecalhoDireita;
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

    const designacao = this.condominio.designacao || 'Condomínio';
    const morada = [
      this.condominio.morada,
      [this.condominio.codigo_postal, this.condominio.localidade].filter(Boolean).join(' '),
    ]
      .filter(Boolean)
      .join(', ');
    const nifTexto = this.condominio.nif ? `NIF: ${this.condominio.nif}` : '';

    // ── Modo simples (documentos sem coluna direita) ──────────────────
    if (!this.cabecalhoDireita || !this.cabecalhoDireita.length) {
      this.doc.font(T.FONTE_BOLD).fontSize(15).fillColor(T.COR_TEXTO).text(designacao, xTexto, 42, { width: 250, lineBreak: false });
      if (morada) this.doc.font(T.FONTE).fontSize(T.TEXTO_SIZE_SMALL).fillColor(T.COR_MUTED).text(morada, xTexto, 62, { width: 250 });
      if (nifTexto) this.doc.font(T.FONTE).fontSize(T.TEXTO_SIZE_SMALL).fillColor(T.COR_MUTED).text(nifTexto, xTexto, 74, { width: 250 });
      this.doc.font(T.FONTE_BOLD).fontSize(T.TITULO_DOC_SIZE).fillColor(T.COR_TEXTO).text(this.titulo, 300, 45, { width: 245, align: 'right' });
      this.doc.moveTo(T.MARGEM, 96).lineTo(T.MARGEM + T.LARGURA_CONTEUDO, 96).lineWidth(1.2).strokeColor(T.COR_PRIMARIA).stroke();
      this.y = 108;
      return;
    }

    // ── Cabeçalho em duas colunas robustas (recibo/aviso com coluna direita) ──
    const rightX = 300;
    const rightW = T.LARGURA_PAGINA - T.MARGEM - rightX; // 245
    const leftW = Math.max(110, rightX - xTexto - 16);

    // Largura real do nome em cada tamanho: o PDFKit ignora "fontSize" nas
    // opções de medição — é preciso definir o tamanho no documento primeiro.
    const larguraNomeEm = (tamanho) => {
      this.doc.font(T.FONTE_BOLD).fontSize(tamanho);
      return this.doc.widthOfString(designacao);
    };
    // Nome do condomínio SEMPRE numa única linha e completo: começa no tamanho
    // normal (15) e reduz progressivamente (mínimo legível 6) até caber na
    // largura reservada à coluna esquerda (a direita nunca é invadida).
    let nomeSize = 15;
    while (nomeSize >= 6 && larguraNomeEm(nomeSize) > leftW) {
      nomeSize -= 1;
    }

    const alturaDe = (texto, tamanho, bold, width) => {
      const f = bold ? T.FONTE_BOLD : T.FONTE;
      this.doc.font(f).fontSize(tamanho);
      return this.doc.heightOfString(String(texto ?? ''), { width }) + 3;
    };

    const esq = [{ texto: designacao, tamanho: nomeSize, bold: true, cor: T.COR_TEXTO, semQuebra: true }];
    if (morada) esq.push({ texto: morada, tamanho: T.TEXTO_SIZE_SMALL, bold: false, cor: T.COR_MUTED });
    if (nifTexto) esq.push({ texto: nifTexto, tamanho: T.TEXTO_SIZE_SMALL, bold: false, cor: T.COR_MUTED });

    const dir = this.cabecalhoDireita.map((l) => ({
      texto: l.texto,
      tamanho: l.tamanho || (l.negrito ? 13 : T.TEXTO_SIZE_SMALL),
      bold: l.negrito === true,
      cor: l.cor || T.COR_MUTED,
    }));

    const leftTotal = esq.reduce((s, l) => s + alturaDe(l.texto, l.tamanho, l.bold, leftW), 0);
    const rightTotal = dir.reduce((s, l) => s + alturaDe(l.texto, l.tamanho, l.bold, rightW), 0);
    const startTop = 34;
    const centro = Math.max(leftTotal, rightTotal);

    // Desenha colunas; a mais pequena fica centrada verticalmente na mais alta.
    let yEsq = startTop;
    for (const l of esq) {
      if (!this.medindo) {
        const opts = { width: leftW, lineGap: 1 };
        if (l.semQuebra) opts.lineBreak = false; // o nome nunca quebra
        this.doc
          .font(l.bold ? T.FONTE_BOLD : T.FONTE)
          .fontSize(l.tamanho)
          .fillColor(l.cor)
          .text(l.texto, xTexto, yEsq, opts);
      }
      yEsq += alturaDe(l.texto, l.tamanho, l.bold, leftW);
    }
    let yDir = startTop + Math.max(0, (leftTotal - rightTotal) / 2);
    for (const l of dir) {
      if (!this.medindo) {
        this.doc
          .font(l.bold ? T.FONTE_BOLD : T.FONTE)
          .fontSize(l.tamanho)
          .fillColor(l.cor)
          .text(l.texto, rightX, yDir, { width: rightW, align: 'right', lineBreak: false, lineGap: 1 });
      }
      yDir += alturaDe(l.texto, l.tamanho, l.bold, rightW);
    }

    const ruleY = startTop + centro + 6;
    this.doc.moveTo(T.MARGEM, ruleY).lineTo(T.MARGEM + T.LARGURA_CONTEUDO, ruleY).lineWidth(1.2).strokeColor(T.COR_PRIMARIA).stroke();
    this.y = ruleY + 9;
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

  caixa(titulo, corpo, cor = T.COR_PRIMARIA, fundo = T.COR_FUNDO_CAIXA, opts = {}) {
    // Espaçamento entre blocos (secções visualmente independentes).
    const gapBloco = 7;
    const hideTitle = opts.hideTitle === true;
    const tituloFontSize = opts.tituloFontSize || T.TITULO_CAIXA_SIZE;
    const tituloBloco = hideTitle ? 0 : tituloFontSize + 6;
    if (!this.medindo) this.y += gapBloco;
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

    const alturaTotal = T.PADDING + tituloBloco + alturaCorpo + T.PADDING;
    this.garantirEspaco(alturaTotal);

    // Fundo suave arredondado SEM border/linhas delimitadoras.
    this.doc.roundedRect(T.MARGEM, this.y, T.LARGURA_CONTEUDO, alturaTotal, 8).fill(fundo);
    this.y += T.PADDING;
    if (!hideTitle) {
      this.doc
        .font(T.FONTE_BOLD)
        .fontSize(tituloFontSize)
        .fillColor(cor)
        .text(titulo, T.MARGEM + T.PADDING, this.y, { width: T.LARGURA_CONTEUDO - 2 * T.PADDING });
      this.y += tituloBloco;
    }

    corpo(this);

    this.y += T.PADDING + gapBloco;
    this.cx = prevCx;
    this.cw = prevCw;
  }
}

// ── Rodapé + paginação ─────────────────────────────────────────────
function finalizarPaginacao(doc) {
  const range = doc.bufferedPageRange();
  const largura = T.LARGURA_CONTEUDO;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Rodapé com uma ÚNICA linha: documento à esquerda, página à direita.
    doc.font(T.FONTE).fontSize(7).fillColor('#777777').text('Documento processado por GesCondu - Gestão de Condomínios', T.MARGEM, 786, { width: 400, align: 'left', lineBreak: false });
    doc.font(T.FONTE).fontSize(7).fillColor('#777777').text(`Página ${i + 1} de ${range.count}`, 455, 786, { width: 90, align: 'right', lineBreak: false });
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

// ── Marca de recibo anulado (faixa diagonal discreta, não destrói o original) ──
function marcarAnulado(doc) {
  doc.save();
  doc.opacity(0.16);
  doc.font(T.FONTE_BOLD).fontSize(72).fillColor('#b91c1c');
  const cx = T.LARGURA_PAGINA / 2;
  const cy = 425;
  doc.translate(cx, cy);
  doc.rotate(38);
  doc.text('ANULADO', -180, -50, { width: 360, align: 'center' });
  doc.rotate(-38);
  doc.translate(-cx, -cy);
  doc.restore();
}

// ═══════════════════════════════════════════════════════════════════
// RECIBO
// ═══════════════════════════════════════════════════════════════════
async function gerarReciboPDF(condominio, d) {
  const doc = criarDocumento();
  const L = new Layout(doc, condominio, 'RECIBO', [
    { texto: d.numero ? `Recibo n.º ${d.numero}` : 'Recibo', tamanho: 13, negrito: true, cor: T.COR_TEXTO },
    { texto: `Código de verificação: ${d.codigoVerificacao || '—'}`, tamanho: T.TEXTO_SIZE_SMALL, negrito: false, cor: T.COR_MUTED },
    { texto: `Emitido em ${d.data ? formatDateExtenso(d.data) : '—'}`, tamanho: T.TEXTO_SIZE_SMALL, negrito: false, cor: T.COR_MUTED },
  ]);

  // ── Zona do destinatário (documento/ofício) ─────────────────────────
  if (d.destinatario) {
    const linhas = [];
    const dest = d.destinatario;
    linhas.push({ t: 'Exmo(a) Sr.(a)', bold: false });
    if (dest.nome) linhas.push({ t: dest.nome, bold: true });
    if (dest.fracao) linhas.push({ t: dest.fracao, bold: false });
    if (dest.morada) linhas.push({ t: dest.morada, bold: false });
    if (dest.codigoPostalLocalidade) linhas.push({ t: dest.codigoPostalLocalidade, bold: false });
    L.caixa(
      '',
      (C) => {
        linhas.forEach((l) => {
          if (!C.medindo) {
            C.doc
              .font(l.bold ? T.FONTE_BOLD : T.FONTE)
              .fontSize(l.bold ? T.TEXTO_SIZE + 1 : T.TEXTO_SIZE)
              .fillColor(l.bold ? T.COR_TEXTO : '#334155')
              .text(l.t, C.cx, C.y, { width: C.cw, lineGap: 1 });
          }
          C.y += l.bold ? 15 : 13;
        });
      },
      '#334155',
      '#eef6f2',
      { hideTitle: true }
    );
  }

  // ── Bloco 1 — Dados do pagamento (método/data/referência vêm do pagamento) ──
  // Para o módulo de recibos vêm de pagamentosDasQuotas(); para chamadas
  // legadas (pagamento individual) sintetiza-se a partir dos campos antigos.
  const pagamentos = (d.pagamentos && d.pagamentos.length)
    ? d.pagamentos
    : (d.dataPagamento || d.metodoPagamento || d.referencia)
      ? [{ data_pagamento: d.dataPagamento, metodo: d.metodoPagamento || '—', referencia: d.referencia || '', valor: d.valor }]
      : [];
  const umPagamento = pagamentos.length === 1 ? pagamentos[0] : null;
  L.caixa(
    'Dados do pagamento',
    (C) => {
      // O condómino fica identificado na zona do destinatário (quando existe);
      // nas chamadas legadas sem destinatário mantém-se a linha aqui.
      if (!d.destinatario) C.linha('Condómino', d.condominoNome || '—');
      const fracaoTexto = d.fracaoPermilagem
        ? `${d.fracaoDesignacao || '—'} — ${d.fracaoPermilagem}`
        : d.fracaoDesignacao || '—';
      C.linha('Fração', fracaoTexto);
      if (umPagamento) {
        C.linha('Data do pagamento', umPagamento.data_pagamento ? formatDate(umPagamento.data_pagamento) : '—');
        C.linha('Método de pagamento', umPagamento.metodo || '—');
        C.linha('Referência', umPagamento.referencia || '—');
      } else if (pagamentos.length > 1) {
        C.linha('Pagamentos contribuintes', `${pagamentos.length} pagamentos (ver abaixo)`);
      }
    },
    '#1d4ed8',
    '#eef2fb'
  );

  // Bloco extra (apenas quando vários pagamentos contribuem para o recibo).
  if (pagamentos.length > 1) {
    L.caixa(
      'Pagamentos que cobrem este recibo',
      (C) => {
        C.tabela(
          [
            { titulo: 'Data', x: 0, width: 90 },
            { titulo: 'Método', x: 100, width: 115 },
            { titulo: 'Referência', x: 225, width: 130 },
            { titulo: 'Valor aplicado', x: 360, width: 95, align: 'right' },
          ],
          pagamentos.map((p) => [
            p.data_pagamento ? formatDate(p.data_pagamento) : '—',
            p.metodo || '—',
            p.referencia || '—',
            formatEUR(p.valor),
          ])
        );
      },
      '#1d4ed8',
      '#eef2fb'
    );
  }

  // ── Bloco 2 — Distribuição pelas quotas ──────────────────────────────
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
      T.COR_SUCESSO,
      T.COR_FUNDO_VERDE
    );
  }

  // ── Bloco 3 — VALOR DO RECIBO (título e valor NA MESMA LINHA) ─────
  L.caixa(
    '',
    (C) => {
      const topo = C.y;
      const valorY = topo;
      const tituloY = topo + 8; // bases alinhadas (título maior com 20pt)
      if (!C.medindo) {
        // Valor à direita, título à esquerda, mesma linha — valor é o destaque.
        C.doc
          .font(T.FONTE_BOLD)
          .fontSize(30)
          .fillColor('#14532d')
          .text(formatEUR(d.valor), C.cx, valorY, { width: C.cw, align: 'right', lineGap: 0 });
        C.doc
          .font(T.FONTE_BOLD)
          .fontSize(20)
          .fillColor('#14532d')
          .text('VALOR DO RECIBO', C.cx, tituloY, { width: C.cw - 100, align: 'left', lineGap: 0 });
      }
      const saldoY = topo + 40;
      if (!C.medindo) {
        C.doc
          .font(T.FONTE)
          .fontSize(T.TEXTO_SIZE_SMALL)
          .fillColor(T.COR_VERDE)
          .text(`Saldo devedor vencido em ${d.data ? formatDate(d.data) : '—'}: ${formatEUR(d.saldoAposPagamento)}`, C.cx, saldoY, { width: C.cw, align: 'right' });
      }
      C.y = saldoY + 14;
    },
    T.COR_VERDE,
    T.COR_FUNDO_VERDE,
    { hideTitle: true }
  );

  // Recibos anulados mantêm todo o conteúdo histórico, mas ficam marcados de
  // forma inequívoca (faixa "ANULADO") sem poderem ser confundidos com válidos.
  if (d.anulado) marcarAnulado(doc);

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ═══════════════════════════════════════════════════════════════════
// CONVOCATÓRIA — carta oficial A4 de página única
// (composição e adaptação automática em helpers/pdf-convocatoria.js)
// ═══════════════════════════════════════════════════════════════════
async function gerarConvocatoriaPDF(condominio, d) {
  const tipoLabel = String(d.tipo || 'Ordinária').replace(/^Assembleia Geral\s*/i, '');
  const tipo =
    tipoLabel === 'Extraordinária' || tipoLabel === 'Urgência' ? 'extraordinaria' : 'ordinaria';
  return gerarConvocatoriaCartaPDF(condominio || {}, {
    numero: d.numero,
    tipo,
    data: d.data,
    dataEmissao: d.dataEmissao || new Date(),
    hora: d.hora,
    horaSegunda: d.horaSegunda,
    local: d.local,
    emailAutorizado: d.emailAutorizado,
    ordemTrabalhos: d.ordemTrabalhos,
  });
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
