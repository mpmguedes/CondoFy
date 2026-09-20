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
// Eliminação de condomínio: descoberta de dependências a partir do schema real.
const eliminacaoCondominio = require('../helpers/eliminacao-condominio');
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

// ── Estado do condomínio: DESATIVAR / REATIVAR ──────────────────────
//
// O ciclo de vida é Ativo → Desativado → Eliminação permanente, e cada passo é
// uma DECISÃO, não um interruptor. A implementação anterior era um toggle cego
// (`estado === 'ativo' ? 'inativo' : 'ativo'`), com três defeitos:
//
//   1. Sem intenção. O botão que o operador via não determinava o efeito: o
//      SERVIDOR decidia a partir do estado em BD. Um duplo-submit (ou um F5
//      depois do POST) revertia silenciosamente a transição — o operador
//      desativava e ficava ativo, sem erro nenhum.
//   2. Sem motivo. Desativar um condomínio é uma interrupção de serviço para
//      toda a gente que lá trabalha, e não deixava rasto do PORQUÊ.
//   3. Sem pré-condição. Reativar um condomínio já ativo «passava» e reescrevia
//      o mesmo estado, produzindo um evento de auditoria que não correspondia a
//      transição nenhuma.
//
// Agora há DUAS rotas explícitas, e cada uma sabe o que está a fazer:
//   POST /global/condominios/:id/desativar  → exige motivo + estado ativo
//   POST /global/condominios/:id/reativar   → exige estado inativo
//
// A rota antiga `/:id/estado` mantém-se por compatibilidade, mas deixou de ser
// um toggle: deriva a INTENÇÃO a partir de um campo `acao` do formulário
// (`desativar`/`reativar`) e delega nas mesmas duas rotas. Sem `acao` explícita,
// recusa — nunca adivinha. Assim não existe um caminho cego paralelo.
const ACOES_ESTADO = ['desativar', 'reativar'];

// Lê o motivo de um formulário, já normalizado. `null` quando vazio.
function motivoDoPedido(req) {
  const texto = String((req.body && req.body.motivo) || '').trim();
  return texto || null;
}

// Registo de uma tentativa RECUSADA. Existe porque uma recusa é informação de
// segurança: uma série de tentativas de desativar sem motivo, ou de eliminar
// sem a confirmação correta, é exatamente o que se quer ver num log de
// auditoria. A implementação anterior não registava nada nestes casos.
async function auditarRecusa({ req, acao, entidadeId, motivoSistema, detalhes = {} }) {
  await audit({
    userId: req.user ? req.user.id : null,
    acao,
    entidade: 'Condominio',
    entidadeId,
    detalhes: { resultado: 'recusado', motivo: motivoSistema, ...detalhes },
  }).catch(() => {});
}

