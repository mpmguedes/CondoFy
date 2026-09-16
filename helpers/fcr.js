// Fundo Comum de Reserva (FCR) — receção e transferência entre contas.
//
// Ciclo coberto por este módulo:
//   quota com FCR → pagamento → FCR recebido → transferência para a conta FCR
//
// Distinções que este helper NUNCA confunde (nem soma):
//   · FCR EMITIDO   — FCR incluído nas quotas lançadas (Quota.valor_fcr);
//   · FCR RECEBIDO  — FCR da parte de cada quota que foi efetivamente paga
//                     (aplicações de pagamentos CONFIRMADOS, PagamentoQuota);
//   · FCR TRANSFERIDO — transferências já registadas de conta corrente para a
//                     conta do tipo `fundo_reserva` (par saída/entrada com
//                     referencia 'TRANSF');
//   · FCR DISPONÍVEL — recebido − transferido (o que ainda pode ser transferido).
//
// NÃO é dinheiro recebido: `ReciboQuota.valor_fcr` (FCR faturado) e
// `SUM(Quota.valor_fcr)` (FCR emitido). Só as aplicações de pagamentos
// confirmados provam entrada de dinheiro.
//
// A parcela de FCR de um pagamento parcial é PROPORCIONAL à parte da quota que
// foi paga: o FCR de uma quota é sempre `valor_fcr / valor × valor_pago`. É
// aritmética determinística sobre valores históricos e imutáveis da quota
// (`valor` e `valor_fcr` nunca são reescritos depois de emitida), pelo que
// NÃO é preciso inventar uma associação pagamento↔FCR nem alterar o modelo.
//
// Todas as consultas são filtradas pelo condomínio: as quotas e os pagamentos
// têm `condominio_id`; as transferências não têm (os movimentos bancários não
// têm `condominio_id`), pelo que são filtradas pela conta bancária do
// condomínio — a mesma convenção usada em helpers/relatorio-financeiro.js.
const { Op } = require('sequelize');
const {
  ContaBancaria,
  MovimentoBancario,
  Pagamento,
  PagamentoQuota,
  Quota,
} = require('../models');
const { toCents, fromCents } = require('./money');
const { registarTransferencia, saldoContaMovimentos } = require('./movimentos');
const { carregarDeliberacao, valorUtilizadoDeliberacaoC, ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO } = require('./fcr-deliberacoes');

// Referência que identifica uma transferência entre contas (os dois movimentos
// — saída na origem e entrada no destino — partilham este valor).
const REF_TRANSFERENCIA = 'TRANSF';

// ── Regra pura: parcela de FCR de uma aplicação de pagamento ───────
// `valorAplicadoC` = parte da quota efetivamente paga (PagamentoQuota).
// `valorQuotaC`/`fcrQuotaC` = componentes guardados na quota (imutáveis).
// Devolve a parcela em cêntimos, arredondada ao cêntimo (nunca superior ao FCR
// da quota).
function fcrDaAplicacaoC({ valorAplicadoC, valorQuotaC, fcrQuotaC }) {
  const aplicado = Math.max(0, Math.round(Number(valorAplicadoC) || 0));
  const total = Math.round(Number(valorQuotaC) || 0);
  const fcr = Math.max(0, Math.round(Number(fcrQuotaC) || 0));
  if (aplicado <= 0 || total <= 0 || fcr <= 0) return 0;
  // Dois limites, pela ordem mais restritiva: a parcela de FCR da quota e o que
  // foi efetivamente pago (a parcela de FCR nunca pode exceder o dinheiro que
  // entrou, mesmo que a quota tenha componentes inconsistentes).
  return Math.min(fcr, aplicado, Math.round((fcr * aplicado) / total));
}

