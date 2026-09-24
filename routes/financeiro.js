const express = require('express');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { toDateInput } = require('../helpers/dates');
const { validarIban } = require('../public/js/validacao-fiscal');
const {
  ContaBancaria,
  Categoria,
  MetodoPagamento,
  Despesa,
  Quota,
  Pagamento,
  PagamentoQuota,
  Fracao,
  Orcamento,
  OrcamentoRubrica,
  Documento,
  Fornecedor,
  EmailFila,
  ExtraQuota,
  ExtraQuotaParcela,
  PagamentoExtraParcela,
  Recibo,
  ReciboQuota,
  ReciboExtraParcela,
  AgendaItem,
  Assembleia,
  MovimentoBancario,
} = require('../models');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { toCents, fromCents, toNumber, formatEURCents } = require('../helpers/money');
const { MESES, monthName, currentYear } = require('../helpers/dates');
const { resumoCondominio, resumoFracao, estadoEfetivo } = require('../helpers/saldos');
const { getCondominio } = require('../helpers/condominio');
const { PASTAS_BASE, resolverPastaDocumento } = require('../helpers/documento-pastas');
const { proximoNumero } = require('../helpers/numeracao');
const { registarPagamento, registarPagamentoComItens, anularPagamento } = require('../helpers/pagamentos');
const recibos = require('../helpers/recibos');
const quotaModulo = require('./quotas-modulo');
const { uploadComprovativo, apagarComprovativo } = require('../helpers/comprovativos');
const { sincronizarMovimentoDespesa } = require('../helpers/movimentos');
const extrato = require('../helpers/extrato');
// R10 — imutabilidade financeira de uma quota emitida (lógica pura).
const {
  estaEmitida, alteracoesCongeladas, invarianteOk, isoData,
} = require('../helpers/quota-imutabilidade');
// Q9 — pré-visualização da configuração de quotas (só leitura).
const { previsaoRecalculo } = require('../helpers/quotas-previsao');
// Lê e valida os filtros do extrato a partir da query string (nunca o
// condomínio — esse vem sempre da sessão).
const lerFiltrosExtrato = extrato.lerFiltros;
const { gerarAvisoQuotaPDF, gerarReciboPDF } = require('../helpers/pdf');
const cabecalhos = require('../helpers/cabecalhos-ficheiro');
const { compor: comporEmail, nomeFicheiro: nomeFicheiroEmail } = require('../helpers/email-templates');
const { resolverDestinatarios } = require('../helpers/avisos');
const titulares = require('../helpers/titularidades');
const { enfileirarEmail } = require('../helpers/email-fila');
const { estaAtivo } = require('../helpers/notificacoes');
// P54-7 — as automações são POR CONDOMÍNIO: toda a leitura leva o condomínio
// ativo. Sem ele leria-se a chave herdada (global) e a decisão de UM
// condomínio passaria a governar a geração de quotas de TODOS.
const { estaAtivo: automacaoAtiva } = require('../helpers/automacoes');
const background = require('../helpers/background-jobs');
const { getQuotaConfig, setQuotaConfig, validarFcrPercentagem } = require('../helpers/quotas-config');
const { calcularQuota, calcularQuotasOrcamento } = require('../helpers/quotas-calc');
const { resumoFcr, transferirFcr, transferirFcrAprovado } = require('../helpers/fcr');
const {
  deliberacoesAprovadas,
  carregarDeliberacao,
  deliberacaoComUtilizacao,
  validarAssociacaoDespesa,
} = require('../helpers/fcr-deliberacoes');
const { validarPermilagem } = require('../helpers/permilagem');
const storage = require('../helpers/storage');

const router = express.Router();

// Isolamento: condomínio ativo (sessão validada) nas operações deste módulo.
router.use(tenant.comCondominioAtivo);

// ── Suporte diagnóstico: admissão explícita DESTE módulo ───────────
// A allow-list é partilhada (`helpers/suporte-allowlist.js`); aqui declara-se
// apenas que este router admite o suporte nas rotas que lá constam para o
// módulo `financeiro`. Fora disso, o pedido segue para a guarda de papel.
const allowlistSuporte = require('../helpers/suporte-allowlist');
router.use(allowlistSuporte.soDiagnostico('financeiro'));

// Guarda de papel CONDICIONAL (única): contornada só pelo suporte ADMITIDO.
// Um `router.use(tenant.comPapel('gestor'))` incondicional a seguir anularia a
// admissão — o Express corre os dois e o segundo recusaria o pedido admitido.
router.use(allowlistSuporte.comPapelOuSuporteAdmitido('gestor'));

// Carregadores restritos ao condomínio ativo (bloqueiam IDOR).
function carregarConta(req) {
  return ContaBancaria.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
}
function carregarDespesa(req) {
  return Despesa.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: AgendaItem, as: 'deliberacao', include: [{ model: Assembleia, as: 'assembleia', attributes: ['id', 'numero', 'data'] }] }],
  });
}
function ondeCondominio(req, extra = {}) {
  return { condominio_id: req.condominioId, ...extra };
}

