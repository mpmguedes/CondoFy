// ═══════════════════════════════════════════════════════════════════
// Tips contextuais — DISPENSA, ISOLAMENTO E CONDIÇÕES (sem base de dados).
//
// O que este teste protege, e que nenhum outro protege:
//   · REGRESSÃO: nenhuma operação sobre `RecomendacaoEstado` pode referir a
//     coluna `condominio_id`. Essa coluna NÃO existe — a migração
//     20260101000073 omite-a de propósito e o índice é `(user_id, recomendacao)`.
//     Uma consulta a uma coluna inexistente rebenta com ER_BAD_FIELD_ERROR na
//     BD real, e a rota do portal (/condomino) não tem try/catch: derrubava a
//     página principal do condómino. Este teste falha com a implementação
//     anterior (que filtrava/gravava `condominio_id`).
//   · ISOLAMENTO por condomínio: o âmbito vive na CHAVE (`tip:<id>@c<id>`), pelo
//     que dispensar no condomínio A não esconde o mesmo tip no B.
//   · ISOLAMENTO por utilizador: a leitura e a escrita são sempre da conta certa.
//   · CONDIÇÕES de backup/armazenamento: verdadeiras → aparece; falsas → não
//     aparece; contexto incompleto → não se inventa nada.
//   · NÃO DUPLICAÇÃO, prioridade, áreas e âmbito.
//   · Ação/destino FIXOS no servidor: um identificador manipulado é recusado.
//
// Utilização: node scripts/test-tips-isolamento.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

// ── Modelo em duplo, com captura de tudo o que é pedido ─────────────
// Instalado ANTES de carregar os motores (ambos resolvem `RecomendacaoEstado`
// no momento do require).
const operacoes = [];
const modelsPath = require.resolve(path.join(__dirname, '..', 'models'));
const registroFalso = {
  update: async (valores) => { operacoes.push({ op: 'update', dados: valores }); return registroFalso; },
};
const duplo = {
  findAll: async (opcoes) => { operacoes.push({ op: 'findAll', dados: opcoes }); return []; },
  findOne: async (opcoes) => {
    operacoes.push({ op: 'findOne', dados: opcoes });
    // Devolve um registo existente só quando o teste o pede (ver `comExistente`).
    return duplo.existente ? registroFalso : null;
  },
  create: async (valores) => { operacoes.push({ op: 'create', dados: valores }); return valores; },
  destroy: async (opcoes) => { operacoes.push({ op: 'destroy', dados: opcoes }); return 0; },
  existente: false,
};
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: { RecomendacaoEstado: duplo },
};

const tips = require('../helpers/tips');
const rec = require('../helpers/recomendacoes');

const CID = 12;
const OUTRO = 13;
const DIA = 24 * 60 * 60 * 1000;
const AGORA = Date.parse('2026-09-21T10:00:00.000Z');

let seccao = '';
function titulo(t) { seccao = t; console.log('\n── ' + t); }
const ok = (nome) => console.log('  ✓ ' + nome);

// Um condomínio em ordem: nada a sugerir. Cada teste acrescenta só o que quer
// provar, para que a condição testada seja a única diferença.
const BASE = {
  condominioId: CID,
  papel: 'admin',
  agora: AGORA,
  fracoes: { n: 12, permilagemTotal: 1000, permilagemOk: true, semTitular: 0 },
  contas: { n: 2, fundoReserva: 1 },
  assembleias: { realizadasSemAta: 0 },
  backup: { destino: 'google_drive', temLigacoes: true, usavel: true, estado: 'local_com_cloud', diasDesde: 1 },
};

const ids = (extra = {}) => tips.elegiveis({ ...BASE, ...extra }).map((t) => t.id);

// ── 1. REGRESSÃO: nenhuma coluna `condominio_id` ────────────────────
async function testeSemColunaInexistente() {
  operacoes.length = 0;

  // Os DOIS motores que partilham a tabela, em todos os caminhos de escrita e
  // de leitura.
  await tips.carregarDispensas(7);
  await tips.registarDispensa({ userId: 7, tip: 'fracoes_por_definir', condominioId: CID });
  await rec.carregarDispensas(7);
  await rec.registarDispensa({ userId: 7, recomendacao: '2fa_ativo' });

  // Caminho de atualização (registo já existente).
  duplo.existente = true;
  await tips.registarDispensa({ userId: 7, tip: 'fracoes_por_definir', condominioId: CID });
  await rec.registarDispensa({ userId: 7, recomendacao: '2fa_ativo' });
  duplo.existente = false;

  assert.ok(operacoes.length >= 6, 'as operações foram exercitadas');

  // Recolha de chaves INCLUINDO símbolos, e recursão também PELOS VALORES das
  // chaves-símbolo: `where[Op.or]` é uma chave-símbolo cujo valor é uma lista de
  // objetos — um `Object.keys` simples não vê a chave, e recursar só por chaves
  // de texto não vê o que está lá dentro. Foi exatamente por aí que a
  // implementação anterior escapava a uma inspeção desprevenida.
  const chaves = new Set();
  (function recolher(valor, vistos = new Set()) {
    if (!valor || typeof valor !== 'object') return;
    if (vistos.has(valor)) return;
    vistos.add(valor);
    const chavesDeTexto = Object.keys(valor);
    const chavesSimbolo = Object.getOwnPropertySymbols(valor);
    for (const k of chavesDeTexto) chaves.add(k);
    for (const s of chavesSimbolo) chaves.add(String(s));
    for (const k of chavesDeTexto) recolher(valor[k], vistos);
    for (const s of chavesSimbolo) recolher(valor[s], vistos);
  })(operacoes);

  const proibidas = [...chaves].filter((k) => /condominio_id/i.test(k));
  assert.deepStrictEqual(proibidas, [],
    `nenhuma operação pode referir condominio_id (encontrado: ${proibidas.join(', ')})`);

  // E o âmbito tem de estar na CHAVE, não numa coluna.
  const escritas = operacoes.filter((o) => o.op === 'create' || o.op === 'update');
  const chavesGravadas = escritas.map((o) => o.dados.recomendacao);
  assert.ok(chavesGravadas.includes(`tip:fracoes_por_definir@c${CID}`),
    'a dispensa do tip é gravada com a chave qualificada pelo condomínio');
  assert.ok(chavesGravadas.includes('2fa_ativo'),
    'a recomendação do portal continua a ser gravada com a chave simples');
  ok('nenhuma operação usa `condominio_id`; o âmbito vive na chave');
}

