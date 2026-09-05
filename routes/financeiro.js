const express = require('express');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const {
  ContaBancaria,
  Categoria,
  MetodoPagamento,
  Despesa,
  Quota,
  Pagamento,
  PagamentoQuota,
  Fracao,
  Pessoa,
  FracaoPessoa,
  Orcamento,
  OrcamentoRubrica,
  Documento,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { toCents, fromCents, toNumber } = require('../helpers/money');
const { MESES, monthName } = require('../helpers/dates');
const { resumoCondominio, resumoFracao, estadoEfetivo } = require('../helpers/saldos');
const { getCondominio } = require('../helpers/condominio');
const { proximoNumero } = require('../helpers/numeracao');
const { registarPagamento, anularPagamento } = require('../helpers/pagamentos');
const { sincronizarMovimentoDespesa } = require('../helpers/movimentos');
const { gerarAvisoQuotaPDF, gerarReciboPDF } = require('../helpers/pdf');
const { resolverDestinatarios } = require('../helpers/avisos');
const { enfileirarEmail } = require('../helpers/email-fila');
const { estaAtivo } = require('../helpers/notificacoes');
const { getQuotaConfig, setQuotaConfig } = require('../helpers/quotas-config');
const { calcularQuota, calcularQuotasOrcamento } = require('../helpers/quotas-calc');
const { validarPermilagem } = require('../helpers/permilagem');
const drive = require('../helpers/drive');

const router = express.Router();

router.use(eAdmin);

function parseDecimal(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

// ═══════════════════════════════════════════════════════════════════
// CONTAS BANCÁRIAS
// ═══════════════════════════════════════════════════════════════════
router.get('/contas', async (req, res) => {
  const contas = await ContaBancaria.findAll({ order: [['nome', 'ASC']] });
  const resumo = await resumoCondominio();
  const saldoPorId = {};
  resumo.contas.forEach((c) => (saldoPorId[c.id] = c.saldo));
  const linhas = contas.map((c) => ({ ...c.toJSON(), saldo: saldoPorId[c.id] }));
  res.render('admin/contas/listar', { titulo: 'Contas bancárias', contas: linhas, resumo });
});

router.get('/contas/nova', (req, res) => {
  res.render('admin/contas/form', { titulo: 'Nova conta bancária', conta: null });
});

router.post('/contas', async (req, res) => {
  const { nome, banco, iban, tipo, saldo_inicial } = req.body;
  const conta = await ContaBancaria.create({
    nome,
    banco,
    iban,
    tipo: tipo || 'corrente',
    saldo_inicial: toNumber(saldo_inicial),
  });
  await audit({ userId: req.user.id, acao: 'criar_conta_bancária', entidade: 'ContaBancaria', entidadeId: conta.id });
  req.flash('success_msg', 'Conta bancária criada.');
  res.redirect('/admin/contas');
});

router.get('/contas/:id/editar', async (req, res) => {
  const conta = await ContaBancaria.findByPk(req.params.id);
  if (!conta) return res.redirect('/admin/contas');
  res.render('admin/contas/form', { titulo: 'Editar conta bancária', conta });
});

router.post('/contas/:id', async (req, res) => {
  const conta = await ContaBancaria.findByPk(req.params.id);
  if (!conta) return res.redirect('/admin/contas');
  const { nome, banco, iban, tipo, saldo_inicial, ativa } = req.body;
  await conta.update({
    nome,
    banco,
    iban,
    tipo: tipo || 'corrente',
    saldo_inicial: toNumber(saldo_inicial),
    ativa: ativa === 'on' || ativa === '1' || ativa === true,
  });
  await audit({ userId: req.user.id, acao: 'editar_conta_bancária', entidade: 'ContaBancaria', entidadeId: conta.id });
  req.flash('success_msg', 'Conta bancária atualizada.');
  res.redirect('/admin/contas');
});

router.post('/contas/:id/eliminar', async (req, res) => {
  const conta = await ContaBancaria.findByPk(req.params.id);
  if (conta) {
    await conta.destroy();
    await audit({ userId: req.user.id, acao: 'eliminar_conta_bancária', entidade: 'ContaBancaria', entidadeId: req.params.id });
  }
  req.flash('success_msg', 'Conta bancária eliminada.');
  res.redirect('/admin/contas');
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORIAS
// ═══════════════════════════════════════════════════════════════════
router.get('/categorias', async (req, res) => {
  const categorias = await Categoria.findAll({ order: [['tipo', 'ASC'], ['nome', 'ASC']] });
  res.render('admin/categorias/listar', { titulo: 'Categorias', categorias });
});

router.post('/categorias', async (req, res) => {
  const { nome, tipo } = req.body;
  await Categoria.create({ nome, tipo: tipo || 'despesa' });
  req.flash('success_msg', 'Categoria criada.');
  res.redirect('/admin/categorias');
});

router.post('/categorias/:id', async (req, res) => {
  const cat = await Categoria.findByPk(req.params.id);
  if (cat) {
    const { nome, tipo, ativa } = req.body;
    await cat.update({ nome, tipo: tipo || 'despesa', ativa: ativa === 'on' || ativa === '1' || ativa === true });
  }
  req.flash('success_msg', 'Categoria atualizada.');
  res.redirect('/admin/categorias');
});

router.post('/categorias/:id/eliminar', async (req, res) => {
  const cat = await Categoria.findByPk(req.params.id);
  if (cat) await cat.destroy();
  req.flash('success_msg', 'Categoria eliminada.');
  res.redirect('/admin/categorias');
});

// ═══════════════════════════════════════════════════════════════════
// DESPESAS
// ═══════════════════════════════════════════════════════════════════
router.get('/despesas', async (req, res) => {
  const despesas = await Despesa.findAll({
    include: [
      { model: Categoria, as: 'categoria' },
      { model: ContaBancaria, as: 'conta_bancaria' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
    ],
    order: [['data', 'DESC']],
  });
  res.render('admin/despesas/listar', { titulo: 'Despesas', despesas });
});

router.get('/despesas/nova', async (req, res) => {
  const [categorias, contas, metodos] = await Promise.all([
    Categoria.findAll({ where: { tipo: 'despesa', ativa: true }, order: [['nome', 'ASC']] }),
    ContaBancaria.findAll({ where: { ativa: true }, order: [['nome', 'ASC']] }),
    MetodoPagamento.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] }),
  ]);
  res.render('admin/despesas/form', { titulo: 'Nova despesa', despesa: null, categorias, contas, metodos });
});

router.post('/despesas', async (req, res) => {
  const { descricao, categoria_id, valor, data, fornecedor, conta_bancaria_id, metodo_pagamento_id, observacoes, estado } = req.body;
  const dataObj = data ? new Date(data) : new Date();
  const numero = await proximoNumero('despesa', { ano: dataObj.getFullYear() });
  const despesa = await Despesa.create({
    numero_documento: numero,
    descricao,
    categoria_id: categoria_id || null,
    valor: toNumber(valor),
    data: dataObj,
    competencia_ano: dataObj.getFullYear(),
    competencia_mes: dataObj.getMonth() + 1,
    fornecedor,
    conta_bancaria_id: conta_bancaria_id || null,
    metodo_pagamento_id: metodo_pagamento_id || null,
    observacoes,
    estado: estado || 'registada',
  });
  await sincronizarMovimentoDespesa(despesa, req.user.id);
  await audit({ userId: req.user.id, acao: 'criar_despesa', entidade: 'Despesa', entidadeId: despesa.id });
  req.flash('success_msg', 'Despesa criada.');
  res.redirect('/admin/despesas');
});

router.get('/despesas/:id/editar', async (req, res) => {
  const despesa = await Despesa.findByPk(req.params.id);
  if (!despesa) return res.redirect('/admin/despesas');
  const [categorias, contas, metodos] = await Promise.all([
    Categoria.findAll({ where: { tipo: 'despesa' }, order: [['nome', 'ASC']] }),
    ContaBancaria.findAll({ order: [['nome', 'ASC']] }),
    MetodoPagamento.findAll({ order: [['nome', 'ASC']] }),
  ]);
  res.render('admin/despesas/form', { titulo: 'Editar despesa', despesa, categorias, contas, metodos });
});

router.post('/despesas/:id', async (req, res) => {
  const despesa = await Despesa.findByPk(req.params.id);
  if (!despesa) return res.redirect('/admin/despesas');
  const { descricao, categoria_id, valor, data, fornecedor, conta_bancaria_id, metodo_pagamento_id, observacoes, estado } = req.body;
  const dataObj = data ? new Date(data) : new Date();
  await despesa.update({
    descricao,
    categoria_id: categoria_id || null,
    valor: toNumber(valor),
    data: dataObj,
    competencia_ano: dataObj.getFullYear(),
    competencia_mes: dataObj.getMonth() + 1,
    fornecedor,
    conta_bancaria_id: conta_bancaria_id || null,
    metodo_pagamento_id: metodo_pagamento_id || null,
    observacoes,
    estado: estado || 'registada',
  });
  await sincronizarMovimentoDespesa(despesa, req.user.id);
  await audit({ userId: req.user.id, acao: 'editar_despesa', entidade: 'Despesa', entidadeId: despesa.id });
  req.flash('success_msg', 'Despesa atualizada.');
  res.redirect('/admin/despesas');
});

router.post('/despesas/:id/anular', async (req, res) => {
  const despesa = await Despesa.findByPk(req.params.id);
  if (despesa) {
    await despesa.update({ estado: 'anulada' });
    await sincronizarMovimentoDespesa(despesa, req.user.id);
    await audit({ userId: req.user.id, acao: 'anular_despesa', entidade: 'Despesa', entidadeId: despesa.id });
  }
  req.flash('success_msg', 'Despesa anulada.');
  res.redirect('/admin/despesas');
});

// ═══════════════════════════════════════════════════════════════════
// QUOTAS
// ═══════════════════════════════════════════════════════════════════
router.get('/quotas', async (req, res) => {
  const { ano, mes, estado } = req.query;
  const where = {};
  if (ano) where.ano = parseInt(ano, 10);
  if (mes) where.mes = parseInt(mes, 10);

  const quotas = await Quota.findAll({
    where,
    include: [{ model: Fracao, as: 'fracao' }],
    order: [['ano', 'DESC'], ['mes', 'DESC'], ['id', 'ASC']],
  });

  const quotaIds = quotas.map((q) => q.id);
  const aplicacoes = quotaIds.length
    ? await PagamentoQuota.findAll({
        where: { quota_id: quotaIds },
        include: [
          { model: Pagamento, as: 'pagamento', attributes: [], where: { estado: 'confirmado' }, required: true },
        ],
        raw: true,
      })
    : [];
  const pagoC = {};
  aplicacoes.forEach((a) => {
    pagoC[a.quota_id] = (pagoC[a.quota_id] || 0) + toCents(a.valor_aplicado);
  });

  const linhas = quotas
    .map((q) => {
      const efetivo = estadoEfetivo(q);
      const pago = fromCents(pagoC[q.id] || 0);
      return {
        ...q.toJSON(),
        estadoEfetivo: efetivo,
        pago,
        emAberto: fromCents(toCents(q.valor) - (pagoC[q.id] || 0)),
      };
    })
    .filter((q) => (estado ? q.estadoEfetivo === estado : true));

  const [anos, quotaConfig, fracoes] = await Promise.all([
    Quota.findAll({ attributes: [[sequelize.fn('DISTINCT', sequelize.col('ano')), 'ano']], order: [['ano', 'DESC']], raw: true }),
    getQuotaConfig(),
    Fracao.findAll({ where: { estado: 'ativo' } }),
  ]);

  // Validação da soma das permilagens (ideal: 1000‰)
  const permilagem = validarPermilagem(fracoes);

  // Total mensal previsto das quotas (valor por 1000‰ + FCR)
  const previstasMesC = fracoes.reduce((s, f) => {
    const { totalC } = calcularQuota(f.permilagem, quotaConfig.valorPor1000, quotaConfig.fcrPercentagem);
    return s + totalC;
  }, 0);

  res.render('admin/quotas/listar', {
    titulo: 'Quotas',
    quotas: linhas,
    filtros: { ano: ano || '', mes: mes || '', estado: estado || '' },
    anos: anos.map((a) => a.ano),
    meses: MESES,
    quotaConfig,
    permilagem,
    previstasMes: fromCents(previstasMesC),
    driveLigado: drive.isConfigured(),
  });
});

// Configuração das quotas (valor por 1000‰ + FCR)
router.post('/quotas/config', async (req, res) => {
  const valorPor1000 = parseDecimal(req.body.valor_1000 ?? req.body.valor_permilagem);
  const fcrPercentagem = parseInt(req.body.fcr_percentagem, 10);

  if (valorPor1000 <= 0) {
    req.flash('error_msg', 'O valor por 1000‰ tem de ser maior que zero.');
    return res.redirect('/admin/quotas');
  }
  if (isNaN(fcrPercentagem) || fcrPercentagem < 0 || fcrPercentagem > 100) {
    req.flash('error_msg', 'O FCR tem de estar entre 0 e 100%.');
    return res.redirect('/admin/quotas');
  }

  await setQuotaConfig({ valorPor1000, fcrPercentagem });

  // Recalcular quotas futuras não pagas (se pedido)
  if (req.body.recalcular === 'futuras') {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const futuras = await Quota.findAll({
      where: { estado: { [Op.in]: ['pendente', 'parcialmente_paga'] }, data_vencimento: { [Op.gte]: hoje } },
    });
    for (const q of futuras) {
      const fracao = await Fracao.findByPk(q.fracao_id);
      if (!fracao) continue;
      const calc = calcularQuota(fracao.permilagem, valorPor1000, fcrPercentagem);
      await q.update({
        valor_base: calc.base,
        valor_fcr: calc.fcr,
        valor: calc.total,
        valor_por_1000: calc.valorPor1000,
        permilagem_aplicada: calc.permilagem,
        fcr_percentagem: calc.fcrPercentagem,
      });
    }
    req.flash('success_msg', `Configuração guardada e ${futuras.length} quota(s) futura(s) recalculada(s).`);
  } else {
    req.flash('success_msg', 'Configuração guardada (aplica-se a quotas futuras ainda não geradas).');
  }

  await audit({ userId: req.user.id, acao: 'configurar_quotas', entidade: 'Configuracao', detalhes: { valorPor1000, fcrPercentagem } });
  res.redirect('/admin/quotas');
});

// Grelha anual do estado das quotas por fração × mês
router.get('/quotas/grelha', async (req, res) => {
  const ano = parseInt(req.query.ano || new Date().getFullYear(), 10);
  const [fracoes, quotas, anos] = await Promise.all([
    Fracao.findAll({ order: [['designacao', 'ASC']] }),
    Quota.findAll({ where: { ano } }),
    Quota.findAll({ attributes: [[sequelize.fn('DISTINCT', sequelize.col('ano')), 'ano']], order: [['ano', 'DESC']], raw: true }),
  ]);

  const porFracao = {};
  quotas.forEach((q) => {
    if (!porFracao[q.fracao_id]) porFracao[q.fracao_id] = {};
    porFracao[q.fracao_id][q.mes] = { id: q.id, estado: estadoEfetivo(q) };
  });

  const linhas = fracoes.map((f) => ({
    id: f.id,
    designacao: f.designacao,
    permilagem: f.permilagem,
    meses: Array.from({ length: 12 }, (_, i) => (porFracao[f.id] ? porFracao[f.id][i + 1] || null : null)),
  }));

  res.render('admin/quotas/grelha', {
    titulo: 'Grelha de quotas',
    ano,
    linhas,
    anos: anos.map((a) => a.ano),
    meses: MESES,
  });
});

router.get('/quotas/gerar', async (req, res) => {
  const [fracoes, quotaConfig, orcamentos, existentes] = await Promise.all([
    Fracao.findAll({ where: { estado: 'ativo' }, order: [['designacao', 'ASC']] }),
    getQuotaConfig(),
    Orcamento.findAll({
      where: { estado: { [Op.ne]: 'anulado' } },
      include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
      order: [['data_inicio', 'DESC']],
    }),
    Quota.findAll({ attributes: ['fracao_id', 'ano', 'mes'], raw: true }),
  ]);

  // Orçamentos com total de rubricas (receita anual definida pelo orçamento).
  const orcamentosJson = orcamentos.map((o) => {
    const totalC = o.rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
    return {
      id: o.id,
      designacao: o.designacao,
      anoInicio: new Date(o.data_inicio).getFullYear(),
      total: fromCents(totalC),
    };
  });

  // Conjunto de quotas já existentes (fração|ano|mes) para o preview idempotente.
  const existentesSet = {};
  existentes.forEach((q) => {
    existentesSet[`${q.fracao_id}|${q.ano}|${q.mes}`] = true;
  });

  res.render('admin/quotas/gerar', {
    titulo: 'Gerar quotas',
    fracoes,
    quotaConfig,
    orcamentos: orcamentosJson,
    orcamentosJson: JSON.stringify(orcamentosJson),
    fracoesJson: JSON.stringify(fracoes.map((f) => ({ id: f.id, designacao: f.designacao, permilagem: f.permilagem }))),
    existentesJson: JSON.stringify(existentesSet),
  });
});

router.post('/quotas/gerar', async (req, res) => {
  const escopo = req.body.escopo || 'mes'; // 'mes' | 'ano'
  const metodo = req.body.metodo === 'orcamento' ? 'orcamento' : 'permilagem';
  const anoNum = parseInt(req.body.ano, 10);
  const mesNum = escopo === 'ano' ? null : parseInt(req.body.mes, 10);
  const vencDia = parseInt(req.body.vencimento_dia, 10) || 8;
  const orcamentoId = parseInt(req.body.orcamento_id, 10) || null;

  if (!anoNum || (escopo === 'mes' && !mesNum)) {
    req.flash('error_msg', 'Indique o ano (e o mês, se aplicável).');
    return res.redirect('/admin/quotas/gerar');
  }

  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' }, order: [['designacao', 'ASC']] });
  const meses = escopo === 'ano' ? Array.from({ length: 12 }, (_, i) => i + 1) : [mesNum];

  // Método 1 (permilagem + FCR via config) vs Método 2 (orçamento define a receita).
  let valoresPorFracao;
  let metodoLabel;
  if (metodo === 'orcamento') {
    if (!orcamentoId) {
      req.flash('error_msg', 'Selecione o orçamento que define a receita.');
      return res.redirect('/admin/quotas/gerar');
    }
    const orcamento = await Orcamento.findByPk(orcamentoId, {
      include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
    });
    if (!orcamento) {
      req.flash('error_msg', 'Orçamento não encontrado.');
      return res.redirect('/admin/quotas/gerar');
    }
    const totalAnualC = orcamento.rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
    valoresPorFracao = calcularQuotasOrcamento({
      fracoes,
      totalAnual: fromCents(totalAnualC),
      metodo: 'permilagem',
      meses: 12,
    });
    metodoLabel = `orçamento ${orcamento.designacao}`;
  } else {
    const { valorPor1000, fcrPercentagem } = await getQuotaConfig();
    valoresPorFracao = new Map(
      fracoes.map((f) => [f.id, calcularQuota(f.permilagem, valorPor1000, fcrPercentagem)])
    );
    metodoLabel = 'permilagem + FCR';
  }

  const t = await sequelize.transaction();
  let criadas = 0;
  let ignoradas = 0;
  try {
    for (const f of fracoes) {
      const v = valoresPorFracao.get(f.id);
      for (const m of meses) {
        const existente = await Quota.findOne({ where: { fracao_id: f.id, ano: anoNum, mes: m }, transaction: t });
        if (existente) {
          ignoradas++;
          continue;
        }
        const numero = await proximoNumero('aviso_quota', { ano: anoNum, transaction: t });
        await Quota.create(
          {
            numero_documento: numero,
            fracao_id: f.id,
            ano: anoNum,
            mes: m,
            periodo: new Date(anoNum, m - 1, 1),
            valor: v.total,
            valor_base: v.base,
            valor_fcr: v.fcr,
            valor_por_1000: v.valorPor1000,
            permilagem_aplicada: v.permilagem ?? f.permilagem,
            fcr_percentagem: v.fcrPercentagem,
            data_emissao: new Date(),
            data_vencimento: new Date(anoNum, m - 1, vencDia),
            estado: 'pendente',
          },
          { transaction: t }
        );
        criadas++;
      }
    }
    await t.commit();
    await audit({ userId: req.user.id, acao: 'gerar_quotas', entidade: 'Quota', detalhes: { ano: anoNum, mes: mesNum, escopo, metodo: metodoLabel, criadas } });
    req.flash('success_msg', `Geradas ${criadas} quota(s)${ignoradas ? `; ${ignoradas} já existiam (não duplicadas)` : ''} (${metodoLabel}).`);
  } catch (err) {
    await t.rollback();
    console.error(err);
    req.flash('error_msg', 'Não foi possível gerar as quotas. Verifique os dados e tente novamente.');
  }
  res.redirect('/admin/quotas');
});

router.get('/quotas/:id', async (req, res) => {
  const quota = await Quota.findByPk(req.params.id, { include: [{ model: Fracao, as: 'fracao' }] });
  if (!quota) return res.redirect('/admin/quotas');
  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: quota.id },
    include: [
      { model: Pagamento, as: 'pagamento', where: { estado: 'confirmado' }, required: false },
    ],
    order: [['id', 'ASC']],
  });
  const pagoC = aplicacoes
    .filter((a) => a.pagamento)
    .reduce((s, a) => s + toCents(a.valor_aplicado), 0);
  const ultima = aplicacoes
    .filter((a) => a.pagamento && a.pagamento.data_pagamento)
    .map((a) => a.pagamento.data_pagamento)
    .sort()
    .pop();
  res.render('admin/quotas/detalhe', {
    titulo: `Quota ${quota.numero_documento || ''}`,
    quota,
    aplicacoes,
    estadoEfetivo: estadoEfetivo(quota),
    pago: fromCents(pagoC),
    emFalta: fromCents(toCents(quota.valor) - pagoC),
    ultimaData: ultima || null,
    driveLigado: drive.isConfigured(),
  });
});

