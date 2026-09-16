// Testes da área do condómino (mobile-first) — sem base de dados.
// Utilização: node scripts/test-area-condomino.js
//
// Cobre:
//  1. navegação inferior do condómino (Início · Quotas · Documentos · Avisos · Menu)
//     e a barra do backoffice intacta;
//  2. o Início: resumo da fração, próximo vencimento, ações rápidas, atividade
//     recente, próximos acontecimentos, transparência compacta e os blocos de
//     saída/titularidades terminadas preservados;
//  3. a área Quotas com separadores (Quotas · Pagamentos · Recibos) e os URLs
//     anteriores sempre válidos;
//  4. o cabeçalho: atalho real para os avisos (com contagem) e «Preparar saída»
//     no perfil, sem botões sem ação;
//  5. invariantes de integridade: nenhuma rota removida, portal continua só de
//     leitura, autorização por condomínio ativo e mockup da homepage coerente
//     com a barra real.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

Object.entries(require('../helpers/handlebars-helpers')).forEach(([k, v]) => handlebars.registerHelper(k, v));
const partialsDir = path.join(RAIZ, 'views', 'partials');
for (const entry of fs.readdirSync(partialsDir)) {
  if (entry.endsWith('.handlebars')) {
    handlebars.registerPartial(entry.replace('.handlebars', ''), fs.readFileSync(path.join(partialsDir, entry), 'utf8'));
  }
}
const render = (rel, ctx) => handlebars.compile(ler(rel))(ctx);

