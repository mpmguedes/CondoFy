// Deliberações de assembleia que autorizam a utilização do Fundo Comum de
// Reserva (FCR).
//
// A deliberação vive em `agenda_items` (um ponto da ordem de trabalhos = no
// máximo uma deliberação) e o condomínio vem sempre da assembleia — nunca é
// duplicado no item nem aceite do formulário. Toda a validação da cadeia
//   deliberação → agenda_item → assembleia → condomínio
// está aqui, numa só função pura (`validarDeliberacao`), para as rotas apenas
// a aplicarem.
//
// Este módulo trata da POLÍTICA (quem pode autorizar quanto); o dinheiro
// (recebido/transferido/disponível) está em helpers/fcr.js.
const { Op } = require('sequelize');
const { AgendaItem, Assembleia, MovimentoBancario, ContaBancaria } = require('../models');
const { toCents, fromCents } = require('./money');

// Assembleias em que uma deliberação aprovada NUNCA é aceite: a assembleia não
// chegou a reunir-se validamente ou foi cancelada.
const ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO = ['rascunho', 'agendada', 'cancelada'];

// ── Regra pura: pode ficar registada nesta assembleia/ponto? ────────
// Devolve { ok, valorAprovadoC } ou { ok:false, motivo, mensagem }.
// Regras:
//  · só itens sujeitos a votação podem ser aprovados;
//  · aprovada exige valor > 0; rejeitada e pendente não têm valor aprovado;
//  · assembleia em rascunho/agendada/cancelada nunca aprova nada.
function validarDeliberacao({ assembleia, item, estado, valorAprovadoC = null }) {
  const estadoDeliberacao = String(estado || 'pendente');
  if (!['pendente', 'aprovada', 'rejeitada'].includes(estadoDeliberacao)) {
    return { ok: false, motivo: 'estado_invalido', mensagem: 'Estado da deliberação inválido.' };
  }
  if (!assembleia || !item) {
    return { ok: false, motivo: 'item_invalido', mensagem: 'Ponto da ordem de trabalhos não encontrado nesta assembleia.' };
  }
  if (ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO.includes(assembleia.estado)) {
    return {
      ok: false,
      motivo: 'assembleia_nao_delibera',
      mensagem: `Uma assembleia ${assembleia.estado === 'cancelada' ? 'cancelada' : `em ${assembleia.estado}`} não pode ter deliberação aprovada.`,
    };
  }
  // Cadeia: o item tem de pertencer à assembleia carregada do condomínio ativo.
  if (Number(item.assembleia_id) !== Number(assembleia.id)) {
    return { ok: false, motivo: 'item_invalido', mensagem: 'Ponto da ordem de trabalhos não encontrado nesta assembleia.' };
  }
  if (estadoDeliberacao === 'aprovada' && !item.sujeito_votacao) {
    return {
      ok: false,
      motivo: 'sem_sujeito_votacao',
      mensagem: 'Só os pontos sujeitos a votação podem ficar aprovados.',
    };
  }
  const valor = valorAprovadoC === null || valorAprovadoC === undefined ? null : Math.round(Number(valorAprovadoC) || 0);
  if (estadoDeliberacao === 'aprovada') {
    if (valor === null || valor <= 0) {
      return {
        ok: false,
        motivo: 'valor_invalido',
        mensagem: 'Uma deliberação aprovada tem de ter um valor aprovado superior a 0,00 €.',
      };
    }
    return { ok: true, valorAprovadoC: valor };
  }
  // Pendente/rejeitada: nunca guardam valor aprovado (não autorizam utilização).
  return { ok: true, valorAprovadoC: null };
}

// ── Leitura de uma deliberação, já validada contra o condomínio ─────
// A cadeia completa é verificada aqui: deliberação → agenda_item → assembleia →
// condomínio. Devolve null se qualquer elo não pertencer ao condomínio ativo.
async function carregarDeliberacao({ deliberacaoId, condominioId, transaction }) {
  if (!deliberacaoId) return null;
  const item = await AgendaItem.findOne({
    where: { id: deliberacaoId },
    include: [{
      model: Assembleia,
      as: 'assembleia',
      attributes: ['id', 'condominio_id', 'numero', 'tipo', 'data', 'estado'],
      where: { condominio_id: condominioId },
      required: true,
    }],
    transaction,
  });
  if (!item) return null;
  return item;
}