// ── 2. Chave com âmbito: o mesmo tip em dois condomínios ────────────
async function testeChavePorCondominio() {
  const a = tips.chaveDeDispensa('fracoes_por_definir', CID);
  const b = tips.chaveDeDispensa('fracoes_por_definir', OUTRO);
  assert.strictEqual(a, `tip:fracoes_por_definir@c${CID}`, 'a chave tem o formato tip:<id>@c<id>');
  assert.notStrictEqual(a, b, 'a mesma tip em condomínios diferentes tem chaves diferentes');
  assert.ok(a.length <= 60, 'a chave cabe na coluna recomendacao (STRING(60))');

  // Sem condomínio válido não há chave — logo não há dispensa possível.
  for (const c of [null, undefined, 0, -3, 'x', 1.5, NaN]) {
    assert.strictEqual(tips.chaveDeDispensa('fracoes_por_definir', c), null,
      `sem condomínio válido (${String(c)}) não há chave de dispensa`);
  }

  // Funcional: dispensado no condomínio A, continua elegível no B.
  const dispensasA = { [a]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA) } };
  const semFracoes = { fracoes: { n: 0, permilagemTotal: 0, permilagemOk: true, semTitular: 0 } };
  const emA = tips.elegiveis({ ...BASE, ...semFracoes }, dispensasA).map((t) => t.id);
  const emB = tips.elegiveis({ ...BASE, ...semFracoes, condominioId: OUTRO }, dispensasA).map((t) => t.id);
  assert.ok(!emA.includes('fracoes_por_definir'), 'dispensado no condomínio A: não aparece em A');
  assert.ok(emB.includes('fracoes_por_definir'), 'dispensado em A: continua a aparecer em B');
  ok('a dispensa é por condomínio (não vaza de A para B)');
}

// ── 3. Isolamento por utilizador ───────────────────────────────────
async function testeIsolamentoPorUtilizador() {
  // A leitura e a escrita levam SEMPRE o `user_id` pedido, e só esse.
  for (const userId of [7, 8]) {
    operacoes.length = 0;
    await tips.carregarDispensas(userId);
    const leitura = operacoes.find((o) => o.op === 'findAll');
    assert.strictEqual(leitura.dados.where.user_id, userId, `a leitura é da conta ${userId}`);

    operacoes.length = 0;
    await tips.registarDispensa({ userId, tip: 'fracoes_por_definir', condominioId: CID });
    const escrita = operacoes.find((o) => o.op === 'create');
    assert.strictEqual(escrita.dados.user_id, userId, `a escrita é da conta ${userId}`);
    assert.strictEqual(escrita.dados.recomendacao, `tip:fracoes_por_definir@c${CID}`,
      'a chave é a mesma para as duas contas — o que as separa é o user_id');
  }

  // Sem conta não se lê nem se escreve nada.
  assert.deepStrictEqual(await tips.carregarDispensas(null), {}, 'sem conta não há dispensas');
  assert.deepStrictEqual(await tips.carregarDispensas(0), {}, 'user_id 0 não é conta');
  const semConta = await tips.registarDispensa({ userId: null, tip: 'fracoes_por_definir', condominioId: CID });
  assert.strictEqual(semConta.ok, false, 'sem conta não se regista dispensa');
  ok('a dispensa é por utilizador (leitura e escrita sempre da conta certa)');
}

// ── 4. Portal e administração não colidem na tabela partilhada ─────
function testeSemCruzamento() {
  assert.strictEqual(tips.podeDispensar('2fa_ativo'), false, 'o motor de tips recusa a recomendação do portal');
  assert.strictEqual(rec.podeDispensar('permilagem_incompleta'), false, 'o motor do portal recusa um tip');
  for (const d of tips.definicoes()) {
    assert.strictEqual(rec.porId(d.id), null, `«${d.id}» não colide com uma recomendação do portal`);
    assert.ok(tips.chaveDeDispensa(d.id, CID).startsWith('tip:'), `a chave de «${d.id}» é namespaced`);
  }
  ok('um identificador de um motor nunca é aceite pelo outro');
}

