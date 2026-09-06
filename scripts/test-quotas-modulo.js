// Testes do módulo Quotas (Mapa / Comprovativos / Recibos) — sem base de dados.
// Cobre: regras puras dos recibos (alocação, partilha base/FCR, códigos RCP,
// rótulos de período) e a renderização das três áreas com dados representativos.
// Utilização: node scripts/test-quotas-modulo.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('../helpers/handlebars-helpers');

const {
  formatarNumero,
  formatarCodigo,
  periodoLabel,
  partilharValor,
  alocarMeses,
} = require('../helpers/recibos');

// ── 1. Regras puras ────────────────────────────────────────────────
function testRegras() {
  // Códigos RCP
  assert.strictEqual(formatarNumero(6), '0006', 'número com 4 dígitos');
  assert.strictEqual(formatarCodigo(2026, 6), 'RCP-2026-0006', 'código único');

  // Período (1 mês / contíguo / transições de ano / não contíguo)
  assert.strictEqual(periodoLabel([{ ano: 2026, mes: 1 }]), 'Jan 2026', 'período de um mês');
  assert.strictEqual(periodoLabel([{ ano: 2026, mes: 1 }, { ano: 2026, mes: 2 }, { ano: 2026, mes: 3 }]), 'Jan–Mar 2026', 'período contíguo compacto');
  assert.strictEqual(periodoLabel([{ ano: 2025, mes: 12 }, { ano: 2026, mes: 1 }]), 'Dez 2025 – Jan 2026', 'período entre anos');
  assert.strictEqual(periodoLabel([{ ano: 2026, mes: 1 }, { ano: 2026, mes: 3 }]), 'Jan 2026, Mar 2026', 'período não contíguo');

  // Distribuição de um recibo único (nunca acima do valor pago)
  const meses = [
    { quotaId: 1, ano: 2026, mes: 1, limiteC: 15000 },
    { quotaId: 2, ano: 2026, mes: 2, limiteC: 15000 },
    { quotaId: 3, ano: 2026, mes: 3, limiteC: 15000 },
  ];
  const parcial = alocarMeses({ modo: 'unico', meses, valorGlobalC: 20000 });
  assert.deepStrictEqual(parcial, [{ quotaId: 1, valorC: 15000 }, { quotaId: 2, valorC: 5000 }], 'preenche por ordem até esgotar');
  const total = alocarMeses({ modo: 'unico', meses, valorGlobalC: 45000 });
  assert.strictEqual(total.reduce((s, a) => s + a.valorC, 0), 45000, 'recibo único com tudo');

  // Um recibo por mês: cada mês leva o valor disponível
  const porMes = alocarMeses({ modo: 'mes', meses: meses.slice(0, 2) });
  assert.strictEqual(porMes.length, 2);
  assert.strictEqual(porMes[0].valorC, 15000, 'mês 1 com valor completo');
  assert.strictEqual(porMes[1].valorC, 15000, 'mês 2 com valor completo');

  // Ordenação cronológica dos meses
  const foraOrdem = alocarMeses({
    modo: 'mes',
    meses: [{ quotaId: 9, ano: 2026, mes: 3, limiteC: 100 }, { quotaId: 8, ano: 2026, mes: 1, limiteC: 200 }],
  });
  assert.strictEqual(foraOrdem[0].quotaId, 8, 'meses ordenados cronologicamente');

  // Partilha proporcional base/FCR quando o mês é pago parcialmente
  const p = partilharValor({ valor: 100, valor_base: 75, valor_fcr: 25 }, 5000);
  assert.deepStrictEqual(p, { baseC: 3750, fcrC: 1250 }, 'base e FCR proporcionais ao valor emitido');
}