function toArray(v) {
  if (v === null || v === undefined || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function parseDecimal(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

// Detalhes de auditoria da ligação Despesa ↔ Deliberação do FCR. Só é
// preenchido quando a despesa tem deliberação: as despesas correntes mantêm os
// eventos de auditoria exatamente como estavam.
function detalhesFcrDespesa(deliberacaoId, validada) {
  if (!deliberacaoId) return undefined;
  return {
    deliberacaoId: Number(deliberacaoId),
    assembleiaId: validada && validada.deliberacao && validada.deliberacao.assembleia
      ? Number(validada.deliberacao.assembleia.id)
      : null,
    valorAprovadoC: validada ? validada.valorAprovadoC : null,
    jaAssociadoC: validada ? validada.jaAssociadoC : null,
    disponivelC: validada ? validada.disponivelC : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// CONTAS BANCÁRIAS
// ═══════════════════════════════════════════════════════════════════
router.get('/contas', async (req, res) => {
  const contas = await ContaBancaria.findAll({ where: ondeCondominio(req), order: [['nome', 'ASC']] });
  const resumo = await resumoCondominio(req.condominioId);
  const saldoPorId = {};
  resumo.contas.forEach((c) => (saldoPorId[c.id] = c.saldo));
  const linhas = contas.map((c) => ({ ...c.toJSON(), saldo: saldoPorId[c.id] }));
  // Vista de SUPORTE: IBAN mascarado (`maskIban`) e sem ações de escrita. A
  // vista administrativa (com o IBAN completo e a edição) não é tocada.
  const vista = req.suporte ? 'admin/contas/listar-suporte' : 'admin/contas/listar';
  res.render(vista, { titulo: 'Contas bancárias', contas: linhas, resumo });
});

router.get('/contas/nova', (req, res) => {
  res.render('admin/contas/form', { titulo: 'Nova conta bancária', conta: null });
});

// Rotas do Fundo de Reserva registadas AQUI, antes de qualquer `/contas/:id…`:
// o Express usa a primeira rota que casa, e `transferir-fcr` era apanhado por
// `/contas/:id` (que respondia "conta não encontrada" e redirecionava para
// /admin/contas, sem criar movimento nenhum).
registarRotasFundoReserva();

router.post('/contas', async (req, res) => {
  const { nome, banco, iban, tipo, saldo_inicial } = req.body;
  const ibanValidado = validarIban(iban);
  if (!ibanValidado.ok) {
    req.flash('error_msg', ibanValidado.mensagem);
    return res.redirect('/admin/contas/nova');
  }
  const conta = await ContaBancaria.create({
    condominio_id: req.condominioId,
    nome,
    banco,
    iban: ibanValidado.valor || null,
    tipo: tipo || 'corrente',
    saldo_inicial: toNumber(saldo_inicial),
  });
  await audit({ userId: req.user.id, acao: 'criar_conta_bancária', entidade: 'ContaBancaria', entidadeId: conta.id });
  req.flash('success_msg', 'Conta bancária criada.');
  res.redirect('/admin/contas');
});

// Rotas paramétricas de conta: o `:id` é restrito a dígitos (`:id(\d+)`) para
// que nenhum caminho literal futuro de `/contas/...` volte a ser interpretado
// como id de conta. Um id não numérico não casa aqui (404) em vez de cair num
// "conta não encontrada" silencioso.
router.get('/contas/:id(\\d+)/editar', async (req, res) => {
  const conta = await carregarConta(req);
  if (!conta) {
    req.flash('error_msg', 'Conta bancária não encontrada neste condomínio.');
    return res.redirect('/admin/contas');
  }
  res.render('admin/contas/form', { titulo: 'Editar conta bancária', conta });
});

router.post('/contas/:id(\\d+)', async (req, res) => {
  const conta = await carregarConta(req);
  if (!conta) {
    req.flash('error_msg', 'Conta bancária não encontrada neste condomínio.');
    return res.redirect('/admin/contas');
  }
  const { nome, banco, iban, tipo, saldo_inicial, ativa } = req.body;
  const ibanValidado = validarIban(iban);
  if (!ibanValidado.ok) {
    req.flash('error_msg', ibanValidado.mensagem);
    return res.redirect(`/admin/contas/${conta.id}/editar`);
  }
  await conta.update({
    nome,
    banco,
    iban: ibanValidado.valor || null,
    tipo: tipo || 'corrente',
    saldo_inicial: toNumber(saldo_inicial),
    ativa: ativa === 'on' || ativa === '1' || ativa === true,
  });
  await audit({ userId: req.user.id, acao: 'editar_conta_bancária', entidade: 'ContaBancaria', entidadeId: conta.id });
  req.flash('success_msg', 'Conta bancária atualizada.');
  res.redirect('/admin/contas');
});

router.post('/contas/:id(\\d+)/eliminar', async (req, res) => {
  const conta = await carregarConta(req);
  if (!conta) {
    req.flash('error_msg', 'Conta bancária não encontrada neste condomínio.');
    return res.redirect('/admin/contas');
  }

  // Uma conta com histórico de movimentos NÃO pode ser eliminada: a FK
  // movimentos_bancarios.conta_bancaria_id é ON DELETE RESTRICT, pelo que o
  // destroy() rebentava com um erro de constraint e a rota devolvia 500
  // («Erro interno») — sem dizer ao utilizador o que se passou.
  //
  // Apagar a conta levaria o histórico bancário com ela (não é possível manter
  // um movimento sem conta: a coluna é NOT NULL com FK RESTRICT). Por isso a
  // única política coerente com o modelo existente é RECUSAR a eliminação e
  // sugerir a desativação — a conta fica fora dos saldos (só contas `ativa` são
  // consideradas em resumoCondominio) sem perder o histórico.
  const nMovimentos = await MovimentoBancario.count({ where: { conta_bancaria_id: conta.id } });
  if (nMovimentos > 0) {
    req.flash(
      'error_msg',
      `Não é possível eliminar «${conta.nome}»: tem ${nMovimentos} movimento(s) bancário(s) associado(s). `
      + 'Desative a conta em vez de a eliminar, para preservar o histórico.'
    );
    return res.redirect('/admin/contas');
  }

  await conta.destroy();
  await audit({ userId: req.user.id, acao: 'eliminar_conta_bancária', entidade: 'ContaBancaria', entidadeId: req.params.id });
  req.flash('success_msg', 'Conta bancária eliminada.');
  res.redirect('/admin/contas');
});

// ═══════════════════════════════════════════════════════════════════
// FUNDO DE RESERVA — movimento entre contas, nos dois sentidos
//
// (As duas rotas estão registadas ACIMA das rotas paramétricas de conta — ver
// `/contas/nova` — e as paramétricas limitam o `:id` a dígitos: um caminho
// literal como `transferir-fcr` nunca pode ser interpretado como `:id`.)
//
// · Corrente → Fundo de Reserva: o FCR recebido (parte das quotas efetivamente
//   pagas que corresponde ao fundo) é passado para a conta do tipo
//   `fundo_reserva`.
// · Fundo de Reserva → Corrente: UTILIZAÇÃO do fundo, só com deliberação de
//   assembleia aprovada e dentro do valor ainda disponível dessa deliberação.
//
// Em ambos os sentidos cria-se um par de movimentos (saída na origem, entrada no
// destino) e a operação é uma transferência entre contas do condomínio: NUNCA
// receita nem despesa nos relatórios.
//
// O corpo das duas rotas vive em `registarRotasFundoReserva`, chamado logo após
// `/contas/nova` (antes de `/contas/:id(\d+)`), para que a ordem de registo seja
// impossível de inverter por engano ao editar o ficheiro.
// ═══════════════════════════════════════════════════════════════════
function registarRotasFundoReserva() {
router.get('/contas/transferir-fcr', async (req, res) => {
  const [contas, resumo, fcr, deliberacoes] = await Promise.all([
    ContaBancaria.findAll({ where: { condominio_id: req.condominioId, ativa: true }, order: [['nome', 'ASC']] }),
    resumoCondominio(req.condominioId),
    resumoFcr(req.condominioId, { incluirDetalhe: true }),
    // Apenas deliberações aprovadas, em assembleia que já delibera, e já com o
    // valor disponível calculado (valor aprovado − utilizado).
    deliberacoesAprovadas({ condominioId: req.condominioId }),
  ]);
  const saldoPorId = {};
  (resumo.contas || []).forEach((c) => (saldoPorId[c.id] = c.saldo));
  // O saldo é associado pelo ID da conta (nunca pela posição: as duas listas não
  // têm a mesma ordenação e o saldo podia aparecer trocado).
  const contasComSaldo = contas.map((c) => ({ ...c.toJSON(), saldo: saldoPorId[c.id] }));
  const contasFcr = contasComSaldo.filter((c) => c.tipo === 'fundo_reserva');
  const comDisponivel = deliberacoes.filter((d) => d.disponivelC > 0);
  res.render('admin/contas/transferir-fcr', {
    titulo: 'Movimentos do Fundo de Reserva',
    contas: contasComSaldo,
    contasFcr,
    contasNaoFcr: contasComSaldo.filter((c) => c.tipo !== 'fundo_reserva'),
    fcr,
    deliberacoes: comDisponivel,
    nDeliberacoesSemSaldo: deliberacoes.length - comDisponivel.length,
    hoje: new Date().toISOString().slice(0, 10),
  });
});

router.post('/contas/transferir-fcr', async (req, res) => {
  const valorC = toCents(parseDecimal(req.body.valor, 0));
  const contaOrigemId = parseInt(req.body.conta_origem_id, 10) || null;
  const contaDestinoId = parseInt(req.body.conta_destino_id, 10) || null;
  const sentido = req.body.sentido === 'fcr_para_corrente' ? 'fcr_para_corrente' : 'corrente_para_fcr';
  try {
    // Utilização do FCR (fundo → corrente): exige deliberação aprovada com
    // saldo disponível; a cadeia deliberação → item → assembleia → condomínio é
    // validada dentro da operação, nunca a partir do formulário.
    if (sentido === 'fcr_para_corrente') {
      const deliberacaoId = parseInt(req.body.deliberacao_id, 10) || null;
      const r = await transferirFcrAprovado({
        condominioId: req.condominioId,
        deliberacaoId,
        contaOrigemId,
        contaDestinoId,
        valorC,
        data: req.body.data || new Date(),
        descricao: String(req.body.descricao || '').trim() || null,
        userId: req.user.id,
      });
      if (!r.ok) {
        req.flash('error_msg', r.mensagem || 'Não foi possível registar a utilização do Fundo de Reserva.');
        return res.redirect('/admin/contas/transferir-fcr');
      }
      await audit({
        userId: req.user.id,
        acao: 'utilizar_fcr',
        entidade: 'AgendaItem',
        entidadeId: r.deliberacaoId,
        detalhes: {
          deliberacaoId: r.deliberacaoId,
          assembleiaId: r.assembleiaId,
          valor: fromCents(r.valorC),
          contaOrigemId,
          contaDestinoId,
          saidaId: r.saidaId,
          entradaId: r.entradaId,
          disponivelApos: fromCents(r.disponivelAprovadoC),
        },
      });
      req.flash(
        'success_msg',
        `Utilização de ${fromCents(r.valorC).toFixed(2).replace('.', ',')} € do Fundo de Reserva registada (é uma transferência entre contas, não uma despesa). Valor ainda disponível nesta deliberação: ${fromCents(r.disponivelAprovadoC).toFixed(2).replace('.', ',')} €.`
      );
      return res.redirect('/admin/contas/transferir-fcr');
    }

    const r = await transferirFcr({
      condominioId: req.condominioId,
      contaOrigemId,
      contaDestinoId,
      valorC,
      data: req.body.data || new Date(),
      descricao: String(req.body.descricao || '').trim() || null,
      userId: req.user.id,
    });
    if (!r.ok) {
      req.flash('error_msg', r.mensagem || 'Não foi possível registar a transferência.');
      return res.redirect('/admin/contas/transferir-fcr');
    }
    await audit({
      userId: req.user.id,
      acao: 'transferir_fcr',
      entidade: 'ContaBancaria',
      entidadeId: contaDestinoId,
      detalhes: { valor: fromCents(r.valorC), origem: r.contaOrigem, destino: r.contaDestino, saidaId: r.saidaId, entradaId: r.entradaId },
    });
    req.flash(
      'success_msg',
      `Transferência de ${fromCents(r.valorC).toFixed(2).replace('.', ',')} € registada (não é despesa: transferência entre contas). FCR disponível: ${fromCents(r.disponivelC).toFixed(2).replace('.', ',')} €.`
    );
    res.redirect('/admin/contas/transferir-fcr');
  } catch (err) {
    console.error('[fcr-transferencia]', err);
    req.flash('error_msg', 'Erro ao registar o movimento. Nenhum movimento foi criado.');
    res.redirect('/admin/contas/transferir-fcr');
  }
});
}

// ═══════════════════════════════════════════════════════════════════
// EXTRATO BANCÁRIO
//
// Consulta cronológica dos movimentos do condomínio, com filtros por conta,
// período e tipo, e saldo corrente por movimento.
//
// Toda a lógica de consulta e de cálculo vive em `helpers/extrato.js`; aqui
// só se leem os parâmetros, se resolve o condomínio (sempre da SESSÃO, via
// tenant.comCondominioAtivo) e se apresenta.
//
// Só de leitura, exceto a anulação lógica (POST .../anular), que preserva o
// registo e não afeta o saldo. A edição de um movimento com origem
// operacional (pagamento/despesa/quota extra) NÃO é feita aqui: faz-se na
// entidade de origem, pelo fluxo que já existe.
// ═══════════════════════════════════════════════════════════════════

// Período por omissão: o ano corrente, igual ao Relatório Financeiro. Não se
// inventa um intervalo arbitrário — segue-se o padrão já estabelecido.
function periodoOmissaoExtrato() {
  const ano = currentYear();
  return { inicio: `${ano}-01-01`, fim: `${ano}-12-31` };
}

router.get('/movimentos', async (req, res) => {
  const filtros = lerFiltrosExtrato(req.query);
  const omissao = periodoOmissaoExtrato();
  // Sem parâmetros no URL, aplica-se o período por omissão; assim que o
  // utilizador filtra (mesmo que limpe as datas), respeita-se a escolha.
  const semParametros = !req.query.inicio && !req.query.fim && !req.query.conta
    && !req.query.tipo && !req.query.estado;
  const efetivos = semParametros ? { ...filtros, inicio: omissao.inicio, fim: omissao.fim } : filtros;

  const [contas, dados] = await Promise.all([
    extrato.contasDoCondominio(req.condominioId),
    extrato.extrato({ condominioId: req.condominioId, filtros: efetivos }),
  ]);

  // Conta inexistente OU de outro condomínio: mesmo tratamento. Não se revela
  // a existência de contas de outros condomínios.
  if (efetivos.conta && !dados.conta) {
    req.flash('error_msg', 'Conta bancária não encontrada neste condomínio.');
    return res.redirect('/admin/movimentos');
  }

  return res.render('admin/movimentos/listar', {
    titulo: 'Extrato bancário',
    suporteDiagnostico: Boolean(req.suporte),
    contas: contas.map((c) => ({
      id: c.id, nome: c.nome, banco: c.banco, tipo: c.tipo, ativa: c.ativa,
    })),
    contaSelecionada: dados.conta,
    filtros: efetivos,
    linhas: dados.linhas,
    temMovimentos: dados.temMovimentos,
    resumo: dados.resumo,
    // Ligação de limpeza: sem filtros nenhuns (reaparece o período por omissão).
    urlLimpar: '/admin/movimentos',
  });
});

// Anulação lógica de um movimento MANUAL (ajuste). Preserva o registo: só
// muda o estado. Um movimento com origem operacional é recusado aqui — a
// correção faz-se na entidade de origem, para não criar divergência.
router.post('/movimentos/:id(\\d+)/anular', async (req, res) => {
  // O where inclui o condomínio: um movimento de outro condomínio é
  // indistinguível de um inexistente (nunca 500, nunca 403 revelador).
  const movimento = await MovimentoBancario.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
  });
  if (!movimento) {
    req.flash('error_msg', 'Movimento não encontrado neste condomínio.');
    return res.redirect('/admin/movimentos');
  }
  if (movimento.estado === 'anulado') {
    req.flash('error_msg', 'Este movimento já está anulado.');
    return res.redirect('/admin/movimentos');
  }

  const categoria = extrato.categoriaDe(movimento);
  if (categoria !== extrato.CATEGORIAS.ajuste) {
    req.flash(
      'error_msg',
      `Este movimento tem origem em «${extrato.ETIQUETAS[categoria]}» e não pode ser anulado no extrato. `
      + 'Corrija o registo na origem, para o extrato e a origem não ficarem divergentes.'
    );
    return res.redirect('/admin/movimentos');
  }

  await movimento.update({ estado: 'anulado' });
  await audit({
    userId: req.user.id,
    acao: 'anular_movimento_bancario',
    entidade: 'MovimentoBancario',
    entidadeId: movimento.id,
  });
  req.flash('success_msg', 'Movimento anulado. Continua visível no extrato e não afeta o saldo.');
  return res.redirect('/admin/movimentos');
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORIAS
// ═══════════════════════════════════════════════════════════════════
router.get('/categorias', async (req, res) => {
  const categorias = await Categoria.findAll({ order: [['tipo', 'ASC'], ['nome', 'ASC']] });
  res.render('admin/categorias/listar', { titulo: 'Categorias', categorias });
});

router.post('/categorias', async (req, res) => {
  const { nome, tipo } = req.body;
  await Categoria.create({ nome, tipo: tipo || 'despesa' });
  req.flash('success_msg', 'Categoria criada.');
  res.redirect('/admin/categorias');
});

router.post('/categorias/:id', async (req, res) => {
  const cat = await Categoria.findByPk(req.params.id);
  if (cat) {
    const { nome, tipo, ativa } = req.body;
    await cat.update({ nome, tipo: tipo || 'despesa', ativa: ativa === 'on' || ativa === '1' || ativa === true });
  }
  req.flash('success_msg', 'Categoria atualizada.');
  res.redirect('/admin/categorias');
});

router.post('/categorias/:id/eliminar', async (req, res) => {
  const cat = await Categoria.findByPk(req.params.id);
  if (cat) await cat.destroy();
  req.flash('success_msg', 'Categoria eliminada.');
  res.redirect('/admin/categorias');
});

// ═══════════════════════════════════════════════════════════════════
// DESPESAS
// ═══════════════════════════════════════════════════════════════════

// Rollback que nunca rebenta. Quando o próprio `commit()` falha (deadlock no
// fecho, ligação perdida), a transação já caiu do lado do servidor e o
// `rollback()` pode ele próprio lançar — o que mascararia o erro original e
// deixaria o utilizador sem resposta. O erro do rollback é registado, não
// propagado.
async function rollbackSilencioso(t) {
  try {
    await t.rollback();
  } catch (e) {
    console.error('[transacao] rollback falhou:', e.message);
  }
}

router.get('/despesas', async (req, res) => {
  const despesas = await Despesa.findAll({
    where: ondeCondominio(req),
    include: [
      { model: Categoria, as: 'categoria' },
      { model: ContaBancaria, as: 'conta_bancaria' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      // Deliberação que autoriza a despesa com Fundo de Reserva (badge na lista).
      { model: AgendaItem, as: 'deliberacao', include: [{ model: Assembleia, as: 'assembleia', attributes: ['id', 'numero', 'data'] }] },
    ],
    order: [['data', 'DESC']],
  });
  res.render('admin/despesas/listar', { titulo: 'Despesas', despesas, suporteDiagnostico: Boolean(req.suporte) });
});

// Deliberações aprovadas com valor ainda disponível para despesas (só as que
// podem ser escolhidas no formulário). Reutiliza o cálculo já existente.
async function deliberacoesParaDespesa(req) {
  const deliberacoes = await deliberacoesAprovadas({ condominioId: req.condominioId });
  return deliberacoes.filter((d) => d.disponivelC > 0);
}

router.get('/despesas/nova', async (req, res) => {
  const [categorias, contas, metodos, fornecedores, deliberacoes] = await Promise.all([
    Categoria.findAll({ where: { tipo: 'despesa', ativa: true }, order: [['nome', 'ASC']] }),
    ContaBancaria.findAll({ where: ondeCondominio(req, { ativa: true }), order: [['nome', 'ASC']] }),
    MetodoPagamento.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] }),
    // Fornecedores apenas do condomínio ativo (cada condomínio tem a sua lista).
    Fornecedor.findAll({ where: { condominio_id: req.condominioId, ativo: true }, order: [['nome', 'ASC']] }),
    deliberacoesParaDespesa(req),
  ]);
  res.render('admin/despesas/form', { titulo: 'Nova despesa', despesa: null, categorias, contas, metodos, fornecedores, deliberacoes });
});

router.post('/despesas', async (req, res) => {
  const { descricao, categoria_id, valor, data, fornecedor, conta_bancaria_id, metodo_pagamento_id, observacoes, estado } = req.body;
  const dataObj = data ? new Date(data) : new Date();
  // ⚠️ O número é reservado FORA da transação, de propósito. `numeracoes` é uma
  // série GLOBAL: quando `proximoNumero` recebe uma transação, grava o
  // incremento da sequência NESSA transação — e um abort posterior desfaria o
  // incremento, deixando a série PRESA a recomputar o mesmo número em cada
  // tentativa (foi a causa do incidente de numeração em pagamentos). Sem
  // transação, o incremento é autónomo: um abort deixa no máximo um SALTO na
  // série — aceitável; um número repetido, não. A série 'despesa' não tem
  // (ainda) predicado `jaUsado`, logo esta ordem é deliberada e não deve ser
  // "corrigida" para dentro da transação.
  const numero = await proximoNumero('despesa', { ano: dataObj.getFullYear() });

  // Conta bancária da despesa tem de pertencer ao condomínio ativo (IDOR).
  let contaId = parseInt(conta_bancaria_id, 10) || null;
  if (contaId) {
    const conta = await ContaBancaria.findOne({ where: { id: contaId, condominio_id: req.condominioId } });
    contaId = conta ? conta.id : null;
  }

  // Fornecedor: estruturado (id) com texto legado sincronizado para compatibilidade.
  // O fornecedor tem de pertencer ao condomínio ativo (nunca um id de outro).
  let fornecedor_id = parseInt(req.body.fornecedor_id, 10) || null;
  let fornecedorTexto = (fornecedor || '').trim();
  if (fornecedor_id) {
    const f = await Fornecedor.findOne({ where: { id: fornecedor_id, condominio_id: req.condominioId } });
    if (!f) fornecedor_id = null;
    else fornecedorTexto = f.nome;
  }

  // Fundo de Reserva: a despesa pode ser ligada à deliberação que a autoriza
  // (opcional — sem deliberação é uma despesa corrente). A cadeia
  // deliberação → item → assembleia → condomínio é validada na ajuda.
  const deliberacaoId = parseInt(req.body.deliberacao_id, 10) || null;
  let deliberacaoValidada = null;
  if (deliberacaoId) {
    const decisao = await validarAssociacaoDespesa({
      deliberacaoId,
      condominioId: req.condominioId,
      valorC: toCents(valor),
      contaBancariaId: contaId,
    });
    if (!decisao.ok) {
      req.flash('error_msg', decisao.mensagem);
      return res.redirect('/admin/despesas/nova');
    }
    deliberacaoValidada = decisao;
  }

  // A despesa e o movimento bancário que a desconta são gravados na MESMA
  // transação. Sem isto, uma falha ao criar o movimento deixava a despesa
  // gravada sem saída na conta — o saldo deixaria de descontar uma despesa paga
  // e a divergência era silenciosa (o pedido parecia ter corrido bem).
  const t = await sequelize.transaction();
  let despesa;
  try {
    despesa = await Despesa.create(
      {
        condominio_id: req.condominioId,
        numero_documento: numero,
        descricao,
        categoria_id: categoria_id || null,
        valor: toNumber(valor),
        data: dataObj,
        competencia_ano: dataObj.getFullYear(),
        competencia_mes: dataObj.getMonth() + 1,
        fornecedor: fornecedorTexto || null,
        fornecedor_id,
        conta_bancaria_id: contaId,
        metodo_pagamento_id: metodo_pagamento_id || null,
        deliberacao_id: deliberacaoId,
        observacoes,
        estado: estado || 'registada',
      },
      { transaction: t }
    );
    await sincronizarMovimentoDespesa(despesa, req.user.id, t, req.condominioId);
    await t.commit();
  } catch (err) {
    await rollbackSilencioso(t);
    console.error('[despesas] criar:', err);
    req.flash('error_msg', 'Não foi possível criar a despesa. Nenhum dado foi gravado.');
    return res.redirect('/admin/despesas/nova');
  }
  // A auditoria fica FORA da transação (e depois do commit): regista operações
  // que ficaram gravadas, nunca tentativas abortadas.
  await audit({
    userId: req.user.id,
    acao: 'criar_despesa',
    entidade: 'Despesa',
    entidadeId: despesa.id,
    detalhes: detalhesFcrDespesa(deliberacaoId, deliberacaoValidada),
  });
  req.flash('success_msg', 'Despesa criada.');
  res.redirect('/admin/despesas');
});

router.get('/despesas/:id/editar', async (req, res) => {
  const despesa = await carregarDespesa(req);
  if (!despesa) return res.redirect('/admin/despesas');
  const [categorias, contas, metodos, fornecedores, deliberacoes] = await Promise.all([
    Categoria.findAll({ where: { tipo: 'despesa' }, order: [['nome', 'ASC']] }),
    ContaBancaria.findAll({ where: ondeCondominio(req), order: [['nome', 'ASC']] }),
    MetodoPagamento.findAll({ order: [['nome', 'ASC']] }),
    Fornecedor.findAll({ where: { condominio_id: req.condominioId }, order: [['nome', 'ASC']] }),
    deliberacoesParaDespesa(req),
  ]);
  // A deliberação já associada continua a poder ser mantida mesmo que o
  // disponível se tenha esgotado (senão a edição falharia sem motivo).
  const deliberacaoAtualIncluida = Boolean(
    despesa.deliberacao_id && deliberacoes.some((d) => Number(d.id) === Number(despesa.deliberacao_id))
  );
  if (despesa.deliberacao_id && !deliberacaoAtualIncluida) {
    const atual = await carregarDeliberacao({ deliberacaoId: despesa.deliberacao_id, condominioId: req.condominioId });
    if (atual) deliberacoes.unshift(await deliberacaoComUtilizacao(atual, { condominioId: req.condominioId }));
  }
  res.render('admin/despesas/form', {
    titulo: 'Editar despesa',
    despesa,
    categorias,
    contas,
    metodos,
    fornecedores,
    deliberacoes,
    deliberacaoAtualIncluida,
  });
});

router.post('/despesas/:id', async (req, res) => {
  const despesa = await carregarDespesa(req);
  if (!despesa) return res.redirect('/admin/despesas');
  const { descricao, categoria_id, valor, data, fornecedor, conta_bancaria_id, metodo_pagamento_id, observacoes, estado } = req.body;
  const dataObj = data ? new Date(data) : new Date();

  let contaId = parseInt(conta_bancaria_id, 10) || null;
  if (contaId) {
    const conta = await ContaBancaria.findOne({ where: { id: contaId, condominio_id: req.condominioId } });
    contaId = conta ? conta.id : null;
  }

  let fornecedor_id = parseInt(req.body.fornecedor_id, 10) || null;
  let fornecedorTexto = (fornecedor || '').trim();
  if (fornecedor_id) {
    const f = await Fornecedor.findOne({ where: { id: fornecedor_id, condominio_id: req.condominioId } });
    if (!f) fornecedor_id = null;
    else fornecedorTexto = f.nome;
  }

  // Deliberação do FCR: validada como na criação (a própria despesa é ignorada
  // no cálculo do que já está associado, para poder ser reeditada).
  const deliberacaoId = parseInt(req.body.deliberacao_id, 10) || null;
  let deliberacaoValidada = null;
  if (deliberacaoId) {
    const decisao = await validarAssociacaoDespesa({
      deliberacaoId,
      condominioId: req.condominioId,
      valorC: toCents(valor),
      contaBancariaId: contaId,
      ignorarDespesaId: despesa.id,
    });
    if (!decisao.ok) {
      req.flash('error_msg', decisao.mensagem);
      return res.redirect(`/admin/despesas/${despesa.id}/editar`);
    }
    deliberacaoValidada = decisao;
  }

  // Alteração da despesa e do movimento bancário na MESMA transação: se o
  // movimento não puder ser atualizado, a despesa não pode ficar com os valores
  // novos — senão a conta passaria a descontar um valor que não corresponde a
  // nenhuma despesa gravada.
  const t = await sequelize.transaction();
  try {
    await despesa.update(
      {
        descricao,
        categoria_id: categoria_id || null,
        valor: toNumber(valor),
        data: dataObj,
        competencia_ano: dataObj.getFullYear(),
        competencia_mes: dataObj.getMonth() + 1,
        fornecedor: fornecedorTexto || null,
        fornecedor_id,
        conta_bancaria_id: contaId,
        metodo_pagamento_id: metodo_pagamento_id || null,
        deliberacao_id: deliberacaoId,
        observacoes,
        estado: estado || 'registada',
      },
      { transaction: t }
    );
    await sincronizarMovimentoDespesa(despesa, req.user.id, t, req.condominioId);
    await t.commit();
  } catch (err) {
    await rollbackSilencioso(t);
    console.error('[despesas] editar:', err);
    // Nota: a instância `despesa` fica com os valores novos em memória mesmo
    // depois do rollback (o Sequelize escreve-os no objeto antes de os gravar);
    // como a resposta é um redirect e o pedido termina aqui, não há leitura
    // posterior que possa observar esse estado — a base de dados é que ficou
    // intacta.
    req.flash('error_msg', 'Não foi possível atualizar a despesa. Nenhuma alteração foi gravada.');
    return res.redirect(`/admin/despesas/${despesa.id}/editar`);
  }
  await audit({
    userId: req.user.id,
    acao: 'editar_despesa',
    entidade: 'Despesa',
    entidadeId: despesa.id,
    detalhes: detalhesFcrDespesa(deliberacaoId, deliberacaoValidada),
  });
  req.flash('success_msg', 'Despesa atualizada.');
  res.redirect('/admin/despesas');
});

router.post('/despesas/:id/anular', async (req, res) => {
  const despesa = await carregarDespesa(req);
  if (despesa) {
    // Anulação da despesa e do movimento bancário na MESMA transação: uma
    // despesa anulada com o movimento ainda 'confirmado' continuaria a
    // descontar no saldo da conta — uma despesa cancelada a pesar no extrato.
    const t = await sequelize.transaction();
    try {
      await despesa.update({ estado: 'anulada' }, { transaction: t });
      await sincronizarMovimentoDespesa(despesa, req.user.id, t, req.condominioId);
      await t.commit();
    } catch (err) {
      await rollbackSilencioso(t);
      console.error('[despesas] anular:', err);
      req.flash('error_msg', 'Não foi possível anular a despesa. Nada foi alterado.');
      return res.redirect('/admin/despesas');
    }
    await audit({ userId: req.user.id, acao: 'anular_despesa', entidade: 'Despesa', entidadeId: despesa.id });
  }
  req.flash('success_msg', 'Despesa anulada.');
  res.redirect('/admin/despesas');
});

// ═══════════════════════════════════════════════════════════════════
// QUOTAS
// ═══════════════════════════════════════════════════════════════════

// Configuração das quotas (valor por 1000‰ + FCR)
router.post('/quotas/config', async (req, res) => {
  const valorPor1000 = parseDecimal(req.body.valor_1000 ?? req.body.valor_permilagem);
  // O FCR tem um mínimo legal (10% da quota-parte nas restantes despesas do
  // condomínio) e admite qualquer valor acima desse, aprovado pelo condomínio.
  // Aceita decimais (ex.: 12,5%).
  const fcrValidado = validarFcrPercentagem(req.body.fcr_percentagem);
  const fcrPercentagem = fcrValidado.valor;

  if (valorPor1000 <= 0) {
    req.flash('error_msg', 'O valor por 1000‰ tem de ser maior que zero.');
    return res.redirect('/admin/quotas');
  }
  if (!fcrValidado.ok) {
    req.flash('error_msg', fcrValidado.mensagem);
    return res.redirect('/admin/quotas');
  }

  await setQuotaConfig(req.condominioId, { valorPor1000, fcrPercentagem });

  // ── R10 / Q9 — PRÉ-VISUALIZAÇÃO, NUNCA ESCRITA ─────────────────────
  //
  // Antes, `recalcular=futuras` fazia `q.update(...)` sobre as quotas
  // `pendente`/`vencida` com vencimento futuro — incluindo quotas JÁ EMITIDAS.
  // Isso reescrevia documentos já entregues ao condómino e desligava-os do
  // valor que o orçamento aprovou.
  //
  // Agora o recálculo é apenas uma PRÉ-VISUALIZAÇÃO: calcula o impacto e
  // mostra-o, sem gravar uma única quota. A configuração nova produz efeitos
  // só nas GERAÇÕES FUTURAS de quotas (`POST /quotas/gerar`), nunca sobre
  // quotas que já existam — emitidas ou não.
  //
  // A fronteira de imutabilidade é `data_emissao` (R10), nunca `estado` nem
  // `data_vencimento`: `estado` é DERIVADO dos pagamentos (uma quota `pendente`
  // pode já estar emitida) e `data_vencimento` é uma data de calendário —
  // nenhum dos dois distingue um documento de um rascunho.
  let previa = null;
  if (req.body.recalcular === 'futuras') {
    previa = await previsaoRecalculo({
      condominioId: req.condominioId,
      valorPor1000,
      fcrPercentagem,
    });
    req.flash(
      'success_msg',
      `Configuração guardada. Pré-visualização: ${previa.nAfetadas} quota(s) não emitida(s) `
      + `seriam calculadas com a nova configuração (${previa.nMudam} com valor diferente); `
      + `${previa.nProtegidas} quota(s) já emitida(s) mantêm-se intactas. `
      + 'Nenhuma quota existente foi alterada — a nova configuração aplica-se às próximas gerações.'
    );
  } else {
    req.flash('success_msg', 'Configuração guardada (aplica-se a quotas futuras ainda não geradas).');
  }

  await audit({
    userId: req.user.id,
    acao: 'configurar_quotas',
    entidade: 'Configuracao',
    detalhes: {
      valorPor1000,
      fcrPercentagem,
      // R10/Q9 — a pré-visualização fica registada (o que foi mostrado), sem
      // que nenhuma quota tenha sido tocada.
      previsao: previa
        ? { nAfetadas: previa.nAfetadas, nMudam: previa.nMudam, nProtegidas: previa.nProtegidas }
        : null,
    },
  });
  res.redirect('/admin/quotas');
});

// Grelha anual do estado das quotas por fração × mês
router.get('/quotas/grelha', async (req, res) => {
  const ano = parseInt(req.query.ano || new Date().getFullYear(), 10);
  const [fracoes, quotas, anos] = await Promise.all([
    Fracao.findAll({ where: ondeCondominio(req), order: [['designacao', 'ASC']] }),
    Quota.findAll({ where: { ano, condominio_id: req.condominioId } }),
    Quota.findAll({ attributes: [[sequelize.fn('DISTINCT', sequelize.col('ano')), 'ano']], where: { condominio_id: req.condominioId }, order: [['ano', 'DESC']], raw: true }),
  ]);

  const porFracao = {};
  quotas.forEach((q) => {
    if (!porFracao[q.fracao_id]) porFracao[q.fracao_id] = {};
    porFracao[q.fracao_id][q.mes] = { id: q.id, estado: estadoEfetivo(q) };
  });

  const linhas = fracoes.map((f) => ({
    id: f.id,
    designacao: f.designacao,
    permilagem: f.permilagem,
    meses: Array.from({ length: 12 }, (_, i) => (porFracao[f.id] ? porFracao[f.id][i + 1] || null : null)),
  }));

  res.render('admin/quotas/grelha', {
    titulo: 'Grelha de quotas',
    ano,
    linhas,
    anos: anos.map((a) => a.ano),
    meses: MESES,
  });
});

router.get('/quotas/gerar', async (req, res) => {
  const [fracoes, quotaConfig, orcamentos, existentes] = await Promise.all([
    Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId }, order: [['designacao', 'ASC']] }),
    getQuotaConfig(req.condominioId),
    Orcamento.findAll({
      where: { estado: { [Op.ne]: 'anulado' }, condominio_id: req.condominioId },
      include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
      order: [['data_inicio', 'DESC']],
    }),
    Quota.findAll({ attributes: ['fracao_id', 'ano', 'mes'], where: { condominio_id: req.condominioId }, raw: true }),
  ]);

  // Orçamentos com total de rubricas (receita anual definida pelo orçamento).
  const totalAnualPorOrcamento = new Map();
  const orcamentosJson = orcamentos.map((o) => {
    const totalC = o.rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
    totalAnualPorOrcamento.set(o.id, totalC);
    return {
      id: o.id,
      designacao: o.designacao,
      anoInicio: new Date(o.data_inicio).getFullYear(),
      total: fromCents(totalC),
    };
  });

  // ── Pré-visualização (P20) ─────────────────────────────────────────
  // Os valores que a vista apresenta são calculados AQUI, com as MESMAS
  // funções que geram e gravam as quotas (`calcularQuota` e
  // `calcularQuotasOrcamento`). Não existe nenhuma fórmula de cálculo no
  // browser — a vista só formata e soma.
  //
  // Antes: a vista reimplementava as duas regras em JS (`totalComFcr`, a
  // proporção direta `totalAnual × perm / Σperm` e a divisão por 12) e, no
  // método orçamento, divergia do gravado sempre que havia resto — o servidor
  // distribui por maior-resto (`distribuirPorPesos`, soma exata) e a vista por
  // proporção contínua. O comentário da vista prometia «a pré-visualização
  // nunca inventa números que o servidor não vá gravar», o que era falso nesse
  // ramo.
  const previsao = { permilagem: {}, orcamento: {} };

  // Método permilagem: quota mensal única, repetida nos 12 meses.
  for (const f of fracoes) {
    const q = calcularQuota(f.permilagem, quotaConfig.valorPor1000, quotaConfig.fcrPercentagem);
    previsao.permilagem[f.id] = {
      base: q.base,
      fcr: q.fcr,
      total: q.total,
      anual: fromCents(q.totalC * 12),
      meses: null, // o mesmo valor em todos os meses
    };
  }

  // Método orçamento: cada mês tem o SEU valor (é o ano que fecha exatamente).
  for (const o of orcamentos) {
    const totalC = totalAnualPorOrcamento.get(o.id) || 0;
    const mapa = calcularQuotasOrcamento({
      fracoes,
      totalAnual: fromCents(totalC),
      metodo: 'permilagem',
      meses: 12,
      fcrPercentagem: quotaConfig.fcrPercentagem,
    });
    const bloco = {};
    for (const [id, v] of mapa) {
      const primeiroMes = (v.porMes && v.porMes[0]) || { base: 0, fcr: 0, total: 0 };
      bloco[id] = {
        base: primeiroMes.base,
        fcr: primeiroMes.fcr,
        total: primeiroMes.total,
        anual: v.total,
        meses: v.porMes.map((m) => ({ base: m.base, fcr: m.fcr, total: m.total })),
      };
    }
    previsao.orcamento[o.id] = bloco;
  }

  // Conjunto de quotas já existentes (fração|ano|mes) para o preview idempotente.
  const existentesSet = {};
  existentes.forEach((q) => {
    existentesSet[`${q.fracao_id}|${q.ano}|${q.mes}`] = true;
  });

  // P54-7 — as automações que pré-marcam os interruptores são as DESTE
  // condomínio (a página de automações grava no âmbito `:c<ID>`).
  const [autoQuotasDrive, autoQuotasEmail, autoQuotasAutomatico] = await Promise.all([
    automacaoAtiva('quotas', 'drive', req.condominioId),
    automacaoAtiva('quotas', 'email', req.condominioId),
    automacaoAtiva('quotas', 'automatico', req.condominioId),
  ]);

  res.render('admin/quotas/gerar', {
    titulo: 'Gerar quotas',
    fracoes,
    quotaConfig,
    orcamentos: orcamentosJson,
    fracoesJson: JSON.stringify(fracoes.map((f) => ({ id: f.id, designacao: f.designacao, permilagem: f.permilagem }))),
    existentesJson: JSON.stringify(existentesSet),
    // Pré-visualização: valores já calculados pelo servidor com as funções
    // reais (ver o bloco `previsao` acima). A vista não tem fórmulas.
    previsaoJson: JSON.stringify(previsao),
    driveLigado: storage.isConfigured(req.condominioId),
    autoQuotas: { drive: autoQuotasDrive, email: autoQuotasEmail, automatico: autoQuotasAutomatico },
  });
});

