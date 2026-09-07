const { Op } = require('sequelize');
const { Pessoa, Fracao, FracaoPessoa } = require('../models');
const { emailsPreferidosPorPessoa } = require('./contactos');

// Resolve destinatários de um aviso numa lista única de {pessoa_id, email, nome}.
// O email é o preferido do condómino (contacto principal → primeiro ativo →
// email legado), mantendo compatibilidade com os dados existentes.
// selecao = { modo: 'todos' | 'fracoes' | 'pessoas', fracoes: [ids], pessoas: [ids] }
// condominioId (opcional): restringe frações/pessoas ao condomínio ativo.
async function resolverDestinatarios(selecao, condominioId) {
  const unicos = new Map();
  const add = (p) => {
    if (p) unicos.set(p.id, { pessoa_id: p.id, email: p.email || '', nome: p.nome });
  };
  // Escopo por condomínio ativo quando indicado (multi-condomínio).
  const escopoPessoa = condominioId ? { condominio_id: condominioId } : null;
  const wherePessoa = (extra = {}) => (escopoPessoa ? { ...escopoPessoa, ...extra } : extra);

  if (selecao.modo === 'todos') {
    const todas = await Pessoa.findAll({ where: wherePessoa({ ativo: true }) });
    todas.forEach(add);
  } else if (selecao.modo === 'fracoes' && selecao.fracoes && selecao.fracoes.length) {
    let fracoes = selecao.fracoes.map(Number);
    if (escopoPessoa) {
      // Apenas frações do condomínio ativo (evita envio via ids de outro condomínio).
      const donas = await Fracao.findAll({
        where: { id: { [Op.in]: fracoes }, condominio_id: condominioId },
        attributes: ['id'],
        raw: true,
      });
      fracoes = donas.map((f) => f.id);
    }
    if (!fracoes.length) return [];
    const vinculos = await FracaoPessoa.findAll({
      where: { fracao_id: { [Op.in]: fracoes } },
      include: [{ model: Pessoa, as: 'pessoa', where: wherePessoa() }],
    });
    vinculos.forEach((v) => add(v.pessoa));
  } else if (selecao.modo === 'pessoas' && selecao.pessoas && selecao.pessoas.length) {
    const ps = await Pessoa.findAll({ where: wherePessoa({ id: { [Op.in]: selecao.pessoas.map(Number) } }) });
    ps.forEach(add);
  }

  // Email preferido via contactos (principal/primeiro ativo), sem enviar
  // para todos os endereços de uma pessoa.
  const ids = [...unicos.keys()];
  if (ids.length) {
    const preferidos = await emailsPreferidosPorPessoa(ids);
    for (const [pid, item] of unicos) {
      const preferido = preferidos.get(pid);
      if (preferido) item.email = preferido;
    }
  }

  return [...unicos.values()].filter((d) => d.email);
}

module.exports = { resolverDestinatarios };
