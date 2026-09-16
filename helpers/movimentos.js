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
// - despesa 'paga' com conta → garante um movimento de saída;
// - caso contrário → anula o movimento existente.
async function sincronizarMovimentoDespesa(despesa, userId, transaction) {
  const movimento = await MovimentoBancario.findOne({ where: { despesa_id: despesa.id }, transaction });
  if (despesa.estado === 'paga' && despesa.conta_bancaria_id) {
    if (movimento) {
      if (movimento.estado === 'confirmado') {
        await movimento.update(
          {
            conta_bancaria_id: despesa.conta_bancaria_id,
            data: despesa.data || new Date(),
            valor: despesa.valor,
            descricao: despesa.descricao,
            categoria_id: despesa.categoria_id,
          },
          { transaction }
        );
      }
    } else {
      await criarMovimento({
        contaBancariaId: despesa.conta_bancaria_id,
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

module.exports = { criarMovimento, registarTransferencia, sincronizarMovimentoDespesa, saldoContaMovimentos };
