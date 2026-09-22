// ═══════════════════════════════════════════════════════════════════
// T8 — RENDER das vistas de SUPORTE com contexto representativo (sem BD).
//
// PORQUÊ ESTE TESTE EXISTE
// `scripts/check-templates.js` compila e renderiza TODAS as vistas, mas com um
// contexto "smoke" quase vazio: como os `{{#if}}`/`{{#each}}` não têm dados, os
// ramos interiores NUNCA são executados. Um helper que não existe só rebenta
// quando o ramo que o chama é realmente avaliado — foi assim que
// `{{money …}}` passou meses dentro de `detalhe-suporte.handlebars` sem que
// nada falhasse (o Handlebars só lança `Missing helper` ao executar o ramo).
//
//   node -e "const h=require('handlebars');h.compile('{{#if x}}{{money y}}{{/if}}')({x:false})"
//   → devolve "" e NÃO lança. Com `{x:true}` → "Missing helper: \"money\"".
//
// Este teste fecha a lacuna: renderiza cada vista `*-suporte.handlebars` com
// contexto REPRESENTATIVO (o mesmo que o router entrega, ver `routes/*.js`),
// de modo a executar os ramos relevantes e a exercer cada helper/partial usado.
//
// O que fica coberto a partir de agora:
//   · helper inexistente (o caso do `money`) → falha imediata;
//   · parcial inexistente (`{{> _x}}` sem registo) → falha na COMPILAÇÃO;
//   · helper usado só dentro de `{{#if}}`/`{{#each}}` → falha (ramo executado);
//   · erro de sintaxe/expressão na vista → falha na compilação.
//
// O que este teste NÃO é: não substitui `test-mascara-vistas.js` (PII), nem os
// testes de allow-list/isolamento, nem `check-templates.js`. Complementa-os.
//
// Utilização: node scripts/test-vistas-suporte.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const RAIZ = path.join(__dirname, '..');
let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

console.log('\nTestes de RENDER das vistas de suporte (sem BD)');

// ── Infraestrutura: os MESMOS helpers e partials que a aplicação usa ──
// (a aplicação regista-os em app.js via express-handlebars; aqui usa-se o
// Handlebars direto, como os restantes testes de vista do projeto.)
Handlebars.registerHelper(require(path.join(RAIZ, 'helpers', 'handlebars-helpers')));

const partialsDir = path.join(RAIZ, 'views', 'partials');
for (const f of fs.readdirSync(partialsDir)) {
  if (!f.endsWith('.handlebars')) continue;
  Handlebars.registerPartial(f.replace(/\.handlebars$/, ''), fs.readFileSync(path.join(partialsDir, f), 'utf8'));
}

const compilar = (relativa) => Handlebars.compile(fs.readFileSync(path.join(RAIZ, relativa), 'utf8'));

// ── Contextos representativos ──────────────────────────────────────
// Construídos a partir do que cada router entrega às vistas (verificado em
// `routes/*.js`), sem BD: apenas o suficiente para executar os ramos usados.

// admin/assembleias/detalhe-suporte — routes/assembleias.js:220
// O router calcula `item.fcr` antes de renderizar; reproduz-se o mesmo objeto.
const itemAgendaComFcr = {
  id: 100, ordem: 1, descricao: 'Substituição do elevador', sujeito_votacao: true,
  deliberacao_estado: 'aprovada', valor_aprovado: 75.5,
  deliberacao_nota: 'Utilização do FCR para o elevador',
  fcr: { valorAprovadoC: 7550, utilizadoC: 0, disponivelC: 7550, valorAprovado: 75.5, utilizado: 0, disponivel: 75.5 },
};
const ctxAssembleias = {
  titulo: 'Assembleia 2026/1',
  assembleia: {
    id: 1, numero: '2026/1', tipo: 'extraordinaria', estado: 'realizada',
    data: '2026-04-20', hora: '21:00', local: 'Sala comum',
    ordem_trabalhos: '1. Elevador\n2. Orçamento',
    agenda_itens: [itemAgendaComFcr],
  },
  anexos: [{ id: 7, nome: 'Orçamento.pdf', data: '2026-04-01', drive_status: 'guardado' }],
};

// admin/condominos/listar-suporte — routes/admin.js:710
const ctxCondominos = {
  titulo: 'Condóminos',
  pessoas: [
    { id: 1, nome: 'Maria Silva', email: 'maria.silva@dominio.pt', telefone: '912 345 678', nif: '123456789', tipo: 'proprietario', fracoes: [{ designacao: 'A' }] },
    { id: 2, nome: 'Bruno Costa', email: null, telefone: null, nif: null, tipo: 'arrendatario', fracoes: [] },
  ],
};

