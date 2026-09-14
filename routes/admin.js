const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const {
  Fracao,
  Pessoa,
  FracaoPessoa,
  FracaoTitularidade,
  User,
  UserCondominio,
  Condominio,
  Categoria,
  MetodoPagamento,
  ContaBancaria,
  Quota,
  Pagamento,
  Despesa,
  Documento,
  Aviso,
  AvisoDestinatario,
  Fornecedor,
  PagamentoFornecedor,
  BackupLog,
  EmailFila,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const { toCents, fromCents } = require('../helpers/money');
const { audit } = require('../helpers/audit');
const { getCondominio } = require('../helpers/condominio');
const { resumoCondominio, resumoFracao, estadoEfetivo } = require('../helpers/saldos');
const { resumoFinanceiroMes, resumoEmAtraso, orcamentoDoAno } = require('../helpers/dashboard');
// Histórico de titularidade da fração (relação temporal pessoa/conta ↔ fração).
const titularidades = require('../helpers/titularidades');
const { validarNif } = require('../public/js/validacao-fiscal');
const drive = require('../helpers/drive');
const { smtpConfigured, sendMail } = require('../helpers/mailer');
const convites = require('../helpers/convites');
const background = require('../helpers/background-jobs');
const { sincronizarContactosPessoa, parseContactosForm, validarContactos, contactosParaForm } = require('../helpers/contactos');

const router = express.Router();

// Isolamento: condomínio ativo (sessão validada) em todas as operações.
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('admin'));

// Escopo e carregadores restritos ao condomínio ativo (bloqueiam IDOR).
function onde(req, extra = {}) {
  return { condominio_id: req.condominioId, ...extra };
}
function carregarFracao(req) {
  return Fracao.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
}
function carregarPessoa(req) {
  return Pessoa.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
}

function parseDecimal(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// ── Dashboard ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const [nFracoes, nPessoas, nUsers, condominio, resumo, quotas, ultimoBackup, filaPendentes, filaErros] =
    await Promise.all([
      Fracao.count({ where: onde(req) }),
      Pessoa.count({ where: onde(req) }),
      UserCondominio.count({ where: { condominio_id: req.condominioId } }),
      getCondominio({ id: req.condominioId }),
      resumoCondominio(req.condominioId),
      Quota.findAll({ where: onde(req, { estado: { [Op.ne]: 'anulada' } }) }),
      BackupLog.findOne({ order: [['id', 'DESC']] }),
      // Contagens da fila isoladas por condomínio (nunca globais).
      EmailFila.count({ where: onde(req, { estado: 'pendente' }) }),
      EmailFila.count({ where: onde(req, { estado: 'erro' }) }),
    ]);

  const [nDriveDocs, nEmailsEnviados, nFornecedores, nPagFornecedorPendentes] = await Promise.all([
    Documento.count({ where: onde(req, { drive_status: 'guardado' }) }),
    // Contagens isoladas por condomínio (nunca globais).
    EmailFila.count({ where: onde(req, { estado: 'enviado' }) }),
    Fornecedor.count({ where: onde(req, { ativo: true }) }),
    PagamentoFornecedor.count({ where: onde(req, { estado: 'pendente' }) }),
  ]);

  const nPagas = quotas.filter((q) => q.estado === 'paga').length;
  const nPendentes = quotas.filter((q) => ['pendente', 'parcialmente_paga'].includes(q.estado)).length;
  const nVencidas = quotas.filter((q) => estadoEfetivo(q) === 'vencida').length;

  // Gráficos do dashboard (ano corrente)
  const anoAtual = new Date().getFullYear();
  const mesAtual = new Date().getMonth() + 1;
  const [pagamentos, despesas, financeiroMes, emAtraso, orcamentoAno] = await Promise.all([
    Pagamento.findAll({ attributes: ['valor', 'data_pagamento'], where: onde(req, { estado: 'confirmado' }), raw: true }),
    Despesa.findAll({
      attributes: ['valor', 'data'],
      where: onde(req, { estado: { [Op.ne]: 'anulada' } }),
      include: [{ model: Categoria, as: 'categoria', attributes: ['nome'] }],
      raw: true,
    }),
    resumoFinanceiroMes(anoAtual, mesAtual, req.condominioId),
    resumoEmAtraso(req.condominioId),
    orcamentoDoAno(anoAtual, req.condominioId),
  ]);

  const receitasMes = Array(12).fill(0);
  const despesasMes = Array(12).fill(0);
  const porCategoria = {};

  pagamentos.forEach((p) => {
    const d = p.data_pagamento ? new Date(p.data_pagamento) : null;
    if (d && !isNaN(d.getTime()) && d.getFullYear() === anoAtual) receitasMes[d.getMonth()] += toCents(p.valor);
  });
  despesas.forEach((d) => {
    const dt = d.data ? new Date(d.data) : null;
    if (dt && !isNaN(dt.getTime()) && dt.getFullYear() === anoAtual) despesasMes[dt.getMonth()] += toCents(d.valor);
    const nome = d['categoria.nome'] || 'Outras';
    porCategoria[nome] = (porCategoria[nome] || 0) + toCents(d.valor);
  });

  const categoriasTop = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).slice(0, 6);

  // TOP DEVEDORES (Painel): agrupado por fração, quotas não pagas.
  const fracoesTodas = await Fracao.findAll({ attributes: ['id', 'designacao'], where: onde(req) });
  const nomeFracao = new Map(fracoesTodas.map((f) => [f.id, f.designacao]));
  const mapaDivida = new Map();
  for (const q of quotas) {
    if (q.estado === 'anulada') continue;
    const st = estadoEfetivo(q);
    if (st === 'paga' || st === 'anulada') continue;
    const e = mapaDivida.get(q.fracao_id) || { fracao: nomeFracao.get(q.fracao_id) || `#${q.fracao_id}`, meses: new Set(), totalC: 0 };
    e.meses.add(`${q.ano}-${String(q.mes).padStart(2, '0')}`);
    e.totalC += toCents(q.valor);
    mapaDivida.set(q.fracao_id, e);
  }
  const topDevedores = [...mapaDivida.values()]
    .map((e) => ({ fracao: e.fracao, meses: e.meses.size, totalC: e.totalC, total: fromCents(e.totalC) }))
    .sort((a, b) => b.totalC - a.totalC)
    .slice(0, 5);

  res.render('admin/dashboard', {
    titulo: 'Painel de administração',
    nFracoes,
    nPessoas,
    nUsers,
    condominio: condominio ? condominio.toJSON() : null,
    resumo,
    nPagas,
    nPendentes,
    nVencidas,
    nDriveDocs,
    nEmailsEnviados,
    nFornecedores,
    nPagFornecedorPendentes,
    topDevedores,
    anoAtual,
    financeiroMes,
    emAtraso,
    orcamentoAno: orcamentoAno,
    sistema: {
      driveLigado: drive.isConfigured(),
      smtp: smtpConfigured(),
      ultimoBackup,
      filaPendentes,
      filaErros,
    },
    chartFinanceiro: JSON.stringify({
      labels: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
      receitas: receitasMes.map((c) => fromCents(c)),
      despesas: despesasMes.map((c) => fromCents(c)),
    }),
    chartCategorias: JSON.stringify({
      labels: categoriasTop.map(([n]) => n),
      valores: categoriasTop.map(([, v]) => fromCents(v)),
    }),
  });
});

