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

  // Ações rápidas: as seis áreas reais, a um toque.
  assert.ok(/Ações rápidas/.test(html), 'Início: secção de ações rápidas');
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
  assert.ok(/Próximos acontecimentos/.test(html) && seguido.includes('Assembleia 2/2026'), 'Início: próximos acontecimentos com assembleias');

  // Transparência compacta (detalhe fica na área Condomínio).
  assert.ok(/O condomínio em resumo/.test(html), 'Início: transparência compacta');
  assert.ok(seguido.includes('Saldo das contas') && /Execução do orçamento 2026/.test(seguido), 'Início: saldo e execução do orçamento');
  assert.ok(/href="\/condomino\/situacao"/.test(html) && /href="\/condomino\/orcamento"/.test(html),
    'Início: ligação ao detalhe (Situação financeira e Orçamento)');

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
testeCabecalho();
testeIntegridade();
console.log('✓ Testes da área do condómino passaram (mobile-first, sem base de dados).');
