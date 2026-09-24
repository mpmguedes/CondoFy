// ─────────────────────────────────────────────────────────────────────
// Emails — central OPERACIONAL (fila de envio + histórico + preferências).
//
// A configuração técnica do serviço de email (SMTP) e o envio do email de
// teste NÃO vivem aqui: passaram para Configuração → Email / SMTP
// (`routes/configuracao.js`, `/admin/config/email`). Esta central ficou só com
// a operação: listar/filtrar a fila, reenviar, cancelar e as preferências de
// notificação. A configuração continua a ser a MESMA (`helpers/mailer.js`).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { Op } = require('sequelize');
const { EmailFila, Documento, Aviso, User } = require('../models');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const mailer = require('../helpers/mailer');
const {
  processarEmailUnico,
  cancelarEmail,
  contarFila,
  reenviarEmail,
  filtroFilaPorCondominio,
} = require('../helpers/email-fila');
const { listarPreferencias, guardarPreferencias } = require('../helpers/notificacoes');
// Período da listagem (mês em curso até hoje, por omissão). Puro e sem BD.
const { resolverPeriodo, ATALHOS } = require('../helpers/periodo-filtro');

const router = express.Router();
// Central de emails (operação da fila) — módulo de plataforma/condomínio admin.
router.use(tenant.comCondominioAtivo);

// ── Suporte diagnóstico: admissão explícita DESTE módulo ───────────
// A allow-list é partilhada (`helpers/suporte-allowlist.js`). Só as rotas
// declaradas para o módulo `emails` são admitidas ao suporte; as
// restantes caem na guarda de papel abaixo.
const allowlistSuporte = require('../helpers/suporte-allowlist');
router.use(allowlistSuporte.soDiagnostico('emails'));

// Guarda de papel CONDICIONAL (única): contornada só pelo suporte ADMITIDO.
// Um `router.use(tenant.comPapel('admin'))` incondicional a seguir anularia a
// admissão — o Express corre os dois e o segundo recusaria o pedido admitido.
router.use(allowlistSuporte.comPapelOuSuporteAdmitido('admin'));

const ESTADOS_LABEL = {
  pendente: 'Pendente',
  a_enviar: 'A enviar',
  enviado: 'Enviado',
  erro: 'Erro',
  cancelado: 'Cancelado',
};

function filtraPor(filtro) {
  if (filtro === 'pendentes') return { estado: { [Op.in]: ['pendente', 'a_enviar'] } };
  if (filtro === 'enviados') return { estado: 'enviado' };
  if (filtro === 'erros') return { estado: 'erro' };
  if (filtro === 'cancelados') return { estado: 'cancelado' };
  return {};
}

// Filtro por origem (tipo de documento/entidade).
const ORIGENS = {
  quotas: { rotulo: 'Quotas', condicao: { entidade_tipo: 'Quota' } },
  recibos: { rotulo: 'Recibos', condicao: { entidade_tipo: 'Pagamento' } },
  avisos: { rotulo: 'Avisos', condicao: { aviso_id: { [Op.ne]: null } } },
  documentos: { rotulo: 'Documentos', condicao: { documento_id: { [Op.ne]: null }, aviso_id: null } },
  fornecedores: { rotulo: 'Fornecedores', condicao: { entidade_tipo: 'PagamentoFornecedor' } },
};

function filtraOrigem(tipo) {
  const origem = ORIGENS[tipo];
  return origem ? origem.condicao : {};
}

router.get('/emails', async (req, res) => {
  const filtro = ['pendentes', 'enviados', 'erros', 'cancelados'].includes(req.query.estado)
    ? req.query.estado
    : 'todas';
  const tipo = Object.prototype.hasOwnProperty.call(ORIGENS, req.query.tipo) ? req.query.tipo : 'todas';

  // Período: mês em curso até hoje por omissão, alterável por atalho ou por
  // datas. Resolvido numa função PURA (helpers/periodo-filtro.js) e aplicado
  // ABAIXO, na consulta — nunca escondendo registos no frontend depois de os
  // carregar todos. É um filtro de LEITURA: não altera nem apaga nada.
  const periodo = resolverPeriodo(req.query);
  const ondeData = { createdAt: { [Op.between]: [periodo.de, periodo.ate] } };

  // Isolamento: a Central de Emails vive dentro de um condomínio — todas as
  // listagens/contagens filtram condominio_id = ativo. Registos históricos sem
  // condominio_id (NULL/órfãos) nunca aparecem aqui.
  const baseCondominio = filtroFilaPorCondominio(req.condominioId);

  const [contagens, emails, estadoSmtp, preferencias] = await Promise.all([
    contarFila({ condominioId: req.condominioId }),
    EmailFila.findAll({
      where: {
        ...baseCondominio,
        ...ondeData,
        ...filtraPor(filtro),
        ...filtraOrigem(tipo),
      },
      include: [
        { model: Documento, as: 'documento', attributes: ['id', 'nome', 'drive_status', 'url'] },
        { model: Aviso, as: 'aviso', attributes: ['id', 'assunto'] },
        { model: User, as: 'utilizador', attributes: ['id', 'nome'] },
      ],
      order: [['id', 'DESC']],
      limit: 200,
    }),
    mailer.obterEstadoSmtp(),
    listarPreferencias(),
  ]);

  // P54-7 — linhas da CONSULTA para o padrão P54-0: valores como TEXTO, sem um
  // único input na página. Não há segredos nesta área (são preferências
  // sim/não), pelo que nenhuma linha é marcada como `sensivel`.
  const linhasNotificacoes = preferencias.map((p) => ({
    rotulo: p.rotulo,
    valor: `Email: ${p.email ? 'ativo' : 'inativo'} · Guardar: ${p.drive ? 'ativo' : 'inativo'}`,
  }));

  res.render(req.suporte ? 'admin/emails/index-suporte' : 'admin/emails/index', {
    titulo: 'Emails',
    emails,
    filtro,
    tipo,
    origens: ORIGENS,
    contagens,
    estadoSmtp,
    preferencias,
    linhasNotificacoes,
    estadosLabel: ESTADOS_LABEL,
    periodo,
    periodos: ATALHOS,
  });
});

