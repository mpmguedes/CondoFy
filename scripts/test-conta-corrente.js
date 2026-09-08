// Testes offline da Conta-corrente (módulo Quotas) — sem base de dados.
//
// Cobre o motor puro do extrato (débitos/créditos/saldo acumulado) e os
// invariantes estruturais de isolamento multi-condomínio das consultas.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { construirExtrato, filtrarExtratoPorAno } = require('../helpers/conta-corrente');

const rotaQuotas = fs.readFileSync(path.join(__dirname, '..', 'routes', 'quotas-modulo.js'), 'utf8');
const helperCC = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'conta-corrente.js'), 'utf8');
const vistaCC = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'quotas', 'conta-corrente.handlebars'), 'utf8');
const vistaMapa = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'quotas', 'mapa.handlebars'), 'utf8');
const vistaRecibos = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'quotas', 'recibos.handlebars'), 'utf8');
const vistaPagamentos = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'quotas', 'comprovativos.handlebars'), 'utf8');
const vistaExtraListar = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'quotas-extra', 'listar.handlebars'), 'utf8');
const tabs = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', '_quotas-tabs.handlebars'), 'utf8');

function quota(mes, ano, valor, dataISO) {
  return {
    tipo: 'quota',
    dataISO: dataISO || `${ano}-${String(mes).padStart(2, '0')}-15`,
    rotulo: `Quota de ${mes} ${ano}`,
    detalhe: '',
    debito: valor,
    credito: 0,
  };
}
function parcela(designacao, numero, valor, dataISO) {
  return {
    tipo: 'parcela',
    dataISO: dataISO || '2026-10-15',
    rotulo: `Quota extraordinária — ${designacao}`,
    detalhe: `Parcela ${numero}`,
    debito: valor,
    credito: 0,
  };
}
function pagamento(dataISO, valor, numero) {
  return {
    tipo: 'pagamento',
    dataISO,
    rotulo: `Pagamento — ${numero}`,
    detalhe: '',
    debito: 0,
    credito: valor,
  };
}
function cents(n) {
  return Math.round(n * 100);
}

// ── Cenário 1: quota normal sem pagamento ───────────────────────────
function cenarioQuotaSemPagamento() {
  const e = construirExtrato({ entradas: [quota(6, 2026, 61.22)] });
  assert.strictEqual(e.linhas.length, 1, '1 débito');
  assert.strictEqual(e.saldoC, cents(61.22), 'saldo = dívida da quota');
}

// ── Cenário 2: quota normal totalmente paga ─────────────────────────
function cenarioQuotaTotalmentePaga() {
  const e = construirExtrato({
    entradas: [quota(6, 2026, 61.22), pagamento('2026-06-30', 61.22, 'PAG-1')],
  });
  assert.strictEqual(e.linhas.length, 2, 'débito + crédito');
  assert.strictEqual(e.saldoC, 0, 'saldo 0,00 €');
}

// ── Cenário 3: quota parcialmente paga ──────────────────────────────
function cenarioQuotaParcial() {
  const e = construirExtrato({
    entradas: [quota(6, 2026, 61.22), pagamento('2026-06-30', 30, 'PAG-1')],
  });
  assert.strictEqual(e.linhas.length, 2, 'débito + pagamento parcial');
  assert.strictEqual(e.saldoC, cents(31.22), 'saldo reflete só o remanescente (31,22 €)');
  const saldoFinal = e.linhas[e.linhas.length - 1].saldoC;
  assert.strictEqual(saldoFinal, cents(31.22), 'saldo acumulado linha a linha');
}

