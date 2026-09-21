// ═══════════════════════════════════════════════════════════════════
// Backups — cópia LOCAL obrigatória + cópia cloud OPCIONAL.
//
// Prova, sem base de dados e sem rede:
//  1. a cópia local é SEMPRE criada, mesmo sem nenhum serviço de cloud;
//  2. sem destino cloud configurado, o backup termina normalmente (local);
//  3. com destino cloud configurado E utilizável, é criada a cópia local E a
//     cópia cloud;
//  4. quando a cópia cloud falha, a cópia local é PRESERVADA e o estado
//     distingue «local OK, cloud falhou» de «backup em erro»;
//  5. o fornecedor dos backups é o da configuração GLOBAL — pode ser diferente
//     do serviço principal dos documentos do condomínio, e o job nunca o
//     consulta;
//  6. o job usa mesmo a configuração global de backups;
//  7. um destino configurado mas SEM ligação utilizável não é usado (o backup
//     fica local) — é o que impede a interface de anunciar uma cópia cloud que
//     nunca acontece;
//  8. a interpretação dos estados (helpers/backup-estado.js) distingue os cinco
//     casos exigidos, apenas com as colunas existentes de `backup_logs`.
//
// Utilização: node scripts/test-backup-estado.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// ── 1. Interpretação pura dos estados (helpers/backup-estado.js) ───
const backupEstado = require('../helpers/backup-estado');
const ROTULOS = { google_drive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'Microsoft OneDrive' };

function testeEstados() {
  const casos = [
    ['sem_historico', null, { rotulo: 'Sem backups', temLocal: false, temCloud: false, data: null }],
    ['em_curso', { estado: 'em_curso', data: new Date() }, { rotulo: 'Em curso', cor: 'warning' }],
    ['erro', { estado: 'erro', erro: 'mysqldump: command not found', data: new Date() }, { rotulo: 'Erro', cor: 'danger', temLocal: false }],
    ['local', { estado: 'concluido', tamanho: 4096, ficheiro_drive_id: null, erro: null, data: new Date() }, { rotulo: 'Concluído', cor: 'success', temLocal: true, temCloud: false }],
    ['local_com_cloud', { estado: 'concluido', tamanho: 4096, ficheiro_drive_id: 'dbx:abc123', erro: null, data: new Date() }, { rotulo: 'Concluído', cor: 'success', temLocal: true, temCloud: true, provedor: 'dropbox' }],
    ['local_copia_cloud_falhada', { estado: 'concluido', tamanho: 4096, ficheiro_drive_id: null, erro: 'Cópia cloud não criada: 401 invalid_grant', data: new Date() }, { rotulo: 'Concluído', cor: 'warning', temLocal: true, temCloud: false }],
  ];
  for (const [esperado, linha, campos] of casos) {
    const r = backupEstado.interpretar(linha, { rotulos: ROTULOS });
    assert.strictEqual(r.estado, esperado, `estado interpretado: ${esperado} (obtido ${r.estado})`);
    for (const [chave, valor] of Object.entries(campos)) {
      if (chave === 'provedor') assert.strictEqual(r.cloud && r.cloud.provedor, valor, `${esperado}: provedor da cópia cloud`);
      else assert.strictEqual(r[chave], valor, `${esperado}: campo ${chave}`);
    }
  }
  // O rótulo do provedor é resolvido pelo mapa injetado (sem BD neste módulo).
  const comCloud = backupEstado.interpretar({ estado: 'concluido', tamanho: 10, ficheiro_drive_id: 'gd:xyz' }, { rotulos: ROTULOS });
  assert.strictEqual(comCloud.cloud.rotulo, 'Google Drive', 'localizador sem prefixo é do Google Drive');
  assert.strictEqual(backupEstado.interpretar({ estado: 'concluido', tamanho: 10, ficheiro_drive_id: 'gd:xyz' }).cloud.rotulo, null,
    'sem mapa de rótulos não se inventa um nome');

  // Só os dois estados degradados exigem atenção.
  const atencao = ['erro', 'local_copia_cloud_falhada'];
  for (const estado of Object.keys(backupEstado.ESTADOS)) {
    assert.strictEqual(backupEstado.exigeAtencao(estado), atencao.includes(estado), `exigeAtencao(${estado})`);
  }
  // O detalhe apresentado no painel nunca é a mensagem técnica do fornecedor.
  const falha = backupEstado.interpretar({ estado: 'concluido', tamanho: 5, erro: 'token=segredo conta=x@y.pt' });
  assert.ok(!/segredo|x@y\.pt/.test(falha.detalhe), 'o painel não despeja a mensagem técnica do fornecedor');
  assert.ok(/token=segredo/.test(falha.erro), 'a mensagem completa continua disponível para a página de configuração');
  console.log('  ✓ os cinco estados de backup distinguem-se só com as colunas existentes');
}

