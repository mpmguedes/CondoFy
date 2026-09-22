// ═══════════════════════════════════════════════════════════════════
// Painel administrativo acionável — sinais de atenção e atividade (Fase 2H.2).
//
// O que se testa aqui:
//  · a DECISÃO de que sinais aparecem (lógica pura de `helpers/dashboard.js`),
//    com o destino (ligação) de cada um e sem mostrar zeros como problemas;
//  · o orçamento por concluir (estados que exigem ação);
//  · a atividade recente: só eventos úteis, sem sessões/2FA/dispensas, com
//    autor e limite;
//  · o ISOLAMENTO das consultas do handler (condomínio ativo) e a garantia de
//    que o painel não apresenta dívida individual de condóminos.
//
// Utilização: node scripts/test-dashboard-painel.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// `helpers/dashboard.js` importa modelos; aqui não há base de dados.
const modelsPath = require.resolve(path.join(RAIZ, 'models'));
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: { Quota: {}, Pagamento: {}, PagamentoQuota: {}, ExtraQuotaParcela: {}, Orcamento: {}, OrcamentoRubrica: {}, PlanoQuota: {}, ExtraQuota: {} },
};

const dash = require('../helpers/dashboard');
const { sinaisDeAtencao, orcamentoPorConcluir, atividadeRecente, ATIVIDADE } = dash;

const porId = (sinais) => new Map(sinais.map((s) => [s.id, s]));
const CALMO = {
  nVencidas: 0,
  comprovativosPendentes: 0,
  quotasMesEmitidas: 5,
  pagamentosFornecedorPendentes: 0,
  documentosPorDisponibilizar: 0,
  orcamentoEstadoAberto: null,
  proximasAssembleias: [],
  filaErros: 0,
  // Armazenamento dos DOCUMENTOS do condomínio (por condomínio) — não confundir
  // com o destino dos backups, que é uma configuração da instalação.
  documentosLigado: true,
  backupEstado: null,
  smtp: true,
};

// ── 1. Sem nada a tratar: nenhum sinal ────────────────────────────
function testeSemSinais() {
  assert.deepStrictEqual(sinaisDeAtencao(CALMO), [], 'condomínio em ordem: nenhum sinal');
  // Sem dados nenhuns não rebenta nem inventa sinais.
  assert.deepStrictEqual(sinaisDeAtencao(), [], 'sem dados não inventa sinais');
  assert.deepStrictEqual(sinaisDeAtencao({ nVencidas: 0, quotasMesEmitidas: 12, documentosLigado: true, backupEstado: 'local', smtp: true }), [],
    'zeros, serviços ligados e um backup concluído não produzem sinais');
  console.log('  ✓ sem nada a tratar, a lista fica vazia (nenhum zero é «problema»)');
}

