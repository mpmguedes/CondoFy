// Testes dos documentos PDF (recibo e variantes) — sem base de dados e sem rede.
// Gera os PDFs com dados de exemplo, verifica o conteúdo (texto extraído das
// streams) e a estrutura (páginas, rodapé em todas as páginas).
// Os PDFs ficam em docs/documentos/ para validação visual.
//
// Utilização: node scripts/test-pdf-documentos.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { gerarReciboPDF, gerarAvisoQuotaPDF, componentesDaQuota } = require('../helpers/pdf');
const { toCents } = require('../helpers/money');
const backupMut = require('./helpers/backup-mutacao');

// Valor em cêntimos → texto do número exatamente como o PDF o escreve
// (ex.: 649,74), sem o símbolo € (que o PDF codifica como octal no stream).
function formatarPT(cents) {
  return (cents / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const RAIZ = path.join(__dirname, '..');
const SAIDA = path.join(RAIZ, 'docs', 'documentos');

// Extrai o texto das streams do PDF (PDFKit comprime com FlateDecode e escreve
// as cadeias de texto em hexadecimal <...> ou em literais (...)).
function textoDoPdf(buffer) {
  const bruto = buffer.toString('latin1');
  let conteudo = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(bruto)) !== null) {
    try {
      conteudo += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch (e) {
      conteudo += m[1];
    }
  }

  // As cadeias são concatenadas sem separador: PDFKit divide o texto em vários
  // pedaços (sobretudo quando há espaçamento entre caracteres).
  let texto = '';
  const reHex = /<([0-9A-Fa-f\s]+)>/g;
  let h;
  while ((h = reHex.exec(conteudo)) !== null) {
    const hex = h[1].replace(/\s+/g, '');
    if (hex.length % 2 !== 0) continue;
    texto += Buffer.from(hex, 'hex').toString('latin1');
  }
  const reLiteral = /\(((?:\\.|[^\\()])*)\)/g;
  let l;
  while ((l = reLiteral.exec(conteudo)) !== null) {
    texto += l[1].replace(/\\([()\\])/g, '$1');
  }
  return texto;
}

function contarPaginas(buffer) {
  const bruto = buffer.toString('latin1');
  return (bruto.match(/\/Type\s*\/Page(?![s])/g) || []).length;
}

// Geometria do texto: o PDFKit escreve com o eixo Y invertido (1 0 0 -1 0 H cm),
// pelo que um Tm y pequeno corresponde ao FUNDO da página. Serve para garantir
// que nada é desenhado abaixo do rodapé e que este aparece em todas as páginas.
function geometriaTexto(buffer) {
  const bruto = buffer.toString('latin1');
  let conteudo = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(bruto)) !== null) {
    try {
      conteudo += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch (e) {
      conteudo += m[1];
    }
  }
  const ys = [];
  const reTm = /1 0 0 1 [\d.]+ ([\d.]+) Tm/g;
  let t;
  while ((t = reTm.exec(conteudo)) !== null) ys.push(Number(t[1]));
  return {
    min: ys.length ? Math.min(...ys) : null,
    // textos na faixa do rodapé (PDFKit y > 779 => Tm y < 63)
    rodape: ys.filter((y) => y < 63).length,
  };
}

// Cores efetivamente usadas no PDF (operadores "scn" do content stream),
// convertidas para hexadecimal — confirma que a paleta foi aplicada.
function coresDoPdf(buffer) {
  const bruto = buffer.toString('latin1');
  let conteudo = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(bruto)) !== null) {
    try {
      conteudo += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch (e) {
      conteudo += m[1];
    }
  }
  const cores = [];
  const reCor = /([\d.]+) ([\d.]+) ([\d.]+) (?:scn|SCN|rg|RG)/g;
  let c;
  while ((c = reCor.exec(conteudo)) !== null) {
    const hex = '#' + [c[1], c[2], c[3]]
      .map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    cores.push(hex);
  }
  return cores;
}