// ── 5. Ação fixa no servidor: identificador manipulado ─────────────
async function testeIdentificadorManipulado() {
  const maliciosos = [
    '', 'inexistente', '../../etc/passwd', 'https://exemplo.pt', '2fa_ativo',
    'fracoes_por_definir ', 'FRACOES_POR_DEFINIR', 'tip:fracoes_por_definir@c12',
    'constructor', '__proto__', null, undefined,
  ];
  for (const id of maliciosos) {
    assert.strictEqual(tips.podeDispensar(id), false, `«${String(id)}» não pode ser dispensado`);
    operacoes.length = 0;
    const r = await tips.registarDispensa({ userId: 7, tip: id, condominioId: CID });
    assert.strictEqual(r.ok, false, `«${String(id)}»: escrita recusada`);
    assert.strictEqual(operacoes.length, 0, `«${String(id)}»: nada foi escrito`);
  }

  // Toda a ação vem da definição e é interna.
  for (const d of tips.definicoes()) {
    const acao = tips.porId(d.id).acao;
    assert.ok(acao && acao.url && acao.texto, `«${d.id}» tem ação completa`);
    assert.ok(acao.url.startsWith('/admin'), `«${d.id}» aponta para dentro do backoffice`);
    assert.ok(!/^https?:/i.test(acao.url), `«${d.id}» não aponta para fora`);
  }
  ok('identificador manipulado → recusado; ação sempre da definição e interna');
}

// ── 6. Prioridade, limite e ordem determinística ───────────────────
function testePrioridade() {
  assert.ok(tips.PRIORIDADE.risco > tips.PRIORIDADE.aviso, 'risco acima de aviso');
  assert.ok(tips.PRIORIDADE.aviso > tips.PRIORIDADE.conclusao, 'aviso acima de por completar');
  assert.ok(tips.PRIORIDADE.conclusao > tips.PRIORIDADE.compreensao, 'por completar acima de vale a pena saber');
  assert.ok(tips.PRIORIDADE.compreensao > tips.PRIORIDADE.descoberta, 'vale a pena saber acima de descoberta');

  // Cenário com vários tips ao mesmo tempo: a ordem é por prioridade e é
  // determinística (empates pela ordem do registo).
  const cheio = {
    ...BASE,
    fracoes: { n: 12, permilagemTotal: 765, permilagemOk: false, semTitular: 2 },
    contas: { n: 0, fundoReserva: 0 },
    assembleias: { realizadasSemAta: 1 },
    backup: { destino: null, temLigacoes: true, usavel: false, estado: 'sem_historico' },
  };
  const lista = tips.elegiveis(cheio);
  assert.ok(lista.length >= 4, 'várias situações elegíveis ao mesmo tempo');
  for (let i = 1; i < lista.length; i += 1) {
    assert.ok(lista[i - 1].prioridade >= lista[i].prioridade,
      `a ordem é decrescente por prioridade (${lista[i - 1].id} → ${lista[i].id})`);
  }
  const escolha = tips.escolher(cheio);
  assert.strictEqual(escolha.apresentar.length, tips.LIMITE_APRESENTACAO,
    'apresenta no máximo o limite do motor');
  assert.strictEqual(escolha.total, lista.length, 'o total conta todas as elegíveis');
  assert.strictEqual(escolha.apresentar.length + escolha.outras.length, escolha.total,
    'as restantes ficam identificadas, sem serem apresentadas');
  // A mesma entrada dá sempre a mesma ordem.
  assert.deepStrictEqual(tips.elegiveis(cheio).map((t) => t.id), lista.map((t) => t.id),
    'a ordem é determinística');
  ok('prioridade decrescente, limite respeitado, ordem determinística');
}

// ── 7. Áreas: um tip não aparece em qualquer página ────────────────
function testeAreas() {
  const comProblema = { ...BASE, backup: { destino: 'google_drive', temLigacoes: true, usavel: true, estado: 'erro', diasDesde: 0 } };

  // Na área de armazenamento, os tips de armazenamento são elegíveis.
  const naArea = tips.elegiveis({ ...comProblema, area: 'armazenamento' }).map((t) => t.id);
  assert.ok(naArea.includes('backup_ultimo_falhou'), 'na página de armazenamento o tip do backup aparece');

  // Noutra área, os tips que declaram `areas` NÃO aparecem.
  const noPainel = tips.elegiveis({ ...comProblema, area: 'inicio' }).map((t) => t.id);
  assert.ok(!noPainel.includes('backup_ultimo_falhou'), 'no painel o tip do backup NÃO aparece');
  assert.ok(!noPainel.includes('armazenamento_estrutura_por_provedor'), 'nem o educativo do armazenamento');

  // Um tip SEM `areas` (os do condomínio) aparece em qualquer área.
  const semFracoes = { fracoes: { n: 0, permilagemTotal: 0, permilagemOk: true, semTitular: 0 } };
  for (const area of ['inicio', 'armazenamento', 'documentos']) {
    assert.ok(tips.elegiveis({ ...BASE, ...semFracoes, area }).map((t) => t.id).includes('fracoes_por_definir'),
      `um tip sem \`areas\` aparece na área «${area}»`);
  }

  // Sem área indicada não se filtra (comportamento anterior preservado).
  assert.ok(tips.elegiveis(comProblema).map((t) => t.id).includes('backup_ultimo_falhou'),
    'sem `ctx.area` não se filtra por área');
  assert.ok(tips.aceitaArea({ areas: null }, 'inicio'), 'tip sem `areas` passa em qualquer área');
  assert.ok(!tips.aceitaArea({ areas: ['armazenamento'] }, 'inicio'), 'área errada: não passa');
  assert.ok(tips.aceitaArea({ areas: ['armazenamento'] }, null), 'sem área indicada: passa');
  ok('as `areas` restringem os tips à sua página');
}

