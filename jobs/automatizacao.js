const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Fracao, Configuracao } = require('../models');
const { proximoNumero } = require('../helpers/numeracao');
const { toNumber } = require('../helpers/money');
const { monthName } = require('../helpers/dates');
const { resolverDestinatarios } = require('../helpers/avisos');
const { enfileirarEmail } = require('../helpers/email-fila');

async function getConfigNumero(chave, fallback) {
  const reg = await Configuracao.findOne({ where: { chave } });
  const v = reg ? parseFloat(reg.valor) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

// Gera as quotas do mês corrente (se existir valor mensal configurado).
async function gerarQuotasAutomaticas() {
  const reg = await Configuracao.findOne({ where: { chave: 'quota_valor_mensal' } });
  const valor = reg ? toNumber(reg.valor) : 0;
  if (!valor || valor <= 0) {
    return { geradas: 0, motivo: 'valor mensal não configurado' };
  }

  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = agora.getMonth() + 1;
  const fracoes = await Fracao.findAll({ where: { estado: 'ativo' } });

  const t = await sequelize.transaction();
  let geradas = 0;
  try {
    for (const f of fracoes) {
      const existente = await Quota.findOne({ where: { fracao_id: f.id, ano, mes }, transaction: t });
      if (existente) continue;
      const numero = await proximoNumero('aviso_quota', { ano, transaction: t });
      await Quota.create(
        {
          numero_documento: numero,
          fracao_id: f.id,
          ano,
          mes,
          periodo: new Date(ano, mes - 1, 1),
          valor,
          data_emissao: new Date(),
          data_vencimento: new Date(ano, mes - 1, 8),
          estado: 'pendente',
        },
        { transaction: t }
      );
      geradas++;
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
  return { geradas };
}

// Envia lembretes de vencimento e avisos de atraso (dias configuráveis).
async function enviarLembretesAutomaticos() {
  const diasLembrete = await getConfigNumero('lembrete_dias', 5);
  const diasAtraso = await getConfigNumero('atraso_dias', 3);

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dLembrete = new Date(hoje);
  dLembrete.setDate(dLembrete.getDate() + diasLembrete);
  const dAtraso = new Date(hoje);
  dAtraso.setDate(dAtraso.getDate() - diasAtraso);

  const lembreteISO = dLembrete.toISOString().slice(0, 10);
  const atrasoISO = dAtraso.toISOString().slice(0, 10);

  const alvos = await Quota.findAll({
    where: {
      estado: { [Op.in]: ['pendente', 'parcialmente_paga', 'vencida'] },
      data_vencimento: { [Op.in]: [lembreteISO, atrasoISO] },
    },
    include: [{ model: Fracao, as: 'fracao' }],
  });

  let enviados = 0;
  for (const q of alvos) {
    const ehAtraso = q.data_vencimento === atrasoISO;
    const dest = await resolverDestinatarios({ modo: 'fracoes', fracoes: [q.fracao_id] });
    const assunto = ehAtraso
      ? 'Aviso de atraso — quota em dívida'
      : 'Lembrete de vencimento da quota';
    const corpo = [
      `Fração ${q.fracao.designacao}`,
      `Período: ${monthName(q.mes)} ${q.ano}`,
      `Valor: ${q.valor} €`,
      `Vencimento: ${q.data_vencimento}`,
      '',
      ehAtraso
        ? 'A quota encontra-se em atraso. Regularize o pagamento com a maior brevidade.'
        : 'O vencimento da quota está próximo. Efetue o pagamento até à data indicada.',
    ].join('\n');

    for (const d of dest) {
      await enfileirarEmail({
        destinatario_email: d.email,
        destinatario_nome: d.nome,
        assunto,
        corpo,
      });
      enviados++;
    }
  }
  return { enviados, alvos: alvos.length };
}

module.exports = { gerarQuotasAutomaticas, enviarLembretesAutomaticos };
