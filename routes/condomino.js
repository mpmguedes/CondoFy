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
const { resumoFracao, resumoCondominio, resumoOrcamento, estadoEfetivo } = require('../helpers/saldos');
const { getCondominio } = require('../helpers/condominio');
const { gerarReciboPDF } = require('../helpers/pdf');
const cabecalhos = require('../helpers/cabecalhos-ficheiro');
const recibosHelper = require('../helpers/recibos');
const { mapaPastas } = require('../helpers/documento-pastas');
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
    .slice(0, 6);

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
  });
});

// ── As minhas quotas (leitura; filtros ano/estado) ─────────────────
router.get('/quotas', async (req, res) => {
  const { pessoa, fracoes } = await contextoFracoes(req);
  const ids = fracoes.map((f) => f.id);
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
    .filter((l) => !estado || l.estadoEfetivo === estado);

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
      };
    }),
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
    return json;
  });
  res.render('condomino/recibos', { titulo: 'Os meus recibos', pessoa, linhas });
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
router.get('/assembleias', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const assembleias = await Assembleia.findAll({
    where: { condominio_id: req.condominioId },
    order: [['data', 'DESC'], ['id', 'DESC']],
  });
  res.render('condomino/assembleias', { titulo: 'Assembleias', pessoa, assembleias });
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
router.get('/avisos', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const avisos = await Aviso.findAll({ where: { condominio_id: req.condominioId }, order: [['id', 'DESC']], limit: 100 });
  res.render('condomino/avisos', { titulo: 'Avisos e comunicações', pessoa, avisos });
});

// ── Calendário (assembleias + avisos programados; leitura) ─────────
router.get('/calendario', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const hoje = new Date().toISOString().slice(0, 10);
  const assembleias = await Assembleia.findAll({
    where: { condominio_id: req.condominioId, estado: { [Op.notIn]: ['cancelada'] } },
    order: [['data', 'ASC'], ['id', 'ASC']],
  });
  const avisos = await Aviso.findAll({
    where: { condominio_id: req.condominioId, data_programada: { [Op.gte]: hoje } },
    order: [['data_programada', 'ASC']],
  });
  const eventos = [
    ...assembleias.map((a) => ({
      data: a.data,
      tipo: 'assembleia',
      titulo: a.numero ? `Assembleia ${a.numero}` : 'Assembleia',
      detalhe: [a.hora, a.local].filter(Boolean).join(' · ') || null,
      link: `/condomino/assembleias/${a.id}`,
    })),
    ...avisos.map((a) => ({ data: a.data_programada, tipo: 'aviso', titulo: a.assunto, detalhe: null, link: '/condomino/avisos' })),
  ].sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')));
  res.render('condomino/calendario', { titulo: 'Calendário', pessoa, eventos });
});

// ── Documentos públicos do condomínio ───────────────────────────────
router.get('/documentos', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const pasta = typeof req.query.pasta === 'string' ? req.query.pasta : null;
  const cond = await getCondominio({ id: req.condominioId });
  const mapa = mapaPastas(cond);
  const where = { condominio_id: req.condominioId, disponivel_condominos: true };
  if (pasta && mapa[pasta]) where.pasta = pasta;
  const documentos = await Documento.findAll({
    where,
    order: [['data', 'DESC'], ['id', 'DESC']],
  });
  const agrupados = [];
  if (!pasta) {
    const porPasta = new Map();
    for (const d of documentos) {
      const label = mapa[d.pasta] || d.pasta;
      if (!porPasta.has(label)) porPasta.set(label, { rotulo: label, itens: [] });
      porPasta.get(label).itens.push(d);
    }
    for (const [rotulo, grupo] of porPasta) agrupados.push({ rotulo, itens: grupo.itens });
  }
  res.render('condomino/documentos', {
    titulo: 'Documentos do condomínio',
    pessoa,
    pasta,
    pastas: mapa,
    documentos: pasta ? documentos : null,
    agrupados: pasta ? null : agrupados,
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
router.get('/situacao', async (req, res) => {
  const { pessoa } = await contextoFracoes(req);
  const ano = new Date().getFullYear();
  const inicio = `${ano}-01-01`;
  const fim = `${ano}-12-31`;

  const [resumo, quotasAno, receitasAno, despesasAno, nFracoes] = await Promise.all([
    resumoCondominio(req.condominioId),
    Quota.findAll({ where: { condominio_id: req.condominioId, ano, estado: { [Op.ne]: 'anulada' } }, raw: true }),
    Pagamento.sum('valor', { where: { condominio_id: req.condominioId, estado: 'confirmado', data_pagamento: { [Op.between]: [inicio, fim] } } }),
    Despesa.sum('valor', { where: { condominio_id: req.condominioId, estado: { [Op.ne]: 'anulada' }, data: { [Op.between]: [inicio, fim] } } }),
    Fracao.count({ where: { condominio_id: req.condominioId } }),
  ]);

  const totalQuotasC = quotasAno.reduce((s, q) => s + Math.round((Number(q.valor) || 0) * 100), 0);
  const pagoMap = await recibosHelper.pagoPorQuota(quotasAno.map((q) => q.id));
  let pagoC = 0;
  for (const q of quotasAno) pagoC += pagoMap.get(q.id) || 0;
  const dividaC = Math.max(0, totalQuotasC - pagoC);
  const cobrancaPct = totalQuotasC > 0 ? Math.round((pagoC / totalQuotasC) * 100) : 0;

  // Frações com quota em atraso (agregado — apenas contagem, sem nomes).
  const emAtraso = new Set();
  for (const q of quotasAno) {
    if (estadoEfetivo(q) === 'vencida') {
      const aberto = Math.round((Number(q.valor) || 0) * 100) - (pagoMap.get(q.id) || 0);
      if (aberto > 0) emAtraso.add(q.fracao_id);
    }
  }

  res.render('condomino/situacao', {
    titulo: 'Situação financeira',
    pessoa,
    ano,
    resumo,
    nFracoes,
    receitasAno: Number(receitasAno) || 0,
    despesasAno: Number(despesasAno) || 0,
    saldoAno: (Number(receitasAno) || 0) - (Number(despesasAno) || 0),
    totalQuotas: totalQuotasC / 100,
    pagoQuotas: pagoC / 100,
    divida: dividaC / 100,
    cobrancaPct,
    nFracoesEmAtraso: emAtraso.size,
  });
});

module.exports = router;