// ── 8. Âmbito: instalação vs condomínio ────────────────────────────
function testeAmbito() {
  assert.strictEqual(tips.ambitoDe({ ambito: 'instalacao' }), 'instalacao', 'âmbito de instalação reconhecido');
  assert.strictEqual(tips.ambitoDe({}), 'condominio', 'sem âmbito declarado assume condomínio');
  assert.strictEqual(tips.ambitoDe({ ambito: 'inexistente' }), 'condominio', 'âmbito inválido assume condomínio');

  const ctx = {
    ...BASE,
    area: 'armazenamento',
    fracoes: { n: 0, permilagemTotal: 0, permilagemOk: true, semTitular: 0 },
    backup: { destino: 'google_drive', temLigacoes: true, usavel: true, estado: 'erro', diasDesde: 0 },
  };
  const soInstalacao = tips.elegiveis({ ...ctx, ambito: 'instalacao' }).map((t) => t.id);
  const soCondominio = tips.elegiveis({ ...ctx, ambito: 'condominio' }).map((t) => t.id);
  assert.ok(soInstalacao.includes('backup_ultimo_falhou'), 'âmbito instalação inclui o tip do backup');
  assert.ok(!soInstalacao.includes('fracoes_por_definir'), 'âmbito instalação exclui o tip do condomínio');
  assert.ok(soCondominio.includes('fracoes_por_definir'), 'âmbito condomínio inclui o tip das frações');
  assert.ok(!soCondominio.includes('backup_ultimo_falhou'), 'âmbito condomínio exclui o tip da instalação');

  const ambos = tips.elegiveis({ ...ctx, ambito: ['condominio', 'instalacao'] }).map((t) => t.id);
  assert.ok(ambos.includes('fracoes_por_definir') && ambos.includes('backup_ultimo_falhou'),
    'uma lista de âmbitos aceita os dois');

  assert.ok(tips.aceitaAmbito({ ambito: 'instalacao' }, undefined), 'sem âmbito pedido não se filtra');
  assert.ok(tips.aceitaAmbito({ ambito: 'instalacao' }, []), 'lista vazia não filtra');
  ok('o âmbito filtra os tips quando a página o pede');
}

// ── 9. Condições dos tips de backup: verdadeiras e falsas ──────────
function testeCondicoesDeBackup() {
  const umDe = (id, ctx) => tips.elegiveis(ctx).find((t) => t.id === id) || null;
  const ARMAZ = { area: 'armazenamento' };

  // (1) O último backup falhou.
  assert.ok(umDe('backup_ultimo_falhou', { ...BASE, ...ARMAZ, backup: { ...BASE.backup, estado: 'erro' } }),
    'estado «erro» → aparece');
  assert.strictEqual(umDe('backup_ultimo_falhou', { ...BASE, ...ARMAZ }), null, 'estado «local_com_cloud» → não aparece');

  // (2) Sem backups recentes.
  const desatualizado = umDe('backup_desatualizado', {
    ...BASE, ...ARMAZ, backup: { ...BASE.backup, estado: 'local_com_cloud', diasDesde: 30 },
  });
  assert.ok(desatualizado, '30 dias sem backup → aparece');
  assert.ok(/30 dias/.test(desatualizado.mensagem), 'a mensagem diz quantos dias');
  assert.strictEqual(umDe('backup_desatualizado', {
    ...BASE, ...ARMAZ, backup: { ...BASE.backup, estado: 'local_com_cloud', diasDesde: 1 },
  }), null, 'backup de ontem → não aparece');
  assert.strictEqual(umDe('backup_desatualizado', {
    ...BASE, ...ARMAZ, backup: { ...BASE.backup, estado: 'em_curso' },
  }), null, 'backup a decorrer → não aparece (nada a recomendar)');
  assert.ok(umDe('backup_desatualizado', { ...BASE, ...ARMAZ, backup: { ...BASE.backup, estado: 'sem_historico' } }),
    'sem histórico → aparece, a explicar que não há backups');

  // (3) Destino sem ligação utilizável.
  const semLigacao = umDe('backup_destino_sem_ligacao', {
    ...BASE, ...ARMAZ, backup: { destino: 'dropbox', temLigacoes: true, usavel: false, estado: 'local', diasDesde: 1 },
  });
  assert.ok(semLigacao, 'destino configurado sem ligação → aparece');
  assert.ok(/Dropbox/.test(semLigacao.mensagem), 'a mensagem nomeia o serviço escolhido');
  assert.strictEqual(umDe('backup_destino_sem_ligacao', { ...BASE, ...ARMAZ }), null,
    'destino com ligação utilizável → não aparece');
  assert.strictEqual(umDe('backup_destino_sem_ligacao', {
    ...BASE, ...ARMAZ, backup: { destino: 'dropbox', temLigacoes: true, estado: 'local' },
  }), null, '`usavel` ausente → não se inventa a situação');
  assert.strictEqual(umDe('backup_destino_sem_ligacao', {
    ...BASE, ...ARMAZ, backup: { destino: null, temLigacoes: true, usavel: false, estado: 'local' },
  }), null, 'sem destino escolhido não é este o tip que fala');

  // (4) A cópia cloud do último backup não foi criada.
  assert.ok(umDe('backup_cloud_nao_criada', {
    ...BASE, ...ARMAZ, backup: { ...BASE.backup, estado: 'local_copia_cloud_falhada' },
  }), 'cópia cloud falhada → aparece');
  assert.strictEqual(umDe('backup_cloud_nao_criada', { ...BASE, ...ARMAZ }), null, 'cópia cloud feita → não aparece');

  // (5) Há um serviço ligado que podia receber os backups.
  const alternativo = umDe('backup_servico_ligado_sem_uso', {
    ...BASE,
    ...ARMAZ,
    backup: { destino: 'google_drive', temLigacoes: true, usavel: true, estado: 'local_com_cloud', diasDesde: 1 },
    armazenamento: { provedores: [{ nome: 'google_drive', ligado: true }, { nome: 'onedrive', ligado: true }] },
  });
  assert.ok(alternativo, 'há outro serviço ligado → aparece');
  assert.ok(/OneDrive/.test(alternativo.mensagem), 'a mensagem nomeia o serviço alternativo');
  assert.strictEqual(umDe('backup_servico_ligado_sem_uso', {
    ...BASE,
    ...ARMAZ,
    backup: { destino: 'google_drive', temLigacoes: true, usavel: true, estado: 'local_com_cloud', diasDesde: 1 },
    armazenamento: { provedores: [{ nome: 'google_drive', ligado: true }] },
  }), null, 'só o serviço já escolhido → não aparece');
  assert.strictEqual(umDe('backup_servico_ligado_sem_uso', {
    ...BASE, ...ARMAZ, backup: { destino: null, temLigacoes: true, estado: 'local', diasDesde: 1 },
    armazenamento: { provedores: [{ nome: 'onedrive', ligado: true }] },
  }), null, 'sem destino escolhido quem fala é `backup_sem_copia_externa`');

  // (6) Documentos e backups: só na área de armazenamento.
  assert.ok(umDe('armazenamento_documentos_e_backups', { ...BASE, area: 'armazenamento' }),
    'na página de armazenamento explica a diferença');
  assert.strictEqual(umDe('armazenamento_documentos_e_backups', { ...BASE, area: 'inicio' }), null,
    'noutra área não se explica isto');

  // (7) Estrutura de pastas por provedor.
  const estrutura = umDe('armazenamento_estrutura_por_provedor', {
    ...BASE, ...ARMAZ, armazenamento: { provedores: [{ nome: 'onedrive', ligado: true }] },
  });
  assert.ok(estrutura, 'com um serviço ligado, explica a estrutura de pastas');
  assert.ok(/OneDrive/.test(estrutura.mensagem), 'nomeia os serviços ligados');
  assert.ok(!/Dropbox/.test(estrutura.mensagem), 'não fala de serviços que não estão ligados');
  // A limitação da Dropbox só é dita quando a Dropbox é o destino escolhido.
  const comDropbox = umDe('armazenamento_estrutura_por_provedor', {
    ...BASE,
    ...ARMAZ,
    backup: { destino: 'dropbox', temLigacoes: true, usavel: true, estado: 'local_com_cloud', diasDesde: 1 },
    armazenamento: { provedores: [{ nome: 'dropbox', ligado: true }] },
  });
  assert.ok(/não consegue remover ficheiros/.test(comDropbox.mensagem),
    'com a Dropbox como destino, a limitação real é dita');
  assert.strictEqual(umDe('armazenamento_estrutura_por_provedor', { ...BASE, ...ARMAZ }), null,
    'sem nenhum serviço ligado não há estrutura a explicar');
  ok('as condições de backup são verdadeiras/falsas como documentado');
}