// admin/contas/listar-suporte — routes/financeiro.js:138
const ctxContas = {
  titulo: 'Contas bancárias',
  contas: [
    { id: 10, nome: 'Conta corrente', banco: 'CGD', iban: 'PT50000201231234567890154', tipo: 'corrente', saldo: 310.55, ativa: true },
    { id: 11, nome: 'Fundo de Reserva', banco: null, iban: 'PT50000201231234567890154', tipo: 'fundo_reserva', saldo: 275, ativa: false },
  ],
  resumo: { saldoContas: 585.55, fundoReserva: 275, contas: [] },
};

// admin/documentos/listar-suporte — routes/documentos.js:114 e :219
const ctxDocumentos = {
  titulo: 'Documentos',
  documentos: [
    { id: 5, nome: 'Ata 10/01', pasta: 'atas', tipo: 'ata', data: '2026-01-10', drive_status: 'guardado', drive_erro: null, drive_uploaded_at: '2026-01-11', disponivel_condominos: true },
    { id: 6, nome: 'Recibo 2026/1', pasta: 'recibos', tipo: 'recibo', data: '2026-02-01', drive_status: 'erro', drive_erro: 'invalid_grant: token revoked', drive_uploaded_at: null, disponivel_condominos: false },
  ],
  pasta: null, pastasMulti: null, rotulo: null, nDocumentos: 2,
  pastas: { atas: 'Atas', recibos: 'Recibos de Pagamento' },
  driveLigado: true,
};

// admin/emails/index-suporte — routes/emails.js:92
const ctxEmails = {
  titulo: 'Emails',
  emails: [
    { id: 1, tipo: 'recibo', estado: 'erro', tentativas: 3, destinatario_email: 'joao@exemplo.pt', assunto: 'Recibo 2026/1', message_id: null, erro: 'SMTP timeout', data_enviada: null, data_prevista: '2026-02-01' },
    { id: 2, tipo: 'aviso', estado: 'enviado', tentativas: 1, destinatario_email: 'ana@exemplo.pt', assunto: 'Aviso', message_id: '<abc@exemplo.pt>', erro: null, data_enviada: '2026-02-02', data_prevista: null },
  ],
  filtro: 'todas', tipo: null, origens: {},
  // Período da listagem: a MESMA resolução da vista de administração (o suporte
  // não pode ver um histórico silenciosamente truncado, nem deixar de o alargar).
  periodo: { deInput: '2026-09-01', ateInput: '2026-09-20', atalho: 'este-mes', rotulo: 'Este mês' },
  periodos: [{ id: 'este-mes', rotulo: 'Este mês' }, { id: 'mes-anterior', rotulo: 'Mês anterior' }, { id: 'ultimos-7', rotulo: 'Últimos 7 dias' }, { id: 'ultimos-30', rotulo: 'Últimos 30 dias' }, { id: 'personalizado', rotulo: 'Personalizado' }],
  contagens: { total: 2, pendentes: 0, enviados: 1, erros: 1, cancelados: 0 },
  estadoSmtp: { configurado: true, servidor: 'smtp.gmail.com', porta: '587', utilizador: 'condominio@gmail.com', remetente: 'condominio@gmail.com', nomeRemetente: 'Administração', seguranca: 'STARTTLS (587)', temPassword: true, ultimo_erro: 'Falha de autenticação' },
  preferencias: [], estadosLabel: {},
};

// admin/orcamento/detalhe-suporte — routes/orcamento.js:217
const ctxOrcamento = {
  titulo: 'Orçamento 2026',
  orcamento: {
    id: 1, designacao: 'Orçamento 2026', estado: 'aprovado',
    data_inicio: '2026-01-01', data_fim: '2026-12-31',
    rubricas: [
      { descricao: 'Elevador', categoria: { nome: 'Manutenção' }, valor_anual: 1200.5, metodo_distribuicao: 'permilagem', periodicidade: 'mensal' },
      { descricao: 'Limpeza', categoria: null, valor_anual: 3600, metodo_distribuicao: 'igual', periodicidade: 'trimestral' },
    ],
  },
  total: 4800.5, nDistribuicoes: 12, nPlano: 24,
  categorias: [],
  alteracoes: [
    { tipo_alteracao: 'criacao', entidade_alterada: 'OrcamentoRubrica', valor_anterior: null, valor_novo: 1200.5, utilizador: { nome: 'M.S.' }, data_alteracao: '2026-01-05T10:00:00' },
    { tipo_alteracao: 'edicao', entidade_alterada: null, valor_anterior: 1000, valor_novo: 1200.5, utilizador: null, data_alteracao: '2026-01-06T11:30:00' },
  ],
};