router.get('/quotas/:id/editar', async (req, res) => {
  const quota = await Quota.findByPk(req.params.id, { include: [{ model: Fracao, as: 'fracao' }] });
  if (!quota) return res.redirect('/admin/quotas');
  res.render('admin/quotas/form', { titulo: 'Editar quota', quota });
});

router.post('/quotas/:id', async (req, res) => {
  const quota = await Quota.findByPk(req.params.id);
  if (!quota) return res.redirect('/admin/quotas');
  const { valor, data_emissao, data_vencimento, observacoes } = req.body;
  await quota.update({
    valor: toNumber(valor),
    data_emissao: data_emissao || quota.data_emissao,
    data_vencimento: data_vencimento || quota.data_vencimento,
    observacoes,
  });
  await audit({ userId: req.user.id, acao: 'editar_quota', entidade: 'Quota', entidadeId: quota.id });
  req.flash('success_msg', 'Quota atualizada.');
  res.redirect('/admin/quotas');
});

router.post('/quotas/:id/anular', async (req, res) => {
  const quota = await Quota.findByPk(req.params.id);
  if (quota) {
    await quota.update({ estado: 'anulada' });
    await audit({ userId: req.user.id, acao: 'anular_quota', entidade: 'Quota', entidadeId: quota.id });
  }
  req.flash('success_msg', 'Quota anulada.');
  res.redirect('/admin/quotas');
});