// ── 10. Contexto incompleto / estado inexistente ───────────────────
function testeContextoIncompleto() {
  const armaz = ['backup_ultimo_falhou', 'backup_desatualizado', 'backup_destino_sem_ligacao',
    'backup_cloud_nao_criada', 'backup_servico_ligado_sem_uso', 'armazenamento_estrutura_por_provedor'];

  // Sem `backup` nenhum: nenhum tip de backup aparece (nada de avisos falsos).
  for (const ctx of [{}, { condominioId: CID, papel: 'admin', area: 'armazenamento' },
    { ...BASE, area: 'armazenamento', backup: undefined }]) {
    const lista = tips.elegiveis(ctx).map((t) => t.id);
    for (const id of armaz) {
      assert.ok(!lista.includes(id), `contexto sem backup (${JSON.stringify(ctx.area || null)}): «${id}» não aparece`);
    }
  }

  // Estado de backup desconhecido: só o tip que fala de histórico pode aparecer.
  const desconhecido = ids({ ...BASE, area: 'armazenamento', backup: { ...BASE.backup, estado: 'estado_que_nao_existe' } });
  assert.ok(!desconhecido.includes('backup_ultimo_falhou'), 'estado desconhecido não vira «falhou»');
  assert.ok(!desconhecido.includes('backup_cloud_nao_criada'), 'estado desconhecido não vira «cópia cloud falhada»');
  assert.ok(!desconhecido.includes('backup_desatualizado'), 'estado desconhecido não vira «desatualizado»');

  // Estado de provedor inexistente: nada de nomes inventados.
  const semProvedores = tips.elegiveis({
    ...BASE, area: 'armazenamento', armazenamento: { provedores: [{ nome: null }, null, {}] },
    backup: { destino: null, temLigacoes: true, usavel: false, estado: 'local', diasDesde: 1 },
  });
  const nomes = semProvedores.map((t) => t.mensagem).join(' ');
  assert.ok(!/undefined|null/.test(nomes), 'nenhuma mensagem mostra «undefined»/«null»');
  assert.strictEqual(tips.porId('nao_existe'), null, 'um tip inexistente não existe');
  assert.strictEqual(tips.podeDispensar('nao_existe'), false, 'um tip inexistente não pode ser dispensado');
  ok('contexto incompleto e estados desconhecidos não inventam situações');
}