// admin/pagamentos/detalhe-suporte — routes/financeiro.js:1682
// A vista acede a `{{this.PagamentoQuota.valor_aplicado}}` (atributo da tabela
// de junção) e a `{{this.PagamentoExtraParcela.valor_aplicado}}`.
const ctxPagamentos = {
  titulo: 'Pagamento 2026/1',
  pagamento: {
    id: 1, numero_documento: 'PAG-2026-0001', valor: 61.22, data_pagamento: '2026-02-01',
    estado: 'confirmado', referencia: 'REF-123',
    metodo_pagamento: { nome: 'Transferência' },
    fracao: { designacao: 'A' },
    comprovativo_ficheiro: 'comprovativo.pdf', comprovativo_estado: 'validado', comprovativo_data: '2026-02-02',
    quotas: [
      { numero_documento: 'Q-2026-01', mes: 1, ano: 2026, PagamentoQuota: { valor_aplicado: 61.22 } },
    ],
    parcelasExtra: [
      { extra_quota: { designacao: 'Obras fachada' }, PagamentoExtraParcela: { valor_aplicado: 50 } },
    ],
  },
  driveLigado: true,
  recibosPagamento: [{ id: 9 }],
  temRecibo: true,
};

// admin/quotas-extra/detalhe-suporte — routes/extra-quotas.js:312
const ctxQuotasExtra = {
  titulo: 'Obras fachada',
  extra: {
    id: 1, designacao: 'Obras fachada', metodo_divisao: 'permilagem', numero_parcelas: 3,
    periodicidade: 'mensal', valor_total: 900, estado: 'processada',
    aprovado_em: '2026-01-05', processado_em: '2026-01-06',
  },
  grupos: [{
    fracao: { designacao: 'A', permilagem: 250 },
    total: 225, pago: 75, emFalta: 150,
    parcelas: [
      { parcela_numero: 1, data_vencimento: '2026-02-01', valor: 75, valor_pago: 75, estado: 'paga', pagamentoNumero: 'PAG-1', reciboCodigo: 'RCP-1' },
      { parcela_numero: 2, data_vencimento: '2026-03-01', valor: 75, valor_pago: 0, estado: 'cobrada', pagamentoNumero: null, reciboCodigo: null },
      { parcela_numero: 3, data_vencimento: '2026-04-01', valor: 75, valor_pago: 0, estado: 'pendente', pagamentoNumero: null, reciboCodigo: null },
    ],
  }],
  contas: [],
  resumo: { pago: 75, emFalta: 150, tudoPago: false },
  periodicidadeLabel: { mensal: 'Mensal', trimestral: 'Trimestral' },
  estadosLabel: {}, estadoLabel: 'Processada', acoes: {},
};

// ── Catálogo: cada vista de suporte + o seu contexto representativo ──
// O contexto é aplicado com um `Object.create` para permitir variantes (ramos
// `{{else}}`/estado vazio) sem duplicar a vista.
const VISTAS = [
  { ficheiro: 'views/admin/assembleias/detalhe-suporte.handlebars', ctx: ctxAssembleias, marcas: ['Ordem de trabalhos e deliberações', 'Valor aprovado', 'Fundo de Reserva (FCR) deste ponto', 'Aprovado', 'Utilizado', 'Disponível'] },
  { ficheiro: 'views/admin/condominos/listar-suporte.handlebars', ctx: ctxCondominos, marcas: ['Condóminos', 'Maria Silva'] },
  { ficheiro: 'views/admin/contas/listar-suporte.handlebars', ctx: ctxContas, marcas: ['Contas bancárias', 'Fundo de reserva'] },
  { ficheiro: 'views/admin/documentos/listar-suporte.handlebars', ctx: ctxDocumentos, marcas: ['Documentos', 'Ata 10/01'] },
  { ficheiro: 'views/admin/emails/index-suporte.handlebars', ctx: ctxEmails, marcas: ['Emails', 'Configuração SMTP'] },
  { ficheiro: 'views/admin/orcamento/detalhe-suporte.handlebars', ctx: ctxOrcamento, marcas: ['Orçamento 2026', 'Rubricas'] },
  { ficheiro: 'views/admin/pagamentos/detalhe-suporte.handlebars', ctx: ctxPagamentos, marcas: ['Pagamento', 'Aplicações às quotas'] },
  { ficheiro: 'views/admin/quotas-extra/detalhe-suporte.handlebars', ctx: ctxQuotasExtra, marcas: ['Obras fachada', 'Valor total', 'Parcela'] },
];