// ═══════════════════════════════════════════════════════════════════
// PAGAMENTOS
// ═══════════════════════════════════════════════════════════════════
router.get('/pagamentos', async (req, res) => {
  const pagamentos = await Pagamento.findAll({
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: ContaBancaria, as: 'conta_bancaria' },
    ],
    order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
  });
  res.render('admin/pagamentos/listar', { titulo: 'Pagamentos', pagamentos, driveLigado: drive.isConfigured() });
});

router.get('/pagamentos/nova', async (req, res) => {
  const [fracoes, metodos, contas] = await Promise.all([
    Fracao.findAll({ order: [['designacao', 'ASC']] }),
    MetodoPagamento.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] }),
    ContaBancaria.findAll({ where: { ativa: true }, order: [['nome', 'ASC']] }),
  ]);
  res.render('admin/pagamentos/form', { titulo: 'Registar pagamento', fracoes, metodos, contas });
});

router.post('/pagamentos', async (req, res) => {
  const { fracao_id, valor, data_pagamento, metodo_pagamento_id, conta_bancaria_id, referencia, observacoes } = req.body;
  try {
    const resultado = await registarPagamento({
      fracaoId: fracao_id,
      valor: toNumber(valor),
      dataPagamento: data_pagamento || new Date(),
      metodoPagamentoId: metodo_pagamento_id || null,
      contaBancariaId: conta_bancaria_id || null,
      referencia,
      observacoes,
      userId: req.user.id,
    });
    await audit({ userId: req.user.id, acao: 'registar_pagamento', entidade: 'Pagamento', entidadeId: resultado.pagamento.id });

    // Envio automático do recibo (fila de email) — respeita a preferência
    // "Recibos → email" configurada em Emails → Notificações.
    if (await estaAtivo('recibos', 'email')) {
      try {
        const dest = await resolverDestinatarios({ modo: 'fracoes', fracoes: [fracao_id] });
        const linkRecibo = `${req.protocol}://${req.get('host')}/admin/pagamentos/${resultado.pagamento.id}/recibo`;
        for (const d of dest) {
          await enfileirarEmail({
            destinatario_email: d.email,
            destinatario_nome: d.nome,
            assunto: `Recibo ${resultado.pagamento.numero_documento}`,
            corpo: `Foi registado um pagamento no valor de ${resultado.pagamento.valor} €.\nRecibo: ${linkRecibo}`,
          });
        }
      } catch (err) {
        console.error('[recibo-email]', err.message);
      }
    }

    const msg = `Pagamento registado (recibo ${resultado.pagamento.numero_documento}).`;
    req.flash('success_msg', resultado.excedente > 0 ? `${msg} Ficou ${resultado.excedente.toFixed(2)} € por aplicar (crédito).` : msg);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao registar o pagamento.');
  }
  res.redirect('/admin/pagamentos');
});

