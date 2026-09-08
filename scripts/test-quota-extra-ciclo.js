// Testes das regras do ciclo de vida das Quotas Extra — sem base de dados.
// Cobre estados, aprovação/processamento, elegibilidade de aviso/pagamento,
// não-duplicação (cobrada) e invariantes de isolamento das rotas.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const models = require('../models');
const x = require('../helpers/extra-quota-estado');

const rotaExtra = fs.readFileSync(path.join(__dirname, '..', 'routes', 'extra-quotas.js'), 'utf8');
const rotaFinanceiro = fs.readFileSync(path.join(__dirname, '..', 'routes', 'financeiro.js'), 'utf8');
const rotaCondomino = fs.readFileSync(path.join(__dirname, '..', 'routes', 'condomino.js'), 'utf8');
const helperPagamentos = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'pagamentos.js'), 'utf8');
const helperRecibos = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'recibos.js'), 'utf8');
const pagamentosHelper = require('../helpers/pagamentos');
const recibosHelper = require('../helpers/recibos');

// ── 1. Modelo ───────────────────────────────────────────────────────
function testarModelo() {
  const estados = models.ExtraQuota.rawAttributes.estado;
  assert.deepStrictEqual([...estados.values], ['pendente', 'aprovada', 'processada', 'anulada'], 'estados da quota extra');
  const parcela = models.ExtraQuotaParcela.rawAttributes.estado;
  assert.ok(parcela.values.includes('cobrada'), 'parcela tem estado cobrada');
  assert.ok(models.PagamentoExtraParcela, 'modelo PagamentoExtraParcela existe');
  assert.ok(models.ReciboExtraParcela, 'modelo ReciboExtraParcela existe');
  for (const campo of ['aprovado_por', 'aprovado_em', 'processado_por', 'processado_em']) {
    assert.ok(models.ExtraQuota.rawAttributes[campo], `extra_quotas.${campo}`);
  }
}

// ── 2. Regras de estado ─────────────────────────────────────────────
function testarEstados() {
  assert.strictEqual(x.podeEditar('pendente'), true, 'pendente pode ser editada');
  assert.strictEqual(x.podeEditar('aprovada'), false, 'aprovada não edita');
  assert.strictEqual(x.podeAprovar('pendente'), true, 'pendente pode aprovar');
  assert.strictEqual(x.podeAprovar('aprovada'), false, 'aprovada não aprova de novo');
  assert.strictEqual(x.podeProcessar('aprovada'), true, 'aprovada pode processar');
  assert.strictEqual(x.podeProcessar('pendente'), false, 'pendente não processa');
  assert.strictEqual(x.podeProcessar('processada'), false, 'processada não processa de novo');
  assert.strictEqual(x.podeAnular('pendente'), true, 'pendente pode anular');
  assert.strictEqual(x.podeAnular('aprovada'), true, 'aprovada pode anular');
  assert.strictEqual(x.podeAnular('processada'), true, 'processada pode anular');
  assert.strictEqual(x.podeAnular('anulada'), false, 'anulada não anula de novo');
}

// ── 3. Elegibilidade pagamento / aviso ──────────────────────────────
function testarElegibilidade() {
  // Pagamento exige quota extra processada + parcela pendente/cobrada.
  assert.strictEqual(x.parcelaCobraPorPagamento({ estadoExtra: 'processada', estadoParcela: 'pendente' }), true);
  assert.strictEqual(x.parcelaCobraPorPagamento({ estadoExtra: 'processada', estadoParcela: 'cobrada' }), true);
  assert.strictEqual(x.parcelaCobraPorPagamento({ estadoExtra: 'aprovada', estadoParcela: 'pendente' }), false, 'aprovada não paga');
  assert.strictEqual(x.parcelaCobraPorPagamento({ estadoExtra: 'pendente', estadoParcela: 'pendente' }), false, 'pendente de aprovação não cobra');
  assert.strictEqual(x.parcelaCobraPorPagamento({ estadoExtra: 'processada', estadoParcela: 'paga' }), false, 'paga não cobra');
  assert.strictEqual(x.parcelaCobraPorPagamento({ estadoExtra: 'processada', estadoParcela: 'anulada' }), false, 'anulada não cobra');

  // Aviso: processada + parcela pendente + vencimento no mês do aviso.
  const base = { estadoExtra: 'processada', estadoParcela: 'pendente', vencimento: '2026-07-10', anoAviso: 2026, mesAviso: 7 };
  assert.strictEqual(x.parcelaElegivelParaAviso(base), true, 'parcela do mês elegível');
  assert.strictEqual(
    x.parcelaElegivelParaAviso({ ...base, estadoExtra: 'aprovada' }),
    false,
    'extra apenas aprovada não entra no aviso'
  );
  assert.strictEqual(
    x.parcelaElegivelParaAviso({ ...base, estadoExtra: 'pendente' }),
    false,
    'extra pendente de aprovação nunca aparece'
  );
  assert.strictEqual(x.parcelaElegivelParaAviso({ ...base, estadoParcela: 'paga' }), false, 'paga nunca reaparece');
  assert.strictEqual(x.parcelaElegivelParaAviso({ ...base, estadoParcela: 'cobrada' }), false, 'já cobrada não reaparece');
  assert.strictEqual(x.parcelaElegivelParaAviso({ ...base, estadoParcela: 'anulada' }), false, 'anulada não aparece');
  assert.strictEqual(x.parcelaElegivelParaAviso({ ...base, mesAviso: 8 }), false, 'vencimento noutro mês não aparece');
  assert.strictEqual(x.vencimentoNoMes('2026-07-10', 2026, 7), true, 'vencimento no mês');
  assert.strictEqual(x.vencimentoNoMes('2026-08-01', 2026, 7), false, 'vencimento futuro fora do mês');
}

