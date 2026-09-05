// ─────────────────────────────────────────────────────────────────────
// Templates de email — comunicações administrativas profissionais (PT-PT).
//
// Fonte única dos textos/assuntos dos emails do GesCondu. Cada tipo gera
// um assunto, uma versão HTML simples (compatível com clientes de email)
// e uma versão de texto simples, com saudação personalizada e assinatura
// baseada na administração/condomínio.
// ─────────────────────────────────────────────────────────────────────

// "Exmo./Exma. Senhor(a), João Silva," (neutro quando o nome não existe)
function saudacao(nome) {
  const limpo = String(nome || '').trim();
  return limpo
    ? `Exmo./Exma. Senhor(a) ${limpo},`
    : 'Exmo./Exma. Senhor(a),';
}

// Escapar texto para HTML simples.
function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function linha(html) {
  return `<p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;">${html}</p>`;
}

function linkHtml(url, texto) {
  return `<a href="${esc(url)}" style="color:#1a73e8;text-decoration:underline;">${esc(texto || url)}</a>`;
}

// Assinatura: "A Administração" + nome da administração + condomínio.
function assinatura({ administracao, condominio }) {
  const nome = String(administracao || '').trim() || 'A Administração';
  const linhas = [nome];
  if (String(condominio || '').trim()) linhas.push(String(condominio).trim());
  return { nome, texto: linhas.join('\n') };
}

// Corpo base em HTML com título, saudação, parágrafos, botão e assinatura.
function htmlBase({ titulo, saudacaoTexto, paragrafos, botoes = [], assinaturaBloco, nota }) {
  const botoesHtml = botoes.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;"><tr><td style="border-radius:6px;background:#1a73e8;"><a href="${botoes.map((b) => esc(b.url)).join('')}" style="display:inline-block;padding:10px 20px;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${esc(botoes[0].texto)}</a></td></tr></table>`
    : '';
  const assinaturaHtml = esc(assinaturaBloco.texto).replace(/\n/g, '<br/>');
  return (
    `<div style="background:#f4f5f7;padding:16px 8px;">` +
    `<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e5ea;border-radius:8px;overflow:hidden;">` +
    `<div style="padding:16px 24px;border-bottom:1px solid #e2e5ea;">` +
    `<span style="font-size:18px;font-weight:bold;color:#1c2733;font-family:Arial,Helvetica,sans-serif;">GesCondu</span>` +
    `<span style="float:right;font-size:12px;color:#6a7380;font-family:Arial,Helvetica,sans-serif;">${esc(titulo)}</span>` +
    `</div>` +
    `<div style="padding:20px 24px;">` +
    linha(saudacaoTexto) +
    paragrafos.map((p) => (p.html ? linha(p.html) : linha(esc(p)))).join('') +
    botoesHtml +
    (nota ? `<p style="margin:12px 0 0 0;font-size:12px;color:#6a7380;font-family:Arial,Helvetica,sans-serif;">${esc(nota)}</p>` : '') +
    `</div>` +
    `<div style="padding:16px 24px;border-top:1px solid #e2e5ea;color:#1c2733;font-family:Arial,Helvetica,sans-serif;">` +
    `<p style="margin:0 0 4px 0;">Com os melhores cumprimentos,</p>` +
    `<p style="margin:0;font-weight:bold;">${assinaturaHtml}</p>` +
    `</div>` +
    `</div></div>`
  );
}

function textoBase({ saudacaoTexto, paragrafos, botoes, assinaturaBloco }) {
  const linhas = [`${saudacaoTexto}\n`];
  for (const p of paragrafos) {
    const t = typeof p === 'string' ? p : p.texto;
    linhas.push(`${t}\n`);
  }
  if (botoes.length) {
    botoes.forEach((b) => linhas.push(`${b.texto}: ${b.url}`));
  }
  linhas.push('Com os melhores cumprimentos,');
  linhas.push(assinaturaBloco.texto);
  return linhas.join('\n\n');
}

// Constrói um email a partir de blocos (usado pelos templates específicos).
function montar({ assunto, saudacaoTexto, paragrafos, botoes = [], assinaturaBloco, titulo, nota }) {
  return {
    assunto,
    html: htmlBase({ titulo: titulo || assunto, saudacaoTexto, paragrafos, botoes, assinaturaBloco, nota }),
    text: textoBase({ saudacaoTexto, paragrafos, botoes, assinaturaBloco }),
  };
}

