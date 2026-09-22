// ═══════════════════════════════════════════════════════════════════
// Área de backups da instalação (/global/armazenamento) — execução REAL.
//
// Monta `routes/global-admin.js` com duplos de base de dados e pede as rotas
// por HTTP. É a única forma de provar:
//   J. ISOLAMENTO: só o Super Admin entra; um administrador de condomínio é
//      recusado (302) e nunca vê nem apaga um dump;
//   ·  a página mostra os valores REAIS medidos a partir dos ficheiros;
//   ·  a retenção é validada no SERVIDOR (mínimo 30), não no browser;
//   ·  o espaço documental é apresentado separado do espaço dos backups.
//
// Utilização: node scripts/test-rotas-global-backups.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');
const DIA = 86400000;

// ── Cenário: ficheiros REAIS de backup num diretório temporário ────
// Conteúdos diferentes ⇒ tamanhos diferentes ⇒ a junção ficheiro↔registo é
// inequívoca (é o `tipo|tamanho` que a faz).
const dirBackups = fs.mkdtempSync(path.join(os.tmpdir(), 'gescondu-global-backups-'));
process.env.BACKUP_LOCAL_DIR = dirBackups;

function criarBackup(dias, { comCloud = false } = {}) {
  const quando = new Date(Date.now() - dias * DIA);
  const nome = `backup_diario_${quando.toISOString().slice(0, 10)}_${quando.getTime()}.sql.gz`;
  const conteudo = zlib.gzipSync(Buffer.from(`-- dump de teste ${'x'.repeat(dias * 10 + 10)}\n`));
  fs.writeFileSync(path.join(dirBackups, nome), conteudo);
  return {
    id: dias,
    tipo: 'diario',
    estado: 'concluido',
    data: quando,
    tamanho: conteudo.length,
    ficheiro_drive_id: comCloud ? 'gd:copia-cloud-1' : null,
    erro: null,
    toJSON() { return { ...this }; },
    _nome: nome,
  };
}

const LOG_ANTIGO = criarBackup(120);
const LOG_RECENTE = criarBackup(1, { comCloud: true });
const LOGS = [LOG_ANTIGO, LOG_RECENTE];
const LOGS_CLOUD = [LOG_RECENTE]; // só o que tem referência cloud

// Documentos (eixo SEPARADO) — o tamanho é o registado no GesCondu.
const DOCS_POR_CONDOMINIO = [
  { condominio_id: 1, documentos: 12, bytes: 2576980377, maisAntigo: '2026-01-05', maisRecente: '2026-09-18' },
  { condominio_id: 2, documentos: 4, bytes: 891289, maisAntigo: '2026-06-01', maisRecente: '2026-08-30' },
];
const DOCS_SEM_TAMANHO = [{ condominio_id: 2, total: 2 }];

