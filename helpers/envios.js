// ─────────────────────────────────────────────────────────────────────
// Envios — consulta de histórico por entidade e prevenção de duplicados.
//
// O histórico de envios vive em EmailFila (única fonte), ligado às
// entidades através de documento_id/aviso_id ou dos campos genéricos
// entidade_tipo/entidade_id (ex.: Quota, Pagamento, Fornecedor).
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { EmailFila } = require('../models');

const ESTADOS_NAO_ENVIADOS = ['pendente', 'erro'];

// Todos os envios de uma entidade (histórico, do mais recente ao mais antigo).
async function historicoEntidade({ entidadeTipo, entidadeId, documentoId, avisoId, limite = 50 }) {
  const where = [];
  if (entidadeTipo && entidadeId) where.push({ entidade_tipo: entidadeTipo, entidade_id: entidadeId });
  if (documentoId) where.push({ documento_id: documentoId });
  if (avisoId) where.push({ aviso_id: avisoId });
  if (!where.length) return [];
  return EmailFila.findAll({
    where: { [Op.or]: where },
    order: [['id', 'DESC']],
    limit: limite,
  });
}

// O último envio concluído de uma entidade para um destinatário (ou null).
async function ultimoEnvioConcluido({ entidadeTipo, entidadeId, email, documentoId }) {
  const where = { estado: 'enviado' };
  if (email) where.destinatario_email = email;
  const grupo = [];
  if (entidadeTipo && entidadeId) grupo.push({ entidade_tipo: entidadeTipo, entidade_id: entidadeId });
  if (documentoId) grupo.push({ documento_id: documentoId });
  if (!grupo.length) return null;
  where[Op.or] = grupo;
  return EmailFila.findOne({ where, order: [['data_enviada', 'DESC'], ['id', 'DESC']] });
}

// Existe envio (concluído OU em curso/pendente) para a entidade/destinatário?
async function existeEnvioPara({ entidadeTipo, entidadeId, email, documentoId, incluirPendentes = true }) {
  const estados = incluirPendentes ? ['pendente', 'a_enviar', 'enviado', 'erro'] : ['enviado'];
  const where = { estado: { [Op.in]: estados } };
  if (email) where.destinatario_email = email;
  const grupo = [];
  if (entidadeTipo && entidadeId) grupo.push({ entidade_tipo: entidadeTipo, entidade_id: entidadeId });
  if (documentoId) grupo.push({ documento_id: documentoId });
  if (!grupo.length) return false;
  where[Op.or] = grupo;
  const reg = await EmailFila.findOne({ where, attributes: ['id', 'estado'] });
  return Boolean(reg);
}

module.exports = { historicoEntidade, ultimoEnvioConcluido, existeEnvioPara, ESTADOS_NAO_ENVIADOS };
