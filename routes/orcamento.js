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
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { toCents, fromCents, toNumber } = require('../helpers/money');
const helpersHbs = require('../helpers/handlebars-helpers');
const { monthName } = require('../helpers/dates');
const { distribuirValorAnual } = require('../helpers/distribuicao');
const { calcularPlano } = require('../helpers/plano');
const { proximoNumero } = require('../helpers/numeracao');
const { getQuotaConfig } = require('../helpers/quotas-config');
const { dividirComponentesQuota } = require('../helpers/quotas-calc');
const orcamentoEstado = require('../helpers/orcamento-estado');

const router = express.Router();
// Isolamento: condomínio ativo (sessão validada) em todas as operações.
router.use(tenant.comCondominioAtivo);

// ── Suporte diagnóstico: admissão explícita DESTE módulo ───────────
// A allow-list é partilhada (`helpers/suporte-allowlist.js`). Só as rotas
// declaradas para o módulo `orcamento` são admitidas ao suporte; as
// restantes caem na guarda de papel abaixo.
const allowlistSuporte = require('../helpers/suporte-allowlist');
router.use(allowlistSuporte.soDiagnostico('orcamento'));

// Guarda de papel CONDICIONAL (única): contornada só pelo suporte ADMITIDO.
// Um `router.use(tenant.comPapel('gestor'))` incondicional a seguir anularia a
// admissão — o Express corre os dois e o segundo recusaria o pedido admitido.
router.use(allowlistSuporte.comPapelOuSuporteAdmitido('gestor'));

