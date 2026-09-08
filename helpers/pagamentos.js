const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Pagamento, PagamentoQuota, PagamentoExtraParcela, ExtraQuotaParcela, MovimentoBancario, Fracao } = require('../models');
const { toCents, fromCents } = require('./money');
const { proximoNumero } = require('./numeracao');
const { criarMovimento } = require('./movimentos');

// Recalcula o estado de uma quota a partir dos pagamentos confirmados.
async function recalcularEstadoQuota(quotaId, transaction) {
  const quota = await Quota.findByPk(quotaId, { transaction });
  if (!quota || quota.estado === 'anulada') return;

  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: quotaId },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
    transaction,
  });
  const pagoC = aplicacoes
    .filter((a) => a.pagamento && a.pagamento.estado === 'confirmado')
    .reduce((s, a) => s + toCents(a.valor_aplicado), 0);

  const valorC = toCents(quota.valor);
  let estado;
  if (pagoC >= valorC) estado = 'paga';
  else if (pagoC > 0) estado = 'parcialmente_paga';
  else estado = 'pendente';

  await quota.update({ estado }, { transaction });
}

// Pura, testável: soma por quota apenas aplicações cujo pagamento está
// confirmado. Aplicações de pagamentos anulados ficam no histórico mas nunca
// contam para saldos/estados/disponibilidade.
function somarAplicacoesConfirmadas(aplicacoes) {
  const mapa = new Map();
  for (const a of aplicacoes || []) {
    if (!a || !a.pagamento || a.pagamento.estado !== 'confirmado') continue;
    mapa.set(a.quota_id, (mapa.get(a.quota_id) || 0) + toCents(a.valor_aplicado));
  }
  return mapa;
}

// Distribuição FIFO (pura, testável): quotas já ordenadas por ano/mês.
// pagoConfirmadoC: Map quota_id → cêntimos já pagos (APENAS pagamentos
// confirmados — aplicações de pagamentos anulados não contam).
// Devolve { alocacoes: [{quotaId, jaPagoC, aplicarC, novoPagoC}], restanteC }.
function alocarFIFO({ quotas, pagoConfirmadoC = new Map(), valorC }) {
  const alocacoes = [];
  let restanteC = Math.max(0, Number(valorC) || 0); // já em cêntimos
  for (const quota of quotas) {
    if (restanteC <= 0) break;
    const jaPagoC = pagoConfirmadoC.get(quota.id) || 0;
    const emAbertoC = toCents(quota.valor) - jaPagoC;
    if (emAbertoC <= 0) continue; // quota sem saldo real em aberto (confirmado)
    const aplicarC = Math.min(emAbertoC, restanteC);
    if (aplicarC > 0) {
      alocacoes.push({ quotaId: quota.id, jaPagoC, aplicarC, novoPagoC: jaPagoC + aplicarC });
      restanteC -= aplicarC;
    }
  }
  return { alocacoes, restanteC };
}

