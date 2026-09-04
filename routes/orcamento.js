const express = require('express');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const {
  Orcamento,
  OrcamentoRubrica,
  OrcamentoDistribuicao,
  OrcamentoAlteracao,
  PlanoQuota,
  Quota,
  Categoria,
  Fracao,
  User,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { toCents, fromCents, toNumber } = require('../helpers/money');
const { monthName } = require('../helpers/dates');
const { distribuirValorAnual } = require('../helpers/distribuicao');
const { calcularPlano } = require('../helpers/plano');
const { proximoNumero } = require('../helpers/numeracao');

const router = express.Router();
router.use(eAdmin);

function periodoUmAno(dataInicio, dataFim) {
  const i = new Date(dataInicio);
  const umAno = new Date(i.getFullYear() + 1, i.getMonth(), i.getDate());
  const fimEsperado = new Date(umAno.getTime() - 86400000);
  return new Date(dataFim).getTime() === fimEsperado.getTime();
}

function totalRubricasC(rubricas) {
  return rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
}

function rotuloPeriodo(o) {
  const inicio = new Date(o.data_inicio).getFullYear();
  const fim = new Date(o.data_fim).getFullYear();
  return inicio === fim ? `${inicio}` : `${inicio}/${fim}`;
}

// ── Lista ──────────────────────────────────────────────────────────
router.get('/orcamento', async (req, res) => {
  const orcamentos = await Orcamento.findAll({
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
    order: [['data_inicio', 'DESC']],
  });
  const linhas = orcamentos.map((o) => ({
    ...o.toJSON(),
    rotulo: rotuloPeriodo(o),
    total: fromCents(totalRubricasC(o.rubricas)),
  }));
  res.render('admin/orcamento/listar', { titulo: 'Orçamentos', orcamentos: linhas });
});

// ── Criar ──────────────────────────────────────────────────────────
router.get('/orcamento/nova', (req, res) => {
  res.render('admin/orcamento/form', { titulo: 'Novo orçamento', orcamento: null });
});

router.post('/orcamento', async (req, res) => {
  const { designacao, data_inicio, data_fim, observacoes } = req.body;
  if (!periodoUmAno(data_inicio, data_fim)) {
    req.flash('error_msg', 'O período tem de corresponder exatamente a 1 ano.');
    return res.redirect('/admin/orcamento/nova');
  }
  const orcamento = await Orcamento.create({
    designacao,
    data_inicio,
    data_fim,
    observacoes: observacoes || null,
    estado: 'rascunho',
  });
  await audit({ userId: req.user.id, acao: 'criar_orçamento', entidade: 'Orcamento', entidadeId: orcamento.id });
  req.flash('success_msg', 'Orçamento criado.');
  res.redirect(`/admin/orcamento/${orcamento.id}`);
});

// ── Detalhe ────────────────────────────────────────────────────────
router.get('/orcamento/:id', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id, {
    include: [
      { model: OrcamentoRubrica, as: 'rubricas', include: [{ model: Categoria, as: 'categoria' }] },
    ],
  });
  if (!orcamento) return res.redirect('/admin/orcamento');

  const [nDistribuicoes, nPlano, categorias, alteracoes] = await Promise.all([
    OrcamentoDistribuicao.count({ where: { orcamento_id: orcamento.id } }),
    PlanoQuota.count({ where: { orcamento_id: orcamento.id } }),
    Categoria.findAll({ where: { tipo: 'despesa' }, order: [['nome', 'ASC']] }),
    OrcamentoAlteracao.findAll({ where: { orcamento_id: orcamento.id }, include: [{ model: User, as: 'utilizador', attributes: ['nome'] }], order: [['id', 'DESC']], limit: 10 }),
  ]);

  res.render('admin/orcamento/detalhe', {
    titulo: `Orçamento ${rotuloPeriodo(orcamento)}`,
    orcamento: orcamento.toJSON(),
    rotulo: rotuloPeriodo(orcamento),
    total: fromCents(totalRubricasC(orcamento.rubricas)),
    nDistribuicoes,
    nPlano,
    categorias,
    alteracoes,
  });
});