// ── 2. Duplos: modelos, armazenamento e mysqldump ─────────────────
const criados = [];
function fakeLog(inicial) {
  const log = { id: criados.length + 1, ...inicial, atualizacoes: [] };
  log.update = async (dados) => { Object.assign(log, dados); log.atualizacoes.push(dados); return log; };
  return log;
}

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    BackupLog: {
      create: async (dados) => { const l = fakeLog(dados); criados.push(l); return l; },
      findAll: async () => [],
    },
  },
};

// Cenário do armazenamento (mutável entre testes).
const cloud = { destino: null, ligacao: null, erroUpload: null, localizador: null };
const uploads = [];
const chamadas = { destinoDeBackup: 0, principalDoCondominio: 0 };
const storagePath = require.resolve('../helpers/storage');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
  exports: {
    destinoDeBackup: async () => { chamadas.destinoDeBackup += 1; return cloud.destino; },
    obterProvedor: (nome) => (nome ? { nome, rotulo: () => ROTULOS[nome] || nome, icone: () => 'bi bi-cloud' } : null),
    ligacaoDeBackup: () => cloud.ligacao,
    pastaDeBackups: async () => 'pasta-backups',
    uploadComProvedor: async (nome, opcoes) => {
      uploads.push({ nome, opcoes });
      if (cloud.erroUpload) throw new Error(cloud.erroUpload);
      return { localizador: cloud.localizador };
    },
    apagarArquivo: async () => true,
    // O job NUNCA pode tocar no armazenamento de documentos do condomínio.
    principalDoCondominio: async () => { chamadas.principalDoCondominio += 1; throw new Error('o job não pode usar o serviço de documentos'); },
    isConfigured: () => true,
    rotuloPrincipal: () => 'Dropbox',
  },
};

// mysqldump: substituído antes de carregar o job (que desestrutura `execFile`).
const cp = require('child_process');
const execFileOriginal = cp.execFile;
let dumpFalha = null;
cp.execFile = (cmd, args, opts, cb) => {
  if (dumpFalha) return cb(new Error(dumpFalha));
  return cb(null, Buffer.from('-- dump de teste\nCREATE TABLE x (id int);\n'));
};

const dirLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'gescondu-backup-'));
process.env.BACKUP_LOCAL_DIR = dirLocal;

const { executarBackup } = require('../jobs/backup');

function reiniciar() {
  cloud.destino = null;
  cloud.ligacao = null;
  cloud.erroUpload = null;
  cloud.localizador = null;
  uploads.length = 0;
  criados.length = 0;
  chamadas.destinoDeBackup = 0;
  chamadas.principalDoCondominio = 0;
  dumpFalha = null;
  for (const f of fs.readdirSync(dirLocal)) fs.rmSync(path.join(dirLocal, f), { force: true });
}

const ficheirosLocais = () => fs.readdirSync(dirLocal);
const conteudoLocal = () => {
  const ficheiros = ficheirosLocais();
  assert.strictEqual(ficheiros.length, 1, `exatamente uma cópia local (${ficheiros.length})`);
  return fs.readFileSync(path.join(dirLocal, ficheiros[0]));
};

// ── 3. Cópia local sempre + sem destino cloud ────────────────────
async function testeLocalSempre() {
  reiniciar();
  const log = await executarBackup('diario');
  assert.strictEqual(log.estado, 'concluido', 'sem destino cloud: termina concluído');
  assert.ok(log.tamanho > 0, 'sem destino cloud: a cópia local tem tamanho registado');
  assert.strictEqual(log.ficheiro_drive_id, undefined, 'sem destino cloud: nenhum localizador de cloud');
  assert.strictEqual(log.erro, null, 'sem destino cloud: nenhum erro registado');
  assert.strictEqual(uploads.length, 0, 'sem destino cloud: nenhum upload tentado');
  const bytes = conteudoLocal();
  assert.ok(bytes.length === log.tamanho, 'a cópia local existe mesmo e tem o tamanho registado');
  assert.ok(bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])), 'a cópia local é gzip (magic 1f 8b)');
  assert.strictEqual(backupEstado.interpretar(log, { rotulos: ROTULOS }).estado, 'local', 'estado: só local');
  console.log('  ✓ a cópia local é sempre criada e o backup termina sem cloud');
}

