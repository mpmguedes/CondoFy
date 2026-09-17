// ─────────────────────────────────────────────────────────────────────
// Extrato bancário — consulta e cálculo dos movimentos de uma conta.
//
// Este helper concentra TODA a lógica do extrato: filtros, ordenação,
// classificação de origem e saldo corrente. As rotas limitam-se a ler os
// parâmetros e a apresentar o resultado.
//
// ── Isolamento multi-condomínio ──────────────────────────────────────
// `condominioId` é SEMPRE um argumento explícito e obrigatório: nunca é
// lido de parâmetros do browser. Todas as leituras filtram por
// `condominio_id`, e a conta selecionada é revalidada contra o condomínio
// antes de ser usada (uma conta de outro condomínio é indistinguível de
// uma conta inexistente).
//
// ── Conceito de saldo ────────────────────────────────────────────────
// Este é o saldo BANCÁRIO (movimento-based), o mesmo de
// `saldoContaMovimentos` (helpers/movimentos.js) e de `saldoContaNaData`
// (helpers/relatorio-financeiro.js) — a fórmula NÃO é reimplementada aqui.
// O saldo inicial entra uma única vez e nunca é multiplicado por JOINs.
//
// ── Preparação para a futura importação/reconciliação ────────────────
// Um movimento pode não ter origem operacional (sem pagamento_id,
// despesa_id nem parcela extra). Isso é um estado LEGÍTIMO: hoje é um
// "ajuste manual" e amanhã será um movimento importado do banco. Nada
// aqui assume o contrário, e nenhum campo de reconciliação é introduzido.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { ContaBancaria, MovimentoBancario } = require('../models');
const { toCents, fromCents } = require('../helpers/money');
const { saldoContaNaData } = require('../helpers/relatorio-financeiro');