// ═══════════════════════════════════════════════════════════════════
// FRAÇÕES
// ═══════════════════════════════════════════════════════════════════
router.get('/fracoes', async (req, res) => {
  const fracoes = await Fracao.findAll({
    where: onde(req),
    include: [{ model: Pessoa, as: 'pessoas', through: { attributes: ['vinculo'] } }],
    order: [['designacao', 'ASC']],
  });
  res.render('admin/fracoes/listar', { titulo: 'Frações', fracoes });
});

router.get('/fracoes/nova', (req, res) => {
  res.render('admin/fracoes/form', { titulo: 'Nova fração', fracao: null });
});

router.post('/fracoes', async (req, res) => {
  try {
    const { designacao, permilagem, andar, porta, observacoes, estado } = req.body;
    const fracao = await Fracao.create({
      condominio_id: req.condominioId,
      designacao,
      permilagem: parseDecimal(permilagem),
      andar,
      porta,
      observacoes,
      estado: estado || 'ativo',
    });
    await audit({ userId: req.user.id, acao: 'criar_fração', entidade: 'Fracao', entidadeId: fracao.id });
    req.flash('success_msg', 'Fração criada com sucesso.');
    res.redirect('/admin/fracoes');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao criar a fração.');
    res.redirect('/admin/fracoes/nova');
  }
});

router.get('/fracoes/:id/editar', async (req, res) => {
  const fracao = await Fracao.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Pessoa, as: 'pessoas', through: { attributes: ['id', 'vinculo', 'data_inicio', 'data_fim'] } }],
  });
  if (!fracao) {
    req.flash('error_msg', 'Fração não encontrada.');
    return res.redirect('/admin/fracoes');
  }
  const pessoas = await Pessoa.findAll({ where: onde(req, { ativo: true }), order: [['nome', 'ASC']] });
  // Titularidade: quem é titular agora e o histórico completo (os períodos nunca
  // são apagados, por isso é possível ver quem foi proprietário e quando).
  const [titulares, historico] = await Promise.all([
    titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id }),
    titularidades.historicoDaFracao({ condominioId: req.condominioId, fracaoId: fracao.id }),
  ]);
  // Uma conta só existe depois de criada/convite aceite (fluxo de Utilizadores).
  // Sem conta, o titular consta do histórico mas não tem acesso ao GesCondu.
  const idsPessoasTitulares = [...new Set(titulares.map((t) => t.pessoa_id).filter(Boolean))];
  const contasPorPessoa = new Map();
  if (idsPessoasTitulares.length) {
    const contas = await User.findAll({
      where: { pessoa_id: { [Op.in]: idsPessoasTitulares } },
      attributes: ['id', 'pessoa_id'],
    });
    contas.forEach((c) => {
      const chave = Number(c.pessoa_id);
      contasPorPessoa.set(chave, (contasPorPessoa.get(chave) || 0) + 1);
    });
  }
  const titularesComConta = titulares.map((t) => {
    const n = contasPorPessoa.get(Number(t.pessoa_id)) || 0;
    return { ...t.toJSON(), temConta: n > 0, contasMultiplas: n > 1 };
  });

  res.render('admin/fracoes/form', {
    titulo: 'Editar fração',
    fracao,
    pessoas,
    titulares: titularesComConta,
    historico,
    // Data de hoje no formato dos inputs <input type="date">.
    hoje: titularidades.hojeISO(),
    // Dois proprietários ativos ao mesmo tempo é sinal de que uma mudança de
    // proprietário ficou a meio (o anterior não foi encerrado).
    proprietariosDuplicados: titularesComConta.filter((t) => t.vinculo === 'proprietario').length > 1,
  });
});

router.post('/fracoes/:id', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) {
    req.flash('error_msg', 'Fração não encontrada.');
    return res.redirect('/admin/fracoes');
  }
  const { designacao, permilagem, andar, porta, observacoes, estado } = req.body;
  await fracao.update({
    designacao,
    permilagem: parseDecimal(permilagem),
    andar,
    porta,
    observacoes,
    estado: estado || 'ativo',
  });
  await audit({ userId: req.user.id, acao: 'editar_fração', entidade: 'Fracao', entidadeId: fracao.id });
  req.flash('success_msg', 'Fração atualizada.');
  res.redirect('/admin/fracoes');
});

router.post('/fracoes/:id/eliminar', async (req, res) => {
  try {
    const fracao = await carregarFracao(req);
    if (fracao) {
      await fracao.destroy();
      await audit({ userId: req.user.id, acao: 'eliminar_fração', entidade: 'Fracao', entidadeId: req.params.id });
    }
    req.flash('success_msg', 'Fração eliminada.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Não foi possível eliminar a fração (pode ter registos associados).');
  }
  res.redirect('/admin/fracoes');
});

