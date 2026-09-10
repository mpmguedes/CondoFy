// ─────────────────────────────────────────────────────────────────────
// Link temporário de documento — destinatários SEM conta no GesCondu.
//
// Como funciona:
//  · o link é emitido pelo backend SÓ depois de um administrador/gestor
//    autenticado pedir o envio do documento (helpers/documentos-acesso.js,
//    criarLinkTemporario) — nunca existe por si;
//  · é assinado (HMAC-SHA256), está ligado a UM documento e a UM condomínio,
//    e expira (por omissão 7 dias, DOC_LINK_TTL_HOURS);
//  · ao ser aberto, confirma-se a assinatura, a validade e que o documento
//    continua a pertencer ao condomínio indicado no token;
//  · cada acesso fica registado na auditoria (via = link_temporario).
//
// Não há aqui nenhuma listagem nem descoberta: sem um token válido, a rota
// não revela sequer se o documento existe. Para quem tem conta, o caminho é
// sempre a rota autenticada (/condomino/documentos/:id/ficheiro).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const { documentoDeLinkTemporario, servirDocumento } = require('../helpers/documentos-acesso');

const router = express.Router();

function texto(res, status, mensagem) {
  res.status(status);
  res.type('text/plain; charset=utf-8');
  return res.send(mensagem);
}

router.get('/documentos/ficheiro/:token', async (req, res) => {
  const r = await documentoDeLinkTemporario(req.params.token);
  if (!r.ok) {
    if (r.motivo === 'expirado') {
      return texto(res, 410, 'Este link expirou. Peça ao administrador do condomínio que volte a enviar o documento.');
    }
    if (r.motivo === 'sem_ficheiro') {
      return texto(res, 404, 'Este documento não tem ficheiro associado.');
    }
    return texto(res, 404, 'Link inválido.');
  }

  const servido = await servirDocumento({ documento: r.documento, req, res, disposicao: 'inline', via: 'link_temporario' });
  if (!servido.ok && !res.headersSent) {
    return texto(res, 502, servido.mensagem);
  }
  return undefined;
});

module.exports = router;
