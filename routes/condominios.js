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
const { validarNif } = require('../public/js/validacao-fiscal');

const router = express.Router();

// Pode criar condomínios: Super Admin global (criação de condomínios da
// plataforma) OU utilizador sem nenhum condomínio (arranque do primeiro
// condomínio — sem esta via, ninguém podia instalar a aplicação).
//
// Criar um condomínio NÃO exige estar associado a ele (ver o POST abaixo): o
// Super Admin cria sem se tornar membro e convida depois o administrador.
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
  const ROTULOS_PAPEL = { admin: 'Administrador de Condomínio', gestor: 'Gestor', leitura: 'Leitura' };
  const lista = meus.map((c) => ({
    ...c,
    fracoes: nFracoes.get(c.id) || 0,
    papelLabel: ROTULOS_PAPEL[c.role] || c.role,
    local: [c.morada, c.codigo_postal, c.localidade].filter(Boolean).join(' · ') || null,
  }));

  // Página independente (layout "blank"): sem sidebar nem seletor — o utilizador
  // ainda não escolheu o condomínio onde quer trabalhar.
  res.render('condominios/meus', {
    titulo: 'Os meus condomínios',
    lista,
    podeCriar: await podeCriar(req),
    layout: 'blank',
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
    const nifValidado = validarNif(req.body.nif);
    if (!nifValidado.ok) {
      req.flash('error_msg', nifValidado.mensagem);
      return res.redirect('/condominios');
    }
    const condominio = await Condominio.create({
      designacao,
      morada: String(req.body.morada || '').trim() || null,
      codigo_postal: String(req.body.codigo_postal || '').trim() || null,
      localidade: String(req.body.localidade || '').trim() || null,
      nif: nifValidado.valor || null,
      estado: 'ativo',
    });

    // Quem cria NÃO fica automaticamente associado ao condomínio.
    //
    // Antes criava-se sempre uma associação `role: 'admin'` para o criador. Para
    // um Super Admin isso significava que criar um condomínio o tornava
    // administrador dele — o Super Admin é administrador da PLATAFORMA e não
    // deve herdar o condomínio por o ter criado. O administrador do condomínio
    // nasce do convite (`helpers/convites.js`), que é quem define o dono.
    //
    // A exceção é o ARRANQUE: um utilizador sem nenhum condomínio (o cenário
    // de instalação, o primeiro condomínio da plataforma) continua a ser
    // associado como `admin`, senão criava um condomínio que ninguém podia
    // administrar. O critério é factual e não depende do eixo global.
    const jaTinha = await tenant.listarCondominios(req.user.id);
    const primeiro = jaTinha.length === 0;
    if (primeiro) {
      await UserCondominio.create({
        utilizador_id: req.user.id,
        condominio_id: condominio.id,
        role: 'admin',
        estado: 'ativo',
      });
      req.session.condominio_ativo_id = condominio.id;
    } else {
      // Não se «entra» num condomínio onde não se tem associação: o ativo na
      // sessão ficaria órfão e o pedido seguinte caía em /condominios.
      delete req.session.condominio_ativo_id;
    }

    await audit({
      userId: req.user.id,
      acao: 'condominio_criado',
      entidade: 'Condominio',
      entidadeId: condominio.id,
      detalhes: { associacaoCriada: primeiro ? 'admin' : null },
    });
    req.flash('success_msg', `Condomínio "${condominio.designacao}" criado.`);
    return res.redirect(primeiro ? '/' : '/condominios');
  } catch (err) {
    console.error('[criar-condominio]', err);
    req.flash('error_msg', 'Erro ao criar o condomínio.');
    return res.redirect('/condominios');
  }
});

// ── Entrar num condomínio (valida associação; define o ativo na sessão) ──
// Só a associação real entra por aqui. O Super Admin não «entra» num
// condomínio: quando precisa de o consultar, faz um pedido de ACESSO DE SUPORTE
// (ver `routes/global-admin.js` → `/global/condominios/:id/suporte`), que fica
// registado com motivo e prazo.
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
    detalhes: { via: 'associacao' },
  }).catch(() => {});
  return res.redirect('/');
});

module.exports = router;