// Vínculos fração ↔ pessoa (ambos do condomínio ativo)
router.post('/fracoes/:id/pessoas', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const { pessoa_id, vinculo, data_inicio, data_fim } = req.body;
  try {
    const pessoa = await Pessoa.findOne({ where: { id: pessoa_id, condominio_id: req.condominioId } });
    if (!pessoa) {
      req.flash('error_msg', 'Pessoa não encontrada neste condomínio.');
      return res.redirect(`/admin/fracoes/${fracao.id}/editar`);
    }
    await FracaoPessoa.findOrCreate({
      where: { fracao_id: fracao.id, pessoa_id: pessoa.id, vinculo: vinculo || 'proprietario' },
      defaults: {
        fracao_id: fracao.id,
        pessoa_id: pessoa.id,
        vinculo: vinculo || 'proprietario',
        data_inicio: data_inicio || null,
        data_fim: data_fim || null,
      },
    });
    // Mantém a titularidade em sincronia: se ainda não existir um período ativo
    // para esta pessoa/fração/vínculo, regista-o (o histórico não é substituído).
    const vinculoNormalizado = titularidades.normalizarVinculo(vinculo);
    const atuais = await titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id });
    const jaTemPeriodo = atuais.some((t) => Number(t.pessoa_id) === Number(pessoa.id) && t.vinculo === vinculoNormalizado);
    if (!jaTemPeriodo) {
      const contas = await User.findAll({ where: { pessoa_id: pessoa.id }, attributes: ['id'], limit: 2 });
      await titularidades.criarTitularidade({
        condominioId: req.condominioId,
        fracaoId: fracao.id,
        pessoaId: pessoa.id,
        utilizadorId: contas.length === 1 ? contas[0].id : null,
        vinculo: vinculoNormalizado,
        dataInicio: data_inicio || titularidades.hojeISO(),
        userId: req.user.id,
        origem: 'vinculo_pessoa',
      });
    }
    await audit({ userId: req.user.id, acao: 'vincular_pessoa_fração', entidade: 'FracaoPessoa' });
    req.flash('success_msg', 'Pessoa associada à fração.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao associar a pessoa.');
  }
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

router.post('/fracoes/:id/pessoas/:vinculoId/eliminar', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const vinculo = await FracaoPessoa.findOne({ where: { id: req.params.vinculoId, fracao_id: fracao.id } });
  await FracaoPessoa.destroy({ where: { id: req.params.vinculoId, fracao_id: fracao.id } });
  // A titularidade correspondente NÃO é apagada: encerra-se com a data de hoje,
  // para o histórico e a autorização ficarem coerentes com a remoção do vínculo.
  if (vinculo) {
    const ativas = await titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id });
    for (const t of ativas) {
      if (Number(t.pessoa_id) === Number(vinculo.pessoa_id) && t.vinculo === vinculo.vinculo) {
        await titularidades.cessarTitularidade({
          titularidadeId: t.id,
          dataFim: titularidades.hojeISO(),
          motivo: 'vinculo_removido',
          userId: req.user.id,
        });
      }
    }
  }
  await audit({ userId: req.user.id, acao: 'desvincular_pessoa_fração', entidade: 'FracaoPessoa' });
  req.flash('success_msg', 'Associação removida.');
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

// ── Titularidade da fração (histórico e mudança de proprietário) ────
// Registar um titular NUNCA substitui o anterior: ou se cria mais um período, ou
// se encerra explicitamente o titular atual do mesmo vínculo (mudança de
// proprietário), ficando ambos no histórico.
router.post('/fracoes/:id/titulares', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const { pessoa_id, vinculo, data_inicio, encerrar_atual } = req.body;
  try {
    const pessoa = await Pessoa.findOne({ where: { id: pessoa_id, condominio_id: req.condominioId } });
    if (!pessoa) {
      req.flash('error_msg', 'Pessoa não encontrada neste condomínio.');
      return res.redirect(`/admin/fracoes/${fracao.id}/editar`);
    }
    const vinculoNormalizado = titularidades.normalizarVinculo(vinculo);
    const inicio = titularidades.normalizarData(data_inicio) || titularidades.hojeISO();

    // Conta associada a esta pessoa, quando for inequívoca (uma só).
    const contas = await User.findAll({ where: { pessoa_id: pessoa.id }, attributes: ['id'], limit: 2 });
    const utilizadorId = contas.length === 1 ? contas[0].id : null;

    // Mudança de proprietário: encerrar o titular atual do MESMO vínculo no dia
    // anterior ao início do novo período (não há sobreposição nem buraco).
    const encerrados = [];
    if (encerrar_atual === 'on') {
      const atuais = await titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id });
      for (const t of atuais) {
        if (t.vinculo !== vinculoNormalizado) continue;
        const fim = titularidades.diaAnterior(inicio);
        encerrados.push(await titularidades.cessarTitularidade({
          titularidadeId: t.id,
          dataFim: fim,
          motivo: 'mudanca_titular',
          userId: req.user.id,
        }));
      }
    }

    const criada = await titularidades.criarTitularidade({
      condominioId: req.condominioId,
      fracaoId: fracao.id,
      pessoaId: pessoa.id,
      utilizadorId,
      vinculo: vinculoNormalizado,
      dataInicio: inicio,
      userId: req.user.id,
      origem: 'administracao',
      motivo: encerrados.length ? 'mudanca_titular' : null,
    });

    // Manter o vínculo do modelo anterior em sincronia (é o que sustenta os
    // contactos e as comunicações por fração).
    await FracaoPessoa.findOrCreate({
      where: { fracao_id: fracao.id, pessoa_id: pessoa.id, vinculo: vinculoNormalizado },
      defaults: { fracao_id: fracao.id, pessoa_id: pessoa.id, vinculo: vinculoNormalizado, data_inicio: inicio, data_fim: null },
    });

    await audit({
      userId: req.user.id,
      acao: encerrados.length ? 'alterar_titularidade' : 'registar_titularidade',
      entidade: 'Fracao',
      entidadeId: fracao.id,
      detalhes: {
        condominioId: req.condominioId,
        titularidadeId: criada.id,
        pessoaId: pessoa.id,
        utilizadorId,
        vinculo: vinculoNormalizado,
        inicio,
        encerrados: encerrados.map((t) => ({ id: t.id, pessoaId: t.pessoa_id, dataFim: t.data_fim })),
        contaAssociada: utilizadorId ? 'sim' : 'sem conta ligada',
      },
    });

    req.flash(
      'success_msg',
      encerrados.length
        ? `Titularidade alterada: ${encerrados.length} período(s) anterior(es) encerrado(s) e novo titular registado. O histórico mantém-se.`
        : 'Titular registado. O período anterior, se existir, mantém-se no histórico.'
    );
  } catch (err) {
    console.error('[titularidades]', err);
    req.flash('error_msg', 'Não foi possível registar a titularidade.');
  }
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