router.post('/quotas/gerar', async (req, res) => {
  const escopo = req.body.escopo || 'mes'; // 'mes' | 'ano'
  const metodo = req.body.metodo === 'orcamento' ? 'orcamento' : 'permilagem';
  const anoNum = parseInt(req.body.ano, 10);
  const mesNum = escopo === 'ano' ? null : parseInt(req.body.mes, 10);
  const vencDia = parseInt(req.body.vencimento_dia, 10) || 8;
  const orcamentoId = parseInt(req.body.orcamento_id, 10) || null;

  if (!anoNum || (escopo === 'mes' && !mesNum)) {
    req.flash('error_msg', 'Indique o ano (e o mês, se aplicável).');
    return res.redirect('/admin/quotas/gerar');
  }

  const fracoes = await Fracao.findAll({ where: { estado: 'ativo', condominio_id: req.condominioId }, order: [['designacao', 'ASC']] });
  const meses = escopo === 'ano' ? Array.from({ length: 12 }, (_, i) => i + 1) : [mesNum];

  // Método 1 (permilagem + FCR via config) vs Método 2 (orçamento define a receita).
  let valoresPorFracao;
  let metodoLabel;
  if (metodo === 'orcamento') {
    if (!orcamentoId) {
      req.flash('error_msg', 'Selecione o orçamento que define a receita.');
      return res.redirect('/admin/quotas/gerar');
    }
    const orcamento = await Orcamento.findOne({
      where: { id: orcamentoId, condominio_id: req.condominioId },
      include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
    });
    if (!orcamento) {
      req.flash('error_msg', 'Orçamento não encontrado neste condomínio.');
      return res.redirect('/admin/quotas/gerar');
    }
    const totalAnualC = orcamento.rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
    // A percentagem do FCR vem SEMPRE da configuração do condomínio: sem ela o
    // FCR saía a zero e a quota deixava de discriminar o fundo.
    const { fcrPercentagem: fcrOrcamento } = await getQuotaConfig(req.condominioId);
    valoresPorFracao = calcularQuotasOrcamento({
      fracoes,
      totalAnual: fromCents(totalAnualC),
      metodo: 'permilagem',
      meses: 12,
      fcrPercentagem: fcrOrcamento,
    });
    metodoLabel = `orçamento ${orcamento.designacao}`;
  } else {
    const { valorPor1000, fcrPercentagem } = await getQuotaConfig(req.condominioId);
    valoresPorFracao = new Map(
      fracoes.map((f) => [f.id, calcularQuota(f.permilagem, valorPor1000, fcrPercentagem)])
    );
    metodoLabel = 'permilagem + FCR';
  }

  const t = await sequelize.transaction();
  let criadas = 0;
  let ignoradas = 0;
  const criadasLista = [];
  try {
    for (const f of fracoes) {
      const v = valoresPorFracao.get(f.id);
      for (const m of meses) {
        const existente = await Quota.findOne({ where: { fracao_id: f.id, ano: anoNum, mes: m, condominio_id: req.condominioId }, transaction: t });
        if (existente) {
          ignoradas++;
          continue;
        }
        const numero = await proximoNumero('aviso_quota', { ano: anoNum, transaction: t });
        // C3: cada mês tem o SEU valor. `porMes[m-1]` fecha exatamente
        // `Σ meses === anual` (I-2); usar `v.total` (anual) repetido nos 12
        // meses inflacionaria a quota em 12×.
        const mV = (v.porMes && v.porMes[m - 1]) || v;
        const nova = await Quota.create(
          {
            condominio_id: req.condominioId,
            numero_documento: numero,
            fracao_id: f.id,
            // P56 — vínculo ao orçamento de origem. Sem isto, uma quota gerada
            // pelo método «orçamento» perdia o vínculo, e como `orcamento_id` é
            // campo CONGELADO pelo R10 (`helpers/quota-imutabilidade.js`) não
            // podia ser preenchido depois por uma edição normal. `null` quando o
            // método é a permilagem (não há orçamento de origem a registar).
            orcamento_id: metodo === 'orcamento' ? orcamentoId : null,
            ano: anoNum,
            mes: m,
            periodo: new Date(anoNum, m - 1, 1),
            valor: mV.total,
            valor_base: mV.base,
            valor_fcr: mV.fcr,
            valor_por_1000: v.valorPor1000,
            permilagem_aplicada: v.permilagem ?? f.permilagem,
            fcr_percentagem: v.fcrPercentagem,
            data_emissao: new Date(),
            data_vencimento: new Date(anoNum, m - 1, vencDia),
            estado: 'pendente',
          },
          { transaction: t }
        );
        criadasLista.push(nova);
        criadas++;
      }
    }
    await t.commit();
    await audit({ userId: req.user.id, acao: 'gerar_quotas', entidade: 'Quota', detalhes: { ano: anoNum, mes: mesNum, escopo, metodo: metodoLabel, criadas } });

    // ── Processamento em segundo plano (PDFs/armazenamento/emails) ──
    // A criação das quotas é síncrona; as operações pesadas (gerar PDFs,
    // guardar no armazenamento do condomínio, colocar emails na fila) correm
    // fora do request.
    let extraMsg = '';
    try {
      if (criadas > 0) {
        // P54-7 — a automação é lida no âmbito do condomínio que está a gerar
        // (o MESMO `req.condominioId` que vai para o `background.enqueue`),
        // para que o pré-processamento não aplique a decisão de outro.
        const guardarDrive = req.body.guardar_drive === 'on' || (await automacaoAtiva('quotas', 'drive', req.condominioId));
        const enviarEmail = req.body.enviar_email === 'on' || (await automacaoAtiva('quotas', 'automatico', req.condominioId));
        const storageLigado = storage.isConfigured(req.condominioId);
        if ((guardarDrive && storageLigado) || enviarEmail) {
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          background.enqueue('quotas_pos_processamento', {
            ano: anoNum,
            mes: mesNum,
            condominioId: req.condominioId,
            guardarDrive: Boolean(guardarDrive && storageLigado),
            enviarEmail: Boolean(enviarEmail),
            userId: req.user.id,
            baseUrl,
          });
          extraMsg = ' Processamento em segundo plano iniciado (PDFs/armazenamento/emails). A interface continua disponível.';
        }
      }
    } catch (e) {
      console.error('[quotas-background]', e.message);
      extraMsg = ' (não foi possível agendar o processamento em segundo plano).';
    }

    req.flash('success_msg', `Geradas ${criadas} quota(s)${ignoradas ? `; ${ignoradas} já existiam (não duplicadas)` : ''} (${metodoLabel}).${extraMsg}`);
  } catch (err) {
    await t.rollback();
    console.error(err);
    req.flash('error_msg', 'Não foi possível gerar as quotas. Verifique os dados e tente novamente.');
  }
  res.redirect('/admin/quotas');
});