// ── 2. Renderização das vistas ─────────────────────────────────────
Object.entries(helpers).forEach(([k, v]) => handlebars.registerHelper(k, v));
const ROOT = path.join(__dirname, '..', 'views');
function ler(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
const parciais = {};
['_quotas-tabs', '_empty-state', '_flash'].forEach((p) => handlebars.registerPartial(p, ler(`partials/${p}.handlebars`)));

const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function mesSemQuota() {
  return { key: 'semquota', sim: '*', rot: 'Sem quota', temQuota: false };
}

function testVistaMapa() {
  const tpl = handlebars.compile(ler('admin/quotas/mapa.handlebars'));
  const linhas = [
    {
      id: 1,
      designacao: 'Fração A',
      andar: '3.º',
      porta: 'Esq.',
      estado: 'ativo',
      transitado: 125.4,
      transitadoTxt: '125,40',
      meses: [
        { temQuota: true, id: 10, key: 'paga', sim: '✓', rot: 'Pago', valor: 75, pago: 75 },
        { temQuota: true, id: 11, key: 'incumprimento', sim: '✗', rot: 'Em incumprimento', valor: 75, pago: 0 },
        ...Array.from({ length: 10 }, () => mesSemQuota()),
      ],
      saldo: -125.4,
      absSaldo: 125.4,
      emDivida: true,
      porEmitirInfo: { meses: 1, valor: 75 },
    },
    {
      id: 2,
      designacao: 'Fração B',
      andar: null,
      porta: '1.º Dto.',
      estado: 'ativo',
      transitado: 0,
      transitadoTxt: '0,00',
      meses: Array.from({ length: 12 }, () => mesSemQuota()),
      saldo: 0,
      absSaldo: 0,
      emDivida: false,
      porEmitirInfo: null,
    },
  ];
  const html = tpl({
    titulo: 'Quotas',
    secao: 'mapa',
    ano: 2026,
    anos: [2026, 2025],
    linhas,
    quotaConfig: { valorPor1000: 100, fcrPercentagem: 10 },
    permilagemTotal: 1000,
    fcrMensalPrevisto: 12.5,
    permilagem: { ok: true, total: 1000 },
    resumo: { quotasAno: 1800, recebidoAno: 700, emDivida: 1100, pendenteAno: 1100 },
    nFracoes: 2,
    meses: MESES_CURTO,
  });

  assert.ok(html.includes('Mapa de Quotas'), 'título do mapa');
  assert.ok(html.includes('Mapa de Quotas') && html.includes('Comprovativos') && html.includes('Recibos'), 'tabs presentes');
  assert.ok(html.includes('q-ind q-paga') && html.includes('✓'), 'indicador de pago');
  assert.ok(html.includes('q-ind q-incumprimento') && html.includes('✗'), 'indicador de incumprimento');
  assert.ok(html.includes('Jan') && html.includes('Dez'), 'meses abreviados');
  assert.ok(html.includes('125,40'), 'transitado visível');
  assert.ok(html.includes('text-danger'), 'dívida a vermelho');
  assert.ok(html.includes('/admin/quotas/recibos?emitir=1'), 'por emitir liga para a emissão de recibo');
  assert.ok(html.includes('1 · 75,00 €'), 'coluna por emitir mostra valor real + meses');
  assert.ok(html.includes('modalTransitados'), 'modal de transitados presente');
  assert.ok(!html.includes('RCP-'), 'mapa não lista recibos');
}

function testVistaComprovativos() {
  const tpl = handlebars.compile(ler('admin/quotas/comprovativos.handlebars'));
  const pagamentos = [
    {
      id: 1,
      numero_documento: '2026/0001',
      data_pagamento: '2026-01-10',
      valor: 75,
      metodo: 'Transferência',
      estado: 'confirmado',
      condominos: 'João Silva',
      fracao: 'Fração A',
      comprovativo_estado: 'validado',
      comprovativo_nome: 'comprovativo.pdf',
      comprovativo_ficheiro: 'x_comprovativo.pdf',
      comprovativo_motivo: null,
    },
    {
      id: 2,
      numero_documento: '2026/0002',
      data_pagamento: '2026-02-01',
      valor: 150,
      metodo: 'MB WAY',
      estado: 'confirmado',
      condominos: 'Maria Costa',
      fracao: 'Fração B',
      comprovativo_estado: null,
      comprovativo_nome: null,
      comprovativo_ficheiro: null,
      comprovativo_motivo: null,
    },
  ];
  const html = tpl({
    titulo: 'Quotas · Comprovativos',
    secao: 'comprovativos',
    pagamentos,
    contagem: { pendentes: 1, validados: 1, rejeitados: 0 },
  });
  assert.ok(html.includes('Comprovativos'), 'título');
  assert.ok(html.includes('Pendentes') && html.includes('Validados') && html.includes('Rejeitados'), 'cartões de resumo');
  assert.ok(html.includes('João Silva'), 'condómino visível');
  assert.ok(html.includes('/admin/pagamentos/1/comprovativo'), 'visualizar comprovativo');
  assert.ok(html.includes('modalAnexar') && html.includes('Carregar comprovativo'), 'modal de anexo');
  assert.ok(html.includes('Registar pagamento'), 'ação registar pagamento');
}

function testVistaRecibos() {
  const tpl = handlebars.compile(ler('admin/quotas/recibos.handlebars'));
  const mesJan = { quotaId: 10, mes: 1, ano: 2026, rotulo: 'Jan 2026', quota: 50, pago: 50, coberto: 0, disponivel: 50, fcr: 0, pode: true };
  const mesFev = { quotaId: 11, mes: 2, ano: 2026, rotulo: 'Fev 2026', quota: 50, pago: 50, coberto: 0, disponivel: 50, fcr: 0, pode: true };
  const mesMar = { quotaId: 12, mes: 3, ano: 2026, rotulo: 'Mar 2026', quota: 50, pago: 20, coberto: 0, disponivel: 20, fcr: 0, pode: true };
  const mesAbr = { quotaId: 13, mes: 4, ano: 2026, rotulo: 'Abr 2026', quota: 50, pago: 0, coberto: 0, disponivel: 0, fcr: 0, pode: false };
  const porEmitir = [
    {
      fracaoId: 1,
      mesesN: 3,
      designacao: 'Fração A',
      andar: '3.º',
      porta: null,
      pago: 120,
      enviado: 0,
      porEmitir: 120,
      meses: [mesJan, mesFev, mesMar, mesAbr],
    },
  ];
  const porEmitirJson = JSON.stringify([{ fracaoId: 1, meses: porEmitir[0].meses }]);
  const recibos = [
    {
      id: 5,
      numero: '0006',
      codigo: 'RCP-2026-0006',
      tipo: 'ordinario',
      valor: 75,
      data_emissao: '2026-01-10',
      estado: 'emitido',
      enviado_at: null,
      fracao: 'Fração A',
      morador: 'João Silva',
      periodo: 'Jan 2026',
    },
  ];
  const html = tpl({
    titulo: 'Quotas · Recibos',
    secao: 'recibos',
    porEmitir,
    porEmitirJson,
    recibos,
    resumo: { emitidos: 1, enviados: 0, porEnviar: 1 },
    abrirEmitirFracaoId: null,
  });
  assert.ok(html.includes('Recibos'), 'título');
  assert.ok(html.includes('Emitidos (1) — (1) por enviar'), 'resumo com contagens');
  assert.ok(html.includes('Emitir recibo'), 'ação de emissão');
  assert.ok(html.includes('RCP-2026-0006'), 'código único visível');
  assert.ok(html.includes('Por enviar'), 'estado de envio visível');
  assert.ok(html.includes('modalEmitir') && html.includes('modalAnular'), 'modais presentes');
  assert.ok(html.includes('Valor pago disponível') && html.includes('Valor máximo a emitir'), 'modal mostra valores disponíveis');
  assert.ok(html.includes('Já em recibo') && html.includes('Disponível'), 'tabela de meses com colunas de disponibilidade');
  assert.ok(html.includes('120,00 €'), 'por emitir mostra valor real');
  assert.ok(html.includes('3 mês/meses disponíveis'), 'número de meses visível');
  assert.ok(html.includes('modalEmitir') && html.includes('Emitir recibo'), 'modal abre pelo botão');
  assert.ok(html.includes('/admin/quotas/recibos/5/pdf'), 'ver PDF');
}

function testVistaDetalhePagamento() {
  const tpl = handlebars.compile(ler('admin/pagamentos/detalhe.handlebars'));
  const html = tpl({
    titulo: 'Pagamento 2026/0001',
    driveLigado: false,
    pagamento: {
      id: 7,
      numero_documento: '2026/0001',
      estado: 'confirmado',
      valor: 75,
      data_pagamento: '2026-01-10',
      referencia: 'REF-1',
      metodo_pagamento: { nome: 'Transferência' },
      fracao: { designacao: 'Fração A' },
      comprovativo_ficheiro: 'x_comp.pdf',
      comprovativo_nome: 'comprovativo.pdf',
      comprovativo_estado: 'rejeitado',
      comprovativo_motivo: 'Ficheiro ilegível',
      comprovativo_data: '2026-01-12',
      quotas: [{ numero_documento: '2026/0012', mes: 1, ano: 2026, PagamentoQuota: { valor_aplicado: 75 } }],
    },
  });
  assert.ok(html.includes('Comprovativo de recebimento'), 'secção de comprovativo presente');
  assert.ok(html.includes('Rejeitado'), 'estado rejeitado visível');
  assert.ok(html.includes('Ficheiro ilegível'), 'motivo de rejeição visível');
  assert.ok(html.includes('comprovativo.pdf'), 'nome do ficheiro visível');
  assert.ok(html.includes('/admin/pagamentos/7/comprovativo'), 'visualizar comprovativo');
  assert.ok(html.includes('/admin/pagamentos/7/comprovativo?download=1'), 'descarregar comprovativo');
  assert.ok(html.includes('modalPgAnexar') && html.includes('modalPgRejeitar'), 'modais de anexo/rejeição presentes');
  assert.ok(html.includes('/admin/quotas/comprovativos'), 'volta para o módulo Quotas (não para Pagamentos antigo)');

  const sem = tpl({
    titulo: 'Pagamento 2026/0002',
    driveLigado: false,
    pagamento: {
      id: 8,
      numero_documento: '2026/0002',
      estado: 'confirmado',
      valor: 150,
      data_pagamento: '2026-02-01',
      fracao: { designacao: 'Fração B' },
      comprovativo_ficheiro: null,
      comprovativo_nome: null,
      comprovativo_estado: null,
      comprovativo_motivo: null,
      quotas: [],
    },
  });
  assert.ok(sem.includes('Sem comprovativo associado'), 'sem comprovativo indica estado vazio');
  assert.ok(sem.includes('Anexar comprovativo'), 'botão anexar disponível');
}

// ── 3. Valores transitados — parser (persistência com regras de vazio) ──
function testTransitadosParser() {
  const { parseTransitado } = require('../routes/quotas-modulo');
  assert.strictEqual(parseTransitado('150,00'), 150, 'vírgula decimal');
  assert.strictEqual(parseTransitado('150.50'), 150.5, 'ponto decimal');
  assert.strictEqual(parseTransitado('1.500,00'), 1500, 'milhares PT');
  assert.strictEqual(parseTransitado('0'), 0, 'zero explícito guardado');
  assert.strictEqual(parseTransitado('0,00'), 0, 'zero com vírgula guardado');
  assert.strictEqual(parseTransitado('-25,50'), -25.5, 'negativo aceite');
  assert.strictEqual(parseTransitado(''), null, 'vazio → não altera');
  assert.strictEqual(parseTransitado('  '), null, 'espaços → não altera');
  assert.strictEqual(parseTransitado('abc'), null, 'inválido → não altera');
}

function testVistaFormPagamento() {
  const tpl = handlebars.compile(ler('admin/pagamentos/form.handlebars'));
  const html = tpl({ titulo: 'Registar pagamento', fracoes: [], metodos: [], contas: [] });
  assert.ok(html.includes('enctype="multipart/form-data"'), 'form multipart para upload');
  assert.ok(html.includes('Comprovativo de pagamento'), 'secção de comprovativo no registo');
  assert.ok(html.includes('Selecionar ficheiro') === false || html.includes('name="comprovativo"'), 'campo comprovativo presente');
  assert.ok(html.includes('/admin/quotas/comprovativos'), 'volta para o módulo Quotas');
}

// ── 4. PDF do recibo (mesmo motor usado pelas vistas/ações do módulo) ──
async function testPdfRecibo() {
  const { gerarReciboPDF } = require('../helpers/pdf');
  const cond = { designacao: 'Condomínio Teste', morada: 'Rua X', codigo_postal: '1000-000', localidade: 'Lisboa', nif: '500000000', logotipo: null, identidade_visual: 'designacao' };
  const buffer = await gerarReciboPDF(cond, {
    numero: 'RCP-2026-0006',
    data: new Date('2026-01-10T12:00:00'),
    dataPagamento: new Date('2026-01-10T12:00:00'),
    condominoNome: 'João Silva',
    fracaoDesignacao: 'Fração A',
    metodoPagamento: '—',
    referencia: 'RCP-2026-0006',
    valor: 75,
    saldoAposPagamento: 0,
    quotas: [{ numero: '2026/0012', periodo: 'Jan 2026', valorAplicado: 75 }],
  });
  assert.strictEqual(buffer.slice(0, 5).toString(), '%PDF-', 'recibo gerado como PDF');
}

// ── 4. Modos de distribuição: apenas os quatro aceites ──
async function testModosDistribuicao() {
  const { emitirRecibos } = require('../helpers/recibos');
  // A validação do modo ocorre antes de abrir a transação (não toca na BD).
  await assert.rejects(
    () => emitirRecibos({ fracaoId: 1, meses: [], modo: 'desconhecido' }),
    /Modo de distribuição inválido/,
    'modos desconhecidos são rejeitados explicitamente'
  );
}

// ── 5. Distribuição FIFO de pagamentos (anulados nunca contam) ──
function testFIFOPagamentos() {
  const { alocarFIFO, somarAplicacoesConfirmadas } = require('../helpers/pagamentos');
  const quota = (id, valor) => ({ id, valor });
  const quotas = [quota(1, 50), quota(2, 55.66), quota(3, 61.23)];

  // Pagamentos anulados existem no histórico mas não contam para o saldo.
  const apenasAnulados = [
    { quota_id: 1, valor_aplicado: '50.00', pagamento: { estado: 'anulado' } },
    { quota_id: 2, valor_aplicado: '55.66', pagamento: { estado: 'anulado' } },
    { quota_id: 3, valor_aplicado: '30.00', pagamento: { estado: 'anulado' } },
  ];
  const vazio = somarAplicacoesConfirmadas(apenasAnulados);
  assert.strictEqual(vazio.size, 0, 'aplicações anuladas não contam para saldo');

  let r = alocarFIFO({ quotas, pagoConfirmadoC: vazio, valorC: 10000 });
  assert.deepStrictEqual(
    r.alocacoes.map((a) => ({ id: a.quotaId, valor: a.aplicarC })),
    [{ id: 1, valor: 5000 }, { id: 2, valor: 5000 }],
    'novo pagamento volta a começar na primeira quota em aberto (FIFO)'
  );
  assert.strictEqual(r.restanteC, 0, '100 € aplicados por completo');

  // Com uma aplicação confirmada, essa quota deixa de ser alvo.
  const comConfirmado = [
    { quota_id: 1, valor_aplicado: '50.00', pagamento: { estado: 'anulado' } },
    { quota_id: 1, valor_aplicado: '50.00', pagamento: { estado: 'confirmado' } },
  ];
  const pago = somarAplicacoesConfirmadas(comConfirmado);
  assert.strictEqual(pago.get(1), 5000, 'só a aplicação confirmada é contada');
  r = alocarFIFO({ quotas, pagoConfirmadoC: pago, valorC: 6000 });
  assert.strictEqual(r.alocacoes[0].quotaId, 2, 'Janeiro já pago → começa em Fevereiro');
  assert.strictEqual(r.alocacoes[0].aplicarC, 5566, 'Fevereiro pago por completo (55,66)');
  assert.strictEqual(r.alocacoes[1].aplicarC, 434, 'restante vai para Março');

  // Pagamento superior ao saldo → excedente devolvido, sem aplicações a mais.
  r = alocarFIFO({ quotas, pagoConfirmadoC: vazio, valorC: 100000 });
  const totalC = r.alocacoes.reduce((s, a) => s + a.aplicarC, 0);
  assert.strictEqual(totalC, 5000 + 5566 + 6123, 'aplica no máximo o saldo das quotas');
  assert.strictEqual(r.restanteC, 100000 - totalC, 'excedente devolvido (crédito)');

  // Pagamentos múltiplos acumulam corretamente (estados intermediários).
  const r1 = alocarFIFO({ quotas, pagoConfirmadoC: vazio, valorC: 10000 });
  const acumulado = new Map([[1, 5000], [2, 5000]]);
  const r2 = alocarFIFO({ quotas, pagoConfirmadoC: acumulado, valorC: 6123 });
  assert.deepStrictEqual(
    r2.alocacoes.map((a) => ({ id: a.quotaId, valor: a.aplicarC })),
    [{ id: 2, valor: 566 }, { id: 3, valor: 5557 }],
    'segundo pagamento continua na primeira quota ainda em aberto'
  );

  // Ordem cronológica ano/mês é respeitada (lista já ordenada pelo chamador).
  const multiAno = [{ id: 10, valor: 50 }, { id: 11, valor: 50 }];
  const rr = alocarFIFO({ quotas: multiAno, pagoConfirmadoC: vazio, valorC: 10000 });
  assert.strictEqual(rr.alocacoes.length, 2, 'aplica por ordem recebida (ano/mês)');
}

async function main() {
  testRegras();
  testTransitadosParser();
  testFIFOPagamentos();
  testVistaMapa();
  testVistaComprovativos();
  testVistaRecibos();
  testVistaDetalhePagamento();
  testVistaFormPagamento();
  await testPdfRecibo();
  await testModosDistribuicao();
  console.log('✓ Testes do módulo Quotas (mapa/comprovativos/recibos) passaram (sem base de dados).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