router.post('/fracoes/:id/titulares/:tid/cessar', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const titulo = await FracaoTitularidade.findOne({
    where: { id: req.params.tid, fracao_id: fracao.id, condominio_id: req.condominioId },
  });
  if (!titulo) {
    req.flash('error_msg', 'Titularidade não encontrada nesta fração.');
    return res.redirect(`/admin/fracoes/${fracao.id}/editar`);
  }
  await titularidades.cessarTitularidade({
    titularidadeId: titulo.id,
    dataFim: req.body.data_fim,
    motivo: (req.body.motivo || '').trim() || 'cessacao',
    userId: req.user.id,
  });
  req.flash('success_msg', 'Titularidade encerrada com data de fim. O registo mantém-se no histórico.');
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

// Detalhe da fração (tabs)
router.get('/fracoes/:id', async (req, res) => {
  const fracao = await Fracao.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Pessoa, as: 'pessoas', through: { attributes: ['id', 'vinculo', 'data_inicio', 'data_fim'] } }],
  });
  if (!fracao) {
    req.flash('error_msg', 'Fração não encontrada.');
    return res.redirect('/admin/fracoes');
  }

  const [quotas, pagamentos, documentos, avisosDest, resumo] = await Promise.all([
    Quota.findAll({ where: { fracao_id: fracao.id }, order: [['ano', 'DESC'], ['mes', 'DESC']] }),
    Pagamento.findAll({
      where: { fracao_id: fracao.id },
      include: [{ model: MetodoPagamento, as: 'metodo_pagamento' }],
      order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
    }),
    Documento.findAll({ where: { entidade_tipo: 'Fracao', entidade_id: fracao.id, condominio_id: req.condominioId }, order: [['data', 'DESC']] }),
    AvisoDestinatario.findAll({
      where: { fracao_id: fracao.id },
      include: [{ model: Aviso, as: 'aviso', where: { condominio_id: req.condominioId }, required: true }],
      order: [['id', 'DESC']],
    }),
    resumoFracao(fracao.id),
  ]);

  const quotasComEstado = quotas.map((q) => ({ ...q.toJSON(), estadoEfetivo: estadoEfetivo(q) }));

  res.render('admin/fracoes/detalhe', {
    titulo: `Fração ${fracao.designacao}`,
    fracao: fracao.toJSON(),
    // Nesta aba mostram-se apenas as relações em vigor: os vínculos já
    // encerrados ficam no histórico de titularidade (ecrã de edição da fração).
    pessoasAtuais: fracao.pessoas.filter((p) => !p.FracaoPessoa.data_fim),
    quotas: quotasComEstado,
    pagamentos: pagamentos.map((p) => p.toJSON()),
    documentos: documentos.map((d) => d.toJSON()),
    avisos: avisosDest.map((a) => a.toJSON()),
    resumo,
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONDÓMINOS (PESSOAS)
// ═══════════════════════════════════════════════════════════════════
router.get('/condominos', async (req, res) => {
  const pessoas = await Pessoa.findAll({
    where: onde(req),
    include: [{ model: Fracao, as: 'fracoes', through: { attributes: ['vinculo'] } }],
    order: [['nome', 'ASC']],
  });
  res.render('admin/condominos/listar', { titulo: 'Condóminos', pessoas });
});

// Linhas de arranque da ficha "Novo condómino" (uma linha vazia de cada tipo).
function contactosIniciaisForm() {
  return {
    emails: [{ id: null, valor: '', etiqueta: '', principal: true }],
    telefones: [{ id: null, valor: '', etiqueta: '', principal: true }],
  };
}

router.get('/condominos/nova', async (req, res) => {
  const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
  res.render('admin/condominos/form', {
    titulo: 'Novo condómino',
    edicao: false,
    pessoa: null,
    contactosForm: contactosIniciaisForm(),
    fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: false })),
  });
});

// Frações do condomínio ativo para validar os ids enviados pelo browser.
async function fracoesDoAtivo(req) {
  return Fracao.findAll({ where: onde(req), attributes: ['id'] });
}

// ── Relação pessoa ↔ fração pela via das titularidades ─────────────
// A ficha do condómino NÃO cria vínculos paralelos: qualquer ligação ou remoção
// passa pelos helpers de titularidade (período com data de início/fim, estado,
// motivo e auditoria) e mantém `fracao_pessoas` em sincronia. Nunca se apaga uma
// relação — encerra-se com data de fim.
async function relacoesAtuaisDaPessoa({ condominioId, pessoaId }) {
  return titularidades.relacoesAtuaisDaPessoa({ condominioId, pessoaId });
}

async function acrescentarRelacao({ req, fracaoId, pessoa, vinculo, origem }) {
  return titularidades.ligarPessoaAFracao({
    condominioId: req.condominioId,
    fracaoId,
    pessoaId: pessoa.id,
    vinculo,
    userId: req.user.id,
    origem,
  });
}

async function retirarRelacao({ req, fracaoId, pessoaId, motivo }) {
  return titularidades.desligarPessoaDaFracao({
    condominioId: req.condominioId,
    fracaoId,
    pessoaId,
    motivo,
    userId: req.user.id,
  });
}

router.post('/condominos', async (req, res) => {
  const { nome, nif, tipo, observacoes } = req.body;
  const vinculo = req.body.vinculo || 'proprietario';
  const { emails, telefones } = parseContactosForm(req.body);
  const erro = validarContactos({ emails, telefones });
  const nifValidado = validarNif(nif);
  const fracoesSelecionadas = toArray(req.body.fracoes).map(Number);

  if (erro || !nifValidado.ok) {
    const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
    const selecionadas = new Set(fracoesSelecionadas);
    res.locals.error_msg = [erro || nifValidado.mensagem];
    return res.render('admin/condominos/form', {
      titulo: 'Novo condómino',
      edicao: false,
      pessoa: { nome: nome || '', nif: nif || '', tipo: tipo || 'proprietario', observacoes: observacoes || '' },
      contactosForm: { emails, telefones },
      fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: selecionadas.has(f.id) })),
    });
  }

  const pessoa = await Pessoa.create({
    condominio_id: req.condominioId,
    nome,
    nif: nifValidado.valor || null,
    tipo: tipo || 'proprietario',
    observacoes,
    email: null,
    telefone: null,
  });
  // Guarda os contactos (email/telefone legados ficam sincronizados com o principal).
  await sincronizarContactosPessoa(pessoa, emails, telefones, req.condominioId);

  // Liga apenas frações do condomínio ativo (ignora ids de outros condomínios),
  // sempre pelo mecanismo de titularidades (com período e auditoria).
  const validas = new Set((await fracoesDoAtivo(req)).map((f) => f.id));
  const recusadas = [];
  for (const fid of fracoesSelecionadas) {
    if (!validas.has(fid)) continue;
    const r = await acrescentarRelacao({ req, fracaoId: fid, pessoa, vinculo, origem: 'ficha_condomino' });
    if (!r.ok) recusadas.push(r.erro);
  }

  await audit({ userId: req.user.id, acao: 'criar_condómino', entidade: 'Pessoa', entidadeId: pessoa.id, detalhes: { fracoes: fracoesSelecionadas.length, recusadas: recusadas.length } });
  if (recusadas.length) {
    req.flash('error_msg', recusadas.join(' '));
    req.flash('success_msg', 'Condómino criado; algumas frações não foram associadas (ver aviso).');
  } else {
    req.flash('success_msg', 'Condómino criado.');
  }
  res.redirect('/admin/condominos');
});

