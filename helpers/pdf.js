const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatEUR } = require('./money');
const { formatDate, formatDateExtenso } = require('./dates');
const { gerarConvocatoriaCartaPDF } = require('./pdf-convocatoria');

// ── Paleta GesCondu para documentos impressos ──────────────────────
// Os documentos são SEMPRE claros e profissionais (independentes do tema
// claro/escuro da aplicação): nada aqui é lido das variáveis CSS da web.
const P = {
  MARINHO: '#06213F', // títulos e cabeçalhos institucionais
  MARINHO_2: '#0B2E56', // cabeçalho de tabelas
  AZUL: '#075B9B', // acentos, linhas e colunas de destaque
  AZUL_APOIO: '#087FC2',
  CIANO: '#00D0F8',
  VERDE: '#20C83F',
  FUNDO: '#F5F9FC', // fundo muito claro (blocos)
  SUPERFICIE: '#FFFFFF', // página e cartões (branco)
  ZEBRA: '#F7FAFC', // linhas alternadas
  BORDA: '#D7E4ED',
  BORDA_FORTE: '#B9CEDD',
  TINTA: '#102B46', // texto principal
  TINTA_2: '#567086', // texto secundário
  TINTA_3: '#7B91A2', // texto subtil
  ERRO: '#D8475C',
  AVISO: '#D98A16',
  // tons de TEXTO com contraste AA sobre branco (iguais aos da web app)
  TINTA_SUCESSO: '#0F7A2C',
  TINTA_ERRO: '#B03146',
  TINTA_AVISO: '#9A6108',
  FUNDO_SUCESSO: '#E9FBEA',
  FUNDO_AVISO: '#FFF5DF',
  FUNDO_ERRO: '#FDECEF',
  FUNDO_AZUL: '#E4F3FB',
};