// ── 2. Cada sinal, com o destino certo ───────────────────────────
function testeSinaisIndividuais() {
  const casos = [
    ['quotas_vencidas', { nVencidas: 4 }, '/admin/quotas', 4],
    ['comprovativos', { comprovativosPendentes: 3 }, '/admin/quotas/comprovativos', 3],
    ['quotas_mes', { quotasMesEmitidas: 0 }, '/admin/quotas/gerar', 0],
    ['pagamentos_fornecedor', { pagamentosFornecedorPendentes: 2 }, '/admin/fornecedores', 2],
    ['documentos', { documentosPorDisponibilizar: 5 }, '/admin/documentos', 5],
    ['email_erros', { filaErros: 7 }, '/admin/emails?estado=erros', 7],
    ['backup', { backupEstado: 'erro' }, '/admin/config/armazenamento', 0],
    ['backup', { backupEstado: 'local_copia_cloud_falhada' }, '/admin/config/armazenamento', 0],
    ['drive', { documentosLigado: false }, '/admin/config/armazenamento', 0],
    ['smtp', { smtp: false }, '/admin/config/email', 0],
  ];
  for (const [id, extra, url, quantidade] of casos) {
    const sinais = sinaisDeAtencao({ ...CALMO, ...extra });
    const mapa = porId(sinais);
    assert.ok(mapa.has(id), `sinal «${id}» aparece quando a condição existe`);
    assert.strictEqual(mapa.get(id).destino.url, url, `sinal «${id}»: ligação direta para ${url}`);
    assert.ok(mapa.get(id).destino.texto, `sinal «${id}»: texto da ação presente`);
    assert.ok(mapa.get(id).texto && mapa.get(id).texto.length > 8, `sinal «${id}»: texto legível`);
    assert.strictEqual(mapa.get(id).quantidade, quantidade, `sinal «${id}»: quantidade correta`);
    assert.ok(['critico', 'atencao', 'info'].includes(mapa.get(id).gravidade), `sinal «${id}»: gravidade conhecida`);
    // Só o sinal em causa.
    assert.strictEqual(sinais.length, 1, `sinal «${id}»: só ele aparece (${sinais.map((s) => s.id).join(', ')})`);
  }
  // Orçamento e assembleia (as duas entradas que não são contagens).
  const comOrcamento = porId(sinaisDeAtencao({ ...CALMO, ano: 2026, orcamentoEstadoAberto: 'rascunho', orcamentoEstadoRotulo: 'rascunho', orcamentoId: 12 }));
  assert.ok(comOrcamento.has('orcamento'), 'orçamento por concluir aparece');
  assert.strictEqual(comOrcamento.get('orcamento').destino.url, '/admin/orcamento/12', 'orçamento: liga ao orçamento certo');
  assert.ok(/2026/.test(comOrcamento.get('orcamento').texto) && /rascunho/.test(comOrcamento.get('orcamento').texto),
    'orçamento: texto identifica o ano e o estado');

  const comAssembleia = porId(sinaisDeAtencao({ ...CALMO, proximasAssembleias: [{ id: 30, numero: '2/2026', data: '12/11/2026' }] }));
  assert.ok(comAssembleia.has('assembleias'), 'próxima assembleia aparece');
  assert.strictEqual(comAssembleia.get('assembleias').destino.url, '/admin/assembleias/30', 'assembleia: liga ao detalhe');
  assert.ok(/12\/11\/2026/.test(comAssembleia.get('assembleias').texto), 'assembleia: texto mostra a data');
  // Sem orçamento por abrir e sem assembleias futuras, nada destes dois.
  const semExtras = sinaisDeAtencao({ ...CALMO, proximasAssembleias: [] });
  assert.ok(!porId(semExtras).has('orcamento') && !porId(semExtras).has('assembleias'),
    'sem orçamento por concluir e sem assembleias futuras, nada aparece');
  console.log('  ✓ cada sinal aparece com a condição certa e a ligação certa');
}

// ── 3. Prioridade e ordem ─────────────────────────────────────────
function testePrioridade() {
  const sinais = sinaisDeAtencao({
    nVencidas: 1, comprovativosPendentes: 1, quotasMesEmitidas: 0, pagamentosFornecedorPendentes: 1,
    documentosPorDisponibilizar: 1, filaErros: 1, documentosLigado: false, backupEstado: 'erro', smtp: false,
    ano: 2026, orcamentoEstadoAberto: 'aprovado', orcamentoEstadoRotulo: 'aprovado', orcamentoId: 3,
    proximasAssembleias: [{ id: 1, data: '01/12/2026' }],
  });
  const ordem = sinais.map((s) => s.id);
  assert.strictEqual(ordem[0], 'quotas_vencidas', 'a dívida dos condóminos vem primeiro');
  assert.ok(ordem.indexOf('comprovativos') < ordem.indexOf('documentos'), 'dinheiro antes de trabalho de arquivo');
  assert.ok(ordem.indexOf('quotas_mes') < ordem.indexOf('drive'), 'trabalho do mês antes da configuração');
  assert.ok(ordem.indexOf('email_erros') < ordem.indexOf('backup'), 'um email falhado antes da cópia de segurança');
  assert.ok(ordem.indexOf('backup') < ordem.indexOf('drive'), 'a cópia de segurança antes do destino da cópia');
  assert.ok(ordem.indexOf('email_erros') > ordem.indexOf('assembleias'), 'configuração depois do trabalho corrente');
  const prioridades = sinais.map((s) => s.prioridade);
  assert.deepStrictEqual(prioridades, [...prioridades].sort((a, b) => b - a), 'ordenados por prioridade decrescente');
  console.log(`  ✓ prioridade respeitada (${ordem.join(' > ')})`);
}