router.get('/condominos/:id/editar', async (req, res) => {
  const pessoa = await Pessoa.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Fracao, as: 'fracoes', through: { attributes: ['id', 'vinculo'] } }],
  });
  if (!pessoa) {
    req.flash('error_msg', 'Condómino não encontrado.');
    return res.redirect('/admin/condominos');
  }
  const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
  // A relação atual é a união das titularidades ativas com os vínculos antigos
  // ainda em vigor: é isso que a ficha mostra marcado (e o que a gravação usa).
  const atuais = await relacoesAtuaisDaPessoa({ condominioId: req.condominioId, pessoaId: pessoa.id });
  const associadasIds = new Set(atuais.map((a) => a.fracaoId));
  // Mostra os contactos existentes; na ausência de registos de um tipo usa o
  // valor legado pessoa.email/telefone (nunca desaparecem da ficha).
  const contactosForm = await contactosParaForm(pessoa);
  res.render('admin/condominos/form', {
    titulo: 'Editar condómino',
    edicao: true,
    pessoa,
    contactosForm,
    fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: associadasIds.has(f.id) })),
  });
});

router.post('/condominos/:id', async (req, res) => {
  const pessoa = await carregarPessoa(req);
  if (!pessoa) return res.redirect('/admin/condominos');
  const { nome, nif, tipo, observacoes } = req.body;
  const ativo = req.body.ativo === 'on' || req.body.ativo === '1' || req.body.ativo === true;
  const vinculo = req.body.vinculo || 'proprietario';
  const { emails, telefones } = parseContactosForm(req.body);
  const erro = validarContactos({ emails, telefones });
  const nifValidado = validarNif(nif);
  const fracoesSelecionadas = toArray(req.body.fracoes).map(Number);

  if (erro || !nifValidado.ok) {
    // Reapresenta a ficha com os valores submetidos (sem perder nada).
    const atuais = await FracaoPessoa.findAll({ where: { pessoa_id: pessoa.id } });
    const atuaisIds = new Set(atuais.map((a) => a.fracao_id));
    const selecionadas = new Set(fracoesSelecionadas);
    const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
    res.locals.error_msg = [erro || nifValidado.mensagem];
    return res.render('admin/condominos/form', {
      titulo: 'Editar condómino',
      edicao: true,
      pessoa: {
        id: pessoa.id,
        nome: nome || '',
        nif: nif || '',
        tipo: tipo || 'proprietario',
        observacoes: observacoes || '',
        ativo,
      },
      contactosForm: { emails, telefones },
      fracoes: fracoes.map((f) => ({
        ...f.toJSON(),
        associada: atuaisIds.has(f.id) || selecionadas.has(f.id),
      })),
    });
  }

  await pessoa.update({
    nome,
    nif: nifValidado.valor || null,
    tipo: tipo || 'proprietario',
    observacoes,
    ativo,
  });
  // Substituição idempotente: a ficha submete sempre a lista completa, por isso
  // os contactos são reconstruídos sem duplicar em gravações repetidas.
  await sincronizarContactosPessoa(pessoa, emails, telefones, req.condominioId);

  // Frações: acrescenta as novas e ENCERRA as desmarcadas — sempre pelo sistema
  // de titularidades (data de início/fim, motivo e auditoria). Sem `destroy`.
  const validas = new Set((await fracoesDoAtivo(req)).map((f) => f.id));
  const selecionadasIds = new Set(fracoesSelecionadas.filter((fid) => validas.has(fid)));
  const atuais = await relacoesAtuaisDaPessoa({ condominioId: req.condominioId, pessoaId: pessoa.id });
  const atuaisIds = new Set(atuais.map((a) => a.fracaoId));

  const recusadas = [];
  let encerradas = 0;
  for (const a of atuais) {
    if (selecionadasIds.has(a.fracaoId)) continue;
    const r = await retirarRelacao({ req, fracaoId: a.fracaoId, pessoaId: pessoa.id, motivo: 'removido_ficha_condomino' });
    encerradas += r.titularesEncerrados + r.vinculosFechados;
  }
  for (const fid of selecionadasIds) {
    if (atuaisIds.has(fid)) continue;
    const r = await acrescentarRelacao({ req, fracaoId: fid, pessoa, vinculo, origem: 'ficha_condomino' });
    if (!r.ok) recusadas.push(r.erro);
  }

  await audit({
    userId: req.user.id,
    acao: 'editar_condómino',
    entidade: 'Pessoa',
    entidadeId: pessoa.id,
    detalhes: { fracoes: selecionadasIds.size, relacoesEncerradas: encerradas, relacoesRecusadas: recusadas.length },
  });
  if (recusadas.length) {
    req.flash('error_msg', recusadas.join(' '));
    req.flash('success_msg', 'Condómino atualizado; algumas frações não foram associadas (ver aviso).');
  } else {
    req.flash('success_msg', encerradas
      ? 'Condómino atualizado. As relações retiradas ficaram encerradas com data de fim, no histórico.'
      : 'Condómino atualizado.');
  }
  res.redirect('/admin/condominos');
});

