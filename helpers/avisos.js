const { Op } = require('sequelize');
const { Pessoa, Fracao, FracaoPessoa } = require('../models');

// Resolve destinatários de um aviso numa lista única de {pessoa_id, email, nome}.
// selecao = { modo: 'todos' | 'fracoes' | 'pessoas', fracoes: [ids], pessoas: [ids] }
async function resolverDestinatarios(selecao) {
  const unicos = new Map();
  const add = (p) => {
    if (p && p.email) unicos.set(p.id, { pessoa_id: p.id, email: p.email, nome: p.nome });
  };

  if (selecao.modo === 'todos') {
    const todas = await Pessoa.findAll({ where: { ativo: true } });
    todas.forEach(add);
  } else if (selecao.modo === 'fracoes' && selecao.fracoes && selecao.fracoes.length) {
    const vinculos = await FracaoPessoa.findAll({
      where: { fracao_id: { [Op.in]: selecao.fracoes } },
      include: [{ model: Pessoa, as: 'pessoa' }],
    });
    vinculos.forEach((v) => add(v.pessoa));
  } else if (selecao.modo === 'pessoas' && selecao.pessoas && selecao.pessoas.length) {
    const ps = await Pessoa.findAll({ where: { id: { [Op.in]: selecao.pessoas } } });
    ps.forEach(add);
  }

  return [...unicos.values()];
}

module.exports = { resolverDestinatarios };