// ── 11. Não duplicação ─────────────────────────────────────────────
function testeSemDuplicados() {
  const definicoes = tips.definicoes();
  const todos = definicoes.map((d) => d.id);
  assert.strictEqual(new Set(todos).size, todos.length, 'não há identificadores repetidos');

  const tem = (ctx, id) => tips.elegiveis(ctx).some((t) => t.id === id);
  const ARMAZ = { area: 'armazenamento' };

  // «Falhou» e «desatualizado» nunca aparecem juntos: o segundo cala-se quando
  // o primeiro fala.
  for (const estado of ['erro', 'local_copia_cloud_falhada']) {
    const ctx = { ...BASE, ...ARMAZ, backup: { ...BASE.backup, estado, diasDesde: 40 } };
    assert.ok(tem(ctx, estado === 'erro' ? 'backup_ultimo_falhou' : 'backup_cloud_nao_criada'),
      `estado «${estado}»: o tip específico aparece`);
    assert.ok(!tem(ctx, 'backup_desatualizado'), `estado «${estado}»: o tip genérico cala-se`);
  }

  // «Sem destino» e «serviço ligado sem uso» são mutuamente exclusivos.
  const semDestino = { ...BASE, ...ARMAZ, backup: { destino: null, temLigacoes: true, usavel: false, estado: 'local', diasDesde: 1 },
    armazenamento: { provedores: [{ nome: 'onedrive', ligado: true }] } };
  assert.ok(tem(semDestino, 'backup_sem_copia_externa'), 'sem destino: aparece o tip do destino');
  assert.ok(!tem(semDestino, 'backup_servico_ligado_sem_uso'), 'sem destino: o outro cala-se');

  const comDestino = { ...BASE, ...ARMAZ, backup: { destino: 'google_drive', temLigacoes: true, usavel: true, estado: 'local_com_cloud', diasDesde: 1 },
    armazenamento: { provedores: [{ nome: 'google_drive', ligado: true }, { nome: 'dropbox', ligado: true }] } };
  assert.ok(tem(comDestino, 'backup_servico_ligado_sem_uso'), 'com destino: aparece o tip do serviço alternativo');
  assert.ok(!tem(comDestino, 'backup_sem_copia_externa'), 'com destino: o outro cala-se');
  ok('nenhuma situação gera dois tips equivalentes');
}

// ── 12. Estado de dispensa ausente/corrompido ─────────────────────
function testeDispensaRobusta() {
  const chave = tips.chaveDeDispensa('fracoes_por_definir', CID);
  const ctx = { ...BASE, fracoes: { n: 0, permilagemTotal: 0, permilagemOk: true, semTitular: 0 } };

  // Registos estranhos nunca escondem por engano.
  for (const registo of [null, {}, { dispensada_ate: null, dispensada_em: null },
    { dispensada_em: 'não é uma data' }, { dispensada_ate: 'também não' }, { intervalo_dias: 'x' }]) {
    const dispensas = { [chave]: registo };
    assert.ok(tips.elegiveis(ctx, dispensas).some((t) => t.id === 'fracoes_por_definir'),
      `registo ${JSON.stringify(registo)}: não esconde por engano`);
  }

  // Sem mapa de dispensas (a leitura falhou) não se esconde nada.
  assert.ok(tips.elegiveis(ctx).some((t) => t.id === 'fracoes_por_definir'), 'sem dispensas: aparece');
  assert.ok(tips.elegiveis(ctx, null).some((t) => t.id === 'fracoes_por_definir'), 'dispensas null: aparece');

  // Uma dispensa em vigor esconde; passado o intervalo volta a aparecer.
  const emVigor = { [chave]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA) } };
  assert.ok(!tips.elegiveis(ctx, emVigor).some((t) => t.id === 'fracoes_por_definir'), 'dispensa em vigor esconde');
  assert.ok(tips.elegiveis({ ...ctx, agora: AGORA + 31 * DIA }, emVigor).some((t) => t.id === 'fracoes_por_definir'),
    'passado o intervalo volta a aparecer');
  ok('estado de dispensa ausente/corrompido nunca esconde por engano');
}