// ── Rubricas ───────────────────────────────────────────────────────
router.post('/orcamento/:id/rubricas', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (orcamento.estado !== 'rascunho') {
    req.flash('error_msg', 'Orçamento aprovado não pode ser alterado normalmente. Use "alteração extraordinária".');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  const { categoria_id, descricao, valor_anual, metodo_distribuicao, periodicidade } = req.body;
  await OrcamentoRubrica.create({
    orcamento_id: orcamento.id,
    categoria_id: categoria_id || null,
    descricao,
    valor_anual: toNumber(valor_anual),
    metodo_distribuicao: metodo_distribuicao || 'permilagem',
    periodicidade: periodicidade || 'mensal',
    ativo: true,
  });
  req.flash('success_msg', 'Rubrica adicionada.');
  res.redirect(`/admin/orcamento/${orcamento.id}`);
});

router.post('/orcamento/:id/rubricas/:rid/eliminar', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  const rubrica = await OrcamentoRubrica.findByPk(req.params.rid);
  if (orcamento && rubrica) {
    if (orcamento.estado !== 'rascunho') {
      req.flash('error_msg', 'Orçamento aprovado não pode ser alterado normalmente.');
      return res.redirect(`/admin/orcamento/${orcamento.id}`);
    }
    await rubrica.destroy();
    req.flash('success_msg', 'Rubrica removida.');
  }
  res.redirect(`/admin/orcamento/${req.params.id}`);
});

// Alteração extraordinária de uma rubrica (com justificação obrigatória quando aprovado).
router.post('/orcamento/:id/rubricas/:rid/alterar', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  const rubrica = await OrcamentoRubrica.findByPk(req.params.rid);
  if (!orcamento || !rubrica) return res.redirect('/admin/orcamento');
  const novoValor = toNumber(req.body.valor_novo);
  const justificacao = (req.body.justificacao || '').trim();
  if (orcamento.estado !== 'rascunho' && !justificacao) {
    req.flash('error_msg', 'Justificação é obrigatória para alterar um orçamento aprovado.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  const valorAnterior = rubrica.valor_anual;
  await rubrica.update({ valor_anual: novoValor });
  await OrcamentoAlteracao.create({
    orcamento_id: orcamento.id,
    utilizador_id: req.user.id,
    tipo_alteracao: 'alteracao_valor',
    entidade_alterada: 'OrcamentoRubrica',
    entidade_id: rubrica.id,
    valor_anterior: valorAnterior,
    valor_novo: novoValor,
    justificacao: justificacao || null,
  });
  await audit({
    userId: req.user.id,
    acao: 'alterar_rubrica_orçamento',
    entidade: 'OrcamentoRubrica',
    entidadeId: rubrica.id,
    detalhes: { valor_anterior: valorAnterior, valor_novo: novoValor },
  });
  req.flash('success_msg', 'Rubrica alterada e registada no histórico.');
  res.redirect(`/admin/orcamento/${orcamento.id}`);
});

// ── Aprovação ──────────────────────────────────────────────────────
router.post('/orcamento/:id/aprovar', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id, {
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
  });
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!periodoUmAno(orcamento.data_inicio, orcamento.data_fim)) {
    req.flash('error_msg', 'O período não corresponde a 1 ano.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  if (!orcamento.rubricas.some((r) => r.ativo && toCents(r.valor_anual) > 0)) {
    req.flash('error_msg', 'Adicione pelo menos uma rubrica com valor antes de aprovar.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  await orcamento.update({ estado: 'aprovado', data_aprovacao: new Date(), aprovado_por: req.user.id });
  await OrcamentoAlteracao.create({
    orcamento_id: orcamento.id,
    utilizador_id: req.user.id,
    tipo_alteracao: 'aprovacao',
    entidade_alterada: 'Orcamento',
    entidade_id: orcamento.id,
  });
  await audit({ userId: req.user.id, acao: 'aprovar_orçamento', entidade: 'Orcamento', entidadeId: orcamento.id });
  req.flash('success_msg', 'Orçamento aprovado.');
  res.redirect(`/admin/orcamento/${orcamento.id}`);
});

// ── Distribuição ───────────────────────────────────────────────────
router.get('/orcamento/:id/distribuicao', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id, {
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
  });
  if (!orcamento) return res.redirect('/admin/orcamento');

  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' }, order: [['designacao', 'ASC']] });
  const rubricas = orcamento.rubricas.filter((r) => r.ativo);
  const distribuicoes = await OrcamentoDistribuicao.findAll({ where: { orcamento_id: orcamento.id } });
  const distMap = {};
  distribuicoes.forEach((d) => (distMap[`${d.rubrica_id}|${d.fracao_id}`] = d.valor_anual));

  const celulas = {};
  for (const r of rubricas) {
    const partes =
      r.metodo_distribuicao === 'valor_fixo'
        ? fracoes.map((f) => distMap[`${r.id}|${f.id}`] ?? 0)
        : distribuirValorAnual(r.valor_anual, fracoes, r.metodo_distribuicao);
    const mapa = {};
    partes.forEach((p) => (mapa[p.fracaoId] = p.valor));
    celulas[r.id] = fracoes.map((f) => distMap[`${r.id}|${f.id}`] ?? mapa[f.id]);
  }

  const linhas = fracoes.map((f) => ({
    id: f.id,
    designacao: f.designacao,
    permilagem: f.permilagem,
    valores: rubricas.map((r) => ({ rubricaId: r.id, valor: celulas[r.id][fracoes.indexOf(f)] })),
  }));

  res.render('admin/orcamento/distribuicao', {
    titulo: `Distribuição — Orçamento ${rotuloPeriodo(orcamento)}`,
    orcamento: orcamento.toJSON(),
    rubricas: rubricas.map((r) => ({ id: r.id, descricao: r.descricao, metodo: r.metodo_distribuicao })),
    linhas,
  });
});