// ── Templates por tipo ──────────────────────────────────────────────
// contexto mínimo: { destinatarioNome, condominio, administracao, urlOnline }
function recibo({ destinatarioNome, condominio, administracao, valor, fração, data, referencia, urlOnline, anexo = true }) {
  const bloco = assinatura({ administracao, condominio });
  const paragrafos = [];
  paragrafos.push(`Vimos por este meio enviar o recibo referente ao pagamento efetuado no valor de <strong>${esc(valor)}</strong>.`);
  const extras = [];
  if (fração) extras.push(`Fração: ${esc(fração)}`);
  if (referencia) extras.push(`Recibo: ${esc(referencia)}`);
  if (data) extras.push(`Data do pagamento: ${esc(data)}`);
  if (extras.length) paragrafos.push(extras.join('<br/>'));
  paragrafos.push(anexo
    ? 'O respetivo recibo encontra-se em anexo a este email.'
    : 'Pode consultar o recibo através do link online (área do condómino no GesCondu).');
  const botoes = urlOnline ? [{ url: urlOnline, texto: 'Consultar recibo online' }] : [];
  return montar({
    assunto: `Recibo de pagamento — ${condominio || 'GesCondu'}`,
    titulo: 'Recibo',
    saudacaoTexto: saudacao(destinatarioNome),
    paragrafos,
    botoes,
    assinaturaBloco: bloco,
    nota: 'Pode também consultar este documento online através da sua área no GesCondu.',
  });
}

function aviso({ destinatarioNome, condominio, administracao, tituloAviso, urlOnline, anexo = true }) {
  const bloco = assinatura({ administracao, condominio });
  const assuntoTitulo = tituloAviso || 'Aviso';
  return montar({
    assunto: `${assuntoTitulo} — ${condominio || 'GesCondu'}`,
    titulo: assuntoTitulo,
    saudacaoTexto: saudacao(destinatarioNome),
    paragrafos: [
      `Vimos por este meio enviar o aviso referente ao condomínio <strong>${esc(condominio || '')}</strong>.`,
      anexo ? 'O documento encontra-se em anexo para sua consulta.' : 'Pode consultar o documento através do link online.',
    ],
    botoes: urlOnline ? [{ url: urlOnline, texto: 'Consultar aviso online' }] : [],
    assinaturaBloco: bloco,
    nota: 'Agradecemos desde já a sua atenção e colaboração.',
  });
}

function quota({ destinatarioNome, condominio, administracao, periodo, valor, urlOnline, atrasada, anexo = true }) {
  const bloco = assinatura({ administracao, condominio });
  const paragrafos = [];
  paragrafos.push(`Vimos por este meio enviar a informação referente à quota de condomínio do período <strong>${esc(periodo || '')}</strong>.`);
  if (valor) paragrafos.push(`<strong>Valor: ${esc(valor)}</strong>`);
  paragrafos.push(anexo
    ? 'O documento correspondente encontra-se em anexo.'
    : 'Pode consultar a informação através do link online (área do condómino no GesCondu).');
  const nota = atrasada
    ? 'A quota encontra-se em atraso. Agradecemos a regularização com a maior brevidade.'
    : 'Agradecemos a sua atenção e colaboração.';
  return montar({
    assunto: `Quota de condomínio — ${periodo || ''} — ${condominio || 'GesCondu'}`.replace(/\s{2,}/g, ' '),
    titulo: 'Quota de condomínio',
    saudacaoTexto: saudacao(destinatarioNome),
    paragrafos,
    botoes: urlOnline ? [{ url: urlOnline, texto: 'Consultar quota online' }] : [],
    assinaturaBloco: bloco,
    nota,
  });
}

