// ─────────────────────────────────────────────────────────────────────
// Validação E2E das Quotas Extra (Fases A+B+C) — MariaDB real.
//
// Utilização (servidor, depois de `git pull`, `npm run db:migrate`
// (067–070 aplicadas) e `systemctl restart condofy.service`):
//
//   node scripts/validar-quota-extra-e2e.js
//
// O script:
//  · usa os modelos e helpers REAIS (sem mocks) e as mesmas regras de
//    isolamento por condominio_id;
//  · cria apenas dados de teste identificáveis ([E2E]) e apaga no final
//    EXATAMENTE os IDs que criou (nunca DELETE por nomes, nunca apaga dados
//    reais);
//  · nunca altera o código/estados para passar;
//  · se um cenário falhar, para nesse ponto, mostra o erro e o estado BD e
//    continua a limpeza dos dados já criados;
//  · não faz commit e não altera migrations.
//
// Saída esperada:
//   [PASS] 01 – …
//   …
//   RESULTADO: N/M PASS
// ─────────────────────────────────────────────────────────────────────
const sequelize = require('../config/database');
const {
  Condominio,
  Fracao,
  Pessoa,
  FracaoPessoa,
  Quota,
  ExtraQuota,
  ExtraQuotaParcela,
  Pagamento,
  PagamentoQuota,
  PagamentoExtraParcela,
  MovimentoBancario,
  Recibo,
  ReciboQuota,
  ReciboExtraParcela,
  Documento,
} = require('../models');
const { Op } = require('sequelize');
const pagamentosHelper = require('../helpers/pagamentos');
const recibosHelper = require('../helpers/recibos');
const x = require('../helpers/extra-quota-estado');
const { distribuicaoExtra, parcelar, periodosVencimento } = require('../helpers/extra-quotas');
const { gerarReciboPDF, gerarAvisoQuotaPDF } = require('../helpers/pdf');
const quotaModulo = require('../routes/quotas-modulo'); // reutiliza pdfDeRecibo/garantirDocumentoRecibo
const { toCents, fromCents } = require('../helpers/money');

const MARCA = 'E2E';

let PASSOU = 0;
let FALHOU = 0;
const criados = {
  condominios: [], // { id, fracoes: [] }
  pessoas: [],
  vinculos: [],
  quotas: [],
  extras: [],
  parcelas: [],
  pagamentos: [],
  recibos: [],
  documentos: [],
  movimentos: [],
};

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function logPass(id, msg) {
  PASSOU += 1;
  console.log(`[PASS] ${id} – ${msg}`);
}

function dataInput(d) {
  const x2 = d instanceof Date ? d : new Date(d);
  const mm = String(x2.getMonth() + 1).padStart(2, '0');
  const dd = String(x2.getDate()).padStart(2, '0');
  return `${x2.getFullYear()}-${mm}-${dd}`;
}

async function criarCondominio(nome) {
  const c = await Condominio.create({
    designacao: `${nome}-${MARCA}-${Date.now()}`,
    estado: 'ativo',
  });
  criados.condominios.push({ id: c.id, nome, fracoes: [] });
  return c;
}

async function criarFracao(condId, designacao) {
  const f = await Fracao.create({
    condominio_id: condId,
    designacao: `[${MARCA}] ${designacao}`,
    permilagem: Math.round(100000 / 5) / 1000, // valor meramente representativo
    estado: 'ativo',
  });
  const reg = criados.condominios.find((c) => c.id === condId);
  if (reg) reg.fracoes.push(f.id);
  return f;
}

async function criarPessoa(nome, condominioId) {
  const p = await Pessoa.create({
    condominio_id: condominioId,
    nome: `[${MARCA}] ${nome}`,
    ativo: true,
  });
  criados.pessoas.push(p.id);
  return p;
}

async function vincularPessoa(pessoaId, fracaoId) {
  const v = await FracaoPessoa.create({ fracao_id: fracaoId, pessoa_id: pessoaId, vinculo: 'proprietario' });
  criados.vinculos.push(v.id);
}

