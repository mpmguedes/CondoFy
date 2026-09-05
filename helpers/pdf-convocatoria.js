// ─────────────────────────────────────────────────────────────────────
// PDF — Convocatória para Assembleia Geral (carta oficial, A4, 1 página)
//
// Gera um documento administrativo com composição de carta formal:
// cabeçalho tipográfico (edifício à esquerda, saudação à direita),
// assunto centrado, texto justificado, ordem de trabalhos numerada com
// indentação pendente, quórum/2.ª convocatória, representação, espaço
// de assinatura e rodapé discreto.
//
// Garantias:
//  · uma única página A4 (nunca corta texto nem cria 2.ª página);
//  · adaptação automática: reduz primeiro os espaços entre parágrafos e
//    secções, depois as margens internas e, só no fim, o tamanho da letra;
//  · aparência de documento oficial (sem caixas, sombras ou cores fortes).
// ─────────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit');
const { construirDocumento } = require('./convocatoria');

// ── Constantes de layout ────────────────────────────────────────────
const A4 = { w: 595.28, h: 841.89 };
const M = 52; // margem lateral
const CW = A4.w - M * 2; // largura útil (≈ 491 pt)
const TOPO = 42;

const FONTE = 'Helvetica';
const FONTE_BOLD = 'Helvetica-Bold';

// Cores institucionais discretas (sem blocos coloridos)
const COR_INK = '#1c2733';
const COR_TEXTO = '#262c33';
const COR_MUTED = '#6a7380';
const COR_LINHA = '#c3cbd4';
const COR_RODAPE = '#7c8794';

// Colunas do cabeçalho
const LCOL_W = 268; // largura da coluna esquerda (edifício)
const RW = CW - LCOL_W - 12; // largura da coluna direita (saudação)
const RX = M + CW - RW; // x inicial da coluna direita

const LIMITE = 772; // fim útil do conteúdo (acima do rodapé)
const RODAPE_BASE = 784; // y da linha do rodapé quando o conteúdo cabe

function paraBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ── Motor de layout ─────────────────────────────────────────────────
// Compõe o documento inteiro (mede ou desenha) e devolve o y final.
function compor(doc, nivel, desenhar, docObj) {
  const { fs, esp } = nivel;
  const T = docObj.textos;
  const pontos = docObj.pontos || [];

  let y = TOPO;
  // Pausa vertical: base × escala do nível (com um mínimo para legibilidade).
  const sp = (base, min = 0) => {
    y += Math.max(base * esp, min);
  };

  const medir = (texto, o) => {
    doc.font(o.bold ? FONTE_BOLD : FONTE).fontSize(o.size);
    return doc.heightOfString(String(texto ?? ''), {
      width: o.width || CW,
      lineGap: o.lineGap || 0,
      characterSpacing: o.charSpace || 0,
    });
  };

  // Desenha um texto no cursor y e avança o cursor.
  const texto = (textoBruto, o = {}) => {
    const h = medir(textoBruto, o);
    if (desenhar) {
      doc
        .font(o.bold ? FONTE_BOLD : FONTE)
        .fontSize(o.size)
        .fillColor(o.cor || COR_TEXTO);
      doc.text(String(textoBruto ?? ''), o.x != null ? o.x : M, y, {
        width: o.width || CW,
        align: o.align || 'left',
        lineGap: o.lineGap || 0,
        characterSpacing: o.charSpace || 0,
      });
    }
    y += h;
  };

  // ── Cabeçalho (duas colunas) ──────────────────────────────────────
  const yIni = TOPO;
  const leftLines = [{ t: docObj.edificioNome || 'Condomínio', size: 15, bold: true, cor: COR_INK }];
  if (docObj.morada) leftLines.push({ t: docObj.morada, size: 8.6, cor: COR_MUTED });
  if (docObj.codigoPostal || docObj.cidade) {
    leftLines.push({
      t: [docObj.codigoPostal, docObj.cidade].filter(Boolean).join(' '),
      size: 8.6,
      cor: COR_MUTED,
    });
  }

  let yl = yIni;
  for (const [i, lin] of leftLines.entries()) {
    const h = medir(lin.t, { size: lin.size, bold: lin.bold, width: LCOL_W });
    if (desenhar) {
      doc.font(lin.bold ? FONTE_BOLD : FONTE).fontSize(lin.size).fillColor(lin.cor);
      doc.text(lin.t, M, yl, { width: LCOL_W });
    }
    yl += h + (i < leftLines.length - 1 ? 1.5 : 0);
  }
  const leftH = yl - yIni;

  // Coluna direita: saudação, linha fina, cidade
  const hSaud = medir(T.saudacaoCabecalho, { size: 10.5, bold: true, width: RW, align: 'right' });
  const linhaY = yIni + hSaud + 5;
  const cidadeY = linhaY + 8;
  let hCidade = 0;
  if (docObj.cidade) {
    hCidade = medir(docObj.cidade, { size: 9.4, width: RW, align: 'right' });
  }
  const rightH = Math.max(hSaud + 5 + 8 + hCidade, hSaud);

  if (desenhar) {
    doc.font(FONTE_BOLD).fontSize(10.5).fillColor(COR_INK);
    doc.text(T.saudacaoCabecalho, RX, yIni, { width: RW, align: 'right' });
    doc.moveTo(RX, linhaY).lineTo(M + CW, linhaY).lineWidth(0.8).strokeColor(COR_LINHA).stroke();
    if (docObj.cidade) {
      doc.font(FONTE).fontSize(9.4).fillColor(COR_MUTED);
      doc.text(docObj.cidade, RX, cidadeY, { width: RW, align: 'right' });
    }
  }

  const headerH = Math.max(leftH, rightH);
  y = yIni + headerH;
  sp(22, 10); // espaço generoso após o cabeçalho

  // ── Assunto + título (centrados) ──────────────────────────────────
  texto(T.rotuloAssunto, { size: 7.6, cor: COR_MUTED, align: 'center', charSpace: 2.2 });
  sp(10, 4);
  texto(T.titulo, { size: 17, bold: true, cor: COR_INK, align: 'center' });
  sp(12, 6);

  if (T.linhaIdentificacao) {
    texto(T.linhaIdentificacao, { size: 9.6, bold: true, cor: '#3c4856', align: 'center' });
    sp(3, 2);
  }
  if (T.localData) {
    texto(T.localData, { size: 9.2, cor: COR_MUTED, align: 'center' });
  }
  sp(14, 7);

  // ── Saudação + texto introdutório ─────────────────────────────────
  texto(T.saudacao, { size: 10.4, bold: true });
  sp(7, 4);
  texto(T.introducao, { size: fs, align: 'justify', lineGap: 1.6 });
  sp(18, 9);

  // ── Ordem de trabalhos ────────────────────────────────────────────
  texto(T.tituloOrdem, { size: 10.8, bold: true, cor: COR_INK, charSpace: 1.6 });
  sp(7, 4);

  if (pontos.length) {
    const numW = 27;
    const itemX = M + numW + 3;
    const itemW = CW - numW - 3;
    pontos.forEach((ponto, i) => {
      const hItem = medir(ponto, { size: fs, width: itemW, lineGap: 1.2 });
      if (desenhar) {
        doc.font(FONTE_BOLD).fontSize(fs).fillColor(COR_INK);
        doc.text(`${i + 1}.`, M, y, { width: numW, align: 'right', lineGap: 1.2 });
        doc.font(FONTE).fontSize(fs).fillColor(COR_TEXTO);
        doc.text(ponto, itemX, y, { width: itemW, align: 'left', lineGap: 1.2 });
      }
      y += hItem;
      sp(5, 2.5); // separação entre pontos
    });
  } else {
    texto(T.semPontos, { size: Math.max(fs - 1, 7), cor: COR_MUTED });
  }
  sp(18, 9);

  // ── Quórum e segunda convocatória ─────────────────────────────────
  texto(T.tituloQuorum, { size: 10.8, bold: true, cor: COR_INK, charSpace: 1.6 });
  sp(7, 4);

  texto(T.subtituloPrimeira, { size: 10, bold: true });
  sp(2, 1);
  texto(T.textoPrimeira, { size: fs, align: 'justify', lineGap: 1.4 });
  sp(10, 5);

  texto(T.subtituloSegunda, { size: 10, bold: true });
  sp(2, 1);
  texto(T.textoSegunda, { size: fs, align: 'justify', lineGap: 1.4 });
  sp(8, 4);
  texto(T.textoRepresentacao, { size: fs, align: 'justify', lineGap: 1.4 });
  sp(10, 6);

  // ── Fecho e assinatura ────────────────────────────────────────────
  texto(T.fechoComparacia, { size: fs, lineGap: 1 });
  sp(5, 3);
  texto(T.fechoCumprimentos, { size: fs, lineGap: 1 });
  sp(56, 36); // espaço para assinatura

  texto(T.assinaturaRotulo, { size: 11, bold: true, cor: COR_INK });
  if (docObj.administracaoNome) {
    sp(3, 2);
    texto(docObj.administracaoNome, { size: 9.5, cor: COR_MUTED });
  }

  return y;
}