// ── Regra pura: FCR recebido a partir das aplicações confirmadas ───
// `aplicacoes`: [{ quota_id, valor_aplicado }] de pagamentos CONFIRMADOS, já
// restringidas ao condomínio. `quotasPorId`: Map/objeto id → { valor, valor_fcr }.
// Devolve { totalC, porQuotaC: Map<quotaId, cents>, detalhe: [...] }.
function calcularFcrRecebidoC({ aplicacoes = [], quotasPorId = new Map() } = {}) {
  const obter = (id) => (quotasPorId instanceof Map ? quotasPorId.get(Number(id)) : quotasPorId[Number(id)]);
  const porQuotaC = new Map();
  const detalhe = [];
  let totalC = 0;
  for (const a of aplicacoes) {
    const quota = obter(a.quota_id);
    if (!quota) continue;
    const valorAplicadoC = toCents(a.valor_aplicado);
    const fcrC = fcrDaAplicacaoC({
      valorAplicadoC,
      valorQuotaC: toCents(quota.valor),
      fcrQuotaC: toCents(quota.valor_fcr),
    });
    if (fcrC <= 0) continue;
    const quotaId = Number(a.quota_id);
    porQuotaC.set(quotaId, (porQuotaC.get(quotaId) || 0) + fcrC);
    totalC += fcrC;
    detalhe.push({ quotaId, valorAplicadoC, fcrC });
  }
  return { totalC, porQuotaC, detalhe };
}

// ── FCR emitido (informativo): FCR das quotas lançadas do condomínio ──
async function fcrEmitidoC(condominioId, { transaction } = {}) {
  const total = await Quota.sum('valor_fcr', {
    where: { condominio_id: condominioId, estado: { [Op.ne]: 'anulada' } },
    transaction,
  });
  return toCents(total);
}

// ── FCR transferido: transferências já registadas da corrente para o fundo ──
// Só conta o que foi EFETIVAMENTE transferido PARA o fundo: entradas na conta do
// tipo `fundo_reserva` cujo par seja uma saída de OUTRA conta do condomínio e
// que NÃO seja uma utilização (uma utilização tem `deliberacao_id` e tem a
// entrada na conta corrente, não no fundo).
//
// Erro que isto corrige: contar qualquer entrada no fundo somava também a
// ponta de entrada das UTILIZAÇÕES feitas para a conta corrente, o que inflava o
// "transferido" e esgotava o "disponível" — a seguir, uma nova transferência
// corrente → FCR era recusada com «o valor excede o FCR recebido e ainda não
// transferido».
//
// A contagem é feita pelas entradas no fundo (a conta de destino identifica
// inequivocamente a operação), com a saída correspondente marcada como
// consumida para nunca contar o mesmo dinheiro duas vezes — inclusive em dados
// antigos gravados apenas com `referencia: 'TRANSF'`.
async function fcrTransferidoC(condominioId, { transaction, incluirDetalhe = false } = {}) {
  const contas = await ContaBancaria.findAll({
    where: { condominio_id: condominioId },
    attributes: ['id', 'nome', 'tipo'],
    transaction,
  });
  const contasPorId = new Map(contas.map((c) => [Number(c.id), c]));
  const fundoIds = contas.filter((c) => c.tipo === 'fundo_reserva').map((c) => Number(c.id));

  const movimentos = await MovimentoBancario.findAll({
    where: {
      referencia: REF_TRANSFERENCIA,
      estado: 'confirmado',
      // O condomínio do movimento é lido da coluna nova quando existe (escritas
      // a partir da migração 20260101000074) e, no histórico anterior, continua
      // a ser lido pela conta — a mesma regra do resto do projeto.
      [Op.or]: [{ condominio_id: null }, { condominio_id: condominioId }],
    },
    attributes: ['id', 'conta_bancaria_id', 'data', 'tipo', 'valor', 'descricao', 'deliberacao_id'],
    include: [{ model: ContaBancaria, as: 'conta_bancaria', attributes: ['id', 'condominio_id', 'nome', 'tipo'], where: { condominio_id: condominioId }, required: true }],
    order: [['data', 'ASC'], ['id', 'ASC']],
    transaction,
  });

  const dataISO = (m) => String(m.data || '').slice(0, 10);
  const entradas = movimentos.filter((m) => m.tipo === 'entrada');
  const saidas = movimentos.filter((m) => m.tipo === 'saida');
  const saidasUsadas = new Set();

  const transferencias = [];
  for (const entrada of entradas) {
    const candidatas = saidas.filter(
      (s) => !saidasUsadas.has(s.id)
        && toCents(s.valor) === toCents(entrada.valor)
        && dataISO(s) === dataISO(entrada)
    );
    // Prefere a saída de OUTRA conta (a origem real da transferência).
    const par = candidatas.find((s) => Number(s.conta_bancaria_id) !== Number(entrada.conta_bancaria_id)) || candidatas[0] || null;
    if (par) saidasUsadas.add(par.id);

    const noFundo = fundoIds.includes(Number(entrada.conta_bancaria_id));
    const origemFora = par && !fundoIds.includes(Number(par.conta_bancaria_id));
    // Utilização do FCR (fundo → corrente) não é reforço do fundo e não entra
    // aqui: o `deliberacao_id` identifica-a em qualquer das pontas do par.
    const ehUtilizacao = Boolean(entrada.deliberacao_id)
      || Boolean(par && par.deliberacao_id);

    if (!par) {
      // Entrada antiga/solta no fundo (sem par identificável): é dinheiro que
      // entrou no fundo e não foi movimentado por nós — conta como transferido.
      if (noFundo && !ehUtilizacao) {
        transferencias.push({
          id: entrada.id, data: entrada.data, valorC: toCents(entrada.valor),
          descricao: entrada.descricao, origem: null, contaOrigemId: null,
          destino: entrada.conta_bancaria ? entrada.conta_bancaria.nome : null,
          contaDestinoId: Number(entrada.conta_bancaria_id), registada: true,
        });
      }
      continue;
    }

    if (!noFundo) continue; // a ponta de entrada não é no fundo → não é reforço do fundo
    if (ehUtilizacao) continue; // fundo → corrente: utilização, não reforço
    if (fundoIds.includes(Number(par.conta_bancaria_id))) continue; // fundo → fundo
    if (!origemFora) continue;

    const origem = contasPorId.get(Number(par.conta_bancaria_id));
    transferencias.push({
      id: entrada.id,
      data: entrada.data,
      valorC: toCents(entrada.valor),
      descricao: entrada.descricao,
      origem: origem ? origem.nome : null,
      contaOrigemId: Number(par.conta_bancaria_id),
      destino: entrada.conta_bancaria ? entrada.conta_bancaria.nome : null,
      contaDestinoId: Number(entrada.conta_bancaria_id),
      registada: true,
    });
  }

  const totalC = transferencias.reduce((s, t) => s + t.valorC, 0);
  // `valor` em euros para as vistas (as vistas formatam com o helper `eur`).
  const comVista = (t) => ({ ...t, valor: fromCents(t.valorC) });
  const ordenadas = transferencias.map(comVista).sort((a, b) => String(b.data).localeCompare(String(a.data)) || b.id - a.id);
  if (!incluirDetalhe) return { totalC, contasFcr: fundoIds, nTransferencias: transferencias.length };
  return { totalC, contasFcr: fundoIds, nTransferencias: transferencias.length, transferencias: ordenadas };
}

