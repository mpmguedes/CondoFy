// ─────────────────────────────────────────────────────────────────────
// Enfileiramento de um AVISO — motor único (destinatários → deduplicação →
// templates → fila).
//
// Porque existe: esta regra vivia DENTRO do handler `POST /avisos/:id/enviar`.
// O disparo automático dos avisos PROGRAMADOS (P29) precisa exatamente da mesma
// regra — anexo, link, condomínio do remetente, deduplicação — e uma segunda
// implementação divergiria à primeira alteração. Passa a viver aqui, e tanto a
// rota manual como o job chamam esta função: não há dois motores.
//
// ⛔ Não inventa política de envio: limita-se a enfileirar. Quem decide SE
// deve enviar (ação do administrador, preferência de notificação, data
// programada) é quem chama. A fila, as 3 tentativas e a recuperação de
// `a_enviar` órfão continuam a ser de `helpers/email-fila.js`.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { AvisoDestinatario, Pessoa, Documento, EmailFila } = require('../models');
const { enfileirarEmail } = require('./email-fila');
const { compor: comporEmail } = require('./email-templates');
const { getCondominio } = require('./condominio');
const drive = require('./drive');
// Link do documento para email: sempre uma rota do GesCondu (nunca o link do
// fornecedor de armazenamento).
const { urlParaEmail } = require('./documentos-acesso');

// Estados que significam «este destinatário já foi tratado».
//
//   · EM_CURSO  — o envio está na fila ou já saiu. É o critério do envio
//     MANUAL: depois de um `erro` ou de um `cancelado`, o administrador pode
//     voltar a carregar em «Enviar» e a mensagem volta à fila — é uma ação
//     explícita dele.
//   · DESPACHADOS — inclui `erro` e `cancelado`. É o critério do disparo
//     AUTOMÁTICO: um aviso programado é despachado UMA vez; um `cancelado`
//     foi cancelado de propósito e o job não o pode ressuscitar; e um `erro`
//     já esgotou as 3 tentativas da fila, pelo que o job não o repõe
//     diariamente em ciclo. Sem esta distinção, o job diário reenfileirava
//     para sempre tudo o que tivesse falhado.
const ESTADOS_EM_CURSO = ['pendente', 'a_enviar', 'enviado'];
const ESTADOS_DESPACHADOS = ['pendente', 'a_enviar', 'enviado', 'erro', 'cancelado'];

// Um link sem esquema (`/documentos/...`) não é clicável a partir de um cliente
// de email. Quando não há base absoluta conhecida, omite-se o link — nunca se
// envia um endereço quebrado.
function linkAbsoluto(url) {
  return url && /^https?:\/\//i.test(String(url)) ? url : null;
}

