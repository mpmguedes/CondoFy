const { Op } = require('sequelize');
const { Pessoa } = require('../models');
const { pessoasAtuaisDaFracao } = require('./titularidades');
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
    const fracoes = selecao.fracoes.map(Number);
    if (!fracoes.length) return [];
    // Contactos ATUAIS de cada fração: depois de uma mudança de proprietário, o
    // anterior deixou de ser titular (ou tem `data_fim`) e não recebe o aviso.
    // `pessoasAtuaisDaFracao` resolve o condomínio de cada fração, pelo que ids
    // de outro condomínio não trazem destinatários.
    const porFracao = await Promise.all(
      fracoes.map((fid) => pessoasAtuaisDaFracao({ condominioId, fracaoId: fid }))
    );
    porFracao.forEach(({ pessoas }) =>
      pessoas
        .filter((p) => !condominioId || Number(p.condominio_id) === Number(condominioId))
        .forEach(add)
    );
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