// ═══════════════════════════════════════════════════════════════════
// QUOTAS — envio em lote por email (com histórico e sem duplicados)
// ═══════════════════════════════════════════════════════════════════
const { enfileirarEmail: enfileirarEmailFila } = require('../helpers/email-fila');
const { existeEnvioPara, ultimoEnvioConcluido } = require('../helpers/envios');

// Proprietários/condóminos ATUAIS de uma fração (titularidade em vigor;
// preferência a "proprietario"). Depois de uma mudança de proprietário, o
// anterior deixa de constar — não recebe avisos nem pedidos de pagamento.
async function pessoasDaFracao(fracaoId) {
  const { pessoas } = await titulares.pessoasAtuaisDaFracao({ fracaoId });
  return pessoas;
}

function emailsUnicos(pessoas) {
  const mapa = new Map();
  pessoas
    .filter((p) => p.email)
    .forEach((p) => mapa.set(String(p.email).toLowerCase(), p.email));
  return [...mapa.values()];
}

// Lista de quotas com destinatários/estado para a página de envio em lote.
async function contextoEnvioQuotas({ ano, mes, condominioId }) {
  const agora = new Date();
  const anoNum = parseInt(ano, 10) || agora.getFullYear();
  const mesNum = parseInt(mes, 10) || agora.getMonth() + 1;

  const quotas = await Quota.findAll({
    where: { ano: anoNum, mes: mesNum, ...(condominioId ? { condominio_id: condominioId } : {}) },
    include: [{ model: Fracao, as: 'fracao' }],
    order: [[{ model: Fracao, as: 'fracao' }, 'designacao', 'ASC']],
  });

  const ids = quotas.map((q) => q.id);
  const envios = ids.length
    ? await EmailFila.findAll({ where: { entidade_tipo: 'Quota', entidade_id: { [Op.in]: ids } }, order: [['id', 'ASC']] })
    : [];
  const porQuota = {};
  for (const e of envios) {
    (porQuota[e.entidade_id] = porQuota[e.entidade_id] || []).push(e);
  }

  const linhas = [];
  for (const q of quotas) {
    const pessoas = await pessoasDaFracao(q.fracao_id);
    const emails = emailsUnicos(pessoas);
    const registos = porQuota[q.id] || [];
    const enviados = registos.filter((r) => r.estado === 'enviado');
    const temErro = registos.some((r) => r.estado === 'erro');
    const pendente = registos.some((r) => ['pendente', 'a_enviar'].includes(r.estado));
    const ultimo = enviados[enviados.length - 1] || null;
    linhas.push({
      id: q.id,
      fracao: q.fracao.designacao,
      numero: q.numero_documento,
      periodo: `${monthName(q.mes)} ${q.ano}`,
      ano: q.ano,
      mes: q.mes,
      valor: q.valor,
      condominos: pessoas.map((p) => p.nome).join(', ') || '—',
      emails: emails.join(', ') || '',
      temEmail: emails.length > 0,
      emailsLista: emails,
      estado: enviados.length ? 'enviado' : temErro ? 'erro' : pendente ? 'pendente' : 'nao_enviado',
      ultimoEnvio: ultimo ? { data: ultimo.data_enviada, email: ultimo.destinatario_email } : null,
    });
  }

  return {
    ano: anoNum,
    mes: mesNum,
    titulo: `Quotas — ${monthName(mesNum)} ${anoNum}`,
    anos: Array.from({ length: 7 }, (_, i) => new Date().getFullYear() - 3 + i),
    meses: MESES.map((nome, i) => ({ numero: i + 1, nome })),
    total: linhas.length,
    comEmail: linhas.filter((l) => l.temEmail).length,
    enviados: linhas.filter((l) => l.estado === 'enviado').length,
    pendentes: linhas.filter((l) => l.temEmail && l.estado !== 'enviado').length,
    semEmail: linhas.filter((l) => !l.temEmail).length,
    comErro: linhas.filter((l) => l.estado === 'erro').length,
    linhas,
  };
}

