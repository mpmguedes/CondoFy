const sequelize = require('../config/database');
const { MovimentoBancario } = require('../models');
const { toCents, fromCents } = require('./money');

// Cria um movimento bancário. `valor` é sempre positivo; o tipo indica o sentido.
async function criarMovimento({
  contaBancariaId,
  data,
  tipo,
  valor,
  descricao,
  referencia,
  categoriaId,
  quotaId,
  pagamentoId,
  despesaId,
  documentoId,
  observacoes,
  userId,
  transaction,
}) {
  return MovimentoBancario.create(
    {
      conta_bancaria_id: contaBancariaId,
      data: data || new Date(),
      tipo,
      valor: fromCents(toCents(valor)),
      descricao: descricao || null,
      referencia: referencia || null,
      categoria_id: categoriaId || null,
      quota_id: quotaId || null,
      pagamento_id: pagamentoId || null,
      despesa_id: despesaId || null,
      documento_id: documentoId || null,
      observacoes: observacoes || null,
      created_by: userId || null,
      estado: 'confirmado',
    },
    { transaction }
  );
}

// Transferência entre contas: cria dois movimentos (saída na origem, entrada no destino).
async function registarTransferencia({ contaOrigemId, contaDestinoId, valor, data, descricao, userId }) {
  const t = await sequelize.transaction();
  try {
    await criarMovimento({
      contaBancariaId: contaOrigemId,
      data,
      tipo: 'saida',
      valor,
      descricao: descricao || 'Transferência entre contas',
      referencia: 'TRANSF',
      userId,
      transaction: t,
    });
    await criarMovimento({
      contaBancariaId: contaDestinoId,
      data,
      tipo: 'entrada',
      valor,
      descricao: descricao || 'Transferência entre contas',
      referencia: 'TRANSF',
      userId,
      transaction: t,
    });
    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
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
async function saldoContaMovimentos(conta) {
  const [entradas, saidas] = await Promise.all([
    MovimentoBancario.sum('valor', { where: { conta_bancaria_id: conta.id, tipo: 'entrada', estado: 'confirmado' } }),
    MovimentoBancario.sum('valor', { where: { conta_bancaria_id: conta.id, tipo: 'saida', estado: 'confirmado' } }),
  ]);
  return fromCents(toCents(conta.saldo_inicial) + toCents(entradas) - toCents(saidas));
}

module.exports = { criarMovimento, registarTransferencia, sincronizarMovimentoDespesa, saldoContaMovimentos };
