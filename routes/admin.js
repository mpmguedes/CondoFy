const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const {
  Fracao,
  Pessoa,
  FracaoPessoa,
  User,
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
const { toCents, fromCents } = require('../helpers/money');
const { audit } = require('../helpers/audit');
const { getCondominio } = require('../helpers/condominio');
const { resumoCondominio, resumoFracao, estadoEfetivo } = require('../helpers/saldos');
const { resumoFinanceiroMes, resumoEmAtraso, orcamentoDoAno } = require('../helpers/dashboard');
const drive = require('../helpers/drive');
const { smtpConfigured } = require('../helpers/mailer');
const background = require('../helpers/background-jobs');
const { sincronizarContactosPessoa, parseContactosForm, validarContactos, contactosParaForm } = require('../helpers/contactos');

const router = express.Router();

router.use(eAdmin);

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
      Fracao.count(),
      Pessoa.count(),
      User.count(),
      getCondominio(),
      resumoCondominio(),
      Quota.findAll({ where: { estado: { [Op.ne]: 'anulada' } } }),
      BackupLog.findOne({ order: [['id', 'DESC']] }),
      EmailFila.count({ where: { estado: 'pendente' } }),
      EmailFila.count({ where: { estado: 'erro' } }),
    ]);

  const [nDriveDocs, nEmailsEnviados, nFornecedores, nPagFornecedorPendentes] = await Promise.all([
    Documento.count({ where: { drive_status: 'guardado' } }),
    EmailFila.count({ where: { estado: 'enviado' } }),
    Fornecedor.count({ where: { ativo: true } }),
    PagamentoFornecedor.count({ where: { estado: 'pendente' } }),
  ]);

  const nPagas = quotas.filter((q) => q.estado === 'paga').length;
  const nPendentes = quotas.filter((q) => ['pendente', 'parcialmente_paga'].includes(q.estado)).length;
  const nVencidas = quotas.filter((q) => estadoEfetivo(q) === 'vencida').length;

  // Gráficos do dashboard (ano corrente)
  const anoAtual = new Date().getFullYear();
  const mesAtual = new Date().getMonth() + 1;
  const [pagamentos, despesas, financeiroMes, emAtraso, orcamentoAno] = await Promise.all([
    Pagamento.findAll({ attributes: ['valor', 'data_pagamento'], where: { estado: 'confirmado' }, raw: true }),
    Despesa.findAll({
      attributes: ['valor', 'data'],
      where: { estado: { [Op.ne]: 'anulada' } },
      include: [{ model: Categoria, as: 'categoria', attributes: ['nome'] }],
      raw: true,
    }),
    resumoFinanceiroMes(anoAtual, mesAtual),
    resumoEmAtraso(),
    orcamentoDoAno(anoAtual),
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
  const fracoesTodas = await Fracao.findAll({ attributes: ['id', 'designacao'] });
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
  const fracao = await Fracao.findByPk(req.params.id, {
    include: [{ model: Pessoa, as: 'pessoas', through: { attributes: ['id', 'vinculo', 'data_inicio', 'data_fim'] } }],
  });
  if (!fracao) {
    req.flash('error_msg', 'Fração não encontrada.');
    return res.redirect('/admin/fracoes');
  }
  const pessoas = await Pessoa.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] });
  res.render('admin/fracoes/form', { titulo: 'Editar fração', fracao, pessoas });
});