// ── 4. Orçamento por concluir ─────────────────────────────────────
function testeOrcamentoPorConcluir() {
  for (const estado of ['rascunho', 'aprovado', 'em_execucao']) {
    const r = orcamentoPorConcluir({ id: 9, estado });
    assert.ok(r && r.id === 9, `orçamento ${estado}: exige ação`);
    assert.ok(r.rotulo && r.rotulo.length, `orçamento ${estado}: tem rótulo legível`);
  }
  for (const estado of ['encerrado', 'anulado']) {
    assert.strictEqual(orcamentoPorConcluir({ id: 9, estado }), null, `orçamento ${estado}: já não exige ação`);
  }
  assert.strictEqual(orcamentoPorConcluir(null), null, 'sem orçamento não há sinal');
  assert.strictEqual(orcamentoPorConcluir(undefined), null, 'orçamento indefinido não rebenta');
  assert.strictEqual(orcamentoPorConcluir({ id: 9, estado: 'estado_estranho' }), null,
    'estado desconhecido não é apresentado como pendente');
  console.log('  ✓ só o orçamento por concluir gera sinal (fechado e anulado não)');
}

// ── 5. Atividade recente ──────────────────────────────────────────
function testeAtividade() {
  const registos = [
    { acao: 'registar_pagamento', data_hora: '2026-09-20T10:00:00Z', utilizador: { nome: 'Ana Silva' } },
    { acao: 'inicio_sessao', data_hora: '2026-09-20T09:00:00Z', utilizador: { nome: 'Ana Silva' } },
    { acao: 'criar_documento', data_hora: '2026-09-19T18:00:00Z', utilizador: { nome: 'Bruno Costa' } },
    { acao: '2fa_verificado', data_hora: '2026-09-19T17:00:00Z' },
    { acao: 'gerar_quotas', data_hora: '2026-09-18T12:00:00Z', utilizador: { nome: 'Ana Silva' } },
    { acao: 'terminar_sessao', data_hora: '2026-09-18T11:00:00Z' },
    { acao: 'exportacao_dados', data_hora: '2026-09-18T10:00:00Z' },
    { acao: 'recomendacao_dispensada', data_hora: '2026-09-18T09:00:00Z' },
    { acao: 'criar_aviso', data_hora: '2026-09-17T09:00:00Z' },
    { acao: 'criar_assembleia', data_hora: '2026-09-16T09:00:00Z' },
    { acao: 'criar_utilizador', data_hora: '2026-09-15T09:00:00Z' },
    { acao: 'configurar_smtp', data_hora: '2026-09-14T09:00:00Z' },
  ];
  const itens = atividadeRecente(registos, 5);
  assert.strictEqual(itens.length, 5, 'no máximo 5 itens');
  assert.deepStrictEqual(itens.map((i) => i.acao), ['registar_pagamento', 'criar_documento', 'gerar_quotas', 'criar_aviso', 'criar_assembleia'],
    'só eventos úteis e pela ordem em que chegaram (mais recentes primeiro)');
  for (const i of itens) {
    assert.ok(i.rotulo && i.icone && i.url, `atividade «${i.acao}»: tem rótulo, ícone e destino`);
    assert.ok(i.data, `atividade «${i.acao}»: tem data`);
  }
  assert.strictEqual(itens[0].autor, 'Ana Silva', 'atividade: mostra quem fez a ação');
  // Sem autor conhecido não inventa nome.
  const semAutor = atividadeRecente([{ acao: 'criar_aviso', data_hora: '2026-09-17' }], 5);
  assert.strictEqual(semAutor[0].autor, null, 'atividade sem autor fica sem autor');
  // Nada de sessões, 2FA, dispensas de recomendações nem exportações.
  const acoesProibidas = ['inicio_sessao', 'terminar_sessao', '2fa_verificado', '2fa_pedido', 'ativar_2fa', 'desativar_2fa',
    'exportacao_dados', 'recomendacao_dispensada', 'recomendacao_reposta', 'entrar_condominio', 'inicio_saida_condominio'];
  for (const acao of acoesProibidas) {
    assert.ok(!(acao in ATIVIDADE), `atividade: «${acao}» não é apresentada`);
    assert.strictEqual(atividadeRecente([{ acao }], 5).length, 0, `atividade: «${acao}» é filtrada`);
  }
  // Lista vazia e entradas inválidas.
  assert.deepStrictEqual(atividadeRecente([], 5), [], 'sem registos, lista vazia');
  assert.deepStrictEqual(atividadeRecente(null, 5), [], 'sem lista não rebenta');
  assert.deepStrictEqual(atividadeRecente([null, {}, { acao: 'acao_desconhecida' }], 5), [], 'registos inúteis são descartados');
  // Todos os destinos são páginas internas de administração.
  for (const [acao, info] of Object.entries(ATIVIDADE)) {
    assert.ok(info.url.startsWith('/admin/'), `atividade «${acao}»: destino interno (${info.url})`);
    assert.ok(info.rotulo && info.icone, `atividade «${acao}»: rótulo e ícone`);
  }
  console.log(`  ✓ atividade recente: ${Object.keys(ATIVIDADE).length} eventos úteis, sem sessões/2FA/exportações`);
}