// Orçamento do condomínio ATIVO (null quando não pertence — bloqueia IDOR).
// `incluir` aceita um array de includes ({model, as}) — usado pela maioria das
// rotas — ou o objeto de opções { include: [...] } usado nas rotas de
// detalhe/aprovar/distribuição; normaliza para o array. O filtro do condomínio
// ativo é SEMPRE aplicado (nunca removido/contornado).
function carregarOrcamento(req, incluir = []) {
  const includes = Array.isArray(incluir)
    ? incluir
    : incluir && Array.isArray(incluir.include)
      ? incluir.include
      : [];
  return Orcamento.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: includes,
  });
}

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
    where: { condominio_id: req.condominioId },
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
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId }, order: [['designacao', 'ASC']] });
  const quotaConfig = await getQuotaConfig(req.condominioId);
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
    condominio_id: req.condominioId,
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
  const orcamento = await carregarOrcamento(req, {
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

  // Suporte diagnóstico: o autor de cada alteração é reduzido a iniciais —
  // o histórico continua legível sem expor nomes pessoais completos.
  if (req.suporte && Array.isArray(alteracoes)) {
    for (const alt of alteracoes) {
      const u = alt.utilizador;
      if (u && u.nome) {
        const ini = helpersHbs.iniciais(u.nome);
        u.setDataValue ? u.setDataValue('nome', ini) : (u.nome = ini);
      }
    }
  }

  res.render(req.suporte ? 'admin/orcamento/detalhe-suporte' : 'admin/orcamento/detalhe', {
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

// ── Editar (apenas rascunho) ───────────────────────────────────────
router.get('/orcamento/:id/editar', async (req, res) => {
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.podeEditar(orcamento.estado)) {
    req.flash('error_msg', 'Apenas orçamentos em rascunho podem ser editados.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId }, order: [['designacao', 'ASC']] });
  const quotaConfig = await getQuotaConfig(req.condominioId);
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
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.podeEditar(orcamento.estado)) {
    req.flash('error_msg', 'Apenas orçamentos em rascunho podem ser editados.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }

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
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.podeEditar(orcamento.estado)) {
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
  const orcamento = await carregarOrcamento(req);
  const rubrica = await OrcamentoRubrica.findByPk(req.params.rid);
  if (orcamento && rubrica && rubrica.orcamento_id === orcamento.id) {
    if (!orcamentoEstado.podeEditar(orcamento.estado)) {
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
  const orcamento = await carregarOrcamento(req);
  const rubrica = await OrcamentoRubrica.findByPk(req.params.rid);
  if (!orcamento || !rubrica || rubrica.orcamento_id !== orcamento.id) return res.redirect('/admin/orcamento');
  // Rascunho altera normalmente; aprovado/em execução/fechado alteram com
  // justificação; um orçamento ANULADO nunca é alterado.
  if (!orcamentoEstado.podeEditar(orcamento.estado) && !orcamentoEstado.podeAlteracaoExtraordinaria(orcamento.estado)) {
    req.flash('error_msg', 'Orçamento anulado não pode ser alterado.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
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
  const orcamento = await carregarOrcamento(req, {
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
  });
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.podeAprovar(orcamento.estado)) {
    req.flash('error_msg', 'Apenas orçamentos em rascunho podem ser aprovados.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
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

// Fecha o orçamento (encerrado) — apenas aprovado/em execução.
router.post('/orcamento/:id/fechar', async (req, res) => {
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.podeFechar(orcamento.estado)) {
    req.flash('error_msg', 'Apenas orçamentos aprovados ou em execução podem ser fechados.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  await orcamento.update({ estado: 'encerrado' });
  await audit({ userId: req.user.id, acao: 'fechar_orçamento', entidade: 'Orcamento', entidadeId: orcamento.id });
  req.flash('success_msg', 'Orçamento fechado.');
  res.redirect(`/admin/orcamento/${orcamento.id}`);
});

// ANULAÇÃO — ação distinta de eliminar: preserva o histórico (registo +
// alteração registada) e marca claramente o orçamento como anulado. Só é
// possível num orçamento aprovado que ainda NÃO entrou em execução.
router.post('/orcamento/:id/anular', async (req, res) => {
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.podeAnular(orcamento.estado)) {
    req.flash('error_msg', 'Apenas orçamentos aprovados (ainda sem execução) podem ser anulados.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  const id = orcamento.id;
  await orcamento.update({ estado: 'anulado' });
  await OrcamentoAlteracao.create({
    orcamento_id: id,
    utilizador_id: req.user.id,
    tipo_alteracao: 'anulacao',
    entidade_alterada: 'Orcamento',
    entidade_id: id,
    justificacao: String(req.body.justificacao || '').trim() || null,
  });
  await audit({ userId: req.user.id, acao: 'anular_orçamento', entidade: 'Orcamento', entidadeId: id });
  req.flash('success_msg', 'Orçamento anulado. Fica no histórico, sem poder ser editado ou executado.');
  res.redirect(`/admin/orcamento/${id}`);
});

// ELIMINAÇÃO — apenas rascunhos (sem relevância financeira/histórica).
// Remove os registos associados (rubricas, distribuições, plano, histórico).
// Orçamentos aprovados/em execução/fechados/anulados nunca são eliminados.
router.post('/orcamento/:id/eliminar', async (req, res) => {
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.podeEliminar(orcamento.estado)) {
    req.flash('error_msg', 'Apenas orçamentos em rascunho podem ser eliminados.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  const id = orcamento.id;
  // Segurança: um rascunho não deve ter quotas emitidas; se tiver (fluxo
  // antigo), recusar a eliminação — quotas têm ON DELETE SET NULL e nunca
  // podem perder a referência por uma eliminação.
  const quotasAssociadas = await Quota.count({ where: { orcamento_id: id } });
  if (quotasAssociadas > 0) {
    req.flash('error_msg', 'Este rascunho já tem quotas associadas — não pode ser eliminado.');
    return res.redirect(`/admin/orcamento/${id}`);
  }
  const t = await sequelize.transaction();
  try {
    await OrcamentoAlteracao.destroy({ where: { orcamento_id: id }, transaction: t });
    await OrcamentoDistribuicao.destroy({ where: { orcamento_id: id }, transaction: t });
    await OrcamentoRubrica.destroy({ where: { orcamento_id: id }, transaction: t });
    await PlanoQuota.destroy({ where: { orcamento_id: id }, transaction: t });
    await orcamento.destroy({ transaction: t });
    await t.commit();
    await audit({ userId: req.user.id, acao: 'eliminar_orçamento', entidade: 'Orcamento', entidadeId: id });
    req.flash('success_msg', 'Orçamento (rascunho) eliminado.');
    return res.redirect('/admin/orcamento');
  } catch (err) {
    await t.rollback();
    console.error('[orcamento-eliminar]', err.message);
    req.flash('error_msg', `Não foi possível eliminar o orçamento: ${err.message}`);
    return res.redirect(`/admin/orcamento/${id}`);
  }
});

// ── Distribuição ───────────────────────────────────────────────────
router.get('/orcamento/:id/distribuicao', async (req, res) => {
  const orcamento = await carregarOrcamento(req, {
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
  });
  if (!orcamento) return res.redirect('/admin/orcamento');

  const fracoes = await Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId }, order: [['designacao', 'ASC']] });
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
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.naoAnulado(orcamento.estado)) {
    req.flash('error_msg', 'Orçamento anulado não pode ser alterado.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }

  // ── Leitura do corpo submetido ────────────────────────────────────
  // Os campos do formulário são `dist[r<rubricaId>][f<fracaoId>]`. O prefixo
  // NÃO é decorativo: o body-parser (`qs`, via
  // `express.urlencoded({ extended: true })`) interpreta chaves numéricas
  // abaixo de `arrayLimit` (100) como ÍNDICES DE ARRAY. Com os nomes antigos
  // (`dist[11][21]`) o corpo era convertido em `[[…],[…]]`, os ids
  // desapareciam e a gravação tentava `rubrica_id = 0` → o MySQL recusava com
  // `ER_NO_REFERENCED_ROW_2` (chave estrangeira para `orcamento_rubricas`).
  const corpo = req.body.dist;
  if (corpo !== undefined && (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo))) {
    // Um formulário antigo (ou adulterado) já chega aqui sem os ids: a análise
    // do corpo converteu-o em array e a informação perdeu-se. Não há como
    // recuperar os ids — pede-se o reenvio em vez de gravar lixo.
    req.flash('error_msg', 'Não foi possível ler a distribuição submetida (formato inválido). Recarregue a página e volte a guardar.');
    return res.redirect(`/admin/orcamento/${orcamento.id}/distribuicao`);
  }

  // Âmbito: só rubricas DESTE orçamento e frações do condomínio ATIVO. Sem esta
  // verificação, a FK de `rubrica_id` aceitaria uma rubrica de OUTRO orçamento
  // (e, por isso, de outro condomínio) — a FK garante que a rubrica existe, não
  // que pertence a este orçamento.
  const rubricasDoOrcamento = new Set(
    (await OrcamentoRubrica.findAll({ where: { orcamento_id: orcamento.id } })).map((r) => Number(r.id))
  );
  const fracoesDoAtivo = new Set(
    (await Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId } })).map((f) => Number(f.id))
  );

  const valores = corpo || {};
  const registos = [];
  const ignorados = [];
  for (const [chaveRubrica, frac] of Object.entries(valores)) {
    const rubricaId = parseInt(String(chaveRubrica).replace(/^r/, ''), 10);
    if (!Number.isInteger(rubricaId) || rubricaId <= 0 || !rubricasDoOrcamento.has(rubricaId)) {
      ignorados.push(`rubrica «${chaveRubrica}»`);
      continue;
    }
    if (!frac || typeof frac !== 'object' || Array.isArray(frac)) {
      ignorados.push(`rubrica «${chaveRubrica}»`);
      continue;
    }
    for (const [chaveFracao, valor] of Object.entries(frac)) {
      const fracaoId = parseInt(String(chaveFracao).replace(/^f/, ''), 10);
      if (!Number.isInteger(fracaoId) || fracaoId <= 0 || !fracoesDoAtivo.has(fracaoId)) {
        ignorados.push(`fração «${chaveFracao}»`);
        continue;
      }
      const v = toNumber(valor);
      if (v > 0) registos.push({ rubrica_id: rubricaId, fracao_id: fracaoId, valor_anual: v });
    }
  }
  if (ignorados.length) {
    console.warn('[orcamento/distribuicao] entradas ignoradas por não pertencerem ao âmbito:', {
      orcamento: orcamento.id, condominio: req.condominioId, ignorados,
    });
  }

  const t = await sequelize.transaction();
  try {
    await OrcamentoDistribuicao.destroy({ where: { orcamento_id: orcamento.id }, transaction: t });
    for (const r of registos) {
      await OrcamentoDistribuicao.create(
        { orcamento_id: orcamento.id, rubrica_id: r.rubrica_id, fracao_id: r.fracao_id, valor_anual: r.valor_anual },
        { transaction: t }
      );
    }
    await t.commit();
    await audit({ userId: req.user.id, acao: 'calcular_distribuição', entidade: 'Orcamento', entidadeId: orcamento.id });
    req.flash('success_msg', 'Distribuição guardada.');
  } catch (err) {
    await t.rollback();
    // A mensagem genérica escondia a causa real. Regista-se o que o MySQL
    // devolveu (`code`/`errno`/`sqlMessage`) e, quando é reconhecível,
    // acrescenta-se ao aviso do utilizador uma indicação concreta.
    console.error('[orcamento/distribuicao] falha ao gravar a distribuição:', {
      orcamento: orcamento.id,
      condominio: req.condominioId,
      code: err.code,
      errno: err.errno,
      sqlMessage: err.sqlMessage || err.message,
    });
    const causa = err.code === 'ER_NO_REFERENCED_ROW_2'
      ? ' Uma rubrica ou fração indicada já não existe — recarregue a página e verifique as rubricas do orçamento.'
      : err.code === 'ER_DUP_ENTRY'
        ? ' Há uma rubrica repetida para a mesma fração.'
        : '';
    req.flash('error_msg', `Erro ao guardar a distribuição.${causa}`);
  }
  res.redirect(`/admin/orcamento/${orcamento.id}/distribuicao`);
});

// ── Plano de quotas ────────────────────────────────────────────────
router.get('/orcamento/:id/plano', async (req, res) => {
  const orcamento = await carregarOrcamento(req);
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
    // Os valores do plano são o TOTAL a cobrar (despesas + FCR): a vista
    // identifica a percentagem aplicada para o valor não parecer inexplicado.
    quotaConfig: await getQuotaConfig(req.condominioId),
  });
});

router.post('/orcamento/:id/plano', async (req, res) => {
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.naoAnulado(orcamento.estado)) {
    req.flash('error_msg', 'Orçamento anulado não pode ser alterado.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
  const rubricas = await OrcamentoRubrica.findAll({ where: { orcamento_id: orcamento.id, ativo: true } });
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId } });
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

  // A percentagem do FCR é do CONDOMÍNIO (não do orçamento). O plano passa a
  // representar o TOTAL a cobrar em cada quota (despesas + FCR), pela mesma
  // função do acréscimo usada na geração de quotas — sem ela, as quotas
  // emitidas a partir do orçamento ficavam sem componente de fundo.
  const { fcrPercentagem } = await getQuotaConfig(req.condominioId);
  const plano = calcularPlano({
    orcamento: orcamento.toJSON(),
    rubricas: rubricas.map((r) => r.toJSON()),
    distribuicoes: distribuicoes.map((d) => d.toJSON()),
    fracoes: fracoes.map((f) => f.toJSON()),
    fcrPercentagem,
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
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.naoAnulado(orcamento.estado)) {
    req.flash('error_msg', 'Orçamento anulado não pode emitir quotas.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
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
  const orcamento = await carregarOrcamento(req);
  if (!orcamento) return res.redirect('/admin/orcamento');
  if (!orcamentoEstado.naoAnulado(orcamento.estado)) {
    req.flash('error_msg', 'Orçamento anulado não pode emitir quotas.');
    return res.redirect(`/admin/orcamento/${orcamento.id}`);
  }
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

    // Componentes da quota: o valor do plano é o TOTAL a cobrar (despesas +
    // FCR, ver `helpers/plano.js`). A decomposição usa a MESMA regra D1 do
    // cálculo das quotas (`dividirComponentesQuota`) e a percentagem vem da
    // configuração do CONDOMÍNIO — sem isto, a quota emitida a partir do
    // orçamento ficava sem componente de fundo (`valor_fcr` nulo).
    const { fcrPercentagem } = await getQuotaConfig(req.condominioId);
    const fracoes = await Fracao.findAll({
      where: { condominio_id: orcamento.condominio_id },
      attributes: ['id', 'permilagem'],
      transaction: t,
    });
    const permilagemPorFracao = new Map(fracoes.map((f) => [Number(f.id), f.permilagem]));

    for (const p of plano) {
      const numero = await proximoNumero('aviso_quota', { ano, transaction: t });
      const partes = dividirComponentesQuota(toCents(p.valor), fcrPercentagem);
      await Quota.create(
        {
          condominio_id: orcamento.condominio_id,
          numero_documento: numero,
          fracao_id: p.fracao_id,
          orcamento_id: orcamento.id,
          ano,
          mes,
          periodo: new Date(ano, mes - 1, 1),
          valor: fromCents(partes.totalC),
          valor_base: fromCents(partes.baseC),
          valor_fcr: fromCents(partes.fcrC),
          permilagem_aplicada: permilagemPorFracao.get(Number(p.fracao_id)) ?? null,
          fcr_percentagem: partes.fcrPercentagem,
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
  const orcamento = await carregarOrcamento(req);
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
