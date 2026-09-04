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
const { getQuotaConfig } = require('../helpers/quotas-config');

const router = express.Router();
router.use(eAdmin);

function totalRubricasC(rubricas) {
  return rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
}

function rotuloPeriodo(o) {
  const inicio = new Date(o.data_inicio).getFullYear();
  const fim = new Date(o.data_fim).getFullYear();
  return inicio === fim ? `${inicio}` : `${inicio}/${fim}`;
}

// Normaliza o período para exatamente 1 ano (ano civil ou personalizado).
function periodoUmAno(dataInicio, dataFim) {
  if (!dataInicio || !dataFim) return false;
  const [iy, im, id] = dataInicio.split('-').map(Number);
  const fim = new Date(Date.UTC(iy, im - 1, id));
  fim.setUTCFullYear(fim.getUTCFullYear() + 1);
  fim.setUTCDate(fim.getUTCDate() - 1);
  const esperado = fim.toISOString().slice(0, 10);
  return dataFim === esperado;
}

function dataParaAnoCivil(ano) {
  return { dataInicio: `${ano}-01-01`, dataFim: `${ano}-12-31` };
}

// ── Lista ──────────────────────────────────────────────────────────
router.get('/orcamento', async (req, res) => {
  const orcamentos = await Orcamento.findAll({
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
    order: [['ano', 'DESC'], ['data_inicio', 'DESC']],
  });

  const ids = orcamentos.map((o) => o.id);
  const plano = ids.length
    ? await PlanoQuota.findAll({ where: { orcamento_id: ids, estado: { [Op.ne]: 'cancelada' } }, raw: true })
    : [];
  const receitasPorOrcamento = {};
  plano.forEach((p) => {
    receitasPorOrcamento[p.orcamento_id] = (receitasPorOrcamento[p.orcamento_id] || 0) + toCents(p.valor);
  });

  const anoAtual = new Date().getFullYear();
  const temAnoAtual = orcamentos.some((o) => o.ano === anoAtual);

  const linhas = orcamentos.map((o) => {
    const despesasC = totalRubricasC(o.rubricas);
    const receitasC = receitasPorOrcamento[o.id] || 0;
    return {
      ...o.toJSON(),
      rotulo: rotuloPeriodo(o),
      despesas: fromCents(despesasC),
      receitas: fromCents(receitasC),
      saldo: fromCents(receitasC - despesasC),
    };
  });
  res.render('admin/orcamento/listar', {
    titulo: 'Orçamentos',
    orcamentos: linhas,
    anoAtual,
    temAnoAtual,
  });
});

// ── Criar ──────────────────────────────────────────────────────────
router.get('/orcamento/nova', async (req, res) => {
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' }, order: [['designacao', 'ASC']] });
  const quotaConfig = await getQuotaConfig();
  const anoAtual = new Date().getFullYear();
  res.render('admin/orcamento/form', {
    titulo: 'Novo orçamento',
    orcamento: null,
    fracoes,
    quotaConfig,
    anoAtual,
    permilagemTotal: fracoes.reduce((s, f) => s + (toNumber(f.permilagem) || 0), 0),
  });
});