// ── Valor utilizado de uma deliberação ──────────────────────────────
// Só as SAÍDAS CONFIRMADAS da conta do tipo fundo_reserva com esse
// `deliberacao_id`: o par saída/entrada é gravado com o mesmo id, pelo que somar
// as duas pontas contaria o mesmo dinheiro duas vezes.
async function valorUtilizadoDeliberacaoC(deliberacaoId, { condominioId, transaction } = {}) {
  if (!deliberacaoId) return 0;
  const contasFcr = await ContaBancaria.findAll({
    where: { condominio_id: condominioId, tipo: 'fundo_reserva' },
    attributes: ['id'],
    transaction,
  });
  const ids = contasFcr.map((c) => Number(c.id));
  if (!ids.length) return 0;
  const movimentos = await MovimentoBancario.findAll({
    where: {
      deliberacao_id: deliberacaoId,
      tipo: 'saida',
      estado: 'confirmado',
      conta_bancaria_id: { [Op.in]: ids },
    },
    attributes: ['valor'],
    transaction,
  });
  return movimentos.reduce((s, m) => s + toCents(m.valor), 0);
}

// ── Deliberação com valores calculados (para a interface) ───────────
// `disponivelAprovado = valor_aprovado − utilizado`, nunca negativo.
async function deliberacaoComUtilizacao(item, { condominioId, transaction } = {}) {
  const valorAprovadoC = toCents(item.valor_aprovado);
  const utilizadoC = await valorUtilizadoDeliberacaoC(item.id, { condominioId, transaction });
  const disponivelC = Math.max(0, valorAprovadoC - utilizadoC);
  return {
    id: item.id,
    assembleiaId: item.assembleia_id,
    assembleia: item.assembleia || null,
    ordem: item.ordem,
    descricao: item.descricao,
    estado: item.deliberacao_estado,
    nota: item.deliberacao_nota,
    valorAprovadoC,
    utilizadoC,
    disponivelC,
    valorAprovado: fromCents(valorAprovadoC),
    utilizado: fromCents(utilizadoC),
    disponivel: fromCents(disponivelC),
  };
}

// ── Deliberações aprovadas do condomínio com valor disponível ───────
// Só o que pode ser usado hoje: deliberação aprovada, com valor aprovado, em
// assembleia que já deliberou (convocada/realizada) e com saldo por usar.
// O valor disponível calculado aqui é informativo; a validação final é feita
// (dentro da transação) em helpers/fcr.js.
async function deliberacoesAprovadas({ condominioId, transaction } = {}) {
  const itens = await AgendaItem.findAll({
    where: { deliberacao_estado: 'aprovada' },
    include: [{
      model: Assembleia,
      as: 'assembleia',
      attributes: ['id', 'condominio_id', 'numero', 'tipo', 'data', 'estado'],
      where: { condominio_id: condominioId, estado: { [Op.notIn]: ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO } },
      required: true,
    }],
    order: [['assembleia_id', 'DESC'], ['ordem', 'ASC']],
    transaction,
  });
  const comValores = [];
  for (const item of itens) {
    comValores.push(await deliberacaoComUtilizacao(item, { condominioId, transaction }));
  }
  return comValores;
}

// ── Utilizações já registadas de um ponto (para a vista da assembleia) ──
// Devolve Map<agenda_item_id, utilizadoC>, calculado a partir das saídas
// confirmadas da conta FCR (uma consulta, sem N+1).
async function utilizacaoPorItemC({ condominioId, itemIds = [], transaction } = {}) {
  const mapa = new Map();
  if (!itemIds.length) return mapa;
  const contasFcr = await ContaBancaria.findAll({
    where: { condominio_id: condominioId, tipo: 'fundo_reserva' },
    attributes: ['id'],
    transaction,
  });
  const ids = contasFcr.map((c) => Number(c.id));
  if (!ids.length) return mapa;
  const movimentos = await MovimentoBancario.findAll({
    where: {
      deliberacao_id: { [Op.in]: itemIds.map(Number) },
      tipo: 'saida',
      estado: 'confirmado',
      conta_bancaria_id: { [Op.in]: ids },
    },
    attributes: ['deliberacao_id', 'valor'],
    transaction,
  });
  for (const m of movimentos) {
    const chave = Number(m.deliberacao_id);
    mapa.set(chave, (mapa.get(chave) || 0) + toCents(m.valor));
  }
  return mapa;
}

// ── Existe utilização financeira deste ponto? ───────────────────────
// Usado para impedir a eliminação de um ponto já usado (qualquer movimento com
// esse deliberacao_id, em qualquer estado: anulado também conta, para não
// deixar históricos órfãos).
async function temMovimentosAssociados(deliberacaoId, { transaction } = {}) {
  if (!deliberacaoId) return 0;
  return MovimentoBancario.count({ where: { deliberacao_id: deliberacaoId }, transaction });
}

module.exports = {
  ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO,
  validarDeliberacao,
  carregarDeliberacao,
  valorUtilizadoDeliberacaoC,
  deliberacaoComUtilizacao,
  deliberacoesAprovadas,
  utilizacaoPorItemC,
  temMovimentosAssociados,
};
