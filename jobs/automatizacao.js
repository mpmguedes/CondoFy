const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Fracao, Configuracao, Condominio } = require('../models');
const { proximoNumero } = require('../helpers/numeracao');
const { monthName } = require('../helpers/dates');
const { getQuotaConfig } = require('../helpers/quotas-config');
const { calcularQuota } = require('../helpers/quotas-calc');
const { resolverDestinatarios } = require('../helpers/avisos');
const { enfileirarEmail } = require('../helpers/email-fila');
const { estaAtivo } = require('../helpers/notificacoes');

async function getConfigNumero(chave, fallback) {
  const reg = await Configuracao.findOne({ where: { chave } });
  const v = reg ? parseFloat(reg.valor) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

// ─────────────────────────────────────────────────────────────────────
// Isolamento multi-condomínio nos jobs automáticos.
//
// As tarefas agendadas correm fora de qualquer pedido HTTP: não existe
// «condomínio ativo da sessão». O âmbito tem de ser construído aqui, e é sempre
// derivado dos DADOS (a lista de condomínios ativos), nunca assumido.
//
// Regra transversal: nenhuma fração, quota ou destinatário de um condomínio
// pode ser lido ou escrito a partir do processamento de outro. Por isso cada
// tarefa itera os condomínios e processa-os um a um, em vez de fazer uma
// consulta global.
// ─────────────────────────────────────────────────────────────────────

// Condomínios ATIVOS — a raiz do âmbito de todas as tarefas automáticas.
// Só os ativos (`condominios.estado` = 'ativo' | 'inativo'): um condomínio
// inativo não deve receber quotas nem lembretes.
async function condominiosAtivos() {
  return Condominio.findAll({
    where: { estado: 'ativo' },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
}

// Gera as quotas do mês corrente (por permilagem/1000‰ + FCR), de forma
// idempotente. Processa cada condomínio SEPARADAMENTE, com a configuração
// desse condomínio e apenas as suas frações: o valor por 1000‰ e a percentagem
// de FCR são decididos por condomínio, pelo que uma única consulta global
// aplicaria a configuração de um condomínio às frações de outro.
async function gerarQuotasAutomaticas() {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = agora.getMonth() + 1;

  const condominios = await condominiosAtivos();
  let geradas = 0;
  const porCondominio = [];

  for (const condominio of condominios) {
    const condominioId = Number(condominio.id);

    // 1. Configuração DESTE condomínio (com a precedência específica → global → default).
    const { valorPor1000, fcrPercentagem } = await getQuotaConfig(condominioId);

    // 2. Apenas as frações DESTE condomínio.
    const fracoes = await Fracao.findAll({ where: { estado: 'ativo', condominio_id: condominioId } });
    if (!fracoes.length) continue;

    // 3. Transação por condomínio: a falha de um não arrasta os restantes (e o
    //    rollback nunca desfaz quotas já confirmadas de outro condomínio).
    const t = await sequelize.transaction();
    let geradasAqui = 0;
    try {
      for (const f of fracoes) {
        const existente = await Quota.findOne({
          where: { fracao_id: f.id, ano, mes, condominio_id: condominioId },
          transaction: t,
        });
        if (existente) continue;
        const q = calcularQuota(f.permilagem, valorPor1000, fcrPercentagem);
        const numero = await proximoNumero('aviso_quota', { ano, transaction: t });
        await Quota.create(
          {
            numero_documento: numero,
            condominio_id: condominioId,
            fracao_id: f.id,
            ano,
            mes,
            periodo: new Date(ano, mes - 1, 1),
            valor: q.total,
            valor_base: q.base,
            valor_fcr: q.fcr,
            valor_por_1000: q.valorPor1000,
            permilagem_aplicada: q.permilagem,
            fcr_percentagem: q.fcrPercentagem,
            data_emissao: new Date(),
            data_vencimento: new Date(ano, mes - 1, 8),
            estado: 'pendente',
          },
          { transaction: t }
        );
        geradasAqui++;
      }
      await t.commit();
    } catch (err) {
      await t.rollback();
      // Um condomínio mal configurado não pode impedir os restantes de gerar.
      console.error(`[auto-quotas] condomínio ${condominioId} falhou:`, err.message);
      continue;
    }

    geradas += geradasAqui;
    porCondominio.push({ condominioId, geradas: geradasAqui });
  }

  return { geradas, condominios: porCondominio.length, porCondominio };
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
      // Só quotas de condomínios ATIVOS (as de um condomínio inativo não geram avisos).
      condominio_id: { [Op.in]: (await condominiosAtivos()).map((c) => Number(c.id)) },
    },
    include: [{ model: Fracao, as: 'fracao' }],
  });

  let enviados = 0;
  for (const q of alvos) {
    const ehAtraso = q.data_vencimento === atrasoISO;
    // Avisos de atraso respeitam a preferência "Quotas em atraso → email".
    if (ehAtraso && !(await estaAtivo('quotas_atraso', 'email'))) continue;

    // O condomínio vem da PRÓPRIA quota (nunca de uma assunção global). Sem ele,
    // `resolverDestinatarios` desliga o escopo por condomínio e pode devolver
    // contactos de outro condomínio.
    const condominioId = Number(q.condominio_id);
    if (!condominioId) continue;

    const dest = await resolverDestinatarios(
      { modo: 'fracoes', fracoes: [q.fracao_id] },
      condominioId
    );
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
      // Ligação segura à quota (condominio_id) para que o processamento da
      // fila derive o condomínio do remetente — nunca por nome/assunto.
      await enfileirarEmail({
        destinatario_email: d.email,
        destinatario_nome: d.nome,
        assunto,
        corpo,
        entidade_tipo: 'Quota',
        entidade_id: q.id,
        condominioId,
      });
      enviados++;
    }
  }
  return { enviados, alvos: alvos.length };
}

module.exports = { gerarQuotasAutomaticas, enviarLembretesAutomaticos, condominiosAtivos };