router.post('/orcamento', async (req, res) => {
  const ano = parseInt(req.body.ano, 10);
  const tipoPeriodo = req.body.tipo_periodo === 'personalizado' ? 'personalizado' : 'civil';
  const saldoTransitado = toNumber(req.body.saldo_transitado);
  const metodoCalculo = req.body.metodo_calculo === 'modo_b' ? 'modo_b' : 'modo_a';
  const receitaPrevista = metodoCalculo === 'modo_b' ? toNumber(req.body.receita_quotas_prevista) : null;

  if (!ano || ano < 2000 || ano > 2100) {
    req.flash('error_msg', 'Indique um ano válido.');
    return res.redirect('/admin/orcamento/nova');
  }

  let dataInicio;
  let dataFim;
  if (tipoPeriodo === 'personalizado') {
    dataInicio = req.body.data_inicio;
    dataFim = req.body.data_fim;
    if (!periodoUmAno(dataInicio, dataFim)) {
      req.flash('error_msg', 'O período tem de corresponder exatamente a 1 ano.');
      return res.redirect('/admin/orcamento/nova');
    }
  } else {
    const civil = dataParaAnoCivil(ano);
    dataInicio = civil.dataInicio;
    dataFim = civil.dataFim;
  }

  if (metodoCalculo === 'modo_b' && receitaPrevista <= 0) {
    req.flash('error_msg', 'Indique a receita anual pretendida (maior que zero) para o Modo B.');
    return res.redirect('/admin/orcamento/nova');
  }

  const designacao = req.body.designacao || `Orçamento ${ano}`;

  const orcamento = await Orcamento.create({
    designacao,
    ano,
    saldo_transitado: saldoTransitado,
    data_inicio: dataInicio,
    data_fim: dataFim,
    metodo_calculo: metodoCalculo,
    receita_quotas_prevista: receitaPrevista,
    observacoes: req.body.observacoes || null,
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

// ── Editar ─────────────────────────────────────────────────────────
router.get('/orcamento/:id/editar', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' }, order: [['designacao', 'ASC']] });
  const quotaConfig = await getQuotaConfig();
  res.render('admin/orcamento/form', {
    titulo: 'Editar orçamento',
    orcamento: orcamento.toJSON(),
    fracoes,
    quotaConfig,
    anoAtual: orcamento.ano || new Date().getFullYear(),
    permilagemTotal: fracoes.reduce((s, f) => s + (toNumber(f.permilagem) || 0), 0),
  });
});

router.post('/orcamento/:id', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');

  const metodoCalculo = req.body.metodo_calculo === 'modo_b' ? 'modo_b' : 'modo_a';
  const receitaPrevista = metodoCalculo === 'modo_b' ? toNumber(req.body.receita_quotas_prevista) : null;

  const dados = {
    designacao: req.body.designacao || orcamento.designacao,
    saldo_transitado: toNumber(req.body.saldo_transitado),
    metodo_calculo: metodoCalculo,
    receita_quotas_prevista: receitaPrevista,
    observacoes: req.body.observacoes || null,
  };

  if (req.body.tipo_periodo === 'personalizado') {
    if (!periodoUmAno(req.body.data_inicio, req.body.data_fim)) {
      req.flash('error_msg', 'O período tem de corresponder exatamente a 1 ano.');
      return res.redirect(`/admin/orcamento/${orcamento.id}/editar`);
    }
    dados.data_inicio = req.body.data_inicio;
    dados.data_fim = req.body.data_fim;
  }

  if (metodoCalculo === 'modo_b' && receitaPrevista <= 0) {
    req.flash('error_msg', 'Indique a receita anual pretendida (maior que zero) para o Modo B.');
    return res.redirect(`/admin/orcamento/${orcamento.id}/editar`);
  }

  await orcamento.update(dados);
  await audit({ userId: req.user.id, acao: 'editar_orçamento', entidade: 'Orcamento', entidadeId: orcamento.id });
  req.flash('success_msg', 'Orçamento atualizado.');
  res.redirect(`/admin/orcamento/${orcamento.id}`);
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

// ── Aprovação / estado ─────────────────────────────────────────────
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
  req.flash('success_msg', 'Orçamento aprovado (Ativo).');
  res.redirect(`/admin/orcamento/${orcamento.id}`);
});

// Fecha o orçamento (encerrado).
router.post('/orcamento/:id/fechar', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  await orcamento.update({ estado: 'encerrado' });
  await audit({ userId: req.user.id, acao: 'fechar_orçamento', entidade: 'Orcamento', entidadeId: orcamento.id });
  req.flash('success_msg', 'Orçamento fechado.');
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
router.get('/orcamento/:id/plano', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');

  const plano = await PlanoQuota.findAll({
    where: { orcamento_id: orcamento.id },
    include: [{ model: Fracao, as: 'fracao' }],
    order: [['ano', 'ASC'], ['mes', 'ASC'], ['fracao_id', 'ASC']],
  });

  const fracoesMap = new Map();
  const meses = [];
  const mesesSet = new Set();
  plano.forEach((p) => {
    if (!fracoesMap.has(p.fracao_id)) fracoesMap.set(p.fracao_id, p.fracao ? p.fracao.designacao : p.fracao_id);
    const key = `${p.ano}|${p.mes}`;
    if (!mesesSet.has(key)) {
      mesesSet.add(key);
      meses.push({ ano: p.ano, mes: p.mes });
    }
  });

  const celulas = {};
  plano.forEach((p) => (celulas[`${p.fracao_id}|${p.ano}|${p.mes}`] = p.valor));

  const fracoes = [...fracoesMap.entries()].map(([id, designacao]) => ({
    id,
    designacao,
    totais: meses.map((m) => celulas[`${id}|${m.ano}|${m.mes}`] ?? 0),
    totalAnual: fromCents(meses.reduce((s, m) => s + toCents(celulas[`${id}|${m.ano}|${m.mes}`] ?? 0), 0)),
  }));

  const totaisMes = meses.map((m) =>
    fromCents(plano.filter((p) => p.ano === m.ano && p.mes === m.mes).reduce((s, p) => s + toCents(p.valor), 0))
  );

  res.render('admin/orcamento/plano', {
    titulo: `Plano de quotas — ${rotuloPeriodo(orcamento)}`,
    orcamento: orcamento.toJSON(),
    meses,
    fracoes,
    totaisMes,
    totalGeral: fromCents(plano.reduce((s, p) => s + toCents(p.valor), 0)),
  });
});

router.post('/orcamento/:id/plano', async (req, res) => {
  const orcamento = await Orcamento.findByPk(req.params.id);
  if (!orcamento) return res.redirect('/admin/orcamento');
  const rubricas = await OrcamentoRubrica.findAll({ where: { orcamento_id: orcamento.id, ativo: true } });
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' } });
  let distribuicoes = await OrcamentoDistribuicao.findAll({ where: { orcamento_id: orcamento.id } });

  // Distribuição automática para rubricas ainda sem distribuição (permilagem/igual).
  let autoDistribuidas = 0;
  const tDist = await sequelize.transaction();
  try {
    for (const r of rubricas) {
      if (distribuicoes.some((d) => d.rubrica_id === r.id)) continue;
      const metodo = r.metodo_distribuicao === 'valor_fixo' ? 'igual' : r.metodo_distribuicao;
      const partes = distribuirValorAnual(r.valor_anual, fracoes, metodo);
      for (const p of partes) {
        if (p.valor > 0) {
          await OrcamentoDistribuicao.create(
            { orcamento_id: orcamento.id, rubrica_id: r.id, fracao_id: p.fracaoId, valor_anual: p.valor },
            { transaction: tDist }
          );
        }
      }
      autoDistribuidas++;
    }
    await tDist.commit();
  } catch (err) {
    await tDist.rollback();
    throw err;
  }
  distribuicoes = await OrcamentoDistribuicao.findAll({ where: { orcamento_id: orcamento.id } });

  const plano = calcularPlano({
    orcamento: orcamento.toJSON(),
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
    req.flash('success_msg', `Plano de quotas gerado (${plano.length} lançamentos${autoDistribuidas ? `; distribuição calculada para ${autoDistribuidas} rubrica(s)` : ''}).`);
  } catch (err) {
    await t.rollback();
    console.error(err);
    req.flash('error_msg', 'Erro ao gerar o plano.');
  }
  res.redirect(`/admin/orcamento/${orcamento.id}/plano`);
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
  let ano = parseInt(req.body.ano, 10);
  let mes = parseInt(req.body.mes, 10);
  if (req.body.periodo) {
    const [pAno, pMes] = req.body.periodo.split('-').map(Number);
    ano = pAno;
    mes = pMes;
  }
  if (!ano || !mes) {
    req.flash('error_msg', 'Selecione o período a emitir.');
    return res.redirect(`/admin/orcamento/${orcamento.id}/emitir`);
  }

  const t = await sequelize.transaction();
  let criadas = 0;
  try {
    const plano = await PlanoQuota.findAll({
      where: { orcamento_id: orcamento.id, ano, mes, estado: 'planeada' },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (plano.length === 0) {
      await t.rollback();
      req.flash('error_msg', 'Não há quotas planeadas para esse período.');
      return res.redirect(`/admin/orcamento/${orcamento.id}/emitir`);
    }

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
    req.flash('error_msg', `Erro ao emitir quotas: ${err.message}`);
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
