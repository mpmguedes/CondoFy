// ─────────────────────────────────────────────────────────────────────
// Avisos PROGRAMADOS — disparo automático por `data_programada` (P29).
//
// Antes: o calendário mostrava os avisos programados, mas nenhuma tarefa os
// despachava — só o botão «Enviar» (manual) punha o aviso na fila. Um aviso
// marcado como programado ficava parado para sempre.
//
// Aqui: uma tarefa diária procura os avisos `programado` com data já atingida
// e enfileira-os pelo MESMO motor do envio manual (`helpers/avisos-envio.js`).
//
// Idempotência — o ponto crítico. A tarefa corre TODOS os dias e a condição
// (`data_programada <= hoje`) continua verdadeira depois do primeiro disparo.
// O que impede o reenvio é a deduplicação por `email_fila.aviso_id` com o
// critério ESTADOS_DESPACHADOS (que inclui `erro` e `cancelado`): um aviso
// despachado não volta a ser enfileirado, um cancelado não é ressuscitado e um
// que falhou não entra em ciclo diário. As 3 tentativas de reenvio continuam a
// ser da fila (`helpers/email-fila.js`), não desta tarefa.
//
// Isolamento — como todas as tarefas automáticas (`jobs/automatizacao.js`), o
// âmbito é derivado dos DADOS: itera os condomínios ATIVOS e trata cada aviso
// com o `condominio_id` da própria linha, nunca com um condomínio assumido.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { Aviso } = require('../models');
const { enfileirarAviso, ESTADOS_DESPACHADOS } = require('../helpers/avisos-envio');
const { condominiosAtivos } = require('./automatizacao');
const { estaAtivo } = require('../helpers/notificacoes');
const { toDateInput } = require('../helpers/dates');

// Base absoluta para o link do documento no email. Uma tarefa agendada não tem
// pedido HTTP de onde derivar protocolo/host. Sem `APP_URL` configurado não se
// inventa um endereço: o link é omitido e o aviso segue na mesma (com anexo,
// quando existe) — o motor descarta links relativos, que não seriam clicáveis.
function baseUrlPublica(env = process.env) {
  return String((env && env.APP_URL) || '').trim().replace(/\/+$/, '');
}

// Despacha os avisos programados com data já atingida.
//
// `agora` é injetável para o teste fixar o dia. Devolve estatísticas; nunca
// lança por causa de um aviso — um aviso mal formado não impede os restantes.
async function enviarAvisosProgramados({ agora = new Date() } = {}) {
  const hoje = toDateInput(agora);

  // Só condomínios ATIVOS — um condomínio inativo não recebe comunicações.
  const ativos = await condominiosAtivos();
  const ids = ativos.map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return { hoje, avisos: 0, enfileirados: 0, porCondominio: [] };

  // A preferência «Avisos → email» governa os envios AUTOMÁTICOS (é o mesmo
  // critério que `enviarLembretesAutomaticos` aplica aos avisos de atraso). O
  // envio manual não a consulta: é uma ação explícita do administrador.
  if (!(await estaAtivo('avisos', 'email'))) {
    return { hoje, avisos: 0, enfileirados: 0, porCondominio: [], desativado: true };
  }

  // Data já atingida (não só o dia exato): uma paragem da aplicação no dia
  // programado não pode perder o aviso para sempre.
  const avisos = await Aviso.findAll({
    where: {
      tipo: 'programado',
      data_programada: { [Op.ne]: null, [Op.lte]: hoje },
      condominio_id: { [Op.in]: ids },
    },
    order: [['data_programada', 'ASC'], ['id', 'ASC']],
  });

  const baseUrl = baseUrlPublica();
  let enfileirados = 0;
  const porCondominio = [];

  for (const aviso of avisos) {
    const condominioId = Number(aviso.condominio_id);
    if (!condominioId) continue; // sem condomínio não há âmbito — nunca se assume um
    try {
      const r = await enfileirarAviso({
        aviso,
        condominioId,
        baseUrl,
        estadosJaDespachados: ESTADOS_DESPACHADOS,
      });
      if (r.enfileirados > 0) {
        enfileirados += r.enfileirados;
        porCondominio.push({ condominioId, avisoId: aviso.id, enfileirados: r.enfileirados });
      }
    } catch (err) {
      // Um aviso que falha não pode impedir os restantes de sair.
      console.error(`[avisos-programados] aviso ${aviso.id} falhou:`, err.message);
    }
  }

  return { hoje, avisos: avisos.length, enfileirados, porCondominio };
}

module.exports = { enviarAvisosProgramados, baseUrlPublica };