// ── 1. Navegação inferior ─────────────────────────────────────────
function testeBarraInferior() {
  const src = ler('views/partials/_bottom-bar.handlebars');
  const html = render('views/partials/_bottom-bar.handlebars', { isAdmin: false, currentPath: '/condomino' });
  const htmlQuotas = render('views/partials/_bottom-bar.handlebars', { isAdmin: false, currentPath: '/condomino/recibos' });
  const htmlAdmin = render('views/partials/_bottom-bar.handlebars', { isAdmin: true, currentPath: '/admin' });

  for (const [rotulo, href] of [
    ['Início', '/condomino'],
    ['Quotas', '/condomino/quotas'],
    ['Documentos', '/condomino/documentos'],
    ['Avisos', '/condomino/avisos'],
  ]) {
    assert.ok(html.includes(`href="${href}"`), `barra: ${rotulo} acessível a um toque (${href})`);
    assert.ok(html.includes(`>${rotulo}<`), `barra: ${rotulo} com etiqueta visível`);
  }
  assert.ok(html.includes('mb-item-menu') && /aria-label="Abrir menu principal"/.test(html), 'barra: mantém o acesso ao menu lateral');
  assert.ok(!html.includes('>A minha área<') && !html.includes('>Condomínios<'),
    'barra: itens de contexto substituídos por áreas reais');
  assert.ok(/mb-item-ativo/.test(html) && /aria-current="page"/.test(htmlQuotas),
    'barra: a área atual fica assinalada (inclusive na área Quotas por inteiro)');
  assert.ok(htmlQuotas.includes('href="/condomino/quotas"') && /mb-item mb-item-ativo"[^>]*href="\/condomino\/quotas"/.test(htmlQuotas),
    'barra: pagamentos/recibos marcam a entrada Quotas');
  // A barra do backoffice não é afetada por esta alteração.
  assert.ok(htmlAdmin.includes('href="/admin"') && htmlAdmin.includes('href="/admin/quotas/recibos"') && htmlAdmin.includes('href="/admin/avisos"'),
    'barra: navegação do backoffice intacta');
  assert.ok(!/href="\/condomino/.test(htmlAdmin), 'barra: backoffice não recebe atalhos do portal');
  // Acessibilidade: ícones decorativos e rótulos (no ramo do condómino).
  const ramoCondomino = src.slice(src.indexOf('{{else}}'));
  for (const m of ramoCondomino.matchAll(/<span class="material-symbols-outlined"(?![^>]*aria-hidden)>/g)) {
    assert.fail(`barra: ícone do portal sem aria-hidden (offset ${m.index})`);
  }
  assert.ok((html.match(/mb-label/g) || []).length >= 5, 'barra: todos os itens com etiqueta de texto');
  assert.ok((ramoCondomino.match(/aria-label="/g) || []).length >= 5, 'barra: itens do portal com rótulo acessível');
}

// ── 2. Início ─────────────────────────────────────────────────────
const CONTEXTO = {
  user: { nome: 'Ana Silva' },
  condominio: { designacao: 'Condomínio Jardins do Tejo' },
  condominioAtivo: { id: 1, designacao: 'Condomínio Jardins do Tejo', role: 'leitura' },
  pessoa: { id: 10, nome: 'Ana Silva' },
  hoje: '2026-09-20',
  nFracoesProprias: 1,
  fracoesComResumo: [
    {
      id: 5, designacao: '1.º Esq', permilagem: '125.00',
      resumo: { emDivida: 75, quotasPagas: 8, quotasPendentes: 2, quotasVencidas: 1, ultimoPagamento: { valor: 75, data: '2026-08-05' } },
      // A próxima quota pertence à FRAÇÃO: a rota calcula-a por fração e o
      // cartão de cada fração só pode mostrar a sua (ver testeInicioMultiFraccao).
      proximaQuota: { valor: 75, data_vencimento: '2026-10-08', fracao_id: 5 },
      extrasPendentes: [{ designacao: 'Elevador', valor: 40, parcela: 2 }],
    },
  ],
  resumo: { saldoContas: 12480.5, fundoReserva: 3200, receitas: 9000, despesas: 7400, emDividaGlobal: 900 },
  orcamento: { ano: 2026, percentagem: 62, executado: 7400, orcamentado: 12000 },
  atividadeRecente: [
    { tipo: 'aviso', icone: 'campaign', titulo: 'Manutenção do elevador', detalhe: 'Na próxima terça-feira', data: '2026-09-18', link: '/condomino/avisos' },
    { tipo: 'documento', icone: 'description', titulo: 'Ata da assembleia', detalhe: 'Atas', data: '2026-09-10', link: '/condomino/documentos/3/ficheiro' },
    { tipo: 'recibo', icone: 'receipt_long', titulo: 'Recibo RCP-2026-0042', detalhe: '75,00 €', data: '2026-09-02', link: '/condomino/recibos' },
  ],
  proximosEventos: [
    { tipo: 'assembleia', icone: 'forum', titulo: 'Assembleia 2/2026', detalhe: '18:30 · Sala', data: '2026-11-12', link: '/condomino/assembleias/7' },
  ],
  titularidadesTerminadas: [],
};

function testeInicio() {
  const html = render('views/condomino/dashboard.handlebars', CONTEXTO);
  const seguido = html.replace(/\s+/g, ' ');

  // Identidade e resumo.
  assert.ok(seguido.includes('Olá, Ana Silva'), 'Início: saudação');
  assert.ok(seguido.includes('Condomínio Jardins do Tejo') && seguido.includes('1.º Esq') && seguido.includes('125.00'),
    'Início: topo identifica o condomínio e a fração (com permilagem)');
  assert.ok(seguido.includes('75,00 €'), 'Início: valor em dívida em destaque');
  assert.ok(/Quota em atraso/.test(seguido), 'Início: alerta de atraso quando há dívida');
  assert.ok(/Próxima quota:/.test(seguido) && seguido.includes('08/10/2026'), 'Início: próximo vencimento (dado real da quota)');
  assert.ok(/Último pagamento:/.test(seguido), 'Início: último pagamento');
  assert.ok(/Extraordinárias por pagar:/.test(seguido) && seguido.includes('Elevador'), 'Início: quotas extraordinárias pendentes');

  // Acesso rápido: as seis áreas reais, a um toque.
  assert.ok(/Acesso rápido/.test(html), 'Início: secção de acesso rápido');
  for (const [rotulo, href] of [
    ['Quotas', '/condomino/quotas'], ['Recibos', '/condomino/recibos'], ['Documentos', '/condomino/documentos'],
    ['Avisos', '/condomino/avisos'], ['Assembleias', '/condomino/assembleias'], ['Situação', '/condomino/situacao'],
  ]) {
    assert.ok(new RegExp(`href="${href}"[^>]*>\\s*<span class="material-symbols-outlined"[^>]*>[a-z_]+</span>${rotulo}<`).test(html),
      `Início: atalho rápido para ${rotulo}`);
  }

  // Atividade recente e próximos acontecimentos (dados reais).
  assert.ok(/Atividade recente/.test(html), 'Início: atividade recente');
  assert.ok(seguido.includes('Manutenção do elevador') && seguido.includes('Recibo RCP-2026-0042') && seguido.includes('Ata da assembleia'),
    'Início: avisos, recibos e documentos na atividade');
  assert.ok(/Próximos eventos/.test(html) && seguido.includes('Assembleia 2/2026'), 'Início: próximos eventos com assembleias');
  // Limite da lista: no máximo 5 itens (a rota corta antes de renderizar).
  const rotaAtividade = ler('routes/condomino.js');
  assert.ok(/const atividadeRecente = \[[\s\S]*?\.slice\(0, 5\)/.test(rotaAtividade),
    'Início: atividade recente limitada a 5 itens');
  assert.ok(!/\.slice\(0, 6\)/.test(rotaAtividade), 'Início: o limite antigo de 6 itens já não existe');

  // Transparência compacta (detalhe fica na área Condomínio).
  assert.ok(/O condomínio em resumo/.test(html), 'Início: transparência compacta');
  assert.ok(seguido.includes('Saldo das contas') && /Execução do orçamento 2026/.test(seguido), 'Início: saldo e execução do orçamento');
  assert.ok(/href="\/condomino\/situacao"/.test(html) && /href="\/condomino\/orcamento"/.test(html),
    'Início: ligação ao detalhe (Situação financeira e Orçamento)');

  // Cartão principal «A minha situação»: destaque, estado e ligação às quotas.
  assert.ok(/class="card portal-hero[^"]*"/.test(html), 'Início: cartão principal em destaque (A minha situação)');
  assert.ok(/portal-hero-valor/.test(html), 'Início: valor em destaque no cartão principal');
  assert.ok(/Quota em atraso/.test(seguido) && /portal-hero-divida/.test(html),
    'Início: com dívida, o cartão principal assume o estado de atraso');
  assert.ok(/Valores por regularizar/.test(seguido), 'Início: com dívida, texto de valores por regularizar');
  assert.ok(/href="\/condomino\/quotas"[^>]*>[\s\S]{0,200}?Consultar quotas/.test(html),
    'Início: com dívida, ligação para consultar as quotas');
  // Cada sub-linha do cartão usa dados reais da fração.
  assert.ok(/Último pagamento: <strong>75,00 €<\/strong> em 05\/08\/2026/.test(seguido), 'Início: último pagamento no cartão principal');
  assert.ok(/8 quota\(s\) paga\(s\) · 2 pendente\(s\)/.test(seguido), 'Início: quotas pagas e pendentes');

  // Acesso rápido: as seis sub-linhas vêm de dados que já existem.
  assert.strictEqual((html.match(/portal-atalho-meta/g) || []).length, 6, 'Início: seis atalhos com sub-linha informativa');
  assert.ok(/Em dívida/.test(seguido), 'Início: atalho Quotas indica o estado da dívida');

  // Ordem da página no telemóvel: identidade → situação → acesso → atividade → eventos → condomínio.
  const posicoes = ['Olá, Ana Silva', 'portal-hero', 'Acesso rápido', 'Atividade recente', 'Próximos eventos', 'O condomínio em resumo']
    .map((marca) => html.indexOf(marca));
  assert.ok(posicoes.every((p) => p > -1), 'Início: todas as secções presentes');
  assert.deepStrictEqual(posicoes, [...posicoes].sort((a, b) => a - b),
    'Início: sequência identidade → situação → acesso rápido → atividade → próximos eventos → condomínio');

  // Duas colunas a partir de 992px (mesma informação, reorganizada).
  assert.ok(/class="row g-3 portal-inicio"/.test(html) && /col-12 col-lg-7/.test(html) && /col-12 col-lg-5/.test(html),
    'Início: blocos em duas colunas no desktop');
  assert.ok(/class="portal-conteudo"/.test(html), 'Início: contentor limita a largura em ecrãs grandes');

  // Nada de duplicação: a situação por fração aparece uma só vez.
  assert.strictEqual((html.match(/portal-hero-valor/g) || []).length, 1, 'Início: um só cartão de situação por fração');

  // Fluxos já validados preservados.
  const semFracoes = render('views/condomino/dashboard.handlebars', {
    ...CONTEXTO,
    fracoesComResumo: [],
    atividadeRecente: [],
    proximosEventos: [],
    titularidadesTerminadas: [{ fracao: '1.º Esq', vinculo: 'proprietario', data_fim: '2026-06-30' }],
  });
  assert.ok(/Deixou de ser titular das frações/.test(semFracoes), 'Início: bloco de antigo titular preservado');
  assert.ok(/action="\/condomino\/saida\/exportar"/.test(semFracoes), 'Início: exportação da informação preservada');
  // O cartão de saída duplicado saiu do Início (a ação vive no perfil); o bloco
  // informativo de antigo titular mantém-se porque explica um estado.
  assert.ok(!/Deixou de ser titular destas frações\?/.test(html),
    'Início: cartão de saída redundante removido (ação disponível no perfil)');
  assert.ok(/href="\/condomino\/saida"/.test(ler('views/layouts/main.handlebars')),
    'Início: «Preparar saída do condomínio» continua acessível pelo perfil');
  // Alvos de toque dos atalhos: classe própria do portal (48px em qualquer
  // largura), sem alterar o painel de administração.
  const classesAtalho = [...html.matchAll(/class="quick-action([^"]*)"/g)].map((m) => m[1]);
  assert.strictEqual(classesAtalho.length, 6, 'Início: seis atalhos rápidos');
  assert.ok(classesAtalho.every((c) => c.includes('portal-atalho')), 'Início: atalhos com alvo de toque de 48px');
  assert.ok(/\.portal-atalho \{ min-height: 48px; \}/.test(ler('public/css/styles.css')),
    'CSS: 48px definidos só para os atalhos do portal (painel inalterado)');
  const semPessoa = render('views/condomino/dashboard.handlebars', { ...CONTEXTO, pessoa: null });
  assert.ok(/não está associada a um condómino/.test(semPessoa), 'Início: aviso de conta sem condómino associado');

  // Estrutura antiga substituída (sem listas soltas duplicadas).
  assert.ok(!/Avisos da administração/.test(html) && !/Documentos recentes/.test(html),
    'Início: listas soltas antigas substituídas por atividade recente');
  assert.ok((html.match(/<h1/g) || []).length === 1, 'Início: um só título principal');
}

// ── 2b. Próxima quota: uma por fração, nunca misturada ────────────
// Defeito corrigido: a rota escolhia UMA quota entre todas as frações e o cartão
// de cada fração mostrava essa mesma quota — com duas frações, o cartão da
// fração A podia anunciar a quota da fração B, repetida nos dois cartões.
function testeInicioMultiFraccao() {
  const html = render('views/condomino/dashboard.handlebars', {
    ...CONTEXTO,
    nFracoesProprias: 2,
    fracoesComResumo: [
      {
        id: 5, designacao: '1.º Esq', permilagem: '125.00',
        resumo: { emDivida: 0, quotasPagas: 10, quotasPendentes: 1, quotasVencidas: 0, ultimoPagamento: { valor: 75, data: '2026-08-05' } },
        proximaQuota: { valor: 75, data_vencimento: '2026-10-08', fracao_id: 5 },
        extrasPendentes: [],
      },
      {
        id: 6, designacao: '2.º Dto', permilagem: '95.00',
        resumo: { emDivida: 42.5, quotasPagas: 9, quotasPendentes: 2, quotasVencidas: 1, ultimoPagamento: { valor: 42.5, data: '2026-07-30' } },
        proximaQuota: { valor: 42.5, data_vencimento: '2026-11-15', fracao_id: 6 },
        extrasPendentes: [],
      },
    ],
  });
  const seguido = html.replace(/\s+/g, ' ');

  // Cada cartão anuncia a sua própria quota e a sua própria data.
  assert.ok(seguido.includes('Próxima quota: <strong>75,00 €</strong> até 08/10/2026'),
    'multi-fração: fração A mostra a próxima quota de A');
  assert.ok(seguido.includes('Próxima quota: <strong>42,50 €</strong> até 15/11/2026'),
    'multi-fração: fração B mostra a próxima quota de B');
  assert.strictEqual((seguido.match(/Próxima quota:/g) || []).length, 2,
    'multi-fração: uma linha de próxima quota por fração (sem repetir a mesma)');
  assert.strictEqual((seguido.match(/08\/10\/2026/g) || []).length, 1,
    'multi-fração: a data de A aparece só no cartão de A');
  assert.strictEqual((seguido.match(/15\/11\/2026/g) || []).length, 1,
    'multi-fração: a data de B aparece só no cartão de B');

  // Fração sem quota por vencer: o cartão dela diz isso, e não a quota da outra.
  const soUma = render('views/condomino/dashboard.handlebars', {
    ...CONTEXTO,
    fracoesComResumo: [
      { id: 5, designacao: '1.º Esq', permilagem: '125.00', resumo: { emDivida: 0, quotasPagas: 10, quotasPendentes: 0, quotasVencidas: 0, ultimoPagamento: null }, proximaQuota: null, extrasPendentes: [] },
      { id: 6, designacao: '2.º Dto', permilagem: '95.00', resumo: { emDivida: 0, quotasPagas: 9, quotasPendentes: 1, quotasVencidas: 0, ultimoPagamento: null }, proximaQuota: { valor: 42.5, data_vencimento: '2026-11-15', fracao_id: 6 }, extrasPendentes: [] },
    ],
  }).replace(/\s+/g, ' ');
  assert.ok(soUma.includes('Sem quotas por vencer registadas') && soUma.includes('Próxima quota: <strong>42,50 €</strong> até 15/11/2026'),
    'multi-fração: fração sem vencimento futuro não herda a quota da outra fração');

  // ── Estado normal (sem dívida) ────────────────────────────────────
  // Uma fração sem dívida e com próxima quota: «Tudo pago» + próximo vencimento.
  const semDivida = render('views/condomino/dashboard.handlebars', {
    ...CONTEXTO,
    fracoesComResumo: [{
      id: 5, designacao: '1.º Esq', permilagem: '125.00', vinculo: 'proprietario',
      resumo: { emDivida: 0, quotasPagas: 10, quotasPendentes: 1, quotasVencidas: 0, ultimoPagamento: { valor: 75, data: '2026-08-05' } },
      proximaQuota: { valor: 75, data_vencimento: '2026-10-08', fracao_id: 5 },
      extrasPendentes: [],
    }],
  }).replace(/\s+/g, ' ');
  assert.ok(/Tudo pago/.test(semDivida) && /portal-hero-ok/.test(semDivida),
    'situação normal: cartão principal mostra «Tudo pago»');
  assert.ok(/Nada a pagar/.test(semDivida), 'situação normal: rótulo do valor em dia');
  assert.ok(/Próxima quota: <strong>75,00 €<\/strong> até 08\/10\/2026/.test(semDivida),
    'situação normal: mostra a próxima quota e o vencimento');
  assert.ok(/href="\/condomino\/quotas"[^>]*>[\s\S]{0,200}?Ver quotas/.test(semDivida),
    'situação normal: ligação para as quotas');
  assert.ok(!/Quota em atraso/.test(semDivida) && !/Valores por regularizar/.test(semDivida),
    'situação normal: sem linguagem de dívida');

  // Sem quotas por vencer: diz-se, em vez de inventar uma próxima quota.
  const semProxima = render('views/condomino/dashboard.handlebars', {
    ...CONTEXTO,
    fracoesComResumo: [{
      id: 5, designacao: '1.º Esq', permilagem: '125.00',
      resumo: { emDivida: 0, quotasPagas: 12, quotasPendentes: 0, quotasVencidas: 0, ultimoPagamento: null },
      proximaQuota: null, extrasPendentes: [],
    }],
  }).replace(/\s+/g, ' ');
  assert.ok(/Sem quotas por vencer registadas/.test(semProxima), 'sem quotas por vencer: mensagem neutra');
  assert.ok(!/Próxima quota:/.test(semProxima), 'sem quotas por vencer: não inventa uma próxima quota');

  // ── Próximos eventos usam dados que já existem ────────────────────
  const comEventos = render('views/condomino/dashboard.handlebars', {
    ...CONTEXTO,
    proximosEventos: [
      { tipo: 'assembleia', icone: 'forum', titulo: 'Assembleia 2/2026', detalhe: '18:30 · Sala comum', data: '2026-11-12', link: '/condomino/assembleias/7' },
      { tipo: 'comunicacao', icone: 'schedule_send', titulo: 'Vistoria do gás', detalhe: 'Comunicação programada', data: '2026-11-20', link: '/condomino/avisos' },
    ],
  }).replace(/\s+/g, ' ');
  assert.ok(comEventos.includes('18:30 · Sala comum · 12/11/2026'),
    'próximos eventos: assembleia com hora e local');
  assert.ok(comEventos.includes('Comunicação programada · 20/11/2026'),
    'próximos eventos: aviso programado identificado como comunicação');
  assert.ok(/href="\/condomino\/assembleias\/7"/.test(comEventos) && /href="\/condomino\/avisos"/.test(comEventos),
    'próximos eventos: cada evento liga ao recurso existente');

  // Sem eventos: mensagem neutra, sem cartão vazio artificial.
  const semEventos = render('views/condomino/dashboard.handlebars', { ...CONTEXTO, proximosEventos: [] }).replace(/\s+/g, ' ');
  assert.ok(/Sem eventos agendados neste condomínio\./.test(semEventos), 'sem eventos: mensagem neutra');

  // A vista lê a quota DA FRAÇÃO: não pode voltar a existir uma quota global.
  const vista = ler('views/condomino/dashboard.handlebars');
  assert.ok(!/\.\.\/proximaQuota/.test(vista), 'Início: a vista não usa uma próxima quota global (fora do cartão da fração)');
  const rota = ler('routes/condomino.js');
  assert.ok(/const proximaQuota = await Quota\.findOne\(\{[\s\S]{0,400}fracao_id: f\.id/.test(rota),
    'Início: a próxima quota é consultada por fração (fracao_id: f.id)');
  assert.ok(!/fracao_id: \{ \[Op\.in\]: ids \}[\s\S]{0,200}data_vencimento: \{ \[Op\.gte\]: hoje \}/.test(rota),
    'Início: deixou de existir a consulta de próxima quota para todas as frações ao mesmo tempo');
  // O filtro «por vencer» não pode incluir uma data no passado (uma quota
  // vencida é atraso/dívida, contabilizada no resumo da fração).
  assert.ok(/data_vencimento: \{ \[Op\.gte\]: hoje \}/.test(rota),
    'Início: próxima quota continua a ser «por vencer» (data futura)');
}

// ── 3. Área Quotas com separadores ────────────────────────────────
function testeAreaQuotas() {
  const tabs = ler('views/partials/_condomino-quotas-tabs.handlebars');
  for (const href of ['/condomino/quotas', '/condomino/pagamentos', '/condomino/recibos']) {
    assert.ok(tabs.includes(`href="${href}"`), `separadores: ${href} presente`);
  }
  for (const [vista, ativo] of [['quotas', 'quotas'], ['pagamentos', 'pagamentos'], ['recibos', 'recibos']]) {
    const src = ler(`views/condomino/${vista}.handlebars`);
    assert.ok(src.startsWith(`{{> _condomino-quotas-tabs ativo='${ativo}'}}`),
      `separadores: ${vista}.handlebars abre com os separadores (ativo=${ativo})`);
  }
  const html = render('views/partials/_condomino-quotas-tabs.handlebars', { ativo: 'pagamentos' });
  assert.strictEqual((html.match(/aria-current="page"/g) || []).length, 1, 'separadores: só o ativo é assinalado');
  assert.ok(/class="quotas-tab active"[^>]*href="\/condomino\/pagamentos"/.test(html), 'separadores: marca visual no ativo');
}

// ── 3b. Página de Quotas: situação, estados e multi-fração ────────
// Reproduz a derivação de estado que a rota faz para cada linha (a partir do
// valor pago confirmado que já calculou) e verifica o que a vista apresenta.
const HOJE = '2026-09-20';
function linhasDaRota(quotas, pagoPorQuota) {
  return quotas.map((q) => {
    const l = { ...q, pago: pagoPorQuota[q.id] || 0 };
    let estadoApresentado;
    if (l.estado === 'anulada') estadoApresentado = 'anulada';
    else if (l.estado === 'paga') estadoApresentado = 'paga';
    else {
      const pagoC = Math.round((Number(l.pago) || 0) * 100);
      const valorC = Math.round((Number(l.valor) || 0) * 100);
      const venceu = Boolean(l.data_vencimento) && String(l.data_vencimento).slice(0, 10) < HOJE;
      if (valorC > 0 && pagoC >= valorC) estadoApresentado = 'paga';
      else if (pagoC > 0) estadoApresentado = 'parcialmente_paga';
      else if (venceu) estadoApresentado = 'vencida';
      else estadoApresentado = 'pendente';
    }
    return { ...l, estadoApresentado, mesNome: MESES[l.mes - 1] };
  });
}
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Resumo por fração, tal como a rota o constrói sobre as linhas carregadas.
function resumoDaRota(linhas) {
  const mapa = new Map();
  linhas.forEach((l) => {
    if (!mapa.has(l.fracao_id)) {
      mapa.set(l.fracao_id, { fracao_id: l.fracao_id, designacao: l.fracaoDesignacao, pagas: 0, parciais: 0, vencidas: 0, pendentes: 0, anuladas: 0, total: 0, pago: 0, proximaQuota: null });
    }
    const g = mapa.get(l.fracao_id);
    g.total += Number(l.valor) || 0;
    g.pago += Number(l.pago) || 0;
    if (l.estadoApresentado === 'paga') g.pagas += 1;
    else if (l.estadoApresentado === 'parcialmente_paga') g.parciais += 1;
    else if (l.estadoApresentado === 'vencida') g.vencidas += 1;
    else if (l.estadoApresentado === 'anulada') g.anuladas += 1;
    else g.pendentes += 1;
    if (l.estadoApresentado !== 'paga' && l.estadoApresentado !== 'anulada' && l.data_vencimento) {
      const venc = String(l.data_vencimento).slice(0, 10);
      if (venc >= HOJE && (!g.proximaQuota || venc < g.proximaQuota.data_vencimento)) {
        g.proximaQuota = { valor: l.valor, data_vencimento: venc, mes: l.mes, ano: l.ano };
      }
    }
  });
  return [...mapa.values()];
}
const paginaQuotas = (quotas, pagoPorQuota, extras = []) => {
  const linhas = linhasDaRota(quotas, pagoPorQuota);
  const resumoAno = resumoDaRota(linhas);
  return render('views/condomino/quotas.handlebars', {
    pessoa: { id: 10 }, linhas, extras, resumoAno, hoje: HOJE,
    currentYear: 2026, currentMonth: 9, temVariasFracoes: resumoAno.length > 1,
    filtros: { ano: '', estado: '' }, anos: [2026],
  }).replace(/\s+/g, ' ');
};

function testePaginaQuotas() {
  // ── Estado normal: tudo pago, com próxima quota ───────────────────
  // Nesta fixture as quotas do ano estão pagas (total pago = total), mas existe
  // uma quota futura por vencer: o emblema não pode dizer «Tudo pago» — seria
  // contraditório com a próxima quota apresentada ao lado.
  const normais = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 8, valor: 75, data_vencimento: '2026-08-10', estado: 'paga' },
    { id: 2, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 10, valor: 75, data_vencimento: '2026-10-10', estado: 'pendente' },
  ], { 1: 75 });
  assert.ok(/Valores por regularizar/.test(normais) && !/Tudo pago/.test(normais),
    'quotas: com uma quota futura por pagar não diz «Tudo pago»');
  assert.ok(/portal-hero-ok/.test(normais), 'quotas: cartão da fração sem atraso');
  assert.ok(/Próxima quota: <strong>75,00 €<\/strong> até 10\/10\/2026/.test(normais),
    'quotas: mostra a próxima quota da própria fração');
  assert.ok(/1 paga\(s\) · 1 pendente\(s\)/.test(normais), 'quotas: resumo anual conta pagas e pendentes');
  assert.ok(/75,00 € de 150,00 € no ano/.test(normais), 'quotas: total pago e total do ano');
  assert.ok(/Fração 1\.º Esq/.test(normais), 'quotas: o resumo identifica a fração');

  // ── Tudo pago: nenhuma quota do ano por pagar ─────────────────────
  const tudoPago = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 8, valor: 75, data_vencimento: '2026-08-10', estado: 'paga' },
    { id: 2, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 9, valor: 75, data_vencimento: '2026-09-10', estado: 'paga' },
  ], { 1: 75, 2: 75 });
  assert.ok(/Tudo pago/.test(tudoPago), 'tudo pago: emblema correto quando nada está por pagar');
  assert.ok(/150,00 € de 150,00 € no ano/.test(tudoPago), 'tudo pago: total pago igual ao total do ano');
  assert.ok(/Sem quotas por vencer registadas/.test(tudoPago),
    'tudo pago: diz que não há quotas por vencer em vez de inventar uma');
  assert.ok(/2 paga\(s\) · 0 pendente\(s\)/.test(tudoPago), 'tudo pago: contagem só de pagas');

  // ── Dívida: quota vencida e sem pagamento ─────────────────────────
  const divida = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 7, valor: 100, data_vencimento: '2026-07-10', estado: 'pendente' },
    { id: 2, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 10, valor: 75, data_vencimento: '2026-10-10', estado: 'pendente' },
  ], {});
  assert.ok(/1 quota\(s\) em atraso/.test(divida), 'quotas: assinala as quotas em atraso');
  assert.ok(/portal-hero-divida/.test(divida), 'quotas: cartão da fração assume o estado de atraso');
  assert.ok(/Vencida/.test(divida) && /badge text-bg-danger">Vencida/.test(divida),
    'quotas: a quota vencida mostra o emblema «Vencida»');
  assert.ok(/0 paga\(s\) · 1 pendente\(s\) · 1 em atraso/.test(divida),
    'quotas: contagem correta (atraso separado dos pendentes)');

  // ── Parcialmente paga: 100 € de quota, 50 € pagos, vencimento passado ──
  const parcial = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 6, valor: 100, data_vencimento: '2026-06-10', estado: 'parcialmente_paga' },
  ], { 1: 50 });
  assert.ok(/badge text-bg-info">Parcialmente paga/.test(parcial),
    'parcial: uma quota paga em parte aparece como «Parcialmente paga»');
  assert.ok(!/badge text-bg-danger">Vencida/.test(parcial),
    'parcial: NÃO é apresentada como «Vencida» apesar do vencimento ultrapassado');
  assert.ok(/Pago 50,00 €/.test(parcial), 'parcial: mostra o valor já pago');
  assert.ok(/1 parcialmente paga\(s\)/.test(parcial), 'parcial: contada à parte no resumo anual');

  // O estado derivado nunca contradiz os valores pagos.
  const casos = linhasDaRota([
    { id: 1, valor: 100, data_vencimento: '2026-01-10', estado: 'pendente' },      // 0 pago, vencida
    { id: 2, valor: 100, data_vencimento: '2026-01-10', estado: 'pendente' },      // 50 pago, vencida
    { id: 3, valor: 100, data_vencimento: '2026-12-10', estado: 'pendente' },      // 0 pago, futura
    { id: 4, valor: 100, data_vencimento: '2026-01-10', estado: 'pendente' },      // 100 pago
    { id: 5, valor: 100, data_vencimento: '2026-01-10', estado: 'anulada' },       // anulada
  ], { 2: 50, 4: 100 });
  assert.deepStrictEqual(casos.map((c) => c.estadoApresentado),
    ['vencida', 'parcialmente_paga', 'pendente', 'paga', 'anulada'],
    'estados: paga / parcialmente paga / vencida / pendente / anulada, pela ordem certa');

  // ── Quotas anuladas: nunca viram «Pendente» ───────────────────────
  const comAnulada = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 5, valor: 75, data_vencimento: '2026-05-10', estado: 'anulada' },
    { id: 2, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 6, valor: 75, data_vencimento: '2026-06-10', estado: 'paga' },
  ], { 2: 75 });
  assert.ok(/badge text-bg-secondary">Anulada/.test(comAnulada), 'anuladas: apresentadas como «Anulada»');
  assert.ok(/1 anulada\(s\)/.test(comAnulada), 'anuladas: contadas à parte, nunca como pendentes');
  assert.ok(!/badge text-bg-warning">Pendente/.test(comAnulada), 'anuladas: nenhuma é apresentada como «Pendente»');

  // ── Várias frações: um resumo por fração, sem misturar valores ────
  const multi = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 9, valor: 75, data_vencimento: '2026-09-10', estado: 'paga' },
    { id: 2, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 10, valor: 75, data_vencimento: '2026-10-10', estado: 'pendente' },
    { id: 3, fracao_id: 6, fracaoDesignacao: '2.º Dto', ano: 2026, mes: 9, valor: 42.5, data_vencimento: '2026-09-05', estado: 'pendente' },
    { id: 4, fracao_id: 6, fracaoDesignacao: '2.º Dto', ano: 2026, mes: 11, valor: 42.5, data_vencimento: '2026-11-05', estado: 'pendente' },
  ], { 1: 75 });
  assert.strictEqual((multi.match(/portal-hero-valor/g) || []).length, 2,
    'multi-fração: um cartão de resumo por fração');
  assert.ok(/Fração 1\.º Esq/.test(multi) && /Fração 2\.º Dto/.test(multi),
    'multi-fração: cada resumo identifica a sua fração');
  assert.ok(/75,00 € de 150,00 € no ano/.test(multi), 'multi-fração: totais da fração A');
  assert.ok(/0,00 € de 85,00 € no ano/.test(multi), 'multi-fração: totais da fração C (2 × 42,50 €, nada pago)');
  assert.ok(!/117,50 € de 235,00 €/.test(multi),
    'multi-fração: nenhum agregado que junte as duas frações');
  assert.ok(/Próxima quota: <strong>75,00 €<\/strong> até 10\/10\/2026/.test(multi),
    'multi-fração: próxima quota da fração A');
  assert.ok(/Próxima quota: <strong>42,50 €<\/strong> até 05\/11\/2026/.test(multi),
    'multi-fração: próxima quota da fração C');
  assert.strictEqual((multi.match(/Próxima quota:/g) || []).length, 2,
    'multi-fração: uma próxima quota por fração, sem repetir');
  assert.ok(/· 1\.º Esq/.test(multi) && /· 2\.º Dto/.test(multi),
    'multi-fração: a fração é identificada em cada linha do ano');

  // ── Sem quotas por vencer: mensagem neutra, sem inventar valores ──
  const semProxima = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 1, valor: 75, data_vencimento: '2026-01-10', estado: 'paga' },
  ], { 1: 75 });
  assert.ok(/Sem quotas por vencer registadas/.test(semProxima), 'sem vencimento: mensagem neutra');
  assert.ok(!/Próxima quota:/.test(semProxima), 'sem vencimento: não inventa uma próxima quota');
  assert.ok(/Tudo pago/.test(semProxima), 'sem vencimento e sem atraso: «Tudo pago»');

  // ── Página sem quotas ─────────────────────────────────────────────
  const vazia = paginaQuotas([], {});
  assert.ok(/Ainda não existem quotas registadas/.test(vazia), 'sem quotas: mensagem neutra');
  assert.ok(!/portal-hero/.test(vazia), 'sem quotas: nenhum cartão de situação inventado');

  // ── Extraordinárias: separadas das quotas normais ─────────────────
  const comExtras = paginaQuotas(
    [{ id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 9, valor: 75, data_vencimento: '2026-09-10', estado: 'paga' }],
    { 1: 75 },
    [{ id: 9, designacao: 'Elevador', fracaoDesignacao: '1.º Esq', parcela_numero: 2, valor: 40, vencimento: '2026-10-01', estado: 'cobrada', estadoLabel: 'Em cobrança', extraEstado: 'processada', valorPago: 0 }],
  );
  assert.ok(/Quotas extraordinárias/.test(comExtras), 'extras: secção própria mantida');
  assert.ok(/Elevador/.test(comExtras) && /Parcela 2/.test(comExtras),
    'extras: designação e parcela apresentadas');
  assert.ok(/badge text-bg-info">Em cobrança/.test(comExtras), 'extras: estado apresentado em linguagem clara');
}

