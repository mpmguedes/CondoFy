// ─────────────────────────────────────────────────────────────────────
// Administração GLOBAL (Super Admin) — condomínios, utilizadores,
// associações, auditoria e suporte. Apenas utilizadores role_global =
// 'super_admin' têm acesso a estas rotas.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const {
  Condominio,
  User,
  UserCondominio,
  Fracao,
  AuditLog,
} = require('../models');
const { eAutenticado } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const tenant = require('../helpers/tenant');
const { validarNif } = require('../public/js/validacao-fiscal');

const router = express.Router();
router.use(eAutenticado);

// Guarda: apenas Super Admin global.
router.use((req, res, next) => {
  if (tenant.eSuperAdmin(req.user)) return next();
  req.flash('error_msg', 'Acesso restrito à administração global.');
  return res.redirect('/');
});

const TABELAS_ELIMINAR = ['fracoes', 'pessoas', 'contactos_pessoa', 'quotas', 'pagamentos', 'recibos', 'documentos', 'assembleias', 'despesas', 'contas_bancarias', 'orcamentos', 'extra_quotas', 'avisos'];

// ── Painel global ───────────────────────────────────────────────────
router.get('/global', async (req, res) => {
  const [condominios, ativos, utilizadores, superAdmins, auditoria] = await Promise.all([
    Condominio.count(),
    Condominio.count({ where: { estado: 'ativo' } }),
    User.count(),
    User.count({ where: { role_global: 'super_admin' } }),
    AuditLog.count(),
  ]);
  res.render('admin/global/index', {
    titulo: 'Administração global',
    resumo: { condominios, ativos, inativos: condominios - ativos, utilizadores, superAdmins, auditoria },
  });
});

// ── Condomínios (lista + criar) ─────────────────────────────────────
router.get('/global/condominios', async (req, res) => {
  const [condominios, porMembro, porFracao] = await Promise.all([
    Condominio.findAll({ order: [['designacao', 'ASC']] }),
    UserCondominio.findAll({
      attributes: ['condominio_id', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'total']],
      group: ['condominio_id'],
      raw: true,
    }),
    Fracao.findAll({
      attributes: ['condominio_id', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'total']],
      group: ['condominio_id'],
      raw: true,
    }),
  ]);
  const membros = new Map(porMembro.map((r) => [r.condominio_id, Number(r.total)]));
  const fracoes = new Map(porFracao.map((r) => [r.condominio_id, Number(r.total)]));
  const lista = condominios.map((c) => ({ ...c.toJSON(), membros: membros.get(c.id) || 0, fracoes: fracoes.get(c.id) || 0 }));
  res.render('admin/global/condominios', { titulo: 'Condomínios · Global', lista });
});

router.post('/global/condominios', async (req, res) => {
  const designacao = String(req.body.designacao || '').trim();
  if (!designacao) {
    req.flash('error_msg', 'Indique o nome do condomínio.');
    return res.redirect('/admin/global/condominios');
  }
  try {
    const nifValidado = validarNif(req.body.nif);
    if (!nifValidado.ok) {
      req.flash('error_msg', nifValidado.mensagem);
      return res.redirect('/admin/global/condominios');
    }
    const condominio = await Condominio.create({
      designacao,
      morada: String(req.body.morada || '').trim() || null,
      codigo_postal: String(req.body.codigo_postal || '').trim() || null,
      localidade: String(req.body.localidade || '').trim() || null,
      nif: nifValidado.valor || null,
      estado: 'ativo',
    });
    await audit({ userId: req.user.id, acao: 'condominio_criado', entidade: 'Condominio', entidadeId: condominio.id });
    req.flash('success_msg', `Condomínio "${condominio.designacao}" criado.`);
    return res.redirect('/admin/global/condominios');
  } catch (err) {
    console.error('[global-condominio]', err);
    req.flash('error_msg', 'Erro ao criar o condomínio.');
    return res.redirect('/admin/global/condominios');
  }
});

// Estado: desativar / reativar (ciclo Ativo → Desativado).
router.post('/global/condominios/:id/estado', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect('/admin/global/condominios');
  }
  const proximo = condominio.estado === 'ativo' ? 'inativo' : 'ativo';
  await condominio.update({ estado: proximo });
  await audit({
    userId: req.user.id,
    acao: proximo === 'inativo' ? 'condominio_desativado' : 'condominio_reativado',
    entidade: 'Condominio',
    entidadeId: condominio.id,
  });
  req.flash('success_msg', proximo === 'inativo' ? 'Condomínio desativado.' : 'Condomínio reativado.');
  return res.redirect('/admin/global/condominios');
});

