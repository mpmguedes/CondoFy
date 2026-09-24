const { AuditLog } = require('../models');

// ─────────────────────────────────────────────────────────────────────
// Registo de auditoria (`audit_logs`, append-only).
//
// Regra que se mantém: **nunca lança** para o chamador. Uma falha a escrever o
// log não pode interromper a operação que está a ser auditada (eliminar uma
// fração não pode falhar porque a auditoria falhou).
//
// O que mudou (P12, 2026-09-22): «não lançar» deixou de ser «não se sabe».
// Até aqui a falha morria num `console.error` e nada mais — a trilha de
// auditoria podia estar partida durante semanas sem que ninguém notasse. Numa
// funcionalidade de SEGURANÇA, o silêncio é o pior modo de falha. Passa a
// haver sinal observável:
//
//   · cada falha é contada (`estadoAuditoria().falhas`);
//   · a última causa e o momento ficam guardados (sem segredos: só a
//     mensagem do erro, nunca os `detalhes`);
//   · a partir de `LIMITE_AVISO` falhas SEGUIDAS o aviso é escalado — uma vez
//     por rajada, para não afogar o log quando a base de dados está em baixo;
//   · um registo bem-sucedido reinicia a contagem de falhas seguidas.
//
// Quem quiser saber se a auditoria está de pé (painel de diagnóstico,
// verificação de saúde) chama `estadoAuditoria()`.
// ─────────────────────────────────────────────────────────────────────

// Falhas seguidas a partir das quais o aviso passa a «ATENÇÃO».
const LIMITE_AVISO = 3;

let falhas = 0; // total desde o arranque do processo
let falhasSeguidas = 0; // reinicia no primeiro registo bem-sucedido
let ultimoErro = null;
let ultimaFalhaEm = null;
let avisoEmitido = false; // evita repetir o aviso a cada falha da mesma rajada

function registarFalha(acao, entidade, err) {
  falhas += 1;
  falhasSeguidas += 1;
  ultimoErro = err && err.message ? err.message : String(err);
  ultimaFalhaEm = new Date();

  const alvo = entidade ? `${acao} (${entidade})` : acao;
  console.error(`[auditoria] falha ao registar «${alvo}»: ${ultimoErro}`);

  if (falhasSeguidas === LIMITE_AVISO && !avisoEmitido) {
    avisoEmitido = true;
    console.error(
      `[auditoria] ATENÇÃO: ${falhasSeguidas} falhas seguidas a registar auditoria — `
      + 'a trilha de auditoria está a ser PERDIDA. Verificar a base de dados e o modelo AuditLog.'
    );
  }
}

// Regista uma operação importante no log de auditoria.
// Nunca lança erro para não interromper o fluxo principal.
//
// P54-3 — duas opções novas, ambas opcionais e sem efeito por omissão:
//   · `transaction` — escreve o evento DENTRO da transação do chamador, para
//     que configuração e auditoria sejam atómicas (ou ficam as duas, ou
//     nenhuma);
//   · `rigoroso` — em falha, RELANÇA em vez de engolir. Só faz sentido dentro
//     de uma transação: aí a auditoria faz parte da operação e uma falha tem de
//     reverter tudo. Fora dela mantém-se a regra histórica (a auditoria nunca
//     derruba a ação que está a ser auditada).
async function audit({ userId, acao, entidade, entidadeId, detalhes, transaction, rigoroso = false }) {
  try {
    await AuditLog.create({
      user_id: userId || null,
      acao,
      entidade: entidade || null,
      entidade_id: entidadeId || null,
      detalhes: detalhes ? JSON.stringify(detalhes) : null,
    }, transaction ? { transaction } : undefined);
    falhasSeguidas = 0;
    avisoEmitido = false;
  } catch (err) {
    registarFalha(acao, entidade, err);
    if (rigoroso) throw err;
  }
}

// Estado observável (sem segredos: nunca devolve `detalhes` nem o token).
function estadoAuditoria() {
  return {
    saudavel: falhasSeguidas === 0,
    falhas,
    falhasSeguidas,
    ultimoErro,
    ultimaFalhaEm,
  };
}

module.exports = { audit, estadoAuditoria, LIMITE_AVISO };