// ── 4. Invariantes das rotas (isolamento + fluxo) ───────────────────
function testarRotas() {
  // Guardas de estado no backend (nunca só UI).
  for (const guarda of ['podeAprovar', 'podeProcessar', 'podeEditar', 'podeAnular']) {
    assert.ok(rotaExtra.includes(`extraEstado.${guarda}(`), `extra-quotas usa ${guarda}`);
  }
  assert.ok(rotaExtra.includes("'/quotas-extra/:id/aprovar'"), 'rota aprovar');
  assert.ok(rotaExtra.includes("'/quotas-extra/:id/processar'"), 'rota processar');
  assert.ok(rotaExtra.includes("'/quotas-extra/:id/editar'"), 'rota editar');
  assert.ok(rotaExtra.includes('condominio_id: req.condominioId'), 'rotas isoladas por condomínio');
  assert.ok(rotaExtra.includes('pagamentosHelper.registarPagamentoExtraParcela'), 'pagamento real por parcela');
  assert.ok(rotaExtra.includes("estado: 'processada'"), 'só processada pode ser paga/incluída');
  assert.ok(!rotaExtra.includes("'/quotas-extra/parcelas/:id/recibo'"), 'sem emissão individual de recibo na área de Quotas Extra (emissão via Pagamento)');
  assert.ok(!rotaExtra.includes("estado: 'ativa'"), 'sem estado legado ativa na criação');
  assert.ok(rotaFinanceiro.includes("'/quotas/:id/aviso/extras'"), 'seleção de extras no aviso existe');
  assert.ok(rotaFinanceiro.includes("estado: 'pendente'"), 'aviso só lista parcelas ainda não cobradas');
}

// ── 5. Fase C: pagamento/recibo combinado + área do condómino ───────
function testarFaseC() {
  assert.strictEqual(typeof pagamentosHelper.registarPagamentoComItens, 'function', 'helper de pagamento combinado exportado');
  assert.strictEqual(typeof recibosHelper.emitirReciboDePagamento, 'function', 'helper de recibo por pagamento exportado');
  assert.strictEqual(typeof recibosHelper.emitirReciboParcela, 'function', 'recibo por parcela mantém-se');

  // Pagamento combinado: um único Pagamento com quotas + parcelas.
  assert.ok(helperPagamentos.includes('registarPagamentoComItens'), 'helper tem registarPagamentoComItens');
  assert.ok(helperPagamentos.includes('PagamentoExtraParcela.create'), 'pagamento combinado cria ligações extra');
  assert.ok(helperPagamentos.includes("estado: { [Op.in]: ['pendente', 'cobrada'] }"), 'parcelas pagas/anuladas excluídas');
  assert.ok(helperPagamentos.includes("estado: 'processada'"), 'extra não processada não é paga');

  // Recibo combinado: linhas ReciboQuota + ReciboExtraParcela no mesmo RCP.
  assert.ok(helperRecibos.includes('emitirReciboDePagamento'), 'helper tem emitirReciboDePagamento');
  assert.ok(helperRecibos.includes('ReciboExtraParcela.create'), 'recibo combinado cria linhas extra');

  // Rota do pagamento combinado (formulário com quotas + extras elegíveis).
  assert.ok(rotaFinanceiro.includes('registarPagamentoComItens'), 'rota usa pagamento combinado');
  assert.ok(rotaFinanceiro.includes('quota_ids') && rotaFinanceiro.includes('parcela_ids'), 'formulário aceita quotas e parcelas');
  assert.ok(rotaFinanceiro.includes("'/pagamentos/:id/recibo/emitir'"), 'rota de recibo por pagamento existe');
  assert.ok(rotaFinanceiro.includes('garantirDocumentoRecibo'), 'recibo do pagamento regista Documento na biblioteca');
  assert.ok(rotaFinanceiro.includes("estado: { [Op.in]: ['pendente', 'cobrada'] }"), 'aviso/pagamento só listam parcelas elegíveis');

  // Área do condómino: parcelas extra e recibos com extras discriminadas.
  assert.ok(rotaCondomino.includes("estado: { [Op.in]: ['pendente', 'cobrada'] }"), 'condómino vê parcelas por cobrar');
  assert.ok(rotaCondomino.includes("as: 'parcelasExtra'"), 'condómino inclui parcelas extra nos recibos');
  assert.ok(rotaCondomino.includes("condominio_id: req.condominioId"), 'área do condómino isolada por condomínio');
}

testarModelo();
testarEstados();
testarElegibilidade();
testarRotas();
testarFaseC();
console.log('✓ Testes do ciclo de vida das Quotas Extra passaram (sem base de dados).');