// ── Cenário 4: várias quotas + vários pagamentos ────────────────────
function cenarioMultiplasQuotasPagamentos() {
  const e = construirExtrato({
    entradas: [
      quota(1, 2026, 61.22, '2026-01-15'),
      quota(2, 2026, 61.22, '2026-02-15'),
      quota(3, 2026, 61.22, '2026-03-15'),
      pagamento('2026-01-25', 61.22, 'PAG-1'),
      pagamento('2026-02-28', 50, 'PAG-2'),
    ],
  });
  const esperado = cents(61.22) * 3 - cents(61.22) - cents(50);
  assert.strictEqual(e.saldoC, esperado, 'saldo = 3 quotas − 2 pagamentos');
  assert.strictEqual(e.linhas.length, 5, '3 débitos + 2 créditos');
}

// ── Cenário 5: quota extraordinária sem pagamento ───────────────────
function cenarioExtraSemPagamento() {
  const e = construirExtrato({ entradas: [parcela('Obras no telhado', 1, 217.68)] });
  assert.strictEqual(e.saldoC, cents(217.68), 'dívida da parcela extra');
}

// ── Cenário 6: quota extraordinária paga ────────────────────────────
function cenarioExtraPaga() {
  const e = construirExtrato({
    entradas: [parcela('Obras no telhado', 1, 217.68, '2026-10-10'), pagamento('2026-10-20', 217.68, 'PAG-9')],
  });
  assert.strictEqual(e.saldoC, 0, 'parcela paga → saldo 0');
}

// ── Cenário 7: pagamento COMBINADO = UMA única linha de crédito ─────
function cenarioPagamentoCombinado() {
  const e = construirExtrato({
    entradas: [
      quota(7, 2026, 61.22, '2026-07-15'),
      parcela('Pintura', 1, 217.68, '2026-07-20'),
      // Um único pagamento com as duas associações internas → 1 crédito só.
      pagamento('2026-07-25', 278.9, 'PAG-12'),
    ],
  });
  const creditos = e.linhas.filter((l) => l.credito > 0);
  assert.strictEqual(creditos.length, 1, 'um pagamento combinado = uma única linha de crédito');
  assert.strictEqual(creditos[0].credito, 278.9, 'crédito único com o valor total');
  assert.strictEqual(e.saldoC, 0, 'saldo 0 após pagamento combinado');
}

// ── Cenário 8: várias parcelas extraordinárias ──────────────────────
function cenarioVariasParcelas() {
  const e = construirExtrato({
    entradas: [
      parcela('Obras no telhado', 1, 217.68, '2026-10-10'),
      parcela('Obras no telhado', 2, 217.68, '2026-11-10'),
      parcela('Obras no telhado', 3, 217.68, '2026-12-10'),
    ],
  });
  const debitos = e.linhas.filter((l) => l.tipo === 'parcela');
  assert.strictEqual(debitos.length, 3, 'cada parcela é identificada individualmente');
  assert.strictEqual(e.saldoC, cents(217.68) * 3, 'saldo soma as três parcelas');
}

// ── Cenário 9: pagamento superior à obrigação (comportamento atual) ─
function cenarioExcedente() {
  // O CondoFy mantém o excedente IMPLÍCITO ("por aplicar (crédito)"): o
  // pagamento entra pelo valor total e o saldo fica negativo (crédito favor).
  const e = construirExtrato({
    entradas: [quota(6, 2026, 61.22), pagamento('2026-06-30', 100, 'PAG-5')],
  });
  assert.strictEqual(e.saldoC, cents(61.22 - 100), 'saldo negativo = crédito a favor');
  assert.ok(e.saldoC < 0, 'saldo < 0 sem entidade de crédito (limitação documentada)');
}