// ── 4. Cabeçalho do portal ────────────────────────────────────────
function testeCabecalho() {
  const layout = ler('views/layouts/main.handlebars');
  assert.ok(/\{\{#if isAdmin\}\}[\s\S]{0,400}title="Notificações"[\s\S]{0,600}\{\{else\}\}[\s\S]{0,400}href="\/condomino\/avisos"/.test(layout),
    'cabeçalho: área do condómino tem atalho real para os avisos (backoffice mantém o seu)');
  assert.ok(/icon-badge/.test(layout) && /\{\{#if avisosRecentes\}\}/.test(layout), 'cabeçalho: contagem de avisos recentes quando existe');
  assert.ok(/aria-label="Avisos do condomínio/.test(layout), 'cabeçalho: atalho descrito para leitores de ecrã');
  assert.ok(/\{\{#unless isAdmin\}\}\s*<li><a class="dropdown-item" href="\/condomino\/saida">/.test(layout),
    'cabeçalho: «Preparar saída do condomínio» no perfil, apenas para condóminos');
  assert.ok(/href="\/conta\/seguranca"/.test(layout) && /href="\/logout"/.test(layout), 'cabeçalho: perfil mantém segurança e sair');

  const app = ler('app.js');
  assert.ok(/res\.locals\.avisosRecentes = 0;/.test(app), 'app: contagem inicializada para todas as páginas');
  assert.ok(/if \(req\.user && res\.locals\.condominioAtivo && !res\.locals\.isAdmin\)/.test(app),
    'app: contagem calculada apenas na área do condómino');
  assert.ok(/Aviso\.count\(\{[\s\S]{0,200}createdAt: \{ \[Op\.gte\]: desde \}/.test(app),
    'app: conta avisos recentes com um critério factual (sem inventar «lido/não lido»)');
  // Invariante real: nenhum modelo ganhou estado de leitura (não existe no sistema).
  const modelos = require('../models');
  for (const [nome, M] of Object.entries(modelos)) {
    if (!M || !M.rawAttributes) continue;
    assert.ok(!M.rawAttributes.lido && !M.rawAttributes.nao_lido,
      `models: ${nome} não tem estado de leitura inventado`);
  }
}

// ── 5. Integridade do portal ──────────────────────────────────────
function testeIntegridade() {
  const rota = ler('routes/condomino.js');
  // Nenhuma rota do portal foi removida.
  for (const caminho of ['/', '/quotas', '/pagamentos', '/recibos', '/recibos/:id/pdf', '/assembleias', '/assembleias/:id',
    '/avisos', '/calendario', '/documentos', '/documentos/:id/ficheiro', '/orcamento', '/situacao']) {
    assert.ok(rota.includes(`router.get('${caminho}'`), `portal: rota preservada ${caminho}`);
  }
  // Continua só de leitura (nenhuma escrita no portal).
  assert.ok(!/\.(create|update|destroy)\(/.test(rota), 'portal: só de leitura (nenhuma escrita)');
  // Autorização e isolamento intactos.
  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(rota), 'portal: condomínio ativo obrigatório');
  assert.ok(rota.includes('condominio_id: req.condominioId'), 'portal: consultas filtradas pelo condomínio ativo');
  assert.ok(rota.includes('fracao_id: { [Op.in]:'), 'portal: dados limitados às frações do próprio');
  // O Início usa apenas dados existentes (sem campos inventados).
  for (const modelo of ['Quota', 'Aviso', 'Documento', 'Recibo', 'Assembleia']) {
    assert.ok(new RegExp(`${modelo}\\.find`).test(rota), `portal: Início usa ${modelo} (dados reais)`);
  }
  assert.ok(/resumoFracao\(/.test(rota) && /resumoCondominio\(/.test(rota), 'portal: resumos existentes reutilizados');
  // As vistas do portal continuam a existir todas.
  for (const vista of ['dashboard', 'quotas', 'pagamentos', 'recibos', 'documentos', 'assembleias', 'assembleia', 'avisos',
    'calendario', 'orcamento', 'situacao', 'saida-condominio', 'saida-condominio-confirmar']) {
    assert.ok(fs.existsSync(path.join(RAIZ, 'views', 'condomino', `${vista}.handlebars`)), `portal: vista preservada ${vista}`);
  }
  // Mockup da homepage coerente com a barra real.
  const mockup = ler('views/partials/_home-mock-mobile.handlebars');
  for (const item of ['Início', 'Quotas', 'Documentos', 'Avisos']) {
    assert.ok(new RegExp(`>${item}<`).test(mockup), `mockup: barra inferior inclui ${item}`);
  }
  assert.ok(!/>Pagamentos</.test(mockup), 'mockup: barra já não mostra “Pagamentos” como item próprio (passou a área com separadores)');
  assert.ok(/portal do condómino/.test(mockup), 'mockup: descrição acessível mantida');

  // Sidebar do desktop espelha a navegação do telemóvel (mesma hierarquia).
  const layout = ler('views/layouts/main.handlebars');
  const ramoSidebar = layout.slice(layout.indexOf('sidebar-group-title">Início'), layout.indexOf('{{/if}}\n      </nav>'));
  assert.ok(/sidebar-group-title">Início</.test(ramoSidebar), 'sidebar: grupo Início');
  assert.ok(/sidebar-group-title">A minha fração</.test(ramoSidebar), 'sidebar: grupo A minha fração');
  assert.ok(/sidebar-group-title">Condomínio</.test(ramoSidebar), 'sidebar: grupo Condomínio');
  assert.ok(/href="\/condomino\/quotas"[\s\S]{0,300}href="\/condomino\/recibos"/.test(ramoSidebar),
    'sidebar: Quotas antes de Recibos (área financeira agrupada)');
  assert.ok(!/href="\/condomino\/pagamentos"/.test(ramoSidebar),
    'sidebar: Pagamentos deixa de ser item próprio (passa a separador da área Quotas)');
  assert.ok(/href="\/condomino\/situacao"/.test(ramoSidebar) && !/href="\/condomino\/orcamento"/.test(ramoSidebar),
    'sidebar: Orçamento acede-se pelo Início e pela Situação financeira');
  assert.ok(/href="\/condomino\/orcamento"/.test(ler('views/condomino/situacao.handlebars')),
    'situação financeira: ligação ao orçamento (sem becos sem saída na navegação)');
  // Nenhuma migration/modelo foi tocado por esta alteração (só apresentação).
  assert.ok(!/migrations\//.test(rota) && !/sequelize\.define/.test(rota), 'portal: sem novos modelos ou migrations');
}

testeBarraInferior();
testeInicio();
testeInicioMultiFraccao();
testeAreaQuotas();
testePaginaQuotas();
testeCabecalho();
testeIntegridade();
console.log('✓ Testes da área do condómino passaram (mobile-first, sem base de dados).');