// ── 4. Destino cloud utilizável → local + cloud ──────────────────
async function testeLocalMaisCloud() {
  reiniciar();
  cloud.destino = 'google_drive';
  cloud.ligacao = { condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' };
  cloud.localizador = 'gd:ficheiro-123';
  const log = await executarBackup('manual');
  assert.strictEqual(chamadas.destinoDeBackup, 1, 'o job consulta a configuração GLOBAL de backups');
  assert.strictEqual(uploads.length, 1, 'com destino utilizável, é feito o upload');
  assert.strictEqual(uploads[0].nome, 'google_drive', 'o upload vai para o serviço configurado para backups');
  assert.strictEqual(uploads[0].opcoes.condominioId, null, 'ligação de plataforma: sem condomínio');
  assert.strictEqual(uploads[0].opcoes.parentFolderId, 'pasta-backups', 'o upload usa a pasta de backups');
  assert.strictEqual(log.estado, 'concluido', 'local + cloud: concluído');
  assert.strictEqual(log.ficheiro_drive_id, 'gd:ficheiro-123', 'local + cloud: localizador guardado');
  assert.ok(log.tamanho > 0, 'local + cloud: a cópia local tem tamanho registado');
  assert.strictEqual(conteudoLocal().length, log.tamanho, 'local + cloud: a cópia local existe');
  assert.strictEqual(backupEstado.interpretar(log, { rotulos: ROTULOS }).estado, 'local_com_cloud', 'estado: local + cloud');
  console.log('  ✓ com destino cloud utilizável são criadas as duas cópias');
}

// ── 5. Falha do upload → cópia local preservada ──────────────────
async function testeFalhaCloud() {
  reiniciar();
  cloud.destino = 'dropbox';
  cloud.ligacao = { condominioId: null, conta: null, origem: 'plataforma' };
  cloud.erroUpload = '503 service unavailable';
  const log = await executarBackup('diario');
  assert.strictEqual(uploads.length, 1, 'a cópia cloud foi tentada');
  assert.strictEqual(log.estado, 'concluido', 'a falha da cloud não transforma um backup válido em erro');
  assert.strictEqual(log.ficheiro_drive_id, undefined, 'falha da cloud: nenhum localizador');
  assert.ok(/503 service unavailable/.test(log.erro), 'falha da cloud: motivo registado');
  assert.strictEqual(ficheirosLocais().length, 1, 'falha da cloud: a cópia local NÃO é removida');
  assert.strictEqual(conteudoLocal().length, log.tamanho, 'falha da cloud: a cópia local continua íntegra');
  assert.strictEqual(backupEstado.interpretar(log, { rotulos: ROTULOS }).estado, 'local_copia_cloud_falhada',
    'estado: local concluído mas cópia cloud falhada');
  console.log('  ✓ a falha da cópia cloud nunca perde a cópia local');
}

// ── 6. Destino configurado sem ligação utilizável ────────────────
async function testeDestinoSemLigacao() {
  reiniciar();
  cloud.destino = 'onedrive';
  cloud.ligacao = null; // configurado, mas sem ligação que o job consiga usar
  const log = await executarBackup('diario');
  assert.strictEqual(uploads.length, 0, 'destino sem ligação utilizável: nenhum upload tentado');
  assert.strictEqual(log.estado, 'concluido', 'destino sem ligação utilizável: o backup termina localmente');
  assert.strictEqual(conteudoLocal().length, log.tamanho, 'destino sem ligação utilizável: cópia local feita');
  assert.strictEqual(backupEstado.interpretar(log, { rotulos: ROTULOS }).estado, 'local', 'estado: só local');
  console.log('  ✓ um destino sem ligação utilizável não é usado (o backup fica local)');
}

// ── 7. O fornecedor dos documentos nunca decide o dos backups ────
async function testeIndependenciaDosFornecedores() {
  reiniciar();
  // Documentos do condomínio: Dropbox. Backups: Google Drive.
  cloud.destino = 'google_drive';
  cloud.ligacao = { condominioId: 7, conta: 'gestao@exemplo.pt', origem: 'condominio' };
  cloud.localizador = 'gd:backup-9';
  const log = await executarBackup('diario');
  assert.strictEqual(uploads[0].nome, 'google_drive', 'os backups vão para o serviço da configuração GLOBAL');
  assert.strictEqual(uploads[0].opcoes.condominioId, 7, 'ligação de condomínio: âmbito passado ao adaptador');
  assert.strictEqual(chamadas.principalDoCondominio, 0, 'o job nunca consulta o armazenamento de documentos do condomínio');
  assert.strictEqual(backupEstado.interpretar(log, { rotulos: ROTULOS }).cloud.provedor, 'google_drive',
    'o localizador identifica o provedor real da cópia cloud');
  const fonte = ler('jobs/backup.js');
  assert.ok(!/principalDoCondominio|rotuloPrincipal|provedorParaEscrita/.test(fonte),
    'a fonte do job não liga os backups ao armazenamento principal dos documentos');
  console.log('  ✓ documentos num serviço e backups noutro: o job respeita a configuração global');
}

// ── 8. Falha do dump → erro (não há backup nenhum) ───────────────
async function testeFalhaDump() {
  reiniciar();
  dumpFalha = 'mysqldump: command not found';
  const log = await executarBackup('diario');
  assert.strictEqual(log.estado, 'erro', 'sem dump não há backup: estado de erro');
  assert.strictEqual(ficheirosLocais().length, 0, 'sem dump não se escreve nenhuma cópia local');
  assert.strictEqual(log.tamanho, undefined, 'sem dump não há tamanho registado');
  assert.strictEqual(backupEstado.interpretar(log, { rotulos: ROTULOS }).estado, 'erro', 'estado interpretado: erro');
  console.log('  ✓ quando o dump falha não se inventa um backup');
}

// ── 9. Fonte: o painel separa documentos de backups ──────────────
function testeFonteDoPainel() {
  const rota = ler('routes/admin.js');
  const bloco = rota.slice(rota.indexOf("router.get('/', async"), rota.indexOf('// FRAÇÕES'));
  assert.ok(/storage\.isConfigured\(req\.condominioId\)/.test(bloco),
    'painel: o estado dos DOCUMENTOS resolve-se com o condomínio ativo');
  assert.ok(!/drive\.isConfigured\(\)/.test(bloco),
    'painel: já não se usa a ligação da plataforma para decidir o armazenamento dos documentos');
  assert.ok(/documentosLigado/.test(bloco) && /backupEstado: ultimoBackupEstado\.estado/.test(bloco),
    'painel: os dois eixos (documentos e backups) são passados separadamente aos sinais');
  assert.ok(/storage\.destinoDeBackup\(\)/.test(bloco) && /storage\.ligacaoDeBackup\(destinoBackup\)/.test(bloco),
    'painel: o destino dos backups vem da configuração global + ligação utilizável');

  const vista = ler('views/admin/dashboard.handlebars');
  for (const rotulo of ['Documentos:', 'Cópias de segurança:', 'Último backup:', 'Email/SMTP:']) {
    assert.ok(vista.includes(rotulo), `painel: linha própria para «${rotulo}»`);
  }
  assert.ok(vista.includes('○ Apenas local'), 'painel: sem cloud de backups mostra «Apenas local» (nunca «Desligado»)');
  assert.ok(/Último backup: [^\n]*formatDate sistema\.ultimoBackup\.data/.test(vista),
    'painel: o último backup apresenta a data');
  assert.ok(!/Backup: \{\{#if sistema\.ultimoBackup\}\}/.test(vista), 'painel: a linha antiga e ambígua de Backup desapareceu');
  console.log('  ✓ o painel apresenta documentos e backups como eixos independentes');
}

// ── 10. Fonte: a retenção é configurável e o âmbito da cloud é respeitado ──
function testeFonteDaRetencao() {
  const job = ler('jobs/backup.js');

  // A retenção deixou de vir só do `.env`: é lida da configuração persistida
  // (com o `.env` como fallback) e validada com o mínimo de 30 dias. Deixou
  // também de ser POR TIPO: passou a ser POR DESTINO (local e cloud), porque as
  // duas cópias são independentes.
  assert.ok(/retencao\.lerConfiguracao|lerConfiguracao/.test(job), 'o job lê a retenção configurada');
  assert.ok(!/BACKUP_WEEKLY_RETENTION|BACKUP_MONTHLY_RETENTION/.test(job),
    'a retenção por tipo no `.env` deixou de ser a fonte');
  assert.ok(/limparBackupsLocais/.test(job) && /limparBackupsCloud/.test(job),
    'as duas retenções são independentes e explícitas');
  assert.ok(/protegerUltimo/.test(job), 'a retenção local protege o último backup válido');

  // ⛔ O âmbito da remoção cloud tem de ser passado. Sem ele, a remoção resolvia
  // os tokens do âmbito PLATAFORMA mesmo quando a cópia tinha sido enviada pela
  // ligação de um condomínio: o `DELETE` caía noutra conta e o OneDrive
  // respondia 404 → devolvia `true` («apagado») sem apagar nada.
  assert.ok(/storage\.apagarArquivo\(b\.ficheiro_drive_id, condominioId\)/.test(job),
    'a remoção cloud usa o âmbito da ligação do destino');
  assert.ok(!/storage\.apagarArquivo\(b\.ficheiro_drive_id\)/.test(job),
    'a remoção cloud já não é chamada sem âmbito');

  // A limpeza corre depois do backup local e NÃO depende do sucesso da cloud.
  assert.ok(/const limpeza = await executarLimpeza\(\{ ligacao \}\);/.test(job),
    'a retenção corre depois do backup local, independentemente da cópia cloud');

  // As funções que a área do Super Admin usa são as MESMAS do job (uma verdade).
  const mod = require('../jobs/backup');
  for (const nome of [
    'executarBackup', 'configuracaoRetencao', 'pastaLocal', 'listarBackupsLocais',
    'limparBackupsLocais', 'limparBackupsCloud', 'executarLimpeza', 'apagarBackupLocal', 'apagarBackupsAntesDe',
  ]) {
    assert.strictEqual(typeof mod[nome], 'function', `o job exporta ${nome}`);
  }

  // A área do Super Admin reutiliza o job e está atrás da guarda global.
  const rota = ler('routes/global-admin.js');
  assert.ok(/router\.get\('\/armazenamento'/.test(rota), 'a área de armazenamento existe no namespace global');
  assert.ok(/backupJob\.listarBackupsLocais/.test(rota), 'a área usa o inventário do job (sem duplicar lógica)');
  assert.ok(/backupJob\.executarLimpeza/.test(rota), 'a limpeza manual usa a mesma função do ciclo automático');
  assert.ok(/backupRetencao\.gravarConfiguracao/.test(rota), 'a retenção é validada no servidor pela regra única');
  const guarda = rota.slice(rota.indexOf('router.use((req, res, next)'), rota.indexOf('// Caminho de um recurso'));
  assert.ok(/tenant\.eSuperAdmin\(req\.user\)/.test(guarda), 'a área global é decidida por `role_global`');

  // A vista separa os dois eixos e diz que os backups são da instalação.
  const vista = ler('views/admin/global/armazenamento.handlebars');
  assert.ok(/Backups da instalação/.test(vista), 'a vista identifica os backups como da instalação');
  assert.ok(/não existem backups por condomínio/.test(vista), 'a vista diz que não há backups por condomínio');
  assert.ok(/Armazenamento documental/.test(vista), 'a vista separa o armazenamento documental');
  assert.ok(/não fazem parte dos backups/.test(vista), 'a vista diz que os documentos não entram nos backups');
  assert.ok(!/\{\{money/.test(vista), 'a vista não usa o helper inexistente `money` (rebentaria no render)');
  console.log('  ✓ a retenção é configurável, o âmbito cloud é respeitado e a área reutiliza o job');
}

(async () => {
  testeEstados();
  await testeLocalSempre();
  await testeLocalMaisCloud();
  await testeFalhaCloud();
  await testeDestinoSemLigacao();
  await testeIndependenciaDosFornecedores();
  await testeFalhaDump();
  testeFonteDoPainel();
  testeFonteDaRetencao();
  cp.execFile = execFileOriginal;
  fs.rmSync(dirLocal, { recursive: true, force: true });
  console.log('✓ Testes do backup local + cópia cloud opcional passaram (sem base de dados).');
})().catch((err) => {
  cp.execFile = execFileOriginal;
  try { fs.rmSync(dirLocal, { recursive: true, force: true }); } catch (e) { /* nada */ }
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
