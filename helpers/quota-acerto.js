// Q11 / R10 — ACERTO de uma quota EMITIDA.
//
// Uma quota emitida é um documento: os seus valores são imutáveis (R10). Corrigir
// um valor emitido NÃO se faz com um `UPDATE` à quota — faz-se com um documento
// NOVO, o ACERTO, que:
//   · referencia a quota original (`quota_id`) SEM A ALTERAR;
//   · referencia o orçamento de origem quando aplicável (`orcamento_id`);
//   · guarda o motivo (`justificacao`);
//   · guarda o valor anterior e o valor novo (`valor_anterior`/`valor_novo`);
//   · guarda o autor (`criado_por`) e é registado na auditoria transversal;
//   · não executa nenhum recálculo global — só trata da quota indicada.
//
// Este módulo é a INFRAESTRUTURA da operação (domínio + persistência). Não
// inclui rotas nem vistas: a ligação à interface é uma fase seguinte.
//
// Invariante estrutural: este ficheiro NUNCA chama `quota.update`. É essa
// ausência que garante «a quota original nunca é alterada para realizar um
// acerto» — não uma verificação que se possa contornar.
const sequelize = require('../config/database');
const { Quota, ExtraQuota } = require('../models');
const { audit } = require('../helpers/audit');
const { toCents, fromCents } = require('../helpers/money');

// Erro de domínio: distingue «o pedido não é válido» de «a base de dados falhou».
class ErroAcerto extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroAcerto';
  }
}

/**
 * Regista um acerto sobre uma quota emitida. A quota NÃO é alterada.
 *
 * @param {object} p
 * @param {number} p.condominioId âmbito (obrigatório — nunca inferido)
 * @param {number} p.quotaId      quota original corrigida
 * @param {string|number} p.valorNovo  valor que a quota passa a valer
 * @param {string} p.justificacao motivo da operação (obrigatório)
 * @param {number} p.userId       autor da operação
 * @param {object} [p.transaction]
 * @returns {Promise<{extra: object, valorAnteriorC: number, valorNovoC: number, diferencaC: number}>}
 */
async function registarAcerto({
  condominioId, quotaId, valorNovo, justificacao, userId, transaction = null,
}) {
  const quota = await Quota.findOne({
    where: { id: quotaId, condominio_id: condominioId },
    transaction,
  });
  if (!quota) throw new ErroAcerto('Quota não encontrada neste condomínio.');

  // Um acerto corrige um DOCUMENTO. Uma quota ainda não emitida corrige-se pela
  // configuração/edição normal — criar um acerto para ela seria um documento a
  // corrigir um rascunho.
  if (!quota.data_emissao) {
    throw new ErroAcerto(
      'Um acerto corrige uma quota JÁ EMITIDA. Esta quota ainda não foi emitida: '
      + 'corrija-a pela configuração de quotas ou pela edição normal.'
    );
  }

  const motivo = String(justificacao === null || justificacao === undefined ? '' : justificacao).trim();
  if (!motivo) {
    throw new ErroAcerto('Um acerto exige justificação: sem motivo não é auditável.');
  }

  const valorAnteriorC = toCents(quota.valor);
  const valorNovoC = toCents(valorNovo);
  if (valorNovoC <= 0) {
    throw new ErroAcerto('O valor novo do acerto tem de ser maior que zero.');
  }
  if (valorNovoC === valorAnteriorC) {
    throw new ErroAcerto('O valor novo é igual ao valor atual: não há nada a acertar.');
  }
  const diferencaC = valorNovoC - valorAnteriorC;

  // O acerto é um documento NOVO. `valor_total` é o montante a cobrar:
  // só a DIFERENÇA positiva (um acerto a mais cobra o acrescido; uma redução
  // não gera crédito — o crédito é uma decisão de produto ainda em aberto).
  // Ver «pontos que precisam de decisão» no relatório da fase.
  const aCobrarC = diferencaC > 0 ? diferencaC : 0;

  const extra = await ExtraQuota.create(
    {
      condominio_id: condominioId,
      tipo: 'acerto',
      // Vínculo à quota original — referência, nunca alvo de escrita.
      quota_id: quota.id,
      // Vínculo histórico ao orçamento de origem, quando exista.
      orcamento_id: quota.orcamento_id || null,
      designacao: `Acerto da quota ${quota.numero_documento || quota.id}`,
      valor_total: fromCents(aCobrarC),
      metodo_divisao: 'permilagem',
      // O acerto respeita o período da quota que corrige.
      mes_inicio: quota.mes,
      ano_inicio: quota.ano,
      numero_parcelas: 1,
      periodicidade: 'mensal',
      // Nasce pendente de aprovação, como qualquer documento financeiro.
      estado: 'pendente',
      justificacao: motivo,
      valor_anterior: fromCents(valorAnteriorC),
      valor_novo: fromCents(valorNovoC),
      criado_por: userId,
    },
    { transaction }
  );

  await audit({
    userId,
    acao: 'registar_acerto_quota',
    entidade: 'ExtraQuota',
    entidadeId: extra.id,
    detalhes: {
      quotaId: quota.id,
      orcamentoId: quota.orcamento_id || null,
      valorAnterior: fromCents(valorAnteriorC),
      valorNovo: fromCents(valorNovoC),
      diferenca: fromCents(diferencaC),
      justificacao: motivo,
      // Prova explícita de que o documento original não foi tocado.
      quotaOriginalAlterada: false,
    },
  });

  return { extra, valorAnteriorC, valorNovoC, diferencaC };
}

/**
 * Correção dentro de uma transação própria — para quem chama de fora de uma.
 * (Separado para o chamador poder compor o acerto numa transação já aberta.)
 */
async function registarAcertoEmTransacao(pedido) {
  const t = await sequelize.transaction();
  try {
    const resultado = await registarAcerto({ ...pedido, transaction: t });
    await t.commit();
    return resultado;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = { registarAcerto, registarAcertoEmTransacao, ErroAcerto };