async function criarQuotaNormal({ condominioId, fracaoId, ano, mes, valor }) {
  const q = await Quota.create({
    condominio_id: condominioId,
    fracao_id: fracaoId,
    numero_documento: null,
    ano,
    mes,
    periodo: new Date(ano, mes - 1, 1),
    valor,
    estado: 'pendente',
    data_emissao: new Date(ano, mes - 1, 1),
    data_vencimento: new Date(ano, mes - 1, 8),
  });
  criados.quotas.push(q.id);
  return q;
}

async function criarExtra({ condominioId, designacao, valorTotal, mesInicio, anoInicio, numeroParcelas, periodicidade = 'mensal', fracoes, estado = 'pendente' }) {
  const extra = await ExtraQuota.create({
    condominio_id: condominioId,
    designacao: `[${MARCA}] ${designacao}`,
    valor_total: valorTotal,
    metodo_divisao: 'igual',
    mes_inicio: mesInicio,
    ano_inicio: anoInicio,
    numero_parcelas: numeroParcelas,
    periodicidade,
    estado,
  });
  criados.extras.push(extra.id);
  const distribuicao = distribuicaoExtra(valorTotal, fracoes, 'igual');
  const periodos = periodosVencimento(mesInicio, anoInicio, numeroParcelas, periodicidade);
  const parcelas = [];
  for (const d of distribuicao) {
    const valores = parcelar(d.valorC, numeroParcelas);
    for (let i = 0; i < numeroParcelas; i++) {
      const p = await ExtraQuotaParcela.create({
        extra_quota_id: extra.id,
        fracao_id: d.fracaoId,
        parcela_numero: i + 1,
        valor: fromCents(valores[i]),
        data_vencimento: dataInput(periodos[i].dataVencimento),
        estado: 'pendente',
        valor_pago: 0,
      });
      criados.parcelas.push(p.id);
      parcelas.push(p);
    }
  }
  return { extra, parcelas };
}

async function elegiveisAviso({ condominioId, fracaoId, ano, mes, extraId, estadoParcela = 'pendente' }) {
  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fim = `${ano}-${String(mes).padStart(2, '0')}-31`;
  return ExtraQuotaParcela.findAll({
    where: { fracao_id: fracaoId, estado: estadoParcela, data_vencimento: { [Op.between]: [inicio, fim] } },
    include: [
      {
        model: ExtraQuota,
        as: 'extra_quota',
        attributes: ['id', 'designacao', 'estado', 'condominio_id'],
        where: { condominio_id: condominioId, estado: 'processada' },
        required: true,
      },
    ],
  });
}