// ── Duplos ─────────────────────────────────────────────────────────
const loja = new Map();
// Medição de espaço da conta do serviço de destino (null = não medida).
let ESPACO_CLOUD = null;
const stubs = {
  '../models': {
    Condominio: {
      count: async () => 2,
      findAll: async () => [
        { id: 1, designacao: 'Condomínio Alfa' },
        { id: 2, designacao: 'Condomínio Beta' },
      ],
    },
    User: { count: async () => 3 },
    UserCondominio: { count: async () => 2, findAll: async () => [], findOrCreate: async () => [null, false] },
    Fracao: { count: async () => 0, findAll: async () => [] },
    AuditLog: { count: async () => 0, findAll: async () => [] },
    Documento: {
      findAll: async (opcoes = {}) => (opcoes.where ? DOCS_SEM_TAMANHO : DOCS_POR_CONDOMINIO),
    },
    BackupLog: {
      // Duas consultas distintas: a lista completa (junção do inventário) e as
      // cópias cloud (referência não nula).
      findAll: async (opcoes = {}) => (opcoes.where && opcoes.where.ficheiro_drive_id ? LOGS_CLOUD : LOGS),
    },
  },
  '../helpers/config': {
    getConfig: async (chave, fallback = null) => (loja.has(chave) ? loja.get(chave) : fallback),
    setConfig: async (chave, valor) => {
      loja.set(chave, valor);
      return { chave, valor };
    },
  },
  // Guarda REAL do Super Admin: `role_global === 'super_admin'`.
  '../helpers/tenant': {
    eSuperAdmin: (utilizador) => Boolean(utilizador && utilizador.role_global === 'super_admin'),
  },
  '../helpers/audit': { audit: async () => ({}) },
  '../helpers/suporte': {
    terminarVigentesDoCondominio: async () => ({ terminados: 0 }),
    contagemAcessosDoCondominio: async () => ({ total: 0, vigentes: 0 }),
    vigentesDe: async () => [], pendentesDe: async () => [], historicoDe: async () => [],
    temAdminAtivo: async () => true, iniciar: async () => ({ ok: false }), terminar: async () => null, revogar: async () => null,
    DURACOES_MINUTOS: [], NIVEIS_CONCEDIVEIS: [],
  },
  '../helpers/titularidades': { decidirEstadoAssociacao: () => ({ estado: 'ativo', reativada: false, estavaAtiva: true }) },
  '../helpers/eliminacao-condominio': { eliminarDadosDoCondominio: async () => ({ total: 0, porTabela: {} }), eliminarCondominio: async () => ({}) },
  '../helpers/storage': {
    destinoDeBackup: async () => 'dropbox',
    obterProvedor: (nome) => (nome ? { nome, rotulo: () => 'Dropbox', icone: () => 'bi bi-dropbox' } : null),
    ligacaoDeBackup: () => ({ condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' }),
    provedores: () => ['google_drive', 'dropbox', 'onedrive'],
    // Medição de espaço da conta do serviço. Mutável: o teste pede a página
    // duas vezes — uma sem medição (o serviço não respondeu) e outra com os
    // valores REAIS que a API devolveria.
    espacoNaCloud: async () => ESPACO_CLOUD,
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// ── Aplicação de teste (rota REAL) ─────────────────────────────────
const { engine } = require('express-handlebars');
const app = express();
app.engine('handlebars', engine({
  defaultLayout: false,
  helpers: require('../helpers/handlebars-helpers'),
  layoutsDir: path.join(RAIZ, 'views', 'layouts'),
  partialsDir: path.join(RAIZ, 'views', 'partials'),
  runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
}));
app.set('view engine', 'handlebars');
app.set('views', path.join(RAIZ, 'views'));
app.use(session({ secret: 'teste', resave: false, saveUninitialized: false }));
app.use(express.urlencoded({ extended: true }));
app.use(flash());

// O utilizador autenticado é mutável: o mesmo servidor serve os dois papéis.
const SUPER = { id: 1, nome: 'Super Admin', email: 'super@exemplo.pt', role: 'admin', role_global: 'super_admin' };
const ADMIN_CONDOMINIO = { id: 42, nome: 'Ana Gestora', email: 'ana@exemplo.pt', role: 'admin', role_global: null };
let UTILIZADOR = SUPER;
app.use((req, res, next) => {
  req.user = UTILIZADOR;
  req.isAuthenticated = () => true;
  res.locals.user = UTILIZADOR;
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.tarefas = { ativas: 0, emErro: 0 };
  next();
});
app.use('/global', require('../routes/global-admin'));
app.use((err, req, res, next) => res.status(500).send(`ERRO_NO_HANDLER: ${err.message}`));

// ── Utilitário de pedido HTTP ──────────────────────────────────────
function pedir(metodo, caminho, corpo = null) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const dados = corpo ? new URLSearchParams(corpo).toString() : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: servidor.address().port,
          path: caminho,
          method: metodo,
          headers: dados ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) } : {},
        },
        (res) => {
          let texto = '';
          res.on('data', (c) => { texto += c; });
          res.on('end', () => {
            servidor.close();
            resolve({ status: res.statusCode, location: res.headers.location || null, texto });
          });
        }
      );
      req.on('error', (e) => { servidor.close(); reject(e); });
      if (dados) req.write(dados);
      req.end();
    });
  });
}

