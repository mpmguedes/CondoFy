const express = require('express');
const { Op } = require('sequelize');
const {
  Pessoa,
  Fracao,
  Quota,
  Pagamento,
  PagamentoQuota,
  Recibo,
  ReciboQuota,
  Documento,
  Aviso,
  Assembleia,
  ExtraQuota,
  ExtraQuotaParcela,
  Despesa,
  Orcamento,
  OrcamentoRubrica,
  Categoria,
  MetodoPagamento,
} = require('../models');
const { eAutenticado } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const titularidades = require('../helpers/titularidades');
const { resumoFracao, resumoCondominio, resumoOrcamento, resumoFinanceiro, evolucaoMensal, estadoEfetivo } = require('../helpers/saldos');
const contaCorrente = require('../helpers/conta-corrente');
const { getCondominio } = require('../helpers/condominio');
const { gerarReciboPDF } = require('../helpers/pdf');
const cabecalhos = require('../helpers/cabecalhos-ficheiro');
const recibosHelper = require('../helpers/recibos');
const { mapaPastas } = require('../helpers/documento-pastas');
const recomendacoesHelper = require('../helpers/recomendacoes');
// Acesso autorizado a documentos (neste módulo: só os disponibilizados).
const { autorizarAcessoDocumento, servirDocumento, verificarDocumento, responderRecusa } = require('../helpers/documentos-acesso');

const router = express.Router();