// ── Cenário 10: saldo final consistente (nunca inventado) ───────────
function cenarioConsistencia() {
  const entradas = [
    quota(1, 2025, 50, '2025-01-15'),
    quota(2, 2026, 61.22, '2026-02-15'),
    parcela('Obras', 1, 217.68, '2026-03-10'),
    pagamento('2025-02-10', 50, 'PAG-1'),
    pagamento('2026-04-01', 100, 'PAG-2'),
  ];
  const e = construirExtrato({ transitado: 25.5, entradas });
  const esperado = cents(25.5) + cents(50) + cents(61.22) + cents(217.68) - cents(50) - cents(100);
  assert.strictEqual(e.saldoC, esperado, 'saldo = transitado + débitos − créditos');
  assert.strictEqual(e.linhas[e.linhas.length - 1].saldoC, e.saldoC, 'última linha fecha o saldo');
  const primeira = e.linhas[0];
  assert.strictEqual(primeira.tipo, 'transitado', 'transitado abre o extrato');
}

// ── Cenário 11: recibos nunca contam como pagamentos ────────────────
function cenarioRecibosNaoContam() {
  // O motor só recebe entradas reais (quotas/parcelas/pagamentos); recibos
  // não são aceites como crédito (não existe tipo 'recibo' com valor).
  const creditos = (l) => l.filter((x) => x.credito > 0);
  const e = construirExtrato({
    entradas: [
      quota(6, 2026, 61.22),
      pagamento('2026-06-30', 61.22, 'PAG-1'),
      // Linha "recibo" sem valor → nunca gera crédito nem movimento.
      { tipo: 'recibo', dataISO: '2026-06-30', rotulo: 'Recibo RCP-2026-0001', detalhe: '', debito: 0, credito: 0 },
    ],
  });
  assert.strictEqual(creditos(e.linhas).length, 1, 'só o pagamento real conta');
  assert.strictEqual(e.saldoC, 0, 'recibo não altera o saldo');
}

// ── Cenário 12: nenhum pagamento é contado duas vezes ───────────────
function cenarioNenhumaDuplicacao() {
  const e = construirExtrato({
    entradas: [
      quota(7, 2026, 61.22),
      parcela('Pintura', 1, 217.68),
      pagamento('2026-07-25', 278.9, 'PAG-12'),
    ],
  });
  const totalCredC = e.linhas.reduce((s, l) => s + cents(l.credito), 0);
  assert.strictEqual(totalCredC, cents(278.9), 'crédito total = 1 × valor do pagamento');
}

// ── Filtro por ano (abertura do extrato) ────────────────────────────
function cenarioFiltroAno() {
  const e = construirExtrato({
    transitado: 100,
    entradas: [
      quota(11, 2025, 50, '2025-11-15'),
      quota(2, 2026, 61.22, '2026-02-15'),
      pagamento('2026-03-01', 61.22, 'PAG-1'),
    ],
  });
  const f2026 = filtrarExtratoPorAno(e, 2026);
  assert.strictEqual(f2026.saldoInicialC, cents(150), 'saldo inicial 2026 = transitado + quota 2025');
  assert.ok(f2026.linhas[0].sintetico, 'primeira linha sintética "Saldo inicial"');
  assert.strictEqual(f2026.linhas.length, 3, 'saldo inicial + movimentos de 2026');
  const fTodos = filtrarExtratoPorAno(e, null);
  assert.strictEqual(fTodos.linhas.length, e.linhas.length, 'sem ano → extrato completo');
}

