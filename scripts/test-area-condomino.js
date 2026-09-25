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

// Procura, no CÓDIGO do projeto (routes/, helpers/, views/, scripts/ — nunca em
// node_modules, docs/ ou .workbuddy-ai/), referências a um alvo. O alvo pode ser
// uma string literal (`situacao.handlebars`) ou uma RegExp (nome nu da vista).
// Serve para provar que não ficou nenhuma referência morta depois de remover
// código — uma simples lista de vistas não deteta isto.
function varrerReferencias(alvo) {
  const re = alvo instanceof RegExp ? alvo : new RegExp(alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const raizes = ['routes', 'helpers', 'views', 'scripts'];
  const encontradas = [];
  const percorrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const caminho = path.join(dir, entrada.name);
      if (entrada.isDirectory()) { percorrer(caminho); continue; }
      if (!/\.(js|handlebars)$/.test(entrada.name)) continue;
      const rel = path.relative(RAIZ, caminho).replace(/\\/g, '/');
      // O próprio teste referencia o nome (é isso que o deteta): não conta.
      if (rel === 'scripts/test-area-condomino.js') continue;
      const linhas = fs.readFileSync(caminho, 'utf8').split(/\r?\n/);
      linhas.forEach((linha, i) => {
        if (re.test(linha)) encontradas.push(`${rel}:${i + 1}`);
      });
    }
  };
  for (const raiz of raizes) {
    const p = path.join(RAIZ, raiz);
    if (fs.existsSync(p)) percorrer(p);
  }
  return encontradas;
}

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
    ['Avisos', '/condomino/avisos'], ['Assembleias', '/condomino/assembleias'], ['Situação', '/condomino/situacao-financeira'],
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
  assert.ok(/href="\/condomino\/situacao-financeira"/.test(html) && /href="\/condomino\/orcamento"/.test(html),
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
  // O valor passou a vir do token A7 `--ctl-h-touch` (48px): a asserção aceita
  // as duas formas e confirma que o token vale mesmo 48px.
  const cssApp = ler('public/css/styles.css');
  assert.ok(/--ctl-h-touch: 48px;/.test(cssApp), 'CSS: o token --ctl-h-touch vale 48px');
  assert.ok(/\.portal-atalho \{ min-height: (48px|var\(--ctl-h-touch\)); \}/.test(cssApp),
    'CSS: 48px definidos só para os atalhos do portal (painel inalterado)');
  // ⛔ O painel NÃO pode herdar os 48px do portal. Antes isto era IMPLÍCITO (o
  // `48px` só existia no `.portal-atalho`); passa a ser asserido diretamente,
  // para que aplicar o token ao `.quick-action` deixe de passar em silêncio.
  const corpoQuickAction = /\.quick-action \{([^}]*)\}/.exec(cssApp);
  assert.ok(corpoQuickAction, 'CSS: existe a definição canónica de .quick-action');
  assert.ok(/min-height: var\(--ctl-h\);/.test(corpoQuickAction[1]),
    'CSS: o painel mantém-se em 36px (--ctl-h), não nos 48px do portal');
  // A vista decide pelo estado de associação (D3). Sem `acesso` nem pessoa, a
  // mensagem é a histórica de «conta sem condómino».
  const semPessoa = render('views/condomino/dashboard.handlebars', { ...CONTEXTO, pessoa: null, registroSemCondomino: true });
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
  assert.ok(/Vencida/.test(divida) && /class="estado estado-erro">Vencida/.test(divida),
    'quotas: a quota vencida mostra o emblema «Vencida» na linguagem de estado única (A14 §8)');
  assert.ok(/0 paga\(s\) · 1 pendente\(s\) · 1 em atraso/.test(divida),
    'quotas: contagem correta (atraso separado dos pendentes)');

  // ── Parcialmente paga: 100 € de quota, 50 € pagos, vencimento passado ──
  const parcial = paginaQuotas([
    { id: 1, fracao_id: 5, fracaoDesignacao: '1.º Esq', ano: 2026, mes: 6, valor: 100, data_vencimento: '2026-06-10', estado: 'parcialmente_paga' },
  ], { 1: 50 });
  assert.ok(/class="estado estado-recomendado">Parcialmente paga/.test(parcial),
    'parcial: uma quota paga em parte aparece como «Parcialmente paga»');
  assert.ok(!/class="estado estado-erro">Vencida/.test(parcial),
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
  assert.ok(/class="estado estado-neutro">Anulada/.test(comAnulada), 'anuladas: apresentadas como «Anulada»');
  assert.ok(/1 anulada\(s\)/.test(comAnulada), 'anuladas: contadas à parte, nunca como pendentes');
  assert.ok(!/class="estado estado-requer-config">Pendente/.test(comAnulada), 'anuladas: nenhuma é apresentada como «Pendente»');

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
  assert.ok(/class="estado estado-recomendado">Em cobrança/.test(comExtras), 'extras: estado apresentado em linguagem clara');
}

// ── 3c. Recibos: cartões, multi-fração e PDF ──────────────────────
const baseRecibos = { pessoa: { id: 10 }, titulo: 'Os meus recibos' };
const paginaRecibos = (linhas, opts = {}) => render('views/condomino/recibos.handlebars', {
  ...baseRecibos, linhas, nRecibos: linhas.length,
  temVariasFracoes: Boolean(opts.temVariasFracoes),
}).replace(/\s+/g, ' ');

function testePaginaRecibos() {
  const um = paginaRecibos([
    { id: 21, codigo: '2026/000121', data_emissao: '2026-08-21', valor: 48.5, estado: 'emitido', periodos: 'Novembro 2026', fracaoDesignacao: '1.º Esq', temExtras: false },
    { id: 22, codigo: '2026/000122', data_emissao: '2026-09-21', valor: 165, estado: 'emitido', periodos: 'Impermeabilização', fracaoDesignacao: '1.º Esq', temExtras: true },
  ]);

  // Identificável sem abrir o PDF.
  assert.ok(/Recibo 2026\/000121/.test(um) && /Recibo 2026\/000122/.test(um), 'recibos: número visível em cada recibo');
  assert.ok(/Emitido 21\/08\/2026/.test(um), 'recibos: data de emissão visível');
  assert.ok(/48,50 €/.test(um) && /165,00 €/.test(um), 'recibos: valor visível');
  assert.ok(/Novembro 2026/.test(um), 'recibos: período a que respeita');
  assert.ok(/class="estado estado-concluido">Emitido/.test(um), 'recibos: estado apresentado');
  assert.ok(/Inclui quota extraordinária/.test(um), 'recibos: assinala o recibo de quota extraordinária');
  // Acesso ao PDF como CTA, para o recurso protegido.
  assert.strictEqual((um.match(/href="\/condomino\/recibos\/\d+\/pdf"/g) || []).length, 4,
    'recibos: acesso ao PDF em cartão e tabela (2 recibos × 2 apresentações)');
  assert.ok(/class="btn btn-primary portal-btn" href="\/condomino\/recibos\/21\/pdf"/.test(um),
    'recibos: CTA principal para o PDF no mobile');
  // Cartões no mobile, tabela no desktop: as duas apresentações existem.
  assert.ok(/portal-quota-lista/.test(um) && /portal-quota-tabela/.test(um),
    'recibos: lista (mobile) e tabela (desktop) na mesma página');
  assert.ok(/<h1>Os meus recibos<\/h1>/.test(um), 'recibos: título próprio');

  // Uma só fração: a designação não se repete em cada recibo.
  assert.ok(!/Recibo 2026\/000121 · /.test(um), 'uma fração: não repete a designação em cada recibo');
  assert.ok(!/<th[^>]*>Fração<\/th>/.test(um), 'uma fração: a tabela não tem coluna de fração');

  // Várias frações: a fração aparece em cada recibo e na tabela.
  const multi = paginaRecibos([
    { id: 31, codigo: '2026/000201', data_emissao: '2026-08-01', valor: 75, estado: 'emitido', periodos: 'Agosto 2026', fracaoDesignacao: '1.º Esq', temExtras: false },
    { id: 32, codigo: '2026/000202', data_emissao: '2026-08-05', valor: 42.5, estado: 'emitido', periodos: 'Agosto 2026', fracaoDesignacao: '2.º Dto', temExtras: false },
  ], { temVariasFracoes: true });
  assert.ok(/Recibo 2026\/000201 · 1\.º Esq/.test(multi) && /Recibo 2026\/000202 · 2\.º Dto/.test(multi),
    'multi-fração: cada recibo identifica a sua fração');
  assert.ok(/<th[^>]*>Fração<\/th>/.test(multi), 'multi-fração: a tabela mostra a coluna de fração');
  assert.ok(/1\.º Esq/.test(multi) && /2\.º Dto/.test(multi), 'multi-fração: as duas frações identificadas');

  // Recibo anulado: estado próprio, não «Emitido» nem mensagem de erro.
  const anulado = paginaRecibos([
    { id: 41, codigo: '2026/000301', data_emissao: '2026-07-01', valor: 75, estado: 'anulado', periodos: 'Julho 2026', fracaoDesignacao: '1.º Esq', temExtras: false },
  ]);
  assert.ok(/class="estado estado-neutro">Anulado/.test(anulado), 'recibos: recibo anulado assinalado como tal');
  assert.ok(!/class="estado estado-concluido">Emitido/.test(anulado), 'recibos: anulado não é apresentado como emitido');

  // Sem recibos: mensagem neutra, sem sugerir problema.
  const vazio = paginaRecibos([]);
  assert.ok(/Ainda não tem recibos emitidos/.test(vazio), 'sem recibos: mensagem neutra');
  assert.ok(!/portal-quota-lista|<table/.test(vazio), 'sem recibos: nenhum cartão nem tabela vazios');
  assert.ok(!/erro|problema|falha/i.test(vazio), 'sem recibos: não sugere erro');
}