// Eliminação permanente — requer condomínio DESATIVADO + confirmação forte.
router.post('/global/condominios/:id/eliminar', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect('/admin/global/condominios');
  }
  if (String(req.body.confirmo || '').trim() !== 'ELIMINAR') {
    req.flash('error_msg', 'Confirmação inválida. Escreva ELIMINAR para confirmar a eliminação permanente.');
    return res.redirect(`/admin/global/condominios/${condominio.id}`);
  }
  if (condominio.estado !== 'inativo') {
    req.flash('error_msg', 'Para eliminar definitivamente, o condomínio tem de estar desativado primeiro.');
    return res.redirect(`/admin/global/condominios/${condominio.id}`);
  }
  const sequelize = require('../config/database');
  const t = await sequelize.transaction();
  try {
    await UserCondominio.destroy({ where: { condominio_id: condominio.id }, transaction: t });
    // Remoção das entidades do condomínio (dados financeiros incluídos).
    const MOD = {
      fracoes: require('../models').Fracao,
      pessoas: require('../models').Pessoa,
      contactos_pessoa: require('../models').ContactoPessoa,
      quotas: require('../models').Quota,
      pagamentos: require('../models').Pagamento,
      recibos: require('../models').Recibo,
      documentos: require('../models').Documento,
      assembleias: require('../models').Assembleia,
      despesas: require('../models').Despesa,
      contas_bancarias: require('../models').ContaBancaria,
      orcamentos: require('../models').Orcamento,
      extra_quotas: require('../models').ExtraQuota,
      avisos: require('../models').Aviso,
    };
    for (const tabela of TABELAS_ELIMINAR) {
      await MOD[tabela].destroy({ where: { condominio_id: condominio.id }, transaction: t });
    }
    await condominio.destroy({ transaction: t });
    await t.commit();
  } catch (err) {
    await t.rollback();
    console.error('[global-eliminar]', err);
    req.flash('error_msg', 'Erro ao eliminar o condomínio.');
    return res.redirect(`/admin/global/condominios/${condominio.id}`);
  }
  await audit({ userId: req.user.id, acao: 'condominio_eliminado', entidade: 'Condominio', entidadeId: req.params.id });
  req.flash('success_msg', 'Condomínio eliminado permanentemente.');
  return res.redirect('/admin/global/condominios');
});

// Suporte: entrar num condomínio (define o ativo da sessão e segue).
router.post('/global/condominios/:id/entrar', async (req, res) => {
  const ok = await tenant.entrarCondominio(req, parseInt(req.params.id, 10));
  if (!ok) {
    req.flash('error_msg', 'Não foi possível entrar no condomínio.');
    return res.redirect('/admin/global/condominios');
  }
  await audit({ userId: req.user.id, acao: 'super_admin_entrar_condominio', entidade: 'Condominio', entidadeId: req.params.id }).catch(() => {});
  return res.redirect('/');
});

// ── Detalhe do condomínio (membros/associações) ────────────────────
router.get('/global/condominios/:id', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect('/admin/global/condominios');
  }
  const associacoes = await UserCondominio.findAll({
    where: { condominio_id: condominio.id },
    include: [{ model: User, as: 'utilizador' }],
    order: [['id', 'ASC']],
  });
  const nFracoes = await Fracao.count({ where: { condominio_id: condominio.id } });
  res.render('admin/global/condominio', {
    titulo: condominio.designacao,
    condominio,
    nFracoes,
    associacoes,
  });
});

router.post('/global/condominios/:id/associacoes', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect('/admin/global/condominios');
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const papel = ['admin', 'gestor', 'leitura'].includes(req.body.role) ? req.body.role : 'leitura';
  if (!email) {
    req.flash('error_msg', 'Indique o email do utilizador.');
    return res.redirect(`/admin/global/condominios/${condominio.id}`);
  }
  const utilizador = await User.findOne({ where: { email } });
  if (!utilizador) {
    req.flash('error_msg', 'Não existe nenhum utilizador com esse email.');
    return res.redirect(`/admin/global/condominios/${condominio.id}`);
  }
  const [associacao] = await UserCondominio.findOrCreate({
    where: { utilizador_id: utilizador.id, condominio_id: condominio.id },
    defaults: { utilizador_id: utilizador.id, condominio_id: condominio.id, role: papel, estado: 'ativo' },
  });
  if (associacao) {
    await associacao.update({ role: papel, estado: 'ativo' });
  }
  await audit({ userId: req.user.id, acao: 'associar_utilizador_condominio', entidade: 'Condominio', entidadeId: condominio.id, detalhes: { email, papel } });
  req.flash('success_msg', `Associação atualizada (${email} → ${papel}).`);
  return res.redirect(`/admin/global/condominios/${condominio.id}`);
});

