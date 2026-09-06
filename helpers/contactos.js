// ─────────────────────────────────────────────────────────────────────
// Contactos flexíveis por pessoa (múltiplos emails/telefones).
// Regras de resolução de email para comunicações automáticas:
//  · usa o contacto ativo do tipo email marcado como "principal";
//  · sem principal, usa o primeiro email ativo;
//  · nunca envia para todos os emails de uma pessoa automaticamente.
// Os campos legados pessoa.email/telefone continuam como fonte de
// compatibilidade quando a tabela de contactos não tiver resultados.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { ContactoPessoa } = require('../models');

// Mapa pessoa_id → email preferido (principal → primeiro ativo).
async function emailsPreferidosPorPessoa(pessoaIds) {
  const mapa = new Map();
  const ids = (pessoaIds || []).filter(Boolean);
  if (!ids.length) return mapa;

  const contactos = await ContactoPessoa.findAll({
    where: { pessoa_id: { [Op.in]: ids }, tipo: 'email', ativo: true },
    order: [['principal', 'DESC'], ['id', 'ASC']],
  });
  for (const c of contactos) {
    if (!mapa.has(c.pessoa_id)) mapa.set(c.pessoa_id, String(c.valor).trim());
  }
  return mapa;
}

// Email preferido de uma pessoa (contacto principal → primeiro ativo →
// valor legado pessoa.email).
async function emailPreferido(pessoa) {
  if (!pessoa) return '';
  const mapa = await emailsPreferidosPorPessoa([pessoa.id]);
  const preferido = mapa.get(pessoa.id);
  if (preferido) return preferido;
  return pessoa.email ? String(pessoa.email).trim() : '';
}

// Telefone preferido de uma pessoa (principal → primeiro ativo → legado).
async function telefonePreferido(pessoa) {
  if (!pessoa) return '';
  const contacto = await ContactoPessoa.findOne({
    where: { pessoa_id: pessoa.id, tipo: 'telefone', ativo: true },
    order: [['principal', 'DESC'], ['id', 'ASC']],
  });
  if (contacto) return String(contacto.valor).trim();
  return pessoa.telefone ? String(pessoa.telefone).trim() : '';
}

// Lista de contactos de uma pessoa (agrupada por tipo), para a interface.
async function listarContactos(pessoaId) {
  const contactos = await ContactoPessoa.findAll({
    where: { pessoa_id: pessoaId },
    order: [['tipo', 'ASC'], ['principal', 'DESC'], ['id', 'ASC']],
  });
  return {
    emails: contactos.filter((c) => c.tipo === 'email'),
    telefones: contactos.filter((c) => c.tipo === 'telefone'),
  };
}

module.exports = { emailsPreferidosPorPessoa, emailPreferido, telefonePreferido, listarContactos };