const retencao = require('../helpers/backup-retencao');

// ── J1: um administrador de CONDOMÍNIO não entra ───────────────────
async function testeIsolamento() {
  UTILIZADOR = ADMIN_CONDOMINIO;
  for (const caminho of ['/global/armazenamento', '/global', '/global/condominios']) {
    const r = await pedir('GET', caminho);
    assert.strictEqual(r.status, 302, `${caminho}: um admin de condomínio é redirecionado`);
    assert.strictEqual(r.location, '/', `${caminho}: redireciona para a raiz`);
    assert.ok(!/Backups da instalação/.test(r.texto), `${caminho}: não vê conteúdo da área global`);
  }
  // E não consegue executar nenhuma operação de gestão.
  for (const [caminho, corpo] of [
    ['/global/armazenamento/apagar', { modo: 'individual', nome: LOG_RECENTE._nome }],
    ['/global/armazenamento/apagar', { modo: 'antes', data_limite: '2030-01-01' }],
    ['/global/armazenamento/limpar', {}],
    ['/global/armazenamento/retencao', { retencao_local: '30', retencao_cloud: '30' }],
  ]) {
    const r = await pedir('POST', caminho, corpo);
    assert.strictEqual(r.status, 302, `${caminho}: POST recusado`);
    assert.strictEqual(r.location, '/', `${caminho}: redireciona para a raiz`);
  }
  // Nada foi apagado nem alterado.
  assert.strictEqual(fs.readdirSync(dirBackups).length, 2, 'nenhum dump foi apagado por um admin de condomínio');
  assert.strictEqual(loja.size, 0, 'nenhuma configuração foi alterada por um admin de condomínio');
  console.log('  ✓ J. um administrador de condomínio não entra nem opera na área de backups');
}

// ── J2: o Super Admin vê a página com os valores reais ────────────
async function testePagina() {
  UTILIZADOR = SUPER;
  const r = await pedir('GET', '/global/armazenamento');
  assert.strictEqual(r.status, 200, 'o Super Admin recebe a página');
  const corpo = r.texto;

  assert.ok(/Backups da instalação/.test(corpo), 'título da área');
  assert.ok(/dump completo da base de dados da instalação/.test(corpo), 'explica que o backup é da instalação');
  assert.ok(/não existem backups por condomínio/.test(corpo), 'diz explicitamente que não há backups por condomínio');

  // Métricas REAIS (medidas do disco). Os valores esperados são LITERAIS: se
  // fossem calculados com o mesmo helper da vista, uma formatação partida
  // (ou um helper que devolvesse sempre «—») passaria despercebida.
  const total = LOG_ANTIGO.tamanho + LOG_RECENTE.tamanho;
  assert.ok(total > 0 && total < 1024, 'o cenário usa tamanhos na ordem dos bytes');
  assert.ok(corpo.includes(`${total} B`), `o espaço total medido aparece (${total} B)`);
  assert.ok(corpo.includes(LOG_ANTIGO._nome), 'o backup mais antigo aparece pelo nome');
  assert.ok(corpo.includes(LOG_RECENTE._nome), 'o backup mais recente aparece pelo nome');
  assert.ok(/Backups válidos/.test(corpo), 'a contagem de backups válidos é apresentada');
  assert.ok(/Mais antigo/.test(corpo), 'a data do mais antigo é apresentada');
  assert.ok(/Espaço no volume/.test(corpo), 'o espaço do volume é apresentado');

  // Cópia cloud: contagem pelo registo e espaço declarado como indisponível.
  assert.ok(/Cópia cloud \(adicional\)/.test(corpo), 'secção da cópia cloud');
  assert.ok(/não disponível/.test(corpo), 'o espaço cloud não é inventado');

  // Retenção: valores configurados e o mínimo.
  assert.ok(/Retenção/.test(corpo), 'secção da retenção');
  assert.ok(/name="retencao_local"[^>]*value="30"/.test(corpo), 'retenção local por omissão: 30');
  assert.ok(/name="retencao_cloud"[^>]*value="90"/.test(corpo), 'retenção cloud por omissão: 90');
  assert.ok(/min="30"/.test(corpo), 'o mínimo de 30 dias é apresentado no formulário');

  // Confirmação explícita da eliminação.
  assert.ok(/Esta operação elimina permanentemente os backups locais selecionados/.test(corpo), 'mensagem de confirmação');
  assert.ok(/As cópias existentes na cloud não são afetadas/.test(corpo), 'esclarece que a cloud não é afetada');

  // Documentos: eixo SEPARADO, com os valores por condomínio.
  assert.ok(/Armazenamento documental/.test(corpo), 'secção documental separada');
  assert.ok(/não fazem parte dos backups/.test(corpo), 'diz que os documentos não entram nos backups');
  assert.ok(/Condomínio Alfa/.test(corpo) && /Condomínio Beta/.test(corpo), 'tabela por condomínio');
  assert.ok(corpo.includes('2,4 GB'), 'o tamanho documental registado aparece formatado (2,4 GB)');
  assert.ok(/sem tamanho/.test(corpo), 'os documentos sem tamanho registado são assinalados');
  assert.ok(/não está somado/.test(corpo), 'esclarece que o espaço documental não é somado ao dos backups');
  console.log('  ✓ J. o Super Admin vê os valores reais, com os documentos claramente separados');
}