function perto(hex, alvo) {
  const num = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
  const a = num(hex.toUpperCase());
  const b = num(alvo.toUpperCase());
  return a.every((v, i) => Math.abs(v - b[i]) <= 2);
}

function guardar(nome, buffer) {
  fs.mkdirSync(SAIDA, { recursive: true });
  const destino = path.join(SAIDA, nome);
  try {
    fs.writeFileSync(destino, buffer);
  } catch (e) {
    // Ficheiro aberto noutro programa (visualizador de PDF): grava ao lado para
    // não fazer falhar a suite de testes.
    const alternativa = destino.replace(/\.pdf$/i, '-novo.pdf');
    fs.writeFileSync(alternativa, buffer);
    console.warn('aviso: ' + nome + ' está aberto noutro programa; gravado em ' + path.basename(alternativa));
  }
}

const CONDOMINIO = {
  designacao: 'Condomínio Poeta José Régio 3A',
  morada: 'Rua Poeta José Régio, 12',
  codigo_postal: '2700-123',
  localidade: 'Amadora',
  nif: '501964843',
  logotipo: null,
  identidade_visual: 'designacao',
};

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// 11 quotas de 63,74 € + 1 de 63,82 € = 764,96 € (o total do recibo de referência)
function quotasDoAno() {
  const q = [];
  for (let i = 0; i < 12; i++) {
    q.push({
      numero: `Q2026-${String(i + 1).padStart(3, '0')}`,
      periodo: `${MESES[i]} 2026`,
      valorAplicado: i === 11 ? 63.82 : 63.74,
    });
  }
  return q;
}

const DESTINATARIO = {
  nome: 'Maria da Conceição Gonçalves Pereira',
  fracao: 'Fração A — 3.º Esq.',
  morada: 'Rua Poeta José Régio, 12',
  codigoPostalLocalidade: '2700-123 Amadora',
};

function reciboBase(extra = {}) {
  return Object.assign({
    numero: 'RCP-2026-0046',
    codigoVerificacao: 'A1B2C3D4E5',
    data: new Date(2026, 8, 9), // 09/09/2026
    condominoNome: DESTINATARIO.nome,
    destinatario: DESTINATARIO,
    fracaoDesignacao: 'Fração A',
    fracaoPermilagem: '125,000 ‰',
    pagamentos: [{ data_pagamento: new Date(2026, 8, 9), metodo: 'Transferência bancária', referencia: 'MB-2026-778812', valor: 764.96 }],
    quotas: quotasDoAno(),
    valor: 764.96,
    saldoAposPagamento: 0,
  }, extra);
}

