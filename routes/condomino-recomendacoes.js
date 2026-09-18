// ─────────────────────────────────────────────────────────────────────
// Portal do condómino — recomendações contextuais (Fase 2G).
//
// Router próprio, separado de `routes/condomino.js` (que é a consulta do
// condomínio ativo e se mantém estritamente só de leitura) e de
// `routes/condomino-conta.js`. Aqui vive apenas a dispensa de uma recomendação
// e a leitura do estado que a alimenta.
//
// O motor (`helpers/recomendacoes.js`) é quem decide o que é elegível. Este
// router não tem condições: não existe aqui nenhum `if` sobre 2FA.
//
// Segurança: a ação apresentada vem SEMPRE da definição da recomendação
// (identificador → definição), nunca do browser. Um identificador manipulado
// não origina destino arbitrário — é recusado antes de qualquer escrita.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { eAutenticado } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const recomendacoes = require('../helpers/recomendacoes');
const { RecomendacaoEstado } = require('../models');

const router = express.Router();

router.use(eAutenticado);
// Defesa em profundidade: o suporte diagnóstico nunca entra no portal. A guarda
// global em `app.js` já cobre este prefixo.
router.use(tenant.semSuporte);

// ── Dispensar uma recomendação ─────────────────────────────────────
// Guarda apenas o estado de apresentação (dispensada + até quando). Não altera
// a conta, não confirma nada e não toca em 2FA: se a condição continuar
// verdadeira, a recomendação volta a poder aparecer no fim do intervalo.
router.post('/recomendacoes/:id/dispensar', async (req, res) => {
  const id = String(req.params.id || '');
  const destino = '/condomino';

  // Recomendação desconhecida ou não dispensável → nada é escrito.
  if (!recomendacoes.podeDispensar(id)) {
    req.flash('error_msg', 'A recomendação indicada não existe ou não pode ser dispensada.');
    return res.redirect(destino);
  }

  const resultado = await recomendacoes.registarDispensa({ userId: req.user.id, recomendacao: id });
  if (!resultado.ok) {
    req.flash('error_msg', 'Não foi possível dispensar a recomendação.');
    return res.redirect(destino);
  }
  await audit({
    userId: req.user.id,
    acao: 'recomendacao_dispensada',
    entidade: 'RecomendacaoEstado',
    entidadeId: null,
    detalhes: { recomendacao: id, intervaloDias: recomendacoes.DIAS_REAPRESENTACAO_PADRAO, criada: resultado.criada },
  }).catch(() => {});
  req.flash('success_msg', 'Recomendação dispensada. Se a situação se mantiver, voltamos a lembrá-lo mais tarde.');
  return res.redirect(destino);
});

// ── Voltar a mostrar (limpar a dispensa) ───────────────────────────
// Útil e honesto: quem dispensou não fica sem forma de voltar atrás, e não é
// preciso esperar 30 dias. Remove APENAS o estado de apresentação desta conta
// para esta recomendação.
router.post('/recomendacoes/:id/mostrar', async (req, res) => {
  const id = String(req.params.id || '');
  const destino = '/condomino';
  if (!recomendacoes.porId(id)) {
    req.flash('error_msg', 'A recomendação indicada não existe.');
    return res.redirect(destino);
  }
  const removidas = await RecomendacaoEstado.destroy({
    where: { user_id: req.user.id, recomendacao: id },
  });
  await audit({
    userId: req.user.id,
    acao: 'recomendacao_reposta',
    entidade: 'RecomendacaoEstado',
    entidadeId: null,
    detalhes: { recomendacao: id, removidas },
  }).catch(() => {});
  req.flash('success_msg', 'Recomendação reposta.');
  return res.redirect(destino);
});

module.exports = router;