// ── J3: espaço da conta do serviço — medido, nunca inventado ──────
// O painel deixou de dizer simplesmente «não disponível»: pede à API do
// serviço de destino a quota da conta. Duas situações, ambas verificadas:
//  · sem medição (serviço não responde / não expõe quota) ⇒ «não disponível»;
//  · com medição ⇒ os números REAIS formatados, identificados como espaço da
//    CONTA (que inclui mais do que os backups) e com a origem do número.
async function testeEspacoCloud() {
  UTILIZADOR = SUPER;

  ESPACO_CLOUD = null;
  const semMedicao = await pedir('GET', '/global/armazenamento');
  assert.strictEqual(semMedicao.status, 200);
  assert.ok(
    /Espaço da conta do serviço:\s*<strong>não disponível<\/strong>/.test(semMedicao.texto),
    'sem medição ⇒ «não disponível» (nunca um valor estimado)'
  );

  ESPACO_CLOUD = {
    suportado: true,
    totalBytes: 5000000000,
    usadosBytes: 2000000000,
    livresBytes: 3000000000,
    fonte: 'dropbox:users/get_space_usage',
  };
  const comMedicao = await pedir('GET', '/global/armazenamento');
  assert.ok(comMedicao.texto.includes('1,9 GB'), 'os usados reais aparecem formatados (1,9 GB)');
  assert.ok(comMedicao.texto.includes('4,7 GB'), 'o total real aparece formatado (4,7 GB)');
  assert.ok(comMedicao.texto.includes('2,8 GB'), 'o espaço livre aparece formatado (2,8 GB)');
  assert.ok(
    /inclui todos os ficheiros da conta, não só os backups/.test(comMedicao.texto),
    'diz explicitamente que NÃO é só o espaço dos backups'
  );
  assert.ok(/dropbox:users\/get_space_usage/.test(comMedicao.texto), 'identifica a origem do número (a API)');
  ESPACO_CLOUD = null;
  console.log('  ✓ o espaço da cloud é o real da conta (ou «não disponível»), nunca uma estimativa');
}

