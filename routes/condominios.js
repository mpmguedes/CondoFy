// ─────────────────────────────────────────────────────────────────────
// Multi-condomínio — "Os meus condomínios" (seleção, criação, entrada).
// O condomínio ativo é sempre guardado na SESSÃO e validado contra a
// associação utilizador ↔ condomínio (nunca confiar num id vindo do browser).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const { Condominio, Fracao, UserCondominio } = require('../models');
const { eAutenticado } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const tenant = require('../helpers/tenant');

const router = express.Router();

// Pode criar condomínios: Super Admin global OU utilizador sem nenhum
// condomínio (arranque do primeiro condomínio).
async function podeCriar(req) {
  if (tenant.eSuperAdmin(req.user)) return true;
  const meus = await tenant.listarCondominios(req.user.id);
  return meus.length === 0;
}

// ── Lista "Os meus condomínios" ────────────────────────────────────
router.get('/condominios', eAutenticado, async (req, res) => {
  const meus = await tenant.listarCondominios(req.user.id);

  // Contagem de frações por condomínio (cartões).
  const ids = meus.map((c) => c.id);
  const contagens = ids.length
    ? await Fracao.findAll({
        attributes: ['condominio_id', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'total']],
        where: { condominio_id: { [Op.in]: ids } },
        group: ['condominio_id'],
        raw: true,
      })
    : [];
  const nFracoes = new Map(contagens.map((r) => [r.condominio_id, Number(r.total)]));
  const lista = meus.map((c) => ({ ...c, fracoes: nFracoes.get(c.id) || 0 }));

  res.render('condominios/meus', {
    titulo: 'Os meus condomínios',
    lista,
    podeCriar: await podeCriar(req),
    naoSeparado: true,
  });
});

// ── Criar condomínio (primeiro ou por Super Admin) ─────────────────
router.post('/condominios', eAutenticado, async (req, res) => {
  if (!(await podeCriar(req))) {
    req.flash('error_msg', 'Não tem permissão para criar condomínios.');
    return res.redirect('/condominios');
  }
  const designacao = String(req.body.designacao || '').trim();
  if (!designacao) {
    req.flash('error_msg', 'Indique o nome do condomínio.');
    return res.redirect('/condominios');
  }
  try {
    const condominio = await Condominio.create({
      designacao,
      morada: String(req.body.morada || '').trim() || null,
      codigo_postal: String(req.body.codigo_postal || '').trim() || null,
      localidade: String(req.body.localidade || '').trim() || null,
      nif: String(req.body.nif || '').trim() || null,
      estado: 'ativo',
    });
    await UserCondominio.create({
      utilizador_id: req.user.id,
      condominio_id: condominio.id,
      role: tenant.eSuperAdmin(req.user) ? 'admin' : 'admin',
      estado: 'ativo',
    });
    req.session.condominio_ativo_id = condominio.id;
    await audit({
      userId: req.user.id,
      acao: 'condominio_criado',
      entidade: 'Condominio',
      entidadeId: condominio.id,
    });
    req.flash('success_msg', `Condomínio "${condominio.designacao}" criado.`);
    return res.redirect('/');
  } catch (err) {
    console.error('[criar-condominio]', err);
    req.flash('error_msg', 'Erro ao criar o condomínio.');
    return res.redirect('/condominios');
  }
});

// ── Entrar num condomínio (valida associação; define o ativo na sessão) ──
router.post('/condominios/:id/entrar', eAutenticado, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = await tenant.entrarCondominio(req, id);
  if (!ok) {
    req.flash('error_msg', 'Não tem acesso a este condomínio.');
    return res.redirect('/condominios');
  }
  await audit({
    userId: req.user.id,
    acao: 'entrar_condominio',
    entidade: 'Condominio',
    entidadeId: id,
    detalhes: { superAdminSuporte: tenant.eSuperAdmin(req.user) },
  }).catch(() => {});
  return res.redirect('/');
});

module.exports = router;