function convocatoria({ destinatarioNome, condominio, administracao, urlOnline, anexo = true }) {
  const bloco = assinatura({ administracao, condominio });
  return montar({
    assunto: `Convocatória para Assembleia — ${condominio || 'GesCondu'}`,
    titulo: 'Convocatória',
    saudacaoTexto: saudacao(destinatarioNome),
    paragrafos: [
      `Vimos por este meio enviar a convocatória para a Assembleia do condomínio <strong>${esc(condominio || '')}</strong>.`,
      anexo
        ? 'A convocatória encontra-se em anexo a este email para sua consulta.'
        : 'Pode consultar a convocatória através do link online.',
    ],
    botoes: urlOnline ? [{ url: urlOnline, texto: 'Consultar assembleia' }] : [],
    assinaturaBloco: bloco,
    nota: 'Agradecemos a sua atenção e esperamos contar com a sua participação.',
  });
}

function documento({ destinatarioNome, condominio, administracao, nomeDocumento, urlOnline, anexo = true }) {
  const bloco = assinatura({ administracao, condominio });
  return montar({
    assunto: `Documento — ${condominio || 'GesCondu'}`,
    titulo: 'Documento',
    saudacaoTexto: saudacao(destinatarioNome),
    paragrafos: [
      `Vimos por este meio enviar o documento <strong>${esc(nomeDocumento || '')}</strong>, referente ao condomínio <strong>${esc(condominio || '')}</strong>.`,
      anexo ? 'O documento encontra-se em anexo a este email.' : 'Pode consultá-lo através do link online (área do condómino no GesCondu).',
    ],
    botoes: urlOnline ? [{ url: urlOnline, texto: 'Consultar documento' }] : [],
    assinaturaBloco: bloco,
    nota: 'Agradecemos a sua atenção.',
  });
}

function fornecedor({ fornecedorNome, destinatarioEmail, condominio, administracao, referencia, urlOnline }) {
  const bloco = assinatura({ administracao, condominio });
  const saudacaoTxt = saudacao(fornecedorNome);
  return montar({
    assunto: `Comprovativo de pagamento — ${condominio || 'GesCondu'}${referencia ? ` — ${referencia}` : ''}`,
    titulo: 'Comprovativo de pagamento',
    saudacaoTexto: saudacaoTxt,
    paragrafos: [
      'Enviamos em anexo o comprovativo da transferência bancária referente ao pagamento da fatura indicada.',
    ],
    botoes: urlOnline ? [{ url: urlOnline, texto: 'Ver comprovativo online' }] : [],
    assinaturaBloco: bloco,
    nota: `Destinatário: ${destinatarioEmail || ''}`,
  });
}

// Comunicação genérica (permite nota adicional do administrador).
function generico({ destinatarioNome, condominio, administracao, titulo, mensagem, urlOnline, urlTexto, nota }) {
  const bloco = assinatura({ administracao, condominio });
  return montar({
    assunto: `${titulo || 'Comunicação'} — ${condominio || 'GesCondu'}`,
    titulo: titulo || 'Comunicação',
    saudacaoTexto: saudacao(destinatarioNome),
    paragrafos: [mensagem || 'Vimos por este meio enviar a comunicação em anexo.'],
    botoes: urlOnline ? [{ url: urlOnline, texto: urlTexto || 'Consultar online' }] : [],
    assinaturaBloco: bloco,
    nota,
  });
}

const TIPOS = {
  recibo,
  aviso,
  quota,
  convocatoria,
  documento,
  fornecedor,
  generico,
};

function compor(tipo, dados) {
  const fn = TIPOS[tipo] || generico;
  return fn(dados);
}

// Nome de ficheiro normalizado para anexos.
function nomeFicheiro(tipo, dados = {}) {
  const limpar = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  let base = 'Documento';
  if (tipo === 'recibo') base = `Recibo_${limpar(dados.numero || dados.referencia || '')}`;
  else if (tipo === 'aviso') base = `Aviso_${limpar(dados.numero || dados.referencia || '')}`;
  else if (tipo === 'quota') base = `Quota_${dados.ano || ''}_${String(dados.mes || '').padStart(2, '0')}_${limpar(dados.fracao || '')}`;
  else if (tipo === 'convocatoria') base = `Convocatoria_Assembleia_${limpar(dados.data || '')}`;
  else if (tipo === 'documento') base = limpar(dados.nomeDocumento || 'Documento');
  else if (tipo === 'fornecedor') base = 'Comprovativo';
  return `${base || 'Documento'}.pdf`;
}

module.exports = { compor, saudacao, assinatura, nomeFicheiro, TIPOS };