router.get('/pagamentos/:id', async (req, res) => {
  const pagamento = await Pagamento.findByPk(req.params.id, {
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: ContaBancaria, as: 'conta_bancaria' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor_aplicado'] } },
    ],
  });
  if (!pagamento) return res.redirect('/admin/pagamentos');
  res.render('admin/pagamentos/detalhe', { titulo: `Recibo ${pagamento.numero_documento || ''}`, pagamento, driveLigado: drive.isConfigured() });
});

router.post('/pagamentos/:id/anular', async (req, res) => {
  try {
    const ok = await anularPagamento(req.params.id);
    await audit({ userId: req.user.id, acao: 'anular_pagamento', entidade: 'Pagamento', entidadeId: req.params.id });
    req.flash('success_msg', ok ? 'Pagamento anulado.' : 'Pagamento já se encontrava anulado.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao anular o pagamento.');
  }
  res.redirect('/admin/pagamentos');
});

// ── PDFs ───────────────────────────────────────────────────────────
async function nomeProprietarioPrincipal(fracaoId) {
  const vinculo = await FracaoPessoa.findOne({
    where: { fracao_id: fracaoId, vinculo: 'proprietario' },
    include: [{ model: Pessoa, as: 'pessoa' }],
  });
  return vinculo && vinculo.pessoa ? vinculo.pessoa.nome : 'Condómino';
}