router.post('/condominos/:id/eliminar', async (req, res) => {
  const pessoa = await carregarPessoa(req);
  if (!pessoa) return res.redirect('/admin/condominos');
  // Não se apaga a ficha de quem tem titularidade ativa: a titularidade ficaria
  // órfã (pessoa_id NULL) e continuaria a autorizar o acesso pela conta ligada.
  // O encerramento tem de ser explícito, na ficha da fração, com data e motivo.
  const ativas = await titularidades.titularesAtivosDaPessoa({
    condominioId: req.condominioId,
    pessoaId: pessoa.id,
  });
  const bloqueio = titularidades.bloqueioEliminacaoCondomino(ativas);
  if (bloqueio) {
    req.flash('error_msg', bloqueio);
    return res.redirect(`/admin/condominos/${pessoa.id}/editar`);
  }
  await pessoa.destroy();
  await audit({ userId: req.user.id, acao: 'eliminar_condómino', entidade: 'Pessoa', entidadeId: req.params.id });
  req.flash('success_msg', 'Condómino eliminado. O histórico financeiro e documental do condomínio mantém-se.');
  res.redirect('/admin/condominos');
});

// ═══════════════════════════════════════════════════════════════════
// UTILIZADORES (CONTAS)
// Contas criadas aqui pertencem ao condomínio ativo (associação
// utilizador_condominios). O papel legado mantém-se para a interface:
// 'admin' ↔ papel de condomínio admin; restantes ↔ 'leitura'.
// ═══════════════════════════════════════════════════════════════════
function papelDaAssociacao(role) {
  return role === 'admin' ? 'admin' : 'leitura';
}
function roleLegadoDoPapel(papel) {
  return papel === 'admin' ? 'admin' : 'condomino';
}

// Gera/renova o convite de um utilizador e tenta o envio por email.
async function enviarConviteAoUtilizador(user, req) {
  const token = convites.gerarToken();
  const expira = convites.calcularExpiracao();
  await user.update({
    convite_token: token,
    convite_token_expira: expira,
    convite_estado: 'enviado',
    email_confirmado: false,
  });
  const link = `${req.protocol}://${req.get('host')}/aceitar-convite/${token}`;
  try {
    await sendMail({
      to: user.email,
      subject: 'Convite de acesso — GesCondu',
      text: `Olá ${user.nome},\n\nFoi criada uma conta para si no GesCondu.\nPara definir a sua palavra-passe e confirmar o email, abra o link (válido por ${convites.diasValidade()} dias):\n\n${link}\n\nSe não esperava este convite, ignore este email.`,
      html: `<p>Olá ${user.nome},</p><p>Foi criada uma conta para si no <strong>GesCondu</strong>.</p><p>Para definir a sua palavra-passe e confirmar o email, clique em:</p><p><a href="${link}">${link}</a></p><p>Este link é válido por ${convites.diasValidade()} dias.</p><p>Se não esperava este convite, ignore este email.</p>`,
      // O convite é criado no condomínio ativo — remetente contextualizado
      // (nunca o "primeiro condomínio" da BD).
      condominioId: req.condominioId,
    });
    return { ok: true };
  } catch (err) {
    console.error('[convite-email]', err.message);
    return { ok: false, erro: err.message };
  }
}

async function assocDeUtilizador(req, userId) {
  return UserCondominio.findOne({ where: { utilizador_id: userId, condominio_id: req.condominioId } });
}

router.get('/utilizadores', async (req, res) => {
  const assocs = await UserCondominio.findAll({
    where: { condominio_id: req.condominioId },
    include: [
      { model: User, as: 'utilizador', include: [{ model: Pessoa, as: 'pessoa' }] },
    ],
    order: [[{ model: User, as: 'utilizador' }, 'nome', 'ASC']],
  });
  const users = assocs
    .map((a) => {
      const u = a.utilizador;
      if (!u) return null;
      const json = u.toJSON();
      json.papel = a.role;
      json.estadoAssoc = a.estado;
      json.role = roleLegadoDoPapel(a.role);
      json.estadoConvite = convites.estadoDoConvite(json);
      json.podeConvite = Boolean(json.convite_token) && ['pendente', 'enviado'].includes(json.convite_estado);
      return json;
    })
    .filter(Boolean);
  res.render('admin/utilizadores/listar', { titulo: 'Utilizadores', users });
});

router.get('/utilizadores/nova', async (req, res) => {
  const pessoas = await Pessoa.findAll({ where: onde(req, { ativo: true }), order: [['nome', 'ASC']] });
  res.render('admin/utilizadores/form', { titulo: 'Novo utilizador', user: null, pessoas });
});

router.post('/utilizadores', async (req, res) => {
  const { nome, email, password, role, pessoa_id, ativo } = req.body;
  const enviarConvite = req.body.enviar_convite === '1' || req.body.enviar_convite === 'on';
  try {
    if (!password && !enviarConvite) {
      req.flash('error_msg', 'Defina uma palavra-passe ou escolha o envio de convite.');
      return res.redirect('/admin/utilizadores/nova');
    }
    const existente = await User.findOne({ where: { email } });
    if (existente) {
      req.flash('error_msg', 'Já existe uma conta com esse email.');
      return res.redirect('/admin/utilizadores/nova');
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const token = enviarConvite ? convites.gerarToken() : null;
    const expira = enviarConvite ? convites.calcularExpiracao() : null;
    const user = await User.create({
      nome,
      email,
      password_hash: passwordHash,
      role: role || 'condomino',
      pessoa_id: pessoa_id || null,
      // Sem marcação explícita a conta nasce ATIVA (a caixa «Ativo» só existe no
      // ecrã de edição): uma conta criada pelo administrador não pode ficar
      // inativa por omissão e impedir a entrada do próprio utilizador.
      ativo: titularidades.contaAtivaDoFormulario(ativo),
      // Por convite: o email só fica confirmado quando o utilizador aceitar.
      email_confirmado: enviarConvite ? false : true,
      convite_token: token,
      convite_token_expira: expira,
      convite_estado: enviarConvite ? 'pendente' : null,
    });
    // Associa ao condomínio ativo (só assim a conta entra na área certa).
    await UserCondominio.create({
      utilizador_id: user.id,
      condominio_id: req.condominioId,
      role: papelDaAssociacao(role),
      estado: 'ativo',
    });
    await audit({ userId: req.user.id, acao: 'criar_utilizador', entidade: 'User', entidadeId: user.id, detalhes: { condominio_id: req.condominioId, papel: papelDaAssociacao(role), porConvite: Boolean(enviarConvite) } });
    if (enviarConvite) {
      const envio = await enviarConviteAoUtilizador(user, req);
      req.flash('success_msg', envio.ok
        ? 'Utilizador criado e convite enviado por email (válido 30 dias).'
        : 'Utilizador criado com convite pendente — o email não foi enviado (configure o SMTP em Emails e use "Reenviar convite").');
    } else {
      req.flash('success_msg', 'Utilizador criado.');
    }
    res.redirect('/admin/utilizadores');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao criar o utilizador.');
    res.redirect('/admin/utilizadores/nova');
  }
});

router.get('/utilizadores/:id/editar', async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) {
    req.flash('error_msg', 'Utilizador não encontrado neste condomínio.');
    return res.redirect('/admin/utilizadores');
  }
  const user = await User.findByPk(req.params.id, { include: [{ model: Pessoa, as: 'pessoa' }] });
  if (!user) return res.redirect('/admin/utilizadores');
  const pessoas = await Pessoa.findAll({ where: onde(req, { ativo: true }), order: [['nome', 'ASC']] });
  const userVista = user.toJSON();
  userVista.papel = assoc.role;
  userVista.role = roleLegadoDoPapel(assoc.role);
  // A associação ao condomínio é o que dá acesso: quando está inativa (por
  // exemplo, depois de «Preparar saída do condomínio»), guardar este formulário
  // não a reativa — a reativação é uma escolha explícita nesta página.
  const assocAtiva = assoc.estado === 'ativo';
  res.render('admin/utilizadores/form', {
    titulo: 'Editar utilizador',
    user: userVista,
    pessoas,
    assocAtiva,
    assocEstado: assoc.estado,
  });
});

