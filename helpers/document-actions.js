// ─────────────────────────────────────────────────────────────────────
// Ações sobre documentos — camada transversal.
//
// Reutilizável por qualquer módulo que tenha um documento/PDF:
//  · guardarDocumentoNoDrive(...)  → Google Drive (estado no model Documento)
//  · enviarDocumentoPorEmail(...)  → fila normal ou envio imediato
//  · guardarEEnviarDocumento(...)  → as duas, com resultado independente
//  · obterLinkDrive(...)           → link público do ficheiro no Drive
//
// Nenhuma destas operações é obrigatória para gerar/utilizar um PDF
// localmente; falhas de Drive/email nunca bloqueiam a aplicação.
// ─────────────────────────────────────────────────────────────────────
const { Documento, EmailFila } = require('../models');
const drive = require('./drive');
const mailer = require('./mailer');
const { enfileirarEmail } = require('./email-fila');
const { audit } = require('./audit');

function anoAtual(data) {
  const d = data ? new Date(data) : new Date();
  return isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
}

function auditSafe(params) {
  if (!params.userId) return Promise.resolve();
  return audit(params).catch(() => {});
}

// Aceita: 'a@x.pt,b@y.pt', 'a@x.pt; b@y.pt', ['a@x.pt'], [{email,nome}]
function normalizarDestinatarios(input) {
  const lista = Array.isArray(input) ? input : [input];
  const unicos = new Map();
  for (const item of lista) {
    if (!item) continue;
    if (typeof item === 'string') {
      item
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((email) => unicos.set(email.toLowerCase(), { email, nome: null }));
    } else if (item.email) {
      const email = String(item.email).trim();
      if (email) unicos.set(email.toLowerCase(), { email, nome: item.nome || null });
    }
  }
  return [...unicos.values()];
}

// ── Google Drive ────────────────────────────────────────────────────
// Guarda um buffer (PDF/doc) no Drive e regista/atualiza o Documento.
// Devolve sempre { ok, documento?, driveFileId?, url?, erro? }.
async function guardarDocumentoNoDrive({
  tipo,
  nome,
  buffer,
  mimeType = 'application/pdf',
  pasta,
  ano,
  data,
  documentoId,
  userId,
}) {
  if (!drive.isConfigured()) {
    return { ok: false, erro: 'Google Drive não está ligado (Configuração → Google Drive).' };
  }
  try {
    const pastaId = await drive.pastaParaDocumento(tipo, ano || anoAtual(data));
    const up = await drive.uploadArquivo({
      nome,
      mimeType,
      buffer,
      parentFolderId: pastaId,
    });

    let documento = null;
    if (documentoId) documento = await Documento.findByPk(documentoId);
    if (documento) {
      await documento.update({
        drive_file_id: up.driveFileId,
        url: up.url,
        mime_type: mimeType,
        tamanho: up.tamanho,
        drive_status: 'guardado',
        drive_folder_id: pastaId,
        drive_erro: null,
        drive_uploaded_at: new Date(),
      });
    } else {
      documento = await Documento.create({
        tipo: tipo || 'outro',
        nome,
        pasta: pasta || 'outros',
        drive_file_id: up.driveFileId,
        drive_folder_id: pastaId,
        url: up.url,
        mime_type: mimeType,
        tamanho: up.tamanho,
        data: data || new Date(),
        drive_status: 'guardado',
        drive_uploaded_at: new Date(),
        created_by: userId || null,
      });
    }

    await auditSafe({
      userId,
      acao: 'guardar_documento_drive',
      entidade: 'Documento',
      entidadeId: documento.id,
      detalhes: { ok: true, tipo, driveFileId: up.driveFileId },
    });
    return { ok: true, documento, driveFileId: up.driveFileId, url: up.url };
  } catch (err) {
    const erro = String((err && err.message) || err || 'erro desconhecido');
    if (documentoId) {
      await Documento.update({ drive_status: 'erro', drive_erro: erro }, { where: { id: documentoId } }).catch(() => {});
    }
    await auditSafe({
      userId,
      acao: 'documento_drive_erro',
      entidade: 'Documento',
      entidadeId: documentoId || null,
      detalhes: { erro },
    });
    return { ok: false, erro };
  }
}