// ── FCR recebido: aplicações de pagamentos CONFIRMADOS do condomínio ──
// O isolamento vem da QUOTA (todas as quotas carregadas acima são do
// condomínio). O `include` do pagamento exige apenas que esteja confirmado e,
// quando o pagamento tem condomínio preenchido, que seja o mesmo: pagamentos
// anteriores à existência de `pagamentos.condominio_id` ficam a NULL e continuam
// a valer (o dinheiro entrou). Exigir igualdade exata aqui excluía-os e fazia o
// FCR recebido sair a zero — era o que impedia a transferência corrente → FCR.
async function fcrRecebidoC(condominioId, { transaction } = {}) {
  const quotas = await Quota.findAll({
    where: { condominio_id: condominioId },
    attributes: ['id', 'valor', 'valor_fcr'],
    transaction,
  });
  if (!quotas.length) return { totalC: 0, porQuotaC: new Map(), detalhe: [], nQuotas: 0 };
  const quotasPorId = new Map(quotas.map((q) => [Number(q.id), { valor: q.valor, valor_fcr: q.valor_fcr }]));
  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: { [Op.in]: [...quotasPorId.keys()] } },
    attributes: ['quota_id', 'valor_aplicado'],
    include: [{
      model: Pagamento,
      as: 'pagamento',
      attributes: ['id', 'estado', 'condominio_id'],
      where: {
        estado: 'confirmado',
        // NULL = registo anterior à coluna; o vínculo ao condomínio é garantido
        // pela quota (que já foi filtrada por condominio_id acima).
        [Op.or]: [{ condominio_id: null }, { condominio_id: condominioId }],
      },
      required: true,
    }],
    transaction,
  });
  const calculado = calcularFcrRecebidoC({ aplicacoes, quotasPorId });
  return { ...calculado, nQuotas: quotas.length, nAplicacoes: aplicacoes.length };
}