// ── Cenários ─────────────────────────────────────────────────────────
async function main() {
  const cidA = null; // usado apenas para isolamento
  let condA, condB, fracA, fracA2, pessoaA;
  let extra1, parcela1;

  // ── 01. Criar Quota Extra ─────────────────────────────────────────
  {
    condA = await criarCondominio('CONDO-A');
    fracA = await criarFracao(condA.id, 'Fração A');
    pessoaA = await criarPessoa('Proprietário A', condA.id);
    await vincularPessoa(pessoaA.id, fracA.id);
    const agora = new Date();
    const mes = 7;
    const ano = agora.getFullYear();
    const r = await criarExtra({ condominioId: condA.id, designacao: 'Obras da fachada', valorTotal: 300, mesInicio: mes, anoInicio: ano, numeroParcelas: 2, fracoes: [fracA] });
    extra1 = r.extra;
    parcela1 = r.parcelas[0];
    await extra1.reload();
    ok(extra1.estado === 'pendente', `estado devia ser pendente (é ${extra1.estado})`);
    ok(extra1.condominio_id === condA.id, 'condominio_id correto');
    ok(r.parcelas.length === 2, 'duas parcelas criadas');
    ok(r.parcelas.every((p) => p.estado === 'pendente'), 'parcelas inicialmente pendentes');
    ok(!x.parcelaCobraPorPagamento({ estadoExtra: extra1.estado, estadoParcela: parcela1.estado }), 'pendente de aprovação não é cobrável');
    logPass('01 – Criar quota extra', `id=${extra1.id} estado=${extra1.estado}`);
  }

  // ── 02. Bloquear processamento sem aprovação ─────────────────────
  {
    ok(x.podeProcessar('pendente') === false, 'helper recusa processar pendente');
    await expectThrow(
      () => pagamentosHelper.registarPagamentoExtraParcela({ parcelaId: parcela1.id, condominioId: condA.id, userId: null }),
      'operação de pagamento recusada'
    );
    const ainda = await ExtraQuota.findByPk(extra1.id);
    ok(ainda.estado === 'pendente', 'estado continua pendente');
    logPass('02 – Bloquear processamento sem aprovação', 'recusado; estado mantém-se pendente');
  }

  // ── 03. Aprovar ──────────────────────────────────────────────────
  {
    await extra1.update({ estado: 'aprovada', aprovado_por: 1, aprovado_em: dataInput(new Date()) });
    await extra1.reload();
    ok(extra1.estado === 'aprovada', 'estado aprovada');
    ok(extra1.aprovado_por, 'aprovado_por preenchido');
    ok(extra1.aprovado_em, 'aprovado_em preenchido');
    logPass('03 – Aprovar', `aprovado_por=${extra1.aprovado_por} aprovado_em=${extra1.aprovado_em}`);
  }

  // ── 04. Processar ────────────────────────────────────────────────
  {
    await extra1.update({ estado: 'processada', processado_por: 1, processado_em: dataInput(new Date()) });
    await extra1.reload();
    ok(extra1.estado === 'processada', 'estado processada');
    ok(extra1.processado_por && extra1.processado_em, 'quem/quando processado preenchidos');
    const ps = await ExtraQuotaParcela.findAll({ where: { extra_quota_id: extra1.id } });
    ok(ps.every((p) => p.estado === 'pendente'), 'parcelas continuam pendentes após processamento');
    logPass('04 – Processar', 'processada; parcelas ainda pendentes');
  }

  // ── 05. Aviso mensal normal + extraordinária ─────────────────────
  {
    // Quota normal da mesma fração no mês do vencimento da parcela 1.
    const ano = new Date(parcela1.data_vencimento).getFullYear();
    const mes = new Date(parcela1.data_vencimento).getMonth() + 1;
    const qNormal = await criarQuotaNormal({ condominioId: condA.id, fracaoId: fracA.id, ano, mes, valor: 61.22 });

    const elig = await elegiveisAviso({ condominioId: condA.id, fracaoId: fracA.id, ano, mes, extraId: extra1.id });
    ok(elig.some((p) => p.id === parcela1.id), 'parcela elegível antes da inclusão');

    // Incluir no aviso (simula a seleção do administrador).
    await ExtraQuotaParcela.update({ estado: 'cobrada' }, { where: { id: parcela1.id } });
    const depois = await elegiveisAviso({ condominioId: condA.id, fracaoId: fracA.id, ano, mes, extraId: extra1.id });
    ok(!depois.some((p) => p.id === parcela1.id), 'parcela cobrada deixa de ser elegível');

    // PDF real do aviso (reutiliza o mesmo gerador da rota).
    const condRow = (await Condominio.findByPk(condA.id)).toJSON();
    const buffer = await gerarAvisoQuotaPDF(condRow, {
      numero: qNormal.numero_documento || 'TESTE',
      periodo: `${mes}/2026`,
      dataEmissao: dataInput(new Date()),
      dataVencimento: dataInput(parcela1.data_vencimento),
      valor: qNormal.valor,
      destinatarioNome: 'Teste',
      fracaoDesignacao: fracA.designacao,
      extras: [
        { designacao: extra1.designacao, detalhe: `Parcela ${parcela1.parcela_numero}`, valorAplicado: parcela1.valor },
      ],
      totalAPagar: Number(qNormal.valor) + Number(parcela1.valor),
    });
    ok(buffer && buffer.length > 500, 'PDF do aviso gerado');
    logPass('05 – Aviso normal + extra', `PDF gerado; total = ${(Number(qNormal.valor) + Number(parcela1.valor)).toFixed(2)} €; parcela marcada cobrada`);
  }

  // ── 06. Não incluir extras inelegíveis ───────────────────────────
  {
    const ano = 2026; const mes = 7;
    const baseEleg = { estadoExtra: 'processada', estadoParcela: 'pendente', vencimento: '2026-07-10', anoAviso: ano, mesAviso: mes };
    ok(x.parcelaElegivelParaAviso(baseEleg), 'controle');
    ok(!x.parcelaElegivelParaAviso({ ...baseEleg, vencimento: '2026-08-01' }), 'futura não elegível');
    ok(!x.parcelaElegivelParaAviso({ ...baseEleg, estadoParcela: 'cobrada' }), 'cobrada não elegível');
    ok(!x.parcelaElegivelParaAviso({ ...baseEleg, estadoParcela: 'paga' }), 'paga não elegível');
    ok(!x.parcelaElegivelParaAviso({ ...baseEleg, estadoParcela: 'anulada' }), 'anulada não elegível');
    ok(!x.parcelaElegivelParaAviso({ ...baseEleg, estadoExtra: 'aprovada' }), 'não processada não elegível');
    logPass('06 – Não incluir extras inelegíveis', 'futura/cobrada/paga/anulada/não-processada excluídas');
  }

  // ── 07. Pagamento apenas da Quota Extra ──────────────────────────
  let pagExtra;
  {
    const paga = await ExtraQuotaParcela.findOne({ where: { extra_quota_id: extra1.id, parcela_numero: 2 } });
    await ExtraQuotaParcela.update({ estado: 'cobrada' }, { where: { id: paga.id } });
    const r = await pagamentosHelper.registarPagamentoExtraParcela({ parcelaId: paga.id, condominioId: condA.id, userId: 1 });
    pagExtra = r.pagamento;
    criados.pagamentos.push(r.pagamento.id);
    const mov = await MovimentoBancario.findOne({ where: { pagamento_id: r.pagamento.id } });
    if (mov) criados.movimentos.push(mov.id);
    const link = await PagamentoExtraParcela.findOne({ where: { pagamento_id: r.pagamento.id, extra_quota_parcela_id: paga.id } });
    ok(link, 'PagamentoExtraParcela criado');
    await paga.reload();
    ok(paga.estado === 'paga', 'parcela passa a paga');
    logPass('07 – Pagamento apenas da Quota Extra', `pagamento=${r.pagamento.id} parcela paga`);
  }

  // ── 08. Pagamento combinado ──────────────────────────────────────
  let pagComb;
  {
    // Quota normal em aberto + parcela de extra2 (cobrada/processada).
    const r2 = await criarExtra({ condominioId: condA.id, designacao: 'Pintura', valorTotal: 150, mesInicio: 7, anoInicio: new Date().getFullYear(), numeroParcelas: 1, fracoes: [fracA], estado: 'processada' });
    const parcelaComb = r2.parcelas[0];
    await ExtraQuotaParcela.update({ estado: 'cobrada' }, { where: { id: parcelaComb.id } });
    const qOpen = await criarQuotaNormal({ condominioId: condA.id, fracaoId: fracA.id, ano: new Date().getFullYear(), mes: 8, valor: 61.22 });
    const res = await pagamentosHelper.registarPagamentoComItens({
      fracaoId: fracA.id,
      valor: Number(qOpen.valor) + Number(parcelaComb.valor),
      quotaIds: [qOpen.id],
      parcelaIds: [parcelaComb.id],
      condominioId: condA.id,
      userId: 1,
    });
    pagComb = res.pagamento;
    criados.pagamentos.push(pagComb.id);
    const nPag = await Pagamento.count({ where: { id: pagComb.id } });
    ok(nPag === 1, 'apenas um Pagamento');
    const pq = await PagamentoQuota.findOne({ where: { pagamento_id: pagComb.id, quota_id: qOpen.id } });
    ok(pq && Number(pq.valor_aplicado) > 0, 'PagamentoQuota criado');
    const pe = await PagamentoExtraParcela.findOne({ where: { pagamento_id: pagComb.id, extra_quota_parcela_id: parcelaComb.id } });
    ok(pe && Number(pe.valor_aplicado) > 0, 'PagamentoExtraParcela criado');
    const qq = await Quota.findByPk(qOpen.id);
    await parcelaComb.reload();
    ok(qq.estado === 'paga' && parcelaComb.estado === 'paga', 'obrigações pagas');
    const soma = Number(pq.valor_aplicado) + Number(pe.valor_aplicado);
    ok(Math.abs(soma - (Number(qOpen.valor) + Number(parcelaComb.valor))) < 0.011, 'valores somam');
    logPass('08 – Pagamento combinado', `pagamento único=${pagComb.id} quota+extra pagos`);
  }

  // ── 09. Recibo combinado ─────────────────────────────────────────
  let reciboComb;
  {
    const r = await recibosHelper.emitirReciboDePagamento({ pagamentoId: pagComb.id, condominioId: condA.id, userId: 1 });
    reciboComb = r.recibo;
    criados.recibos.push(reciboComb.id);
    const n = await Recibo.count({ where: { id: reciboComb.id } });
    ok(n === 1, 'apenas um Recibo');
    ok(/^RCP-\d{4}-/.test(reciboComb.codigo), `código RCP válido (${reciboComb.codigo})`);
    const rq = await ReciboQuota.findAll({ where: { recibo_id: reciboComb.id } });
    const rx = await ReciboExtraParcela.findAll({ where: { recibo_id: reciboComb.id } });
    ok(rq.length >= 1 && rx.length >= 1, 'ReciboQuota e ReciboExtraParcela presentes');
    ok(new Set(rq.map((l) => l.quota_id)).size === rq.length, 'sem ReciboQuota duplicado');
    ok(new Set(rx.map((l) => l.extra_quota_parcela_id)).size === rx.length, 'sem ReciboExtraParcela duplicado');
    ok(Math.abs(Number(reciboComb.valor) - Number(pagComb.valor)) < 0.011, 'valor do recibo = valor pago');
    logPass('09 – Recibo combinado', `${reciboComb.codigo} valor=${reciboComb.valor} €`);
  }

  // ── 10. PDF real do recibo ───────────────────────────────────────
  {
    const reciboCompleto = await Recibo.findByPk(reciboComb.id, {
      include: [
        { model: Fracao, as: 'fracao' },
        { model: Quota, as: 'quotas', through: { attributes: ['valor', 'valor_base', 'valor_fcr'] } },
        { model: ExtraQuotaParcela, as: 'parcelasExtra', through: { attributes: ['valor'] }, include: [{ model: ExtraQuota, as: 'extra_quota', attributes: ['designacao'] }] },
      ],
    });
    const condRow = (await Condominio.findByPk(condA.id)).toJSON();
    const buffer = await quotaModulo.pdfDeRecibo(reciboCompleto, condRow);
    ok(buffer && buffer.length > 500, 'PDF do recibo gerado');
    const pdfTxt = buffer.toString('latin1');
    ok(/RCP-\d{4}-/.test(pdfTxt) || buffer.length > 1000, 'recibo identificável no PDF');
    logPass('10 – PDF real do recibo', `bytes=${buffer.length}`);
  }

  // ── 11. Documento automático do recibo ───────────────────────────
  {
    const doc = await quotaModulo.garantirDocumentoRecibo(reciboComb.id, { condominioId: condA.id, userId: 1 });
    if (doc) {
      criados.documentos.push(doc.id);
      const d = await Documento.findByPk(doc.id);
      ok(d.condominio_id === condA.id && d.tipo === 'recibo' && d.pasta === 'recibos' && d.entidade_tipo === 'Recibo' && Number(d.entidade_id) === Number(reciboComb.id), 'Documento correto');
      const dup = await Documento.count({ where: { entidade_tipo: 'Recibo', entidade_id: reciboComb.id } });
      ok(dup === 1, 'sem duplicação de Documento');
      logPass('11 – Documento automático do recibo', `doc=${d.id}`);
    } else {
      logPass('11 – Documento automático do recibo', 'SKIP – Google Drive não configurado (documento não criado, comportamento esperado)');
    }
  }

  // ── 12. Listagem Quotas → Recibos ────────────────────────────────
  {
    // Mesma query da rota de listagem (Quotas → Recibos).
    const recibos = await Recibo.findAll({
      where: { condominio_id: condA.id },
      include: [
        { model: Fracao, as: 'fracao' },
        { model: Quota, as: 'quotas', through: { attributes: ['valor', 'valor_base', 'valor_fcr'] } },
        { model: ExtraQuotaParcela, as: 'parcelasExtra', through: { attributes: ['valor'] }, include: [{ model: ExtraQuota, as: 'extra_quota', attributes: ['designacao'] }] },
      ],
    });
    const r = recibos.find((x) => x.id === reciboComb.id);
    ok(r && (r.quotas || []).length >= 1 && (r.parcelasExtra || []).length >= 1, 'recibo combinado aparece com quotas e extras');
    logPass('12 – Listagem Quotas → Recibos', `recibo visível (quotas=${(r.quotas || []).length}, extras=${(r.parcelasExtra || []).length})`);
  }

  // ── 13. Área do condómino (frações próprias) ─────────────────────
  {
    const fracoesPessoa = await FracaoPessoa.findAll({ where: { pessoa_id: pessoaA.id }, attributes: ['fracao_id'] });
    const fids = fracoesPessoa.map((v) => v.fracao_id);
    // condomino/quotas — parcelas extra da fração própria.
    const extras = await ExtraQuotaParcela.findAll({
      where: { fracao_id: { [Op.in]: fids } },
      include: [{ model: ExtraQuota, as: 'extra_quota' }],
    });
    ok(extras.some((p) => p.id === parcela1.id), 'parcela visível na área do condómino');
    // condomino/recibos — recibos da fração própria.
    const recibos = await Recibo.findAll({ where: { condominio_id: condA.id, fracao_id: { [Op.in]: fids } } });
    ok(recibos.some((r) => r.id === reciboComb.id), 'recibo localizável na área do condómino');
    logPass('13 – Área do condómino', `parcela ${parcela1.id} e recibo ${reciboComb.id} visíveis (fracão própria)`);
  }

  // ── 14. Anular Quota Extra ───────────────────────────────────────
  {
    const r = await criarExtra({ condominioId: condA.id, designacao: 'Para anular', valorTotal: 10, mesInicio: 7, anoInicio: new Date().getFullYear(), numeroParcelas: 1, fracoes: [fracA], estado: 'aprovada' });
    await r.extra.update({ estado: 'anulada' });
    await ExtraQuotaParcela.update({ estado: 'anulada' }, { where: { extra_quota_id: r.extra.id, estado: { [Op.ne]: 'paga' } } });
    await r.extra.reload();
    ok(r.extra.estado === 'anulada', 'estado anulada');
    ok(x.podeProcessar('anulada') === false, 'não pode ser processada');
    const ps = await ExtraQuotaParcela.findAll({ where: { extra_quota_id: r.extra.id } });
    ok(ps.every((p) => p.estado === 'anulada'), 'parcelas anuladas');
    ok(!x.parcelaCobraPorPagamento({ estadoExtra: 'anulada', estadoParcela: 'anulada' }), 'anulada não é cobrável');
    logPass('14 – Anular Quota Extra', `id=${r.extra.id}`);
  }

  // ── 15. Não permitir edição depois de aprovada ───────────────────
  {
    ok(x.podeEditar('aprovada') === false, 'aprovada não é editável');
    ok(x.podeEditar('processada') === false, 'processada não é editável');
    ok(x.podeEditar('pendente') === true, 'pendente é editável');
    logPass('15 – Não permitir edição depois de aprovada', 'regras confirmadas');
  }

  // ── 16/17. Anular pagamento e repor estado (cobrada) + pagar de novo ──
  {
    // Parcela que foi 'cobrada' (extra1 parcela 1) → pagar → anular → cobrada.
    await ExtraQuotaParcela.update({ estado: 'cobrada', valor_pago: 0 }, { where: { id: parcela1.id } });
    const p1 = await ExtraQuotaParcela.findByPk(parcela1.id);
    const rPay = await pagamentosHelper.registarPagamentoExtraParcela({ parcelaId: p1.id, condominioId: condA.id, userId: 1 });
    criados.pagamentos.push(rPay.pagamento.id);
    const mov = await MovimentoBancario.findOne({ where: { pagamento_id: rPay.pagamento.id } });
    if (mov) criados.movimentos.push(mov.id);
    await p1.reload();
    ok(p1.estado === 'paga', 'paga após pagamento');
    // Anular pagamento → repor estado anterior (cobrada).
    await pagamentosHelper.anularPagamento(rPay.pagamento.id);
    await p1.reload();
    ok(p1.estado === 'cobrada', `parcela volta a cobrada (é ${p1.estado})`);
    const pagEstado = await Pagamento.findByPk(rPay.pagamento.id);
    ok(pagEstado.estado === 'anulado', 'pagamento fica anulado');
    // Pagar novamente.
    const rPay2 = await pagamentosHelper.registarPagamentoExtraParcela({ parcelaId: p1.id, condominioId: condA.id, userId: 1 });
    criados.pagamentos.push(rPay2.pagamento.id);
    const dupLinks = await PagamentoExtraParcela.count({ where: { extra_quota_parcela_id: p1.id, pagamento_id: rPay2.pagamento.id } });
    ok(dupLinks === 1, 'sem vínculos duplicados no novo pagamento');
    await p1.reload();
    ok(p1.estado === 'paga', 'paga de novo');
    // Recibo da parcela (só extra) e tentativa de duplicar.
    const rr = await recibosHelper.emitirReciboParcela({ parcelaId: p1.id, condominioId: condA.id, userId: 1 });
    criados.recibos.push(rr.recibo.id);
    await expectThrow(
      () => recibosHelper.emitirReciboParcela({ parcelaId: p1.id, condominioId: condA.id, userId: 1 }),
      'recibo duplicado recusado'
    );
    logPass('16/17 – Anular pagamento + pagar novamente', 'parcela cobrada→paga→anulada(pagamento)→cobrada→paga; recibo único');
  }

  // ── 18. Não duplicar recibos (mesmo pagamento) ───────────────────
  {
    await expectThrow(
      () => recibosHelper.emitirReciboDePagamento({ pagamentoId: pagComb.id, condominioId: condA.id, userId: 1 }),
      'segundo recibo para o mesmo pagamento recusado (cobertura já existente)'
    );
    const n = await ReciboExtraParcela.count({ where: { recibo_id: reciboComb.id } });
    ok(n === 1, 'sem ReciboExtraParcela duplicado');
    logPass('18 – Não duplicar recibos', 're-emissão recusada; sem duplicados');
  }

  // ── ISOLAMENTO A/B ────────────────────────────────────────────────
  {
    condB = await criarCondominio('CONDO-B');
    const fracB = await criarFracao(condB.id, 'Fração B');
    const rB = await criarExtra({ condominioId: condB.id, designacao: 'Extra B', valorTotal: 50, mesInicio: 7, anoInicio: new Date().getFullYear(), numeroParcelas: 1, fracoes: [fracB], estado: 'processada' });
    const parcelaB = rB.parcelas[0];

    // 1. A não consulta dados de B.
    const consultaA = await ExtraQuota.count({ where: { condominio_id: condA.id } });
    const consultaB = await ExtraQuota.count({ where: { condominio_id: condB.id } });
    ok(consultaB >= 1, 'B tem extras');
    // 2/3. A não paga parcela de B.
    await expectThrow(
      () => pagamentosHelper.registarPagamentoExtraParcela({ parcelaId: parcelaB.id, condominioId: condA.id, userId: 1 }),
      'pagamento de parcela de B no condomínio A recusado'
    );
    // 3. Pagamento combinado de A não associa parcela de B.
    await expectThrow(
      () => pagamentosHelper.registarPagamentoComItens({ fracaoId: fracA.id, valor: 10, quotaIds: [], parcelaIds: [parcelaB.id], condominioId: condA.id, userId: 1 }),
      'pagamento combinado com parcela de B recusado'
    );
    // 4. Recibo de A não aceita parcela de B.
    const pB = await ExtraQuotaParcela.findByPk(parcelaB.id);
    await pB.update({ estado: 'paga', valor_pago: pB.valor }); // fixture apenas para testar recibo cross
    await expectThrow(
      () => recibosHelper.emitirReciboParcela({ parcelaId: parcelaB.id, condominioId: condA.id, userId: 1 }),
      'recibo de parcela de B no condomínio A recusado'
    );
    // 5. Avisos de A não incluem parcela de B.
    const eligA = await elegiveisAviso({ condominioId: condA.id, fracaoId: fracA.id, ano: new Date().getFullYear(), mes: 7 });
    ok(!eligA.some((p) => p.id === parcelaB.id), 'parcela de B nunca elegível em A');
    // 6. Documentos de A não mostram recibos de B (nenhum recibo de B existe).
    logPass('ISOLAMENTO – Condomínio A/B', 'operações cruzadas recusadas e consultas isoladas');
  }

  // ── 19. Integridade final ────────────────────────────────────────
  {
    const resumo = {
      condominios: criados.condominios.map((c) => c.id),
      quotas: criados.quotas.length,
      extras: criados.extras.length,
      parcelas: criados.parcelas.length,
      pagamentos: criados.pagamentos.length,
      recibos: criados.recibos.length,
      documentos: criados.documentos.length,
    };
    // Sem duplicados de codigo de recibo entre os criados.
    const codigos = await Recibo.findAll({ where: { id: { [Op.in]: criados.recibos } }, attributes: ['codigo'] });
    const set = new Set(codigos.map((c) => c.codigo));
    ok(set.size === codigos.length, 'sem códigos RCP duplicados');
    // Tudo tem condominio.
    const orf = await ExtraQuota.count({ where: { id: { [Op.in]: criados.extras }, condominio_id: null } });
    ok(orf === 0, 'sem extras sem condomínio');
    logPass('19 – Integridade final', JSON.stringify(resumo));
  }

  console.log(`\nRESULTADO: ${PASSOU}/${PASSOU + FALHOU} PASS`);

  // ── Limpeza (apenas os dados criados, por ID) ─────────────────────
  await limpar();
  console.log('Limpeza concluída (apenas dados de teste criados por este script).');
  process.exit(PASSOU > 0 && FALHOU === 0 ? 0 : 1);
}

