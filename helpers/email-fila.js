// ─────────────────────────────────────────────────────────────────────
// Fila de email — estados, retry controlado e reenvio manual.
//
// Estados: pendente → a_enviar → enviado | erro
//          pendente/erro → cancelado (manual)
//
// Regras:
//  · nunca envia o mesmo email duas vezes (só pendentes/erros são lidos);
//  · retry até MAX_TENTATIVAS (o scheduler volta a processar os "erro");
//  · se o processo cair com um email em "a_enviar", é retomado como
//    pendente após um período de segurança (sem duplicar envios reais).
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { EmailFila } = require('../models');
const { sendMail } = require('./mailer');

const MAX_TENTATIVAS = 3;
const STALE_MS = 5 * 60 * 1000; // "a_enviar" preso há mais de 5 min → repõe pendente

function escaparHtml(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
}

// Enfileira um email normal da aplicação.
async function enfileirarEmail({
  destinatario_email,
  destinatario_nome,
  assunto,
  corpo,
  corpo_html,
  documento_id,
  aviso_id,
  entidade_tipo,
  entidade_id,
  userId,
  data_prevista,
  tipo = 'normal',
}) {
  if (!destinatario_email) throw new Error('Destinatário sem email.');
  return EmailFila.create({
    destinatario_email,
    destinatario_nome: destinatario_nome || null,
    assunto,
    corpo: corpo || null,
    corpo_html: corpo_html || null,
    documento_id: documento_id || null,
    aviso_id: aviso_id || null,
    entidade_tipo: entidade_tipo || null,
    entidade_id: entidade_id || null,
    user_id: userId || null,
    tipo: tipo === 'teste' ? 'teste' : 'normal',
    data_prevista: data_prevista || new Date(),
    estado: 'pendente',
    tentativas: 0,
  });
}

async function enviarItem(item) {
  await item.update({ estado: 'a_enviar' });
  const res = await sendMail({
    to: item.destinatario_email,
    subject: item.assunto,
    text: item.corpo || '',
    html: item.corpo_html || escaparHtml(item.corpo),
  });
  if (res.enviado) {
    await item.update({ estado: 'enviado', data_enviada: new Date(), message_id: res.message_id || res.messageId || null, erro: null });
    return { ok: true, item };
  }
  throw new Error(res.motivo || 'Falha ao enviar');
}

// Processa um lote da fila (pendentes, erros com retry disponível e
// "a_enviar" presos por falha de processo).
async function processarFilaEmail(limite = 20) {
  // Recupera itens presos em "a_enviar" (processo caiu a meio do envio).
  const presos = await EmailFila.findAll({
    where: { estado: 'a_enviar', updated_at: { [Op.lt]: new Date(Date.now() - STALE_MS) } },
  });
  for (const p of presos) {
    await p.update({ estado: 'pendente', erro: 'Envio interrompido; reposto para nova tentativa.' });
  }

  const agora = new Date();
  const pendentes = await EmailFila.findAll({
    where: {
      estado: { [Op.in]: ['pendente', 'erro'] },
      tentativas: { [Op.lt]: MAX_TENTATIVAS },
      data_prevista: { [Op.lte]: agora },
    },
    order: [['id', 'ASC']],
    limit: limite,
  });

  let enviados = 0;
  let erros = 0;
  for (const item of pendentes) {
    try {
      await enviarItem(item);
      enviados++;
    } catch (err) {
      const tentativas = (item.tentativas || 0) + 1;
      await item.update({ estado: 'erro', erro: err.message, tentativas });
      erros++;
    }
  }
  return { processados: pendentes.length, enviados, erros, presosRecuperados: presos.length };
}

// Envia imediatamente UM email da fila (ação "Reenviar" na central).
async function processarEmailUnico(id) {
  const item = await EmailFila.findByPk(id);
  if (!item) throw new Error('Registo de email não encontrado.');
  if (item.estado === 'enviado') throw new Error('Este email já foi enviado.');
  await enviarItem(item);
  return item;
}

// Repõe um email como pendente para nova tentativa manual.
async function reenviarEmail(id) {
  const item = await EmailFila.findByPk(id);
  if (!item) throw new Error('Registo de email não encontrado.');
  if (item.estado === 'enviado') {
    await item.update({ estado: 'pendente', tentativas: 0, erro: null, data_enviada: null, message_id: null });
  } else {
    await item.update({ estado: 'pendente', tentativas: 0, erro: null });
  }
  return item;
}

// Cancela um email ainda não enviado.
async function cancelarEmail(id) {
  const item = await EmailFila.findByPk(id);
  if (!item) throw new Error('Registo de email não encontrado.');
  if (item.estado === 'enviado') throw new Error('Este email já foi enviado — não pode ser cancelado.');
  await item.update({ estado: 'cancelado' });
  return item;
}

// Contagens para a central de emails.
async function contarFila() {
  const [total, pendentes, enviados, erros, cancelados] = await Promise.all([
    EmailFila.count(),
    EmailFila.count({ where: { estado: { [Op.in]: ['pendente', 'a_enviar'] } } }),
    EmailFila.count({ where: { estado: 'enviado' } }),
    EmailFila.count({ where: { estado: 'erro' } }),
    EmailFila.count({ where: { estado: 'cancelado' } }),
  ]);
  return { total, pendentes, enviados, erros, cancelados };
}

module.exports = {
  enfileirarEmail,
  processarFilaEmail,
  processarEmailUnico,
  reenviarEmail,
  cancelarEmail,
  contarFila,
  MAX_TENTATIVAS,
};