router.post('/utilizadores/:id', async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const user = await User.findByPk(req.params.id);
  if (!user) return res.redirect('/admin/utilizadores');
  const { nome, email, password, role, pessoa_id, ativo } = req.body;

  // ── Conta (global: vale em todos os condomínios) ──────────────────
  const contaAntes = user.ativo === true;
  const contaDepois = ativo === 'on' || ativo === '1' || ativo === true;
  const motivo = String(req.body.motivo_conta || '').trim();
  const decisaoConta = titularidades.decidirAcaoConta({ antes: contaAntes, depois: contaDepois });
  // Desativar a conta bloqueia a entrada em toda a plataforma: exige
  // justificação, que fica registada na auditoria.
  if (decisaoConta.exigeMotivo && !motivo) {
    req.flash('error_msg', 'Indique o motivo para desativar a conta — fica registado na auditoria.');
    return res.redirect(`/admin/utilizadores/${user.id}/editar`);
  }
  // E não pode deixar nenhum condomínio sem quem o possa gerir: se esta conta for
  // o último administrador/gestor ativo de algum condomínio, a desativação é
  // recusada (nada é alterado) e a mensagem identifica os condomínios afetados.
  if (decisaoConta.desativou) {
    const assocGestao = await UserCondominio.findAll({
      where: {
        utilizador_id: user.id,
        estado: 'ativo',
        role: { [Op.in]: titularidades.PAPEIS_GESTAO },
      },
      include: [{ model: Condominio, as: 'condominio', attributes: ['id', 'designacao'], required: false }],
    });
    const gestoresPorCondominio = {};
    for (const a of assocGestao) {
      gestoresPorCondominio[a.condominio_id] = await UserCondominio.count({
        where: {
          condominio_id: a.condominio_id,
          estado: 'ativo',
          role: { [Op.in]: titularidades.PAPEIS_GESTAO },
        },
      });
    }
    const afetados = titularidades.condominiosSemGestao({
      associacoes: assocGestao.map((a) => ({
        condominioId: a.condominio_id,
        designacao: a.condominio ? a.condominio.designacao : null,
        role: a.role,
        estado: a.estado,
      })),
      gestoresPorCondominio,
    });
    const bloqueio = titularidades.motivoBloqueioDesativacaoConta(afetados);
    if (bloqueio) {
      req.flash('error_msg', bloqueio);
      return res.redirect(`/admin/utilizadores/${user.id}/editar`);
    }
  }

  const data = { nome, email, role: role || 'condomino', pessoa_id: pessoa_id || null, ativo: contaDepois };
  if (password) {
    data.password_hash = await bcrypt.hash(password, 10);
  }
  await user.update(data);

  // ── Associação ao condomínio ──────────────────────────────────────
  // Guardar a ficha altera apenas o papel. O estado do ACESSO a este condomínio
  // não é alterado aqui: encerrar/reativar acesso são ações próprias e
  // explícitas (abaixo), para que gravar dados nunca reabra nem feche acessos.
  await assoc.update({ role: papelDaAssociacao(role) });

  await audit({
    // A alteração do estado da conta tem ação própria (desativar/reativar conta).
    acao: decisaoConta.acao || 'editar_utilizador',
    entidade: 'User',
    entidadeId: user.id,
    detalhes: decisaoConta.mudou
      ? {
          estadoAnterior: contaAntes,
          estadoNovo: contaDepois,
          motivo: motivo || null,
          ambito: 'conta (global — todos os condomínios)',
          condominioContexto: req.condominioId,
          papel: papelDaAssociacao(role),
          associacao: assoc.estado,
          titularidadesAlteradas: false,
        }
      : { papel: papelDaAssociacao(role), associacao: assoc.estado },
  });

  if (decisaoConta.reativou) {
    req.flash('success_msg', 'Conta reativada: volta a poder iniciar sessão onde as associações e as titularidades o permitirem. Nenhuma associação foi reaberta por esta ação.');
  } else if (decisaoConta.desativou) {
    req.flash('success_msg', 'Conta desativada: o acesso à plataforma fica bloqueado em todos os condomínios. As associações ao condomínio e as titularidades não foram alteradas.');
  } else {
    req.flash('success_msg', 'Utilizador atualizado.');
  }
  res.redirect('/admin/utilizadores');
});

// ── Acesso a ESTE condomínio (associação) ──────────────────────────
// Ações administrativas explícitas sobre `utilizador_condominios.estado`.
// Alteram apenas esse estado: a conta (`users.ativo`) e as titularidades ficam
// intactas e nada é apagado. Não substituem «Preparar saída do condomínio»
// (fluxo do próprio utilizador, com exportação, reautenticação, declaração e
// encerramento das titularidades) — esse mantém-se como está.

// O condomínio não pode ficar sem quem o possa gerir (mesma regra do fluxo de
// saída, agora num só sítio: helpers/titularidades.js).
async function deixariaCondominioSemGestao(req, assoc) {
  if (!titularidades.PAPEIS_GESTAO.includes(assoc.role)) return false;
  const n = await UserCondominio.count({
    where: {
      condominio_id: req.condominioId,
      estado: 'ativo',
      role: { [Op.in]: titularidades.PAPEIS_GESTAO },
    },
  });
  return titularidades.eUltimoGestorAtivo({ papel: assoc.role, nGestores: n });
}