// Gera o buffer do aviso de quota (partilhado entre ver/descarregar e Drive).
async function construirAvisoQuota(quotaId) {
  const quota = await Quota.findByPk(quotaId, { include: [{ model: Fracao, as: 'fracao' }] });
  if (!quota) throw new Error('Quota não encontrada.');
  const condominio = await getCondominio();
  const resumo = await resumoFracao(quota.fracao_id);
  const destinatarioNome = await nomeProprietarioPrincipal(quota.fracao_id);

  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: quota.id },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
  });
  const pagoAplicadoC = aplicacoes
    .filter((a) => a.pagamento && a.pagamento.estado === 'confirmado')
    .reduce((s, a) => s + toCents(a.valor_aplicado), 0);
  const quotaEmAberto = fromCents(toCents(quota.valor) - pagoAplicadoC);
  const emDividaC = toCents(resumo.emDivida);
  const saldoAnterior = fromCents(emDividaC - toCents(quota.valor) + pagoAplicadoC);

  const buffer = await gerarAvisoQuotaPDF(condominio.toJSON(), {
    numero: quota.numero_documento,
    periodo: `${monthName(quota.mes)} ${quota.ano}`,
    dataEmissao: quota.data_emissao,
    dataVencimento: quota.data_vencimento,
    valor: quota.valor,
    destinatarioNome,
    fracaoDesignacao: quota.fracao.designacao,
    fracaoMorada: [condominio.morada, [condominio.codigo_postal, condominio.localidade].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    saldoAnterior,
    ultimoPagamento: resumo.ultimoPagamento,
    ultimoPagamentoValor: resumo.ultimoPagamento ? resumo.ultimoPagamento.valor : null,
    ultimoPagamentoData: resumo.ultimoPagamento ? resumo.ultimoPagamento.data : null,
    emDivida: resumo.emDivida,
    totalAPagar: quotaEmAberto,
    iban: condominio.iban_principal,
    outrosMeiosPagamento: condominio.outros_meios_pagamento,
    referencia: null,
    instrucoesPagamento: condominio.dados_bancarios_adicionais,
  });
  return { buffer, quota };
}