router.post('/fracoes/:id', async (req, res) => {
  const fracao = await Fracao.findByPk(req.params.id);
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
    const fracao = await Fracao.findByPk(req.params.id);
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

// Vínculos fração ↔ pessoa
router.post('/fracoes/:id/pessoas', async (req, res) => {
  const fracao = await Fracao.findByPk(req.params.id);
  if (!fracao) return res.redirect('/admin/fracoes');
  const { pessoa_id, vinculo, data_inicio, data_fim } = req.body;
  try {
    await FracaoPessoa.findOrCreate({
      where: { fracao_id: fracao.id, pessoa_id, vinculo: vinculo || 'proprietario' },
      defaults: {
        fracao_id: fracao.id,
        pessoa_id,
        vinculo: vinculo || 'proprietario',
        data_inicio: data_inicio || null,
        data_fim: data_fim || null,
      },
    });
    await audit({ userId: req.user.id, acao: 'vincular_pessoa_fração', entidade: 'FracaoPessoa' });
    req.flash('success_msg', 'Pessoa associada à fração.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao associar a pessoa.');
  }
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

router.post('/fracoes/:id/pessoas/:vinculoId/eliminar', async (req, res) => {
  await FracaoPessoa.destroy({ where: { id: req.params.vinculoId, fracao_id: req.params.id } });
  await audit({ userId: req.user.id, acao: 'desvincular_pessoa_fração', entidade: 'FracaoPessoa' });
  req.flash('success_msg', 'Associação removida.');
  res.redirect(`/admin/fracoes/${req.params.id}/editar`);
});

// Detalhe da fração (tabs)
router.get('/fracoes/:id', async (req, res) => {
  const fracao = await Fracao.findByPk(req.params.id, {
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
    Documento.findAll({ where: { entidade_tipo: 'Fracao', entidade_id: fracao.id }, order: [['data', 'DESC']] }),
    AvisoDestinatario.findAll({
      where: { fracao_id: fracao.id },
      include: [{ model: Aviso, as: 'aviso' }],
      order: [['id', 'DESC']],
    }),
    resumoFracao(fracao.id),
  ]);

  const quotasComEstado = quotas.map((q) => ({ ...q.toJSON(), estadoEfetivo: estadoEfetivo(q) }));

  res.render('admin/fracoes/detalhe', {
    titulo: `Fração ${fracao.designacao}`,
    fracao: fracao.toJSON(),
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
  const fracoes = await Fracao.findAll({ order: [['designacao', 'ASC']] });
  res.render('admin/condominos/form', {
    titulo: 'Novo condómino',
    edicao: false,
    pessoa: null,
    contactosForm: contactosIniciaisForm(),
    fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: false })),
  });
});

router.post('/condominos', async (req, res) => {
  const { nome, nif, tipo, observacoes } = req.body;
  const vinculo = req.body.vinculo || 'proprietario';
  const { emails, telefones } = parseContactosForm(req.body);
  const erro = validarContactos({ emails, telefones });
  const fracoesSelecionadas = toArray(req.body.fracoes).map(Number);

  if (erro) {
    const fracoes = await Fracao.findAll({ order: [['designacao', 'ASC']] });
    const selecionadas = new Set(fracoesSelecionadas);
    res.locals.error_msg = [erro];
    return res.render('admin/condominos/form', {
      titulo: 'Novo condómino',
      edicao: false,
      pessoa: { nome: nome || '', nif: nif || '', tipo: tipo || 'proprietario', observacoes: observacoes || '' },
      contactosForm: { emails, telefones },
      fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: selecionadas.has(f.id) })),
    });
  }

  const pessoa = await Pessoa.create({
    nome,
    nif,
    tipo: tipo || 'proprietario',
    observacoes,
    email: null,
    telefone: null,
  });
  // Guarda os contactos (email/telefone legados ficam sincronizados com o principal).
  await sincronizarContactosPessoa(pessoa, emails, telefones);

  for (const fid of fracoesSelecionadas) {
    await FracaoPessoa.create({ fracao_id: fid, pessoa_id: pessoa.id, vinculo });
  }

  await audit({ userId: req.user.id, acao: 'criar_condómino', entidade: 'Pessoa', entidadeId: pessoa.id, detalhes: { fracoes: fracoesSelecionadas.length } });
  req.flash('success_msg', 'Condómino criado.');
  res.redirect('/admin/condominos');
});

router.get('/condominos/:id/editar', async (req, res) => {
  const pessoa = await Pessoa.findByPk(req.params.id, {
    include: [{ model: Fracao, as: 'fracoes', through: { attributes: ['id', 'vinculo'] } }],
  });
  if (!pessoa) {
    req.flash('error_msg', 'Condómino não encontrado.');
    return res.redirect('/admin/condominos');
  }
  const fracoes = await Fracao.findAll({ order: [['designacao', 'ASC']] });
  const associadasIds = new Set(pessoa.fracoes.map((f) => f.id));
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
  const pessoa = await Pessoa.findByPk(req.params.id);
  if (!pessoa) return res.redirect('/admin/condominos');
  const { nome, nif, tipo, observacoes } = req.body;
  const ativo = req.body.ativo === 'on' || req.body.ativo === '1' || req.body.ativo === true;
  const vinculo = req.body.vinculo || 'proprietario';
  const { emails, telefones } = parseContactosForm(req.body);
  const erro = validarContactos({ emails, telefones });
  const fracoesSelecionadas = toArray(req.body.fracoes).map(Number);

  if (erro) {
    // Reapresenta a ficha com os valores submetidos (sem perder nada).
    const atuais = await FracaoPessoa.findAll({ where: { pessoa_id: pessoa.id } });
    const atuaisIds = new Set(atuais.map((a) => a.fracao_id));
    const selecionadas = new Set(fracoesSelecionadas);
    const fracoes = await Fracao.findAll({ order: [['designacao', 'ASC']] });
    res.locals.error_msg = [erro];
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
    nif,
    tipo: tipo || 'proprietario',
    observacoes,
    ativo,
  });
  // Substituição idempotente: a ficha submete sempre a lista completa, por isso
  // os contactos são reconstruídos sem duplicar em gravações repetidas.
  await sincronizarContactosPessoa(pessoa, emails, telefones);

  // Sincronizar frações: remove as desmarcadas, adiciona as novas com o vínculo escolhido.
  const selecionadasIds = new Set(fracoesSelecionadas);
  const atuais = await FracaoPessoa.findAll({ where: { pessoa_id: pessoa.id } });
  const atuaisIds = new Set(atuais.map((a) => a.fracao_id));

  for (const a of atuais) {
    if (!selecionadasIds.has(a.fracao_id)) await a.destroy();
  }
  for (const fid of fracoesSelecionadas) {
    if (!atuaisIds.has(fid)) await FracaoPessoa.create({ fracao_id: fid, pessoa_id: pessoa.id, vinculo });
  }

  await audit({ userId: req.user.id, acao: 'editar_condómino', entidade: 'Pessoa', entidadeId: pessoa.id });
  req.flash('success_msg', 'Condómino atualizado.');
  res.redirect('/admin/condominos');
});