// Marca um documento como pendente de envio (antes do upload em segundo plano).
async function marcarDocumentoDrivePendente(documentoId) {
  if (!documentoId) return;
  await Documento.update({ drive_status: 'pendente', drive_erro: null }, { where: { id: documentoId } }).catch(() => {});
}

// ── Email ───────────────────────────────────────────────────────────
// Envia (ou enfileira) um documento por email.
//  · imediato=false (padrão): cria registos na fila — sem anexos binários,
//    inclui o link do documento quando disponível.
//  · imediato=true: envia já (pode levar anexos binários) e regista o
//    resultado na fila (enviado/erro) para histórico.
async function enviarDocumentoPorEmail({
  destinatarios,
  assunto,
  mensagem,
  documentoId,
  avisoId,
  userId,
  imediato = false,
  anexos = [],
  corpoHtml,
}) {
  const lista = normalizarDestinatarios(destinatarios);
  if (!lista.length) return { ok: false, erro: 'Nenhum destinatário com email válido.', resultados: [] };

  let documento = null;
  if (documentoId) documento = await Documento.findByPk(documentoId).catch(() => null);
  const linkDoc = documento && documento.url ? documento.url : null;
  const corpo = [mensagem || '', linkDoc ? `\n\nDocumento: ${linkDoc}` : ''].filter(Boolean).join('');

  const resultados = [];
  for (const dest of lista) {
    if (imediato) {
      const reg = {
        destinatario_email: dest.email,
        destinatario_nome: dest.nome,
        assunto,
        corpo: corpo || mensagem || null,
        documento_id: documentoId || null,
        aviso_id: avisoId || null,
        tipo: 'normal',
      };
      try {
        const res = await mailer.sendMail({
          to: dest.email,
          subject: assunto,
          text: mensagem || '',
          html: corpoHtml || null,
          attachments: anexos,
        });
        await EmailFila.create({
          ...reg,
          estado: 'enviado',
          data_enviada: new Date(),
          message_id: res.messageId || null,
          tentativas: 1,
        });
        resultados.push({ email: dest.email, nome: dest.nome, ok: true, messageId: res.messageId || null });
      } catch (err) {
        await EmailFila.create({ ...reg, estado: 'erro', erro: err.message, tentativas: 1 });
        resultados.push({ email: dest.email, nome: dest.nome, ok: false, erro: err.message });
      }
    } else {
      await enfileirarEmail({
        destinatario_email: dest.email,
        destinatario_nome: dest.nome,
        assunto,
        corpo,
        corpo_html: corpoHtml || null,
        documento_id: documentoId || null,
        aviso_id: avisoId || null,
      });
      resultados.push({ email: dest.email, nome: dest.nome, ok: true, enfileirado: true });
    }
  }

  const enviados = resultados.filter((r) => r.ok).length;
  const falhas = resultados.length - enviados;
  await auditSafe({
    userId,
    acao: imediato ? 'enviar_documento_email' : 'enfileirar_documento_email',
    entidade: 'Documento',
    entidadeId: documentoId || null,
    detalhes: { destinatarios: resultados.length, enviados, falhas },
  });
  return { ok: falhas === 0, enviados, falhas, resultados };
}

// ── Drive + Email (independentes) ───────────────────────────────────
async function guardarEEnviarDocumento(opcoesDrive, opcoesEmail) {
  const [driveResultado, emailResultado] = await Promise.all([
    guardarDocumentoNoDrive(opcoesDrive),
    enviarDocumentoPorEmail(opcoesEmail),
  ]);
  return { drive: driveResultado, email: emailResultado };
}

// ── Links / estado ──────────────────────────────────────────────────
function obterLinkDrive(documento) {
  return documento && (documento.url || null);
}

async function estadoDriveDoDocumento(documentoId) {
  const doc = await Documento.findByPk(documentoId, {
    attributes: ['drive_status', 'drive_erro', 'drive_uploaded_at', 'drive_file_id', 'url'],
  });
  if (!doc) return null;
  return doc.toJSON();
}

module.exports = {
  guardarDocumentoNoDrive,
  marcarDocumentoDrivePendente,
  enviarDocumentoPorEmail,
  guardarEEnviarDocumento,
  obterLinkDrive,
  estadoDriveDoDocumento,
  normalizarDestinatarios,
  anoAtual,
};
