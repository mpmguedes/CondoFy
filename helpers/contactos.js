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

// ─────────────────────────────────────────────────────────────────────
// Ficha de edição — leitura do formulário.
// ─────────────────────────────────────────────────────────────────────

// Normaliza um valor do body (string única ou array de strings repetidas).
function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

// Lê um grupo contactos[email] / contactos[telefone] submetido pela ficha:
//   contactos[<tipo>][valor][]    — valores (ordem = ordem das linhas)
//   contactos[<tipo>][etiqueta][] — etiquetas opcionais (alinhadas por índice)
//   contactos[<tipo>][principal]  — índice da linha marcada como principal
// Linhas completamente vazias são ignoradas.
function lerGrupoContactos(grupo) {
  if (!grupo || typeof grupo !== 'object') return [];
  const valores = asArray(grupo.valor);
  const etiquetas = asArray(grupo.etiqueta);
  const principal = grupo.principal;
  const idxPrincipal = Array.isArray(principal) ? principal[0] : principal;
  return valores
    .map((valor, i) => ({
      valor: String(valor ?? '').trim(),
      etiqueta: String(etiquetas[i] ?? '').trim(),
      principal: idxPrincipal !== undefined && String(idxPrincipal) === String(i),
    }))
    .filter((c) => c.valor);
}

// Email razoavelmente simples (preenchido → tem de ter @ e domínio).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lê os contactos submetidos na ficha do condómino.
// Formato novo: body.contactos = { email: {...}, telefone: {...} }.
// Compatibilidade: se o body vier da ficha antiga (campos únicos email/telefone,
// sem body.contactos), converte esses valores em contactos principais — nunca se
// perde o que já estava preenchido nem se duplica ao guardar.
function parseContactosForm(body = {}) {
  if (body.contactos && typeof body.contactos === 'object') {
    return {
      emails: lerGrupoContactos(body.contactos.email),
      telefones: lerGrupoContactos(body.contactos.telefone),
    };
  }
  const emails = [];
  const telefones = [];
  const email = String(body.email ?? '').trim();
  const telefone = String(body.telefone ?? '').trim();
  if (email) emails.push({ valor: email, etiqueta: '', principal: true });
  if (telefone) telefones.push({ valor: telefone, etiqueta: '', principal: true });
  return { emails, telefones };
}

// Validação da ficha: emails com formato válido quando preenchidos (linhas
// vazias já foram ignoradas); telefones sem validação rígida (formatos PT
// variados são aceites). Devolve null quando está tudo válido.
function validarContactos({ emails = [], telefones = [] } = {}) {
  for (const c of emails) {
    if (!EMAIL_RE.test(c.valor)) return `Email inválido: ${c.valor}`;
  }
  return null;
}

// Contactos prontos para renderizar na ficha: usa os registos existentes em
// contactos_pessoa; se um tipo não tiver registos mas existir o valor legado
// em pessoa.email/telefone, apresenta esse valor como contacto (principal).
async function contactosParaForm(pessoa) {
  const { emails, telefones } = await listarContactos(pessoa.id);
  const mapa = (lista) =>
    lista.map((c) => ({
      id: c.id,
      valor: c.valor,
      etiqueta: c.etiqueta || '',
      principal: Boolean(c.principal),
    }));
  const emailsVista = mapa(emails);
  const telefonesVista = mapa(telefones);
  if (!emailsVista.length && pessoa.email) {
    emailsVista.push({ id: null, valor: String(pessoa.email), etiqueta: '', principal: true, legado: true });
  }
  if (!telefonesVista.length && pessoa.telefone) {
    telefonesVista.push({ id: null, valor: String(pessoa.telefone), etiqueta: '', principal: true, legado: true });
  }
  return { emails: emailsVista, telefones: telefonesVista };
}

// Substitui os contactos de uma pessoa pela lista submetida na ficha e
// sincroniza pessoas.email/telefone com o contacto principal de cada tipo.
// emails/telefones: [{ id?, valor, etiqueta?, principal }] — um principal por tipo;
// se nenhum estiver marcado, o primeiro torna-se principal (substituição
// idempotente ao guardar a ficha).
async function sincronizarContactosPessoa(pessoa, emails = [], telefones = [], condominioId = null) {
  await ContactoPessoa.destroy({ where: { pessoa_id: pessoa.id } });

  // Multi-condomínio: o contacto herda o condomínio da pessoa (carregada da BD)
  // ou do contexto ativo da rota; fluxos legados sem valor ficam com null e o
  // backfill da migração trata de os preencher.
  const cid = condominioId || (pessoa && pessoa.condominio_id) || null;

  const montar = (tipo, lista) => {
    const temPrincipal = lista.some((c) => c.principal);
    return lista
      .map((c, i) => ({
        condominio_id: cid,
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
  parseContactosForm,
  validarContactos,
  contactosParaForm,
};