// ── Notificações automáticas (preferências por evento) ─────────────
// P54-7 — o ÂMBITO vem do condomínio ATIVO (`req.condominioId`, já validado pelo
// tenant), nunca do corpo do pedido: é isso que impede que gravar aqui altere as
// preferências de outro condomínio. A gravação recusa-se a correr sem âmbito.
router.post('/emails/notificacoes', async (req, res) => {
  try {
    const r = await guardarPreferencias(req.body, req.condominioId);
    await audit({
      userId: req.user.id,
      acao: 'configurar_notificacoes',
      entidade: 'Configuracao',
      // P54-7 — auditoria com utilizador, condomínio e as chaves cujo EFEITO
      // mudou. ⛔ Só NOMES de campos: nunca valores (não há segredos aqui, mas a
      // regra é a mesma em toda a frente).
      detalhes: { condominioId: req.condominioId, eventos: r.eventos, alterados: r.alterados },
    }).catch(() => {});
    req.flash('success_msg', r.alterados.length
      ? `Preferências de notificações guardadas (${r.alterados.length} alteração(ões)).`
      : 'Preferências de notificações guardadas — nada mudou.');
  } catch (err) {
    console.error('[emails] notificações:', err.message);
    // As mensagens do validador são escritas para o utilizador; qualquer outra
    // falha (BD, âmbito ausente) mantém a mensagem genérica — nunca se ecoa o
    // erro interno.
    const doValidador = err.motivo === 'submissao_incompleta' || err.motivo === 'campo_desconhecido';
    req.flash('error_msg', doValidador ? err.message : 'Não foi possível guardar as notificações.');
  }
  res.redirect('/admin/emails#notificacoes');
});

// ── Ações sobre a fila (sempre isoladas por condomínio ativo) ───────
router.post('/emails/:id/reenviar', async (req, res) => {
  try {
    // O helper verifica que o email pertence ao condomínio ativo; um email de
    // outro condomínio é tratado como inexistente (nunca é reenviado).
    const item = await EmailFila.findOne({
      where: { id: req.params.id, condominio_id: req.condominioId },
    });
    if (!item) throw new Error('Registo de email não encontrado neste condomínio.');
    await reenviarEmail(item.id, req.condominioId);
    if (item.estado === 'enviado') {
      req.flash('success_msg', 'Email marcado para reenvio (será processado pela fila).');
    } else {
      await processarEmailUnico(item.id, req.condominioId);
      req.flash('success_msg', `Email reenviado para ${item.destinatario_email}.`);
    }
    await audit({ userId: req.user.id, acao: 'reenviar_email', entidade: 'EmailFila', entidadeId: item.id }).catch(() => {});
  } catch (err) {
    console.error('[emails] reenviar:', err.message);
    req.flash('error_msg', `Não foi possível reenviar: ${err.message}`);
  }
  res.redirect('/admin/emails');
});

router.post('/emails/:id/cancelar', async (req, res) => {
  try {
    const item = await EmailFila.findOne({
      where: { id: req.params.id, condominio_id: req.condominioId },
    });
    if (!item) throw new Error('Registo de email não encontrado neste condomínio.');
    await cancelarEmail(item.id, req.condominioId);
    await audit({ userId: req.user.id, acao: 'cancelar_email', entidade: 'EmailFila', entidadeId: item.id }).catch(() => {});
    req.flash('success_msg', 'Email cancelado.');
  } catch (err) {
    console.error('[emails] cancelar:', err.message);
    req.flash('error_msg', `Não foi possível cancelar: ${err.message}`);
  }
  res.redirect('/admin/emails');
});

module.exports = router;
