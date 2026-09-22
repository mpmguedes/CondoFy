const sequelize = require('../config/database');
const { MovimentoBancario } = require('../models');
const { toCents, fromCents } = require('./money');

// Cria um movimento bancário. `valor` é sempre positivo; o tipo indica o sentido.
// `condominioId` e `deliberacaoId` são opcionais: o primeiro identifica o
// condomínio do movimento (os registos antigos ficam com NULL e continuam a ser
// lidos pela conta) e o segundo liga a utilização do FCR à deliberação que a
// autorizou.
async function criarMovimento({
  contaBancariaId,
  condominioId,
  data,
  tipo,
  valor,
  descricao,
  referencia,
  categoriaId,
  quotaId,
  pagamentoId,
  despesaId,
  extraQuotaParcelaId,
  documentoId,
  deliberacaoId,
  observacoes,
  userId,
  transaction,
}) {
  return MovimentoBancario.create(
    {
      conta_bancaria_id: contaBancariaId,
      condominio_id: condominioId || null,
      data: data || new Date(),
      tipo,
      valor: fromCents(toCents(valor)),
      descricao: descricao || null,
      referencia: referencia || null,
      categoria_id: categoriaId || null,
      quota_id: quotaId || null,
      pagamento_id: pagamentoId || null,
      despesa_id: despesaId || null,
      extra_quota_parcela_id: extraQuotaParcelaId || null,
      documento_id: documentoId || null,
      deliberacao_id: deliberacaoId || null,
      observacoes: observacoes || null,
      created_by: userId || null,
      estado: 'confirmado',
    },
    { transaction }
  );
}

// Transferência entre contas: cria dois movimentos (saída na origem, entrada no
// destino) na MESMA transação.
//
// Os dois movimentos são gravados como `saida`/`entrada` com
// `referencia: 'TRANSF'` — é o que faz o saldo de cada conta ficar correto
// (débito na origem, crédito no destino) e, ao mesmo tempo, mantém a operação
// fora de receitas/despesas: o relatório financeiro identifica as
// transferências pela referencia 'TRANSF' (ou pelo tipo próprio) e nunca as
// conta como receita nem como despesa.
//
// (O valor 'transferencia' do ENUM `tipo` continua a ser reconhecido nas
// leituras, para qualquer movimento antigo gravado assim, mas não é usado aqui:
// sem uma direção explícita não seria possível debitar/creditar corretamente.)
//
// `transaction` opcional: quando quem chama já abriu uma transação (ex.: a
// transferência do Fundo de Reserva, que valida o FCR disponível antes de
// escrever), os dois movimentos entram nessa transação e o commit/rollback é
// responsabilidade de quem a abriu — garantindo atomicidade no conjunto todo.
//
// `condominioId` e `deliberacaoId` são gravados nos dois movimentos do par: o
// primeiro identifica o condomínio, o segundo liga a utilização do FCR à
// deliberação que a autorizou (nulo nas transferências operacionais).
async function registarTransferencia({
  contaOrigemId,
  contaDestinoId,
  valor,
  data,
  descricao,
  userId,
  condominioId,
  deliberacaoId,
  transaction,
}) {
  const t = transaction || (await sequelize.transaction());
  const propria = !transaction;
  try {
    const rotulo = descricao || 'Transferência entre contas';
    const saida = await criarMovimento({
      contaBancariaId: contaOrigemId,
      condominioId,
      data,
      tipo: 'saida',
      valor,
      descricao: rotulo,
      referencia: 'TRANSF',
      deliberacaoId,
      userId,
      transaction: t,
    });
    const entrada = await criarMovimento({
      contaBancariaId: contaDestinoId,
      condominioId,
      data,
      tipo: 'entrada',
      valor,
      descricao: rotulo,
      referencia: 'TRANSF',
      deliberacaoId,
      userId,
      transaction: t,
    });
    if (propria) await t.commit();
    return { saidaId: saida.id, entradaId: entrada.id };
  } catch (err) {
    if (propria) await t.rollback();
    throw err;
  }
}

