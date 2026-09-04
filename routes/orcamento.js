const express = require('express');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Categoria, OrcamentoItem, Despesa } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { toCents, fromCents, toNumber } = require('../helpers/money');
const { resumoOrcamento } = require('../helpers/saldos');

const router = express.Router();
router.use(eAdmin);

router.get('/orcamento', async (req, res) => {
  const ano = parseInt(req.query.ano || new Date().getFullYear(), 10);
  const categorias = await Categoria.findAll({ where: { tipo: 'despesa' }, order: [['nome', 'ASC']] });
  const itens = await OrcamentoItem.findAll({ where: { ano } });

  const despesas = await Despesa.findAll({
    attributes: ['categoria_id', [sequelize.fn('SUM', sequelize.col('valor')), 'total']],
    where: { competencia_ano: ano, estado: { [Op.ne]: 'anulada' }, categoria_id: { [Op.ne]: null } },
    group: ['categoria_id'],
    raw: true,
  });
  const executadoPorCategoria = {};
  despesas.forEach((d) => (executadoPorCategoria[d.categoria_id] = d.total));

  const orcadoPorCategoria = {};
  itens.forEach((i) => (orcadoPorCategoria[i.categoria_id] = i.valor_orcamentado));

  const linhas = categorias.map((c) => {
    const orcadoC = toCents(orcadoPorCategoria[c.id] || 0);
    const execC = toCents(executadoPorCategoria[c.id] || 0);
    return {
      id: c.id,
      nome: c.nome,
      orcamentado: fromCents(orcadoC),
      executado: fromCents(execC),
      diferenca: fromCents(orcadoC - execC),
      percentagem: orcadoC > 0 ? Math.round((execC / orcadoC) * 100) : null,
      acima: execC > orcadoC,
    };
  });

  const global = await resumoOrcamento(ano);
  const anos = await OrcamentoItem.findAll({ attributes: [[sequelize.fn('DISTINCT', sequelize.col('ano')), 'ano']], order: [['ano', 'DESC']], raw: true });

  res.render('admin/orcamento/index', {
    titulo: 'Orçamento',
    ano,
    linhas,
    global,
    anos: anos.map((a) => a.ano),
    chart: JSON.stringify({
      labels: linhas.map((l) => l.nome),
      orcado: linhas.map((l) => toCents(l.orcamentado) / 100),
      executado: linhas.map((l) => toCents(l.executado) / 100),
    }),
  });
});

router.post('/orcamento', async (req, res) => {
  const { ano, categoria_id, valor_orcamentado } = req.body;
  const anoNum = parseInt(ano, 10);
  const valor = toNumber(valor_orcamentado);

  await OrcamentoItem.destroy({ where: { ano: anoNum, categoria_id } });
  if (valor > 0) {
    await OrcamentoItem.create({ ano: anoNum, categoria_id, valor_orcamentado: valor });
  }
  await audit({ userId: req.user.id, acao: 'definir_orçamento', entidade: 'OrcamentoItem', detalhes: { ano: anoNum, categoria_id } });
  req.flash('success_msg', 'Orçamento atualizado.');
  res.redirect(`/admin/orcamento?ano=${anoNum}`);
});

module.exports = router;