// Regista um pagamento e distribui-o pelas quotas em aberto (FIFO).
// Cria o movimento bancário de entrada quando há conta bancária.
// comprovativo (opcional): { ficheiro, nome, mime } — ficheiro já gravado em
// storage/comprovativos pelo upload; fica associado com estado 'pendente'.
// Devolve { pagamento, excedente } (excedente = valor não aplicado, crédito).
async function registarPagamento({
  fracaoId,
  valor,
  dataPagamento,
  metodoPagamentoId,
  contaBancariaId,
  referencia,
  observacoes,
  userId,
  comprovativo,
  condominioId,
}) {
  const t = await sequelize.transaction();
  try {
    const valorC = toCents(valor);
    const numero = await proximoNumero('recibo', { transaction: t });

    // Multi-condomínio: o pagamento herda o condomínio do contexto ativo da
    // rota; em fluxos legados cai para o condomínio da fração.
    let cid = condominioId || null;
    if (!cid) {
      const fracaoCtx = await Fracao.findOne({ where: { id: fracaoId }, attributes: ['condominio_id'] });
      cid = fracaoCtx ? fracaoCtx.condominio_id : null;
    }

    const pagamento = await Pagamento.create(
      {
        condominio_id: cid,
        numero_documento: numero,
        fracao_id: fracaoId,
        conta_bancaria_id: contaBancariaId || null,
        metodo_pagamento_id: metodoPagamentoId || null,
        valor: fromCents(valorC),
        data_pagamento: dataPagamento || new Date(),
        referencia,
        observacoes,
        estado: 'confirmado',
        ...(comprovativo
          ? {
              comprovativo_ficheiro: comprovativo.ficheiro,
              comprovativo_nome: comprovativo.nome,
              comprovativo_mime: comprovativo.mime,
              comprovativo_estado: 'pendente',
              comprovativo_motivo: null,
              comprovativo_data: new Date(),
            }
          : {}),
      },
      { transaction: t }
    );

    if (contaBancariaId) {
      await criarMovimento({
        contaBancariaId,
        data: dataPagamento || new Date(),
        tipo: 'entrada',
        valor: fromCents(valorC),
        descricao: `Pagamento ${numero}`,
        referencia,
        pagamentoId: pagamento.id,
        userId,
        transaction: t,
      });
    }

    // Todas as quotas da fração (não anuladas), por ordem cronológica — a
    // distribuição é FIFO sobre o SALDO REAL em aberto (confirmado), nunca
    // sobre o estado guardado (que pode estar desatualizado/artificial).
    const quotas = await Quota.findAll({
      where: { fracao_id: fracaoId, estado: { [Op.ne]: 'anulada' } },
      order: [['ano', 'ASC'], ['mes', 'ASC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!quotas.length) {
      await t.commit();
      return { pagamento, excedente: fromCents(valorC) };
    }

    // Valor efetivamente pago por quota — só aplicações de pagamentos
    // CONFIRMADOS (anulados mantêm-se no histórico mas nunca contam).
    const ids = quotas.map((q) => q.id);
    const aplicacoes = await PagamentoQuota.findAll({
      where: { quota_id: { [Op.in]: ids } },
      include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
      transaction: t,
    });
    const pagoConfirmadoC = somarAplicacoesConfirmadas(aplicacoes);

    const { alocacoes, restanteC } = alocarFIFO({ quotas, pagoConfirmadoC, valorC });
    for (const aloc of alocacoes) {
      await PagamentoQuota.create(
        {
          pagamento_id: pagamento.id,
          quota_id: aloc.quotaId,
          valor_aplicado: fromCents(aloc.aplicarC),
        },
        { transaction: t }
      );
      const quota = quotas.find((q) => q.id === aloc.quotaId);
      if (quota) {
        await quota.update(
          { estado: aloc.novoPagoC >= toCents(quota.valor) ? 'paga' : 'parcialmente_paga' },
          { transaction: t }
        );
      }
    }

    await t.commit();
    return { pagamento, excedente: fromCents(restanteC) };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// Anula um pagamento (mantém o número do documento) e recalcula as quotas afetadas.
// Anula também o movimento bancário de entrada associado.
async function anularPagamento(pagamentoId) {
  const t = await sequelize.transaction();
  try {
    const pagamento = await Pagamento.findByPk(pagamentoId, { transaction: t });
    if (!pagamento || pagamento.estado === 'anulado') {
      await t.rollback();
      return false;
    }
    await pagamento.update({ estado: 'anulado' }, { transaction: t });

    const movimento = await MovimentoBancario.findOne({
      where: { pagamento_id: pagamento.id, estado: 'confirmado' },
      transaction: t,
    });
    if (movimento) {
      await movimento.update({ estado: 'anulado' }, { transaction: t });
    }

    const aplicacoes = await PagamentoQuota.findAll({
      where: { pagamento_id: pagamento.id },
      transaction: t,
    });
    const quotaIds = [...new Set(aplicacoes.map((a) => a.quota_id))];
    for (const qid of quotaIds) {
      await recalcularEstadoQuota(qid, t);
    }

    // Quotas Extra: repõe as parcelas ao estado anterior do pagamento.
    const linksExtra = await PagamentoExtraParcela.findAll({
      where: { pagamento_id: pagamento.id },
      transaction: t,
    });
    for (const link of linksExtra) {
      await reporParcelaAposAnulacao(link.extra_quota_parcela_id, link.estado_anterior, t);
    }

    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ── Quotas Extra (parcelas) — pagamento real integrado ──────────────
// Repõe o estado de uma parcela após anulação do(s) pagamento(s): sem valor
// confirmado, volta ao estado anterior ('cobrada' se tinha sido incluída num
// aviso, senão 'pendente'); com o valor integral confirmado, mantém-se paga.
async function reporParcelaAposAnulacao(parcelaId, estadoAnterior, transaction) {
  const links = await PagamentoExtraParcela.findAll({
    where: { extra_quota_parcela_id: parcelaId },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'], required: true }],
    transaction,
  });
  const confirmadoC = links
    .filter((l) => l.pagamento && l.pagamento.estado === 'confirmado')
    .reduce((s, l) => s + toCents(l.valor_aplicado), 0);
  const parcela = await ExtraQuotaParcela.findByPk(parcelaId, { transaction });
  if (!parcela || parcela.estado === 'anulada') return;
  const valorC = toCents(parcela.valor);
  if (confirmadoC >= valorC) {
    await parcela.update({ estado: 'paga', valor_pago: parcela.valor }, { transaction });
    return;
  }
  // Pagamentos de parcelas são integralmente pagos; sem valor → repõe estado.
  const estado = estadoAnterior === 'cobrada' ? 'cobrada' : 'pendente';
  await parcela.update({ estado, valor_pago: 0 }, { transaction });
}

// Valor confirmado aplicado por parcela (PagamentoExtraParcela → Pagamento confirmado).
async function pagoParcela(parcelaIds, { transaction } = {}) {
  const mapa = new Map();
  if (!parcelaIds || !parcelaIds.length) return mapa;
  const aplicacoes = await PagamentoExtraParcela.findAll({
    where: { extra_quota_parcela_id: { [Op.in]: parcelaIds } },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'], required: true }],
    transaction,
    raw: true,
  });
  for (const a of aplicacoes) {
    if (!a['pagamento.estado'] || a['pagamento.estado'] !== 'confirmado') continue;
    mapa.set(a.extra_quota_parcela_id, (mapa.get(a.extra_quota_parcela_id) || 0) + toCents(a.valor_aplicado));
  }
  return mapa;
}

// Regista um Pagamento REAL para uma parcela de Quota Extra (integra no mesmo
// sistema de pagamentos das quotas: número, movimento e histórico). A parcela
// só pode ser paga quando a Quota Extra está 'processada' e a parcela
// 'pendente'/'cobrada' (nunca 'anulada' nem já 'paga').
async function registarPagamentoExtraParcela({
  parcelaId,
  dataPagamento,
  metodoPagamentoId,
  contaBancariaId,
  referencia,
  observacoes,
  userId,
  condominioId,
}) {
  const cid = Number(condominioId);
  if (!cid) throw new Error('condominioId é obrigatório para pagar uma parcela de quota extra.');

  const t = await sequelize.transaction();
  try {
    const parcela = await ExtraQuotaParcela.findByPk(parcelaId, {
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!parcela) throw new Error('Parcela não encontrada.');
    if (parcela.estado === 'anulada') throw new Error('Parcela anulada não pode ser paga.');
    if (parcela.estado === 'paga') throw new Error('Parcela já está paga.');

    // A parcela e a sua quota extra têm de pertencer ao condomínio ativo.
    const { ExtraQuota } = require('../models');
    const extra = await ExtraQuota.findOne({
      where: { id: parcela.extra_quota_id, condominio_id: cid },
      transaction: t,
    });
    if (!extra) throw new Error('Quota extra não encontrada neste condomínio.');
    if (extra.estado !== 'processada') {
      throw new Error('Quota extra ainda não está processada (pronta para cobrança).');
    }

    const numero = await proximoNumero('recibo', { transaction: t });
    const estadoAnterior = parcela.estado; // 'pendente' | 'cobrada'
    const pagamento = await Pagamento.create(
      {
        condominio_id: cid,
        numero_documento: numero,
        fracao_id: parcela.fracao_id,
        conta_bancaria_id: contaBancariaId || null,
        metodo_pagamento_id: metodoPagamentoId || null,
        valor: parcela.valor,
        data_pagamento: dataPagamento || new Date(),
        referencia,
        observacoes,
        estado: 'confirmado',
      },
      { transaction: t }
    );

    if (contaBancariaId) {
      await criarMovimento({
        contaBancariaId,
        data: dataPagamento || new Date(),
        tipo: 'entrada',
        valor: parcela.valor,
        descricao: `Quota extra "${extra.designacao}" — parcela ${parcela.parcela_numero}`,
        referencia: referencia || `QE-${extra.id}`,
        pagamentoId: pagamento.id,
        userId,
        transaction: t,
      });
    }

    await PagamentoExtraParcela.create(
      {
        pagamento_id: pagamento.id,
        extra_quota_parcela_id: parcela.id,
        valor_aplicado: parcela.valor,
        estado_anterior: estadoAnterior,
      },
      { transaction: t }
    );
    await parcela.update({ estado: 'paga', valor_pago: parcela.valor }, { transaction: t });

    await t.commit();
    return { pagamento, parcela };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ── Pagamento COMBINADO (quota normal + uma ou várias Quotas Extra) ──
// Regista UM único Pagamento que liquida as obrigações selecionadas da mesma
// fração: quotas normais (PagamentoQuota) e parcelas de Quotas Extra
// (PagamentoExtraParcela). Reutiliza o modelo Pagamento/movimento existentes.
// Regras:
//  · quotas e parcelas têm de pertencer ao condomínio ativo e à fração;
//  · quotas não anuladas; parcelas 'pendente'/'cobrada' de extra 'processada';
//  · parcelas já pagas/anuladas ou extra não processada → erro (nunca duplica);
//  · uma parcela só é paga por inteiro; o remanescente fica como excedente
//    (crédito), tal como no fluxo normal das quotas.
async function registarPagamentoComItens({
  fracaoId,
  valor,
  quotaIds = [],
  parcelaIds = [],
  dataPagamento,
  metodoPagamentoId,
  contaBancariaId,
  referencia,
  observacoes,
  userId,
  comprovativo,
  condominioId,
}) {
  const cid = Number(condominioId);
  if (!cid) throw new Error('condominioId é obrigatório para registar pagamentos.');
  const quotaSelecionadas = [...new Set((quotaIds || []).map(Number).filter(Boolean))];
  const parcelaSelecionadas = [...new Set((parcelaIds || []).map(Number).filter(Boolean))];
  if (!quotaSelecionadas.length && !parcelaSelecionadas.length) {
    return registarPagamento({
      fracaoId,
      valor,
      dataPagamento,
      metodoPagamentoId,
      contaBancariaId,
      referencia,
      observacoes,
      userId,
      comprovativo,
      condominioId,
    });
  }

  const t = await sequelize.transaction();
  try {
    const valorC = toCents(valor);
    const numero = await proximoNumero('recibo', { transaction: t });

    let cidFinal = cid;
    if (!cidFinal) {
      const fracaoCtx = await Fracao.findOne({ where: { id: fracaoId }, attributes: ['condominio_id'] }, { transaction: t });
      cidFinal = fracaoCtx ? fracaoCtx.condominio_id : null;
    }

    const pagamento = await Pagamento.create(
      {
        condominio_id: cidFinal,
        numero_documento: numero,
        fracao_id: fracaoId,
        conta_bancaria_id: contaBancariaId || null,
        metodo_pagamento_id: metodoPagamentoId || null,
        valor: fromCents(valorC),
        data_pagamento: dataPagamento || new Date(),
        referencia,
        observacoes,
        estado: 'confirmado',
        ...(comprovativo
          ? {
              comprovativo_ficheiro: comprovativo.ficheiro,
              comprovativo_nome: comprovativo.nome,
              comprovativo_mime: comprovativo.mime,
              comprovativo_estado: 'pendente',
              comprovativo_motivo: null,
              comprovativo_data: new Date(),
            }
          : {}),
      },
      { transaction: t }
    );

    if (contaBancariaId) {
      await criarMovimento({
        contaBancariaId,
        data: dataPagamento || new Date(),
        tipo: 'entrada',
        valor: fromCents(valorC),
        descricao: `Pagamento ${numero}`,
        referencia,
        pagamentoId: pagamento.id,
        userId,
        transaction: t,
      });
    }

    // Quotas selecionadas (mesma fração/condomínio, não anuladas).
    const quotas = quotaSelecionadas.length
      ? await Quota.findAll({
          where: { id: { [Op.in]: quotaSelecionadas }, fracao_id: fracaoId, condominio_id: cid, estado: { [Op.ne]: 'anulada' } },
          order: [['ano', 'ASC'], ['mes', 'ASC']],
          lock: t.LOCK.UPDATE,
          transaction: t,
        })
      : [];
    if (quotas.length !== quotaSelecionadas.length) throw new Error('Uma das quotas selecionadas não pertence a esta fração/condomínio.');

    // Parcelas selecionadas (mesma fração; extra processada; pendente/cobrada).
    const { ExtraQuota } = require('../models');
    const parcelas = parcelaSelecionadas.length
      ? await ExtraQuotaParcela.findAll({
          where: { id: { [Op.in]: parcelaSelecionadas }, fracao_id: fracaoId, estado: { [Op.in]: ['pendente', 'cobrada'] } },
          include: [
            {
              model: ExtraQuota,
              as: 'extra_quota',
              attributes: ['id', 'designacao', 'estado', 'condominio_id'],
              where: { condominio_id: cid, estado: 'processada' },
              required: true,
            },
          ],
          order: [['data_vencimento', 'ASC'], ['id', 'ASC']],
          lock: t.LOCK.UPDATE,
          transaction: t,
        })
      : [];
    if (parcelas.length !== parcelaSelecionadas.length) {
      throw new Error('Uma das parcelas selecionadas não está disponível (pagas/anuladas ou quota extra não processada).');
    }

    let restanteC = valorC;

    // 1) Quotas: aplica FIFO sobre o saldo real em aberto (confirmado).
    const idsQuotas = quotas.map((q) => q.id);
    const aplicacoes = idsQuotas.length
      ? await PagamentoQuota.findAll({
          where: { quota_id: { [Op.in]: idsQuotas } },
          include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
          transaction: t,
        })
      : [];
    const pagoConfirmadoC = somarAplicacoesConfirmadas(aplicacoes);
    for (const quota of quotas) {
      if (restanteC <= 0) break;
      const jaPagoC = pagoConfirmadoC.get(quota.id) || 0;
      const emAbertoC = toCents(quota.valor) - jaPagoC;
      if (emAbertoC <= 0) continue;
      const aplicarC = Math.min(emAbertoC, restanteC);
      if (aplicarC <= 0) continue;
      await PagamentoQuota.create(
        { pagamento_id: pagamento.id, quota_id: quota.id, valor_aplicado: fromCents(aplicarC) },
        { transaction: t }
      );
      await quota.update(
        { estado: jaPagoC + aplicarC >= toCents(quota.valor) ? 'paga' : 'parcialmente_paga' },
        { transaction: t }
      );
      restanteC -= aplicarC;
    }

    // 2) Parcelas extra: só por inteiro (sem pagamentos parciais de parcela).
    const jaPagasMap = await pagoParcela(parcelas.map((p) => p.id), { transaction: t });
    for (const parcela of parcelas) {
      if (restanteC <= 0) break;
      const emAbertoC = toCents(parcela.valor) - (jaPagasMap.get(parcela.id) || 0);
      if (emAbertoC > restanteC) continue; // não dá para pagar por inteiro → excedente
      const aplicarC = emAbertoC;
      await PagamentoExtraParcela.create(
        {
          pagamento_id: pagamento.id,
          extra_quota_parcela_id: parcela.id,
          valor_aplicado: fromCents(aplicarC),
          estado_anterior: parcela.estado,
        },
        { transaction: t }
      );
      await parcela.update({ estado: 'paga', valor_pago: parcela.valor }, { transaction: t });
      restanteC -= aplicarC;
    }

    await t.commit();
    return { pagamento, excedente: fromCents(restanteC), quotasAplicadas: quotas.length, parcelasAplicadas: parcelas.length };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = {
  registarPagamento,
  registarPagamentoComItens,
  anularPagamento,
  recalcularEstadoQuota,
  alocarFIFO,
  somarAplicacoesConfirmadas,
  registarPagamentoExtraParcela,
  pagoParcela,
  reporParcelaAposAnulacao,
};