// ── 1. Todas as vistas `*-suporte` estão no catálogo ───────────────
// (garante que uma vista NOVA de suporte não fica sem cobertura de render)
titulo('T8.1 — nenhuma vista *-suporte fica fora do catálogo');
const encontradas = [];
(function varrer(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) varrer(p);
    else if (e.name.endsWith('-suporte.handlebars')) encontradas.push(path.relative(RAIZ, p).replace(/\\/g, '/'));
  }
})(path.join(RAIZ, 'views'));
const noCatalogo = VISTAS.map((v) => v.ficheiro).sort();
assert.deepStrictEqual(
  encontradas.sort(), noCatalogo,
  `há vistas *-suporte fora do catálogo de render.\n  em disco: ${encontradas.join(', ')}\n  no catálogo: ${noCatalogo.join(', ')}`
);
feito(`${encontradas.length} vistas *-suporte encontradas — todas cobertas`);

// ── 2. Compilação + render com contexto representativo ─────────────
// É AQUI que um helper inexistente (ex.: `money`) rebenta: o render executa os
// ramos com dados e o Handlebars lança `Missing helper: "…"`.
titulo('T8.2 — as vistas renderizam com contexto representativo');
const renderizadas = {};
for (const v of VISTAS) {
  const tpl = compilar(v.ficheiro); // lança se a sintaxe/expressão for inválida
  let html;
  try {
    html = tpl(v.ctx);
  } catch (e) {
    assert.fail(`${v.ficheiro}: falhou no render -> ${e.message}`);
  }
  assert.strictEqual(typeof html, 'string', `${v.ficheiro}: devolve HTML`);
  renderizadas[v.ficheiro] = html;

  // Marca textual presente: prova que o ramo principal foi mesmo executado e
  // não ficou um HTML vazio (render "sem erro" mas sem conteúdo não serve).
  for (const marca of v.marcas) {
    assert.ok(html.includes(marca), `${v.ficheiro}: o HTML tem de conter «${marca}» (ramo executado)`);
  }
  feito(`${v.ficheiro}: render OK (${html.length} bytes)`);
}

// ── 3. Os helpers/partials USADOS por cada vista existem mesmo ─────
// (verificação por uso: extrai `{{helper …}}` das vistas e confirma que o
// helper está registado — apanha o `money` mesmo que o ramo não seja exercido.)
titulo('T8.3 — todo o helper usado nas vistas de suporte está registado');
const helpersRegistados = new Set(Object.keys(require(path.join(RAIZ, 'helpers', 'handlebars-helpers'))));
// Helpers de bloco e do Handlebars não precisam de estar em handlers-helpers.
const HELPERS_BASE = new Set(['if', 'unless', 'each', 'with', 'lookup', 'log', 'else', 'this']);
const partialsRegistados = new Set(
  fs.readdirSync(partialsDir).filter((f) => f.endsWith('.handlebars')).map((f) => f.replace(/\.handlebars$/, ''))
);

