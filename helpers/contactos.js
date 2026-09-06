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

// Substitui os contactos de uma pessoa pela lista submetida na ficha e
// sincroniza pessoas.email/telefone com o contacto principal de cada tipo.
// emails/telefones: [{ id?, valor, etiqueta?, principal }] — um principal por tipo;
// se nenhum estiver marcado, o primeiro torna-se principal (substituição
// idempotente ao guardar a ficha).
async function sincronizarContactosPessoa(pessoa, emails = [], telefones = []) {
  await ContactoPessoa.destroy({ where: { pessoa_id: pessoa.id } });

  const montar = (tipo, lista) => {
    const temPrincipal = lista.some((c) => c.principal);
    return lista
      .map((c, i) => ({
        pessoa_id: pessoa.id,
        tipo,
        valor: String(c.valor || '').trim(),
        etiqueta: String(c.etiqueta || '').trim() || null,
        principal: temPrincipal ? Boolean(c.principal) : i === 0,
        ativo: true,
      }))
      .filter((r) => r.valor);
  };
  const linhas = [...montar('email', emails), ...montar('telefone', telefones)];
  if (linhas.length) await ContactoPessoa.bulkCreate(linhas);

  const emailPrincipal = emails.find((c) => c.principal)?.valor || emails[0]?.valor || null;
  const telefonePrincipal = telefones.find((c) => c.principal)?.valor || telefones[0]?.valor || null;
  await pessoa.update({
    email: emailPrincipal ? String(emailPrincipal).trim() : null,
    telefone: telefonePrincipal ? String(telefonePrincipal).trim() : null,
  });
  return { email: emailPrincipal, telefone: telefonePrincipal };
}

module.exports = {
  emailsPreferidosPorPessoa,
  emailPreferido,
  telefonePreferido,
  listarContactos,
  sincronizarContactosPessoa,
};