// Sincroniza o movimento bancário de saída de uma despesa com o seu estado:
// - despesa 'paga' com conta → garante um movimento de saída CONFIRMADO, com os
//   valores atuais da despesa (cria-o se não existir, ATUALIZA-O se existir —
//   inclusive se estiver anulado);
// - caso contrário → anula o movimento existente.
//
// ⚠️ O movimento ANULADO é reposto a 'confirmado' quando a despesa volta a
// estar paga. Sem isto, a sequência «pagar → anular → corrigir para paga»
// deixava a despesa paga SEM saída a contar no saldo, em silêncio. Repor é
// seguro porque um movimento ligado a uma despesa só pode ser anulado por esta
// função: o extrato recusa anular movimentos com origem operacional e manda
// corrigir na origem (`routes/financeiro.js`, `POST /movimentos/:id/anular`),
// logo nunca há aqui uma decisão do utilizador a sobrepor.
//
// `condominioId` é opcional e existe só para deixar explícito o condomínio em
// quem chama; quando omitido cai para `despesa.condominio_id` (NOT NULL no
// modelo), que é a fonte natural. Em qualquer dos casos o movimento fica sempre
// com condomínio — nunca NULL numa escrita nova.
async function sincronizarMovimentoDespesa(despesa, userId, transaction, condominioId) {
  const cid = condominioId || despesa.condominio_id || null;
  const movimento = await MovimentoBancario.findOne({ where: { despesa_id: despesa.id }, transaction });
  if (despesa.estado === 'paga' && despesa.conta_bancaria_id) {
    if (movimento) {
      await movimento.update(
        {
          conta_bancaria_id: despesa.conta_bancaria_id,
          condominio_id: cid,
          data: despesa.data || new Date(),
          valor: despesa.valor,
          descricao: despesa.descricao,
          categoria_id: despesa.categoria_id,
          estado: 'confirmado',
        },
        { transaction }
      );
    } else {
      await criarMovimento({
        contaBancariaId: despesa.conta_bancaria_id,
        condominioId: cid,
        data: despesa.data || new Date(),
        tipo: 'saida',
        valor: despesa.valor,
        descricao: despesa.descricao,
        categoriaId: despesa.categoria_id,
        despesaId: despesa.id,
        userId,
        transaction,
      });
    }
  } else if (movimento && movimento.estado === 'confirmado') {
    await movimento.update({ estado: 'anulado' }, { transaction });
  }
}

// Saldo de uma conta calculado pelos movimentos: saldo inicial + entradas − saídas.
//
// Regras (as mesmas que o resto do projeto usa para "saldo bancário"):
//  · o saldo inicial é contado UMA única vez (é o ponto de partida, não uma parcela);
//  · só entram movimentos com estado 'confirmado' (anulados não afetam o saldo);
//  · 'entrada' soma, 'saida' subtrai;
//  · 'transferencia' (valor de ENUM antigo, já não escrito) não altera o saldo —
//    o par saida+entrada de uma transferência real trata do débito/crédito;
//  · o âmbito é a CONTA: `conta_bancaria_id` identifica-a inequivocamente, logo o
//    filtro por conta é, por si, o isolamento por condomínio (uma conta pertence a
//    um e um só condomínio — `contas_bancarias.condominio_id` é NOT NULL).
//  · não há filtro por data aqui: quem precisa de um saldo À DATA usa
//    `saldoContaNaData` (helpers/relatorio-financeiro), que aplica `dataCorte`.
//
// `transaction` opcional: dentro de uma transação lê à mesma ligação (enxerga as
// escritas ainda não confirmadas).
async function saldoContaMovimentos(conta, { transaction } = {}) {
  const movimentos = await MovimentoBancario.findAll({
    where: { conta_bancaria_id: conta.id, estado: 'confirmado' },
    attributes: ['tipo', 'valor'],
    transaction,
  });
  let entradasC = 0;
  let saidasC = 0;
  for (const m of movimentos) {
    if (m.tipo === 'entrada') entradasC += toCents(m.valor);
    else if (m.tipo === 'saida') saidasC += toCents(m.valor);
    // 'transferencia' (registo antigo) não altera o saldo.
  }
  return fromCents(toCents(conta.saldo_inicial) + entradasC - saidasC);
}

// Igual a `saldoContaMovimentos`, mas devolvendo também a decomposição
// (entradas/saídas), para quem precisa de mostrar de onde vem o saldo.
// É a variante "com detalhe" da MESMA lógica — não uma segunda implementação.
async function saldoContaMovimentosDetalhado(conta, { transaction } = {}) {
  const movimentos = await MovimentoBancario.findAll({
    where: { conta_bancaria_id: conta.id, estado: 'confirmado' },
    attributes: ['tipo', 'valor'],
    transaction,
  });
  let entradasC = 0;
  let saidasC = 0;
  for (const m of movimentos) {
    if (m.tipo === 'entrada') entradasC += toCents(m.valor);
    else if (m.tipo === 'saida') saidasC += toCents(m.valor);
  }
  const baseC = toCents(conta.saldo_inicial);
  return {
    saldoC: baseC + entradasC - saidasC,
    saldoInicialC: baseC,
    entradasC,
    saidasC,
    nMovimentos: movimentos.length,  };
}

module.exports = {
  criarMovimento,
  registarTransferencia,
  sincronizarMovimentoDespesa,
  saldoContaMovimentos,
  saldoContaMovimentosDetalhado,
};