// Enfileira emails de uma lista de linhas (envio em lote/automático),
// sem duplicar envios existentes (a menos que reenviar=true).
// Opções avançadas:
//  · mensagemDe(linha) → { assunto, corpo, corpo_html } (templates profissionais)
//  · anexoDe(linha) → { nome, buffer } (PDF específico do destinatário)
async function enfileirarLoteEmails({
  linhas,
  entidadeTipo,
  link,
  assunto,
  corpo,
  mensagemDe,
  anexoDe,
  condominioId,
  userId,
  reenviar = false,
}) {
  let enfileirados = 0;
  let ignorados = 0;
  let semEmail = 0;
  for (const linha of linhas) {
    if (!linha.temEmail) {
      semEmail++;
      continue;
    }
    let anexo = null;
    if (anexoDe) {
      try {
        anexo = await anexoDe(linha);
      } catch (err) {
        console.error('[lote-anexo]', err.message);
        anexo = null; // email avança sem anexo, com link
      }
    }
    for (const email of linha.emailsLista) {
      const ja = await existeEnvioPara({ entidadeTipo, entidadeId: linha.id, email });
      if (ja && !reenviar) {
        ignorados++;
        continue;
      }
      const mensagem = mensagemDe
        ? mensagemDe(linha)
        : { assunto: assunto(linha), corpo_html: null, corpo: corpo(linha, link(linha)) };
      await enfileirarEmailFila({
        destinatario_email: email,
        destinatario_nome: linha.condominos !== '—' ? linha.condominos : null,
        assunto: mensagem.assunto,
        corpo: mensagem.corpo,
        corpo_html: mensagem.corpo_html || null,
        entidade_tipo: entidadeTipo,
        entidade_id: linha.id,
        condominioId,
        userId,
        anexoNome: anexo ? anexo.nome : null,
        anexoBuffer: anexo ? anexo.buffer : null,
      });
      enfileirados++;
    }
  }
  return { enfileirados, ignorados, semEmail };
}

router.get('/quotas/enviar', async (req, res) => {
  const ctx = await contextoEnvioQuotas({ ano: req.query.ano, mes: req.query.mes, condominioId: req.condominioId });
  res.render('admin/quotas/enviar', { titulo: 'Enviar quotas por email', driveLigado: storage.isConfigured(req.condominioId), ...ctx });
});

router.post('/quotas/enviar', async (req, res) => {
  const ctx = await contextoEnvioQuotas({ ano: req.body.ano, mes: req.body.mes, condominioId: req.condominioId });
  const pedidoIds = new Set((Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : []).map(Number));
  const reenviar = req.body.reenviar === '1' || req.body.reenviar === 'on';
  const modoPendentes = req.body.modo === 'pendentes';

  const alvos = ctx.linhas.filter((l) => (modoPendentes ? l.temEmail && l.estado !== 'enviado' : pedidoIds.has(l.id)));
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const condEm = await getCondominio({ id: req.condominioId });
  const condNome = (condEm && String(condEm.designacao || '').trim()) || '';
  const adminNome = (condEm && String(condEm.administracao_nome || '').trim()) || '';
  const r = await enfileirarLoteEmails({
    linhas: alvos,
    entidadeTipo: 'Quota',
    reenviar,
    condominioId: req.condominioId,
    userId: req.user.id,
    link: (l) => `${baseUrl}/admin/quotas/${l.id}/aviso`,
    assunto: (l) => `Aviso de quota ${l.numero} — ${l.periodo}`,
    corpo: (l, url) => `Fração ${l.fracao}\nPeríodo: ${l.periodo}\nValor: ${l.valor} €\n\nAviso de quota: ${url}`,
    mensagemDe: (l) => {
      const url = `${baseUrl}/admin/quotas/${l.id}/aviso`;
      const nome = l.condominos && l.condominos !== '—' ? String(l.condominos).split(',')[0].trim() : undefined;
      const tpl = comporEmail('quota', {
        destinatarioNome: nome,
        condominio: condNome,
        administracao: adminNome,
        periodo: l.periodo,
        valor: `${l.valor} €`,
        urlOnline: url,
      });
      return { assunto: tpl.assunto, corpo: tpl.text, corpo_html: tpl.html };
    },
    anexoDe: async (l) => {
      const { buffer } = await construirAvisoQuota(l.id, req.condominioId);
      return { nome: nomeFicheiroEmail('quota', { ano: String(l.ano || ''), mes: l.mes || '', fracao: l.fracao }), buffer };
    },
  });
  await audit({
    userId: req.user.id,
    acao: 'enviar_quotas_email',
    entidade: 'Quota',
    detalhes: { ano: ctx.ano, mes: ctx.mes, enfileirados: r.enfileirados, ignorados: r.ignorados, semEmail: r.semEmail, reenviar },
  }).catch(() => {});
  req.flash('success_msg', `${r.enfileirados} email(s) enfileirado(s).${r.ignorados ? ` ${r.ignorados} já tinham envio (não duplicados).` : ''}${r.semEmail ? ` ${r.semEmail} sem email.` : ''}`);
  res.redirect(`/admin/quotas/enviar?ano=${ctx.ano}&mes=${ctx.mes}`);
});

router.get('/quotas/:id', async (req, res) => {
  const quota = await Quota.findOne({ where: { id: req.params.id, condominio_id: req.condominioId }, include: [{ model: Fracao, as: 'fracao' }] });
  if (!quota) return res.redirect('/admin/quotas');
  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: quota.id },
    include: [
      { model: Pagamento, as: 'pagamento', where: { estado: 'confirmado' }, required: false },
    ],
    order: [['id', 'ASC']],
  });
  const pagoC = aplicacoes
    .filter((a) => a.pagamento)
    .reduce((s, a) => s + toCents(a.valor_aplicado), 0);
  const ultima = aplicacoes
    .filter((a) => a.pagamento && a.pagamento.data_pagamento)
    .map((a) => a.pagamento.data_pagamento)
    .sort()
    .pop();
  res.render('admin/quotas/detalhe', {
    titulo: `Quota ${quota.numero_documento || ''}`,
    quota,
    aplicacoes,
    estadoEfetivo: estadoEfetivo(quota),
    pago: fromCents(pagoC),
    emFalta: fromCents(toCents(quota.valor) - pagoC),
    ultimaData: ultima || null,
    driveLigado: storage.isConfigured(req.condominioId),
    // Em suporte a vista esconde as ações com efeito lateral (aviso PDF /
    // aviso com quotas extra / guardar no armazenamento).
    suporteDiagnostico: Boolean(req.suporte),
  });
});

router.get('/quotas/:id/editar', async (req, res) => {
  const quota = await Quota.findOne({ where: { id: req.params.id, condominio_id: req.condominioId }, include: [{ model: Fracao, as: 'fracao' }] });
  if (!quota) return res.redirect('/admin/quotas');
  res.render('admin/quotas/form', { titulo: 'Editar quota', quota });
});

// R10 — edição de uma quota.
//
// Uma quota EMITIDA é um documento: os seus elementos financeiros e
// identificadores estão congelados e NÃO existe exceção administrativa. A única
// coisa que esta rota pode mudar numa quota emitida são as `observacoes`.
//
// A correção de um valor emitido faz-se com um ACERTO — um documento NOVO
// (`ExtraQuota` com `tipo='acerto'`, que referencia a quota sem a alterar).
router.post('/quotas/:id', async (req, res) => {
  const quota = await Quota.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
  if (!quota) return res.redirect('/admin/quotas');
  const { valor, data_emissao, data_vencimento, observacoes } = req.body;

  // O que esta edição está a PROPOR (só os campos que o formulário envia).
  //
  // ⛔ `data_emissao` NÃO é mascarada quando vem vazia. Se fosse
  // (`data_emissao || quota.data_emissao`), uma tentativa de LIMPAR a emissão
  // nunca apareceria como «alteração» e a regra de R10 deixá-la-ia passar em
  // silêncio — a porta para «des-emitir» uma quota ficaria aberta por omissão.
  // Aqui, um valor vazio é uma proposta de limpeza (`null`); só a AUSÊNCIA do
  // campo (`undefined`) significa «não proponho nada».
  const propostas = {
    valor: toNumber(valor),
    data_vencimento: data_vencimento || quota.data_vencimento,
  };
  if (data_emissao !== undefined) propostas.data_emissao = data_emissao || null;

  if (estaEmitida(quota)) {
    // 1. A ÂNCORA da imutabilidade: `data_emissao` identifica o documento.
    //    Limpá-la faria a quota «voltar» a rascunho e cair no ramo não-emitido
    //    abaixo, onde o valor voltaria a ser editável — é o contorno de R10.
    //    Recusa-se explicitamente (com mensagem própria), antes da regra geral.
    if ('data_emissao' in propostas && isoData(propostas.data_emissao) !== isoData(quota.data_emissao)) {
      req.flash(
        'error_msg',
        'A data de emissão de uma quota emitida não pode ser alterada nem removida — '
        + 'é ela que identifica o documento. Para corrigir um valor já emitido, registe um ACERTO '
        + '(documento novo, que não altera a quota original).'
      );
      return res.redirect('/admin/quotas');
    }

    // 2. Elementos financeiros e identificadores: congelados por R10.
    const congeladas = alteracoesCongeladas(quota, propostas);
    if (congeladas.length > 0) {
      req.flash(
        'error_msg',
        `Quota emitida não pode ser reescrita (${congeladas.map((c) => c.campo).join(', ')}). `
        + 'Os valores de uma quota emitida são imutáveis: uma correção exige um ACERTO, '
        + 'que é um documento novo e não altera a quota original.'
      );
      return res.redirect('/admin/quotas');
    }

    // 3. `data_vencimento` de um documento emitido: exige operação própria,
    //    explícita e auditada — não é um campo livremente editável.
    if (isoData(propostas.data_vencimento) !== isoData(quota.data_vencimento)) {
      req.flash(
        'error_msg',
        'A data de vencimento de uma quota emitida não é editável por aqui: '
        + 'exige uma operação própria e auditada.'
      );
      return res.redirect('/admin/quotas');
    }

    // 4. Só as observações podem mudar.
    await quota.update({ observacoes });
    await audit({
      userId: req.user.id,
      acao: 'editar_quota',
      entidade: 'Quota',
      entidadeId: quota.id,
      detalhes: { emitida: true, alterados: ['observacoes'] },
    });
    req.flash('success_msg', 'Observações atualizadas (os valores de uma quota emitida são imutáveis).');
    return res.redirect('/admin/quotas');
  }

  // ── Quota ainda NÃO emitida (rascunho) ────────────────────────────
  // O valor pode ser corrigido, mas a edição não pode deixar o total incoerente
  // com as suas componentes (invariante I-4: valor = valor_base + valor_fcr).
  // Só se verifica quando o valor MUDA: uma quota histórica já incoerente
  // continua a poder receber correções de observações (Q10 — detetar/reportar,
  // nunca normalizar).
  const mudaValor = toCents(propostas.valor) !== toCents(quota.valor);
  if (mudaValor && !invarianteOk({
    valor: propostas.valor,
    valor_base: quota.valor_base,
    valor_fcr: quota.valor_fcr,
  })) {
    req.flash(
      'error_msg',
      `A edição deixaria o total (${propostas.valor} €) diferente de base + FCR `
      + `(${quota.valor_base} € + ${quota.valor_fcr} €). Corrija pela configuração de quotas `
      + 'ou por um acerto, para o total continuar a ser a soma das componentes.'
    );
    return res.redirect('/admin/quotas');
  }

  // Este ramo só é alcançável quando `quota.data_emissao` é NULL (a quota não é
  // um documento). É o único sítio que pode ESCREVER `data_emissao` por edição:
  // promove um rascunho a emitido. Nunca a limpa — uma quota já emitida não
  // chega aqui (foi recusada acima), logo o contorno «des-emitir para editar»
  // não tem porta de entrada.
  await quota.update({
    valor: propostas.valor,
    data_emissao: propostas.data_emissao === undefined ? quota.data_emissao : propostas.data_emissao,
    data_vencimento: propostas.data_vencimento,
    observacoes,
  });
  await audit({
    userId: req.user.id,
    acao: 'editar_quota',
    entidade: 'Quota',
    entidadeId: quota.id,
    detalhes: { emitida: false },
  });
  req.flash('success_msg', 'Quota atualizada.');
  res.redirect('/admin/quotas');
});

