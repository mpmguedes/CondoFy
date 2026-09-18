// ─────────────────────────────────────────────────────────────────────
// "Preparar saída do condomínio" — fluxo próprio do condómino.
//
// Não confundir com:
//  · "Terminar sessão" (fim de sessão do browser, em /logout) — não muda nada
//    nas relações da pessoa com os condomínios;
//  · "Transferir administração" (fluxo separado, ainda não implementado) — um
//    administrador entrega a administração a outra pessoa; não passa por aqui.
//
// O que este fluxo faz, por esta ordem:
//  1. explica o que vai acontecer (página própria, sem surpresas);
//  2. permite descarregar a informação a que tem direito (ZIP com manifesto);
//  3. pede confirmação forte (palavra-passe + 2FA quando ativo + confirmação
//     explícita, em segundo passo);
//  4. encerra as titularidades ativas (com data de fim — o histórico fica);
//  5. desativa a associação ao condomínio (a linha permanece; só o estado muda);
//  6. regista tudo na auditoria e limpa o condomínio ativo da sessão.
//
// O histórico financeiro e documental do condomínio nunca é tocado. A conta
// GesCondu continua válida para os restantes condomínios.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { UserCondominio, Fracao } = require('../models');
const { eAutenticado } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const titularidades = require('../helpers/titularidades');
const { construirExportacao } = require('../helpers/exportacao-dados');
const { audit } = require('../helpers/audit');
const doisfatores = require('../helpers/doisfatores');
const cabecalhos = require('../helpers/cabecalhos-ficheiro');
const { getCondominio } = require('../helpers/condominio');

const router = express.Router();

router.use(eAutenticado);
// Defesa em profundidade: o suporte diagnóstico nunca entra no portal. A guarda
// global em `app.js` já cobre este prefixo.
router.use(tenant.semSuporte);
// Isolamento: tudo acontece no condomínio ativo da sessão.
router.use(tenant.comCondominioAtivo);

const PAPEIS_GESTAO = ['admin', 'gestor'];
const MSG_SEM_RELACAO = 'Não tem uma relação ativa com este condomínio que possa ser encerrada.';

// Mensagem a apresentar quando o fluxo não se aplica a esta conta.
function motivoNaoAplicavel(estado) {
  return estado.motivoIndisponivel || MSG_SEM_RELACAO;
}

// Contexto do fluxo: a pessoa e as frações de que é titular ATUALMENTE.
async function contexto(req) {
  const pessoa = req.user.pessoa_id
    ? await require('../models').Pessoa.findOne({ where: { id: req.user.pessoa_id, condominio_id: req.condominioId } })
    : null;
  const { fracoes } = await titularidades.fracoesDoUtilizador({
    condominioId: req.condominioId,
    utilizadorId: req.user.id,
    pessoaId: req.user.pessoa_id,
  });
  const lista = fracoes.map(({ fracao, vinculo }) => {
    fracao.vinculoAtual = vinculo || null;
    return fracao;
  });
  return { pessoa, fracoes: lista };
}

// Quantos administradores/gestores ativos tem o condomínio (para não deixar o
// condomínio sem ninguém que o possa gerir).
async function nGestoresAtivos(condominioId) {
  return UserCondominio.count({
    where: { condominio_id: condominioId, estado: 'ativo', role: { [Op.in]: PAPEIS_GESTAO } },
  });
}

// Reautenticação: palavra-passe e, quando o 2FA por aplicação está ativo,
// também o código atual. Usa os mecanismos que já existem (nada paralelo).
function reautenticacaoValida(req) {
  const password = String(req.body.password || '');
  if (!password) return { ok: false, erro: 'Indique a sua palavra-passe para confirmar.' };
  if (!req.user.password_hash || !bcrypt.compareSync(password, req.user.password_hash)) {
    return { ok: false, erro: 'Palavra-passe incorreta.' };
  }
  if (req.user.two_fa_ativo && req.user.two_fa_metodo === 'totp') {
    const codigo = String(req.body.codigo_2fa || '').replace(/\s+/g, '');
    if (!codigo) return { ok: false, erro: 'Indique o código da aplicação de autenticação.' };
    if (!req.user.two_fa_totp_secret || !doisfatores.verificarTOTP(req.user.two_fa_totp_secret, codigo)) {
      return { ok: false, erro: 'Código de autenticação inválido.' };
    }
  }
  return { ok: true };
}