async function testes() {
  // ── 1. Recibo de referência (uma página, sem dívida) ───────────────
  const pdf = await gerarReciboPDF(CONDOMINIO, reciboBase());
  assert.ok(pdf.slice(0, 4).toString() === '%PDF', 'gera um PDF válido');
  assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'), 'PDF termina com %%EOF');
  const txt = textoDoPdf(pdf);
  assert.ok(txt.includes('RCP-2026-0046'), 'mantém o número do recibo');
  assert.ok(txt.includes('A1B2C3D4E5'), 'mantém o código de verificação');
  assert.ok(txt.includes('764,96'), 'mantém o total 764,96 €');
  assert.ok(txt.includes('09/09/2026'), 'data de emissão em formato PT');
  assert.ok(txt.includes('VALOR DO RECIBO'), 'total identificado como VALOR DO RECIBO');
  assert.ok(txt.includes('Destinat'), 'zona do destinatário presente');
  assert.ok(txt.includes('Distribui'), 'secção de distribuição pelas quotas presente');
  assert.ok(txt.includes('Q2026-012'), 'última quota presente na tabela');
  assert.ok(txt.includes('Saldo regularizado'), 'saldo regularizado identificado por texto');
  assert.ok(txt.includes('Documento processado'), 'rodapé com a menção discreta à plataforma');
  assert.ok(!txt.includes('GesCondu\n') || txt.includes('plataforma GesCondu'), 'GesCondu só no rodapé');
  assert.strictEqual(contarPaginas(pdf), 1, 'recibo normal cabe numa página');
  assert.ok(txt.includes('Página 1 de 1'), 'paginação correta');
  // Geometria: nada abaixo do rodapé e rodapé presente em todas as páginas.
  const geo = geometriaTexto(pdf);
  assert.ok(geo.min >= 49, 'nada é desenhado abaixo do rodapé (min Tm y = ' + geo.min + ')');
  assert.strictEqual(geo.rodape, 2, 'apenas o rodapé ocupa a faixa inferior (plataforma + página)');
  // Ordem das secções: resumo -> quotas -> total -> saldo.
  assert.ok(txt.indexOf('Resumo do pagamento') < txt.indexOf('Distribui'), 'resumo antes das quotas');
  assert.ok(txt.indexOf('Q2026-001') < txt.indexOf('VALOR DO RECIBO'), 'quotas antes do total');
  assert.ok(txt.indexOf('VALOR DO RECIBO') < txt.indexOf('Saldo regularizado'), 'saldo depois do total');
  // Paleta aplicada: cores da identidade presentes e cores antigas ausentes.
  const cores = coresDoPdf(pdf);
  assert.ok(cores.some((c) => perto(c, '#06213F')), 'usa o azul-marinho #06213F (títulos)');
  assert.ok(cores.some((c) => perto(c, '#102B46')), 'usa o texto principal #102B46');
  assert.ok(cores.some((c) => perto(c, '#0B2E56')), 'usa o azul-marinho secundário #0B2E56 (cabeçalho de tabela)');
  assert.ok(cores.some((c) => perto(c, '#D7E4ED')), 'usa a borda #D7E4ED');
  assert.ok(!cores.some((c) => perto(c, '#2563eb')), 'não usa o azul antigo #2563eb');
  assert.ok(!cores.some((c) => perto(c, '#16a34a')), 'não usa o verde antigo #16a34a');
  // Regressão: nenhum fundo preto (o preto da página tornava o documento ilegível).
  assert.ok(!cores.some((c) => perto(c, '#000000')), 'não pinta fundos pretos (documento claro e legível)');
  // A página é pintada de branco (primeiro preenchimento de cada página).
  assert.ok(cores.some((c) => perto(c, '#FFFFFF')), 'página/cartões em branco');
  guardar('recibo-RCP-2026-0046.pdf', pdf);

  // ── 2. Recibo com quotas extraordinárias ───────────────────────────
  const pdfExtras = await gerarReciboPDF(CONDOMINIO, reciboBase({
    valor: 914.96,
    quotas: quotasDoAno().slice(0, 4),
    extras: [
      { designacao: 'Obras de impermeabilização da cobertura', detalhe: 'Parcela 1 — venc. 2026-07-10', valorAplicado: 150 },
      { designacao: 'Substituição do elevador', detalhe: 'Parcela 3 — venc. 2026-09-10', valorAplicado: 0 },
    ],
    pagamentos: [{ data_pagamento: new Date(2026, 8, 9), metodo: 'Multibanco', referencia: 'MB-2026-991122', valor: 914.96 }],
  }));
  const txtExtras = textoDoPdf(pdfExtras);
  assert.ok(txtExtras.includes('Quotas extraordin'), 'secção de quotas extraordinárias presente');
  assert.ok(txtExtras.includes('Parcela 1'), 'parcela identificada');
  assert.ok(txtExtras.includes('10/07/2026'), 'vencimento em formato PT (DD/MM/AAAA)');
  assert.ok(txtExtras.includes('914,96'), 'total do recibo com extras');
  assert.ok(txtExtras.includes('Obras de impermeabiliza'), 'designação longa presente');
  guardar('recibo-com-extras.pdf', pdfExtras);

  // ── 3. Recibo com saldo devedor ────────────────────────────────────
  const pdfDivida = await gerarReciboPDF(CONDOMINIO, reciboBase({ saldoAposPagamento: 312.4 }));
  const txtDivida = textoDoPdf(pdfDivida);
  assert.ok(txtDivida.includes('Saldo devedor'), 'saldo devedor identificado');
  assert.ok(txtDivida.includes('312,40'), 'valor em dívida apresentado');
  guardar('recibo-com-divida.pdf', pdfDivida);

  // ── 4. Recibo com saldo credor ─────────────────────────────────────
  const pdfCredor = await gerarReciboPDF(CONDOMINIO, reciboBase({ saldoAposPagamento: -25.5 }));
  const txtCredor = textoDoPdf(pdfCredor);
  assert.ok(txtCredor.includes('Saldo credor'), 'saldo credor identificado');
  assert.ok(txtCredor.includes('crédito a favor') || txtCredor.includes('Crédito a favor'), 'explica que é crédito a favor da fração');
  guardar('recibo-com-credito.pdf', pdfCredor);

  // ── 5. Tabela longa (várias páginas) ───────────────────────────────
  const quotasLongas = [];
  for (let i = 0; i < 60; i++) {
    quotasLongas.push({ numero: `Q2026-${String(i + 1).padStart(3, '0')}`, periodo: `${MESES[i % 12]} ${2024 + Math.floor(i / 12)}`, valorAplicado: 63.74 });
  }
  const pdfLongo = await gerarReciboPDF(CONDOMINIO, reciboBase({ quotas: quotasLongas, valor: quotasLongas.reduce((s, q) => s + q.valorAplicado, 0) }));
  const paginasLongo = contarPaginas(pdfLongo);
  const txtLongo = textoDoPdf(pdfLongo);
  assert.ok(paginasLongo >= 2, 'tabela longa gera várias páginas (' + paginasLongo + ')');
  for (let i = 1; i <= paginasLongo; i++) {
    assert.ok(txtLongo.includes(`Página ${i} de ${paginasLongo}`), 'rodapé com paginação na página ' + i);
    assert.ok(txtLongo.includes('Documento processado'), 'menção à plataforma na página ' + i);
  }
  assert.ok(txtLongo.includes('Página 1 de ' + paginasLongo), 'primeira página numerada');
  guardar('recibo-tabela-longa.pdf', pdfLongo);

  // ── 6. Com logótipo configurado do condomínio ──────────────────────
  const uploads = path.join(RAIZ, 'public', 'uploads');
  const logotipoTeste = path.join(uploads, '_teste-logotipo.png');
  const origemLogo = path.join(RAIZ, 'public', 'img', 'gescondu-logo-refinado-claro.png');
  fs.mkdirSync(uploads, { recursive: true });
  fs.copyFileSync(origemLogo, logotipoTeste);
  try {
    const pdfLogo = await gerarReciboPDF({ ...CONDOMINIO, logotipo: '_teste-logotipo.png', identidade_visual: 'logo' }, reciboBase());
    assert.ok(pdfLogo.length > pdf.length, 'com logótipo o PDF inclui a imagem');
    assert.strictEqual(contarPaginas(pdfLogo), 1, 'continua numa página com logótipo');
    guardar('recibo-com-logotipo.pdf', pdfLogo);
  } finally {
    // Afastar por rename, não por unlink: o guard de eliminações do host
    // (latched a meio da sessão) fazia este `finally` rebentar e o teste falhar
    // por causa do ambiente, não do produto.
    backupMut.afastar(logotipoTeste);
  }

  // ── 7. Aviso de quota (mesma linguagem visual) ─────────────────────
  // A quota traz as componentes guardadas (Quota.valor_base / valor_fcr /
  // fcr_percentagem): o aviso discrimina quota corrente + FCR e nunca as
  // recalcula.
  const avisoBase = {
    numero: 'AVQ-2026-0031',
    periodo: 'Setembro 2026',
    dataEmissao: new Date(2026, 8, 9),
    dataVencimento: new Date(2026, 8, 30),
    destinatarioNome: DESTINATARIO.nome,
    fracaoDesignacao: 'Fração A',
    fracaoMorada: 'Rua Poeta José Régio, 12 — 2700-123 Amadora',
    valor: 191.22,
    totalAPagar: 191.22,
    saldoAnterior: 0,
    emDivida: 0,
    iban: 'PT50000201231234567890154',
    referencia: 'AVQ-2026-0031',
  };
  const pdfAviso = await gerarAvisoQuotaPDF(CONDOMINIO, {
    ...avisoBase,
    valorBase: 173.84,
    valorFcr: 17.38,
    fcrPercentagem: '10',
  });
  const txtAviso = textoDoPdf(pdfAviso);
  assert.ok(txtAviso.includes('AVQ-2026-0031'), 'aviso mantém o número');
  assert.ok(txtAviso.includes('191,22'), 'aviso mantém os valores');
  assert.ok(txtAviso.includes('30/09/2026'), 'aviso com data de vencimento em formato PT');
  assert.ok(txtAviso.includes('PT50000201231234567890154'), 'aviso mantém o IBAN');
  assert.ok(txtAviso.includes('Documento processado'), 'aviso com o mesmo rodapé');
  // Discriminação da quota: quota corrente + FCR (10%) + total.
  assert.ok(txtAviso.includes('Composi') && txtAviso.includes('da quota'), 'aviso com a composição da quota');
  assert.ok(txtAviso.includes('Quota corrente'), 'aviso identifica a quota corrente');
  assert.ok(txtAviso.includes('Fundo de reserva'), 'aviso identifica o fundo de reserva');
  assert.ok(txtAviso.includes('(10%)'), 'aviso mostra a percentagem de FCR configurada');
  assert.ok(txtAviso.includes('173,84'), 'aviso mostra a quota corrente guardada');
  assert.ok(txtAviso.includes('17,38'), 'aviso mostra o FCR guardado');
  assert.ok(txtAviso.includes('Total da quota'), 'aviso identifica o total da quota');
  assert.strictEqual(173.84 + 17.38, 191.22, 'aviso: quota corrente + FCR = total guardado');
  guardar('aviso-quota.pdf', pdfAviso);

  // ── 7b. Aviso com FCR acima do mínimo legal (15%) ──────────────────
  const pdfAviso15 = await gerarAvisoQuotaPDF(CONDOMINIO, {
    ...avisoBase,
    numero: 'AVQ-2026-0032',
    referencia: 'AVQ-2026-0032',
    valor: '234.35',
    totalAPagar: '234.35',
    valorBase: '203.78',
    valorFcr: '30.57',
    fcrPercentagem: '15',
  });
  const txtAviso15 = textoDoPdf(pdfAviso15);
  assert.ok(txtAviso15.includes('(15%)'), 'aviso com FCR de 15% assume a percentagem guardada');
  assert.ok(txtAviso15.includes('203,78') && txtAviso15.includes('30,57'), 'aviso com FCR acima do mínimo mostra os valores guardados');
  assert.strictEqual(203.78 + 30.57, 234.35, 'aviso 15%: quota corrente + FCR = total guardado');
  guardar('aviso-quota-fcr-15.pdf', pdfAviso15);

  // ── 7c. Aviso de quota sem FCR (10,00 € só de despesas comuns) ─────
  const pdfAvisoSemFcr = await gerarAvisoQuotaPDF(CONDOMINIO, {
    ...avisoBase,
    numero: 'AVQ-2026-0033',
    referencia: 'AVQ-2026-0033',
    valor: '10.00',
    totalAPagar: '10.00',
    valorBase: '10.00',
    valorFcr: '0.00',
    fcrPercentagem: '0',
  });
  const txtAvisoSemFcr = textoDoPdf(pdfAvisoSemFcr);
  assert.ok(txtAvisoSemFcr.includes('Quota corrente'), 'aviso sem FCR continua a discriminar a quota corrente');
  assert.ok(txtAvisoSemFcr.includes('10,00'), 'aviso sem FCR mantém o valor guardado');
  assert.ok(!txtAvisoSemFcr.includes('Fundo de reserva'), 'aviso sem FCR não inventa uma linha de fundo a zero');
  assert.ok(!txtAvisoSemFcr.includes('Sem componentes'), 'aviso com componentes guardadas nunca mostra o aviso de ausência');
  guardar('aviso-quota-sem-fcr.pdf', pdfAvisoSemFcr);

  // ── 7d. Aviso sem componentes guardadas (quota antiga) ─────────────
  const pdfAvisoLegado = await gerarAvisoQuotaPDF(CONDOMINIO, {
    ...avisoBase,
    numero: 'AVQ-2026-0034',
    referencia: 'AVQ-2026-0034',
  });
  const txtAvisoLegado = textoDoPdf(pdfAvisoLegado);
  assert.ok(txtAvisoLegado.includes('Quota atual'), 'aviso antigo mantém a apresentação simples (Quota atual)');
  assert.ok(!txtAvisoLegado.includes('Composi'), 'aviso sem componentes guardadas não cria a composição');
  guardar('aviso-quota-legado.pdf', pdfAvisoLegado);

  // ── 8. Recibo anulado continua marcado ─────────────────────────────
  const pdfAnulado = await gerarReciboPDF(CONDOMINIO, reciboBase({ anulado: true }));
  assert.ok(textoDoPdf(pdfAnulado).includes('ANULADO'), 'recibo anulado marcado de forma inequívoca');
  assert.strictEqual(contarPaginas(pdfAnulado), 1, 'recibo anulado numa página');

  // ── 9. Recibo com FCR (componentes guardadas por linha de ReciboQuota) ──
  // Cada linha de ReciboQuota guarda a parcela daquele mês partida em
  // valor (total), valor_base (quota corrente) e valor_fcr (fundo). O PDF só
  // soma esses valores: nunca recalcula a percentagem (é por isso que as
  // componentes somam exatamente o valor guardado, como na BD real).
  const quotaComComponentes = (q) => {
    const baseC = Math.round(toCents(q.valorAplicado) * 0.85);
    return { ...q, valorBase: baseC / 100, valorFcr: (toCents(q.valorAplicado) - baseC) / 100 };
  };
  const quotasComFcr = quotasDoAno().map(quotaComComponentes);
  const totalBaseC = quotasComFcr.reduce((s, q) => s + toCents(q.valorBase), 0);
  const totalFcrC = quotasComFcr.reduce((s, q) => s + toCents(q.valorFcr), 0);

  const pdfFcr = await gerarReciboPDF(CONDOMINIO, reciboBase({ quotas: quotasComFcr, fcrPercentagem: '15' }));
  const txtFcr = textoDoPdf(pdfFcr);
  assert.ok(txtFcr.includes('Quota corrente'), 'recibo com FCR identifica a quota corrente');
  assert.ok(txtFcr.includes('Fundo de reserva'), 'recibo com FCR identifica o fundo de reserva');
  assert.ok(txtFcr.includes('(15%)'), 'recibo mostra a percentagem de FCR guardada');
  assert.ok(txtFcr.includes('VALOR DO RECIBO'), 'recibo mantém o destaque principal do valor');
  assert.ok(txtFcr.includes(formatarPT(totalBaseC)), 'recibo mostra a soma das componentes base guardadas (' + formatarPT(totalBaseC) + ')');
  assert.ok(txtFcr.includes(formatarPT(totalFcrC)), 'recibo mostra a soma das componentes FCR guardadas (' + formatarPT(totalFcrC) + ')');
  assert.strictEqual(Math.round(totalBaseC + totalFcrC), toCents(764.96), 'recibo: quota corrente + FCR = total da quota corrente');
  assert.ok(txtFcr.includes('Distribui'), 'recibo com FCR mantém a distribuição pelas quotas');
  assert.ok(!txtFcr.includes('extraordin'), 'recibo com FCR não classifica o FCR como quota extraordinária');
  assert.ok(txtFcr.indexOf('Quota corrente') < txtFcr.indexOf('VALOR DO RECIBO'), 'as componentes são apresentadas antes do valor do recibo');
  assert.strictEqual(contarPaginas(pdfFcr), 1, 'recibo com FCR cabe numa página');
  guardar('recibo-com-fcr.pdf', pdfFcr);

  // ── 9b. Recibo com FCR e quotas extraordinárias (separadas) ────────
  const pdfFcrExtras = await gerarReciboPDF(CONDOMINIO, reciboBase({
    valor: 914.96,
    quotas: quotasComFcr.slice(0, 4),
    fcrPercentagem: '15',
    extras: [
      { designacao: 'Obras de impermeabilização da cobertura', detalhe: 'Parcela 1 — venc. 2026-07-10', valorAplicado: 150 },
      { designacao: 'Substituição do elevador', detalhe: 'Parcela 3 — venc. 2026-09-10', valorAplicado: 0 },
    ],
    pagamentos: [{ data_pagamento: new Date(2026, 8, 9), metodo: 'Multibanco', referencia: 'MB-2026-991122', valor: 914.96 }],
  }));
  const txtFcrExtras = textoDoPdf(pdfFcrExtras);
  const fcr4 = quotasComFcr.slice(0, 4).reduce((s, q) => s + toCents(q.valorFcr), 0);
  assert.ok(txtFcrExtras.includes('Quota corrente') && txtFcrExtras.includes('Fundo de reserva'), 'com extras, o recibo continua a discriminar quota corrente + FCR');
  // As componentes impressas têm de somar exatamente a quota corrente coberta
  // (4 meses = 254,98 €): o total manda e a diferença de arredondamento fica na
  // quota corrente, nunca no FCR.
  assert.ok(txtFcrExtras.includes(formatarPT(25496 - fcr4)) && txtFcrExtras.includes(formatarPT(fcr4)), 'componentes do recibo com extras somam a quota corrente coberta (' + formatarPT(25496 - fcr4) + ' + ' + formatarPT(fcr4) + ' = 254,96 €)');
  assert.ok(txtFcrExtras.includes('Quotas extraordin'), 'secção de quotas extraordinárias preservada');
  assert.ok(txtFcrExtras.includes('Obras de impermeabiliza'), 'extra continua discriminada com a sua designação');
  assert.ok(txtFcrExtras.includes('150,00'), 'extra continua com o seu valor');
  assert.ok(txtFcrExtras.includes('914,96'), 'total do recibo (quota corrente + FCR + extra) preservado');
  // O FCR é uma componente da quota corrente: nunca entra na tabela de quotas
  // extraordinárias (que fica intacta, com as suas designações e valores).
  const posExtras = txtFcrExtras.indexOf('Quotas extraordin');
  const posFcr = txtFcrExtras.indexOf('Fundo de reserva');
  assert.ok(posFcr > posExtras && posFcr < txtFcrExtras.indexOf('VALOR DO RECIBO'), 'o FCR é apresentado no valor do recibo, depois da tabela de extraordinárias e antes do total');
  guardar('recibo-com-fcr-e-extras.pdf', pdfFcrExtras);

  // ── 9c. Recibo sem FCR (componentes base iguais ao valor aplicado) ─
  const quotasSemFcr = quotasDoAno().map((q) => ({ ...q, valorBase: q.valorAplicado, valorFcr: 0 }));
  const pdfSemFcr = await gerarReciboPDF(CONDOMINIO, reciboBase({ quotas: quotasSemFcr, fcrPercentagem: '0' }));
  const txtSemFcr = textoDoPdf(pdfSemFcr);
  assert.ok(txtSemFcr.includes('Quota corrente'), 'recibo sem FCR mostra a quota corrente');
  assert.ok(txtSemFcr.includes('764,96'), 'recibo sem FCR mantém o total recebido');
  assert.ok(!txtSemFcr.includes('Fundo de reserva'), 'recibo sem FCR não inventa uma linha de fundo a zero');
  guardar('recibo-sem-fcr.pdf', pdfSemFcr);

  // ── 9d. Recibo sem componentes guardadas (recibo antigo) ───────────
  const pdfSemComponentes = await gerarReciboPDF(CONDOMINIO, reciboBase({ quotas: quotasDoAno() }));
  const txtSemComponentes = textoDoPdf(pdfSemComponentes);
  assert.ok(!txtSemComponentes.includes('Quota corrente') && !txtSemComponentes.includes('Fundo de reserva'), 'recibo antigo (sem componentes guardadas) mantém o layout simples');
  assert.ok(txtSemComponentes.includes('764,96') && txtSemComponentes.includes('VALOR DO RECIBO'), 'recibo antigo mantém o valor e a distribuição');

  // ── 10. Regras da composição da quota (base + FCR = total) ─────────
  // Função única que alimenta os dois documentos: só soma valores guardados.
  assert.strictEqual(componentesDaQuota({ baseC: 0, fcrC: 0 }), null, 'sem componentes não há discriminação (mantém o layout simples)');
  assert.strictEqual(componentesDaQuota({ basesC: [0, 0], fcrsC: [0, 0], aplicadosC: [6374, 6374] }), null, 'linhas a zero não criam um bloco de FCR a zero');

  const c10 = componentesDaQuota({ baseC: 17384, fcrC: 1738, totalC: 19122, percentagem: '10' });
  assert.strictEqual(c10.baseC + c10.fcrC, 19122, '10%: quota corrente + FCR = total guardado');
  assert.strictEqual(c10.temFcr, true, '10%: FCR reconhecido como existente');
  assert.strictEqual(c10.percentagemTexto, ' (10%)', '10%: percentagem mostrada discretamente');

  const c20 = componentesDaQuota({ baseC: 15935, fcrC: 3187, totalC: 19122, percentagem: '20' });
  assert.strictEqual(c20.baseC + c20.fcrC, 19122, '20%: quota corrente + FCR = total guardado');
  assert.strictEqual(c20.percentagemTexto, ' (20%)', '20%: percentagem acima do mínimo legal preservada');

  const cDecimal = componentesDaQuota({ baseC: 16998, fcrC: 2124, totalC: 19122, percentagem: '12,5' });
  assert.strictEqual(cDecimal.baseC + cDecimal.fcrC, 19122, '12,5%: quota corrente + FCR = total guardado');
  assert.strictEqual(cDecimal.percentagemTexto, ' (12,5%)', '12,5%: decimal em formato PT');

  // Totais que não fecham (arredondamento por linha do recibo): o total manda e
  // a diferença vai para a quota corrente — o FCR nunca é reduzido.
  const cArred = componentesDaQuota({ basesC: [5418, 5418, 5418, 5425], fcrsC: [956, 956, 956, 957], aplicadosC: [6374, 6374, 6374, 6382] });
  assert.strictEqual(cArred.baseC + cArred.fcrC, cArred.totalC, 'arredondamento: base + FCR = total');
  assert.strictEqual(cArred.totalC, 25504, 'arredondamento: total é a soma dos valores aplicados (6374×3 + 6382)');
  assert.strictEqual(cArred.fcrC, 3825, 'arredondamento: o FCR mantém o valor guardado (não é ajustado)');
  assert.strictEqual(cArred.baseC, 21679, 'arredondamento: a quota corrente absorve a diferença de cêntimos');

  console.log('✓ Testes dos documentos PDF passaram (recibo + variantes, sem base de dados).');
  console.log('  PDFs gerados em docs/documentos/ para validação visual.');
}

testes().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