// P6 / R10 — anulação de uma quota.
//
// Uma quota com PAGAMENTO CONFIRMADO aplicado não pode ser anulada por esta
// via: a anulação não reverte o pagamento e deixaria dinheiro aplicado sobre
// uma quota anulada (a dívida desaparecia, o dinheiro não). Reverter exige
// anular primeiro o pagamento. Quotas sem pagamento confirmado continuam a
// poder ser anuladas como antes.
router.post('/quotas/:id/anular', async (req, res) => {
  const quota = await Quota.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
  if (!quota) {
    req.flash('error_msg', 'Quota não encontrada.');
    return res.redirect('/admin/quotas');
  }

  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: quota.id },
    include: [
      { model: Pagamento, as: 'pagamento', where: { estado: 'confirmado' }, required: false },
    ],
    order: [['id', 'ASC']],
  });
  const pagoC = aplicacoes
    .filter((a) => a.pagamento && a.pagamento.estado === 'confirmado')
    .reduce((s, a) => s + toCents(a.valor_aplicado), 0);

  if (pagoC > 0) {
    req.flash(
      'error_msg',
      `Esta quota tem ${formatEURCents(pagoC)} de pagamento confirmado aplicado e não pode ser anulada. `
      + 'Anule primeiro o pagamento que a liquidou.'
    );
    return res.redirect('/admin/quotas');
  }

  if (quota.estado === 'anulada') {
    req.flash('error_msg', 'Esta quota já está anulada.');
    return res.redirect('/admin/quotas');
  }

  await quota.update({ estado: 'anulada' });
  await audit({
    userId: req.user.id,
    acao: 'anular_quota',
    entidade: 'Quota',
    entidadeId: quota.id,
    detalhes: { pagamentoAplicadoC: 0 },
  });
  req.flash('success_msg', 'Quota anulada.');
  res.redirect('/admin/quotas');
});

// ═══════════════════════════════════════════════════════════════════
// PAGAMENTOS
// ═══════════════════════════════════════════════════════════════════
router.get('/pagamentos', async (req, res) => {
  const pagamentos = await Pagamento.findAll({
    where: ondeCondominio(req),
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: ContaBancaria, as: 'conta_bancaria' },
    ],
    order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
  });
  res.render('admin/pagamentos/listar', {
    titulo: 'Pagamentos',
    pagamentos,
    driveLigado: storage.isConfigured(req.condominioId),
    suporteDiagnostico: Boolean(req.suporte),
  });
});

router.get('/pagamentos/nova', async (req, res) => {
  const [fracoes, metodos, contas] = await Promise.all([
    Fracao.findAll({ where: ondeCondominio(req), order: [['designacao', 'ASC']] }),
    MetodoPagamento.findAll({ where: { ativo: true }, order: [['nome', 'ASC']] }),
    ContaBancaria.findAll({ where: ondeCondominio(req, { ativa: true }), order: [['nome', 'ASC']] }),
  ]);

  // Opcional: ?fracao=ID pré-seleciona e lista as obrigações em aberto
  // (quotas normais + Quotas Extra elegíveis) para pagamento combinado.
  let itensFracao = null;
  const fracaoSelecionada = parseInt(req.query.fracao, 10) || null;
  if (fracaoSelecionada) {
    const fracaoValida = await Fracao.findOne({ where: { id: fracaoSelecionada, condominio_id: req.condominioId } });
    if (fracaoValida) {
      const quotas = await Quota.findAll({
        where: { condominio_id: req.condominioId, fracao_id: fracaoValida.id, estado: { [Op.ne]: 'anulada' } },
        order: [['ano', 'ASC'], ['mes', 'ASC']],
      });
      const ids = quotas.map((q) => q.id);
      const aplicacoes = ids.length
        ? await PagamentoQuota.findAll({
            where: { quota_id: { [Op.in]: ids } },
            include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
            raw: true,
          })
        : [];
      const pagoMap = new Map();
      for (const a of aplicacoes) {
        if (a['pagamento.estado'] === 'confirmado') {
          pagoMap.set(a.quota_id, (pagoMap.get(a.quota_id) || 0) + toCents(a.valor_aplicado));
        }
      }
      const parcelas = await ExtraQuotaParcela.findAll({
        where: { fracao_id: fracaoValida.id, estado: { [Op.in]: ['pendente', 'cobrada'] } },
        include: [
          {
            model: ExtraQuota,
            as: 'extra_quota',
            attributes: ['designacao', 'estado', 'condominio_id'],
            where: { condominio_id: req.condominioId, estado: 'processada' },
            required: true,
          },
        ],
        order: [['data_vencimento', 'ASC'], ['id', 'ASC']],
      });
      itensFracao = {
        designacao: fracaoValida.designacao,
        quotas: quotas.map((q) => {
          const emAbertoC = toCents(q.valor) - (pagoMap.get(q.id) || 0);
          return {
            id: q.id,
            rotulo: `${monthName(q.mes)} ${q.ano}`,
            valor: fromCents(toCents(q.valor)),
            emAberto: fromCents(Math.max(0, emAbertoC)),
          };
        }).filter((q) => q.emAberto > 0),
        parcelas: parcelas.map((p) => ({
          id: p.id,
          designacao: p.extra_quota.designacao,
          detalhe: `Parcela ${p.parcela_numero}`,
          vencimento: p.data_vencimento ? String(p.data_vencimento).slice(0, 10) : null,
          valor: p.valor,
        })),
      };
    }
  }

  res.render('admin/pagamentos/form', {
    titulo: 'Registar pagamento',
    dataHoje: toDateInput(new Date()), // data sugerida: hoje (antes sugeria 01-01 do ano corrente)
    fracoes,
    metodos,
    contas,
    itensFracao,
    fracaoSelecionada,
    temItens: Boolean(itensFracao && (itensFracao.quotas.length || itensFracao.parcelas.length)),
  });
});

// Registo de pagamento — aceita multipart/form-data com um comprovativo
// opcional (campo "comprovativo"). Se o upload falhar, o pagamento NÃO é
// criado (o middleware de upload corre antes do handler).
router.post('/pagamentos', (req, res, next) => {
  uploadComprovativo(req, res, (err) => {
    if (err) {
      req.flash('error_msg', err.message || 'Erro ao carregar o comprovativo.');
      return res.redirect('/admin/pagamentos/nova');
    }
    next();
  });
}, async (req, res) => {
  const { fracao_id, valor, data_pagamento, metodo_pagamento_id, conta_bancaria_id, referencia, observacoes } = req.body;
  const comprovativo = req.file
    ? { ficheiro: req.file.filename, nome: req.file.originalname, mime: req.file.mimetype }
    : null;
  try {
    // Guardas de condomínio: fração e conta têm de pertencer ao ativo (IDOR).
    const fracaoValida = await Fracao.findOne({ where: { id: parseInt(fracao_id, 10) || 0, condominio_id: req.condominioId } });
    if (!fracaoValida) {
      if (comprovativo) apagarComprovativo(comprovativo.ficheiro);
      req.flash('error_msg', 'Fração não encontrada neste condomínio.');
      return res.redirect('/admin/pagamentos/nova');
    }
    let contaBancariaId = parseInt(conta_bancaria_id, 10) || null;
    if (contaBancariaId) {
      const conta = await ContaBancaria.findOne({ where: { id: contaBancariaId, condominio_id: req.condominioId } });
      contaBancariaId = conta ? conta.id : null;
    }

    // Pagamento COMBINADO: quando o administrador seleciona obrigações
    // (quotas normais e/ou parcelas extra), regista-se UM único Pagamento
    // distribuído pelas selecionadas; sem seleção, mantém o fluxo FIFO atual.
    const quotaIds = toArray(req.body.quota_ids).map(Number).filter(Boolean);
    const parcelaIds = toArray(req.body.parcela_ids).map(Number).filter(Boolean);
    const selecao = quotaIds.length || parcelaIds.length;

    const resultado = selecao
      ? await registarPagamentoComItens({
          fracaoId: fracaoValida.id,
          valor: toNumber(valor),
          quotaIds,
          parcelaIds,
          dataPagamento: data_pagamento || new Date(),
          metodoPagamentoId: metodo_pagamento_id || null,
          contaBancariaId,
          referencia,
          observacoes,
          userId: req.user.id,
          comprovativo,
          condominioId: req.condominioId,
        })
      : await registarPagamento({
          fracaoId: fracaoValida.id,
          valor: toNumber(valor),
          dataPagamento: data_pagamento || new Date(),
          metodoPagamentoId: metodo_pagamento_id || null,
          contaBancariaId,
          referencia,
          observacoes,
          userId: req.user.id,
          comprovativo,
          condominioId: req.condominioId,
        });
    await audit({
      userId: req.user.id,
      acao: 'registar_pagamento',
      entidade: 'Pagamento',
      entidadeId: resultado.pagamento.id,
      detalhes: { comComprovativo: Boolean(comprovativo), combinado: selecao, nQuotas: quotaIds.length, nParcelas: parcelaIds.length },
    });

    // Nota: NÃO há envio automático de recibo ao registar o pagamento — o
    // comprovativo e o recibo são conceitos distintos; a emissão de recibos
    // acontece em Quotas → Recibos ou por pagamento (evita recibos duplicados).

    const msg = `Pagamento registado${selecao ? ' (seleção combinada)' : ''}.`;
    req.flash('success_msg', resultado.excedente > 0 ? `${msg} Ficou ${resultado.excedente.toFixed(2)} € por aplicar (crédito).` : msg);
  } catch (err) {
    console.error(err);
    if (comprovativo) apagarComprovativo(comprovativo.ficheiro);
    req.flash('error_msg', err.message ? `Erro ao registar o pagamento: ${err.message}` : 'Erro ao registar o pagamento.');
    return res.redirect('/admin/pagamentos/nova');
  }
  res.redirect('/admin/pagamentos');
});

// ═══════════════════════════════════════════════════════════════════
// RECIBOS — envio em lote por email (mesmo padrão das quotas)
// ═══════════════════════════════════════════════════════════════════
async function contextoEnvioRecibos(condominioId) {
  // Isolamento: a lista (e o envio) só pode conter pagamentos do condomínio
  // ativo. Sem este filtro, a página mostrava frações/condóminos/emails de
  // outros condomínios e permitia enviar recibos alheios.
  const pagamentos = await Pagamento.findAll({
    where: { estado: 'confirmado', condominio_id: condominioId },
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
    ],
    order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
  });
  const ids = pagamentos.map((p) => p.id);
  const envios = ids.length
    ? await EmailFila.findAll({ where: { entidade_tipo: 'Pagamento', entidade_id: { [Op.in]: ids } }, order: [['id', 'ASC']] })
    : [];
  const porPagamento = {};
  for (const e of envios) (porPagamento[e.entidade_id] = porPagamento[e.entidade_id] || []).push(e);

  const linhas = [];
  for (const p of pagamentos) {
    const pessoas = await pessoasDaFracao(p.fracao_id);
    const emails = emailsUnicos(pessoas);
    const registos = porPagamento[p.id] || [];
    const enviados = registos.filter((r) => r.estado === 'enviado');
    const temErro = registos.some((r) => r.estado === 'erro');
    const pendente = registos.some((r) => ['pendente', 'a_enviar'].includes(r.estado));
    const ultimo = enviados[enviados.length - 1] || null;
    linhas.push({
      id: p.id,
      fracao: p.fracao ? p.fracao.designacao : '—',
      numero: p.numero_documento,
      data: p.data_pagamento,
      valor: p.valor,
      metodo: p.metodo_pagamento ? p.metodo_pagamento.nome : '—',
      condominos: pessoas.map((x) => x.nome).join(', ') || '—',
      emails: emails.join(', ') || '',
      temEmail: emails.length > 0,
      emailsLista: emails,
      estado: enviados.length ? 'enviado' : temErro ? 'erro' : pendente ? 'pendente' : 'nao_enviado',
      ultimoEnvio: ultimo ? { data: ultimo.data_enviada, email: ultimo.destinatario_email } : null,
    });
  }
  return {
    titulo: 'Recibos',
    total: linhas.length,
    comEmail: linhas.filter((l) => l.temEmail).length,
    enviados: linhas.filter((l) => l.estado === 'enviado').length,
    pendentes: linhas.filter((l) => l.temEmail && l.estado !== 'enviado').length,
    semEmail: linhas.filter((l) => !l.temEmail).length,
    comErro: linhas.filter((l) => l.estado === 'erro').length,
    linhas,
  };
}

router.get('/pagamentos/enviar-recibos', async (req, res) => {
  const ctx = await contextoEnvioRecibos(req.condominioId);
  res.render('admin/pagamentos/enviar-recibos', { titulo: 'Enviar recibos por email', driveLigado: storage.isConfigured(req.condominioId), ...ctx });
});