// Desativação: exige motivo e um condomínio ATIVO. Termina os acessos de
// suporte vigentes e audita cada um (ver `terminarVigentesDoCondominio`).
async function desativarCondominio(req, res) {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }

  const motivo = motivoDoPedido(req);
  if (!motivo) {
    await auditarRecusa({
      req,
      acao: 'condominio_desativacao_recusada',
      entidadeId: condominio.id,
      motivoSistema: 'motivo_obrigatorio',
    });
    req.flash('error_msg', 'Indique o motivo da desativação.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }

  // Pré-condição: só se desativa o que está ativo. Recusar aqui é o que impede
  // um duplo-submit de reverter a operação — a segunda tentativa encontra o
  // estado já mudado e é recusada, em vez de o reverter.
  if (condominio.estado !== 'ativo') {
    await auditarRecusa({
      req,
      acao: 'condominio_desativacao_recusada',
      entidadeId: condominio.id,
      motivoSistema: 'estado_invalido',
      detalhes: { estado_atual: condominio.estado },
    });
    req.flash('error_msg', 'Só é possível desativar um condomínio ativo.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }

  await condominio.update({ estado: 'inativo' });

  // Encerrar os acessos de suporte vigentes DESTE condomínio. Cada término tem
  // o seu próprio evento (`suporte_terminado`, origem `condominio_desativado`),
  // pelo que não se audita a soma — audita-se o que o operador fez, e o número
  // fica no evento da desativação para leitura rápida.
  const suporteEncerrado = await suporte.terminarVigentesDoCondominio({
    condominioId: condominio.id,
    atorId: req.user ? req.user.id : null,
  });

  await audit({
    userId: req.user.id,
    acao: 'condominio_desativado',
    entidade: 'Condominio',
    entidadeId: condominio.id,
    detalhes: {
      designacao: condominio.designacao,
      motivo,
      acessos_suporte_terminados: suporteEncerrado.terminados,
    },
  });

  const extra = suporteEncerrado.terminados > 0
    ? ` ${suporteEncerrado.terminados} acesso(s) de suporte encerrado(s).`
    : '';
  req.flash('success_msg', `Condomínio desativado.${extra}`);
  return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
}

// Reativação: NÃO exige motivo (decisão de produto — o motivo do episódio está
// no evento da desativação, e o histórico mantém-se intacto). Exige apenas que
// o condomínio esteja desativado, para não registrar uma transição inexistente.
async function reativarCondominio(req, res) {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }

  if (condominio.estado !== 'inativo') {
    await auditarRecusa({
      req,
      acao: 'condominio_reativacao_recusada',
      entidadeId: condominio.id,
      motivoSistema: 'estado_invalido',
      detalhes: { estado_atual: condominio.estado },
    });
    req.flash('error_msg', 'Só é possível reativar um condomínio desativado.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }

  await condominio.update({ estado: 'ativo' });

  await audit({
    userId: req.user.id,
    acao: 'condominio_reativado',
    entidade: 'Condominio',
    entidadeId: condominio.id,
    detalhes: { designacao: condominio.designacao },
  });

  req.flash('success_msg', 'Condomínio reativado.');
  return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
}

// Rotas explícitas — a intenção está no CAMINHO, não no estado da BD.
router.post('/global/condominios/:id/desativar', desativarCondominio);
router.post('/global/condominios/:id/reativar', reativarCondominio);

// Rota de compatibilidade. Já não é um toggle: exige `acao` explícita e delega.
// Um cliente antigo que só enviem o formulário sem `acao` é recusado, em vez de
// lhe ser adivinhado o efeito pretendido — falhar fechado é preferível a fazer
// a operação errada.
router.post('/global/condominios/:id/estado', async (req, res) => {
  const acao = String((req.body && req.body.acao) || '').trim();
  if (!ACOES_ESTADO.includes(acao)) {
    const condominio = await Condominio.findByPk(req.params.id, { attributes: ['id'] });
    if (condominio) {
      await auditarRecusa({
        req,
        acao: 'condominio_estado_recusado',
        entidadeId: condominio.id,
        motivoSistema: 'acao_ausente_ou_invalida',
        detalhes: { acao_recebida: acao || null },
      });
    }
    req.flash('error_msg', 'Operação inválida: indique se pretende desativar ou reativar.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  return acao === 'desativar' ? desativarCondominio(req, res) : reativarCondominio(req, res);
});

// Eliminação permanente — requer condomínio DESATIVADO + confirmação forte.
//
// A lista de tabelas NÃO é escrita à mão (foi essa a origem do defeito: uma
// lista de 13 tabelas contra um schema com mais, e `movimentos_bancarios`
// nunca apagada enquanto `contas_bancarias` era — FK RESTRICT ⇒ rollback
// garantido em qualquer condomínio com contas bancárias). `eliminacaoCondominio`
// DESCOBRE as tabelas a partir do catálogo da BD, calcula a ordem pelas FKs
// reais e ABORTA (sem apagar nada) se encontrar uma tabela que não saiba tratar.
router.post('/global/condominios/:id/eliminar', async (req, res) => {
  const condominio = await Condominio.findByPk(req.params.id);
  if (!condominio) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect(urlGlobal(req, '/condominios'));
  }
  // As duas pré-condições são auditadas quando falham. A eliminação é a
  // operação mais destrutiva do sistema: uma tentativa recusada (confirmação
  // errada, condomínio ainda ativo) é precisamente o que se quer ver no log,
  // e antes não deixava rasto nenhum.
  if (String(req.body.confirmo || '').trim() !== 'ELIMINAR') {
    await auditarRecusa({
      req,
      acao: 'condominio_eliminacao_recusada',
      entidadeId: condominio.id,
      motivoSistema: 'confirmacao_invalida',
    });
    req.flash('error_msg', 'Confirmação inválida. Escreva ELIMINAR para confirmar a eliminação permanente.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }
  if (condominio.estado !== 'inativo') {
    await auditarRecusa({
      req,
      acao: 'condominio_eliminacao_recusada',
      entidadeId: condominio.id,
      motivoSistema: 'nao_esta_desativado',
      detalhes: { estado_atual: condominio.estado },
    });
    req.flash('error_msg', 'Para eliminar definitivamente, o condomínio tem de estar desativado primeiro.');
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }

  // Acessos de suporte ANTES de eliminar. São apagados pela FK CASCADE, mas
  // por ARRASTO — não por decisão. Contá-los e registá-los torna a eliminação
  // reconstituível: sem isto, um acesso que existia no momento da eliminação
  // desaparecia sem que nada na auditoria o mencionasse.
  //
  // Faz-se a leitura FORA da transação de propósito: é um número para o
  // relatório, e não deve influenciar (nem falhar) a eliminação em si.
  const acessosSuporte = await suporte
    .contagemAcessosDoCondominio(condominio.id)
    .catch(() => ({ total: null, vigentes: null }));

  const sequelize = require('../config/database');
  const t = await sequelize.transaction();
  let resumo;
  try {
    // 1. Associações utilizador ↔ condomínio: só as deste condomínio. O
    //    utilizador é global e NUNCA é apagado por perder uma associação.
    //    (Está fora da descoberta por ser uma tabela de associação ao
    //    próprio condomínio; o `eliminacaoCondominio` também a trataria.)
    await UserCondominio.destroy({ where: { condominio_id: condominio.id }, transaction: t });

    // 2. Dados do condomínio — ordem calculada pelas FKs reais, cada DELETE
    //    limitado ao condomínio alvo. Fail-closed: qualquer incógnita lança.
    resumo = await eliminacaoCondominio.eliminarDadosDoCondominio({
      sequelize,
      condominioId: condominio.id,
      transaction: t,
    });

    // 3. A raiz.
    await eliminacaoCondominio.eliminarCondominio({
      sequelize,
      condominioId: condominio.id,
      transaction: t,
    });

    await t.commit();
  } catch (err) {
    await t.rollback();
    console.error('[global-eliminar]', err);
    // Mensagem explícita quando a recusa é de segurança (schema não tratado),
    // para o operador saber que NADA foi apagado e porquê.
    if (err && err.name === 'ErroEliminacao') {
      req.flash('error_msg', `Eliminação recusada — nada foi apagado. ${err.message}`);
    } else {
      req.flash('error_msg', 'Erro ao eliminar o condomínio. Nada foi apagado.');
    }
    return res.redirect(urlGlobal(req, `/condominios/${condominio.id}`));
  }

  // 4. Auditoria FORA da transação: o commit já aconteceu. Se a auditoria
  //    falhar (ou se a transação tivesse revertido), o registo não é
  //    destruído pelo rollback e a tentativa continua rastreável.
  await audit({
    userId: req.user.id,
    acao: 'condominio_eliminado',
    entidade: 'Condominio',
    entidadeId: req.params.id,
    detalhes: {
      designacao: condominio.designacao,
      totalLinhas: resumo.total,
      porTabela: resumo.porTabela,
      acessos_suporte_total: acessosSuporte.total,
      acessos_suporte_vigentes: acessosSuporte.vigentes,
    },
  }).catch((e) => console.error('[global-eliminar][auditoria]', e));

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
      condominio_inativo: 'Este condomínio está desativado — não é possível abrir um acesso de suporte.',
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