// Enfileira o aviso para os destinatários ainda não tratados.
//
// Devolve `{ enfileirados, total, jaDespachados, semEmail, comAnexo, documento }`.
// Nunca lança por causa de um destinatário sem email: simplesmente não o conta.
async function enfileirarAviso({
  aviso,
  condominioId,
  userId = null,
  baseUrl = '',
  estadosJaDespachados = ESTADOS_EM_CURSO,
} = {}) {
  if (!aviso || !aviso.id) throw new Error('enfileirarAviso: aviso inválido');
  const cid = Number(condominioId);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('enfileirarAviso: condominioId inválido');

  const destinatarios = await AvisoDestinatario.findAll({
    where: { aviso_id: aviso.id },
    include: [{ model: Pessoa, as: 'pessoa' }],
  });

  // Deduplicação: não volta a enfileirar para quem já está tratado.
  const existentes = await EmailFila.findAll({
    where: {
      aviso_id: aviso.id,
      estado: { [Op.in]: estadosJaDespachados },
    },
    attributes: ['destinatario_email'],
  });
  const jaTratados = new Set(existentes.map((e) => String(e.destinatario_email).toLowerCase()));

  const lista = destinatarios
    .filter((d) => d.pessoa && d.pessoa.email)
    .map((d) => ({ email: d.pessoa.email, nome: d.pessoa.nome }))
    .filter((d) => !jaTratados.has(String(d.email).toLowerCase()));

  const semEmail = destinatarios.length - lista.length - jaTratados.size;

  if (!lista.length) {
    return { enfileirados: 0, total: destinatarios.length, jaDespachados: jaTratados.size, semEmail: Math.max(0, semEmail), comAnexo: false, documento: null };
  }

  const mensagem = aviso.mensagem || '';

  // Anexo: o documento associado tem de pertencer ao condomínio do aviso
  // (guarda IDOR) — a associação pode vir pré-carregada, mas nunca se confia
  // nela sem reconfirmar o `condominio_id`.
  let doc = aviso.documento || null;
  if (doc && Number(doc.condominio_id) !== cid) doc = null;
  if (!doc && aviso.documento_id) {
    doc = await Documento.findOne({ where: { id: aviso.documento_id, condominio_id: cid } });
  }

  let anexoBuffer = null;
  let anexoNome = null;
  if (doc && doc.drive_file_id && drive.isConfigured(cid)) {
    try {
      anexoBuffer = await drive.descargarArquivo(doc.drive_file_id, cid);
      anexoNome = String(doc.nome || '').trim() || 'documento.pdf';
    } catch (err) {
      // Sem ficheiro não se bloqueia o aviso: segue sem anexo (com link, se houver).
      anexoBuffer = null;
    }
  }
  const comAnexo = Boolean(anexoBuffer);

  const cond = await getCondominio({ id: cid });
  const condNome = (cond && String(cond.designacao || '').trim()) || '';
  const adminNome = (cond && String(cond.administracao_nome || '').trim()) || '';

  // Destinatários que têm conta no GesCondu levam link interno (autenticado);
  // os restantes levam link temporário assinado. O conjunto é do condomínio.
  const emailsCondominos = new Set(
    (await Pessoa.findAll({
      where: { condominio_id: cid, email: { [Op.ne]: null } },
      attributes: ['email'],
    }).catch(() => [])).map((p) => String(p.email).trim().toLowerCase())
  );

  let enfileirados = 0;
  for (const dest of lista) {
    const urlOnline = doc
      ? linkAbsoluto(
          urlParaEmail({
            documento: doc,
            baseUrl,
            destinatarioInterno: emailsCondominos.has(String(dest.email).trim().toLowerCase()),
          })
        )
      : null;
    const tpl = mensagem
      ? comporEmail('generico', {
          destinatarioNome: dest.nome,
          condominio: condNome,
          administracao: adminNome,
          titulo: aviso.assunto,
          mensagem,
          urlOnline,
          urlTexto: 'Consultar aviso online',
        })
      : comporEmail('aviso', {
          destinatarioNome: dest.nome,
          condominio: condNome,
          administracao: adminNome,
          tituloAviso: aviso.assunto,
          urlOnline,
          anexo: comAnexo,
        });
    await enfileirarEmail({
      destinatario_email: dest.email,
      destinatario_nome: dest.nome,
      assunto: tpl.assunto,
      corpo: tpl.text,
      corpo_html: tpl.html,
      documento_id: aviso.documento_id || null,
      aviso_id: aviso.id,
      entidade_tipo: 'Aviso',
      entidade_id: aviso.id,
      condominioId: cid,
      userId,
      anexoNome: comAnexo ? anexoNome : null,
      anexoBuffer: comAnexo ? anexoBuffer : null,
    });
    enfileirados++;
  }

  return {
    enfileirados,
    total: destinatarios.length,
    jaDespachados: jaTratados.size,
    semEmail: Math.max(0, destinatarios.length - lista.length - jaTratados.size),
    comAnexo,
    documento: doc ? doc.id : null,
  };
}

module.exports = { enfileirarAviso, ESTADOS_EM_CURSO, ESTADOS_DESPACHADOS, linkAbsoluto };
