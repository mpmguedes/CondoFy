const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Quota, Fracao, Configuracao, Condominio, EmailFila } = require('../models');
const { proximoNumero } = require('../helpers/numeracao');
const { monthName, somarDias, toDateInput } = require('../helpers/dates');
const { getQuotaConfig } = require('../helpers/quotas-config');
const { calcularQuota } = require('../helpers/quotas-calc');
const { resolverDestinatarios } = require('../helpers/avisos');
const { enfileirarEmail } = require('../helpers/email-fila');
const { estaAtivo } = require('../helpers/notificacoes');

// ─────────────────────────────────────────────────────────────────────
// Lembretes/atrasos — janela relativa com MARCADOR de envio
//
// Os assuntos são também a CHAVE do marcador (a fila guarda-os em
// `email_fila.assunto`): o email e o marcador usam a MESMA constante, pelo que
// não podem divergir. Reescrever um assunto isoladamente faz o job voltar a
// enviar (o marcador deixa de casar) — há um teste que morde nisto.
// ─────────────────────────────────────────────────────────────────────
const ASSUNTO_LEMBRETE = 'Lembrete de vencimento da quota';
const ASSUNTO_ATRASO = 'Aviso de atraso — quota em dívida';

// Estados da fila que contam como JÁ DESPACHADO (mesmo critério de
// `ESTADOS_DESPACHADOS` em `helpers/avisos-envio.js`): `erro` e `cancelado`
// também bloqueiam — um envio que falhou não é ressuscitado pela passagem
// seguinte. Definido aqui (e não importado) para não arrastar para este job a
// cadeia de dependências do motor dos avisos.
const ESTADOS_JA_DESPACHADOS = ['pendente', 'a_enviar', 'enviado', 'erro', 'cancelado'];

// Folga de recuperação. A janela é relativa para uma paragem não perder a
// coorte do dia — mas tem de ser LIMITADA: sem limite inferior, a primeira
// execução depois desta alteração varreria TODAS as quotas antigas em atraso e
// dispararia um aviso por cada uma. Recupera-se a semana perdida, não o
// histórico.
const DIAS_RECUPERACAO = 7;

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
//
// A seleção é uma JANELA RELATIVA, não um dia exato: se o job não correr num dia
// (paragem, deploy, reinício), um `data_vencimento = <dia>` perderia a coorte
// desse dia para sempre. Como a janela é relativa, a MESMA quota continua
// dentro dela amanhã — o que impede o reenvio não é a consulta, é o MARCADOR
// (uma linha na fila para a mesma quota e o mesmo assunto).
async function enviarLembretesAutomaticos() {
  const diasLembrete = await getConfigNumero('lembrete_dias', 5);
  const diasAtraso = await getConfigNumero('atraso_dias', 3);

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  // ⛔ Datas em componentes LOCAIS (`toDateInput`). Com `toISOString()` a
  // meia-noite local é convertida para UTC e o dia RECUA em fusos a leste de
  // UTC: em Portugal no verão os «dias configuráveis» valiam um dia a menos, e
  // o defeito aparecia/desaparecia com a mudança da hora.
  const hojeISO = toDateInput(hoje);
  const fimLembrete = toDateInput(somarDias(hoje, diasLembrete));
  const fimAtraso = toDateInput(somarDias(hoje, -diasAtraso));
  const inicioAtraso = toDateInput(somarDias(hoje, -diasAtraso - DIAS_RECUPERACAO));

  const alvos = await Quota.findAll({
    where: {
      estado: { [Op.in]: ['pendente', 'parcialmente_paga', 'vencida'] },
      // Vencimento ainda por chegar (dentro dos próximos `lembrete_dias`) OU já
      // vencido há pelo menos `atraso_dias` (com a folga de recuperação).
      [Op.or]: [
        { data_vencimento: { [Op.between]: [hojeISO, fimLembrete] } },
        { data_vencimento: { [Op.between]: [inicioAtraso, fimAtraso] } },
      ],
      // Só quotas de condomínios ATIVOS (as de um condomínio inativo não geram avisos).
      condominio_id: { [Op.in]: (await condominiosAtivos()).map((c) => Number(c.id)) },
    },
    include: [{ model: Fracao, as: 'fracao' }],
  });

  // Marcador de idempotência: uma linha na fila para a MESMA quota e o MESMO
  // assunto ⇒ já foi despachado, esta passagem não repete. Uma só consulta
  // (nunca uma por quota).
  const jaDespachado = new Set();
  const ids = alvos.map((q) => Number(q.id)).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length) {
    const registos = await EmailFila.findAll({
      where: {
        entidade_tipo: 'Quota',
        entidade_id: { [Op.in]: ids },
        assunto: { [Op.in]: [ASSUNTO_LEMBRETE, ASSUNTO_ATRASO] },
        estado: { [Op.in]: ESTADOS_JA_DESPACHADOS },
      },
      attributes: ['entidade_id', 'assunto'],
    });
    for (const r of registos) jaDespachado.add(`${Number(r.entidade_id)}:${r.assunto}`);
  }

  let enviados = 0;
  let repetidos = 0;
  for (const q of alvos) {
    const vencimento = String(q.data_vencimento).slice(0, 10);
    // «Em atraso» = o vencimento já passou. Uma quota que vence hoje não é
    // atraso — entra pela janela do lembrete.
    const ehAtraso = vencimento < hojeISO;
    // Avisos de atraso respeitam a preferência "Quotas em atraso → email".
    if (ehAtraso && !(await estaAtivo('quotas_atraso', 'email'))) continue;

    const assunto = ehAtraso ? ASSUNTO_ATRASO : ASSUNTO_LEMBRETE;
    if (jaDespachado.has(`${Number(q.id)}:${assunto}`)) {
      repetidos++;
      continue;
    }

    // O condomínio vem da PRÓPRIA quota (nunca de uma assunção global). Sem ele,
    // `resolverDestinatarios` desliga o escopo por condomínio e pode devolver
    // contactos de outro condomínio.
    const condominioId = Number(q.condominio_id);
    if (!condominioId) continue;

    const dest = await resolverDestinatarios(
      { modo: 'fracoes', fracoes: [q.fracao_id] },
      condominioId
    );
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
    // Marcador também dentro da passagem: a mesma quota não é processada duas vezes.
    jaDespachado.add(`${Number(q.id)}:${assunto}`);
  }
  return { enviados, alvos: alvos.length, repetidos };
}

module.exports = { gerarQuotasAutomaticas, enviarLembretesAutomaticos, condominiosAtivos };
