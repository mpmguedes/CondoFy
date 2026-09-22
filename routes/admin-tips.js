// ─────────────────────────────────────────────────────────────────────
// Tips contextuais do backoffice — dispensa.
//
// Router próprio e minúsculo, pela mesma razão do router das recomendações do
// portal: a decisão de elegibilidade vive no motor (`helpers/tips.js`) e o
// painel (`routes/admin.js`) mantém-se sem escrita nenhuma. Aqui só existe a
// dispensa — a leitura do estado que a alimenta continua nos handlers.
//
// ÂMBITO: o tip pertence ao condomínio ATIVO. A chave de dispensa inclui o
// condomínio (`tip:<id>@c<id>`), pelo que dispensar num condomínio não esconde
// o mesmo tip noutro. O condomínio vem SEMPRE da sessão (`comCondominioAtivo`),
// nunca do browser.
//
// Segurança: o identificador do tip é validado contra o registo do motor. Um
// identificador manipulado não é escrito e não origina destino nenhum.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const tips = require('../helpers/tips');

const router = express.Router();

// Contexto de condomínio (define `req.condominioId` e `req.papelCondominio`).
router.use(tenant.comCondominioAtivo);
// Quem pode dispensar é quem vê tips (gestor ou admin). Em contexto de suporte
// `req.papelCondominio` é null e a guarda recusa por construção.
router.use(tenant.comPapel('gestor'));

// ── Dispensar um tip ───────────────────────────────────────────────
// Destinos permitidos para onde voltar depois de dispensar. Lista FECHADA: o
// valor chega do browser, pelo que nunca é seguido sem validação — e nunca é
// usado para construir um URL (muito menos externo). Os tips aparecem no painel
// e na página de armazenamento; dispensar devolve o utilizador ao sítio onde
// estava, em vez de o atirar sempre para o painel.
const DESTINOS_PERMITIDOS = new Set(['/admin', '/admin/config/armazenamento']);

function destinoDeRegresso(pedido) {
  const alvo = String(pedido == null ? '' : pedido);
  return DESTINOS_PERMITIDOS.has(alvo) ? alvo : '/admin';
}

// Guarda apenas o estado de apresentação (dispensado + até quando). Não altera
// configuração, não resolve nada e não confirma nada: se a situação continuar
// a existir, o tip volta a poder aparecer no fim do intervalo.
router.post('/tips/:id/dispensar', async (req, res) => {
  const id = String(req.params.id || '');
  const destino = destinoDeRegresso(req.body && req.body.voltar);

  // Tip desconhecido ou não dispensável → nada é escrito.
  if (!tips.podeDispensar(id)) {
    req.flash('error_msg', 'A sugestão indicada não existe ou não pode ser dispensada.');
    return res.redirect(destino);
  }

  const resultado = await tips.registarDispensa({
    userId: req.user.id,
    tip: id,
    condominioId: req.condominioId,
  });
  if (!resultado.ok) {
    req.flash('error_msg', 'Não foi possível dispensar a sugestão.');
    return res.redirect(destino);
  }

  await audit({
    userId: req.user.id,
    acao: 'tip_dispensado',
    entidade: 'Tip',
    entidadeId: null,
    detalhes: {
      tip: id,
      condominioId: req.condominioId,
      intervaloDias: tips.DIAS_REAPRESENTACAO_PADRAO,
      criada: resultado.criada,
    },
  }).catch(() => {});

  req.flash('success_msg', 'Sugestão dispensada. Se a situação se mantiver, voltamos a lembrá-lo mais tarde.');
  return res.redirect(destino);
});

module.exports = router;