// ── Retenção: validação no SERVIDOR ───────────────────────────────
async function testeRetencao() {
  UTILIZADOR = SUPER;

  // Abaixo do mínimo: recusado e NADA é gravado.
  for (const dias of ['10', '29', 'abc', '', '-5', '29.5']) {
    const r = await pedir('POST', '/global/armazenamento/retencao', {
      retencao_local: dias, retencao_cloud: '90', limpeza_automatica: '1',
    });
    assert.strictEqual(r.status, 302, 'a rota responde sempre com redirect');
    assert.strictEqual(loja.has(retencao.CHAVES.retencaoLocal), false, `retenção local inválida (${JSON.stringify(dias)}) não é gravada`);
  }

  // Valores válidos: gravados.
  const r2 = await pedir('POST', '/global/armazenamento/retencao', {
    retencao_local: '60', retencao_cloud: '180', limpeza_automatica: '1', limite_local_gb: '50',
  });
  assert.strictEqual(r2.status, 302);
  assert.strictEqual(loja.get(retencao.CHAVES.retencaoLocal), '60', 'a retenção local válida é gravada');
  assert.strictEqual(loja.get(retencao.CHAVES.retencaoCloud), '180', 'a retenção cloud é independente');
  assert.strictEqual(loja.get(retencao.CHAVES.limiteLocalGb), '50');

  // Sem o campo `limpeza_automatica` (checkbox desmarcada) ⇒ desligada.
  const r3 = await pedir('POST', '/global/armazenamento/retencao', {
    retencao_local: '30', retencao_cloud: '90',
  });
  assert.strictEqual(r3.status, 302);
  assert.strictEqual(loja.get(retencao.CHAVES.limpezaAutomatica), '0', 'a limpeza automática pode ser desligada');

  // A página reflete o que ficou gravado.
  const pagina = await pedir('GET', '/global/armazenamento');
  assert.ok(/name="retencao_local"[^>]*value="30"/.test(pagina.texto));
  assert.ok(/name="retencao_cloud"[^>]*value="90"/.test(pagina.texto));
  console.log('  ✓ a retenção é validada no servidor (mínimo 30) e gravada por destino');
}

// ── Eliminação manual pela rota (com a proteção real) ─────────────
async function testeEliminacaoPelaRota() {
  UTILIZADOR = SUPER;

  // Path traversal: a rota não deixa o nome virar caminho.
  const r1 = await pedir('POST', '/global/armazenamento/apagar', { modo: 'individual', nome: '../../etc/passwd' });
  assert.strictEqual(r1.status, 302);
  assert.strictEqual(fs.readdirSync(dirBackups).length, 2, 'nada foi apagado com um nome inválido');

  // Individual válida: um backup entre dois pode sair.
  const r2 = await pedir('POST', '/global/armazenamento/apagar', { modo: 'individual', nome: LOG_ANTIGO._nome });
  assert.strictEqual(r2.status, 302);
  assert.deepStrictEqual(fs.readdirSync(dirBackups), [LOG_RECENTE._nome], 'o backup indicado foi eliminado');

  // O último backup válido NÃO pode ser eliminado (nem pela interface).
  const r3 = await pedir('POST', '/global/armazenamento/apagar', { modo: 'individual', nome: LOG_RECENTE._nome });
  assert.strictEqual(r3.status, 302);
  assert.deepStrictEqual(fs.readdirSync(dirBackups), [LOG_RECENTE._nome], 'o último backup local válido fica');

  // Por data, com todos anteriores: o último válido é preservado.
  const r4 = await pedir('POST', '/global/armazenamento/apagar', { modo: 'antes', data_limite: '2030-01-01' });
  assert.strictEqual(r4.status, 302);
  assert.deepStrictEqual(fs.readdirSync(dirBackups), [LOG_RECENTE._nome], 'a eliminação por data preserva o último backup');

  // Data inválida: recusada.
  const r5 = await pedir('POST', '/global/armazenamento/apagar', { modo: 'antes', data_limite: 'ontem' });
  assert.strictEqual(r5.status, 302);
  assert.deepStrictEqual(fs.readdirSync(dirBackups), [LOG_RECENTE._nome]);
  console.log('  ✓ a eliminação manual pela rota respeita a proteção do último backup');
}

(async () => {
  await testeIsolamento();
  await testePagina();
  await testeEspacoCloud();
  await testeRetencao();
  await testeEliminacaoPelaRota();
  fs.rmSync(dirBackups, { recursive: true, force: true });
  console.log('✓ Testes da área de backups do Super Admin passaram (sem base de dados).');
})().catch((err) => {
  try { fs.rmSync(dirBackups, { recursive: true, force: true }); } catch (e) { /* nada */ }
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
