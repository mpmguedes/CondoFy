// ─────────────────────────────────────────────────────────────────────
// Administração GLOBAL (Super Admin) — condomínios, utilizadores,
// associações, auditoria e suporte. Apenas utilizadores role_global =
// 'super_admin' têm acesso a estas rotas.
//
// Namespace: este router está montado em `/global` (app.js). Os URLs
// `/admin/global*` continuam a responder através de um shim de compatibilidade
// que redireciona para `/global*`. Por isso, e enquanto as vistas mantiverem
// os links antigos `/admin/global…`, os redirects internos usam `urlGlobal()`
// — devolvem o caminho LEGADO, que é o que o browser acabou de pedir, evitando
// um salto extra via shim em cada POST→GET.
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
// Regra única do estado da associação (reativação só quando explícita).
const titularidades = require('../helpers/titularidades');
const { eAutenticado } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const tenant = require('../helpers/tenant');
const suporte = require('../helpers/suporte');
const { validarNif } = require('../public/js/validacao-fiscal');

// Prefixo do namespace global nos URLs gerados pelo router. Mantém-se
// `/admin/global` por compatibilidade com as vistas e com os marcadores e
// links já existentes; o shim do app.js garante que continua a funcionar.
const PREFIXO_GLOBAL = '/admin/global';

const router = express.Router();
router.use(eAutenticado);

// Guarda: apenas Super Admin global — decidida EXCLUSIVAMENTE por
// `users.role_global` (`tenant.eSuperAdmin`). Um admin ou gestor de condomínio
// nunca entra aqui, mesmo que `users.role` seja 'admin' (coluna legado).
router.use((req, res, next) => {
  if (tenant.eSuperAdmin(req.user)) return next();
  req.flash('error_msg', 'Acesso restrito à administração global.');
  return res.redirect('/');
});

// Caminho de um recurso da administração global, no prefixo público atual.
// Deriva o prefixo da MONTAGEM (`req.baseUrl`) para não haver duas verdades
// sobre o namespace; cai no prefixo de compatibilidade quando não há pedido
// (chamadas directas em testes).
function urlGlobal(req, resto = '') {
  return (req && req.baseUrl ? req.baseUrl : PREFIXO_GLOBAL) + resto;
}

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
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  try {
    const nifValidado = validarNif(req.body.nif);
    if (!nifValidado.ok) {
      req.flash('error_msg', nifValidado.mensagem);
      return res.redirect(urlGlobal(req, '/condominios'));
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
    return res.redirect(urlGlobal(req, '/condominios'));
  } catch (err) {
    console.error('[global-condominio]', err);
    req.flash('error_msg', 'Erro ao criar o condomínio.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
});

// Estado: desativar / reativar (ciclo Ativo → Desativado).
router.post('/global/condominios/:id/estado', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
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
  return res.redirect(urlGlobal(req, '/condominios'));
});

