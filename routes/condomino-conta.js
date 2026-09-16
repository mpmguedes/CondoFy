// ─────────────────────────────────────────────────────────────────────
// Portal do condómino — Conta, Perfil e Condomínios (Fase 2F).
//
// Fecha a experiência pessoal do portal: «A minha conta → Os meus condomínios
// → Segurança», dentro da casca do portal (sidebar/bottom bar), para o condómino
// não sair da sua área para ver quem é nem para mudar de condomínio.
//
// Porque este ficheiro existe em vez de tudo em routes/condomino.js:
//  · routes/condomino.js é a área de CONSULTA do condomínio ativo e tem de
//    continuar estritamente só de leitura (`test-area-condomino.js` verifica
//    que não há escrita nenhuma nesse módulo). A mudança de condomínio é a
//    única ação com efeito de sessão desta fase e vive aqui, isolada.
//
// O que NÃO se faz aqui (fronteira herdada e validada nas fases anteriores):
//  · não se altera a conta, o estado da conta nem a palavra-passe;
//  · não se altera nenhuma titularidade nem fração;
//  · não se reativa nem se encerra acesso;
//  · não se duplica 2FA (a gestão continua em /conta/seguranca).
//
// Trocar de condomínio significa apenas `condominio_ativo_id` na sessão e é
// sempre validado contra as associações reais do utilizador (helpers/tenant).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const { Fracao, User } = require('../models');
const { eAutenticado } = require('../helpers/eAdmin');
const { audit } = require('../helpers/audit');
const tenant = require('../helpers/tenant');
const titularidades = require('../helpers/titularidades');

const router = express.Router();

// Toda a área pessoal exige sessão. Não se monta `comCondominioAtivo` à entrada:
// a lista de condomínios tem de responder também a quem tem sessão mas não tem
// condomínio ativo (o `/condomino/condominios` é o caminho de volta, não pode
// redirecionar para fora para o pedir). O isolamento não depende disso — cada
// consulta filtra pelas associações ATIVAS do próprio utilizador.
router.use(eAutenticado);
// Este router é da área do condómino: um gestor/admin do condomínio tem a sua
// área própria (backoffice) e não é encaminhado para o portal.
router.use((req, res, next) => {
  if (res.locals.isAdmin) return res.redirect('/');
  return next();
});

// ── A minha conta / Perfil ─────────────────────────────────────────
// Uma só página para «quem sou eu»: dados da conta, segurança (estado real do
// 2FA, com a gestão existente) e a posição neste condomínio. Nada de dados
// administrativos e nada que já esteja no Início (o Início responde «qual é a
// minha situação financeira»; aqui responde-se «quem sou e onde estou»).
router.get('/perfil', async (req, res) => {
  // Dados da conta do PRÓPRIO — sempre pelo id da sessão, nunca por parâmetro.
  const conta = await User.findByPk(req.user.id);

  // Condomínio ativo (res.locals vem do app.js, validado por tenant) + frações
  // do próprio, pela mesma função que todas as outras páginas do portal usam.
  const ativo = res.locals.condominioAtivo || null;
  let fracoes = [];
  if (ativo) {
    const { fracoes: minhas } = await titularidades.fracoesDoUtilizador({
      condominioId: ativo.id,
      utilizadorId: req.user.id,
      pessoaId: req.user.pessoa_id,
    });
    fracoes = minhas.map(({ fracao, vinculo }) => ({
      id: fracao.id,
      designacao: fracao.designacao,
      vinculo: vinculo || null,
    }));
  }

  // Associações ativas são a lista completa (o middleware do app.js já as lê,
  // mas o perfil precisa do número certo mesmo em pedidos parciais).
  const meusCondominios = await tenant.listarCondominios(req.user.id);

  res.render('condomino/perfil', {
    titulo: 'Meu perfil',
    // `toJSON` quando o modelo o traz (instância Sequelize); um objeto simples
    // (duplos de teste) é usado tal como está.
    conta: conta ? (typeof conta.toJSON === 'function' ? conta.toJSON() : conta) : null,
    condominioAtivo: ativo,
    condominioLocal: ativo
      ? [ativo.morada, ativo.codigo_postal, ativo.localidade].filter(Boolean).join(' · ') || null
      : null,
    fracoes,
    nCondominios: meusCondominios.length,
    // Estado real da segurança da conta — a mesma leitura do controlador de 2FA.
    doisFatoresAtivo: Boolean(conta && conta.two_fa_ativo),
    doisFatoresMetodo: conta ? conta.two_fa_metodo : 'email',
  });
});