// Estado do fluxo, partilhado pelas páginas.
async function estadoDoFluxo(req) {
  const { pessoa, fracoes } = await contexto(req);
  const associacao = await UserCondominio.findOne({
    where: { utilizador_id: req.user.id, condominio_id: req.condominioId, estado: 'ativo' },
  });
  const papel = associacao ? associacao.role : null;
  const eGestor = PAPEIS_GESTAO.includes(papel);
  const nGestores = await nGestoresAtivos(req.condominioId);
  return {
    pessoa,
    fracoes,
    papel,
    eGestor,
    // Pode encerrar o acesso quem tem uma associação ativa a este condomínio —
    // mesmo que já não tenha frações (ex.: vendeu a fração e a titularidade foi
    // encerrada pela administração). A administração é caso separado: quem
    // administra transfere primeiro a administração.
    podeSair: associacao !== null && !eGestor,
    bloqueio: eGestor && nGestores <= 1
      ? 'É o único administrador ou gestor ativo deste condomínio. Encerrar o seu acesso deixaria o condomínio sem quem o possa gerir: transfira primeiro a administração.'
      : null,
    motivoIndisponivel: eGestor
      ? 'A sua conta administra este condomínio, pelo que este fluxo não se aplica. Trate primeiro da sua administração (por exemplo, passando o papel de administrador a outra pessoa) em Utilizadores; a saída como condómino faz-se depois.'
      : null,
    exige2fa: Boolean(req.user.two_fa_ativo && req.user.two_fa_metodo === 'totp'),
  };
}

// ── 1. Página explicativa ──────────────────────────────────────────
router.get('/saida', async (req, res) => {
  const estado = await estadoDoFluxo(req);
  if (!estado.podeSair) {
    req.flash('error_msg', motivoNaoAplicavel(estado));
    return res.redirect(estado.eGestor ? '/admin/utilizadores' : '/condomino');
  }
  const condominio = await getCondominio({ id: req.condominioId });

  // "Início do processo de saída" fica registado (é uma ação deliberada).
  await audit({
    userId: req.user.id,
    acao: 'inicio_saida_condominio',
    entidade: 'UserCondominio',
    entidadeId: req.condominioId,
    detalhes: { condominioId: req.condominioId, fracoes: estado.fracoes.map((f) => f.designacao) },
  });

  return res.render('condomino/saida-condominio', {
    titulo: 'Preparar saída do condomínio',
    condominio,
    ...estado,
    outrosCondominios: (await tenant.listarCondominios(req.user.id)).filter((c) => Number(c.id) !== Number(req.condominioId)).length,
    exportado: req.query.exportado === '1',
  });
});