// Gera o buffer do recibo (partilhado entre ver/descarregar e Drive).
async function construirRecibo(pagamentoId) {
  const pagamento = await Pagamento.findByPk(pagamentoId, {
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor_aplicado'] } },
    ],
  });
  if (!pagamento) throw new Error('Pagamento não encontrado.');
  const condominio = await getCondominio();
  const resumo = await resumoFracao(pagamento.fracao_id);
  const condominoNome = await nomeProprietarioPrincipal(pagamento.fracao_id);

  const buffer = await gerarReciboPDF(condominio.toJSON(), {
    numero: pagamento.numero_documento,
    data: pagamento.data_pagamento,
    dataPagamento: pagamento.data_pagamento,
    valor: pagamento.valor,
    condominoNome,
    fracaoDesignacao: pagamento.fracao.designacao,
    metodoPagamento: pagamento.metodo_pagamento ? pagamento.metodo_pagamento.nome : null,
    referencia: pagamento.referencia,
    quotas: pagamento.quotas.map((q) => ({
      numero: q.numero_documento,
      periodo: `${monthName(q.mes)} ${q.ano}`,
      valorAplicado: q.PagamentoQuota ? q.PagamentoQuota.valor_aplicado : 0,
    })),
    saldoAposPagamento: resumo.emDivida,
  });
  return { buffer, pagamento };
}