for (const v of VISTAS) {
  const src = fs.readFileSync(path.join(RAIZ, v.ficheiro), 'utf8');
  // Comentários Handlebars não contam (não são executados).
  const semComentarios = src.replace(/\{\{!--[\s\S]*?--\}\}/g, '');

  // `{{nome …}}` e `{{#nome …}}` / `{{else if …}}` — só nomes de helper.
  const usados = new Set();
  for (const m of semComentarios.matchAll(/\{\{~?\s*#?\s*([a-zA-Z_][\w]*)\s/g)) usados.add(m[1]);
  for (const m of semComentarios.matchAll(/\{\{\s*else\s+if\s+([a-zA-Z_][\w]*)/g)) usados.add(m[1]);

  for (const h of usados) {
    if (HELPERS_BASE.has(h)) continue;
    // Um `{{campo}}` (variável de contexto) não é um helper: no Handlebars,
    // uma variável simples não tem argumentos. Distinguir pelo uso.
    const comArg = new RegExp(`\\{\\{[~ ]*#?\\s*${h}\\s+[^}]*\\}\\}`).test(semComentarios)
      || new RegExp(`\\{\\{[~ ]*#\\s*${h}\\s*\\}\\}`).test(semComentarios);
    if (!comArg) continue;
    assert.ok(
      helpersRegistados.has(h),
      `${v.ficheiro}: usa o helper «${h}», que NÃO está registado em helpers/handlebars-helpers.js`
    );
  }

  // Parciais `{{> _x}}` têm de existir em views/partials.
  for (const m of semComentarios.matchAll(/\{\{[~ ]*>\s*([\w-]+)/g)) {
    assert.ok(partialsRegistados.has(m[1]), `${v.ficheiro}: usa a parcial «${m[1]}», que não existe em views/partials/`);
  }
  feito(`${v.ficheiro}: helpers e parciais usados existem`);
}

// ── 4. Prova de que o teste APANHARIA o antigo `{{money …}}` ───────
// Regressão explícita do incidente: com o helper `money` inexistente, o render
// da vista tem de falhar. Constrói-se uma vista mínima com o mesmo padrão
// (`{{#if aprovada}}…{{money …}}…{{/if}}`) e confirma-se que o erro é lançado.
titulo('T8.4 — regressão: helper inexistente dentro de {{#if}} faz falhar');
const tplRegressao = Handlebars.compile('{{#if aprovada}}FCR aprovado: {{money valor}}{{/if}}');
assert.throws(
  () => tplRegressao({ aprovada: true, valor: 75.5 }),
  /Missing helper: "money"/,
  'um helper inexistente tem de lançar «Missing helper» ao executar o ramo'
);
feito('helper inexistente dentro de {{#if}} → erro detetado');
// E confirma-se o que o smoke test fazia: com o ramo fechado, NÃO falha — é
// precisamente por isso que era preciso este teste com contexto representativo.
assert.strictEqual(tplRegressao({ aprovada: false }), '', 'ramo fechado não executa o helper (lacuna do smoke test)');
feito('ramo fechado não executa o helper (justifica o contexto representativo)');

// ── 5. Os ramos `{{else}}` (estado vazio) também renderizam ────────
// Uma vista que só é exercida "com dados" pode esconder um erro no ramo vazio.
titulo('T8.5 — os ramos de estado vazio também renderizam');
const vazios = [
  { ficheiro: 'views/admin/condominos/listar-suporte.handlebars', ctx: { titulo: 'Condóminos', pessoas: [] } },
  { ficheiro: 'views/admin/contas/listar-suporte.handlebars', ctx: { titulo: 'Contas', contas: [], resumo: { saldoContas: 0, fundoReserva: 0 } } },
  { ficheiro: 'views/admin/documentos/listar-suporte.handlebars', ctx: { titulo: 'Documentos', documentos: [], pastas: {}, pasta: null, pastasMulti: null, rotulo: null, driveLigado: false } },
  { ficheiro: 'views/admin/emails/index-suporte.handlebars', ctx: { titulo: 'Emails', emails: [], contagens: null, estadoSmtp: null, filtro: 'todas', periodo: { deInput: '2026-09-01', ateInput: '2026-09-20', atalho: 'este-mes' }, periodos: [{ id: 'este-mes', rotulo: 'Este mês' }, { id: 'personalizado', rotulo: 'Personalizado' }] } },
  { ficheiro: 'views/admin/quotas-extra/detalhe-suporte.handlebars', ctx: { titulo: 'Extra', extra: { designacao: 'X', metodo_divisao: 'igual', numero_parcelas: 0, periodicidade: 'mensal', valor_total: 0, estado: 'pendente' }, grupos: [], resumo: { pago: 0, emFalta: 0 }, periodicidadeLabel: {} } },
  { ficheiro: 'views/admin/orcamento/detalhe-suporte.handlebars', ctx: { titulo: 'Orçamento', orcamento: { designacao: 'X', estado: 'rascunho', data_inicio: '2026-01-01', data_fim: '2026-12-31', rubricas: [] }, total: 0, nDistribuicoes: 0, nPlano: 0, alteracoes: [] } },
];
for (const v of vazios) {
  const tpl = compilar(v.ficheiro);
  const html = tpl(v.ctx);
  assert.ok(html.length > 0, `${v.ficheiro}: o ramo vazio tem de produzir HTML`);
  feito(`${v.ficheiro}: ramo de estado vazio renderiza`);
}

console.log(`\n✓ Testes de render das vistas de suporte passaram (${nTestes} verificações, sem BD).`);