router.use(eAutenticado);
// Isolamento: a área do condómino mostra apenas o condomínio ativo (sessão).
router.use(tenant.comCondominioAtivo);

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Pessoa do utilizador + frações a que tem acesso AGORA (só do condomínio
// ativo). O acesso às frações é determinado pelas TITULARIDADES (relação
// temporal pessoa/conta ↔ fração): uma relação encerrada deixa de dar acesso,
// mesmo que a sessão do browser seja antiga, porque esta consulta corre em cada
// pedido. Sem titularidades registadas (dados anteriores), mantém-se o
// comportamento antigo a partir de `users.pessoa_id` + `fracao_pessoas`,
// também já a respeitar `data_fim`. null quando a conta não está ligada a
// nenhum condómino deste condomínio.
async function contextoFracoes(req) {
  const pessoa = req.user.pessoa_id
    ? await Pessoa.findOne({ where: { id: req.user.pessoa_id, condominio_id: req.condominioId } })
    : null;

  const { fracoes } = await titularidades.fracoesDoUtilizador({
    condominioId: req.condominioId,
    utilizadorId: req.user.id,
    pessoaId: req.user.pessoa_id,
  });

  // Forma compatível com o que as vistas e o resto do módulo já esperam:
  // `fracao.vinculoAtual` e `fracao.FracaoPessoa.vinculo`.
  const lista = fracoes.map(({ fracao, vinculo }) => {
    fracao.vinculoAtual = vinculo || null;
    fracao.FracaoPessoa = { vinculo: vinculo || null };
    return fracao;
  });

  return { pessoa, fracoes: lista };
}

function formatarPermilagem(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const n = Number(valor) || 0;
  const partes = n.toFixed(3).split('.');
  partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${partes.join(',')} ‰`;
}

// ── Dashboard ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { pessoa, fracoes } = await contextoFracoes(req);
  const ids = fracoes.map((f) => f.id);
  const hoje = new Date().toISOString().slice(0, 10);

  // Orientação contextual (Fase 2G): o motor decide, a partir do estado real da
  // conta, se há UMA recomendação a apresentar. As dispensas são lidas aqui e
  // passadas ao motor — a condição continua a mandar: uma recomendação nunca
  // aparece depois de a sua situação deixar de existir.
  const sugestao = recomendacoesHelper.escolher(
    {
      userId: req.user.id,
      autenticado: true,
      twoFaAtivo: Boolean(req.user.two_fa_ativo),
    },
    await recomendacoesHelper.carregarDispensas(req.user.id)
  );

  // Sem frações: distinguir "nunca teve relação" de "deixou de ser titular"
  // (mudança de proprietário). No segundo caso explica-se o que aconteceu e
  // dá-se saída — o acesso ao condomínio não deve manter-se sem razão.
  const historico = pessoa ? await titularidades.historicoDaPessoa({ condominioId: req.condominioId, pessoaId: pessoa.id }) : [];
  const titularidadesTerminadas = fracoes.length
    ? []
    : historico
        .filter((t) => !titularidades.estaAtiva(t) && t.fracao)
        .map((t) => ({ fracao: t.fracao.designacao, vinculo: t.vinculo, data_fim: t.data_fim }));

  const fracoesComResumo = await Promise.all(
    fracoes.map(async (f) => {
      const base = f.toJSON();
      const resumo = await resumoFracao(f.id);
      // Quotas extraordinárias por cobrar da fração (disponíveis ou já em aviso).
      const extras = await ExtraQuotaParcela.findAll({
        where: { fracao_id: f.id, estado: { [Op.in]: ['pendente', 'cobrada'] } },
        include: [{ model: ExtraQuota, as: 'extra_quota', where: { estado: 'processada' }, required: true }],
        order: [['data_vencimento', 'ASC']],
        limit: 5,
      });
      // Próximo vencimento DESTA fração: a quota ainda por pagar mais próxima.
      // Por fração, e não uma só para todas as frações do utilizador: a
      // informação é apresentada dentro do cartão de cada fração, e uma quota
      // de outra fração não pode aparecer nesse cartão.
      // Nota: `data_vencimento >= hoje` significa «por vencer»; uma quota com o
      // vencimento no passado é atraso/dívida (estado efetivo 'vencida', já
      // contabilizado em `resumo.emDivida`) e não entra aqui.
      const proximaQuota = await Quota.findOne({
        where: {
          condominio_id: req.condominioId,
          fracao_id: f.id,
          estado: { [Op.in]: ['pendente', 'parcialmente_paga', 'vencida'] },
          data_vencimento: { [Op.gte]: hoje },
        },
        order: [['data_vencimento', 'ASC'], ['id', 'ASC']],
      });
      return {
        ...base,
        resumo,
        proximaQuota,
        vinculo: f.vinculoAtual || (f.FracaoPessoa ? f.FracaoPessoa.vinculo : null),
        extrasPendentes: extras.map((p) => ({
          id: p.id,
          designacao: p.extra_quota ? p.extra_quota.designacao : 'Quota extraordinária',
          valor: p.valor,
          vencimento: p.data_vencimento,
          parcela: p.parcela_numero,
        })),
      };
    })
  );

  // Painel do Início (mobile-first): o que tenho para tratar, o que aconteceu e
  // o que vem a seguir. Usa apenas dados que já existem (quotas, avisos,
  // documentos, recibos, assembleias) — nenhuma informação inventada.
  const [resumo, orcamento, avisos, documentos, recibos, assembleias, avisosProgramados] = await Promise.all([
    resumoCondominio(req.condominioId),
    resumoOrcamento(new Date().getFullYear(), req.condominioId),
    Aviso.findAll({ where: { condominio_id: req.condominioId }, order: [['id', 'DESC']], limit: 5 }),
    Documento.findAll({
      where: { condominio_id: req.condominioId, disponivel_condominos: true },
      order: [['data', 'DESC'], ['id', 'DESC']],
      limit: 5,
    }),
    ids.length
      ? Recibo.findAll({
          where: { condominio_id: req.condominioId, fracao_id: { [Op.in]: ids } },
          order: [['data_emissao', 'DESC'], ['id', 'DESC']],
          limit: 5,
        })
      : [],
    Assembleia.findAll({
      where: {
        condominio_id: req.condominioId,
        estado: { [Op.in]: ['agendada', 'convocada'] },
        data: { [Op.gte]: hoje },
      },
      order: [['data', 'ASC'], ['id', 'ASC']],
      limit: 5,
    }),
    // Comunicações programadas para o futuro = próximos acontecimentos no calendário.
    Aviso.findAll({
      where: { condominio_id: req.condominioId, data_programada: { [Op.gte]: hoje } },
      order: [['data_programada', 'ASC']],
      limit: 5,
    }),
  ]);

  // Atividade recente: uma lista única por data (avisos, documentos e recibos).
  // Datas para a lista de atividade: `data`, `data_vencimento` e `data_programada`
  // são DATEONLY (texto «AAAA-MM-DD»), mas `createdAt` é um Date — converter
  // sempre por Date evita datas sem sentido na vista (ex.: 2001) e mantém a
  // ordenação cronológica da lista correta.
  const dataISO = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };
  const atividadeRecente = [
    ...avisos.map((a) => ({
      tipo: 'aviso',
      icone: 'campaign',
      titulo: a.assunto || 'Aviso do condomínio',
      detalhe: a.mensagem ? String(a.mensagem).split('\n')[0].slice(0, 90) : null,
      data: dataISO(a.createdAt),
      link: '/condomino/avisos',
    })),
    ...documentos.map((d) => ({
      tipo: 'documento',
      icone: 'description',
      titulo: d.nome,
      detalhe: d.pasta || null,
      data: dataISO(d.data),
      // A vista liga pelo helper urlDocumento (rota interna verificada); aqui
      // passa-se o documento, nunca um URL de fornecedor.
      documento: d.toJSON(),
    })),
    ...recibos.map((r) => ({
      tipo: 'recibo',
      icone: 'receipt_long',
      titulo: `Recibo ${r.codigo || ''}`.trim(),
      detalhe: r.valor != null ? `${Number(r.valor).toFixed(2).replace('.', ',')} €` : null,
      data: dataISO(r.data_emissao),
      link: '/condomino/recibos',
    })),
  ]
    .sort((a, b) => String(b.data).localeCompare(String(a.data)))
    .slice(0, 5);

  // Próximos eventos: assembleias futuras + comunicações programadas.
  const proximosEventos = [
    ...assembleias.map((a) => ({
      tipo: 'assembleia',
      icone: 'forum',
      titulo: a.numero ? `Assembleia ${a.numero}` : 'Assembleia de condóminos',
      detalhe: [a.hora, a.local].filter(Boolean).join(' · ') || null,
      data: dataISO(a.data),
      link: `/condomino/assembleias/${a.id}`,
    })),
    ...avisosProgramados.map((a) => ({
      tipo: 'comunicacao',
      icone: 'schedule_send',
      titulo: a.assunto || 'Comunicação programada',
      detalhe: 'Comunicação programada',
      data: dataISO(a.data_programada),
      link: '/condomino/avisos',
    })),
  ]
    .sort((x, y) => String(x.data).localeCompare(String(y.data)))
    .slice(0, 4);

  res.render('condomino/dashboard', {
    titulo: 'Início',
    pessoa,
    fracoesComResumo,
    resumo,
    orcamento,
    avisos,
    atividadeRecente,
    proximosEventos,
    hoje,
    nFracoesProprias: ids.length,
    titularidadesTerminadas,
    // No máximo UMA recomendação (e só se a condição dela se verificar).
    recomendacao: sugestao.recomendacao,
    recomendacoesDisponiveis: sugestao.total,
  });
});

// ── As minhas quotas (leitura; filtros ano/estado) ─────────────────
router.get('/quotas', async (req, res) => {
  const { pessoa, fracoes } = await contextoFracoes(req);
  const ids = fracoes.map((f) => f.id);
  // Data de hoje (AAAA-MM-DD), como nas restantes rotas do portal: é usada para
  // saber se uma quota já venceu ao derivar o estado apresentado.
  const hoje = new Date().toISOString().slice(0, 10);
  const ano = parseInt(req.query.ano, 10) || null;
  const estado = req.query.estado && ['pendente', 'vencida', 'paga'].includes(req.query.estado) ? req.query.estado : null;

  const whereQ = { condominio_id: req.condominioId };
  if (ids.length) whereQ.fracao_id = { [Op.in]: ids };
  else whereQ.fracao_id = { [Op.in]: [-1] }; // sem frações → nada
  if (ano) whereQ.ano = ano;

  const quotas = await Quota.findAll({
    where: whereQ,
    include: [{ model: Fracao, as: 'fracao' }],
    order: [['ano', 'DESC'], ['mes', 'DESC'], ['fracao_id', 'ASC']],
  });

  // Estados efetivos + pagamento aplicado por quota.
  const idsQuota = quotas.map((q) => q.id);
  const aplicacoes = idsQuota.length
    ? await PagamentoQuota.findAll({
        where: { quota_id: { [Op.in]: idsQuota } },
        include: [{ model: Pagamento, as: 'pagamento', attributes: ['id', 'data_pagamento', 'referencia', 'estado'] }],
      })
    : [];
  const pagoMap = new Map();
  aplicacoes.forEach((a) => {
    if (a.pagamento && a.pagamento.estado === 'confirmado') {
      const anterior = pagoMap.get(a.quota_id) || { valorC: 0, data: null, referencia: null, pagamentoId: null };
      anterior.valorC += Math.round(Number(a.valor_aplicado) * 100);
      if (!anterior.data || new Date(a.pagamento.data_pagamento) > new Date(anterior.data)) {
        anterior.data = a.pagamento.data_pagamento;
        anterior.referencia = a.pagamento.referencia || null;
        anterior.pagamentoId = a.pagamento.id;
      }
      pagoMap.set(a.quota_id, anterior);
    }
  });

  const linhas = quotas
    .map((q) => {
      const efetivo = estadoEfetivo(q);
      const pago = pagoMap.get(q.id) || { valorC: 0 };
      return {
        ...q.toJSON(),
        fracaoDesignacao: q.fracao ? q.fracao.designacao : null,
        mesNome: MESES[q.mes - 1],
        estadoEfetivo: efetivo,
        pago: (pago.valorC || 0) / 100,
        dataPagamento: pago.data || null,
        referencia: pago.referencia || null,
        pagamentoId: pago.pagamentoId || null,
      };
    })
    .filter((l) => !estado || l.estadoEfetivo === estado)
    // Estado APRESENTADO no portal, derivado dos pagamentos confirmados que a
    // rota já calculou (`pago` vs `valor`). Não altera o estado guardado na base
    // de dados: uma quota paga em parte e já vencida é «parcialmente paga», não
    // «vencida». Uma quota anulada continua anulada — nunca vira pendente.
    .map((l) => {
      let estadoApresentado;
      if (l.estado === 'anulada') estadoApresentado = 'anulada';
      else if (l.estado === 'paga') estadoApresentado = 'paga';
      else {
        const pagoC = Math.round((Number(l.pago) || 0) * 100);
        const valorC = Math.round((Number(l.valor) || 0) * 100);
        const venceu = Boolean(l.data_vencimento) && String(l.data_vencimento).slice(0, 10) < hoje;
        if (valorC > 0 && pagoC >= valorC) estadoApresentado = 'paga';
        else if (pagoC > 0) estadoApresentado = 'parcialmente_paga';
        else if (venceu) estadoApresentado = 'vencida';
        else estadoApresentado = 'pendente';
      }
      return { ...l, estadoApresentado };
    });

  // Resumo por fração e do conjunto — calculado sobre as linhas já carregadas
  // (nenhuma consulta nova) e respeitando o filtro de ano em vigor. Cada fração
  // tem o seu próprio resumo: os valores nunca são misturados.
  const resumoAno = [];
  const porFracao = new Map();
  linhas.forEach((l) => {
    const chave = l.fracao_id != null ? l.fracao_id : 0;
    if (!porFracao.has(chave)) {
      porFracao.set(chave, {
        fracao_id: chave,
        designacao: l.fracaoDesignacao,
        pagas: 0,
        parciais: 0,
        vencidas: 0,
        pendentes: 0,
        anuladas: 0,
        total: 0,
        pago: 0,
        proximaQuota: null,
      });
    }
    const g = porFracao.get(chave);
    g.total += Number(l.valor) || 0;
    g.pago += Number(l.pago) || 0;
    if (l.estadoApresentado === 'paga') g.pagas += 1;
    else if (l.estadoApresentado === 'parcialmente_paga') g.parciais += 1;
    else if (l.estadoApresentado === 'vencida') g.vencidas += 1;
    else if (l.estadoApresentado === 'anulada') g.anuladas += 1;
    else g.pendentes += 1;
    // Próxima quota desta fração: o vencimento mais próximo que ainda não está
    // resolvido (as anuladas não contam). Só entre as quotas carregadas.
    if (l.estadoApresentado !== 'paga' && l.estadoApresentado !== 'anulada' && l.data_vencimento) {
      const venc = String(l.data_vencimento).slice(0, 10);
      if (venc >= hoje && (!g.proximaQuota || venc < g.proximaQuota.data_vencimento)) {
        g.proximaQuota = { valor: l.valor, data_vencimento: venc, mes: l.mes, ano: l.ano };
      }
    }
  });
  const totaisAno = { pagas: 0, parciais: 0, vencidas: 0, pendentes: 0, anuladas: 0, total: 0, pago: 0 };
  porFracao.forEach((g) => {
    resumoAno.push(g);
    ['pagas', 'parciais', 'vencidas', 'pendentes', 'anuladas', 'total', 'pago'].forEach((k) => { totaisAno[k] += g[k]; });
  });

  const anos = await Quota.findAll({
    attributes: [[require('sequelize').fn('DISTINCT', require('sequelize').col('ano')), 'ano']],
    where: { condominio_id: req.condominioId, fracao_id: { [Op.in]: ids.length ? ids : [-1] } },
    order: [['ano', 'DESC']],
    raw: true,
  });

  // Quotas extraordinárias (parcelas) da fração.
  const extras = ids.length
    ? await ExtraQuotaParcela.findAll({
        where: { fracao_id: { [Op.in]: ids } },
        include: [
          { model: ExtraQuota, as: 'extra_quota' },
          { model: Fracao, as: 'fracao' },
        ],
        order: [['data_vencimento', 'ASC']],
      })
    : [];

  res.render('condomino/quotas', {
    titulo: 'As minhas quotas',
    pessoa,
    linhas,
    extras: extras.map((p) => {
      const extra = p.extra_quota || null;
      const base = p.toJSON();
      // Linguagem clara para o condómino (não os nomes técnicos da BD).
      let estadoLabel = base.estado; // pendente|cobrada|paga|anulada
      if (base.estado === 'paga') estadoLabel = 'Paga';
      else if (base.estado === 'anulada') estadoLabel = 'Anulada';
      else if (base.estado === 'cobrada') estadoLabel = 'Em cobrança';
      else if (extra && extra.estado === 'pendente') estadoLabel = 'Pendente de aprovação';
      else if (extra && extra.estado === 'aprovada') estadoLabel = 'Aprovada (aguarda cobrança)';
      else estadoLabel = 'Pendente';
      return {
        ...base,
        designacao: extra ? extra.designacao : 'Quota extraordinária',
        fracaoDesignacao: p.fracao ? p.fracao.designacao : null,
        vencimento: p.data_vencimento,
        estadoLabel,
        extraEstado: extra ? extra.estado : null,
        // `valor_pago` já existe no modelo da parcela: é passado à vista tal como
        // está, sem qualquer consulta adicional.
        valorPago: base.valor_pago,
      };
    }),
    resumoAno,
    totaisAno,
    hoje,
    // Contexto de apresentação: o mês corrente só é realçado quando o ano em
    // causa é o ano em curso (sem isso, o realce seria ambíguo). A designação da
    // fração em cada linha só é necessária quando há mais do que uma.
    currentMonth: new Date().getMonth() + 1,
    temVariasFracoes: resumoAno.length > 1,
    filtros: { ano: ano || '', estado: estado || '' },
    anos: anos.map((a) => a.ano),
  });
});

// ── Os meus pagamentos ──────────────────────────────────────────────
router.get('/pagamentos', async (req, res) => {
  const { pessoa, fracoes } = await contextoFracoes(req);
  const ids = fracoes.map((f) => f.id);
  const pagamentos = await Pagamento.findAll({
    where: {
      condominio_id: req.condominioId,
      fracao_id: { [Op.in]: ids.length ? ids : [-1] },
    },
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor_aplicado'] } },
    ],
    order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
  });
  const linhas = pagamentos.map((p) => {
    const json = p.toJSON();
    json.metodoNome = p.metodo_pagamento ? p.metodo_pagamento.nome : null;
    json.fracaoDesignacao = p.fracao ? p.fracao.designacao : null;
    json.periodos = (p.quotas || []).map((q) => `${MESES[q.mes - 1]} ${q.ano}`).join(', ');
    return json;
  });
  res.render('condomino/pagamentos', { titulo: 'Os meus pagamentos', pessoa, linhas });
});

// ── Os meus recibos ─────────────────────────────────────────────────
router.get('/recibos', async (req, res) => {
  const { pessoa, fracoes } = await contextoFracoes(req);
  const ids = fracoes.map((f) => f.id);
  const recibos = await Recibo.findAll({
    where: { condominio_id: req.condominioId, fracao_id: { [Op.in]: ids.length ? ids : [-1] } },
    include: [
      { model: Fracao, as: 'fracao' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor'] } },
      {
        model: ExtraQuotaParcela,
        as: 'parcelasExtra',
        through: { attributes: ['valor'] },
        include: [{ model: ExtraQuota, as: 'extra_quota', attributes: ['designacao'] }],
      },
    ],
    order: [['data_emissao', 'DESC'], ['id', 'DESC']],
  });
  const linhas = recibos.map((r) => {
    const json = r.toJSON();
    json.fracaoDesignacao = r.fracao ? r.fracao.designacao : null;
    json.periodos = (r.quotas || []).map((q) => `${MESES[q.mes - 1]} ${q.ano}`).join(', ');
    const extras = r.parcelasExtra || [];
    if (!json.periodos && extras.length) {
      json.periodos = extras
        .map((p) => (p.extra_quota && p.extra_quota.designacao ? p.extra_quota.designacao : 'Quota extraordinária'))
        .join(' + ');
    }
    json.temExtras = extras.length > 0;
    // Nº de períodos cobertos, para a vista poder resumir uma lista longa.
    json.nPeriodos = (r.quotas || []).length + extras.length;
    return json;
  });
  res.render('condomino/recibos', {
    titulo: 'Os meus recibos',
    pessoa,
    linhas,
    nRecibos: linhas.length,
    // A fração só é mostrada em cada recibo quando o utilizador tem mais do que
    // uma (com uma só seria repetir a mesma designação em todas as linhas).
    temVariasFracoes: fracoes.length > 1,
  });
});

// PDF do recibo — apenas da própria fração do condomínio ativo (IDOR).
router.get('/recibos/:id/pdf', async (req, res) => {
  const { fracoes } = await contextoFracoes(req);
  const ids = fracoes.map((f) => f.id);
  const recibo = await Recibo.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId, fracao_id: { [Op.in]: ids.length ? ids : [-1] } },
    include: [
      { model: Fracao, as: 'fracao' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor', 'valor_base', 'valor_fcr'] } },
      {
        model: ExtraQuotaParcela,
        as: 'parcelasExtra',
        through: { attributes: ['valor'] },
        include: [{ model: ExtraQuota, as: 'extra_quota', attributes: ['designacao'] }],
      },
    ],
  });
  if (!recibo) {
    return res.status(404).send('Recibo não encontrado.');
  }
  const cond = await getCondominio({ id: req.condominioId });
  const condRow = cond && cond.toJSON ? cond.toJSON() : cond || {};
  const morador = pessoaNomeDoUser(req);
  const resumo = await resumoFracao(recibo.fracao_id);
  const quotas = (recibo.quotas || []).slice().sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
  const pagamentos = await recibosHelper.pagamentosDasQuotas(quotas.map((q) => q.id));
  const extras = (recibo.parcelasExtra || []).map((p) => ({
    designacao: p.extra_quota && p.extra_quota.designacao ? p.extra_quota.designacao : 'Quota extraordinária',
    detalhe: `Parcela ${p.parcela_numero || 1}${p.data_vencimento ? ` — venc. ${String(p.data_vencimento).slice(0, 10)}` : ''}`,
    valorAplicado: p.ReciboExtraParcela && p.ReciboExtraParcela.valor != null ? p.ReciboExtraParcela.valor : p.valor,
  }));
  const cpLocalidade = [condRow.codigo_postal, condRow.localidade].filter(Boolean).join(' ');
  const buffer = await gerarReciboPDF(condRow, {
    numero: recibo.codigo,
    codigoVerificacao: recibo.codigo_verificacao,
    data: recibo.data_emissao || new Date(),
    condominoNome: morador || 'Condómino',
    destinatario: {
      nome: morador || null,
      fracao: recibo.fracao ? recibo.fracao.designacao : null,
      morada: condRow.morada || null,
      codigoPostalLocalidade: cpLocalidade || null,
    },
    fracaoDesignacao: recibo.fracao ? recibo.fracao.designacao : '—',
    fracaoPermilagem: recibo.fracao ? formatarPermilagem(recibo.fracao.permilagem) : null,
    valor: recibo.valor,
    saldoAposPagamento: resumo ? resumo.emDivida : 0,
    anulado: recibo.estado === 'anulado',
    pagamentos,
    quotas: quotas.map((q) => ({
      numero: q.numero_documento || '',
      periodo: recibosHelper.periodoLabel([{ ano: q.ano, mes: q.mes }]),
      valorAplicado: q.ReciboQuota ? q.ReciboQuota.valor : q.valor,
    })),
    extras,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', cabecalhos.disposicao(`recibo_${recibo.codigo}.pdf`, 'inline', 'recibo.pdf'));
  return res.send(buffer);
});

function pessoaNomeDoUser(req) {
  return req.user ? req.user.nome : null;
}

// ── Assembleias (consulta) ──────────────────────────────────────────
// Etiquetas em PT-PT para o estado e o tipo de assembleia. São dados que já
// existem no modelo; aqui só são traduzidos para linguagem de condómino.
const ESTADOS_ASSEMBLEIA = {
  rascunho: { rotulo: 'Rascunho', classe: 'text-bg-secondary' },
  agendada: { rotulo: 'Agendada', classe: 'text-bg-warning' },
  convocada: { rotulo: 'Convocada', classe: 'text-bg-info' },
  realizada: { rotulo: 'Realizada', classe: 'text-bg-success' },
  cancelada: { rotulo: 'Cancelada', classe: 'text-bg-dark' },
};
const TIPOS_ASSEMBLEIA = {
  ordinaria: 'Ordinária',
  extraordinaria: 'Extraordinária',
  urgencia: 'Urgência',
};
// Uma assembleia deixa de ser «próxima» quando a data já passou ou quando o
// estado a encerrou. Não se inventa nenhum estado: só se usa o que existe.
function estadoAssembleia(a) {
  return ESTADOS_ASSEMBLEIA[a.estado] || { rotulo: a.estado || '—', classe: 'text-bg-light border' };
}
function assembleiaEncerrada(a) {
  return ['realizada', 'cancelada'].includes(String(a.estado || ''));
}

router.get('/assembleias', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const hoje = new Date().toISOString().slice(0, 10);
  const assembleias = await Assembleia.findAll({
    where: { condominio_id: req.condominioId },
    order: [['data', 'DESC'], ['id', 'DESC']],
  });
  const comEtiquetas = assembleias.map((a) => {
    const json = a.toJSON();
    const dataISO = json.data ? String(json.data).slice(0, 10) : null;
    return {
      ...json,
      estadoRotulo: estadoAssembleia(json).rotulo,
      estadoClasse: estadoAssembleia(json).classe,
      tipoRotulo: TIPOS_ASSEMBLEIA[json.tipo] || null,
      // «Futura» = data ainda por chegar e não encerrada pela administração.
      eFutura: Boolean(dataISO) && dataISO >= hoje && !assembleiaEncerrada(json),
    };
  });
  // A próxima é a mais próxima no tempo; as passadas ficam por ordem descendente.
  const futuras = comEtiquetas.filter((a) => a.eFutura).sort((a, b) => String(a.data).localeCompare(String(b.data)) || a.id - b.id);
  const passadas = comEtiquetas.filter((a) => !a.eFutura);
  res.render('condomino/assembleias', {
    titulo: 'Assembleias',
    pessoa,
    assembleias: comEtiquetas,
    proxima: futuras.length ? futuras[0] : null,
    outrasFuturas: futuras.slice(1),
    passadas,
  });
});

router.get('/assembleias/:id', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const assembleia = await Assembleia.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [
      { model: require('../models').AgendaItem, as: 'agenda_itens', order: [['ordem', 'ASC']] },
      { model: Documento, as: 'convocatoria' },
      { model: Documento, as: 'ata' },
    ],
  });
  if (!assembleia) return res.status(404).render('error', { titulo: 'Não encontrada', mensagem: 'Assembleia não encontrada.' });
  const anexos = await Documento.findAll({
    where: { condominio_id: req.condominioId, entidade_tipo: 'Assembleia', entidade_id: assembleia.id, disponivel_condominos: true },
    order: [['id', 'DESC']],
  });
  res.render('condomino/assembleia', {
    titulo: assembleia.numero ? `Assembleia ${assembleia.numero}` : 'Assembleia',
    pessoa,
    assembleia: assembleia.toJSON(),
    agenda: assembleia.agenda_itens || [],
    anexos,
    convocatoriaDisponivel: assembleia.convocatoria && assembleia.convocatoria.disponivel_condominos,
    ataDisponivel: assembleia.ata && assembleia.ata.disponivel_condominos,
  });
});

// ── Avisos (leitura) ────────────────────────────────────────────────
// O aviso distingue-se pelo que a aplicação já sabe: os publicados de imediato
// (`createdAt`) e os programados para uma data futura (`data_programada`).
// NÃO existe estado de lido/não lido, urgência nem prioridade — nada disso é
// apresentado, porque não existe no sistema.
router.get('/avisos', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const hoje = new Date().toISOString().slice(0, 10);
  const avisos = await Aviso.findAll({ where: { condominio_id: req.condominioId }, order: [['id', 'DESC']], limit: 100 });
  const dataISO = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const comEtiquetas = avisos.map((a) => {
    const json = a.toJSON();
    const programada = dataISO(json.data_programada);
    let tipoRotulo = null;
    if (json.tipo === 'programado') tipoRotulo = 'Comunicação programada';
    else if (json.tipo === 'automatico') tipoRotulo = 'Comunicação automática';
    return {
      ...json,
      programada,
      // Data mostrada: a de publicação (a programada, quando existe).
      dataMostrada: programada || dataISO(json.createdAt),
      // Por publicar: programada para uma data que ainda não chegou.
      porPublicar: Boolean(programada) && programada > hoje,
      temDocumento: Boolean(json.documento_id),
      tipoRotulo,
    };
  });
  const tipo = String(req.query.tipo || '');
  const filtroTipo = ['publicados', 'programados'].includes(tipo) ? tipo : null;
  const lista = filtroTipo === 'programados'
    ? comEtiquetas.filter((a) => a.porPublicar)
    : filtroTipo === 'publicados'
      ? comEtiquetas.filter((a) => !a.porPublicar)
      : comEtiquetas;
  res.render('condomino/avisos', {
    titulo: 'Avisos e comunicações',
    pessoa,
    avisos: lista,
    nAvisos: comEtiquetas.length,
    nPorPublicar: comEtiquetas.filter((a) => a.porPublicar).length,
    filtroTipo,
  });
});

// ── Calendário (assembleias + avisos programados; leitura) ─────────
// Os eventos são os mesmos de sempre (assembleias não canceladas + avisos
// programados), agora separados em próximos e passados para o telemóvel poder
// mostrar primeiro o que ainda vai acontecer.
router.get('/calendario', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const hoje = new Date().toISOString().slice(0, 10);
  const assembleias = await Assembleia.findAll({
    where: { condominio_id: req.condominioId, estado: { [Op.notIn]: ['cancelada'] } },
    order: [['data', 'ASC'], ['id', 'ASC']],
  });
  const avisos = await Aviso.findAll({
    where: { condominio_id: req.condominioId, data_programada: { [Op.ne]: null } },
    order: [['data_programada', 'ASC']],
  });
  const eventos = [
    ...assembleias.map((a) => ({
      data: a.data,
      tipo: 'assembleia',
      tipoRotulo: 'Assembleia',
      titulo: a.numero ? `Assembleia ${a.numero}` : 'Assembleia de condóminos',
      hora: a.hora || null,
      local: a.local || null,
      detalhe: [a.hora, a.local].filter(Boolean).join(' · ') || null,
      estadoRotulo: estadoAssembleia(a).rotulo,
      link: `/condomino/assembleias/${a.id}`,
    })),
    ...avisos.map((a) => ({
      data: a.data_programada,
      tipo: 'aviso',
      tipoRotulo: 'Comunicação programada',
      titulo: a.assunto,
      hora: null,
      local: null,
      detalhe: null,
      estadoRotulo: null,
      link: '/condomino/avisos',
    })),
  ].sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')));
  // Passados que se mantêm consultáveis, do mais recente para o mais antigo.
  const proximos = eventos.filter((e) => String(e.data || '') >= hoje);
  const passados = eventos.filter((e) => String(e.data || '') < hoje).reverse();
  res.render('condomino/calendario', {
    titulo: 'Calendário',
    pessoa,
    eventos,
    proximos,
    passados,
    proximo: proximos.length ? proximos[0] : null,
  });
});

// ── Documentos públicos do condomínio ───────────────────────────────
// Etiquetas em PT-PT para o tipo de documento. O tipo é um dado que já existe
// no modelo; aqui só é traduzido para linguagem de condómino (nada é inventado).
const TIPOS_DOCUMENTO = {
  aviso_quota: 'Aviso de quota',
  recibo: 'Recibo',
  ata: 'Ata',
  convocatoria: 'Convocatória',
  relatorio: 'Relatório',
  fatura: 'Fatura',
  contrato: 'Contrato',
  orcamento: 'Orçamento',
  comprovativo: 'Comprovativo',
  outro: null,
};

router.get('/documentos', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const pasta = typeof req.query.pasta === 'string' ? req.query.pasta : null;
  const anoFiltro = /^\d{4}$/.test(String(req.query.ano || '')) ? String(req.query.ano) : null;
  const cond = await getCondominio({ id: req.condominioId });
  const mapa = mapaPastas(cond);
  const where = { condominio_id: req.condominioId, disponivel_condominos: true };
  if (pasta && mapa[pasta]) where.pasta = pasta;
  // A data é DATEONLY (texto «AAAA-MM-DD»): o ano pode ser filtrado no próprio
  // SQL, mantendo a consulta única e o isolamento por condomínio.
  if (anoFiltro) where.data = { [Op.between]: [`${anoFiltro}-01-01`, `${anoFiltro}-12-31`] };

  const documentos = await Documento.findAll({
    where,
    order: [['data', 'DESC'], ['id', 'DESC']],
  });

  // Anos disponíveis: obtidos dos mesmos documentos, sem consulta adicional.
  // A lista não depende do ano escolhido (que já filtrou a consulta), por isso é
  // lida sobre o resultado — quando há filtro ativo fica só o ano escolhido.
  const anos = [...new Set(documentos.map((d) => (d.data ? String(d.data).slice(0, 4) : null)).filter(Boolean))].sort().reverse();
  if (anoFiltro && !anos.includes(anoFiltro)) anos.unshift(anoFiltro);

  // Apresentação: data, etiqueta de pasta e etiqueta de tipo por documento.
  const comEtiquetas = documentos.map((d) => {
    const json = d.toJSON();
    return {
      ...json,
      pastaRotulo: mapa[d.pasta] || d.pasta || null,
      tipoRotulo: TIPOS_DOCUMENTO[json.tipo] || null,
      ano: json.data ? String(json.data).slice(0, 4) : null,
    };
  });

  const agrupados = [];
  if (!pasta) {
    const porPasta = new Map();
    for (const d of comEtiquetas) {
      const label = mapa[d.pasta] || d.pasta || 'Outros';
      if (!porPasta.has(label)) porPasta.set(label, { rotulo: label, itens: [] });
      porPasta.get(label).itens.push(d);
    }
    for (const [rotulo, grupo] of porPasta) agrupados.push({ rotulo, itens: grupo.itens });
  }

  const comPasta = Boolean(pasta) || Boolean(anoFiltro);
  res.render('condomino/documentos', {
    titulo: 'Documentos do condomínio',
    pessoa,
    pasta,
    pastas: mapa,
    anos,
    anoFiltro,
    nDocumentos: comEtiquetas.length,
    // Uma das duas listas vai sempre vazia (nunca nula), para a vista poder
    // distinguir «sem documentos» de «sem resultados com estes filtros».
    documentos: comPasta ? comEtiquetas : [],
    agrupados: comPasta ? [] : agrupados,
  });
});

// ── Ficheiro de um documento disponibilizado ao condomínio ──────────
// Área do condómino: além do condomínio ativo (helpers/tenant), só são
// servidos documentos com disponivel_condominos = true. O ficheiro vem do
// provedor de armazenamento através do backend — nunca por link do fornecedor.
router.get('/documentos/:id/ficheiro', async (req, res) => {
  const autorizacao = await autorizarAcessoDocumento({ documentoId: req.params.id, req, area: 'condomino' });
  if (!autorizacao.ok) {
    // 401 sem sessão / 403 de outro condomínio ou não disponibilizado ao
    // condomínio / 404 inexistente. Nunca devolve o documento.
    return responderRecusa(res, autorizacao);
  }
  // Verificação prévia: ver o comentário em routes/documentos.js.
  if (req.query.verificacao === '1') {
    const r = await verificarDocumento({ documento: autorizacao.documento, req });
    return res.json({ ok: r.ok, mensagem: r.ok ? null : r.mensagem, motivo: r.ok ? null : r.motivo });
  }
  const disposicao = req.query.descarregar === '1' ? 'attachment' : 'inline';
  const servido = await servirDocumento({ documento: autorizacao.documento, req, res, disposicao, via: 'sessao_condomino' });
  if (!servido.ok && !res.headersSent) {
    return responderRecusa(res, servido);
  }
  return undefined;
});

// ── Orçamento (consulta; agregação por rubrica/categoria) ──────────
router.get('/orcamento', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const anoAtual = new Date().getFullYear();
  const ano = parseInt(req.query.ano, 10) || anoAtual;

  const orcamento = await Orcamento.findOne({
    // Orçamentos anulados não são apresentados ao condomínio como correntes.
    where: { condominio_id: req.condominioId, ano, estado: { [Op.ne]: 'anulado' } },
    include: [{ model: OrcamentoRubrica, as: 'rubricas', include: [{ model: Categoria, as: 'categoria' }] }],
    order: [['data_inicio', 'DESC']],
  });

  let linhas = [];
  let totais = { orcamentado: 0, executado: 0 };
  if (orcamento) {
    const inicio = `${ano}-01-01`;
    const fim = `${ano}-12-31`;
    linhas = [];
    let orcC = 0;
    let execC = 0;
    for (const rubrica of orcamento.rubricas || []) {
      if (!rubrica.ativo) continue;
      const orcamentado = Number(rubrica.valor_anual) || 0;
      const despesas = await Despesa.findAll({
        where: {
          condominio_id: req.condominioId,
          categoria_id: rubrica.categoria_id || null,
          data: { [Op.between]: [inicio, fim] },
          estado: { [Op.ne]: 'anulada' },
        },
        attributes: ['valor'],
        raw: true,
      });
      const executado = despesas.reduce((s, d) => s + (Number(d.valor) || 0), 0);
      orcC += orcamentado;
      execC += executado;
      linhas.push({
        nome: (rubrica.categoria && rubrica.categoria.nome) || rubrica.descricao || 'Sem categoria',
        orcamentado,
        executado,
        percentagem: orcamentado > 0 ? Math.round((executado / orcamentado) * 100) : 0,
      });
    }
    totais = { orcamentado: orcC, executado: execC };
  }
  totais.percentagem = totais.orcamentado > 0 ? Math.round((totais.executado / totais.orcamentado) * 100) : 0;
  totais.saldo = totais.orcamentado - totais.executado;

  res.render('condomino/orcamento', {
    titulo: 'Orçamento',
    pessoa,
    ano,
    anoAtual,
    orcamento: orcamento ? orcamento.toJSON() : null,
    linhas,
    totais,
  });
});

// ── Situação financeira (agregada — sem dados pessoais de terceiros) ──
//
// Página de transparência do condomínio: só valores AGREGADOS (e, quando muito,
// a posição financeira das frações do próprio utilizador, que são suas). Nunca
// são apresentados nomes, contactos, frações de terceiros, nem valores de
// dívida imputáveis a outra fração.
//
// Tudo o que é apresentado vem de dados existentes: quotas, pagamentos,
// despesas, contas bancárias e orçamento do condomínio ATIVO. Nenhuma métrica é
// estimada — quando não há dados, a secção mostra um estado vazio.
async function paginaSituacaoFinanceira(req, res) {
  const { pessoa, fracoes } = await contextoFracoes(req);
  const anoAtual = new Date().getFullYear();
  const mesCorrenteAtual = new Date().getMonth() + 1;

  const [resumo, orcamento] = await Promise.all([
    resumoFinanceiro(anoAtual, req.condominioId),
    resumoOrcamento(anoAtual, req.condominioId),
  ]);

  // Evolução do ano: mesmos valores do resumo, organizados por mês.
  const evolucao = evolucaoMensal(resumo);
  const movimentos = evolucao.meses.map((m) => ({
    ...m,
    nome: MESES[m.mes - 1],
    atual: m.mes === mesCorrenteAtual,
  }));

  // Posição de cada fração do próprio utilizador (conta-corrente: quotas
  // ordinárias + extraordinárias processadas − pagamentos confirmados).
  const minhasFracoes = [];
  for (const f of fracoes) {
    const cc = await contaCorrente.contaCorrenteFracao({ condominioId: req.condominioId, fracaoId: f.id })
      .catch(() => null);
    if (!cc) continue;
    minhasFracoes.push({
      id: f.id,
      designacao: f.designacao,
      emDivida: cc.emDivida,
      saldo: cc.saldo,
      quotasEmDivida: cc.quotasEmDivida,
      extrasEmDivida: cc.extrasEmDivida,
      temCredito: cc.temCredito,
    });
  }

  return res.render('condomino/situacao-financeira', {
    titulo: 'Situação financeira',
    pessoa,
    ano: anoAtual,
    resumo,
    orcamento,
    // Quanto do orçamento ainda não foi executado (negativo = acima do previsto).
    saldoOrcamento: orcamento.orcamentado - orcamento.executado,
    movimentos,
    temMovimentos: evolucao.temMovimentos,
    mesesComMovimentos: evolucao.mesesComMovimentos,
    minhasFracoes,
    temDivida: minhasFracoes.some((f) => f.emDivida),
  });
}

// Endereço atual da página (diz o que a página é).
router.get('/situacao-financeira', paginaSituacaoFinanceira);
// Endereço anterior: mantém-se a responder com a MESMA página (nunca um
// redirecionamento que possa perder a ligação), para não quebrar atalhos,
// separadores abertos nem ligações já partilhadas.
router.get('/situacao', paginaSituacaoFinanceira);

module.exports = router;