// Referência que identifica o par de transferência entre contas próprias. O
// ENUM `transferencia` é legado (0 usos em produção) mas continua a ser lido.
const REF_TRANSFERENCIA = 'TRANSF';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Data ISO *existente* (não só com a forma certa): `2026-02-30` e
// `2026-13-01` têm a forma de uma data e não são datas. Validar isto evita
// que uma data impossível vinda do browser produza um período vazio
// silencioso, que o utilizador leria como "não há movimentos".
function dataISOValida(v) {
  const s = String(v || '');
  if (!ISO.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── Classificação de um movimento ────────────────────────────────────
// `categoria` é o QUE a UI mostra na coluna Origem. Distingue-se de `tipo`
// (entrada/saída), que é a direção do dinheiro.
const CATEGORIAS = {
  pagamento: 'pagamento',
  despesa: 'despesa',
  quotaExtra: 'quota_extra',
  transferencia: 'transferencia',
  ajuste: 'ajuste',
};

// Uma transferência é reconhecida por AMBAS as convenções: o par gravado com
// `referencia = 'TRANSF'` (o que o código escreve hoje) e o valor de ENUM
// `tipo = 'transferencia'` (histórico). A UI nunca deve mostrar duas coisas
// diferentes para a mesma realidade.
function ehTransferencia(m) {
  return String((m && m.referencia) || '') === REF_TRANSFERENCIA
    || String((m && m.tipo) || '') === 'transferencia';
}

// A categoria efetiva de um movimento, por ordem de especificidade. Pagamento,
// despesa e quota extra são origens OPERACIONAIS (criadas por outro fluxo);
// sem nenhuma delas, o movimento é manual/ajuste ou importado (futuro).
function categoriaDe(m) {
  if (Number(m.pagamento_id)) return CATEGORIAS.pagamento;
  if (Number(m.despesa_id)) return CATEGORIAS.despesa;
  if (Number(m.extra_quota_parcela_id)) return CATEGORIAS.quotaExtra;
  if (ehTransferencia(m)) return CATEGORIAS.transferencia;
  return CATEGORIAS.ajuste;
}

const ETIQUETAS = {
  [CATEGORIAS.pagamento]: 'Pagamento',
  [CATEGORIAS.despesa]: 'Despesa',
  [CATEGORIAS.quotaExtra]: 'Quota extra',
  [CATEGORIAS.transferencia]: 'Transferência',
  [CATEGORIAS.ajuste]: 'Ajuste manual',
};

// Ícone (Material Symbols) por categoria — mantém a coluna Origem legível
// sem depender de cor, que nesta tabela já distingue entrada de saída.
const ICONES = {
  [CATEGORIAS.pagamento]: 'payments',
  [CATEGORIAS.despesa]: 'credit_card',
  [CATEGORIAS.quotaExtra]: 'receipt_long',
  [CATEGORIAS.transferencia]: 'swap_horiz',
  [CATEGORIAS.ajuste]: 'tune',
};

// ── Filtros recebidos da query string ────────────────────────────────
// Devolve sempre valores já validados e prontos para uso. Não decide o
// período por omissão (essa decisão é da rota, que segue o padrão do
// Relatório Financeiro) — aqui só se valida o formato.
function lerFiltros(query = {}) {
  const valor = (v) => String(v === null || v === undefined ? '' : v).trim();
  const inicio = dataISOValida(valor(query.inicio)) ? valor(query.inicio) : '';
  const fim = dataISOValida(valor(query.fim)) ? valor(query.fim) : '';

  const tiposValidos = ['entrada', 'saida', 'transferencia'];
  const tipoBruto = valor(query.tipo);
  const tipo = tiposValidos.includes(tipoBruto) ? tipoBruto : '';

  // `conta` é um id; validado como inteiro positivo. A pertença ao condomínio
  // é verificada contra a BD em `contaDoCondominio` — nunca aqui.
  const contaBruta = valor(query.conta);
  const conta = /^\d+$/.test(contaBruta) ? Number(contaBruta) : null;

  return {
    conta,
    inicio: inicio && fim && inicio > fim ? fim : inicio,
    fim: inicio && fim && inicio > fim ? inicio : fim,
    tipo,
    estado: valor(query.estado) === 'anulado' ? 'anulado' : '',
  };
}

// Conta bancária do condomínio, com `saldo_inicial` e a data a partir da qual
// ele é válido. Devolve `null` se o id não for do condomínio — o chamador
// trata isso como "conta não encontrada" (nunca como "sem permissão", para
// não revelar a existência de contas de outros condomínios).
async function contaDoCondominio(condominioId, contaId) {
  if (!condominioId || !contaId) return null;
  return ContaBancaria.findOne({
    where: { id: contaId, condominio_id: condominioId },
    attributes: ['id', 'nome', 'banco', 'iban', 'tipo', 'saldo_inicial', 'data_inicio', 'data_saldo_inicial', 'ativa'],
  });
}

// Contas do condomínio (ativas e inativas — o extrato é histórico, uma conta
// desativada continua a ter movimentos que importa consultar).
async function contasDoCondominio(condominioId) {
  if (!condominioId) return [];
  return ContaBancaria.findAll({
    where: { condominio_id: condominioId },
    attributes: ['id', 'nome', 'banco', 'tipo', 'saldo_inicial', 'ativa'],
    order: [['ativa', 'DESC'], ['nome', 'ASC']],
  });
}

// ── Where dos movimentos ─────────────────────────────────────────────
// Sempre com `condominio_id`. Os filtros de tipo/período/conta são
// acrescentados por cima — nunca o substituem.
function construirWhere(condominioId, filtros = {}) {
  const where = { condominio_id: condominioId };

  if (filtros.conta) where.conta_bancaria_id = filtros.conta;

  if (filtros.inicio || filtros.fim) {
    where.data = {};
    if (filtros.inicio) where.data[Op.gte] = filtros.inicio;
    if (filtros.fim) where.data[Op.lte] = filtros.fim;
  }

  if (filtros.tipo) {
    // 'transferencia' abrange as DUAS convenções. Como `referencia` e `tipo`
    // são colunas diferentes, o OR é a única forma de as juntar numa só query.
    if (filtros.tipo === 'transferencia') {
      where[Op.or] = [
        { referencia: REF_TRANSFERENCIA },
        { tipo: 'transferencia' },
      ];
    } else {
      // Uma entrada/saída que seja transferência continua a ser uma
      // transferência para o utilizador: exclui-a das listas de entrada/saída
      // puras, para os totais baterem certo com o filtro "Transferência".
      where.tipo = filtros.tipo;
      where.referencia = { [Op.ne]: REF_TRANSFERENCIA };
    }
  }

  if (filtros.estado) where.estado = filtros.estado;

  return where;
}

// ── Leitura dos movimentos ───────────────────────────────────────────
// Ordem SEMPRE cronológica (data, id) — é a ordem em que o saldo corrente é
// calculado. A inversão para apresentação (mais recente primeiro) é feita
// depois de os saldos estarem atribuídos, nunca antes.
async function listarMovimentos(condominioId, filtros = {}) {
  const where = construirWhere(condominioId, filtros);
  const movimentos = await MovimentoBancario.findAll({
    where,
    attributes: [
      'id', 'conta_bancaria_id', 'data', 'tipo', 'valor', 'descricao', 'referencia',
      'categoria_id', 'quota_id', 'pagamento_id', 'despesa_id', 'extra_quota_parcela_id',
      'documento_id', 'deliberacao_id', 'estado',
    ],
    order: [['data', 'ASC'], ['id', 'ASC']],
  });
  return movimentos.map((m) => (typeof m.toJSON === 'function' ? m.toJSON() : m));
}

// ── Saldo anterior e corrente ────────────────────────────────────────
// O saldo anterior a um período é o saldo da conta à data imediatamente
// anterior ao início — calculado com os movimentos ANTERIORES, para que o
// primeiro movimento do período não comece em zero.
//
// Usa `saldoContaNaData` (helpers/relatorio-financeiro.js) para o saldo de
// abertura e de fecho: a fórmula do saldo vive num só sítio e não é
// duplicada aqui.
//
// ── Um acumulador POR CONTA ──────────────────────────────────────────
// Com o filtro "Todas as contas" a listagem tem movimentos de VÁRIAS contas
// numa só sequência cronológica. Se houvesse um único acumulador, o saldo de
// uma linha não seria o saldo de conta nenhuma: uma entrada na conta A e uma
// saída na conta B (no mesmo dia, ou em dias próximos) apareceriam somadas na
// mesma linha. Por isso o acumulador é mantido POR `conta_bancaria_id`: cada
// movimento é aplicado só ao acumulador da sua conta, e o saldo mostrado na
// linha é o acumulador dessa conta — exatamente o mesmo número que o
// utilizador veria se filtrasse por essa conta.
//
// A ordem (data, id) mantém-se global, para a leitura cronológica fazer
// sentido; o que é por conta é apenas o SALDO, não a ordenação.
//
// Assinatura: devolve um `Map` id→saldo (em cêntimos) por movimento, para o
// saldo corrente de cada linha, mais os totais do período.
//
// `saldosIniciaisPorConta` é um `Map` contaId→cêntimos com o `saldo_inicial`
// de cada conta abrangida. `saldosAnterioresPorConta` (opcional) é um `Map`
// contaId→cêntimos com o saldo de cada conta à data anterior ao período;
// quando existe, é essa a base do acumulador dessa conta.
function calcularSaldos({
  conta,
  movimentos,
  saldoAnteriorC,
  saldosIniciaisPorConta,
  saldosAnterioresPorConta,
}) {
  // Só os movimentos CONFIRMADOS alteram saldo: um anulado é histórico, não
  // dinheiro. Uma transferência de par (saida+entrada) já é tratada linha a
  // linha — cada ponta pertence a uma conta diferente, pelo que em cada conta
  // só se vê uma delas (efeito correto; o anulamento de uma ponta não é
  // responsabilidade desta fase).
  const iniciais = saldosIniciaisPorConta instanceof Map ? saldosIniciaisPorConta : new Map();
  const anteriores = saldosAnterioresPorConta instanceof Map ? saldosAnterioresPorConta : new Map();
  const contaUnica = conta ? Number(conta.id) : null;

  // Acumulador por conta. Só existe entrada para contas com movimento.
  const runPorConta = new Map();
  function acumuladorDe(contaId) {
    const id = Number(contaId);
    if (!runPorConta.has(id)) {
      // Base do acumulador desta conta, por ordem de preferência:
      //  · saldo dessa conta à data anterior ao período (já inclui os
      //    movimentos anteriores) — o caso normal com um período definido;
      //  · `saldoAnteriorC` do chamador, quando é a única conta abrangida
      //    (retrocompatibilidade com o cálculo de conta única);
      //  · o `saldo_inicial` da conta — o princípio do extrato sem período.
      let base;
      if (anteriores.has(id)) {
        base = Math.round(anteriores.get(id) || 0);
      } else if (contaUnica !== null && id === contaUnica && saldoAnteriorC !== null && saldoAnteriorC !== undefined) {
        base = Math.round(saldoAnteriorC);
      } else {
        base = Math.round(iniciais.get(id) || 0);
      }
      runPorConta.set(id, base);
    }
    return runPorConta.get(id);
  }

  const saldoPorId = new Map();
  let entradasC = 0;
  let saidasC = 0;
  let nAnulados = 0;

  for (const m of movimentos) {
    const contaId = Number(m.conta_bancaria_id);
    const atual = acumuladorDe(contaId);

    if (m.estado !== 'confirmado') {
      // Anulado: não entra no saldo, e o saldo mostrado é o saldo em vigor
      // desta conta (a linha aparece para transparência).
      saldoPorId.set(Number(m.id), atual);
      nAnulados += 1;
      continue;
    }

    const v = Math.max(0, Math.round(toCents(m.valor)));
    let seguinte = atual;
    if (m.tipo === 'entrada') { seguinte = atual + v; entradasC += v; } else if (m.tipo === 'saida') { seguinte = atual - v; saidasC += v; }
    // `transferencia` (ENUM legado) tem efeito nulo: o acumulador não muda.
    runPorConta.set(contaId, seguinte);
    saldoPorId.set(Number(m.id), seguinte);
  }

  // Saldo final: a SOMA dos acumuladores de todas as contas abrangidas —
  // inclui as contas que não tiveram movimento no período, cujo saldo final é
  // o seu saldo à data anterior (ou o inicial, sem período). Assim o total do
  // extrato continua a ser o total das contas, mesmo quando o período não
  // tocou algumas delas.
  let saldoFinalC = 0;
  const vistas = new Set();
  for (const [id, v] of runPorConta) { saldoFinalC += v; vistas.add(Number(id)); }
  for (const [id, v] of iniciais) {
    if (vistas.has(Number(id))) continue;
    saldoFinalC += anteriores.has(Number(id))
      ? Math.round(anteriores.get(Number(id)) || 0)
      : Math.round(v || 0);
  }

  return {
    saldoPorId,
    saldoFinalC,
    entradasC,
    saidasC,
    nAnulados,
  };
}

// ── Consulta completa do extrato ─────────────────────────────────────
// Devolve tudo o que a vista precisa, já em unidades de apresentação (euros
// como número/string, não cêntimos) e com a classificação de origem feita.
//
// `filtros.inicio`/`filtros.fim` são opcionais. Quando existem, o saldo
// anterior é calculado com os movimentos anteriores; sem período, o saldo
// anterior é o saldo inicial da conta (o princípio do extrato).
async function extrato({ condominioId, filtros = {} }) {
  const movimentos = await listarMovimentos(condominioId, filtros);

  // Conta selecionada (se houver). Sem conta (filtro "todas"), o saldo
  // corrente é calculado POR CONTA — ver `calcularSaldos`.
  let conta = null;
  if (filtros.conta) conta = await contaDoCondominio(condominioId, filtros.conta);

  // ── Saldo inicial ─────────────────────────────────────────────────
  // Somatório dos saldos iniciais das contas abrangidas, cada um contado UMA
  // vez (soma de atributos de contas, nunca de linhas multiplicadas por JOIN).
  // O mesmo conjunto serve para o mapa por conta usado no saldo corrente.
  const contasAlvo = conta ? [conta] : await contasDoCondominio(condominioId);
  const saldosIniciaisPorConta = new Map(
    contasAlvo.map((c) => [Number(c.id), toCents(c.saldo_inicial)])
  );
  const saldoInicialC = contasAlvo.reduce((s, c) => s + toCents(c.saldo_inicial), 0);

  // ── Saldo anterior ao período ─────────────────────────────────────
  // O saldo de abertura de cada conta à data imediatamente anterior ao início.
  // Calculado por conta com os movimentos ANTERIORES, para que o primeiro
  // movimento do período não comece em zero. A fórmula continua a ser a de
  // `saldoContaNaData` — reutilizada, nunca duplicada.
  let saldoAnteriorC = saldoInicialC;
  let saldosAnterioresPorConta = null;
  if (filtros.inicio) {
    const anteriores = await listarMovimentos(condominioId, {
      conta: filtros.conta,
      fim: dataAnterior(filtros.inicio),
    });
    const corte = dataAnterior(filtros.inicio);
    saldosAnterioresPorConta = new Map();
    for (const c of contasAlvo) {
      const daConta = anteriores.filter((m) => Number(m.conta_bancaria_id) === Number(c.id));
      saldosAnterioresPorConta.set(
        Number(c.id),
        saldoContaNaData({
          saldoInicialC: toCents(c.saldo_inicial),
          movimentos: daConta,
          dataCorte: corte,
        }).saldoC
      );
    }
    // Com uma só conta, `saldoAnteriorC` é esse saldo; com várias, é a soma
    // (o mesmo total que o resumo agregado mostrava antes).
    saldoAnteriorC = [...saldosAnterioresPorConta.values()].reduce((s, v) => s + v, 0);
  }

  const { saldoPorId, saldoFinalC, entradasC, saidasC, nAnulados } = calcularSaldos({
    conta,
    movimentos,
    saldoAnteriorC,
    saldosIniciaisPorConta,
    saldosAnterioresPorConta,
  });

  const linhas = movimentos.map((m) => {
    const categoria = categoriaDe(m);
    const transferencia = categoria === CATEGORIAS.transferencia;
    return {
      id: m.id,
      data: m.data,
      descricao: m.descricao || '',
      tipo: m.tipo,
      estado: m.estado,
      anulado: m.estado !== 'confirmado',
      transferencia,
      // Valores em euros para as vistas (o helper `eur` formata-os).
      valor: fromCents(Math.round(toCents(m.valor))),
      valorC: Math.round(toCents(m.valor)),
      saldo: fromCents(saldoPorId.get(Number(m.id)) || 0),
      saldoC: saldoPorId.get(Number(m.id)) || 0,
      contaId: Number(m.conta_bancaria_id),
      categoria,
      categoriaEtiqueta: ETIQUETAS[categoria],
      categoriaIcone: ICONES[categoria],
      // Origem operacional: só se preenche o que existe, para a vista poder
      // decidir se mostra ligação. Nunca inventa uma origem.
      pagamentoId: m.pagamento_id ? Number(m.pagamento_id) : null,
      despesaId: m.despesa_id ? Number(m.despesa_id) : null,
      extraQuotaParcelaId: m.extra_quota_parcela_id ? Number(m.extra_quota_parcela_id) : null,
      deliberacaoId: m.deliberacao_id ? Number(m.deliberacao_id) : null,
      // Um movimento com origem operacional NÃO é editável no extrato: a
      // alteração faz-se na entidade de origem, pelo fluxo que já existe.
      // Um ajuste manual (sem origem) pode ser anulado aqui.
      editavel: categoria === CATEGORIAS.ajuste,
    };
  });

  // ── Transferências: «De → Para» quando determinável ──────────────
  // O par é identificado pelo mesmo critério já usado no FCR (mesmo valor,
  // mesma data, conta diferente). A função é a mesma — vive em
  // `emparelharTransferencias`, exportada, para não haver duas políticas.
  // A ligação é feita sobre os movimentos já lidos: NÃO há join novo, pelo que
  // não há risco de multiplicar linhas.
  const nomePorConta = new Map(contasAlvo.map((c) => [Number(c.id), c.nome || `Conta ${c.id}`]));
  for (const l of linhas) l.contaNome = nomePorConta.get(l.contaId) || null;
  anotarTransferencias(linhas, nomePorConta);

  // Apresentação: do mais recente para o mais antigo. Os saldos já estão
  // atribuídos (foram calculados na ordem cronológica), pelo que inverter
  // agora só afeta a leitura — nunca os números.
  const apresentacao = linhas.slice().reverse();

  return {
    conta: conta
      ? { id: conta.id, nome: conta.nome, banco: conta.banco, tipo: conta.tipo, ativa: conta.ativa }
      : null,
    linhas: apresentacao,
    temMovimentos: linhas.length > 0,
    resumo: {
      saldoInicialC,
      saldoAnterior: fromCents(saldoAnteriorC),
      saldoAnteriorC,
      entradas: fromCents(entradasC),
      entradasC,
      saidas: fromCents(saidasC),
      saidasC,
      saldoFinal: fromCents(saldoFinalC),
      saldoFinalC,
      nMovimentos: linhas.length,
      nAnulados,
      // Sem período, o "saldo anterior" é o saldo inicial da conta; com
      // período, é o saldo à data anterior. A vista usa isto para rotular.
      temPeriodo: Boolean(filtros.inicio || filtros.fim),
    },
  };
}

// Dia imediatamente anterior a uma data ISO (aritmética de calendário, sem
// depender de fusos: as datas do extrato são DATEONLY).
function dataAnterior(iso) {
  const [a, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

// ── Emparelhamento das transferências ────────────────────────────────
// Uma transferência entre contas próprias é gravada como um PAR de movimentos
// (uma saída e uma entrada, com `referencia = 'TRANSF'`). Este par é
// reconstruído pelo MESMO critério já usado no Fundo de Reserva
// (helpers/fcr.js): mesmo valor, mesma data, contas diferentes.
//
// É uma função pura: recebe os movimentos já lidos e devolve os pares. Não faz
// joins nem consultas — não pode multiplicar linhas nem revelar dados de outro
// condomínio (os movimentos que recebe já vieram filtrados por `condominio_id`).
//
// Devolve `{ pares, porId }`, onde `porId` mapeia id→{deId,paraId} para as
// pontas emparelhadas. Um movimento cujo par não seja determinável simplesmente
// não aparece em `porId` — a vista mostra só «Transferência».
function emparelharTransferencias(movimentos = []) {
  // Aceita tanto os movimentos lidos da BD (`conta_bancaria_id`, `valor`)
  // como as linhas já formatadas para a vista (`contaId`, `valorC`). Assim a
  // mesma função serve para o helper e para quem já tenha as linhas prontas.
  const contaDe = (m) => Number(m.conta_bancaria_id !== undefined ? m.conta_bancaria_id : m.contaId);
  const centDe = (m) => (m.valorC !== undefined ? Math.round(m.valorC) : Math.round(toCents(m.valor)));
  const dataDe = (m) => String(m.data || '').slice(0, 10);
  const ehTransf = (m) => (m.transferencia === true ? true : ehTransferencia(m));

  const transf = movimentos.filter((m) => ehTransf(m) && m.estado === 'confirmado');
  const entradas = transf.filter((m) => m.tipo === 'entrada');
  const saidas = transf.filter((m) => m.tipo === 'saida');
  const saidasUsadas = new Set();
  const pares = [];

  for (const entrada of entradas) {
    const contaEntrada = contaDe(entrada);
    const candidatas = saidas.filter((s) => !saidasUsadas.has(s.id)
      && centDe(s) === centDe(entrada)
      && dataDe(s) === dataDe(entrada));
    // Prefere a saída de OUTRA conta — é a origem real da transferência.
    const par = candidatas.find((s) => contaDe(s) !== contaEntrada) || candidatas[0] || null;
    if (!par) continue;
    saidasUsadas.add(par.id);
    // Sem conta diferente não há origem/destino determinável: seria a mesma
    // conta dos dois lados. Fica como "Transferência" e nada mais.
    if (contaDe(par) === contaEntrada) continue;
    pares.push({
      saidaId: Number(par.id),
      entradaId: Number(entrada.id),
      deId: contaDe(par),
      paraId: contaEntrada,
      valorC: centDe(entrada),
      data: dataDe(entrada),
    });
  }

  const porId = new Map();
  for (const p of pares) {
    porId.set(p.saidaId, { deId: p.deId, paraId: p.paraId, valorC: p.valorC, data: p.data });
    porId.set(p.entradaId, { deId: p.deId, paraId: p.paraId, valorC: p.valorC, data: p.data });
  }
  return { pares, porId };
}

// Anota cada linha com `transferenciaDe`/`transferenciaPara` (nomes das
// contas) quando o par é determinável. Sem par, deixa os campos a `null` e a
// vista mostra apenas «Transferência».
function anotarTransferencias(linhas, nomePorConta = new Map()) {
  const { porId } = emparelharTransferencias(linhas);
  for (const l of linhas) {
    const par = porId.get(Number(l.id)) || null;
    l.transferenciaDe = par ? (nomePorConta.get(par.deId) || null) : null;
    l.transferenciaPara = par ? (nomePorConta.get(par.paraId) || null) : null;
    l.transferenciaTemPar = Boolean(par && l.transferenciaDe && l.transferenciaPara);
  }
}

module.exports = {
  REF_TRANSFERENCIA,
  CATEGORIAS,
  ETIQUETAS,
  ISO,
  ehTransferencia,
  categoriaDe,
  dataISOValida,
  lerFiltros,
  construirWhere,
  contaDoCondominio,
  contasDoCondominio,
  listarMovimentos,
  calcularSaldos,
  dataAnterior,
  emparelharTransferencias,
  anotarTransferencias,
  extrato,
};