// ── 13. Portal e Administração partilham a tabela SEM colidir ─────
// A prova mais forte: um estado de dispensa REAL e partilhado, exercitado pelos
// DOIS motores, e a verificação de que a decisão de um não muda o que o outro
// apresenta. Um identificador de um motor tem de ser invisível para o outro —
// não basta as chaves serem diferentes: tem de se ver o efeito no utilizador.
async function testeSemColisaoEntreMotores() {
  // Tabela com memória, isolada dos testes anteriores (que usam o duplo de
  // captura). Reinstala-se o duplo e recarrega-se os motores para que ambos
  // resolvam ESTA tabela.
  const linhas = [];
  let seq = 1;
  const estado = {
    async findAll({ where }) { return linhas.filter((l) => l.user_id === where.user_id).map((l) => ({ ...l })); },
    async findOne({ where }) {
      const l = linhas.find((x) => x.user_id === where.user_id && x.recomendacao === where.recomendacao);
      if (!l) return null;
      return { ...l, async update(campos) { Object.assign(l, campos); return l; } };
    },
    async create(campos) { const l = { id: seq, ...campos }; seq += 1; linhas.push(l); return l; },
    async destroy() { return 0; },
  };
  require.cache[modelsPath] = {
    id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
    exports: { RecomendacaoEstado: estado },
  };
  for (const rel of ['../helpers/tips', '../helpers/recomendacoes']) {
    delete require.cache[require.resolve(rel)];
  }
  /* eslint-disable global-require */
  const t = require('../helpers/tips');
  const p = require('../helpers/recomendacoes');
  /* eslint-enable global-require */

  const contextoPortal = (userId) => ({ autenticado: true, userId, twoFaAtivo: false, agora: AGORA });
  const contextoPainel = { ...BASE, fracoes: { n: 0, permilagemTotal: 0, permilagemOk: true, semTitular: 0 } };

  // O utilizador 7 dispensa APENAS a recomendação do portal.
  await p.registarDispensa({ userId: 7, recomendacao: '2fa_ativo', agora: AGORA });
  // O utilizador 8 dispensa APENAS o tip do painel.
  await t.registarDispensa({ userId: 8, tip: 'fracoes_por_definir', condominioId: CID, agora: AGORA });

  assert.strictEqual(linhas.length, 2, 'duas dispensas, uma por motor');
  assert.deepStrictEqual(
    linhas.map((l) => l.recomendacao).sort(),
    ['2fa_ativo', `tip:fracoes_por_definir@c${CID}`].sort(),
    'as chaves dos dois motores convivem na mesma tabela sem se sobreporem'
  );

  // A tabela é PARTILHADA: cada motor lê o mapa todo do utilizador. O que
  // garante a não-colisão não é o mapa vir limpo — é cada motor só consultar as
  // SUAS chaves (o dos tips procura `tip:…@c…`, o portal procura o id nu).
  const d7 = await t.carregarDispensas(7);
  assert.ok(d7['2fa_ativo'], 'tabela partilhada: o mapa do utilizador 7 traz a chave do portal');
  assert.ok(!d7[`tip:fracoes_por_definir@c${CID}`], 'utilizador 7: não tem dispensa própria do painel');
  const p7 = await p.carregarDispensas(7);
  assert.ok(p7['2fa_ativo'], 'o portal vê a sua própria dispensa');
  assert.ok(!p7[`tip:fracoes_por_definir@c${CID}`], 'utilizador 7: o portal não tem dispensa do painel');

  // EFEITO NO UTILIZADOR — a dispensa de um motor não muda o que o outro mostra.
  // Utilizador 7: o portal esconde a recomendação (ele dispensou-a)…
  const portal7 = p.elegiveis(contextoPortal(7), await p.carregarDispensas(7));
  assert.ok(!portal7.some((r) => r.id === '2fa_ativo'), 'utilizador 7: o portal respeita a sua dispensa');
  // …mas o painel continua a mostrar o tip, que ele nunca dispensou.
  assert.ok(
    t.elegiveis(contextoPainel, await t.carregarDispensas(7)).some((x) => x.id === 'fracoes_por_definir'),
    'utilizador 7: a dispensa do PORTAL não esconde o tip do painel'
  );

  // Utilizador 8: o painel esconde o tip (ele dispensou-o)…
  assert.ok(
    !t.elegiveis(contextoPainel, await t.carregarDispensas(8)).some((x) => x.id === 'fracoes_por_definir'),
    'utilizador 8: o painel respeita a sua dispensa'
  );
  // …mas o portal continua a mostrar a recomendação, que ele nunca dispensou.
  const portal8 = p.elegiveis(contextoPortal(8), await p.carregarDispensas(8));
  assert.ok(portal8.some((r) => r.id === '2fa_ativo'),
    'utilizador 8: a dispensa do PAINEL não esconde a recomendação do portal');

  // As chaves de dispensa do painel são namespaced: nunca colidem com um id do
  // portal, mesmo que um dia os nomes coincidam.
  for (const d of t.definicoes()) {
    assert.ok(t.chaveDeDispensa(d.id, CID).startsWith('tip:'), `«${d.id}»: chave namespaced`);
    assert.strictEqual(p.porId(t.chaveDeDispensa(d.id, CID)), null, `«${d.id}»: o portal nunca aceita esta chave`);
  }
  ok('Portal e Administração partilham a tabela sem colidir (efeito visível ao utilizador)');
}