router.post('/global/associacoes/:id/estado', async (req, res) => {
  const assoc = await UserCondominio.findByPk(req.params.id);
  if (!assoc) {
    req.flash('error_msg', 'Associação não encontrada.');
    return res.redirect('/admin/global/condominios');
  }
  const papel = ['admin', 'gestor', 'leitura'].includes(req.body.role) ? req.body.role : assoc.role;
  const estado = req.body.estado === 'ativo' ? 'ativo' : req.body.estado === 'inativo' ? 'inativo' : assoc.estado;
  await assoc.update({ role: papel, estado });
  await audit({ userId: req.user.id, acao: 'alterar_associacao_condominio', entidade: 'Condominio', entidadeId: assoc.condominio_id, detalhes: { papel, estado } });
  req.flash('success_msg', 'Associação atualizada.');
  return res.redirect(`/admin/global/condominios/${assoc.condominio_id}`);
});

router.post('/global/associacoes/:id/eliminar', async (req, res) => {
  const assoc = await UserCondominio.findByPk(req.params.id);
  if (!assoc) {
    req.flash('error_msg', 'Associação não encontrada.');
    return res.redirect('/admin/global/condominios');
  }
  const condominioId = assoc.condominio_id;
  await assoc.destroy();
  await audit({ userId: req.user.id, acao: 'remover_associacao_condominio', entidade: 'Condominio', entidadeId: condominioId });
  req.flash('success_msg', 'Associação removida.');
  return res.redirect(`/admin/global/condominios/${condominioId}`);
});

// ── Utilizadores (global) ───────────────────────────────────────────
router.get('/global/utilizadores', async (req, res) => {
  const utilizadores = await User.findAll({
    attributes: ['id', 'nome', 'email', 'telefone', 'role', 'role_global', 'email_confirmado', 'ativo', 'convite_estado', 'created_at'],
    order: [['nome', 'ASC']],
  });
  const contagens = await UserCondominio.findAll({
    attributes: ['utilizador_id', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'total']],
    group: ['utilizador_id'],
    raw: true,
  });
  const nAssociacoes = new Map(contagens.map((r) => [r.utilizador_id, Number(r.total)]));
  res.render('admin/global/utilizadores', {
    titulo: 'Utilizadores · Global',
    utilizadores: utilizadores.map((u) => ({ ...u.toJSON(), associacoes: nAssociacoes.get(u.id) || 0 })),
  });
});

router.post('/global/utilizadores/:id/global', async (req, res) => {
  const utilizador = await User.findByPk(req.params.id);
  if (!utilizador) {
    req.flash('error_msg', 'Utilizador não encontrado.');
    return res.redirect('/admin/global/utilizadores');
  }
  if (utilizador.id === req.user.id) {
    req.flash('error_msg', 'Não pode remover o seu próprio papel de Super Admin.');
    return res.redirect('/admin/global/utilizadores');
  }
  const novo = req.body.role === 'super_admin' ? 'super_admin' : null;
  await utilizador.update({ role_global: novo });
  await audit({ userId: req.user.id, acao: novo ? 'promover_super_admin' : 'remover_super_admin', entidade: 'User', entidadeId: utilizador.id });
  req.flash('success_msg', novo ? 'Utilizador promovido a Super Admin global.' : 'Papel global removido.');
  return res.redirect('/admin/global/utilizadores');
});

// ── Auditoria global ────────────────────────────────────────────────
router.get('/global/auditoria', async (req, res) => {
  const { acao, entidade } = req.query;
  const where = {};
  if (acao) where.acao = acao;
  if (entidade) where.entidade = entidade;
  const registos = await AuditLog.findAll({
    where,
    include: [{ model: User, as: 'user', attributes: ['id', 'nome', 'email'] }],
    order: [['id', 'DESC']],
    limit: 250,
  });
  const acoes = await AuditLog.findAll({ attributes: [[require('sequelize').fn('DISTINCT', require('sequelize').col('acao')), 'acao']], order: [['acao', 'ASC']], raw: true });
  res.render('admin/global/auditoria', {
    titulo: 'Auditoria · Global',
    registos,
    acoes: acoes.map((a) => a.acao),
    filtros: { acao: acao || '', entidade: entidade || '' },
  });
});

module.exports = router;