// ── Os meus condomínios (dentro do portal) ─────────────────────────
// Mesma informação e mesmo mecanismo da página de seleção, mas dentro da casca
// do portal: é daqui que se muda de condomínio sem perder a navegação.
// A lista vem SEMPRE de `tenant.listarCondominios(req.user.id)` — associações
// ATIVAS do próprio com condomínio ativo. Nunca de ids do browser.
router.get('/condominios', async (req, res) => {
  const meus = await tenant.listarCondominios(req.user.id);
  const ativoId = res.locals.condominioAtivo ? res.locals.condominioAtivo.id : null;
  const ids = meus.map((c) => c.id);

  // Total de frações de cada condomínio (dado do cartão, não é uma contagem de
  // "acesso": o acesso às frações continua a ser decidido pelas titularidades).
  const contagens = ids.length
    ? await Fracao.findAll({
        attributes: ['condominio_id', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'total']],
        where: { condominio_id: { [Op.in]: ids } },
        group: ['condominio_id'],
        raw: true,
      })
    : [];
  const nFracoes = new Map(contagens.map((r) => [r.condominio_id, Number(r.total)]));

  // Frações DO PRÓPRIO em cada condomínio da lista (titularidades em vigor).
  const lista = [];
  for (const c of meus) {
    const { fracoes } = await titularidades.fracoesDoUtilizador({
      condominioId: c.id,
      utilizadorId: req.user.id,
      pessoaId: req.user.pessoa_id,
    });
    lista.push({
      id: c.id,
      designacao: c.designacao,
      morada: c.morada,
      codigo_postal: c.codigo_postal,
      localidade: c.localidade,
      local: [c.morada, c.codigo_postal, c.localidade].filter(Boolean).join(' · ') || null,
      papelLabel: { admin: 'Administrador de Condomínio', gestor: 'Gestor', leitura: 'Leitura' }[c.role] || c.role,
      totalFracoes: nFracoes.get(c.id) || 0,
      ativo: c.id === ativoId,
      minhasFracoes: fracoes.map(({ fracao, vinculo }) => ({
        id: fracao.id,
        designacao: fracao.designacao,
        vinculo: vinculo || null,
      })),
    });
  }

  res.render('condomino/condominios', {
    titulo: 'Os meus condomínios',
    lista,
    ativoId,
    temAtivo: Boolean(ativoId),
    // Um só condomínio: informa-se, não se pede para escolher entre uma opção.
    varios: lista.length > 1,
  });
});

// ── Entrar num condomínio (troca do condomínio ativo) ──────────────
// Ação de sessão: `tenant.entrarCondominio` confirma a associação ativa do
// utilizador (ou, para Super Admin, a existência do condomínio) antes de
// escrever `condominio_ativo_id`. Um id inventado no browser não entra.
// Não toca em titularidades, frações, estado da conta nem permissões.
router.post('/condominios/:id/entrar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    req.flash('error_msg', 'Condomínio inválido.');
    return res.redirect('/condomino/condominios');
  }
  const atual = tenant.ativo(req);
  if (id === atual) {
    // Já é o condomínio ativo: nada para mudar (nem auditoria desnecessária).
    return res.redirect('/condomino');
  }
  const ok = await tenant.entrarCondominio(req, id);
  if (!ok) {
    req.flash('error_msg', 'Não tem acesso a este condomínio.');
    return res.redirect('/condomino/condominios');
  }
  await audit({
    userId: req.user.id,
    acao: 'entrar_condominio',
    entidade: 'Condominio',
    entidadeId: id,
    detalhes: { origem: 'portal_condomino', superAdminSuporte: tenant.eSuperAdmin(req.user) },
  }).catch(() => {});
  return res.redirect('/condomino');
});

module.exports = router;
