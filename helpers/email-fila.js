const { Op } = require('sequelize');
const { EmailFila } = require('../models');
const { sendMail } = require('./mailer');

const MAX_TENTATIVAS = 3;

async function enfileirarEmail({
  destinatario_email,
  destinatario_nome,
  assunto,
  corpo,
  documento_id,
  aviso_id,
  data_prevista,
}) {
  return EmailFila.create({
    destinatario_email,
    destinatario_nome: destinatario_nome || null,
    assunto,
    corpo: corpo || null,
    documento_id: documento_id || null,
    aviso_id: aviso_id || null,
    data_prevista: data_prevista || new Date(),
    estado: 'pendente',
    tentativas: 0,
  });
}

// Processa um lote da fila (envia emails pendentes com data prevista atingida).
async function processarFilaEmail(limite = 20) {
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
      const res = await sendMail({
        to: item.destinatario_email,
        subject: item.assunto,
        text: item.corpo,
        html: item.corpo,
      });
      if (res.enviado) {
        await item.update({ estado: 'enviado', data_enviada: new Date() });
        enviados++;
      } else {
        await item.update({ estado: 'erro', erro: res.motivo, tentativas: item.tentativas + 1 });
        erros++;
      }
    } catch (err) {
      await item.update({ estado: 'erro', erro: err.message, tentativas: item.tentativas + 1 });
      erros++;
    }
  }
  return { processados: pendentes.length, enviados, erros };
}

module.exports = { enfileirarEmail, processarFilaEmail, MAX_TENTATIVAS };