router.post('/orcamento/:id/distribuicao', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  const t = await sequelize.transaction();
  try {
    const valores = req.body.dist || {};
    await OrcamentoDistribuicao.destroy({ where: { orcamento_id: orcamento.id }, transaction: t });
    for (const [rubricaId, frac] of Object.entries(valores)) {
      for (const [fracaoId, valor] of Object.entries(frac)) {
        const v = toNumber(valor);
        if (v > 0) {
          await OrcamentoDistribuicao.create(
            { orcamento_id: orcamento.id, rubrica_id: Number(rubricaId), fracao_id: Number(fracaoId), valor_anual: v },
            { transaction: t }
          );
        }
      }
    }
    await t.commit();
    await audit({ userId: req.user.id, acao: 'calcular_distribuição', entidade: 'Orcamento', entidadeId: orcamento.id });
    req.flash('success_msg', 'Distribuição guardada.');
  } catch (err) {
    await t.rollback();
    console.error(err);
    req.flash('error_msg', 'Erro ao guardar a distribuição.');
  }
  res.redirect(`/admin/orcamento/${orcamento.id}/distribuicao`);
});

// ── Plano de quotas ────────────────────────────────────────────────
router.post('/orcamento/:id/plano', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  const rubricas = await OrcamentoRubrica.findAll({ where: { orcamento_id: orcamento.id, ativo: true } });
  const distribuicoes = await OrcamentoDistribuicao.findAll({ where: { orcamento_id: orcamento.id } });
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' } });

  const plano = calcularPlano({
    orcamento,
    rubricas: rubricas.map((r) => r.toJSON()),
    distribuicoes: distribuicoes.map((d) => d.toJSON()),
    fracoes: fracoes.map((f) => f.toJSON()),
  });

  const t = await sequelize.transaction();
  try {
    await PlanoQuota.destroy({ where: { orcamento_id: orcamento.id, estado: 'planeada' }, transaction: t });
    for (const p of plano) {
      await PlanoQuota.findOrCreate({
        where: { orcamento_id: orcamento.id, fracao_id: p.fracaoId, ano: p.ano, mes: p.mes },
        defaults: { valor: p.valor, data_vencimento: p.dataVencimento, estado: 'planeada' },
        transaction: t,
      });
    }
    await t.commit();
    await audit({ userId: req.user.id, acao: 'gerar_plano_quotas', entidade: 'Orcamento', entidadeId: orcamento.id, detalhes: { linhas: plano.length } });
    req.flash('success_msg', `Plano de quotas gerado (${plano.length} lançamentos).`);
  } catch (err) {
    await t.rollback();
    console.error(err);
    req.flash('error_msg', 'Erro ao gerar o plano.');
  }
  res.redirect(`/admin/orcamento/${orcamento.id}`);
});