// ── Resumo completo do ciclo do FCR (alimenta a interface) ─────────
// Devolve sempre: emitidoC / recebidoC / transferidoC / disponivelC. Nada aqui
// inventa valores: cada parcela vem de um pagamento confirmado ou de uma
// transferência registada.
async function resumoFcr(condominioId, { transaction, incluirDetalhe = false } = {}) {
  const [emitidoC, recebido, transferido] = await Promise.all([
    fcrEmitidoC(condominioId, { transaction }),
    fcrRecebidoC(condominioId, { transaction }),
    fcrTransferidoC(condominioId, { transaction, incluirDetalhe }),
  ]);
  const disponivelC = Math.max(0, recebido.totalC - transferido.totalC);
  return {
    emitidoC,
    recebidoC: recebido.totalC,
    transferidoC: transferido.totalC,
    disponivelC,
    emitido: fromCents(emitidoC),
    recebido: fromCents(recebido.totalC),
    transferido: fromCents(transferido.totalC),
    disponivel: fromCents(disponivelC),
    nTransferencias: transferido.nTransferencias,
    transferencias: transferido.transferencias || [],
    contasFcrIds: transferido.contasFcr,
    porQuotaC: recebido.porQuotaC,
  };
}

// ── Validação da transferência (pura, sem BD) ──────────────────────
// `sentido`:
//   · 'corrente_para_fcr' (por omissão, retrocompatível) — entrada de dinheiro
//     no fundo: destino tem de ser conta do tipo fundo_reserva e o valor não
//     pode exceder o FCR recebido e ainda não transferido;
//   · 'fcr_para_corrente' — utilização do fundo: origem tem de ser conta do
//     tipo fundo_reserva, destino não pode ser do fundo e o valor não pode
//     exceder o saldo atual da conta FCR nem o limite autorizado (deliberação)
//     quando existir.
// Ordem: contas → direção → valor positivo → limite autorizado → saldo
// disponível na origem. Devolve sempre { ok } ou { ok:false, motivo, mensagem }.
function validarTransferenciaFcr({
  contaOrigem,
  contaDestino,
  valorC,
  sentido = 'corrente_para_fcr',
  disponivelC = 0,
  saldoOrigemC = null,
  limiteAutorizadoC = null,
  limiteRotulo = 'valor aprovado ainda disponível',
}) {
  if (!contaOrigem || !contaDestino) {
    return { ok: false, motivo: 'conta_invalida', mensagem: 'Selecione a conta de origem e a conta de destino.' };
  }
  if (Number(contaOrigem.id) === Number(contaDestino.id)) {
    return { ok: false, motivo: 'contas_iguais', mensagem: 'A conta de origem e a conta de destino não podem ser a mesma.' };
  }
  if (sentido === 'fcr_para_corrente') {
    if (contaOrigem.tipo !== 'fundo_reserva') {
      return { ok: false, motivo: 'origem_nao_fcr', mensagem: 'Para utilizar o Fundo de Reserva, a conta de origem tem de ser uma conta do tipo Fundo de Reserva.' };
    }
    if (contaDestino.tipo === 'fundo_reserva') {
      return { ok: false, motivo: 'destino_fcr', mensagem: 'A conta de destino não pode ser uma conta do tipo Fundo de Reserva.' };
    }
  } else if (contaDestino.tipo !== 'fundo_reserva') {
    return { ok: false, motivo: 'destino_nao_fcr', mensagem: 'A conta de destino tem de ser uma conta do tipo Fundo de Reserva.' };
  }
  const valor = Math.round(Number(valorC) || 0);
  if (valor <= 0) {
    return { ok: false, motivo: 'valor_invalido', mensagem: 'Indique um valor positivo para transferir.' };
  }
  if (limiteAutorizadoC !== null && valor > limiteAutorizadoC) {
    return {
      ok: false,
      motivo: 'acima_do_aprovado',
      valorC: valor,
      limiteAutorizadoC,
      mensagem: `O valor excede o ${limiteRotulo} (${fromCents(limiteAutorizadoC).toFixed(2).replace('.', ',')} €).`,
    };
  }
  if (valor > disponivelC) {
    return {
      ok: false,
      motivo: sentido === 'fcr_para_corrente' ? 'saldo_fcr_insuficiente' : 'acima_do_disponivel',
      valorC: valor,
      disponivelC,
      mensagem: sentido === 'fcr_para_corrente'
        ? `O valor excede o saldo atual da conta do Fundo de Reserva (${fromCents(disponivelC).toFixed(2).replace('.', ',')} €).`
        : `O valor excede o FCR recebido e ainda não transferido (${fromCents(disponivelC).toFixed(2).replace('.', ',')} €).`,
    };
  }
  if (saldoOrigemC !== null && valor > saldoOrigemC) {
    return {
      ok: false,
      motivo: 'saldo_origem_insuficiente',
      valorC: valor,
      saldoOrigemC,
      mensagem: 'O valor excede o saldo disponível na conta de origem.',
    };
  }
  return { ok: true, valorC: valor };
}