router.post('/pagamentos/enviar-recibos', async (req, res) => {
  const ctx = await contextoEnvioRecibos(req.condominioId);
  const pedidoIds = new Set((Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : []).map(Number));
  const reenviar = req.body.reenviar === '1' || req.body.reenviar === 'on';
  const modoPendentes = req.body.modo === 'pendentes';
  const alvos = ctx.linhas.filter((l) => (modoPendentes ? l.temEmail && l.estado !== 'enviado' : pedidoIds.has(l.id)));
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const condEm = await getCondominio({ id: req.condominioId });
  const condNome = (condEm && String(condEm.designacao || '').trim()) || '';
  const adminNome = (condEm && String(condEm.administracao_nome || '').trim()) || '';
  const r = await enfileirarLoteEmails({
    linhas: alvos,
    entidadeTipo: 'Pagamento',
    reenviar,
    condominioId: req.condominioId,
    userId: req.user.id,
    link: (l) => `${baseUrl}/admin/pagamentos/${l.id}/recibo`,
    assunto: (l) => `Recibo ${l.numero || ''} — ${l.fracao}`.trim(),
    corpo: (l, url) => `Fração ${l.fracao}\nValor: ${l.valor} €\nData: ${String(l.data || '')}\n\nRecibo: ${url}`,
    mensagemDe: (l) => {
      const url = `${baseUrl}/admin/pagamentos/${l.id}/recibo`;
      const nome = l.condominos && l.condominos !== '—' ? String(l.condominos).split(',')[0].trim() : undefined;
      const tpl = comporEmail('recibo', {
        destinatarioNome: nome,
        condominio: condNome,
        administracao: adminNome,
        valor: `${l.valor} €`,
        referencia: l.numero,
        data: String(l.data || ''),
        urlOnline: url,
      });
      return { assunto: tpl.assunto, corpo: tpl.text, corpo_html: tpl.html };
    },
    anexoDe: async (l) => {
      const { buffer } = await construirRecibo(l.id, req.condominioId);
      return { nome: nomeFicheiroEmail('recibo', { numero: l.numero || l.id }), buffer };
    },
  });
  await audit({
    userId: req.user.id,
    acao: 'enviar_recibos_email',
    entidade: 'Pagamento',
    detalhes: { enfileirados: r.enfileirados, ignorados: r.ignorados, semEmail: r.semEmail, reenviar },
  }).catch(() => {});
  req.flash('success_msg', `${r.enfileirados} recibo(s) enfileirado(s).${r.ignorados ? ` ${r.ignorados} já tinham envio (não duplicados).` : ''}${r.semEmail ? ` ${r.semEmail} sem email.` : ''}`);
  res.redirect('/admin/pagamentos/enviar-recibos');
});

router.get('/pagamentos/:id', async (req, res) => {
  const pagamento = await Pagamento.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: ContaBancaria, as: 'conta_bancaria' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor_aplicado'] } },
      {
        model: ExtraQuotaParcela,
        as: 'parcelasExtra',
        through: { attributes: ['valor_aplicado'] },
        include: [{ model: ExtraQuota, as: 'extra_quota', attributes: ['designacao'] }],
      },
    ],
  });
  if (!pagamento) return res.redirect('/admin/pagamentos');

  // Recibos existentes que cobrem itens deste pagamento (anti-duplicação na UI):
  // recibo é o documento emitido a partir do pagamento — se já existir, apenas
  // se consulta/abre; nunca se cria outro.
  const idsQuotas = (pagamento.quotas || []).map((q) => q.id);
  const idsParcelas = (pagamento.parcelasExtra || []).map((p) => p.id);
  const reciboIds = new Set();
  if (idsQuotas.length) {
    const linhas = await ReciboQuota.findAll({ where: { quota_id: { [Op.in]: idsQuotas } }, attributes: ['recibo_id'], raw: true });
    linhas.forEach((l) => reciboIds.add(Number(l.recibo_id)));
  }
  if (idsParcelas.length) {
    const linhas = await ReciboExtraParcela.findAll({ where: { extra_quota_parcela_id: { [Op.in]: idsParcelas } }, attributes: ['recibo_id'], raw: true });
    linhas.forEach((l) => reciboIds.add(Number(l.recibo_id)));
  }
  const recibosPagamento = reciboIds.size
    ? await Recibo.findAll({
        where: { id: { [Op.in]: [...reciboIds] }, condominio_id: req.condominioId, estado: 'emitido' },
        order: [['data_emissao', 'DESC'], ['id', 'DESC']],
      })
    : [];

  // Vista de SUPORTE quando o pedido vem do contexto de suporte: a vista
  // administrativa traz o fluxo completo de comprovativos e a emissão de
  // recibos (escrita). A de suporte mostra os mesmos dados de diagnóstico
  // (documento, valor, data, estado, método, referência, aplicações) sem nada
  // de escrita e sem o ficheiro do comprovativo.
  res.render(req.suporte ? 'admin/pagamentos/detalhe-suporte' : 'admin/pagamentos/detalhe', {
    titulo: `Pagamento ${pagamento.numero_documento || ''}`,
    pagamento,
    driveLigado: storage.isConfigured(req.condominioId),
    recibosPagamento,
    temRecibo: recibosPagamento.length > 0,
  });
});

router.post('/pagamentos/:id/anular', async (req, res) => {
  try {
    // Guarda IDOR: só anula pagamentos do condomínio ativo.
    const pagamento = await Pagamento.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
    if (!pagamento) {
      req.flash('error_msg', 'Pagamento não encontrado neste condomínio.');
      return res.redirect('/admin/pagamentos');
    }
    const ok = await anularPagamento(pagamento.id);
    await audit({ userId: req.user.id, acao: 'anular_pagamento', entidade: 'Pagamento', entidadeId: pagamento.id });
    req.flash('success_msg', ok ? 'Pagamento anulado.' : 'Pagamento já se encontrava anulado.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao anular o pagamento.');
  }
  res.redirect('/admin/pagamentos');
});

// ── PDFs ───────────────────────────────────────────────────────────
async function nomeProprietarioPrincipal(fracaoId) {
  const pessoas = await pessoasDaFracao(fracaoId);
  const proprietario = pessoas.find((p) => p.vinculoAtual === 'proprietario') || pessoas[0];
  return proprietario ? proprietario.nome : 'Condómino';
}

// Gera o buffer do aviso de quota (partilhado entre ver/descarregar e Drive).
async function construirAvisoQuota(quotaId, condominioId, extrasIds = []) {
  const quota = await Quota.findOne({
    where: { id: quotaId, condominio_id: condominioId },
    include: [{ model: Fracao, as: 'fracao' }],
  });
  if (!quota) throw new Error('Quota não encontrada neste condomínio.');
  const condominio = await getCondominio({ id: condominioId });
  const resumo = await resumoFracao(quota.fracao_id);
  const destinatarioNome = await nomeProprietarioPrincipal(quota.fracao_id);

  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: quota.id },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'] }],
  });
  const pagoAplicadoC = aplicacoes
    .filter((a) => a.pagamento && a.pagamento.estado === 'confirmado')
    .reduce((s, a) => s + toCents(a.valor_aplicado), 0);
  const quotaEmAberto = fromCents(toCents(quota.valor) - pagoAplicadoC);
  const emDividaC = toCents(resumo.emDivida);
  const saldoAnterior = fromCents(emDividaC - toCents(quota.valor) + pagoAplicadoC);

  // Quotas Extra incluídas neste aviso (seleção explícita do administrador).
  // Regras: quota extra 'processada', parcela 'pendente'/'cobrada', vencimento
  // no mês do aviso, mesma fração e mesmo condomínio. Parcelas pagas/anuladas
  // nunca entram; parcelas já cobradas só são mostradas se forem exatamente as
  // escolhidas (o POST de inclusão já as marcou como cobradas).
  let extras = [];
  let extrasTotalC = 0;
  const idsExtras = (Array.isArray(extrasIds) ? extrasIds : String(extrasIds || '').split(',')).map((x) => parseInt(x, 10)).filter(Number.isFinite);
  if (idsExtras.length) {
    const inicio = `${quota.ano}-${String(quota.mes).padStart(2, '0')}-01`;
    const fim = `${quota.ano}-${String(quota.mes).padStart(2, '0')}-31`;
    const parcelas = await ExtraQuotaParcela.findAll({
      where: {
        id: { [Op.in]: idsExtras },
        fracao_id: quota.fracao_id,
        estado: { [Op.in]: ['pendente', 'cobrada'] },
        data_vencimento: { [Op.between]: [inicio, fim] },
      },
      include: [
        {
          model: ExtraQuota,
          as: 'extra_quota',
          attributes: ['designacao', 'estado', 'condominio_id'],
          where: { condominio_id: condominioId, estado: 'processada' },
          required: true,
        },
      ],
      order: [['data_vencimento', 'ASC']],
    });
    extras = parcelas.map((p) => ({
      designacao: p.extra_quota.designacao,
      detalhe: `Parcela ${p.parcela_numero} de ${p.extra_quota.designacao} (venc. ${String(p.data_vencimento).slice(0, 10)})`,
      valorAplicado: p.valor,
    }));
    extrasTotalC = extras.reduce((s, e) => s + toCents(e.valorAplicado), 0);
  }
  const totalAPagar = fromCents(toCents(quotaEmAberto) + extrasTotalC);

  const buffer = await gerarAvisoQuotaPDF(condominio.toJSON(), {
    numero: quota.numero_documento,
    periodo: `${monthName(quota.mes)} ${quota.ano}`,
    dataEmissao: quota.data_emissao,
    dataVencimento: quota.data_vencimento,
    valor: quota.valor,
    // Componentes guardadas na quota (discriminação quota corrente + FCR no PDF).
    valorBase: quota.valor_base,
    valorFcr: quota.valor_fcr,
    fcrPercentagem: quota.fcr_percentagem,
    destinatarioNome,
    fracaoDesignacao: quota.fracao.designacao,
    fracaoMorada: [condominio.morada, [condominio.codigo_postal, condominio.localidade].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    saldoAnterior,
    ultimoPagamento: resumo.ultimoPagamento,
    ultimoPagamentoValor: resumo.ultimoPagamento ? resumo.ultimoPagamento.valor : null,
    ultimoPagamentoData: resumo.ultimoPagamento ? resumo.ultimoPagamento.data : null,
    emDivida: resumo.emDivida,
    totalAPagar,
    extras,
    iban: condominio.iban_principal,
    outrosMeiosPagamento: condominio.outros_meios_pagamento,
    referencia: null,
    instrucoesPagamento: condominio.dados_bancarios_adicionais,
  });
  return { buffer, quota, extras };
}

// Gera o buffer do recibo (partilhado entre ver/descarregar e Drive).
async function construirRecibo(pagamentoId, condominioId) {
  const pagamento = await Pagamento.findOne({
    where: { id: pagamentoId, condominio_id: condominioId },
    include: [
      { model: Fracao, as: 'fracao' },
      { model: MetodoPagamento, as: 'metodo_pagamento' },
      { model: Quota, as: 'quotas', through: { attributes: ['valor_aplicado', 'valor_base', 'valor_fcr'] } },
    ],
  });
  if (!pagamento) throw new Error('Pagamento não encontrado neste condomínio.');
  const condominio = await getCondominio({ id: condominioId });
  const resumo = await resumoFracao(pagamento.fracao_id);
  const condominoNome = await nomeProprietarioPrincipal(pagamento.fracao_id);

  const buffer = await gerarReciboPDF(condominio.toJSON(), {
    numero: pagamento.numero_documento,
    data: pagamento.data_pagamento,
    dataPagamento: pagamento.data_pagamento,
    valor: pagamento.valor,
    condominoNome,
    fracaoDesignacao: pagamento.fracao.designacao,
    metodoPagamento: pagamento.metodo_pagamento ? pagamento.metodo_pagamento.nome : null,
    referencia: pagamento.referencia,
    quotas: pagamento.quotas.map((q) => ({
      numero: q.numero_documento,
      periodo: `${monthName(q.mes)} ${q.ano}`,
      valorAplicado: q.PagamentoQuota ? q.PagamentoQuota.valor_aplicado : 0,
      // Componentes guardadas na ligação pagamento↔quota (valor_base/valor_fcr):
      // permitem discriminar quota corrente + FCR no PDF, sem recalcular nada.
      valorBase: q.PagamentoQuota ? q.PagamentoQuota.valor_base : null,
      valorFcr: q.PagamentoQuota ? q.PagamentoQuota.valor_fcr : null,
    })),
    saldoAposPagamento: resumo.emDivida,
  });
  return { buffer, pagamento };
}

// ── Aviso com Quotas Extra: seleção explícita de extras elegíveis ──
// Só aparecem parcelas de quotas extra 'processadas', 'pendentes' (ainda não
// cobradas), da mesma fração e com vencimento no mês do aviso.
router.get('/quotas/:id/aviso/extras', async (req, res) => {
  const quota = await Quota.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Fracao, as: 'fracao' }],
  });
  if (!quota) return res.redirect('/admin/quotas');
  const inicio = `${quota.ano}-${String(quota.mes).padStart(2, '0')}-01`;
  const fim = `${quota.ano}-${String(quota.mes).padStart(2, '0')}-31`;
  const elegiveis = await ExtraQuotaParcela.findAll({
    where: {
      fracao_id: quota.fracao_id,
      estado: 'pendente',
      data_vencimento: { [Op.between]: [inicio, fim] },
    },
    include: [
      {
        model: ExtraQuota,
        as: 'extra_quota',
        attributes: ['designacao', 'estado', 'condominio_id'],
        where: { condominio_id: req.condominioId, estado: 'processada' },
        required: true,
      },
    ],
    order: [['data_vencimento', 'ASC']],
  });
  res.render('admin/quotas/aviso-extras', {
    titulo: `Incluir Quotas Extra no aviso — ${quota.fracao ? quota.fracao.designacao : ''}`,
    quota,
    elegiveis,
    MESES_CURTO_FINANCEIRO: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
  });
});