router.get('/quotas/:id/aviso', async (req, res) => {
  try {
    const { buffer, quota } = await construirAvisoQuota(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="aviso_${quota.numero_documento || quota.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao gerar o aviso de quota.');
    res.redirect('/admin/quotas');
  }
});

router.get('/pagamentos/:id/recibo', async (req, res) => {
  try {
    const { buffer, pagamento } = await construirRecibo(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo_${pagamento.numero_documento || pagamento.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao gerar o recibo.');
    res.redirect('/admin/pagamentos');
  }
});

// Guarda no Google Drive um PDF gerado pelo Financeiro (aviso/recibo) e
// regista-o como Documento (fica disponível na biblioteca para enviar por email).
async function guardarPdfFinanceiroDrive({ tipo, numeroDocumento, nome, buffer, anoData, userId }) {
  if (!drive.isConfigured()) throw new Error('Google Drive não está ligado (Configuração → Google Drive).');
  const pastaId = await drive.pastaParaDocumento(tipo, anoData);
  const up = await drive.uploadArquivo({ nome, mimeType: 'application/pdf', buffer, parentFolderId: pastaId });
  const doc = await Documento.create({
    tipo,
    numero_documento: numeroDocumento || null,
    nome,
    pasta: tipo === 'recibo' ? 'recibos' : 'quotas',
    drive_file_id: up.driveFileId,
    drive_folder_id: pastaId,
    mime_type: 'application/pdf',
    tamanho: up.tamanho,
    data: anoData ? new Date(anoData, 0, 1) : new Date(),
    url: up.url,
    drive_status: 'guardado',
    drive_uploaded_at: new Date(),
    created_by: userId,
  });
  return { doc, up };
}

router.post('/quotas/:id/aviso/drive', async (req, res) => {
  try {
    const { buffer, quota } = await construirAvisoQuota(req.params.id);
    const ano = quota.data_emissao ? new Date(quota.data_emissao).getFullYear() : new Date().getFullYear();
    const { doc } = await guardarPdfFinanceiroDrive({
      tipo: 'aviso_quota',
      numeroDocumento: quota.numero_documento,
      nome: `Aviso de quota ${quota.numero_documento || quota.id}`,
      buffer,
      anoData: ano,
      userId: req.user.id,
    });
    await audit({ userId: req.user.id, acao: 'guardar_documento_drive', entidade: 'Documento', entidadeId: doc.id, detalhes: { tipo: 'aviso_quota' } }).catch(() => {});
    req.flash('success_msg', 'Aviso de quota guardado no Google Drive.');
  } catch (err) {
    console.error('[aviso-drive]', err.message);
    req.flash('error_msg', `Não foi possível guardar no Drive: ${err.message}`);
  }
  res.redirect('/admin/quotas');
});

router.post('/pagamentos/:id/recibo/drive', async (req, res) => {
  try {
    const { buffer, pagamento } = await construirRecibo(req.params.id);
    const ano = pagamento.data_pagamento ? new Date(pagamento.data_pagamento).getFullYear() : new Date().getFullYear();
    const { doc } = await guardarPdfFinanceiroDrive({
      tipo: 'recibo',
      numeroDocumento: pagamento.numero_documento,
      nome: `Recibo ${pagamento.numero_documento || pagamento.id}`,
      buffer,
      anoData: ano,
      userId: req.user.id,
    });
    await audit({ userId: req.user.id, acao: 'guardar_documento_drive', entidade: 'Documento', entidadeId: doc.id, detalhes: { tipo: 'recibo' } }).catch(() => {});
    req.flash('success_msg', 'Recibo guardado no Google Drive.');
  } catch (err) {
    console.error('[recibo-drive]', err.message);
    req.flash('error_msg', `Não foi possível guardar no Drive: ${err.message}`);
  }
  res.redirect('/admin/pagamentos');
});

module.exports = router;