router.post('/condominos/:id/eliminar', async (req, res) => {
  const pessoa = await Pessoa.findByPk(req.params.id);
  if (pessoa) {
    await pessoa.destroy();
    await audit({ userId: req.user.id, acao: 'eliminar_condómino', entidade: 'Pessoa', entidadeId: req.params.id });
  }
  req.flash('success_msg', 'Condómino eliminado.');
  res.redirect('/admin/condominos');
});

// ═══════════════════════════════════════════════════════════════════
// UTILIZADORES (CONTAS)
// ═══════════════════════════════════════════════════════════════════
router.get('/utilizadores', async (req, res) => {
  const users = await User.findAll({ include: [{ model: Pessoa, as: 'pessoa' }], order: [['nome', 'ASC']] });
  res.render('admin/utilizadores/listar', { titulo: 'Utilizadores', users });
});

router.get('/utilizadores/nova', async (req, res) => {
  const pessoas = await Pessoa.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] });
  res.render('admin/utilizadores/form', { titulo: 'Novo utilizador', user: null, pessoas });
});

router.post('/utilizadores', async (req, res) => {
  const { nome, email, password, role, pessoa_id, ativo } = req.body;
  try {
    const existente = await User.findOne({ where: { email } });
    if (existente) {
      req.flash('error_msg', 'Já existe uma conta com esse email.');
      return res.redirect('/admin/utilizadores/nova');
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const user = await User.create({
      nome,
      email,
      password_hash: passwordHash,
      role: role || 'condomino',
      pessoa_id: pessoa_id || null,
      ativo: ativo === 'on' || ativo === '1' || ativo === true,
    });
    await audit({ userId: req.user.id, acao: 'criar_utilizador', entidade: 'User', entidadeId: user.id });
    req.flash('success_msg', 'Utilizador criado.');
    res.redirect('/admin/utilizadores');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao criar o utilizador.');
    res.redirect('/admin/utilizadores/nova');
  }
});

router.get('/utilizadores/:id/editar', async (req, res) => {
  const user = await User.findByPk(req.params.id, { include: [{ model: Pessoa, as: 'pessoa' }] });
  if (!user) {
    req.flash('error_msg', 'Utilizador não encontrado.');
    return res.redirect('/admin/utilizadores');
  }
  const pessoas = await Pessoa.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] });
  res.render('admin/utilizadores/form', { titulo: 'Editar utilizador', user, pessoas });
});

router.post('/utilizadores/:id', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) return res.redirect('/admin/utilizadores');
  const { nome, email, password, role, pessoa_id, ativo } = req.body;
  const data = {
    nome,
    email,
    role: role || 'condomino',
    pessoa_id: pessoa_id || null,
    ativo: ativo === 'on' || ativo === '1' || ativo === true,
  };
  if (password) {
    data.password_hash = await bcrypt.hash(password, 10);
  }
  await user.update(data);
  await audit({ userId: req.user.id, acao: 'editar_utilizador', entidade: 'User', entidadeId: user.id });
  req.flash('success_msg', 'Utilizador atualizado.');
  res.redirect('/admin/utilizadores');
});

router.post('/utilizadores/:id/eliminar', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (user && user.id !== req.user.id) {
    await user.destroy();
    await audit({ userId: req.user.id, acao: 'eliminar_utilizador', entidade: 'User', entidadeId: req.params.id });
    req.flash('success_msg', 'Utilizador eliminado.');
  } else {
    req.flash('error_msg', 'Não pode eliminar a sua própria conta.');
  }
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