// ── 2. Exportação controlada ("Descarregar a minha informação") ────
router.post('/saida/exportar', async (req, res) => {
  const estado = await estadoDoFluxo(req);
  if (!estado.podeSair) {
    req.flash('error_msg', motivoNaoAplicavel(estado));
    return res.redirect(estado.eGestor ? '/admin/utilizadores' : '/condomino');
  }
  const verificacao = reautenticacaoValida(req);
  if (!verificacao.ok) {
    req.flash('error_msg', verificacao.erro);
    return res.redirect('/condomino/saida');
  }

  try {
    const condominio = await getCondominio({ id: req.condominioId });
    const { nomeFicheiro, buffer, manifesto } = await construirExportacao({
      condominioId: req.condominioId,
      condominio,
      utilizador: req.user,
      pessoa: estado.pessoa,
      fracoes: estado.fracoes,
    });
    await audit({
      userId: req.user.id,
      acao: 'exportacao_dados',
      entidade: 'User',
      entidadeId: req.user.id,
      detalhes: {
        condominioId: req.condominioId,
        ficheiro: nomeFicheiro,
        bytes: buffer.length,
        fracoes: manifesto.fracoes,
        incluidos: manifesto.incluidos.length,
        ignorados: manifesto.ignorados.length,
      },
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', cabecalhos.disposicao(nomeFicheiro, 'attachment', 'GesCondu_Exportacao.zip'));
    return res.send(buffer);
  } catch (err) {
    console.error('[saida] erro ao preparar a exportação:', err);
    req.flash('error_msg', 'Não foi possível preparar a exportação. Tente novamente.');
    return res.redirect('/condomino/saida');
  }
});

// ── 3. Segundo passo: confirmação final ────────────────────────────
router.get('/saida/confirmar', async (req, res) => {
  const estado = await estadoDoFluxo(req);
  if (!estado.podeSair) {
    req.flash('error_msg', motivoNaoAplicavel(estado));
    return res.redirect(estado.eGestor ? '/admin/utilizadores' : '/condomino');
  }
  const condominio = await getCondominio({ id: req.condominioId });
  return res.render('condomino/saida-condominio-confirmar', {
    titulo: 'Encerrar acesso a este condomínio',
    condominio,
    ...estado,
    outrosCondominios: (await tenant.listarCondominios(req.user.id)).filter((c) => Number(c.id) !== Number(req.condominioId)).length,
  });
});

// ── 4. Conclusão: encerra a relação, mantém o histórico ────────────
router.post('/saida/concluir', async (req, res) => {
  const estado = await estadoDoFluxo(req);
  if (!estado.podeSair) {
    req.flash('error_msg', motivoNaoAplicavel(estado));
    return res.redirect(estado.eGestor ? '/admin/utilizadores' : '/condomino');
  }
  if (req.body.confirmo !== 'on') {
    req.flash('error_msg', 'Confirme que pretende encerrar o seu acesso a este condomínio.');
    return res.redirect('/condomino/saida/confirmar');
  }
  if (estado.bloqueio) {
    req.flash('error_msg', estado.bloqueio);
    return res.redirect('/condomino/saida');
  }
  const verificacao = reautenticacaoValida(req);
  if (!verificacao.ok) {
    req.flash('error_msg', verificacao.erro);
    return res.redirect('/condomino/saida/confirmar');
  }

  try {
    // 1) Encerrar as titularidades ativas (data de fim — histórico preservado).
    const encerradas = await titularidades.cessarTitularidadesAtivas({
      condominioId: req.condominioId,
      utilizadorId: req.user.id,
      pessoaId: req.user.pessoa_id || null,
      motivo: 'saida_condominio',
      userId: req.user.id,
    });

    // 2) Revogar o acesso ao condomínio sem apagar a associação (reversível, e
    //    é o estado que `tenant` já valida em cada pedido).
    await UserCondominio.update(
      { estado: 'inativo' },
      { where: { utilizador_id: req.user.id, condominio_id: req.condominioId } }
    );

    // 3) Auditoria com o essencial: quem, onde, quantas relações e porquê.
    await audit({
      userId: req.user.id,
      acao: 'saida_condominio',
      entidade: 'UserCondominio',
      entidadeId: req.condominioId,
      detalhes: {
        condominioId: req.condominioId,
        titularidadesEncerradas: encerradas.map((t) => ({ id: t.id, fracaoId: t.fracao_id, vinculo: t.vinculo })),
        papelAnterior: estado.papel,
      },
    });

    // 4) Limpar o condomínio ativo da sessão (a conta continua válida).
    delete req.session.condominio_ativo_id;

    req.flash('success_msg', 'O seu acesso a este condomínio foi encerrado. O histórico do condomínio mantém-se e a sua conta continua ativa.');
    return res.redirect('/condominios');
  } catch (err) {
    console.error('[saida] erro ao encerrar o acesso:', err);
    req.flash('error_msg', 'Não foi possível concluir a saída. Nada foi alterado; tente novamente.');
    return res.redirect('/condomino/saida');
  }
});

module.exports = router;