// ── Transferência corrente → conta FCR (operação atómica) ──────────
// Cria os dois movimentos (saída na origem, entrada no destino) na MESMA
// transação e valida tudo antes de escrever: contas do condomínio, destino
// fundo_reserva, origem ≠ destino, valor positivo e valor ≤ FCR disponível.
// Devolve { saidaId, entradaId, valorC, disponivelC }.
async function transferirFcr({ condominioId, contaOrigemId, contaDestinoId, valorC, data, descricao, userId }) {
  const t = await sequelizeTransaction();
  try {
    const [contaOrigem, contaDestino] = await Promise.all([
      ContaBancaria.findOne({ where: { id: contaOrigemId, condominio_id: condominioId }, transaction: t }),
      ContaBancaria.findOne({ where: { id: contaDestinoId, condominio_id: condominioId }, transaction: t }),
    ]);
    const { totalC: recebidoC } = await fcrRecebidoC(condominioId, { transaction: t });
    const { totalC: transferidoC } = await fcrTransferidoC(condominioId, { transaction: t });
    const disponivelC = Math.max(0, recebidoC - transferidoC);
    // O valor também não pode exceder o que existe na conta de origem (a
    // transferência não pode deixar a conta de origem a descoberto).
    const saldoOrigemC = contaOrigem ? toCents(await saldoContaMovimentos(contaOrigem, { transaction: t })) : 0;

    const decisao = validarTransferenciaFcr({ contaOrigem, contaDestino, valorC, disponivelC, saldoOrigemC });
    if (!decisao.ok) {
      await t.rollback();
      return decisao;
    }

    const ida = await registarTransferencia({
      contaOrigemId: contaOrigem.id,
      contaDestinoId: contaDestino.id,
      valor: fromCents(decisao.valorC),
      data: data || new Date(),
      descricao: descricao || `Transferência de Fundo de Reserva: ${contaOrigem.nome} → ${contaDestino.nome}`,
      userId,
      condominioId,
      transaction: t,
    });
    await t.commit();
    return {
      ok: true,
      valorC: decisao.valorC,
      disponivelC: Math.max(0, disponivelC - decisao.valorC),
      saidaId: ida.saidaId,
      entradaId: ida.entradaId,
      contaOrigem: contaOrigem.nome,
      contaDestino: contaDestino.nome,
    };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ── Utilização do FCR: fundo_reserva → conta corrente (atómica) ────
// Só com deliberação de assembleia APROVADA e dentro do valor ainda disponível
// dessa deliberação. A cadeia completa é validada antes de escrever:
//   deliberação → agenda_item → assembleia → condomínio  (carregarDeliberacao)
//   movimento   → conta → condomínio                     (ContaBancaria.findOne)
// Nenhum id do formulário é aceite sem esta verificação.
//
// Os dois movimentos (saída da conta FCR e entrada na conta corrente) ficam com
// `deliberacao_id` e `referencia = 'TRANSF'`: é uma transferência entre contas,
// nunca receita nem despesa. Tudo na MESMA transação — qualquer falha deixa a
// base exatamente como estava.
//
// Devolve { saidaId, entradaId, valorC, disponivelAprovadoC, … } ou
// { ok:false, motivo, mensagem }.
async function transferirFcrAprovado({
  condominioId,
  deliberacaoId,
  contaOrigemId,
  contaDestinoId,
  valorC,
  data,
  descricao,
  userId,
}) {
  const t = await sequelizeTransaction();
  try {
    // 1) Deliberação (a cadeia até ao condomínio é validada na consulta).
    const item = await carregarDeliberacao({ deliberacaoId, condominioId, transaction: t });
    if (!item) {
      await t.rollback();
      return {
        ok: false,
        motivo: deliberacaoId ? 'deliberacao_invalida' : 'deliberacao_obrigatoria',
        mensagem: deliberacaoId
          ? 'A deliberação indicada não existe neste condomínio.'
          : 'Escolha a deliberação que autoriza a utilização do Fundo de Reserva.',
      };
    }
    if (item.deliberacao_estado !== 'aprovada') {
      await t.rollback();
      return {
        ok: false,
        motivo: 'deliberacao_nao_aprovada',
        mensagem: 'Só uma deliberação aprovada autoriza a utilização do Fundo de Reserva.',
      };
    }
    const assembleia = item.assembleia;
    if (!assembleia || ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO.includes(assembleia.estado)) {
      await t.rollback();
      return {
        ok: false,
        motivo: 'assembleia_nao_delibera',
        mensagem: 'A assembleia desta deliberação não autoriza utilização do Fundo de Reserva.',
      };
    }
    const valorAprovadoC = toCents(item.valor_aprovado);
    if (valorAprovadoC <= 0) {
      await t.rollback();
      return { ok: false, motivo: 'sem_valor_aprovado', mensagem: 'A deliberação não tem valor aprovado.' };
    }

    // 2) Contas do condomínio ativo (nunca ids do formulário sem verificação).
    const [contaOrigem, contaDestino] = await Promise.all([
      ContaBancaria.findOne({ where: { id: contaOrigemId, condominio_id: condominioId }, transaction: t }),
      ContaBancaria.findOne({ where: { id: contaDestinoId, condominio_id: condominioId }, transaction: t }),
    ]);

    // 3) Limites: valor aprovado ainda disponível e saldo real da conta FCR.
    const utilizadoC = await valorUtilizadoDeliberacaoC(item.id, { condominioId, transaction: t });
    const disponivelAprovadoC = Math.max(0, valorAprovadoC - utilizadoC);
    const saldoOrigemC = contaOrigem ? toCents(await saldoContaMovimentos(contaOrigem, { transaction: t })) : 0;

    const decisao = validarTransferenciaFcr({
      contaOrigem,
      contaDestino,
      valorC,
      sentido: 'fcr_para_corrente',
      disponivelC: saldoOrigemC,
      limiteAutorizadoC: disponivelAprovadoC,
      limiteRotulo: 'valor aprovado ainda disponível nesta deliberação',
    });
    if (!decisao.ok) {
      await t.rollback();
      return { ...decisao, disponivelAprovadoC };
    }

    // 4) Os dois movimentos, com o mesmo valor, na mesma transação.
    const ida = await registarTransferencia({
      contaOrigemId: contaOrigem.id,
      contaDestinoId: contaDestino.id,
      valor: fromCents(decisao.valorC),
      data: data || new Date(),
      descricao: descricao || `Utilização do Fundo de Reserva (${assembleia.numero || 'assembleia'}): ${contaOrigem.nome} → ${contaDestino.nome}`,
      userId,
      condominioId,
      deliberacaoId: item.id,
      transaction: t,
    });
    await t.commit();
    return {
      ok: true,
      valorC: decisao.valorC,
      saidaId: ida.saidaId,
      entradaId: ida.entradaId,
      deliberacaoId: item.id,
      assembleiaId: assembleia.id,
      assembleiaNumero: assembleia.numero || null,
      descricaoPonto: item.descricao,
      contaOrigem: contaOrigem.nome,
      contaDestino: contaDestino.nome,
      valorAprovadoC,
      utilizadoC: utilizadoC + decisao.valorC,
      disponivelAprovadoC: Math.max(0, disponivelAprovadoC - decisao.valorC),
    };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// A transação vive em config/database; mantida numa função para os testes
// poderem injetar um duplo sem tocar no resto do módulo.
function sequelizeTransaction() {
  return require('../config/database').transaction();
}

module.exports = {
  REF_TRANSFERENCIA,
  fcrDaAplicacaoC,
  calcularFcrRecebidoC,
  validarTransferenciaFcr,
  fcrEmitidoC,
  fcrRecebidoC,
  fcrTransferidoC,
  resumoFcr,
  transferirFcr,
  transferirFcrAprovado,
};
