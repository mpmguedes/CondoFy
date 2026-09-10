// Testes do módulo Quotas (Mapa / Comprovativos / Recibos) — sem base de dados.
// Cobre: regras puras dos recibos (alocação, partilha base/FCR, códigos RCP,
// rótulos de período) e a renderização das três áreas com dados representativos.
// Utilização: node scripts/test-quotas-modulo.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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
  assert.ok(html.includes('Mapa de Quotas') && html.includes('Pagamentos') && html.includes('Recibos'), 'tabs presentes');
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
    titulo: 'Quotas · Pagamentos',
    secao: 'comprovativos',
    pagamentos,
    contagem: { pendentes: 1, validados: 1, rejeitados: 0 },
  });
  assert.ok(html.includes('Pagamentos'), 'título');
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
  // Tal como a rota envia: um ARRAY de {fracaoId, meses} (o helper json é que
  // faz JSON.stringify; nunca pré-serializar aqui — senão fica duplamente codificado).
  const porEmitirJson = [{ fracaoId: 1, meses: porEmitir[0].meses }];
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

  // A fração correta segue explicitamente no formulário (name="fracao_id") e o
  // JavaScript preenche o hidden a partir do contexto aberto na modal.
  assert.ok(html.includes('name="fracao_id"') && html.includes('id="emitirFracaoId"'), 'hidden fracao_id presente no form');
  assert.ok(html.includes('campoFracaoId.value = String(fracaoId)'), 'fracaoId é escrito no hidden ao abrir');
  assert.ok(html.includes('input.name = \'meses\''), 'meses submetidos como quotaIds dinâmicos');

  // Os cartões de mês recebem os dados completos (quotaId/fracaoId/ano/mes/
  // disponivel/pode) — o nome das propriedades confirma o atributo data-* real.
  ['dataset.quotaId', 'dataset.fracaoId', 'dataset.ano', 'dataset.mes', 'dataset.disponivel', 'dataset.pode'].forEach(function (campo) {
    assert.ok(html.includes(campo), 'cartão de mês recebe ' + campo);
  });

  // O payload JSON do modal tem de chegar INESCAPED (triple-stash) e com dados:
  // era {{json ...}} → Handlebars escapava para &quot; e o JSON.parse falhava,
  // deixando a modal sem meses (valores a 0).
  assert.ok(!html.includes('&quot;quotaId&quot;'), 'JSON do modal não está escapado para entidades');
  const blocoJson = /<script type="application\/json" id="dadosPorEmitir">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(blocoJson, 'bloco JSON presente na página');
  const dados = JSON.parse(blocoJson[1]);
  assert.strictEqual(dados.length, 1, 'uma fração no payload');
  const mesesJson = dados[0].meses;
  assert.ok(mesesJson.length >= 4, 'meses chegam ao frontend (nenhum é perdido)');
  const out = mesesJson.find((m) => m.quotaId === 12);
  assert.ok(out, 'Outubro presente no payload');
  assert.strictEqual(out.disponivel, 20, 'Outubro parcial: disponível = 20 (não zero)');
  const abr = mesesJson.find((m) => m.quotaId === 13);
  assert.ok(abr && abr.pode === false, 'mês sem pagamento vem marcado como não selecionável');
  for (const m of mesesJson) {
    assert.ok(Number.isInteger(m.quotaId) && Number.isInteger(m.mes) && Number.isInteger(m.ano), 'campos de identificação presentes');
    assert.ok(Number.isFinite(m.pago) && Number.isFinite(m.disponivel) && Number.isFinite(m.quota), 'valores numéricos presentes (nunca a zero por engano de formato)');
  }
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