// ── Emissão (Fase 4) ───────────────────────────────────────────────
router.get('/orcamento/:id/emitir', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  const plano = await PlanoQuota.findAll({
    where: { orcamento_id: orcamento.id, estado: 'planeada' },
    include: [{ model: Fracao, as: 'fracao' }],
    order: [['ano', 'ASC'], ['mes', 'ASC']],
  });
  const meses = [...new Set(plano.map((p) => `${p.ano}|${p.mes}`))].map((s) => {
    const [ano, mes] = s.split('|').map(Number);
    return { ano, mes };
  });
  const proximo = meses.length ? meses[0] : null;
  const proximoAno = proximo ? proximo.ano : null;
  const proximoMes = proximo ? proximo.mes : null;
  const doMes = plano.filter((p) => p.ano === proximoAno && p.mes === proximoMes);
  const total = fromCents(doMes.reduce((s, p) => s + toCents(p.valor), 0));

  res.render('admin/orcamento/emitir', {
    titulo: 'Emissão de quotas',
    orcamento: orcamento.toJSON(),
    rotulo: rotuloPeriodo(orcamento),
    meses,
    proximoAno,
    proximoMes,
    nFracoes: doMes.length,
    total,
  });
});

router.post('/orcamento/:id/emitir', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  const ano = parseInt(req.body.ano, 10);
  const mes = parseInt(req.body.mes, 10);

  const plano = await PlanoQuota.findAll({
    where: { orcamento_id: orcamento.id, ano, mes, estado: 'planeada' },
    lock: true,
  });
  if (plano.length === 0) {
    req.flash('error_msg', 'Não há quotas planeadas para esse período.');
    return res.redirect(`/admin/orcamento/${orcamento.id}/emitir`);
  }

  const t = await sequelize.transaction();
  let criadas = 0;
  try {
    for (const p of plano) {
      const numero = await proximoNumero('aviso_quota', { ano, transaction: t });
      await Quota.create(
        {
          numero_documento: numero,
          fracao_id: p.fracao_id,
          orcamento_id: orcamento.id,
          ano,
          mes,
          periodo: new Date(ano, mes - 1, 1),
          valor: p.valor,
          data_emissao: new Date(),
          data_vencimento: p.data_vencimento,
          estado: 'pendente',
        },
        { transaction: t }
      );
      await p.update({ estado: 'emitida' }, { transaction: t });
      criadas++;
    }
    if (orcamento.estado === 'aprovado') {
      await orcamento.update({ estado: 'em_execucao' }, { transaction: t });
    }
    await t.commit();
    await audit({ userId: req.user.id, acao: 'emitir_quotas', entidade: 'Orcamento', entidadeId: orcamento.id, detalhes: { ano, mes, criadas } });
    req.flash('success_msg', `Emitidas ${criadas} quota(s).`);
  } catch (err) {
    await t.rollback();
    console.error(err);
    req.flash('error_msg', 'Erro ao emitir quotas.');
  }
  res.redirect('/admin/quotas');
});

// ── Histórico ──────────────────────────────────────────────────────
router.get('/orcamento/:id/historico', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  const alteracoes = await OrcamentoAlteracao.findAll({
    where: { orcamento_id: orcamento.id },
    include: [{ model: User, as: 'utilizador', attributes: ['nome'] }],
    order: [['id', 'DESC']],
  });
  res.render('admin/orcamento/historico', {
    titulo: `Histórico — Orçamento ${rotuloPeriodo(orcamento)}`,
    orcamento: orcamento.toJSON(),
    alteracoes,
  });
});

module.exports = router;