// Eliminação permanente — requer condomínio DESATIVADO + confirmação forte.
router.post('/global/condominios/:id/eliminar', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  if (String(req.body.confirmo || '').trim() !== 'ELIMINAR') {
    req.flash('error_msg', 'Confirmação inválida. Escreva ELIMINAR para confirmar a eliminação permanente.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }
  if (condominio.estado !== 'inativo') {
    req.flash('error_msg', 'Para eliminar definitivamente, o condomínio tem de estar desativado primeiro.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
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
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }
  await audit({ userId: req.user.id, acao: 'condominio_eliminado', entidade: 'Condominio', entidadeId: req.params.id });
  req.flash('success_msg', 'Condomínio eliminado permanentemente.');
  return res.redirect(urlGlobal(req, '/condominios'));
});

// ── Acesso de SUPORTE (terceiro contexto) ───────────────────────────
// O Super Admin é administrador da PLATAFORMA: não tem acesso permanente aos
// dados de um condomínio, não fica associado a ele e não recebe
// `req.condominioId` por omissão. O acesso a um condomínio só acontece por uma
// CONCESSÃO explícita registada em `acessos_suporte` — com condomínio alvo,
// motivo obrigatório, prazo absoluto e estado auditável.
//
// Estas rotas apenas CRIAM/GEREM a concessão. O contexto em si é materializado
// por `tenant.comCondominioAtivo` (via `req.suporte`), que nunca produz
// `req.papelCondominio = 'admin'|'gestor'`.
router.get('/global/condominios/:id/suporte', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  const [vigentes, pendentes, historico, temAdmin] = await Promise.all([
    suporte.vigentesDe(req.user.id),
    suporte.pendentesDe(condominio.id),
    suporte.historicoDe(condominio.id, 50),
    suporte.temAdminAtivo(condominio.id),
  ]);
  res.render('admin/global/suporte', {
    titulo: `Suporte · ${condominio.designacao}`,
    condominio,
    vigentes,
    pendentes,
    historico,
    temAdmin,
    duracoes: suporte.DURACOES_MINUTOS,
    niveis: suporte.NIVEIS_CONCEDIVEIS,
  });
});

router.post('/global/condominios/:id/suporte', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  const r = await suporte.iniciar({
    req,
    condominioId: condominio.id,
    motivo: req.body.motivo,
    nivel: req.body.nivel,
    duracaoMinutos: req.body.duracao_minutos,
  });
  if (!r.ok) {
    const MENSAGENS = {
      motivo_obrigatorio: 'Indique o motivo do acesso de suporte.',
      nivel_nao_concedivel: 'O nível pedido não pode ser concedido.',
      duracao_invalida: 'Escolha uma duração da lista.',
    };
    req.flash('error_msg', MENSAGENS[r.erro] || 'Não foi possível iniciar o acesso de suporte.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}/suporte`));
  }

  await audit({
    userId: req.user.id,
    acao: r.pendente ? 'suporte_pendente_autorizacao' : 'suporte_iniciado',
    entidade: 'Condominio',
    entidadeId: condominio.id,
    detalhes: {
      acesso_suporte_id: r.acesso.id,
      nivel: r.acesso.nivel,
      motivo: r.acesso.motivo,
      condominio_id: condominio.id,
      expira_em: r.acesso.expira_em,
    },
  });

  if (r.pendente) {
    req.flash('success_msg', 'Pedido registado. Aguarda autorização de um administrador do condomínio.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}/suporte`));
  }
  req.flash('success_msg', `Acesso de suporte ativo (só leitura) até ${new Date(r.acesso.expira_em).toISOString().slice(11, 16)} UTC.`);
  return res.redirect('/admin');
});

router.post('/global/suporte/:id/terminar', async (req, res) => {
  const acesso = await suporte.terminar({ acessoId: req.params.id, req });
  const destino = acesso && acesso.acesso
    ? urlGlobal(req, `/condominios/${acesso.acesso.condominio_id}/suporte`)
    : urlGlobal(req, '/condominios');
  await audit({
    userId: req.user.id,
    acao: 'suporte_terminado',
    entidade: 'Condominio',
    entidadeId: acesso && acesso.acesso ? acesso.acesso.condominio_id : null,
    detalhes: { acesso_suporte_id: req.params.id },
  });
  req.flash('success_msg', 'Acesso de suporte terminado.');
  return res.redirect(destino);
});

router.post('/global/suporte/:id/revogar', async (req, res) => {
  const r = await suporte.revogar({ acessoId: req.params.id, revogadoPor: req.user.id, req });
  await audit({
    userId: req.user.id,
    acao: 'suporte_revogado',
    entidade: 'Condominio',
    entidadeId: r && r.acesso ? r.acesso.condominio_id : null,
    detalhes: { acesso_suporte_id: req.params.id },
  });
  req.flash('success_msg', 'Acesso de suporte revogado.');
  const destino = r && r.acesso
    ? urlGlobal(req, `/condominios/${r.acesso.condominio_id}/suporte`)
    : urlGlobal(req, '/condominios');
  return res.redirect(destino);
});

// ── Detalhe do condomínio (membros/associações) ────────────────────
router.get('/global/condominios/:id', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
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
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const papel = ['admin', 'gestor', 'leitura'].includes(req.body.role) ? req.body.role : 'leitura';
  if (!email) {
    req.flash('error_msg', 'Indique o email do utilizador.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }
  const utilizador = await User.findOne({ where: { email } });
  if (!utilizador) {
    req.flash('error_msg', 'Não existe nenhum utilizador com esse email.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }
  const [associacao] = await UserCondominio.findOrCreate({
    where: { utilizador_id: utilizador.id, condominio_id: condominio.id },
    defaults: { utilizador_id: utilizador.id, condominio_id: condominio.id, role: papel, estado: 'ativo' },
  });
  // Reutiliza a regra única: uma associação inativa (acesso encerrado, por
  // exemplo pelo próprio utilizador) NÃO volta a ativo só por se voltar a
  // associar o utilizador — a reativação tem de ser pedida explicitamente.
  const decisao = titularidades.decidirEstadoAssociacao({
    estadoAtual: associacao ? associacao.estado : 'ativo',
    reativar: req.body.reativar_acesso,
  });
  if (associacao) {
    await associacao.update({ role: papel, estado: decisao.estado });
  }
  await audit({
    userId: req.user.id,
    acao: decisao.reativada ? 'reativar_acesso_condominio' : 'associar_utilizador_condominio',
    entidade: 'Condominio',
    entidadeId: condominio.id,
    detalhes: {
      email,
      papel,
      associacaoAntes: associacao ? associacao.estado : null,
      associacao: decisao.estado,
      reativacaoExplicita: decisao.reativada,
    },
  });
  if (!decisao.estavaAtiva && !decisao.reativada) {
    req.flash('error_msg', 'Associação atualizada. O acesso deste utilizador a este condomínio continua encerrado — marque «Reativar acesso» para o reabrir.');
  } else {
    req.flash('success_msg', `Associação atualizada (${email} → ${papel}).`);
  }
  return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
});

router.post('/global/associacoes/:id/estado', async (req, res) => {
  const assoc = await UserCondominio.findByPk(req.params.id);
  if (!assoc) {
    req.flash('error_msg', 'Associação não encontrada.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  const papel = ['admin', 'gestor', 'leitura'].includes(req.body.role) ? req.body.role : assoc.role;
  const estado = req.body.estado === 'ativo' ? 'ativo' : req.body.estado === 'inativo' ? 'inativo' : assoc.estado;
  await assoc.update({ role: papel, estado });
  await audit({ userId: req.user.id, acao: 'alterar_associacao_condominio', entidade: 'Condominio', entidadeId: assoc.condominio_id, detalhes: { papel, estado } });
  req.flash('success_msg', 'Associação atualizada.');
  return res.redirect(urlGlobal(req, `/condominios/${assoc.condominio_id}`));
});

router.post('/global/associacoes/:id/eliminar', async (req, res) => {
  const assoc = await UserCondominio.findByPk(req.params.id);
  if (!assoc) {
    req.flash('error_msg', 'Associação não encontrada.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  const condominioId = assoc.condominio_id;
  await assoc.destroy();
  await audit({ userId: req.user.id, acao: 'remover_associacao_condominio', entidade: 'Condominio', entidadeId: condominioId });
  req.flash('success_msg', 'Associação removida.');
  return res.redirect(urlGlobal(req, `/condominios/${condominioId}`));
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
    return res.redirect(urlGlobal(req, '/utilizadores'));
  }
  if (utilizador.id === req.user.id) {
    req.flash('error_msg', 'Não pode remover o seu próprio papel de Super Admin.');
    return res.redirect(urlGlobal(req, '/utilizadores'));
  }
  const novo = req.body.role === 'super_admin' ? 'super_admin' : null;
  await utilizador.update({ role_global: novo });
  await audit({ userId: req.user.id, acao: novo ? 'promover_super_admin' : 'remover_super_admin', entidade: 'User', entidadeId: utilizador.id });
  req.flash('success_msg', novo ? 'Utilizador promovido a Super Admin global.' : 'Papel global removido.');
  return res.redirect(urlGlobal(req, '/utilizadores'));
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