// ── Cenário 13 + isolamento: invariantes das consultas (A/B) ────────
function cenarioIsolamento() {
  // As consultas do helper restringem SEMPRE ao condomínio ativo; a fração é
  // validada com fracao.condominio_id (nunca se confia no id do browser).
  assert.ok(helperCC.includes('condominio_id: condominioId'), 'helper filtra por condomínio ativo');
  assert.ok(helperCC.includes('estado: \'processada\''), 'extras só imputadas (processadas) entram');
  assert.ok(helperCC.includes('estado: \'confirmado\''), 'pagamentos só confirmados');
  assert.ok(helperCC.includes('condominio_id: condominioId, estado: \'confirmado\''), 'pagamentos isolados por condomínio');
  assert.ok(helperCC.includes('Fracao.findOne'), 'valida a fração na BD');

  assert.ok(rotaQuotas.includes("'/quotas/conta-corrente'"), 'rota da Conta-corrente existe');
  assert.ok(rotaQuotas.includes('Fração não encontrada neste condomínio.'), 'guarda IDOR na rota');
  assert.ok(rotaQuotas.includes('fracoes.some((f) => Number(f.id) === Number(fracaoId))'), 'fração pertence ao condomínio ativo');
  assert.ok(rotaQuotas.includes('contaCorrente.contaCorrenteFracao({ condominioId: cid, fracaoId })'), 'detalhe usa condominioId + fracaoId');
  assert.ok(!rotaQuotas.includes("estado: 'anulado'"), 'rota não usa estados inventados');

  // Vista: secções pedidas e sem ações de escrita nesta fase.
  assert.ok(vistaCC.includes('Frações'), 'coluna de frações');
  assert.ok(vistaCC.includes('Extrato de conta corrente'), 'bloco extrato');
  assert.ok(vistaCC.includes('Quotas Extra em dívida'), 'métrica extras em dívida');
  assert.ok(vistaCC.includes('Total pago'), 'métrica total pago');
  assert.ok(vistaCC.includes('name="ano"'), 'seletor de ano do extrato');
  assert.ok(!vistaCC.includes('Adicionar custo'), 'sem ação "Adicionar custo" nesta fase');
  assert.ok(!vistaCC.includes('Adicionar crédito'), 'sem ação "Adicionar crédito" nesta fase');
  assert.ok(!vistaCC.includes('Plano de pagamento'), 'sem planos de pagamento nesta fase');

  // Ordem visual dos separadores: Conta-corrente | Quotas | Quotas Extra |
  // Pagamentos | Recibos (o tab ativo continua por página, sem URL novo).
  const anchors = [
    'href="/admin/quotas/conta-corrente"',
    'href="/admin/quotas"',
    'href="/admin/quotas-extra"',
    'href="/admin/quotas/comprovativos"',
    'href="/admin/quotas/recibos"',
  ];
  const pos = anchors.map((a) => tabs.indexOf(a));
  assert.ok(pos.every((x) => x !== -1), 'links dos separadores presentes no partial');
  for (let i = 1; i < pos.length; i++) {
    assert.ok(pos[i - 1] < pos[i], `separador ${i} na ordem pretendida`);
  }
}

// Estrutura vertical: [TABS] → [TÍTULO] → [DESCRIÇÃO] → [CONTEÚDO].
// Os separadores aparecem SEMPRE antes do título em todas as páginas do módulo.
function testarEstruturaVertical() {
  const paginas = {
    'Conta-corrente': vistaCC,
    Quotas: vistaMapa,
    Recibos: vistaRecibos,
    Pagamentos: vistaPagamentos,
    'Quotas Extra': vistaExtraListar,
  };
  Object.entries(paginas).forEach(([nome, conteudo]) => {
    const iTabs = conteudo.indexOf('_quotas-tabs');
    const iH1 = conteudo.indexOf('<h1>');
    assert.ok(iTabs !== -1, `${nome}: separadores presentes`);
    assert.ok(iH1 !== -1, `${nome}: título presente`);
    assert.ok(iTabs < iH1, `${nome}: separadores ficam no topo, antes do título`);
  });
}

cenarioQuotaSemPagamento();
cenarioQuotaTotalmentePaga();
cenarioQuotaParcial();
cenarioMultiplasQuotasPagamentos();
cenarioExtraSemPagamento();
cenarioExtraPaga();
cenarioPagamentoCombinado();
cenarioVariasParcelas();
cenarioExcedente();
cenarioConsistencia();
cenarioRecibosNaoContam();
cenarioNenhumaDuplicacao();
cenarioFiltroAno();
cenarioIsolamento();
testarEstruturaVertical();
console.log('✓ Testes da Conta-corrente passaram (sem base de dados).');