// ── Constantes de layout (sem números mágicos espalhados) ──────────
const T = {
  ...P,
  MARGEM: 50,
  LARGURA_PAGINA: 595.28,
  ALTURA_PAGINA: 841.89,
  LARGURA_CONTEUDO: 495, // LARGURA_PAGINA - 2*MARGEM
  PADDING: 12, // margem interna das caixas
  LIMITE_INFERIOR: 778, // onde começa o rodapé
  TEXTO_SIZE: 10,
  TEXTO_SIZE_SMALL: 8.8,
  TEXTO_SIZE_LABEL: 8.2,
  TITULO_DOC_SIZE: 18,
  TITULO_CAIXA_SIZE: 10.2,
  TITULO_SECCAO_SIZE: 10.6,
  TOTAL_SIZE: 24,
  FONTE: 'Helvetica',
  FONTE_BOLD: 'Helvetica-Bold',
  // aliases históricos usados pelos restantes documentos (aviso, ata)
  COR_PRIMARIA: P.AZUL,
  COR_TEXTO: P.TINTA,
  COR_MUTED: P.TINTA_2,
  COR_SUCESSO: P.TINTA_SUCESSO,
  COR_ALERTA: P.TINTA_AVISO,
  COR_VERDE: P.TINTA_SUCESSO,
  COR_FUNDO_CAIXA: P.FUNDO,
  COR_FUNDO_VERDE: P.FUNDO_SUCESSO,
  COR_FUNDO_AVISO: P.FUNDO_AVISO,
  COR_FUNDO_ERRO: P.FUNDO_ERRO,
  COR_FUNDO_AZUL: P.FUNDO_AZUL,
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
    this.paginas = 0; // nº de quebras de página (repetição de cabeçalhos)
    this.cx = T.MARGEM; // x do conteúdo (recuado dentro de caixas)
    this.cw = T.LARGURA_CONTEUDO; // largura do conteúdo
    this.desenharCabecalho();
  }

  desenharCabecalho() {
    // A página é SEMPRE branca: os documentos não seguem o tema escuro da
    // aplicação (e ficam corretos em visualizadores com tema escuro).
    if (!this.medindo) {
      this.doc.rect(0, 0, T.LARGURA_PAGINA, T.ALTURA_PAGINA).fill(T.SUPERFICIE);
    }
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
      this.doc.font(T.FONTE_BOLD).fontSize(T.TITULO_DOC_SIZE).fillColor(T.MARINHO).text(this.titulo, 300, 45, { width: 245, align: 'right' });
      // detalhe institucional discreto (azul de interface)
      this.doc.moveTo(T.MARGEM, 96).lineTo(T.MARGEM + T.LARGURA_CONTEUDO, 96).lineWidth(1).strokeColor(T.AZUL).stroke();
      this.doc.moveTo(T.MARGEM, 96).lineTo(T.MARGEM + 74, 96).lineWidth(2.4).strokeColor(T.MARINHO).stroke();
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
    this.doc.moveTo(T.MARGEM, ruleY).lineTo(T.MARGEM + T.LARGURA_CONTEUDO, ruleY).lineWidth(1).strokeColor(T.AZUL).stroke();
    this.doc.moveTo(T.MARGEM, ruleY).lineTo(T.MARGEM + 74, ruleY).lineWidth(2.4).strokeColor(T.MARINHO).stroke();
    this.y = ruleY + 9;
  }

  garantirEspaco(altura) {
    if (this.medindo) return;
    if (this.y + altura > T.LIMITE_INFERIOR) {
      this.doc.addPage();
      this.paginas += 1;
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

  // Compatibilidade: as tabelas de todos os documentos usam o desenho novo.
  tabela(colunas, linhas) {
    this.tabelaDados(colunas, linhas);
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

  // ── Cartão claro com borda subtil (destinatário, resumos) ──────────
  cartao(titulo, corpo, opts = {}) {
    const gap = opts.gap === undefined ? 10 : opts.gap;
    const hideTitle = opts.hideTitle === true;
    const tituloBloco = hideTitle ? 0 : T.TITULO_CAIXA_SIZE + 7;
    if (!this.medindo) this.y += gap;
    const yInicio = this.y;
    const prevCx = this.cx;
    const prevCw = this.cw;
    this.cx = T.MARGEM + T.PADDING;
    this.cw = T.LARGURA_CONTEUDO - 2 * T.PADDING;

    this.medindo = true;
    const yMedida = this.y;
    corpo(this);
    const alturaCorpo = this.y - yMedida;
    this.medindo = false;
    this.y = yInicio;

    const alturaTotal = T.PADDING + tituloBloco + alturaCorpo + T.PADDING;
    this.garantirEspaco(alturaTotal);
    const topo = this.y;
    if (!this.medindo) {
      this.doc.lineWidth(0.8)
        .roundedRect(T.MARGEM, topo, T.LARGURA_CONTEUDO, alturaTotal, 6)
        .fillAndStroke(T.SUPERFICIE, T.BORDA);
    }
    this.y = topo + T.PADDING;
    if (!hideTitle) {
      if (!this.medindo) {
        this.doc.font(T.FONTE_BOLD).fontSize(T.TITULO_CAIXA_SIZE).fillColor(T.MARINHO)
          .text(titulo, this.cx, this.y, { width: this.cw, characterSpacing: 0.4 });
      }
      this.y += tituloBloco;
    }
    corpo(this);
    this.y = topo + alturaTotal + gap;
    this.cx = prevCx;
    this.cw = prevCw;
  }

  // ── Grelha de duas colunas: rótulo secundário + valor (à direita) ──
  grelha(pares, opts = {}) {
    const larguraRotulo = opts.larguraRotulo || 170;
    const gap = 16;
    const larguraValor = Math.max(80, this.cw - larguraRotulo - gap);
    for (const par of pares) {
      const rotulo = par[0];
      const valor = String(par[1] === null || par[1] === undefined || par[1] === '' ? '—' : par[1]);
      const fonte = par[2] || {};
      this.doc.font(T.FONTE).fontSize(T.TEXTO_SIZE);
      const hRot = this.doc.heightOfString(String(rotulo ?? ''), { width: larguraRotulo });
      this.doc.font(T.FONTE_BOLD).fontSize(T.TEXTO_SIZE);
      const hVal = this.doc.heightOfString(valor, { width: larguraValor });
      const h = Math.max(hRot, hVal) + 5;
      this.garantirEspaco(h);
      if (!this.medindo) {
        this.doc.font(T.FONTE).fontSize(T.TEXTO_SIZE).fillColor(T.TINTA_2)
          .text(String(rotulo ?? ''), this.cx, this.y, { width: larguraRotulo, lineGap: 1 });
        this.doc.font(T.FONTE_BOLD).fontSize(T.TEXTO_SIZE).fillColor(fonte.cor || T.TINTA)
          .text(valor, this.cx + larguraRotulo + gap, this.y, { width: larguraValor, align: 'right', lineGap: 1 });
      }
      this.y += h;
    }
  }

  // ── Título de secção (azul-marinho) com separador discreto ─────────
  seccao(titulo) {
    const altura = T.TITULO_SECCAO_SIZE + 15;
    // Nunca deixa o título isolado no fim da página.
    this.garantirEspaco(altura + 30);
    if (!this.medindo) {
      this.doc.font(T.FONTE_BOLD).fontSize(T.TITULO_SECCAO_SIZE).fillColor(T.MARINHO)
        .text(titulo, this.cx, this.y, { width: this.cw, characterSpacing: 0.6 });
      const ly = this.y + T.TITULO_SECCAO_SIZE + 5;
      this.doc.moveTo(this.cx, ly).lineTo(this.cx + this.cw, ly).lineWidth(0.6).strokeColor(T.BORDA).stroke();
    }
    this.y += altura;
  }

  // ── Tabela: cabeçalho azul-marinho, linhas zebra, quebras controladas ──
  tabelaDados(colunas, linhas, opts = {}) {
    const fontSize = T.TEXTO_SIZE_SMALL;
    const alturaCabecalho = 18;
    const zebra = opts.zebra !== false;
    const alturaLinha = (linha) => Math.max(...linha.map((cell, i) =>
      this.doc.font(T.FONTE).fontSize(fontSize).heightOfString(String(cell ?? ''), { width: colunas[i].width }) + 8));

    const desenharCabecalho = () => {
      if (!this.medindo) {
        this.doc.rect(T.MARGEM, this.y, T.LARGURA_CONTEUDO, alturaCabecalho).fill(T.MARINHO_2);
        this.doc.font(T.FONTE_BOLD).fontSize(T.TEXTO_SIZE_LABEL).fillColor('#FFFFFF');
        colunas.forEach((c) => this.doc.text(String(c.titulo).toUpperCase(), T.MARGEM + T.PADDING + c.x, this.y + 6, {
          width: c.width, align: c.align || 'left', lineBreak: false, characterSpacing: 0.4,
        }));
      }
      this.y += alturaCabecalho;
    };

    // Cabeçalho + 1.ª linha sempre juntos (nada de cabeçalho órfão).
    this.garantirEspaco(alturaCabecalho + (linhas.length ? alturaLinha(linhas[0]) : 12));
    desenharCabecalho();

    linhas.forEach((linha, idx) => {
      const h = alturaLinha(linha);
      const antes = this.paginas;
      this.garantirEspaco(h);
      if (this.paginas !== antes) desenharCabecalho(); // repete o cabeçalho na página nova
      if (!this.medindo) {
        if (zebra && idx % 2 === 1) this.doc.rect(T.MARGEM, this.y, T.LARGURA_CONTEUDO, h).fill(T.ZEBRA);
        this.doc.font(T.FONTE).fontSize(fontSize).fillColor(T.TINTA);
        linha.forEach((cell, i) => this.doc.text(String(cell ?? ''), T.MARGEM + T.PADDING + colunas[i].x, this.y + 4, {
          width: colunas[i].width, align: colunas[i].align || 'left', lineGap: 1,
        }));
        const ly = this.y + h - 0.4;
        this.doc.moveTo(T.MARGEM, ly).lineTo(T.MARGEM + T.LARGURA_CONTEUDO, ly).lineWidth(0.4).strokeColor(T.BORDA).stroke();
      }
      this.y += h;
    });
    this.y += 8;
  }

  // ── Total: elemento financeiro mais visível da página ──────────────
  blocoTotal(rotulo, valor) {
    const altura = 54;
    this.garantirEspaco(altura + 16);
    const topo = this.y + 10;
    if (!this.medindo) {
      this.doc.lineWidth(0.8)
        .roundedRect(T.MARGEM, topo, T.LARGURA_CONTEUDO, altura, 6)
        .fillAndStroke(T.FUNDO, T.BORDA);
      this.doc.rect(T.MARGEM, topo, 3, altura).fill(T.MARINHO);
      this.doc.font(T.FONTE_BOLD).fontSize(10.5).fillColor(T.MARINHO)
        .text(rotulo, T.MARGEM + T.PADDING + 4, topo + 21, { width: 230, characterSpacing: 1.1 });
      this.doc.font(T.FONTE_BOLD).fontSize(T.TOTAL_SIZE).fillColor(T.MARINHO)
        .text(formatEUR(valor), T.MARGEM + 250, topo + 13, { width: T.LARGURA_CONTEUDO - 250 - T.PADDING, align: 'right' });
    }
    this.y = topo + altura + 6;
  }

  // ── Saldo: rótulo semântico (nunca depende só da cor) ──────────────
  blocoSaldo(saldo, dataRef) {
    const valor = Number(saldo) || 0;
    const emDivida = valor > 0.004;
    const credor = valor < -0.004;
    const rotulo = emDivida ? 'Saldo devedor' : credor ? 'Saldo credor' : 'Saldo regularizado';
    const nota = emDivida
      ? 'Valor em dívida' + (dataRef ? ' à data de ' + formatDate(dataRef) : '')
      : credor
        ? 'Crédito a favor da fração'
        : 'Sem valores em dívida à data';
    const cor = emDivida ? T.TINTA_ERRO : credor ? T.TINTA_SUCESSO : T.TINTA_2;
    const altura = 30;
    this.garantirEspaco(altura);
    if (!this.medindo) {
      this.doc.circle(T.MARGEM + 6, this.y + 8, 2.6).fill(cor);
      this.doc.font(T.FONTE_BOLD).fontSize(T.TEXTO_SIZE).fillColor(cor)
        .text(rotulo, T.MARGEM + 16, this.y + 2, { width: 260, lineBreak: false });
      this.doc.font(T.FONTE).fontSize(T.TEXTO_SIZE_SMALL).fillColor(T.TINTA_2)
        .text(nota, T.MARGEM + 16, this.y + 15, { width: 300, lineBreak: false });
      this.doc.font(T.FONTE_BOLD).fontSize(T.TEXTO_SIZE).fillColor(T.TINTA)
        .text(formatEUR(Math.abs(valor)), T.MARGEM, this.y + 2, { width: T.LARGURA_CONTEUDO, align: 'right', lineBreak: false });
    }
    this.y += altura;
  }
}

// ── Rodapé + paginação ─────────────────────────────────────────────
function finalizarPaginacao(doc) {
  const range = doc.bufferedPageRange();
  const largura = T.LARGURA_CONTEUDO;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Rodapé com uma ÚNICA linha: documento à esquerda, página à direita.
    // Rodapé discreto: a GesCondu é a plataforma, não a entidade emitente.
    doc.moveTo(T.MARGEM, 782).lineTo(T.MARGEM + largura, 782).lineWidth(0.4).strokeColor(T.BORDA).stroke();
    doc.font(T.FONTE).fontSize(7.2).fillColor(T.TINTA_3).text('Documento processado através da plataforma GesCondu', T.MARGEM, 786, { width: 400, align: 'left', lineBreak: false });
    doc.font(T.FONTE).fontSize(7.2).fillColor(T.TINTA_3).text(`Página ${i + 1} de ${range.count}`, 455, 786, { width: 90, align: 'right', lineBreak: false });
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

  // Quotas extraordinárias incluídas neste aviso (linhas discriminadas).
  if (d.extras && d.extras.length) {
    L.caixa(
      'Quotas extraordinárias incluídas',
      (C) => {
        C.tabela(
          [
            { titulo: 'Designação', x: 0, width: 190 },
            { titulo: 'Parcela', x: 200, width: 150 },
            { titulo: 'Valor', x: 360, width: 100, align: 'right' },
          ],
          d.extras.map((e) => [e.designacao || 'Quota extraordinária', e.detalhe || '—', formatEUR(e.valorAplicado)])
        );
      },
      T.COR_ALERTA,
      T.COR_FUNDO_AVISO
    );
  }

  L.caixa(
    'Situação financeira',
    (C) => {
      C.linha('Saldo anterior', formatEUR(d.saldoAnterior), { cor: T.COR_SUCESSO });
      const ult = d.ultimoPagamento
        ? `${formatEUR(d.ultimoPagamentoValor)} — ${formatDate(d.ultimoPagamentoData)}`
        : '—';
      C.linha('Último pagamento', ult, { cor: T.COR_SUCESSO });
      C.linha('Em dívida (antes desta quota)', formatEUR(d.emDivida), { cor: Number(d.emDivida) > 0 ? T.TINTA_ERRO : T.TINTA_2 });
      C.linha('Quota atual', formatEUR(d.valor), { cor: T.TINTA });
      C.linha('Total a pagar', formatEUR(d.totalAPagar), { cor: T.MARINHO });
    },
    T.MARINHO
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
    T.MARINHO
  );

  finalizarPaginacao(doc, condominio);
  return toBuffer(doc);
}

// ── Marca de recibo anulado (faixa diagonal discreta, não destrói o original) ──
function marcarAnulado(doc) {
  doc.save();
  doc.opacity(0.16);
  doc.font(T.FONTE_BOLD).fontSize(72).fillColor(T.TINTA_ERRO);
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
  // Cabeçalho institucional: o documento é do CONDOMÍNIO (logótipo próprio, se
  // configurado); o número do recibo, o código de verificação e a data ficam na
  // coluna direita, bem visíveis.
  const L = new Layout(doc, condominio, 'RECIBO', [
    { texto: d.numero ? `Recibo n.º ${d.numero}` : 'Recibo', tamanho: 13, negrito: true, cor: T.MARINHO },
    { texto: `Código de verificação: ${d.codigoVerificacao || '—'}`, tamanho: T.TEXTO_SIZE_SMALL, negrito: false, cor: T.TINTA_2 },
    { texto: `Emitido em ${d.data ? formatDateExtenso(d.data) : '—'}`, tamanho: T.TEXTO_SIZE_SMALL, negrito: false, cor: T.TINTA_2 },
  ]);

  // ── 1. Destinatário (cartão claro com borda subtil) ────────────────
  const dest = (d.destinatario && Object.keys(d.destinatario).length)
    ? d.destinatario
    : { nome: d.condominoNome || null, fracao: d.fracaoDesignacao || null, morada: null, codigoPostalLocalidade: null };

  L.cartao('Destinatário', (C) => {
    C.texto('Exmo(a) Sr.(a)', { fontSize: T.TEXTO_SIZE_SMALL, cor: T.TINTA_2 });
    C.texto(dest.nome || '—', { bold: true, fontSize: 11.5 });
    const linhas = [];
    if (dest.fracao) linhas.push(`Fração: ${dest.fracao}`);
    if (dest.morada) linhas.push(dest.morada);
    if (dest.codigoPostalLocalidade) linhas.push(dest.codigoPostalLocalidade);
    linhas.forEach((t) => C.texto(t, { fontSize: T.TEXTO_SIZE_SMALL, cor: T.TINTA_2 }));
  });

  // ── 2. Resumo do pagamento (grelha de duas colunas) ────────────────
  // Método/data/referência vêm dos PAGAMENTOS confirmados que cobrem as quotas;
  // nas chamadas legadas sem lista sintetiza-se a partir dos campos antigos.
  const pagamentos = (d.pagamentos && d.pagamentos.length)
    ? d.pagamentos
    : (d.dataPagamento || d.metodoPagamento || d.referencia)
      ? [{ data_pagamento: d.dataPagamento, metodo: d.metodoPagamento || '—', referencia: d.referencia || '', valor: d.valor }]
      : [];
  const umPagamento = pagamentos.length === 1 ? pagamentos[0] : null;
  const fracaoTexto = d.fracaoPermilagem
    ? `${d.fracaoDesignacao || '—'} — ${d.fracaoPermilagem}`
    : d.fracaoDesignacao || '—';

  const resumo = [['Fração', fracaoTexto]];
  if (umPagamento) {
    resumo.push(['Data do pagamento', umPagamento.data_pagamento ? formatDate(umPagamento.data_pagamento) : '—']);
    resumo.push(['Método de pagamento', umPagamento.metodo || '—']);
    resumo.push(['Referência', umPagamento.referencia || '—']);
  } else if (pagamentos.length > 1) {
    resumo.push(['Pagamentos contribuintes', `${pagamentos.length} pagamentos (detalhe abaixo)`]);
  }
  L.cartao('Resumo do pagamento', (C) => C.grelha(resumo));

  // ── 3. Pagamentos que cobrem o recibo (apenas quando há vários) ────
  if (pagamentos.length > 1) {
    L.seccao('Pagamentos que cobrem este recibo');
    L.tabelaDados(
      [
        { titulo: 'Data', x: 0, width: 95 },
        { titulo: 'Método', x: 105, width: 120 },
        { titulo: 'Referência', x: 235, width: 150 },
        { titulo: 'Valor aplicado', x: 395, width: 78, align: 'right' },
      ],
      pagamentos.map((pg) => [
        pg.data_pagamento ? formatDate(pg.data_pagamento) : '—',
        pg.metodo || '—',
        pg.referencia || '—',
        formatEUR(pg.valor),
      ])
    );
  }

  // ── 4. Distribuição pelas quotas ───────────────────────────────────
  if (d.quotas && d.quotas.length) {
    L.seccao('Distribuição pelas quotas');
    L.tabelaDados(
      [
        { titulo: 'Quota', x: 0, width: 140 },
        { titulo: 'Período', x: 150, width: 215 },
        { titulo: 'Valor aplicado', x: 375, width: 98, align: 'right' },
      ],
      d.quotas.map((q) => [q.numero || '—', q.periodo || '—', formatEUR(q.valorAplicado)])
    );
  }

  // ── 5. Quotas extraordinárias (com vencimento legível) ─────────────
  if (d.extras && d.extras.length) {
    L.seccao('Quotas extraordinárias');
    L.tabelaDados(
      [
        { titulo: 'Designação', x: 0, width: 186 },
        { titulo: 'Parcela', x: 192, width: 74 },
        { titulo: 'Vencimento', x: 270, width: 95 },
        { titulo: 'Valor aplicado', x: 373, width: 100, align: 'right' },
      ],
      d.extras.map((e) => {
        const detalhe = String(e.detalhe || '');
        const mParcela = detalhe.match(/Parcela\s*(\d+)/i);
        const mVenc = detalhe.match(/(\d{4})-(\d{2})-(\d{2})/);
        return [
          e.designacao || 'Quota extraordinária',
          mParcela ? `Parcela ${mParcela[1]}` : (detalhe || '—'),
          mVenc ? formatDate(`${mVenc[1]}-${mVenc[2]}-${mVenc[3]}`) : '—',
          formatEUR(e.valorAplicado),
        ];
      })
    );
  }

  // ── 6. VALOR DO RECIBO (destaque principal) ────────────────────────
  L.blocoTotal('VALOR DO RECIBO', d.valor);

  // ── 7. Saldo (rótulo semântico: devedor / credor / regularizado) ───
  L.blocoSaldo(d.saldoAposPagamento, d.data);

  // Recibos anulados mantêm todo o conteúdo histórico, marcados de forma
  // inequívoca (faixa "ANULADO") para não serem confundidos com válidos.
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