// ── 3d. Documentos: cartões, filtros por ano e estado vazio ──────
const baseDocs = { pessoa: { id: 10 }, titulo: 'Documentos do condomínio', pastas: { atas: 'Atas', convocatorias: 'Convocatórias' } };
const doc = (over) => ({
  id: 9, nome: 'Ata da assembleia.pdf', pasta: 'atas', pastaRotulo: 'Atas', tipo: 'ata', tipoRotulo: 'Ata',
  data: '2026-08-20', ano: '2026', drive_file_id: 'F9', url: null, disponivel_condominos: true, ...over,
});
const paginaDocs = (ctx) => render('views/condomino/documentos.handlebars', { ...baseDocs, anos: [], anoFiltro: null, nDocumentos: 0, documentos: null, agrupados: null, ...ctx }).replace(/\s+/g, ' ');

function testePaginaDocumentos() {
  // Com dados, agrupados por categoria.
  const comDados = paginaDocs({
    agrupados: [
      { rotulo: 'Atas', itens: [doc()] },
      { rotulo: 'Convocatórias', itens: [doc({ id: 8, nome: 'Convocatória 2026.pdf', pasta: 'convocatorias', pastaRotulo: 'Convocatórias', tipo: 'convocatoria', tipoRotulo: 'Convocatória', data: '2026-07-30' })] },
    ],
    anos: ['2026'], nDocumentos: 2,
  });
  assert.ok(/<h1>Documentos<\/h1>/.test(comDados), 'documentos: cabeçalho claro');
  assert.ok(/Ata da assembleia\.pdf/.test(comDados) && /Convocatória 2026\.pdf/.test(comDados),
    'documentos: nome de cada documento');
  assert.ok(/Atas/.test(comDados) && /Convocatórias/.test(comDados), 'documentos: categoria visível');
  assert.ok(/20\/08\/2026/.test(comDados), 'documentos: data visível');
  assert.ok(/documento\(s\)/.test(comDados), 'documentos: contagem apresentada');
  // Acesso pelo recurso protegido do GesCondu (rota interna), nunca link do fornecedor.
  assert.ok(/href="\/condomino\/documentos\/9\/ficheiro"/.test(comDados),
    'documentos: acesso pela rota interna autenticada');
  assert.ok(!/drive\.google|dropbox|1drv/.test(comDados), 'documentos: sem links diretos ao armazenamento');
  assert.ok(/portal-doc-lista/.test(comDados), 'documentos: cartões (lista) no mobile');
  assert.ok(/portal-chip/.test(comDados), 'documentos: filtros em chips');

  // Filtro por ano: o ano ativo fica assinalado.
  const comAno = paginaDocs({
    documentos: [doc()], anoFiltro: '2026', anos: ['2026', '2025'], nDocumentos: 1,
  });
  assert.ok(/portal-chip portal-chip-ativo"[^>]*href="\/condomino\/documentos\?ano=2026"/.test(comAno),
    'documentos: o ano escolhido fica assinalado');
  assert.ok(/href="\/condomino\/documentos\?ano=2026"/.test(comAno), 'documentos: URL de filtro preservado');
  assert.ok(/href="\/condomino\/documentos\?pasta=atas/.test(comAno), 'documentos: filtro de categoria preservado');

  // Sem documentos: mensagem neutra.
  const vazio = paginaDocs({ agrupados: [] });
  assert.ok(/Ainda não existem documentos disponibilizados/.test(vazio), 'sem documentos: mensagem neutra');
  assert.ok(!/portal-doc-lista/.test(vazio), 'sem documentos: nenhum cartão vazio');
  assert.ok(!/erro|problema|falha/i.test(vazio), 'sem documentos: não sugere erro');

  // Categoria/ano sem resultados: explica que são os filtros, sem sugerir erro.
  const semResultado = paginaDocs({ documentos: [], anoFiltro: '2025', anos: ['2025'], nDocumentos: 0 });
  assert.ok(/Sem documentos neste ano/.test(semResultado), 'documentos: ano sem documentos explicado');
  const semResultadoCat = paginaDocs({ documentos: [], pasta: 'atas', anos: ['2026'], nDocumentos: 0 });
  assert.ok(/Sem documentos nesta categoria/.test(semResultadoCat), 'documentos: categoria sem documentos explicada');
  const semResultadoAmbos = paginaDocs({ documentos: [], pasta: 'atas', anoFiltro: '2025', anos: ['2025'], nDocumentos: 0 });
  assert.ok(/Sem documentos com estes filtros/.test(semResultadoAmbos), 'documentos: os dois filtros juntos explicados');
  assert.ok(!/erro|problema|falha/i.test(semResultadoAmbos), 'documentos: filtros sem resultado não sugerem erro');

  // Documento só com ligação externa (sem ficheiro guardado).
  const externo = paginaDocs({
    documentos: [doc({ id: 7, drive_file_id: null, url: 'https://exemplo.pt/ata.pdf' })], nDocumentos: 1,
  });
  assert.ok(/target="_blank" rel="noopener noreferrer"/.test(externo) && /exemplo\.pt/.test(externo),
    'documentos: ligação externa apresentada quando não há ficheiro guardado');
  assert.ok(!/href="\/condomino\/documentos\/7\/ficheiro"/.test(externo),
    'documentos: sem ficheiro guardado não há rota interna de ficheiro');

  // Sem documentos mas sem erros: um documento sem data não parte a linha de meta.
  const semData = paginaDocs({ documentos: [doc({ data: null, ano: null })], nDocumentos: 1 });
  assert.ok(/Ata da assembleia\.pdf/.test(semData), 'documentos: documento sem data continua apresentado');
}

// ── 3e. Avisos, Assembleias e Calendário ──────────────────────────
const baseAvisos = { pessoa: { id: 10 }, titulo: 'Avisos e comunicações' };
const aviso = (over) => ({
  id: 1, assunto: 'Manutenção do elevador', mensagem: 'O elevador estará parado no dia 12.',
  tipo: 'manual', data_programada: null, createdAt: '2026-09-10', programada: null,
  dataMostrada: '2026-09-10', porPublicar: false, temDocumento: false, tipoRotulo: null, ...over,
});
const paginaAvisos = (avisos, extra = {}) => render('views/condomino/avisos.handlebars', {
  ...baseAvisos, avisos, nAvisos: avisos.length, nPorPublicar: avisos.filter((a) => a.porPublicar).length, filtroTipo: null, ...extra,
}).replace(/\s+/g, ' ');

const baseAssembleias = { pessoa: { id: 10 }, titulo: 'Assembleias' };
const assembleia = (over) => ({
  id: 4, numero: '2026/2', tipo: 'ordinaria', tipoRotulo: 'Ordinária', data: '2026-11-12', hora: '18:30',
  local: 'Sala comum', estado: 'convocada', estadoRotulo: 'Convocada', estadoClasse: 'text-bg-info',
  estadoVariante: 'estado-requer-config',
  ordem_trabalhos: '1. Contas\n2. Obras', eFutura: true, ...over,
});
const paginaAssembleias = (ctx) => render('views/condomino/assembleias.handlebars', {
  ...baseAssembleias, assembleias: [], proxima: null, outrasFuturas: [], passadas: [], ...ctx,
}).replace(/\s+/g, ' ');

const baseCalendario = { pessoa: { id: 10 }, titulo: 'Calendário' };
const evento = (over) => ({
  data: '2026-11-12', tipo: 'assembleia', tipoRotulo: 'Assembleia', titulo: 'Assembleia 2026/2',
  hora: '18:30', local: 'Sala comum', detalhe: '18:30 · Sala comum', estadoRotulo: 'Convocada',
  link: '/condomino/assembleias/4', ...over,
});
const paginaCalendario = (ctx) => render('views/condomino/calendario.handlebars', {
  ...baseCalendario, eventos: [], proximos: [], passados: [], proximo: null, ...ctx,
}).replace(/\s+/g, ' ');

// Estrutura mínima do HTML: as tags de bloco têm de estar emparelhadas. Sem isto,
// um ramo condicional mal fechado produziria uma ligação que engole o resto.
function tagsEmparelhadas(html, tag) {
  const abre = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const fecha = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  return { abre, fecha, ok: abre === fecha };
}

function testePaginaAvisos() {
  const comAvisos = paginaAvisos([
    aviso({ id: 2, assunto: 'Limpeza das fachadas', createdAt: '2026-09-14', dataMostrada: '2026-09-14' }),
    aviso({ id: 1, assunto: 'Manutenção do elevador', createdAt: '2026-09-10' }),
  ]);
  assert.ok(/<h1>Avisos<\/h1>/.test(comAvisos), 'avisos: cabeçalho claro');
  assert.ok(/Limpeza das fachadas/.test(comAvisos) && /Manutenção do elevador/.test(comAvisos), 'avisos: título visível');
  assert.ok(/Segunda-feira, 14\/09\/2026/.test(comAvisos), 'avisos: data e dia da semana visíveis');
  assert.ok(/Quinta-feira, 10\/09\/2026/.test(comAvisos), 'avisos: data do segundo aviso distinta');
  assert.ok(/O elevador estará parado no dia 12\./.test(comAvisos), 'avisos: conteúdo apresentado');
  assert.ok(/portal-doc-lista/.test(comAvisos) && /portal-doc/.test(comAvisos), 'avisos: cartões no mobile');
  assert.ok(!/lido|não lido|nao lido|urgente|prioridade/i.test(comAvisos),
    'avisos: não inventa estados de lido/urgência/prioridade');
  assert.ok(tagsEmparelhadas(comAvisos, 'li').ok && tagsEmparelhadas(comAvisos, 'ul').ok,
    'avisos: listas e itens emparelhados');

  // Programado: identificado como tal, sem outro estado inventado.
  const programado = paginaAvisos([aviso({ porPublicar: true, programada: '2026-12-01', dataMostrada: '2026-12-01', tipo: 'programado', tipoRotulo: 'Comunicação programada' })], { nPorPublicar: 1 });
  assert.ok(/Programado/.test(programado), 'avisos: comunicação programada assinalada');
  assert.ok(/schedule_send/.test(programado), 'avisos: ícone próprio para programado');
  assert.ok(/Programados \(1\)/.test(programado), 'avisos: filtro de programados com contagem');

  // Documento associado: liga à área de documentos (recurso existente).
  const comDocumento = paginaAvisos([aviso({ temDocumento: true })]);
  assert.ok(/href="\/condomino\/documentos"/.test(comDocumento), 'avisos: documento associado liga aos documentos');

  // Vários avisos e conteúdo longo: nada é truncado pelo servidor.
  const longo = 'A'.repeat(600);
  const comLongo = paginaAvisos([aviso({ mensagem: longo })]);
  assert.ok(comLongo.includes(longo), 'avisos: conteúdo longo apresentado por inteiro');

  // Sem avisos: mensagem neutra.
  const vazio = paginaAvisos([]);
  assert.ok(/Ainda não existem avisos/.test(vazio), 'avisos: estado vazio neutro');
  assert.ok(!/portal-doc-lista/.test(vazio), 'avisos: sem cartões vazios');
  assert.ok(!/erro|problema|falha/i.test(vazio), 'avisos: o vazio não é apresentado como erro');

  // Filtro sem resultados: remete para todos.
  const semFiltro = paginaAvisos([], { filtroTipo: 'programados' });
  assert.ok(/Sem avisos com este filtro/.test(semFiltro), 'avisos: filtro sem resultados explicado');
}

function testePaginaAssembleias() {
  const proxima = assembleia();
  const passada = assembleia({ id: 3, numero: '2026/1', tipo: 'ordinaria', tipoRotulo: 'Ordinária', data: '2026-04-10', estado: 'realizada', estadoRotulo: 'Realizada', estadoClasse: 'text-bg-success', estadoVariante: 'estado-concluido', eFutura: false, ordem_trabalhos: null });
  const comTudo = paginaAssembleias({ assembleias: [proxima, passada], proxima, outrasFuturas: [], passadas: [passada] });

  assert.ok(/<h1>Assembleias<\/h1>/.test(comTudo), 'assembleias: cabeçalho');
  assert.ok(/Próxima assembleia/.test(comTudo), 'assembleias: secção da próxima');
  assert.ok(/portal-hero/.test(comTudo), 'assembleias: a próxima tem destaque');
  assert.ok(/12\/11\/2026/.test(comTudo) && /18:30/.test(comTudo) && /Sala comum/.test(comTudo),
    'assembleias: data, hora e local da próxima');
  assert.ok(/class="estado estado-requer-config">Convocada/.test(comTudo), 'assembleias: estado na linguagem de estado única do portal (A14 §8)');
  assert.ok(/Ordinária/.test(comTudo), 'assembleias: tipo em PT-PT');
  assert.ok(/Quinta-feira/.test(comTudo) || /Quarta-feira|Terça-feira|Segunda-feira|Sexta-feira|Sábado|Domingo/.test(comTudo),
    'assembleias: dia da semana apresentado');
  assert.ok(/href="\/condomino\/assembleias\/4"/.test(comTudo), 'assembleias: ligação ao detalhe da próxima');
  assert.ok(/Assembleias anteriores/.test(comTudo) && /10\/04\/2026/.test(comTudo), 'assembleias: passadas continuam acessíveis');
  assert.ok(/href="\/condomino\/assembleias\/3"/.test(comTudo), 'assembleias: ligação ao detalhe das passadas');

  // Sem futuras: mensagem específica (não diz que não há assembleias nenhumas).
  const soPassadas = paginaAssembleias({ assembleias: [passada], proxima: null, outrasFuturas: [], passadas: [passada] });
  assert.ok(/Não existem assembleias futuras agendadas/.test(soPassadas), 'assembleias: sem futuras explicado');
  assert.ok(/As assembleias anteriores estão listadas abaixo/.test(soPassadas),
    'assembleias: sem futuras remete para as anteriores');
  assert.ok(/Assembleias anteriores/.test(soPassadas), 'assembleias: as passadas mantêm-se visíveis');
  assert.ok(!/Ainda não existem assembleias registadas/.test(soPassadas),
    'assembleias: com passadas não diz que não existem assembleias');

  // Nenhuma assembleia: mensagem neutra, uma só (e sem falar de «futuras»).
  const nenhuma = paginaAssembleias({});
  assert.ok(/Ainda não existem assembleias registadas/.test(nenhuma), 'assembleias: nenhuma registada');
  assert.ok(!/Não existem assembleias futuras/.test(nenhuma),
    'assembleias: sem nenhuma não fala só de futuras');
  assert.ok(!/Assembleias anteriores/.test(nenhuma), 'assembleias: sem secção de passadas vazia');

  // Várias futuras: a próxima em destaque e as outras em lista.
  const outra = assembleia({ id: 5, numero: '2026/3', data: '2026-12-20' });
  const varias = paginaAssembleias({ assembleias: [proxima, outra], proxima, outrasFuturas: [outra], passadas: [] });
  assert.strictEqual((varias.match(/class="card portal-hero /g) || []).length, 1, 'assembleias: só a próxima em destaque');
  assert.ok(/Também agendadas/.test(varias) && /20\/12\/2026/.test(varias), 'assembleias: as outras futuras listadas');

  assert.ok(tagsEmparelhadas(comTudo, 'li').ok && tagsEmparelhadas(comTudo, 'a').ok,
    'assembleias: listas e ligações emparelhadas');
}

function testePaginaCalendario() {
  const futuro = evento();
  const avisoFuturo = evento({ data: '2026-11-20', tipo: 'aviso', tipoRotulo: 'Comunicação programada', titulo: 'Vistoria do gás', hora: null, local: null, detalhe: null, estadoRotulo: null, link: '/condomino/avisos' });
  const passado = evento({ data: '2026-04-10', titulo: 'Assembleia 2026/1', estadoRotulo: 'Realizada', link: '/condomino/assembleias/3' });
  const comTudo = paginaCalendario({ eventos: [passado, futuro, avisoFuturo], proximos: [futuro, avisoFuturo], passados: [passado], proximo: futuro });

  assert.ok(/<h1>Calendário<\/h1>/.test(comTudo), 'calendário: cabeçalho');
  assert.ok(/Próximo/.test(comTudo) && /portal-hero/.test(comTudo), 'calendário: o próximo tem destaque');
  assert.ok(/12\/11\/2026/.test(comTudo) && /18:30/.test(comTudo) && /Sala comum/.test(comTudo),
    'calendário: data, hora e local do próximo');
  assert.ok(/A seguir/.test(comTudo) && /Vistoria do gás/.test(comTudo), 'calendário: próximos eventos listados');
  assert.ok(/20\/11\/2026/.test(comTudo), 'calendário: data dos próximos eventos');
  assert.ok(/Comunicação programada/.test(comTudo), 'calendário: tipo do evento identificado');
  assert.ok(/Já aconteceu/.test(comTudo) && /10\/04\/2026/.test(comTudo), 'calendário: passados continuam acessíveis');
  assert.ok(/href="\/condomino\/assembleias\/4"/.test(comTudo) && /href="\/condomino\/avisos"/.test(comTudo),
    'calendário: cada evento liga ao recurso existente');

  // A lista condicional de eventos não pode deixar tags por fechar.
  assert.ok(tagsEmparelhadas(comTudo, 'a').ok,
    'calendário: ligações emparelhadas (ramo com e sem link)');
  assert.ok(tagsEmparelhadas(comTudo, 'li').ok, 'calendário: itens emparelhados');
  assert.ok(tagsEmparelhadas(comTudo, 'span').ok, 'calendário: spans emparelhados');

  // Evento sem ligação: o título aparece, sem ligação partida.
  const evSemLink = evento({ titulo: 'Vistoria do gás', link: null });
  const semLink = paginaCalendario({ eventos: [evSemLink], proximos: [evSemLink], proximo: evSemLink });
  assert.ok(/Vistoria do gás/.test(semLink) && !/undefined/.test(semLink),
    'calendário: evento sem ligação continua apresentado');
  assert.ok(tagsEmparelhadas(semLink, 'a').ok, 'calendário: ramo sem ligação tem ligações emparelhadas');
  assert.ok(tagsEmparelhadas(semLink, 'div').ok, 'calendário: ramo sem ligação tem divs emparelhados');

  // Sem eventos: mensagem neutra.
  const vazio = paginaCalendario({});
  assert.ok(/Sem acontecimentos agendados/.test(vazio), 'calendário: estado vazio neutro');
  assert.ok(!/portal-hero/.test(vazio), 'calendário: sem destaque inventado quando não há eventos');
  assert.ok(!/erro|problema|falha/i.test(vazio), 'calendário: o vazio não é apresentado como erro');

  // Só passados: diz que não há futuros e mantém o histórico.
  const soPassados = paginaCalendario({ eventos: [passado], proximos: [], passados: [passado], proximo: null });
  assert.ok(/Sem acontecimentos futuros agendados/.test(soPassados), 'calendário: sem futuros explicado');
  assert.ok(/Já aconteceu/.test(soPassados), 'calendário: passados mantidos');
  assert.ok(/Os acontecimentos anteriores estão listados abaixo/.test(soPassados),
    'calendário: sem futuros remete para os anteriores');
}

// ── 4. Cabeçalho do portal ────────────────────────────────────────
function testeCabecalho() {
  const layout = ler('views/layouts/main.handlebars');
  assert.ok(/\{\{#if isAdmin\}\}[\s\S]{0,400}title="Notificações"[\s\S]{0,600}\{\{else\}\}[\s\S]{0,400}href="\/condomino\/avisos"/.test(layout),
    'cabeçalho: área do condómino tem atalho real para os avisos (backoffice mantém o seu)');
  assert.ok(/icon-badge/.test(layout) && /\{\{#if avisosRecentes\}\}/.test(layout), 'cabeçalho: contagem de avisos recentes quando existe');
  assert.ok(/aria-label="Avisos do condomínio/.test(layout), 'cabeçalho: atalho descrito para leitores de ecrã');
  // O menu do utilizador: isola-se a lista do dropdown a partir do `<ul>` (não o
  // bloco `isAdmin` do cabeçalho, que aparece antes na vista).
  const inicioMenu = layout.indexOf('dropdown-menu dropdown-menu-end');
  const menu = layout.slice(inicioMenu, layout.indexOf('</ul>', inicioMenu));
  assert.ok(/dropdown-item" href="\/condomino\/saida"/.test(menu),
    'cabeçalho: «Preparar saída do condomínio» no perfil, apenas para condóminos');
  assert.ok(/href="\/condomino\/perfil"/.test(layout) && /href="\/condomino\/condominios"/.test(layout)
    && /href="\/conta\/seguranca"/.test(layout) && /href="\/logout"/.test(layout),
    'cabeçalho: perfil mantém perfil, condomínios, segurança e sair');
  // O condómino não é atirado para fora do portal para mudar de condomínio:
  // a ligação de «Trocar de condomínio» do cabeçalho fica no portal.
  assert.ok(/href="\/condomino\/condominios" title="Trocar de condomínio"/.test(layout),
    'cabeçalho: pill do condomínio (área do condómino) troca dentro do portal');
  assert.ok(/dropdown-item" href="\/condomino\/condominios"/.test(menu),
    'cabeçalho: menu do utilizador leva a «Os meus condomínios» dentro do portal');
  // O ramo do backoffice continua a usar o seletor fora do portal.
  const ramoMenuAdmin = menu.slice(0, menu.indexOf('{{else}}'));
  assert.ok(/dropdown-item" href="\/condominios"/.test(ramoMenuAdmin),
    'cabeçalho: backoffice mantém «Os meus condomínios» (seletor fora do portal)');

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
  // As vistas do portal continuam a existir todas — menos a antiga `situacao`,
  // removida por ser código morto (nenhuma rota a renderizava e o contexto que
  // ela esperava — `receitasAno`, `totalQuotas`, … no contexto raiz — não tinha
  // fonte). A mera EXISTÊNCIA do ficheiro nunca foi prova de funcionalidade;
  // uma vista pode existir, compilar e renderizar zeros silenciosos.
  for (const vista of ['dashboard', 'quotas', 'pagamentos', 'recibos', 'documentos', 'assembleias', 'assembleia', 'avisos',
    'calendario', 'orcamento', 'saida-condominio', 'saida-condominio-confirmar']) {
    assert.ok(fs.existsSync(path.join(RAIZ, 'views', 'condomino', `${vista}.handlebars`)), `portal: vista preservada ${vista}`);
  }

  // ── A vista órfã `situacao.handlebars` foi eliminada ──────────────
  // 1) O ficheiro não existe (não pode voltar sem que este teste fique vermelho).
  assert.ok(!fs.existsSync(path.join(RAIZ, 'views', 'condomino', 'situacao.handlebars')),
    'portal: a vista órfã situacao.handlebars não existe (código morto removido)');
  // 2) Nenhuma rota tenta renderizá-la. O padrão cobre `res.render('condomino/situacao'…)`
  //    com aspas simples ou duplas e sem confundir com `condomino/situacao-financeira`
  //    (o nome tem de terminar aí — daí a fronteira `["']`).
  for (const ficheiro of ['routes/condomino.js', 'routes/condomino-conta.js', 'routes/condomino-recomendacoes.js',
    'routes/saida-condominio.js', 'routes/documentos-link.js']) {
    const fonte = ler(ficheiro);
    assert.ok(!/render\(\s*['"]condomino\/situacao['"]/.test(fonte),
      `${ficheiro}: nenhuma rota renderiza condomino/situacao (vista removida)`);
  }
  // 3) A página continua a ser a `situacao-financeira` — o endereço atual E o anterior.
  assert.ok(rota.includes("return res.render('condomino/situacao-financeira'"),
    'portal: /situacao-financeira continua a renderizar condomino/situacao-financeira');
  // 4) Nenhuma referência morta ao nome nu da vista em views/ ou scripts/.
  const referenciasOrfas = varrerReferencias('situacao.handlebars')
    .concat(varrerReferencias(/['"]condomino\/situacao['"]/));
  assert.deepStrictEqual(referenciasOrfas, [],
    `portal: nenhuma referência morta a condomino/situacao — encontradas: ${referenciasOrfas.join(', ')}`);
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
  // A propriedade é a ORDEM, não a distância: a janela de 300 caracteres
  // passava a falhar só porque a A14 §14 acrescentou `aria-current` ao item
  // (371 chars) — a ordem não mudou. Comparar ÍNDICES testa o que se quer
  // (Quotas vem antes de Recibos) sem ficar refém do tamanho do markup.
  const iQuotas = ramoSidebar.indexOf('href="/condomino/quotas"');
  const iRecibos = ramoSidebar.indexOf('href="/condomino/recibos"');
  assert.ok(iQuotas !== -1 && iRecibos !== -1 && iQuotas < iRecibos,
    'sidebar: Quotas antes de Recibos (área financeira agrupada)');
  assert.ok(!/href="\/condomino\/pagamentos"/.test(ramoSidebar),
    'sidebar: Pagamentos deixa de ser item próprio (passa a separador da área Quotas)');
  assert.ok(/href="\/condomino\/situacao-financeira"/.test(ramoSidebar) && !/href="\/condomino\/orcamento"/.test(ramoSidebar),
    'sidebar: Orçamento acede-se pelo Início e pela Situação financeira');
  // A situação financeira é a página de transparência do condomínio: continua a
  // levar ao orçamento e mantém o endereço anterior a responder.
  const vistaSituacao = ler('views/condomino/situacao-financeira.handlebars');
  assert.ok(/href="\/condomino\/orcamento"/.test(vistaSituacao),
    'situação financeira: ligação ao orçamento (sem becos sem saída na navegação)');
  assert.ok(/router\.get\('\/situacao'/.test(rota) && /router\.get\('\/situacao-financeira'/.test(rota),
    'situação financeira: endereço atual e anterior a responder');
  assert.ok(!/router\.post|\.create\(|\.update\(|\.destroy\(/.test(
    rota.slice(rota.indexOf("router.get('/situacao-financeira'"))),
    'situação financeira: a rota continua só de leitura');
  // A página não pode passar percentagens quando não há denominador (orçamento).
  assert.ok(/if \(gt orcamento\.orcamentado 0\)/.test(vistaSituacao),
    'situação financeira: sem percentagem de execução sem orçamento definido');
  // Nenhuma migration/modelo foi tocado por esta alteração (só apresentação).
  assert.ok(!/migrations\//.test(rota) && !/sequelize\.define/.test(rota), 'portal: sem novos modelos ou migrations');
}

// ── 6. Recomendação contextual no Início (Fase 2G) ────────────────
// O parcial não tem condições: apresenta o que o motor lhe entregar. Aqui
// verificam-se as duas situações na vista — com e sem recomendação — e a
// integração com o topo do Início.
function testeRecomendacaoNoInicio() {
  const RECOMENDACAO = {
    id: '2fa_ativo',
    tipo: 'seguranca',
    titulo: 'Reforce a segurança da sua conta com 2FA',
    mensagem: 'A verificação em duas etapas acrescenta um código extra em cada entrada.',
    icone: 'shield_lock',
    acao: { texto: 'Ativar 2FA', url: '/conta/seguranca' },
    dismissivel: true,
    prioridade: 100,
  };

  // Com recomendação: cartão com título, mensagem, ação e dispensa.
  const com = render('views/partials/_portal-recomendacao.handlebars', { recomendacao: RECOMENDACAO });
  assert.ok(/class="card portal-recomendacao/.test(com), 'recomendação: cartão apresentado (discreto, não é modal nem popup)');
  assert.ok(/Reforce a segurança da sua conta com 2FA/.test(com), 'recomendação: título visível');
  assert.ok(/A verificação em duas etapas/.test(com), 'recomendação: mensagem visível');
  assert.ok(/href="\/conta\/seguranca"/.test(com) && /Ativar 2FA/.test(com), 'recomendação: ação com o destino da definição');
  assert.ok(/action="\/condomino\/recomendacoes\/2fa_ativo\/dispensar"/.test(com), 'recomendação: dispensa ligada à recomendação certa');
  assert.strictEqual((com.match(/portal-recomendacao-titulo/g) || []).length, 1, 'recomendação: um só cartão');
  assert.ok(!/alert-danger|modal|popup/i.test(com), 'recomendação: sem alerta agressivo nem modal');

  // Sem recomendação: nada é apresentado (nem um cartão vazio).
  const sem = render('views/partials/_portal-recomendacao.handlebars', { recomendacao: null });
  assert.strictEqual(sem.trim(), '', 'recomendação: sem recomendação não há cartão nenhum');

  // Não dispensável: sem botão de dispensa (a decisão vem do motor).
  const naoDismissivel = render('views/partials/_portal-recomendacao.handlebars', {
    recomendacao: { ...RECOMENDACAO, dismissivel: false },
  });
  assert.ok(/Ativar 2FA/.test(naoDismissivel) && !/Dispensar/.test(naoDismissivel),
    'recomendação: não dispensável não mostra o botão de dispensar');

  // Integração: o Início inclui o parcial como primeiro bloco do conteúdo, e o
  // parcial vem DEPOIS do bloco dos dados globais (que já existiam nas fases
  // anteriores) — nada do Início foi reorganizado.
  const dashboard = ler('views/condomino/dashboard.handlebars');
  assert.ok(/\{\{> _portal-recomendacao\}\}/.test(dashboard), 'Início: inclui o parcial da recomendação');
  assert.ok(dashboard.indexOf('portal-conteudo') < dashboard.indexOf('_portal-recomendacao'),
    'Início: a recomendação entra dentro do conteúdo');
  assert.ok(dashboard.indexOf('_portal-recomendacao') < dashboard.indexOf('portal-inicio'),
    'Início: a recomendação fica no topo do conteúdo (antes das colunas)');

  // Nenhuma condição de elegibilidade vive no template.
  assert.ok(!/two_fa_ativo|two_fa_metodo/.test(ler('views/partials/_portal-recomendacao.handlebars')),
    'recomendação: o template não tem condições de elegibilidade');
  assert.ok(!/two_fa_ativo/.test(dashboard), 'Início: a vista não decide a elegibilidade');
}

// ── 7. Conta, perfil e condomínios (Fase 2F) ──────────────────────
// Renderiza as duas vistas novas com os estados que a fase tem de cobrir:
// 2FA ativo/inativo, um/vários condomínios, uma/várias frações e sem frações.
function testeContaPerfilCondominios() {
  const CONTEXTO_BASE = {
    user: { nome: 'Ana Silva', email: 'ana@exemplo.pt' },
    condominio: { designacao: 'Condomínio Jardins do Tejo', morada: 'Rua das Flores 25', codigo_postal: '1000-100', localidade: 'Lisboa' },
    condominioAtivo: { id: 1, designacao: 'Condomínio Jardins do Tejo', role: 'leitura' },
    isAdmin: false,
  };
  const CONTA = {
    id: 42, nome: 'Ana Silva', email: 'ana@exemplo.pt', telefone: '912345678',
    email_confirmado: true, ativo: true, last_login_at: '2026-09-20T18:30:00.000Z',
  };

  const paginaPerfil = (extra) => render('views/condomino/perfil.handlebars', {
    ...CONTEXTO_BASE,
    conta: CONTA,
    condominioLocal: 'Rua das Flores 25 · 1000-100 · Lisboa',
    fracoes: [],
    nCondominios: 1,
    doisFatoresAtivo: false,
    doisFatoresMetodo: 'email',
    ...extra,
  });

  // ── Perfil: dados da conta e hierarquia ────────────────────────
  const perfilInativo = paginaPerfil({});
  assert.strictEqual((perfilInativo.match(/<h1>/g) || []).length, 1, 'perfil: um só H1');
  assert.ok(/<h1>Meu perfil<\/h1>/.test(perfilInativo), 'perfil: título da página');
  assert.ok(perfilInativo.includes('Ana Silva') && perfilInativo.includes('ana@exemplo.pt'),
    'perfil: identifica a conta do próprio');
  for (const seccao of ['Dados da conta', 'Condomínio ativo', 'Segurança', 'Os meus condomínios', 'Acesso a este condomínio']) {
    assert.ok(perfilInativo.includes(seccao), `perfil: secção «${seccao}» presente`);
  }
  assert.ok(/Conta ativa/.test(perfilInativo), 'perfil: apresenta o estado da conta (o real, sem ação de reativação)');
  assert.ok(!/Ativar conta|Reativar|Desativar conta/i.test(perfilInativo),
    'perfil: não oferece ações sobre o estado da conta (não autorizadas ao próprio)');
  assert.ok(/912345678/.test(perfilInativo), 'perfil: mostra os dados pessoais já apresentados ao próprio');

  // ── Perfil: 2FA inativo → mensagem e ação de ativação ──────────
  assert.ok(/Inativa/.test(perfilInativo), 'perfil: 2FA inativo é apresentado como inativo');
  assert.ok(/Aumente a segurança da sua conta ativando a autenticação de dois fatores\./.test(perfilInativo),
    'perfil: mensagem de incentivo quando o 2FA está inativo');
  assert.ok(/href="\/conta\/seguranca"[\s\S]{0,200}Ativar 2FA/.test(perfilInativo),
    'perfil: ação «Ativar 2FA» na página de segurança existente');
  assert.ok(!/Gerir verificação em duas etapas/.test(perfilInativo),
    'perfil: sem ação de gestão quando o 2FA está inativo');

  // ── Perfil: 2FA ativo → estado real e gestão (sem «Ativar 2FA») ─
  const perfilAtivo = paginaPerfil({ doisFatoresAtivo: true, doisFatoresMetodo: 'totp' });
  assert.ok(/Ativa/.test(perfilAtivo), 'perfil: 2FA ativo é apresentado como ativo');
  assert.ok(/aplicação autenticadora/.test(perfilAtivo), 'perfil: indica o método real do 2FA');
  assert.ok(/href="\/conta\/seguranca"[\s\S]{0,200}Gerir verificação em duas etapas/.test(perfilAtivo),
    'perfil: com 2FA ativo a ação é de gestão');
  assert.ok(!/Ativar 2FA/.test(perfilAtivo), 'perfil: com 2FA ativo não se oferece «Ativar 2FA»');
  assert.ok(!/Aumente a segurança/.test(perfilAtivo), 'perfil: com 2FA ativo não se pede para ativar');

  // ── Perfil: método por email é descrito como email ─────────────
  const perfilEmail = paginaPerfil({ doisFatoresAtivo: true, doisFatoresMetodo: 'email' });
  assert.ok(/código enviado para o seu email/.test(perfilEmail), 'perfil: descreve o método por email');

  // ── Perfil: uma fração, várias frações e sem frações ───────────
  const umaFracao = paginaPerfil({ fracoes: [{ id: 5, designacao: '1.º Esq', vinculo: 'proprietario' }] });
  assert.strictEqual((umaFracao.match(/Fração 1º Esq|Fração 1\.º Esq/g) || []).length, 1,
    'perfil: uma fração aparece uma só vez');
  assert.ok(/proprietario/.test(umaFracao), 'perfil: mostra o vínculo da fração');

  const variasFracoes = paginaPerfil({
    fracoes: [
      { id: 5, designacao: '1.º Esq', vinculo: 'proprietario' },
      { id: 6, designacao: '2.º Dto', vinculo: 'arrendatario' },
    ],
  });
  assert.ok(/1\.º Esq/.test(variasFracoes) && /2\.º Dto/.test(variasFracoes),
    'perfil: todas as frações próprias aparecem');
  assert.strictEqual((variasFracoes.match(/Fração 1\.º Esq/g) || []).length, 1,
    'perfil: nenhuma fração é duplicada');
  assert.ok(/arrendatario/.test(variasFracoes), 'perfil: apresenta vínculos diferentes');

  const semFracao = paginaPerfil({ fracoes: [] });
  assert.ok(/Sem frações associadas neste condomínio\./.test(semFracao),
    'perfil: sem fração mostra estado neutro');
  assert.ok(!/Fração /.test(semFracao), 'perfil: sem fração não inventa uma relação');

  // ── Perfil: sem condomínio ativo (estado neutro, sem invenções) ─
  const semAtivo = render('views/condomino/perfil.handlebars', {
    ...CONTEXTO_BASE, condominioAtivo: null, condominioLocal: null, conta: CONTA,
    fracoes: [], nCondominios: 0, doisFatoresAtivo: false, doisFatoresMetodo: 'email',
  });
  assert.ok(/Sem condomínio ativo\./.test(semAtivo), 'perfil: sem condomínio ativo explica-se');
  assert.ok(!/Fração /.test(semAtivo), 'perfil: sem condomínio ativo não inventa frações');

  // ── Perfil: um condomínio não convida a "escolher" ─────────────
  assert.ok(/Ver o meu condomínio/.test(paginaPerfil({ nCondominios: 1 })),
    'perfil: com um condomínio a ação é informativa, não de escolha');
  assert.ok(/Os meus condomínios/.test(paginaPerfil({ nCondominios: 3 })),
    'perfil: com vários condomínios a ação leva à lista');

  // ── Condomínios: um só, ativo e sem pedir escolha ──────────────
  const UM = [{
    id: 1, designacao: 'Condomínio Jardins do Tejo', local: 'Rua das Flores 25 · Lisboa',
    papelLabel: 'Leitura', totalFracoes: 12, ativo: true, minhasFracoes: [{ id: 5, designacao: '1.º Esq', vinculo: 'proprietario' }],
  }];
  const paginaCondominios = (extra) => render('views/condomino/condominios.handlebars', {
    ...CONTEXTO_BASE, lista: UM, ativoId: 1, temAtivo: true, varios: false, ...extra,
  });

  const umSo = paginaCondominios({});
  assert.strictEqual((umSo.match(/<h1>/g) || []).length, 1, 'condomínios: um só H1');
  assert.ok(/Condomínio ativo/.test(umSo), 'condomínios: o condomínio ativo está assinalado');
  assert.ok(/O condomínio a que tem acesso\./.test(umSo), 'condomínios: com um só não pede escolha');
  assert.ok(!/Entrar neste condomínio/.test(umSo),
    'condomínios: com um só (já ativo) não se mostra a experiência de escolher entre uma opção');
  assert.ok(/href="\/condomino"/.test(umSo), 'condomínios: leva ao Início do condomínio ativo');

  // ── Condomínios: vários → ativo marcado + entrar nos restantes ─
  const VARIOS = [
    UM[0],
    { id: 2, designacao: 'Condomínio das Amoreiras', local: null, papelLabel: 'Leitura', totalFracoes: 8, ativo: false, minhasFracoes: [] },
    { id: 3, designacao: 'Condomínio do Parque', local: null, papelLabel: 'Leitura', totalFracoes: 4, ativo: false, minhasFracoes: [{ id: 9, designacao: 'R/C Dto', vinculo: 'arrendatario' }] },
  ];
  const muitos = paginaCondominios({ lista: VARIOS, varios: true });
  assert.strictEqual((muitos.match(/Condomínio ativo/g) || []).length, 1, 'condomínios: um só ativo assinalado');
  assert.strictEqual((muitos.match(/Entrar neste condomínio/g) || []).length, 2,
    'condomínios: ação de entrada nos restantes (e não no ativo)');
  assert.ok(/action="\/condomino\/condominios\/2\/entrar"/.test(muitos) && /action="\/condomino\/condominios\/3\/entrar"/.test(muitos),
    'condomínios: a entrada usa a rota do portal com o id do condomínio');
  assert.ok(/Escolha onde quer trabalhar\./.test(muitos), 'condomínios: com vários explica a escolha');
  assert.ok(/R\/C Dto/.test(muitos) && /arrendatario/.test(muitos), 'condomínios: mostra as frações próprias de cada condomínio');
  assert.ok(/Sem frações associadas neste condomínio\./.test(muitos),
    'condomínios: sem frações próprias não inventa relação');
  assert.ok(/Sem morada registada/.test(muitos), 'condomínios: sem morada diz que não há (não inventa)');

  // ── Condomínios: sem nenhum (nunca "disponível para seleção") ──
  const nenhum = paginaCondominios({ lista: [], ativoId: null, temAtivo: false });
  assert.ok(/Ainda não está associado a nenhum condomínio\./.test(nenhum), 'condomínios: estado vazio explícito');
  assert.ok(!/Entrar neste condomínio/.test(nenhum), 'condomínios: sem associações não há nada para selecionar');
  assert.ok(!/Condomínio ativo/.test(nenhum), 'condomínios: sem condomínio ativo não se inventa um');

  // ── A vista nunca mostra dados de terceiros ────────────────────
  // As vistas da área pessoal recebem só os dados do próprio (o contexto dos
  // testes não traz nenhum dado alheio): o que se garante é que não há contagens
  // nem listagens de terceiros nem identificação de outras frações/titulares.
  for (const [nome, html] of [['perfil', perfilInativo], ['condomínios', muitos]]) {
    assert.ok(!/outro\(s\) condómino|outros condóminos|outro titular|titulares deste condomínio/i.test(html),
      `${nome}: não apresenta dados de terceiros`);
    assert.ok(!/Fração 7|Fração 8|Fração 9/.test(html),
      `${nome}: não identifica frações que não sejam do próprio`);
  }
}

// ── 7. Router da área pessoal: isolamento e não-escrita no portal ──
function testeRouterConta() {
  const fonte = ler('routes/condomino-conta.js');
  // Isolamento: tudo vem das associações do PRÓPRIO utilizador.
  assert.ok(/router\.use\(eAutenticado\)/.test(fonte), 'conta: exige sessão');
  assert.ok((fonte.match(/tenant\.listarCondominios\(req\.user\.id\)/g) || []).length >= 2,
    'conta: a lista de condomínios vem sempre do utilizador da sessão');
  assert.ok(fonte.includes('tenant.entrarCondominio(req, id)'),
    'conta: a troca de condomínio usa o mecanismo de autorização existente');
  assert.ok(!/UserCondominio\.(create|update|destroy)|titularidades\.(criar|encerrar|associar)/.test(fonte),
    'conta: não cria/atualiza associações nem titularidades');
  assert.ok(!/User\.(create|update|destroy)|user\.update\(/.test(fonte),
    'conta: não altera a conta do utilizador');
  assert.ok(!/condominio_ativo_id\s*=/.test(fonte),
    'conta: não escreve o condomínio ativo fora da função autorizada (tenant)');
  // Do 2FA só se LÊ o estado; nenhum passo do fluxo é duplicado aqui.
  assert.ok(/two_fa_ativo/.test(fonte) && !/two_fa_totp_secret|two_fa_recovery_hash/.test(fonte),
    'conta: lê o estado do 2FA sem tocar em segredos/códigos de recuperação');
  for (const passo of ['2fa/ativar', '2fa/desativar', '2fa/totp/iniciar', '2fa/codigos']) {
    assert.ok(!fonte.includes(passo), `conta: não duplica o passo «${passo}» do 2FA existente`);
  }
  assert.ok(!/migrations\//.test(fonte) && !/sequelize\.define/.test(fonte),
    'conta: sem novos modelos ou migrations');
  // Só uma rota de escrita em toda a área pessoal: entrar num condomínio.
  const escritas = (fonte.match(/router\.post\(/g) || []).length;
  assert.strictEqual(escritas, 1, 'conta: uma só rota de escrita (entrar num condomínio)');
  assert.ok(/router\.post\('\/condominios\/:id\/entrar'/.test(fonte), 'conta: a rota de escrita é a entrada no condomínio');
  // e a área de consulta do portal continua estritamente só de leitura.
  assert.ok(!/router\.post|\.create\(|\.update\(|\.destroy\(/.test(ler('routes/condomino.js')),
    'conta: a área do condomínio (routes/condomino.js) continua só de leitura');

  // Sem reativação de acesso: nenhuma rota do portal reativa associações.
  assert.ok(!/estado: 'ativo'/.test(fonte), 'conta: não reativa associações (estado passado à mão)');
}

// ── 8. Acessibilidade das tabelas do portal (P32) ─────────────────
// As 6 tabelas do portal (quotas ×2, recibos, pagamentos, assembleias,
// orçamento) não tinham NENHUM nome acessível e nenhum dos 39 cabeçalhos
// declarava o âmbito: um leitor de ecrã anunciava «tabela» sem dizer de quê, e
// cada célula sem a coluna a que pertence. Verifica-se na FONTE de todas as
// vistas do portal (não numa lista à mão — uma tabela nova tem de cumprir).
function testeAcessibilidadeTabelas() {
  const ficheiros = fs.readdirSync(path.join(RAIZ, 'views', 'condomino'))
    .filter((f) => f.endsWith('.handlebars'));
  let tabelas = 0;
  let cabecalhos = 0;

  for (const ficheiro of ficheiros) {
    const src = ler(`views/condomino/${ficheiro}`);

    for (const m of src.matchAll(/<table\b[^>]*>/g)) {
      tabelas += 1;
      const resto = src.slice(m.index);
      const ateFecho = resto.slice(0, resto.indexOf('</table>') + 1);
      assert.ok(/<caption\b/.test(ateFecho) || /aria-label=/.test(m[0]),
        `${ficheiro}: cada tabela tem um nome acessível (<caption> ou aria-label)`);
      if (/<caption\b/.test(ateFecho)) {
        // O <caption> tem de ser o primeiro filho da tabela (exigência do HTML).
        assert.ok(resto.slice(m[0].length).trimStart().startsWith('<caption'),
          `${ficheiro}: o <caption> é o primeiro filho da tabela`);
        assert.ok(/<caption class="visually-hidden">\s*\S/.test(ateFecho),
          `${ficheiro}: o <caption> tem texto (escondido visualmente, presente para leitores de ecrã)`);
      }
    }

    for (const m of src.matchAll(/<th\b([^>]*)>/g)) {
      cabecalhos += 1;
      assert.ok(/scope="col"/.test(m[1]),
        `${ficheiro}: todos os <th> declaram scope="col" (offset ${m.index})`);
    }
    assert.ok(!/<th>/.test(src), `${ficheiro}: nenhum <th> sem scope`);
  }

  // Prova de cobertura: as 6 tabelas e os 39 cabeçalhos do portal.
  assert.strictEqual(tabelas, 6, `acessibilidade: as 6 tabelas do portal foram verificadas (${tabelas})`);
  assert.strictEqual(cabecalhos, 39, `acessibilidade: os 39 cabeçalhos do portal foram verificados (${cabecalhos})`);
}

// ── 8b. Seletor de ano no orçamento (P31/C5) ─────────────────────
function testeSeletorAno() {
  const html = render('views/condomino/orcamento.handlebars', {
    pessoa: { id: 10 },
    ano: 2025,
    anoAtual: 2026,
    anos: [2026, 2025, 2024],
    orcamento: { ano: 2025 },
    linhas: [{ nome: 'Elevadores', orcamentado: 1000, executado: 300, percentagem: 30 }],
    totais: { orcamentado: 1000, executado: 300, saldo: 700, percentagem: 30 },
  });

  assert.ok(/<select[^>]*name="ano"/.test(html), 'orçamento: seletor de ano presente na página');
  assert.ok(/<select[^>]*id="filtroAnoOrcamento"/.test(html), 'orçamento: o seletor tem rótulo associado');
  assert.ok(/<label[^>]*for="filtroAnoOrcamento"/.test(html), 'orçamento: o rótulo aponta para o seletor');
  for (const a of [2026, 2025, 2024]) {
    assert.ok(new RegExp(`<option value="${a}"`).test(html), `orçamento: o ano ${a} está na lista`);
  }
  assert.strictEqual((html.match(/selected/g) || []).length, 1,
    'orçamento: exatamente um ano fica selecionado (o que está a ser apresentado)');
  assert.ok(/<option value="2025" selected>/.test(html), 'orçamento: o ano apresentado é o selecionado');
  // Sem JavaScript: o botão submete o formulário.
  assert.ok(/<form method="GET"/.test(html) && /<button[^>]*>Ver<\/button>/.test(html),
    'orçamento: o seletor submete sem depender de JavaScript');
  // O ano em curso continua alcançável (o botão «Ano atual» foi substituído pelo
  // seletor, que inclui sempre o ano em curso).
  assert.ok(/<option value="2026"/.test(html), 'orçamento: o ano em curso continua alcançável');
  // A tabela do orçamento mantém-se acessível (P32) e com as linhas entregues.
  assert.ok(/<caption class="visually-hidden">/.test(html) && /scope="col"/.test(html),
    'orçamento: a tabela mantém nome acessível e âmbito nos cabeçalhos');
  assert.ok(/Elevadores/.test(html) && html.includes('1.000,00 €'),
    'orçamento: as linhas entregues são apresentadas');
}

// ── 8c. Comprovativo na lista de pagamentos (P31/C1) ─────────────
function testeComprovativoNaLista() {
  const com = render('views/condomino/pagamentos.handlebars', {
    pessoa: { id: 10 },
    listaTruncada: false,
    linhas: [
      { id: 501, data_pagamento: '2026-09-01', fracaoDesignacao: '1.º Esq', valor: 75, periodos: 'Agosto 2026', metodoNome: 'Transferência', referencia: 'TRF-1', comprovativo_ficheiro: '1710000000_abc.pdf' },
      { id: 502, data_pagamento: '2026-08-01', fracaoDesignacao: '1.º Esq', valor: 75, periodos: 'Julho 2026', metodoNome: null, referencia: null, comprovativo_ficheiro: null },
    ],
  });

  assert.ok(/href="\/condomino\/pagamentos\/501\/comprovativo"/.test(com),
    'pagamentos: ligação ao comprovativo quando o pagamento tem um');
  assert.ok(!/href="\/condomino\/pagamentos\/502\/comprovativo"/.test(com),
    'pagamentos: sem ligação quando o pagamento não tem comprovativo');
  assert.ok(/aria-label="Ver comprovativo do pagamento de/.test(com),
    'pagamentos: a ligação tem rótulo acessível (não é um ícone mudo)');
  // O comprovativo não se confunde com o recibo: o PDF do recibo é outra rota.
  assert.ok(!/href="\/condomino\/recibos\/501\/pdf"/.test(com),
    'pagamentos: a lista não inventa ligações para recibos');
  // A coluna nova não quebra a tabela (7 cabeçalhos de coluna, todos com âmbito).
  assert.strictEqual((com.match(/scope="col"/g) || []).length, 7, 'pagamentos: 7 colunas no cabeçalho');
}

testeBarraInferior();
testeInicio();
testeInicioMultiFraccao();
testeAreaQuotas();
testePaginaQuotas();
testePaginaRecibos();
testePaginaDocumentos();
testePaginaAvisos();
testePaginaAssembleias();
testePaginaCalendario();
testeCabecalho();
testeIntegridade();
testeRecomendacaoNoInicio();
testeContaPerfilCondominios();
testeRouterConta();
testeAcessibilidadeTabelas();
testeSeletorAno();
testeComprovativoNaLista();
console.log('✓ Testes da área do condómino passaram (mobile-first, sem base de dados).');