// ── 6. Isolamento e não-exposição (fonte do handler e da vista) ───
function testeIsolamento() {
  const rota = ler('routes/admin.js');
  const blocoDashboard = rota.slice(rota.indexOf("router.get('/', async"), rota.indexOf('// FRAÇÕES'));
  assert.ok(blocoDashboard.length > 500, 'handler do painel localizado');
  // Todas as consultas novas levam o condomínio ativo.
  for (const consulta of ['Quota.count({ where: onde(req,', 'Assembleia.findAll({', 'Documento.count({ where: onde(req,', 'Pagamento.count({ where: onde(req,']) {
    assert.ok(blocoDashboard.includes(consulta), `painel: consulta com âmbito do condomínio (${consulta})`);
  }
  assert.ok(/onde\(req, \{ disponivel_condominos: false/.test(blocoDashboard),
    'painel: documentos por disponibilizar filtrados pelo condomínio');
  assert.ok(/onde\(req, \{ estado: \{ \[Op\.in\]: \['agendada', 'convocada'\] \}/.test(blocoDashboard),
    'painel: assembleias futuras usam os estados reais (agendada/convocada)');
  assert.ok(/onde\(req, \{ ano: anoCorrente, mes: mesCorrente, estado: \{ \[Op\.ne\]: 'anulada' \} \}/.test(blocoDashboard),
    'painel: quotas do mês com a mesma lógica da geração de quotas');
  assert.ok(/onde\(req, \{ estado: 'confirmado', comprovativo_estado: 'pendente' \}\)/.test(blocoDashboard),
    'painel: comprovativos por validar com o critério do módulo de comprovativos');
  // Atividade: audit_logs não tem condominio_id → âmbito pelos utilizadores do condomínio.
  assert.ok(/UserCondominio\.findAll\(\{\s*where: \{ condominio_id: req\.condominioId \}/.test(blocoDashboard),
    'painel: atividade limitada aos utilizadores do condomínio ativo');
  assert.ok(/where: \{ user_id: \{ \[Op\.in\]: utilizadoresDoCondominio \} \}/.test(blocoDashboard),
    'painel: consulta de auditoria com âmbito definido');
  assert.ok(/utilizadoresDoCondominio\.length\s*\n?\s*\? AuditLog\.findAll/.test(blocoDashboard),
    'painel: sem utilizadores associados não se consulta auditoria');
  // Nada de dados pessoais desnecessários na atividade.
  assert.ok(/attributes: \['id', 'nome'\], required: false/.test(blocoDashboard),
    'painel: da atividade só se lê o nome de quem fez a ação');
  assert.ok(!/attributes: \[[^\]]*'email'/.test(blocoDashboard), 'painel: não lê emails para a atividade');
  assert.ok(blocoDashboard.includes('dashboardHelpers.sinaisDeAtencao(') && blocoDashboard.includes('dashboardHelpers.atividadeRecente('),
    'painel: a decisão dos sinais e da atividade é do ajudante');

  // A vista não apresenta dívida individual de condóminos na secção nova.
  const vista = ler('views/admin/dashboard.handlebars');
  const blocoAtencao = vista.slice(vista.indexOf('Precisa de atenção'), vista.indexOf('TOP DEVEDORES'));
  assert.ok(blocoAtencao.length > 300, 'bloco «Precisa de atenção» localizado');
  assert.ok(!/fraç(ão|oes)|fracao_id|pessoa|condómino/i.test(blocoAtencao),
    'painel: os sinais não identificam frações nem condóminos');
  assert.ok(/href="\{\{destino\.url\}\}"/.test(vista), 'painel: cada sinal leva à ação');
  assert.ok(!/\{\{detalhes\}\}|\{\{json/.test(vista.slice(vista.indexOf('Atividade recente'), vista.indexOf('SERVIÇOS E DOCUMENTAÇÃO'))),
    'painel: a atividade não despeja os detalhes técnicos do registo');
  console.log('  ✓ isolamento por condomínio e nada de dívida individual no painel');
}

// ── 7. A vista apresenta os dois blocos com estado vazio ──────────
function testeVista() {
  const vista = ler('views/admin/dashboard.handlebars');
  assert.ok(vista.includes('Precisa de atenção'), 'vista: secção de sinais');
  assert.ok(/class="atencao-sinal atencao-\{\{gravidade\}\}"/.test(vista), 'vista: sinal é uma ligação com gravidade');
  assert.ok(vista.includes('Nada a tratar neste momento.'), 'vista: estado tranquilo quando não há sinais');
  assert.ok(vista.includes('Próximas assembleias') && vista.includes('Atividade recente'),
    'vista: blocos de assembleias e de atividade');
  assert.ok(vista.includes('Sem assembleias futuras agendadas.') && vista.includes('Sem atividade registada neste condomínio.'),
    'vista: estados vazios simples nos dois blocos');
  assert.ok(vista.includes('{{formatDate data}}') && vista.includes('{{formatDateTime data}}'),
    'vista: datas formatadas (e não em bruto)');
  // O estado dos serviços continua num só sítio (o cartão «Estado do
  // condomínio»), sem duplicação na nova secção de sinais.
  const ocorrencias = (vista.match(/armazenamentoRotulo/g) || []).length;
  assert.strictEqual(ocorrencias, 1, `vista: o estado do armazenamento aparece uma só vez (${ocorrencias})`);
  // Documentos e backups são linhas SEPARADAS: um condomínio com o serviço de
  // documentos ligado não pode aparecer como «Desligado» só porque a ligação da
  // plataforma (a dos backups) não existe.
  for (const linha of ['Documentos:', 'Cópias de segurança:', 'Último backup:', 'Email/SMTP:']) {
    assert.ok(vista.includes(linha), `vista: linha «${linha}» no cartão do estado`);
  }
  assert.ok(vista.includes('○ Apenas local'), 'vista: sem cloud de backups mostra «Apenas local»');
  assert.ok(vista.includes('{{sistema.backups.cloud.rotulo}}'), 'vista: nomeia o serviço que recebe a cópia cloud');
  assert.ok(vista.includes('formatDate sistema.ultimoBackup.data'), 'vista: o último backup mostra a data');
  assert.ok(!/○ Desligado/.test(vista), 'vista: os backups nunca são apresentados como «Desligado»');
  const blocoAtencaoVista = vista.slice(vista.indexOf('Precisa de atenção'), vista.indexOf('TOP DEVEDORES'));
  assert.ok(!/armazenamentoRotulo|sistema\.smtp/.test(blocoAtencaoVista),
    'vista: a secção de sinais não repete o estado dos serviços');
  const css = ler('public/css/styles.css');
  for (const classe of ['.atencao-lista', '.atencao-sinal', '.atencao-critico', '.atencao-atencao', '.atencao-info', '.painel-linha']) {
    assert.ok(css.includes(classe), `css: classe ${classe} definida`);
  }
  assert.ok(/\.atencao-sinal \{[^}]*min-height: 48px/.test(css), 'css: cada sinal é um alvo de toque de 48px');
  assert.ok(/\.painel-linha \{[^}]*min-height: 48px/.test(css), 'css: as linhas de lista são alvos de 48px');
  console.log('  ✓ vista e estilos com os dois blocos, estados vazios e alvos de 48px');
}

testeSemSinais();
testeSinaisIndividuais();
testePrioridade();
testeOrcamentoPorConcluir();
testeAtividade();
testeIsolamento();
testeVista();
console.log('✓ Testes do painel acionável passaram (sem base de dados).');