router.post('/utilizadores/:id/encerrar-acesso', async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const destino = `/admin/utilizadores/${req.params.id}/editar`;
  const motivo = String(req.body.motivo || '').trim();
  if (!motivo) {
    req.flash('error_msg', 'Indique o motivo do encerramento do acesso — fica registado na auditoria.');
    return res.redirect(destino);
  }
  if (Number(req.params.id) === Number(req.user.id)) {
    req.flash('error_msg', 'Para deixar de ter acesso a este condomínio utilize «Preparar saída do condomínio» na sua área.');
    return res.redirect(destino);
  }
  if (assoc.estado !== 'ativo') {
    req.flash('error_msg', 'O acesso deste utilizador a este condomínio já está encerrado.');
    return res.redirect(destino);
  }
  if (await deixariaCondominioSemGestao(req, assoc)) {
    req.flash('error_msg', 'É o único administrador ou gestor com acesso ativo a este condomínio. Encerrar este acesso deixaria o condomínio sem quem o possa gerir.');
    return res.redirect(destino);
  }
  await assoc.update({ estado: 'inativo' });
  await audit({
    userId: req.user.id,
    acao: 'encerrar_acesso_condominio',
    entidade: 'UserCondominio',
    entidadeId: assoc.id,
    detalhes: {
      condominioId: req.condominioId,
      utilizadorId: assoc.utilizador_id,
      papel: assoc.role,
      motivo,
      estadoAnterior: 'ativo',
      estadoNovo: 'inativo',
      contaAlterada: false,
      titularidadesAlteradas: false,
    },
  });
  req.flash('success_msg', 'Acesso a este condomínio encerrado. A conta e as titularidades não foram alteradas; a associação mantém-se registada (pode ser reaberta).');
  res.redirect('/admin/utilizadores');
});

router.post('/utilizadores/:id/reativar-acesso', async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const destino = `/admin/utilizadores/${req.params.id}/editar`;
  const motivo = String(req.body.motivo || '').trim();
  if (assoc.estado === 'ativo') {
    req.flash('error_msg', 'O acesso deste utilizador a este condomínio já está ativo.');
    return res.redirect(destino);
  }
  await assoc.update({ estado: 'ativo' });
  await audit({
    userId: req.user.id,
    acao: 'reativar_acesso_condominio',
    entidade: 'UserCondominio',
    entidadeId: assoc.id,
    detalhes: {
      condominioId: req.condominioId,
      utilizadorId: assoc.utilizador_id,
      papel: assoc.role,
      motivo: motivo || null,
      estadoAnterior: 'inativo',
      estadoNovo: 'ativo',
      contaAlterada: false,
      titularidadesAlteradas: false,
    },
  });
  req.flash('success_msg', 'Acesso a este condomínio reativado. A conta não foi alterada e as titularidades continuam como estavam.');
  res.redirect('/admin/utilizadores');
});

router.post('/utilizadores/:id/eliminar', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const assoc = await assocDeUtilizador(req, userId);
  if (!assoc || userId === req.user.id) {
    req.flash('error_msg', 'Não pode eliminar a sua própria conta.');
    return res.redirect('/admin/utilizadores');
  }
  await assoc.destroy();
  // Elimina a conta apenas se já não pertence a nenhum outro condomínio.
  const restantes = await UserCondominio.count({ where: { utilizador_id: userId } });
  if (restantes === 0) {
    const user = await User.findByPk(userId);
    if (user) await user.destroy();
  }
  await audit({ userId: req.user.id, acao: 'eliminar_utilizador', entidade: 'User', entidadeId: userId, detalhes: { condominio_id: req.condominioId } });
  req.flash('success_msg', 'Utilizador removido deste condomínio.');
  res.redirect('/admin/utilizadores');
});

// ── Convites (estados/validade; confirmação de email) ──────────────
router.post('/utilizadores/:id/reenviar-convite', async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const user = await User.findByPk(req.params.id);
  if (!user) return res.redirect('/admin/utilizadores');
  if (user.convite_estado === 'aceite') {
    req.flash('error_msg', 'Este utilizador já aceitou o convite.');
    return res.redirect('/admin/utilizadores');
  }
  if (user.convite_estado === 'revogado') {
    req.flash('error_msg', 'Convite revogado. Crie/edite o utilizador para gerar um novo convite.');
    return res.redirect('/admin/utilizadores');
  }
  const envio = await enviarConviteAoUtilizador(user, req);
  await audit({ userId: req.user.id, acao: 'reenviar_convite', entidade: 'User', entidadeId: user.id, detalhes: { email: user.email } }).catch(() => {});
  req.flash('success_msg', envio.ok
    ? 'Convite reenviado por email (válido 30 dias).'
    : 'Convite renovado mas o email não foi enviado (verifique o SMTP).');
  res.redirect('/admin/utilizadores');
});

router.post('/utilizadores/:id/revogar-convite', async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const user = await User.findByPk(req.params.id);
  if (!user) return res.redirect('/admin/utilizadores');
  if (user.convite_estado === 'aceite') {
    req.flash('error_msg', 'Não pode revogar o convite de uma conta já ativada.');
    return res.redirect('/admin/utilizadores');
  }
  await user.update({ convite_token: null, convite_token_expira: null, convite_estado: 'revogado' });
  await audit({ userId: req.user.id, acao: 'revogar_convite', entidade: 'User', entidadeId: user.id, detalhes: { email: user.email } }).catch(() => {});
  req.flash('success_msg', 'Convite revogado.');
  res.redirect('/admin/utilizadores');
});

// Tarefas de processamento em segundo plano (estado/consulta)
router.get('/tarefas', async (req, res) => {
  const tarefas = background.listarTarefas(100);
  res.render('admin/sistema/tarefas', { titulo: 'Processamento em segundo plano', tarefas });
});

// ── Contactos flexíveis do condómino ────────────────────────────────
// Geridos na própria ficha (/editar) — criar/editar chamam
// sincronizarContactosPessoa com a lista completa. A página antiga mantém-se
// apenas por compatibilidade e redireciona para a edição.
router.get('/condominos/:id/contactos', (req, res) => {
  res.redirect(`/admin/condominos/${req.params.id}/editar#contactos`);
});

module.exports = router;
