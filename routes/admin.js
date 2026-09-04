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
  BackupLog,
  EmailFila,
} = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const { getCondominio } = require('../helpers/condominio');
const { resumoCondominio, estadoEfetivo } = require('../helpers/saldos');
const drive = require('../helpers/drive');
const { smtpConfigured } = require('../helpers/mailer');

const router = express.Router();

router.use(eAdmin);

function parseDecimal(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
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

  const nPagas = quotas.filter((q) => q.estado === 'paga').length;
  const nPendentes = quotas.filter((q) => ['pendente', 'parcialmente_paga'].includes(q.estado)).length;
  const nVencidas = quotas.filter((q) => estadoEfetivo(q) === 'vencida').length;

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
    sistema: {
      driveLigado: drive.isConfigured(),
      smtp: smtpConfigured(),
      ultimoBackup,
      filaPendentes,
      filaErros,
    },
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
    const { designacao, permilagem, andar, observacoes, estado } = req.body;
    const fracao = await Fracao.create({
      designacao,
      permilagem: parseDecimal(permilagem),
      andar,
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
  const { designacao, permilagem, andar, observacoes, estado } = req.body;
  await fracao.update({
    designacao,
    permilagem: parseDecimal(permilagem),
    andar,
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

router.get('/condominos/nova', (req, res) => {
  res.render('admin/condominos/form', { titulo: 'Novo condómino', pessoa: null });
});

router.post('/condominos', async (req, res) => {
  const { nome, email, telefone, nif, tipo, observacoes } = req.body;
  const pessoa = await Pessoa.create({ nome, email, telefone, nif, tipo: tipo || 'proprietario', observacoes });
  await audit({ userId: req.user.id, acao: 'criar_condómino', entidade: 'Pessoa', entidadeId: pessoa.id });
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
  res.render('admin/condominos/form', { titulo: 'Editar condómino', pessoa });
});

router.post('/condominos/:id', async (req, res) => {
  const pessoa = await Pessoa.findByPk(req.params.id);
  if (!pessoa) return res.redirect('/admin/condominos');
  const { nome, email, telefone, nif, tipo, observacoes, ativo } = req.body;
  await pessoa.update({
    nome,
    email,
    telefone,
    nif,
    tipo: tipo || 'proprietario',
    observacoes,
    ativo: ativo === 'on' || ativo === '1' || ativo === true,
  });
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

module.exports = router;