// Linha fina + textos do rodapé.
function desenharRodape(doc, docObj, yRodape) {
  doc
    .moveTo(M, yRodape)
    .lineTo(M + CW, yRodape)
    .lineWidth(0.6)
    .strokeColor(COR_LINHA)
    .stroke();

  doc.font(FONTE).fontSize(7.2).fillColor(COR_RODAPE);
  doc.text(docObj.textos.rodape, M, yRodape + 6, { width: CW, align: 'left', lineGap: 0.5 });
  if (docObj.emailAutorizado) {
    doc.text(docObj.textos.rodapeEmail, M, yRodape + 15, { width: CW, align: 'left', lineGap: 0.5 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Geração principal
// ═══════════════════════════════════════════════════════════════════
// condominio — objeto do condomínio (designacao, morada, codigo_postal,
//             localidade, administracao_nome) usado como origem por omissão.
// d         — dados específicos da convocatória (ver helpers/convocatoria.js).
async function gerarConvocatoriaCartaPDF(condominio, d = {}) {
  const c = condominio || {};
  const entrada = {
    edificioNome: d.edificioNome || c.designacao || '',
    morada: d.morada || c.morada || '',
    codigoPostal: d.codigoPostal || c.codigo_postal || '',
    cidade: d.cidade || c.localidade || '',
    administracaoNome: d.administracaoNome || c.administracao_nome || '',
    numero: d.numero,
    tipo: d.tipo,
    data: d.data,
    dataEmissao: d.dataEmissao,
    hora: d.hora,
    horaSegunda: d.horaSegunda,
    local: d.local,
    emailAutorizado: d.emailAutorizado,
    pontos: d.ordemTrabalhos != null ? d.ordemTrabalhos : d.pontos,
  };
  const docObj = construirDocumento(entrada);

  // ── Escolha adaptativa do nível (espaçamentos → letra) ────────────
  // Ordem de compressão conforme especificado: primeiro os espaços entre
  // parágrafos/secções, depois os espaçamentos internos e só no fim a letra.
  const FONTES = [10.2, 9.9, 9.6, 9.3, 9.0, 8.7, 8.4, 8.1, 7.8, 7.5, 7.2, 7.0, 6.7];
  const ESPACOS = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36, 0.28, 0.2, 0.12, 0.06];

  const docMedida = new PDFDocument({ size: 'A4', margin: 0 });
  let nivel = { fs: FONTES[FONTES.length - 1], esp: ESPACOS[ESPACOS.length - 1] };
  encontrar: for (const fs of FONTES) {
    for (const esp of ESPACOS) {
      const yFim = compor(docMedida, { fs, esp }, false, docObj);
      if (yFim <= LIMITE) {
        nivel = { fs, esp };
        break encontrar;
      }
    }
  }

  // ── Desenho final ─────────────────────────────────────────────────
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: docObj.textos.titulo,
      Author: docObj.administracaoNome || 'GesCondu',
      Subject: `Convocatória${docObj.numero ? ` n.º ${docObj.numero}` : ''} — ${docObj.textos.titulo}`,
      Producer: 'GesCondu',
    },
  });

  const yFim = compor(doc, nivel, true, docObj);

  // Rodapé: posição fixa se houver espaço; caso contrário desce ligeiramente
  // (nunca sobrepõe conteúdo nem cria segunda página).
  const yRodape = yFim <= LIMITE ? RODAPE_BASE : Math.min(yFim + 12, A4.h - 40);
  desenharRodape(doc, docObj, yRodape);

  return paraBuffer(doc);
}

module.exports = { gerarConvocatoriaCartaPDF };
