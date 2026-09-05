// ─────────────────────────────────────────────────────────────────────
// Convocatória — composição dos dados e dos textos do documento.
// Módulo partilhado pela interface (Nova Convocatória), pela
// pré-visualização e pelo gerador de PDF, para garantir que o documento
// pré-visualizado é exatamente o mesmo que é gerado.
// ─────────────────────────────────────────────────────────────────────
const { diaSemana, formatDateExtenso } = require('./dates');

const TIPOS = {
  ordinaria: 'Ordinária',
  extraordinaria: 'Extraordinária',
  urgencia: 'Extraordinária',
};

const TIPOS_TITULO = {
  ordinaria: 'Ordinária',
  extraordinaria: 'Extraordinária',
  urgencia: 'Extraordinária',
};

// ── Horas ───────────────────────────────────────────────────────────
// "19:47" → { h: 19, m: 47 }  (valida e normaliza HH:MM)
function parseHora(valor) {
  const res = /^(\d{1,2}):(\d{2})$/.exec(String(valor == null ? '' : valor).trim());
  if (!res) return null;
  const h = parseInt(res[1], 10);
  const min = parseInt(res[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

// Soma minutos a "HH:MM" e devolve "HH:MM" (roda o dia se necessário).
function somarMinutos(valor, minutos = 30) {
  const t = parseHora(valor);
  if (!t) return '';
  const total = t.h * 60 + t.m + minutos;
  const h = ((Math.floor(total / 60)) % 24 + 24) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── Datas ───────────────────────────────────────────────────────────
// Data de hoje no formato YYYY-MM-DD (fuso local).
function hojeInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoData(valor) {
  if (!valor) return '';
  return String(valor).slice(0, 10);
}

// "Sexta-feira" → "sexta-feira" (usado dentro de frases)
function diaSemanaMin(valor) {
  const dia = diaSemana(valor);
  return dia ? dia.charAt(0).toLowerCase() + dia.slice(1) : '';
}

// ── Ordem de trabalhos ──────────────────────────────────────────────
// Aceita arrays ou texto com quebras de linha. Remove numeração manual
// ("1.", "1)", "1 -", "1:") para evitar duplicações com a numeração automática.
function normalizarPontos(entrada) {
  const linhas = [];
  const lista = Array.isArray(entrada) ? entrada : [entrada];
  for (const p of lista) {
    if (p == null) continue;
    for (const linha of String(p).split(/\r?\n/)) {
      const t = linha.trim();
      if (t) linhas.push(t.replace(/^\s*(?:\d{1,3}\s*[.)\-–—:]\s*)+\s*/, '').trim());
    }
  }
  return linhas.filter(Boolean);
}

function str(v) {
  return v == null ? '' : String(v).trim();
}

function ehBooleano(v) {
  return v === true || v === 'on' || v === '1' || v === 1;
}

// ── Textos fixos do documento ────────────────────────────────────────
function textoPrimeiraConvocatoria() {
  return (
    'Nos termos do art. 1432.º, n.º 4 do Código Civil, a presente reunião ' +
    'realizar-se-á em primeira convocatória com a presença ou representação de ' +
    'condóminos titulares de mais de 500 permilagens do valor total do prédio.'
  );
}

function textoSegundaConvocatoria(horaSegunda) {
  return (
    'Caso não se verifique o quórum necessário, fica desde já convocada segunda ' +
    `reunião para as ${horaSegunda || '—'} do mesmo dia e no mesmo local, a qual ` +
    'poderá deliberar validamente com a presença ou representação de condóminos que ' +
    'representem pelo menos 250 permilagens do valor total do prédio (art. 1432.º, n.º 5 ' +
    'do Código Civil).'
  );
}

function textoRepresentacao() {
  return (
    'Os condóminos que não possam comparecer poderão fazer-se representar por procurador ' +
    'munido de procuração escrita, a entregar antes do início da reunião, nos termos do ' +
    'Art. 1432.º, n.º 6 do Código Civil.'
  );
}

// ── Construção do documento ──────────────────────────────────────────
// Entrada: valores crus (formulário) já com os dados do condomínio
// preenchidos por omissão. Saída: objeto com tudo calculado e com os
// textos prontos para a pré-visualização e para o PDF.
function construirDocumento(entrada = {}) {
  const edificioNome = str(entrada.edificioNome);
  const morada = str(entrada.morada);
  const codigoPostal = str(entrada.codigoPostal);
  const cidade = str(entrada.cidade);
  const administracaoNome = str(entrada.administracaoNome);
  const numero = str(entrada.numero);
  const local = str(entrada.local);

  const tipoRaw = str(entrada.tipo).toLowerCase();
  const tipo = TIPOS[tipoRaw] ? tipoRaw : 'ordinaria';
  const tipoLabel = TIPOS_TITULO[tipo] || 'Ordinária';

  const data = isoData(entrada.data);
  const dataEmissao = isoData(entrada.dataEmissao) || hojeInput();

  const hora = parseHora(entrada.hora) ? String(entrada.hora).trim() : str(entrada.hora);
  const horaSegunda = parseHora(entrada.horaSegunda)
    ? String(entrada.horaSegunda).trim()
    : hora
      ? somarMinutos(hora, 30)
      : '';

  const emailAutorizado = ehBooleano(entrada.emailAutorizado);
  const pontos = normalizarPontos(entrada.pontos);

  const dataLonga = data ? formatDateExtenso(data) : '';
  const dataEmissaoLonga = formatDateExtenso(dataEmissao);
  const dia = data ? diaSemanaMin(data) : '';

  // Linha identificadora: "Edifício sito em Lisboa · Reunião n.º 2026/1"
  const partesIdentificacao = [];
  if (cidade) partesIdentificacao.push(`Edifício sito em ${cidade}`);
  if (numero) partesIdentificacao.push(`Reunião n.º ${numero}`);

  // "[Cidade], [data de emissão]"
  const localData = [cidade ? `${cidade},` : '', dataEmissaoLonga].filter(Boolean).join(' ');

  // Texto introdutório (art. 1431.º e 1432.º CC + Lei 8/2022)
  const situadoEm = cidade ? ` do prédio sito em ${cidade}` : '';
  const quando =
    dia && dataLonga
      ? ` que se realizará no próximo dia ${dia}, ${dataLonga}`
      : dataLonga
        ? ` que se realizará no dia ${dataLonga}`
        : ' que se realizará';
  const introducao =
    'Nos termos do disposto nos artigos 1431.º e 1432.º do Código Civil, com as alterações ' +
    'introduzidas pela Lei n.º 8/2022, de 10 de janeiro, venho pela presente convocá-lo(a) ' +
    `para a Assembleia Geral ${tipoLabel} do Condomínio${situadoEm},` +
    `${quando}, pelas ${hora || '—'}, em ${local || 'a designar'}, com a seguinte ordem de trabalhos:`;

  const titulo = `Convocatória para Assembleia Geral ${tipoLabel}`;

  return {
    // Dados (para a pré-visualização e para o PDF)
    edificioNome,
    morada,
    codigoPostal,
    cidade,
    administracaoNome,
    numero,
    tipo,
    tipoLabel,
    data,
    dataEmissao,
    hora,
    horaSegunda,
    local,
    emailAutorizado,
    pontos,

    // Derivados
    dataLonga,
    dataEmissaoLonga,
    dia,
    localData,

    // Textos já compostos (partilha entre pré-visualização e PDF)
    textos: {
      saudacaoCabecalho: 'Exmo.(a) Sr.(a) Condómino(a)',
      rotuloAssunto: 'ASSUNTO',
      titulo,
      linhaIdentificacao: partesIdentificacao.join(' · '),
      localData,
      saudacao: 'Exmo.(a) Senhor(a),',
      introducao,
      tituloOrdem: 'ORDEM DE TRABALHOS',
      semPontos: 'Sem pontos definidos.',
      tituloQuorum: 'QUÓRUM E SEGUNDA CONVOCATÓRIA',
      subtituloPrimeira: 'Primeira convocatória',
      textoPrimeira: textoPrimeiraConvocatoria(),
      subtituloSegunda: 'Segunda convocatória',
      textoSegunda: textoSegundaConvocatoria(horaSegunda),
      textoRepresentacao: textoRepresentacao(),
      fechoComparacia: 'Agradecendo a comparência,',
      fechoCumprimentos: 'Com os melhores cumprimentos,',
      assinaturaRotulo: 'A Administração do Condomínio',
      rodape:
        'Convocatória emitida através da plataforma de gestão de condomínios ao abrigo ' +
        'do Art. 1432.º CC e Lei n.º 8/2022.',
      rodapeEmail: 'Comunicação por email autorizada em assembleia anterior.',
    },
  };
}

module.exports = {
  TIPOS,
  parseHora,
  somarMinutos,
  hojeInput,
  normalizarPontos,
  construirDocumento,
  textoPrimeiraConvocatoria,
  textoSegundaConvocatoria,
  textoRepresentacao,
};