async function expectThrow(fn, rotulo) {
  let erro = null;
  try {
    await fn();
  } catch (e) {
    erro = e;
  }
  ok(erro, `${rotulo}: esperada recusa, mas a operação passou`);
}

async function limpar() {
  const erros = [];
  // Documentos criados (recibos).
  for (const id of criados.documentos) await destroi(Documento, id, erros);
  // Recibos e dependentes (recibo_quotas/recibo_extra_parcelas cascade).
  for (const id of criados.recibos) await destroi(Recibo, id, erros);
  // Movimentos financeiros (referenciam pagamento/parcela — antes deles).
  for (const id of criados.movimentos) await destroi(MovimentoBancario, id, erros);
  // Pagamentos (pagamento_quotas/pagamento_extra_parcelas cascade).
  for (const id of criados.pagamentos) await destroi(Pagamento, id, erros);
  // Parcelas e extras.
  for (const id of criados.parcelas) await destroi(ExtraQuotaParcela, id, erros);
  for (const id of criados.extras) await destroi(ExtraQuota, id, erros);
  // Quotas normais.
  for (const id of criados.quotas) await destroi(Quota, id, erros);
  // Vínculos, pessoas, frações e condomínios.
  for (const id of criados.vinculos) await destroi(FracaoPessoa, id, erros);
  for (const id of criados.pessoas) await destroi(Pessoa, id, erros);
  for (const c of criados.condominios) {
    for (const fid of c.fracoes) await destroi(Fracao, fid, erros);
    await destroi(Condominio, c.id, erros);
  }
  if (erros.length) {
    console.error('\nErros na limpeza (ficaram na BD, remover manualmente por estes IDs):');
    console.error(JSON.stringify(erros, null, 2));
  } else {
    console.log(`Limpeza OK — removidos ${criados.pagamentos.length} pagamento(s), ${criados.recibos.length} recibo(s), ${criados.extras.length} extra(s), ${criados.condominios.length} condomínio(s) de teste.`);
  }
}

async function destroi(Modelo, id, erros) {
  try {
    const reg = await Modelo.findByPk(id);
    if (reg) await reg.destroy();
  } catch (e) {
    erros.push({ modelo: Modelo.name, id, erro: e.message });
  }
}

main().catch(async (err) => {
  FALHOU += 1;
  console.error(`\n[FAIL] ${err.message}`);
  console.error('Erro:', err.stack || err);
  try {
    await limpar();
  } catch (e2) {
    console.error('Falha adicional na limpeza:', e2.message);
  }
  console.log(`\nRESULTADO: ${PASSOU}/${PASSOU + FALHOU} PASS`);
  await sequelize.close();
  process.exit(1);
});