// ── 3b. Valores transitados — leitura dos campos por fração ──────────
// Regressão: com nomes "transitados[<id>]" o qs convertia ids contíguos
// (1,2,3…) num array 0-based e os valores ficavam desalinhados uma fração
// (o valor da 1.ª ia para a 2.ª e a última nunca era atualizada).
function testTransitadosCampos() {
  const { valoresTransitados } = require('../routes/quotas-modulo');
  const qs = require('qs');

  // Cenário exato do bug: ids contíguos 1, 2, 3.
  const corpo = qs.parse('transitado_1=10,00&transitado_2=20,00&transitado_3=30,00');
  assert.deepStrictEqual(
    valoresTransitados(corpo),
    [{ id: 1, valor: '10,00' }, { id: 2, valor: '20,00' }, { id: 3, valor: '30,00' }],
    'ids contíguos mantêm o alinhamento (1→10, 2→20, 3→30)'
  );

  // O mesmo corpo com os nomes antigos seria interpretado como array 0-based.
  const antigo = qs.parse('transitados[1]=10,00&transitados[2]=20,00&transitados[3]=30,00');
  assert.ok(Array.isArray(antigo.transitados), 'qs converte chaves contíguas num array (motivo da correção)');
  assert.deepStrictEqual(Object.entries(antigo.transitados).map(([k]) => k), ['0', '1', '2'], 'índices do array antigo ficavam 0-based');

  // Ids não contíguos e valores decimais/negativos.
  assert.deepStrictEqual(
    valoresTransitados({ transitado_11: '1.500,00', transitado_22: '-25,50' }),
    [{ id: 11, valor: '1.500,00' }, { id: 22, valor: '-25,50' }],
    'ids não contíguos com decimais PT'
  );

  // Campos inválidos são ignorados.
  assert.deepStrictEqual(valoresTransitados({ transitado_0: '1', transitado_abc: '2', outra_coisa: '3', importar: 'x' }), [], 'campos inválidos ignorados');
  assert.deepStrictEqual(valoresTransitados(null), [], 'corpo ausente não rebenta');

  // Compatibilidade: submissões antigas em objeto (ids não contíguos) continuam a funcionar.
  assert.deepStrictEqual(valoresTransitados({ transitados: { 11: '5,00' } }), [{ id: 11, valor: '5,00' }], 'formato antigo (objeto) aceite');

  // A vista usa nomes planos (imunes à conversão em array).
  const vista = ler('admin/quotas/mapa.handlebars');
  assert.ok(vista.includes('name="transitado_{{id}}"'), 'modal usa nome plano transitado_<id>');
  assert.ok(!vista.includes('name="transitados['), 'modal já não usa nomes com índice entre parênteses retos');
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
  // Multi-condomínio: emitir recibo SEM condominioId é rejeitado antes da BD
  // (evita Recibo.condominio_id null em produção).
  await assert.rejects(
    () => emitirRecibos({ fracaoId: 1, meses: [], modo: 'mes' }),
    /condominioId é obrigatório/,
    'emitir recibo exige condominioId (multi-condomínio)'
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

// ── 6. PDFs numa única página + estado anulado ─────────────────────
function paginasPdf(buffer) {
  const s = buffer.toString('latin1');
  return (s.match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

// Extrai o texto dos streams (os caracteres vêm como hex no content stream).
function textosPdf(buffer) {
  const s = buffer.toString('latin1');
  let texto = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s))) {
    let txt = '';
    try {
      txt = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch (e) {
      continue;
    }
    const hexes = txt.match(/<([0-9A-Fa-f]+)>/g) || [];
    for (const h of hexes) {
      try {
        texto += Buffer.from(h.slice(1, -1), 'hex').toString('latin1');
      } catch (e) {
        // ignora fragmentos não decodificáveis
      }
    }
  }
  return texto;
}

async function testPdfUmaPagina() {
  const { gerarReciboPDF, gerarAvisoQuotaPDF } = require('../helpers/pdf');
  const cond = { designacao: 'Condomínio Jardim das Flores', morada: 'Rua Doutor António José de Almeida, 1234', codigo_postal: '1000-000', localidade: 'Lisboa', nif: '500000000', logotipo: null, identidade_visual: 'designacao' };
  const curto = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const meses = curto.map((c, i) => ({ numero: '2026/' + String(100 + i + 1), periodo: c + ' 2026', valorAplicado: 61.23 }));
  const pagamentos = [
    { data_pagamento: '2026-09-06', metodo: 'Transferência Bancária (TB)', referencia: 'TRF123456', valor: 300 },
    { data_pagamento: '2026-09-08', metodo: 'MB WAY', referencia: 'XYZ789', valor: 434.76 },
  ];
  const base = {
    numero: 'RCP-2026-0009',
    codigoVerificacao: '2026-E8D57089',
    data: new Date('2026-09-10T00:00:00'),
    condominoNome: 'João Maria da Silva Santos',
    fracaoDesignacao: 'Fração A',
    fracaoPermilagem: '125,000 ‰',
    valor: 734.76,
    saldoAposPagamento: 0,
    quotas: meses,
    pagamentos,
  };
  const recibo = await gerarReciboPDF(cond, base);
  assert.strictEqual(recibo.slice(0, 5).toString(), '%PDF-', 'recibo normal gerado');
  assert.strictEqual(paginasPdf(recibo), 1, 'recibo normal ocupa uma única página A4');
  const texto = textosPdf(recibo);
  assert.ok(!texto.includes('ANULADO'), 'recibo normal não tem marca de anulado');
  // Conteúdo real no PDF: código, verificação, fração/permilagem e pagamentos.
  assert.ok(texto.includes('RCP-2026-0009'), 'n.º do recibo visível');
  assert.ok(texto.includes('2026-E8D57089'), 'código de verificação visível');
  assert.ok(texto.includes('Fração A'), 'fração visível');
  assert.ok(texto.includes('125'), 'permilagem visível');
  assert.ok(texto.includes('TRF123456') && texto.includes('MB WAY') && texto.includes('XYZ789'), 'métodos/referências dos pagamentos visíveis');
  // O rodapé identifica a plataforma de forma discreta (o documento é do
  // condomínio): "Documento processado através da plataforma GesCondu".
  assert.ok(texto.includes('Documento processado') && texto.includes('plataforma GesCondu'), 'rodapé identifica a plataforma GesCondu');
  assert.ok(!texto.includes('Condomínio Condomínio'), 'rodapé/cabeçalho sem duplicar a palavra Condomínio');

  // Nomes longos: colunas do cabeçalho nunca se sobrepõem e fica numa página.
  const condLongo = { ...cond, designacao: 'CONDOMÍNIO JARDINS DA SERRA E DAS OLIVEIRAS' };
  const reciboLongo = await gerarReciboPDF(condLongo, base);
  assert.strictEqual(paginasPdf(reciboLongo), 1, 'recibo com nome longo numa única página');
  assert.ok(textosPdf(reciboLongo).includes('JARDINS DA SERRA'), 'nome longo presente sem cortes');
  assert.ok(textosPdf(reciboLongo).includes('RCP-2026-0009'), 'coluna direita intacta com nome longo');

  // Nomes de referência (até ~40 caracteres e acima) — completos, sem corte.
  const nomesReferencia = [
    'Condomínio Jardim das Flores',
    'Condomínio Residencial Jardim das Flores',
    'CONDOMÍNIO JARDINS DA SERRA E DAS OLIVEIRAS DO MONTE ALTO',
  ];
  for (const nome of nomesReferencia) {
    const reciboNome = await gerarReciboPDF({ ...cond, designacao: nome }, base);
    assert.strictEqual(paginasPdf(reciboNome), 1, `recibo com "${nome}" numa única página`);
    assert.ok(textosPdf(reciboNome).includes(nome), `nome completo visível: ${nome}`);
  }

  // Valores elevados mantêm título+valor na mesma linha e a página única.
  for (const valor of [1250, 12500.5]) {
    const alto = await gerarReciboPDF(cond, { ...base, valor });
    assert.strictEqual(paginasPdf(alto), 1, `recibo de ${valor} € numa única página`);
  }

  const anulado = await gerarReciboPDF(cond, { ...base, anulado: true });
  assert.strictEqual(paginasPdf(anulado), 1, 'recibo anulado também ocupa uma única página');
  assert.ok(textosPdf(anulado).includes('ANULADO'), 'PDF do recibo anulado mostra ANULADO');

  const aviso = await gerarAvisoQuotaPDF(cond, {
    numero: '2026/0012',
    periodo: 'Janeiro 2026',
    dataEmissao: new Date('2026-01-05T00:00:00'),
    dataVencimento: new Date('2026-01-08T00:00:00'),
    valor: 61.23,
    destinatarioNome: 'João Maria da Silva Santos',
    fracaoDesignacao: 'Fração A',
    fracaoMorada: 'Rua das Flores, 1.º Esq.',
    saldoAnterior: 0,
    ultimoPagamento: true,
    ultimoPagamentoValor: 50,
    ultimoPagamentoData: new Date('2025-12-10T00:00:00'),
    emDivida: 11.23,
    totalAPagar: 61.23,
    iban: 'PT50 0002 0123 1234 5678 9015 4',
    outrosMeiosPagamento: 'MB WAY: 999 999 999 · Referência multibanco',
    referencia: 'A000000001',
    instrucoesPagamento: 'Obrigado pelo cumprimento.',
  });
  assert.strictEqual(paginasPdf(aviso), 1, 'aviso de quota ocupa uma única página A4');
}

// ── 6b. Código de verificação: único e estável ─────────────────────
function testCodigoVerificacao() {
  const { gerarCodigoVerificacao } = require('../helpers/recibos');
  const a = gerarCodigoVerificacao(2026, 'RCP-2026-0009');
  assert.ok(/^2026-[0-9A-F]{8}$/.test(a), 'formato ano-HEX8');
  assert.strictEqual(a, gerarCodigoVerificacao(2026, 'RCP-2026-0009'), 'estável ao reabrir o recibo');
  assert.notStrictEqual(a, gerarCodigoVerificacao(2026, 'RCP-2026-0010'), 'diferente para outro recibo');
}

// ── 6c. Pagamentos contribuintes do recibo (só confirmados) ────────
async function testPagamentosDasQuotas() {
  const models = require('../models');
  const { pagamentosDasQuotas } = require('../helpers/recibos');
  const linhas = [
    { quota_id: 1, valor_aplicado: '300.00', pagamento: { id: 10, numero_documento: '2026/010', data_pagamento: '2026-09-06', referencia: 'TRF123456', estado: 'confirmado', metodo_pagamento: { nome: 'Transferência Bancária' } } },
    { quota_id: 2, valor_aplicado: '434.76', pagamento: { id: 11, numero_documento: '2026/011', data_pagamento: '2026-09-08', referencia: 'XYZ789', estado: 'confirmado', metodo_pagamento: { nome: 'MB WAY' } } },
    { quota_id: 3, valor_aplicado: '999.00', pagamento: { id: 12, numero_documento: '2026/012', data_pagamento: '2026-01-01', referencia: 'ANUL', estado: 'anulado', metodo_pagamento: null } },
  ];
  const orig = models.PagamentoQuota.findAll;
  models.PagamentoQuota.findAll = async () => linhas;
  try {
    const lista = await pagamentosDasQuotas([1, 2, 3]);
    assert.strictEqual(lista.length, 2, 'pagamentos anulados excluídos');
    const tb = lista.find((p) => p.referencia === 'TRF123456');
    assert.ok(tb && tb.metodo === 'Transferência Bancária', 'método real do pagamento preservado');
    assert.strictEqual(tb.data_pagamento, '2026-09-06', 'data do pagamento preservada');
    assert.strictEqual(lista.find((p) => p.referencia === 'XYZ789').valor, 434.76, 'valor aplicado por pagamento');
  } finally {
    models.PagamentoQuota.findAll = orig;
  }
}

// ── 7. Cobertura por recibos: apenas estado 'emitido' conta ─────────
async function testCoberturaPorEstado() {
  const models = require('../models');
  const { cobertoPorQuota } = require('../helpers/recibos');
  const linhas = [
    { quota_id: 1, valor: '50.00', recibo: { estado: 'emitido' } },
    { quota_id: 1, valor: '60.00', recibo: { estado: 'anulado' } },
  ];
  const orig = models.ReciboQuota.findAll;
  models.ReciboQuota.findAll = async (opts) => {
    const include = opts && opts.include && opts.include[0];
    assert.ok(include && include.model && include.model.name === 'Recibo', 'query une com Recibo');
    assert.strictEqual(include.where.estado, 'emitido', 'cobertura só consulta recibos emitidos');
    return linhas.filter((l) => l.recibo.estado === include.where.estado);
  };
  try {
    const mapa = await cobertoPorQuota([1]);
    assert.strictEqual(mapa.get(1), 5000, 'recibo emitido conta como cobertura (50 €)');
    assert.strictEqual(mapa.size, 1, 'recibo anulado NÃO conta como cobertura');
  } finally {
    models.ReciboQuota.findAll = orig;
  }
}

// ── 8. Anulação de recibo: estado, histórico e devolução à disponibilidade ──
async function testAnularRecibo() {
  const models = require('../models');
  const sequelize = require('../config/database');
  const { anularRecibo } = require('../helpers/recibos');

  const origT = sequelize.transaction;
  const origFind = models.Recibo.findByPk;
  let commits = 0;
  sequelize.transaction = async () => ({ commit: async () => { commits += 1; }, rollback: async () => {}, LOCK: { UPDATE: 'UPDATE' } });
  const recibo = {
    id: 9,
    estado: 'emitido',
    update: async (campos) => {
      Object.assign(recibo, campos);
      ultimosCampos = campos;
    },
  };
  let ultimosCampos = null;
  models.Recibo.findByPk = async () => recibo;
  try {
    const ok = await anularRecibo(9, { motivo: 'Emitido por engano' });
    assert.strictEqual(ok, true, 'recibo emitido é anulado');
    assert.strictEqual(recibo.estado, 'anulado', 'estado persistido como anulado');
    assert.strictEqual(ultimosCampos.estado, 'anulado');
    assert.strictEqual(ultimosCampos.motivo_anulacao, 'Emitido por engano', 'motivo guardado no histórico');
    assert.deepStrictEqual(Object.keys(ultimosCampos).sort(), ['estado', 'motivo_anulacao'], 'só o recibo é alterado (pagamentos intactos)');
    assert.strictEqual(commits, 1, 'transação concluída');

    const repetido = await anularRecibo(9, { motivo: '' });
    assert.strictEqual(repetido, false, 'recibo já anulado não é anulado de novo');
  } finally {
    sequelize.transaction = origT;
    models.Recibo.findByPk = origFind;
  }
}

async function main() {
  testRegras();
  testTransitadosParser();
  testTransitadosCampos();
  testFIFOPagamentos();
  testVistaMapa();
  testVistaComprovativos();
  testVistaRecibos();
  testVistaDetalhePagamento();
  testVistaFormPagamento();
  await testPdfRecibo();
  await testModosDistribuicao();
  await testPdfUmaPagina();
  await testCoberturaPorEstado();
  await testAnularRecibo();
  testCodigoVerificacao();
  await testPagamentosDasQuotas();
  console.log('✓ Testes do módulo Quotas (mapa/comprovativos/recibos) passaram (sem base de dados).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