// Marca as parcelas escolhidas como 'cobrada' (evita cobrança duplicada) e
// devolve o aviso PDF já com as linhas extra.
router.post('/quotas/:id/aviso/extras', async (req, res) => {
  const quota = await Quota.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Fracao, as: 'fracao' }],
  });
  if (!quota) return res.redirect('/admin/quotas');
  const ids = toArray(req.body.parcelas).map((x) => parseInt(x, 10)).filter(Number.isFinite);

  const inicio = `${quota.ano}-${String(quota.mes).padStart(2, '0')}-01`;
  const fim = `${quota.ano}-${String(quota.mes).padStart(2, '0')}-31`;
  const elegiveis = ids.length
    ? await ExtraQuotaParcela.findAll({
        where: {
          id: { [Op.in]: ids },
          fracao_id: quota.fracao_id,
          estado: 'pendente',
          data_vencimento: { [Op.between]: [inicio, fim] },
        },
        include: [
          {
            model: ExtraQuota,
            as: 'extra_quota',
            attributes: ['id', 'designacao', 'estado', 'condominio_id'],
            where: { condominio_id: req.condominioId, estado: 'processada' },
            required: true,
          },
        ],
      })
    : [];
  if (!elegiveis.length) {
    req.flash('error_msg', 'Selecione pelo menos uma Quota Extra elegível para incluir no aviso.');
    return res.redirect(`/admin/quotas/${quota.id}/aviso/extras`);
  }
  const marcadas = elegiveis.map((p) => p.id);
  await ExtraQuotaParcela.update({ estado: 'cobrada' }, { where: { id: { [Op.in]: marcadas } } });
  await audit({
    userId: req.user.id,
    acao: 'incluir_quota_extra_aviso',
    entidade: 'Quota',
    entidadeId: quota.id,
    detalhes: { parcelas: marcadas },
  }).catch(() => {});
  return res.redirect(`/admin/quotas/${quota.id}/aviso?extras=${marcadas.join(',')}&incluido=1`);
});

router.get('/quotas/:id/aviso', async (req, res) => {
  try {
    // ?extras=ids → aviso com linhas de Quotas Extra (escolha explícita).
    const extras = String(req.query.extras || '').split(',').filter(Boolean);
    const { buffer, quota } = await construirAvisoQuota(req.params.id, req.condominioId, extras);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', cabecalhos.disposicao(`aviso_${quota.numero_documento || quota.id}.pdf`, 'inline', 'aviso.pdf'));
    res.send(buffer);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao gerar o aviso de quota.');
    res.redirect('/admin/quotas');
  }
});

router.get('/pagamentos/:id/recibo', async (req, res) => {
  try {
    const { buffer, pagamento } = await construirRecibo(req.params.id, req.condominioId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', cabecalhos.disposicao(`recibo_${pagamento.numero_documento || pagamento.id}.pdf`, 'inline', 'recibo.pdf'));
    res.send(buffer);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao gerar o recibo.');
    res.redirect('/admin/pagamentos');
  }
});

// Emite UM recibo RCP para um pagamento (quotas normais e/ou Quotas Extra
// discriminadas no mesmo recibo) e regista o Documento na biblioteca.
router.post('/pagamentos/:id/recibo/emitir', async (req, res) => {
  const pagamento = await Pagamento.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId, estado: 'confirmado' },
  });
  if (!pagamento) {
    req.flash('error_msg', 'Pagamento não encontrado neste condomínio.');
    return res.redirect('/admin/pagamentos');
  }
  try {
    const { recibo } = await recibos.emitirReciboDePagamento({
      pagamentoId: pagamento.id,
      condominioId: req.condominioId,
      userId: req.user.id,
    });
    // Documento do recibo na biblioteca (apenas quando o armazenamento do
    // condomínio está ligado, exatamente como na emissão atual de recibos).
    await quotaModulo.garantirDocumentoRecibo(recibo.id, { condominioId: req.condominioId, userId: req.user.id }).catch(() => null);
    await audit({
      userId: req.user.id,
      acao: 'emitir_recibo_pagamento',
      entidade: 'Recibo',
      entidadeId: recibo.id,
      detalhes: { pagamentoId: pagamento.id },
    }).catch(() => {});
    req.flash('success_msg', `Recibo ${recibo.codigo} emitido para este pagamento (com discriminação).`);
    return res.redirect(`/admin/quotas/recibos/${recibo.id}/pdf`);
  } catch (err) {
    console.error('[recibo-pagamento]', err.message);
    req.flash('error_msg', err.message || 'Não foi possível emitir o recibo deste pagamento.');
  }
  return res.redirect(`/admin/pagamentos/${pagamento.id}`);
});

// Guarda no armazenamento do condomínio um PDF gerado pelo Financeiro
// (aviso/recibo) e regista-o como Documento (fica disponível na biblioteca
// para enviar por email).
async function guardarPdfFinanceiroDrive({ tipo, numeroDocumento, nome, buffer, anoData, userId, condominioId }) {
  if (!storage.isConfigured(condominioId)) throw new Error('O armazenamento do condomínio não está ligado (Configuração → Armazenamento e Backups).');
  const pastaId = await storage.pastaParaDocumento(tipo, anoData, condominioId);
  const up = await storage.uploadArquivo({ nome, mimeType: 'application/pdf', buffer, parentFolderId: pastaId, condominioId });
  const doc = await Documento.create({
    condominio_id: condominioId,
    tipo,
    numero_documento: numeroDocumento || null,
    nome,
    // Classificação central (recibo → recibos; aviso_quota → outros; etc.)
    pasta: resolverPastaDocumento({ tipo, pastaEscolhida: null, pastasValidas: Object.keys(PASTAS_BASE) }).pasta,
    drive_file_id: up.localizador || up.driveFileId || null,
    drive_folder_id: pastaId,
    mime_type: 'application/pdf',
    tamanho: up.tamanho,
    data: anoData ? new Date(anoData, 0, 1) : new Date(),
    url: up.url,
    drive_status: 'guardado',
    drive_uploaded_at: new Date(),
    created_by: userId,
  });
  return { doc, up };
}

router.post('/quotas/:id/aviso/drive', async (req, res) => {
  try {
    const { buffer, quota } = await construirAvisoQuota(req.params.id, req.condominioId);
    const ano = quota.data_emissao ? new Date(quota.data_emissao).getFullYear() : new Date().getFullYear();
    const { doc } = await guardarPdfFinanceiroDrive({
      tipo: 'aviso_quota',
      numeroDocumento: quota.numero_documento,
      nome: `Aviso de quota ${quota.numero_documento || quota.id}`,
      buffer,
      anoData: ano,
      userId: req.user.id,
      condominioId: req.condominioId,
    });
    await audit({ userId: req.user.id, acao: 'guardar_documento_drive', entidade: 'Documento', entidadeId: doc.id, detalhes: { tipo: 'aviso_quota' } }).catch(() => {});
    req.flash('success_msg', 'Aviso de quota guardado no armazenamento do condomínio.');
  } catch (err) {
    console.error('[aviso-drive]', err.message);
    req.flash('error_msg', `Não foi possível guardar no armazenamento do condomínio: ${err.message}`);
  }
  res.redirect(req.get('Referer') || '/admin/quotas');
});

router.post('/pagamentos/:id/recibo/drive', async (req, res) => {
  try {
    const { buffer, pagamento } = await construirRecibo(req.params.id, req.condominioId);
    const ano = pagamento.data_pagamento ? new Date(pagamento.data_pagamento).getFullYear() : new Date().getFullYear();
    const { doc } = await guardarPdfFinanceiroDrive({
      tipo: 'recibo',
      numeroDocumento: pagamento.numero_documento,
      nome: `Recibo ${pagamento.numero_documento || pagamento.id}`,
      buffer,
      anoData: ano,
      userId: req.user.id,
      condominioId: req.condominioId,
    });
    await audit({ userId: req.user.id, acao: 'guardar_documento_drive', entidade: 'Documento', entidadeId: doc.id, detalhes: { tipo: 'recibo' } }).catch(() => {});
    req.flash('success_msg', 'Recibo guardado no armazenamento do condomínio.');
  } catch (err) {
    console.error('[recibo-drive]', err.message);
    req.flash('error_msg', `Não foi possível guardar no armazenamento do condomínio: ${err.message}`);
  }
  res.redirect(req.get('Referer') || '/admin/pagamentos');
});

// ── Processamento em segundo plano: pós-geração de quotas ──────────
// (PDFs → armazenamento do condomínio → emails para a email_fila). Idempotente:
// não duplica documentos (verifica Documento associado) nem emails
// (existeEnvioPara), mesmo quando a tarefa corre/repete mais do que uma vez.
async function processarPosGeracaoQuotas({ ano, mes, guardarDrive, enviarEmail, userId, baseUrl, condominioId }, progresso) {
  if (!ano || !mes || (!guardarDrive && !enviarEmail)) return;

  // Multi-condomínio: processa apenas o condomínio que gerou as quotas.
  // Sem condominioId (tarefas antigas) não adivinha — ignora (evita processar
  // ou enviar dados do condomínio errado).
  const cid = condominioId || null;
  if (!cid) {
    console.warn('[quotas-bg] tarefa sem condominioId — ignorada.');
    return;
  }

  const quotas = await Quota.findAll({
    where: { ano, mes, condominio_id: cid },
    include: [{ model: Fracao, as: 'fracao' }],
    order: [[{ model: Fracao, as: 'fracao' }, 'designacao', 'ASC']],
  });

  const total = quotas.length;
  const fases = {
    drive: { estado: guardarDrive ? 'a_processar' : 'nao_requerido', atual: 0, total },
    emails: { estado: enviarEmail ? 'a_processar' : 'nao_requerido', atual: 0, total },
  };
  progresso({ fases, resumo: {} });
  const erros = [];

  // 1) Guardar avisos no armazenamento do condomínio (idempotente por quota)
  if (guardarDrive) {
    let ok = 0;
    let atual = 0;
    for (const q of quotas) {
      atual += 1;
      try {
        const jaGuardado = await Documento.count({
          where: { entidade_tipo: 'Quota', entidade_id: q.id, drive_status: 'guardado' },
        });
        if (!jaGuardado) {
          const { buffer } = await construirAvisoQuota(q.id, cid);
          const { doc } = await guardarPdfFinanceiroDrive({
            tipo: 'aviso_quota',
            numeroDocumento: q.numero_documento,
            nome: `Aviso de quota ${q.numero_documento || q.id}`,
            buffer,
            anoData: q.ano,
            userId,
            condominioId: cid,
          });
          await doc.update({ entidade_tipo: 'Quota', entidade_id: q.id }).catch(() => {});
        }
        ok += 1;
      } catch (e) {
        erros.push(`Fração ${q.fracao ? q.fracao.designacao : q.id}: ${e.message}`);
      }
      fases.drive.atual = atual;
      progresso({ fases });
    }
    fases.drive.estado = 'concluido';
    progresso({ fases, resumo: { driveOk: ok, driveErros: erros.length } });
  }

  // 2) Colocar emails na fila (nunca envia diretamente; o scheduler trata)
  if (enviarEmail) {
    const cond = await getCondominio({ id: cid });
    const condNome = (cond && String(cond.designacao || '').trim()) || '';
    const adminNome = (cond && String(cond.administracao_nome || '').trim()) || '';
    const cctx = await contextoEnvioQuotas({ ano, mes, condominioId: cid });
    const base = baseUrl || '';
    let enfileirados = 0;
    let atual = 0;
    for (const l of cctx.linhas.filter((x) => x.temEmail)) {
      atual += 1;
      const url = `${base}/admin/quotas/${l.id}/aviso`;
      const nome = l.condominos && l.condominos !== '—' ? String(l.condominos).split(',')[0].trim() : undefined;
      const tpl = comporEmail('quota', {
        destinatarioNome: nome,
        condominio: condNome,
        administracao: adminNome,
        periodo: l.periodo,
        valor: l.valor,
        urlOnline: url,
      });
      let anexo = null;
      try {
        const { buffer } = await construirAvisoQuota(l.id, cid);
        anexo = { nome: nomeFicheiroEmail('quota', { ano: String(l.ano || ''), mes: l.mes || '', fracao: l.fracao }), buffer };
      } catch (e) {
        console.error('[quotas-bg-anexo]', e.message);
      }
      for (const email of l.emailsLista) {
        const ja = await existeEnvioPara({ entidadeTipo: 'Quota', entidadeId: l.id, email });
        if (ja) continue;
        await enfileirarEmailFila({
          destinatario_email: email,
          destinatario_nome: l.condominos !== '—' ? l.condominos : null,
          assunto: tpl.assunto,
          corpo: tpl.text,
          corpo_html: tpl.html,
          entidade_tipo: 'Quota',
          entidade_id: l.id,
          condominioId: cid,
          userId,
          anexoNome: anexo ? anexo.nome : null,
          anexoBuffer: anexo ? anexo.buffer : null,
        });
        enfileirados += 1;
      }
      fases.emails.atual = atual;
      progresso({ fases });
    }
    fases.emails.estado = 'concluido';
    progresso({ fases, resumo: { emailsEnfileirados: enfileirados } });
  }

  if (erros.length) {
    // Não falha a tarefa por itens isolados — os registos já feitos mantêm-se.
    progresso({ fases, resumo: { erros: erros.slice(0, 20) } });
  }
}

router.processarPosGeracaoQuotas = processarPosGeracaoQuotas;

module.exports = router;