// ── 14. Exclusividade EXAUSTIVA (cláusula «nenhum tip redundante») ──
// A secção 11 verifica a não-duplicação em cenários escolhidos à mão. Aqui
// varre-se o PRODUTO CARTESIANO das dimensões de contexto que alimentam as
// condições, para transformar «escolhi quatro casos e correu bem» em «não há
// nenhuma combinação em que os pares redundantes apareçam juntos». Também se
// trava a unicidade dos títulos: dois tips com o mesmo título na mesma página
// seriam, por definição, redundantes.
function testeExclusividadeExaustiva() {
  const ESTADOS = [undefined, 'sem_historico', 'em_curso', 'erro', 'local', 'local_com_cloud', 'local_copia_cloud_falhada', 'desconhecido'];
  const DESTINOS = [null, 'google_drive', 'dropbox', 'onedrive'];
  const USAVEIS = [undefined, true, false];
  const DIAS = [undefined, 0, 3, 7, 8, 40];
  const LIGACOES = [undefined, true, false];
  const PROVEDORES = [
    [],
    [{ nome: 'google_drive', ligado: true }],
    [{ nome: 'google_drive', ligado: true }, { nome: 'dropbox', ligado: true }],
    [{ nome: 'onedrive', ligado: true }],
    [{ nome: 'dropbox', ligado: false }],
  ];
  const AREAS_CTX = ['armazenamento', 'inicio'];

  // Pares que NUNCA podem coocorrer: descrevem a mesma situação do mesmo
  // backup, e o de prioridade superior já a explica.
  const PARES_PROIBIDOS = [
    ['backup_ultimo_falhou', 'backup_desatualizado'],
    ['backup_desatualizado', 'backup_cloud_nao_criada'],
    ['backup_sem_copia_externa', 'backup_servico_ligado_sem_uso'],
  ];
  // Tips que dependem EXCLUSIVAMENTE do estado do backup: sem `ctx.backup`,
  // nenhum pode aparecer (nunca se inventa uma situação).
  const DEPENDEM_DE_BACKUP = [
    'backup_ultimo_falhou', 'backup_desatualizado', 'backup_destino_sem_ligacao',
    'backup_cloud_nao_criada', 'backup_servico_ligado_sem_uso', 'backup_sem_copia_externa',
  ];

  const cenario = (estado, destino, usavel, dias, temLigacoes, provedores, area) => {
    const ctx = { ...BASE, area, papel: 'admin', armazenamento: { provedores } };
    const semBackup = estado === undefined && destino === null && usavel === undefined
      && dias === undefined && temLigacoes === undefined;
    if (semBackup) delete ctx.backup; // contexto em que a página não sabe nada de backups
    else ctx.backup = { estado, destino, usavel, diasDesde: dias, temLigacoes };
    return ctx;
  };

  let combinacoes = 0;
  let maxCoocorrencia = 0;
  let coocorrenciasComBackup = 0;

  for (const estado of ESTADOS) {
    for (const destino of DESTINOS) {
      for (const usavel of USAVEIS) {
        for (const dias of DIAS) {
          for (const temLigacoes of LIGACOES) {
            for (const provedores of PROVEDORES) {
              for (const area of AREAS_CTX) {
                const ctx = cenario(estado, destino, usavel, dias, temLigacoes, provedores, area);
                const rotulo = JSON.stringify({ estado, destino, usavel, dias, temLigacoes, area, provedores: provedores.map((p) => p.nome) });
                const lista = tips.elegiveis(ctx);
                const ids = new Set(lista.map((t) => t.id));
                combinacoes += 1;
                maxCoocorrencia = Math.max(maxCoocorrencia, lista.length);

                // 1. Os pares redundantes nunca coocorrem, em NENHUMA combinação.
                for (const [a, b] of PARES_PROIBIDOS) {
                  assert.ok(!(ids.has(a) && ids.has(b)),
                    `«${a}» e «${b}» nunca coocorrem — cenário ${rotulo}`);
                }

                // 2. Sem contexto de backup, nada se inventa.
                if (!ctx.backup) {
                  for (const id of DEPENDEM_DE_BACKUP) {
                    assert.ok(!ids.has(id), `«${id}» não aparece sem contexto de backup — ${rotulo}`);
                  }
                }

                // 3. Títulos únicos: dois títulos iguais na mesma página seriam
                //    redundantes por definição.
                const titulos = lista.map((t) => t.titulo);
                assert.strictEqual(new Set(titulos).size, titulos.length,
                  `títulos únicos — cenário ${rotulo}`);

                // 4. Todo o tip apresentado traz mensagem e ação completas.
                for (const t of lista) {
                  assert.ok(t.mensagem && String(t.mensagem).length > 20, `«${t.id}» tem mensagem — ${rotulo}`);
                  assert.ok(t.acao && t.acao.url && t.acao.texto, `«${t.id}» tem ação — ${rotulo}`);
                }

                // 5. A área é respeitada em todo o espaço.
                if (area !== 'armazenamento') {
                  assert.ok(!ids.has('armazenamento_documentos_e_backups'),
                    `o tip explicativo não sai da página de armazenamento — ${rotulo}`);
                }

                // 6. Determinismo: a mesma entrada dá sempre a mesma ordem.
                assert.deepStrictEqual(tips.elegiveis(ctx).map((t) => t.id), lista.map((t) => t.id),
                  `ordem determinística — ${rotulo}`);

                if (lista.length > 1) coocorrenciasComBackup += 1;
              }
            }
          }
        }
      }
    }
  }

  // O número de combinações é DERIVADO das dimensões: se alguém acrescentar um
  // estado ao motor e não o puser aqui, a contagem muda e o teste obriga a
  // atualizar a varredura em vez de a deixar cobrir menos do que julga.
  const esperado = ESTADOS.length * DESTINOS.length * USAVEIS.length * DIAS.length
    * LIGACOES.length * PROVEDORES.length * AREAS_CTX.length;
  assert.strictEqual(combinacoes, esperado, `a varredura cobriu todas as combinações (${combinacoes})`);
  assert.ok(combinacoes > 10000, 'a varredura é ampla');
  assert.ok(coocorrenciasComBackup > 0, 'há combinações com mais do que um tip (a varredura é útil)');
  ok(`exaustivo: ${combinacoes} combinações; pares redundantes nunca coocorrem; títulos únicos `
    + `(máx. ${maxCoocorrencia} tips em simultâneo)`);
}

(async () => {
  await testeSemColunaInexistente();
  await testeChavePorCondominio();
  await testeIsolamentoPorUtilizador();
  testeSemCruzamento();
  await testeIdentificadorManipulado();
  testePrioridade();
  testeAreas();
  testeAmbito();
  testeCondicoesDeBackup();
  testeContextoIncompleto();
  testeSemDuplicados();
  testeDispensaRobusta();
  await testeSemColisaoEntreMotores();
  testeExclusividadeExaustiva();
  console.log('\n✓ Testes de dispensa, isolamento e condições dos Tips passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
