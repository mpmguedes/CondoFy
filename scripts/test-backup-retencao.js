// ═══════════════════════════════════════════════════════════════════
// Backups da INSTALAÇÃO — inventário, retenção e gestão manual.
//
// Prova, sem base de dados e sem rede:
//   A. sem cloud: a cópia local é criada, validada e o ciclo conclui;
//   B. cloud funcional: cópia local + cópia cloud, ambas registadas;
//   C. cloud indisponível: a cópia local é preservada, a cloud é marcada como
//      falhada e a retenção local continua a correr;
//   D. credenciais cloud inválidas: o local é independente e o erro é registado;
//   E. falha do backup local: o ciclo FALHA (a cloud nunca é substituto);
//   F. retenção local: por idade, com o último backup VÁLIDO sempre protegido;
//   G. retenção cloud: independente da local, com o âmbito correto;
//   H. métricas: espaço, número e datas medidos a partir dos ficheiros reais;
//   I. eliminação manual: individual e por data, com a mesma proteção;
//   K. documentos separados: um ficheiro documental nunca é tratado como backup.
//
// Utilização: node scripts/test-backup-retencao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const DIA = 86400000;

// ── Duplos: modelos, configuração, armazenamento e mysqldump ───────
// A cópia local é um gzip verdadeiro: a validação real (magic 1f 8b) é
// exercitada, não contornada.
const DUMP = Buffer.from('-- dump de teste\nCREATE TABLE x (id int);\n');
const GZ = zlib.gzipSync(DUMP);

const estado = {
  logsAntigos: [], // registos devolvidos por BackupLog.findAll (retenção cloud)
  logsRecentes: [], // registos devolvidos com `limit` (lista da área do Super Admin)
  consultas: [],
  uploads: [],
  apagadosCloud: [],
  storage: { destino: null, ligacao: null, erroUpload: null, localizador: null, resultadoApagar: true, erroApagar: null },
  dumpFalha: null,
};

let sequencia = 0;
function fakeLog(inicial) {
  const log = { id: (sequencia += 1), ...inicial, atualizacoes: [] };
  log.update = async (dados) => {
    Object.assign(log, dados);
    log.atualizacoes.push(dados);
    return log;
  };
  return log;
}

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    BackupLog: {
      create: async (dados) => fakeLog(dados),
      findAll: async (opcoes = {}) => {
        estado.consultas.push(opcoes);
        if (opcoes.limit) return estado.logsRecentes.slice(0, opcoes.limit);
        return estado.logsAntigos.slice();
      },
    },
  },
};

// Configuração em memória: permite provar que a retenção CONFIGURADA é a que
// manda (e não o `.env`), que é o que a área do Super Admin grava.
const loja = new Map();
const configPath = require.resolve('../helpers/config');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, fallback = null) => (loja.has(chave) ? loja.get(chave) : fallback),
    setConfig: async (chave, valor) => {
      loja.set(chave, valor);
      return { chave, valor };
    },
  },
};

const ROTULOS = { google_drive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'Microsoft OneDrive' };
const storagePath = require.resolve('../helpers/storage');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
  exports: {
    destinoDeBackup: async () => estado.storage.destino,
    obterProvedor: (nome) => (nome ? { nome, rotulo: () => ROTULOS[nome] || nome, icone: () => 'bi bi-cloud' } : null),
    ligacaoDeBackup: () => estado.storage.ligacao,
    provedores: () => Object.keys(ROTULOS),
    pastaDeBackups: async (nome, condominioId) => {
      estado.consultas.push({ pastaDeBackups: [nome, condominioId] });
      return 'pasta-backups';
    },
    uploadComProvedor: async (nome, opcoes) => {
      estado.uploads.push({ nome, opcoes });
      if (estado.storage.erroUpload) throw new Error(estado.storage.erroUpload);
      return { localizador: estado.storage.localizador };
    },
    apagarArquivo: async (localizador, condominioId) => {
      estado.apagadosCloud.push({ localizador, condominioId });
      if (estado.storage.erroApagar) throw new Error(estado.storage.erroApagar);
      return estado.storage.resultadoApagar;
    },
  },
};

// mysqldump substituído ANTES de carregar o job (que desestrutura `execFile`).
const cp = require('child_process');
const execFileOriginal = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => {
  if (estado.dumpFalha) return cb(new Error(estado.dumpFalha));
  return cb(null, DUMP);
};

const dirLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'gescondu-backup-ret-'));
process.env.BACKUP_LOCAL_DIR = dirLocal;
// O `.env` não pode influenciar estes testes: a fonte é a configuração.
delete process.env.BACKUP_DAILY_RETENTION;
delete process.env.BACKUP_CLOUD_RETENTION;

const inventario = require('../helpers/backup-inventario');
const retencao = require('../helpers/backup-retencao');
const job = require('../jobs/backup');

// ── Utilitários do cenário ──────────────────────────────────────────
function limparDir() {
  for (const f of fs.readdirSync(dirLocal)) fs.rmSync(path.join(dirLocal, f), { recursive: true, force: true });
}

function reiniciar() {
  limparDir();
  loja.clear();
  estado.logsAntigos = [];
  estado.logsRecentes = [];
  estado.consultas = [];
  estado.uploads = [];
  estado.apagadosCloud = [];
  estado.storage = { destino: null, ligacao: null, erroUpload: null, localizador: null, resultadoApagar: true, erroApagar: null };
  estado.dumpFalha = null;
  sequencia = 0;
}

// Escreve um ficheiro de backup com um `epoch` controlado (é o NOME que decide
// a idade — a retenção é por data do backup, não pelo mtime do ficheiro).
function escreverBackup({ tipo = 'diario', dias = 0, conteudo = GZ, nome = null } = {}) {
  const quando = new Date(Date.now() - dias * DIA);
  const alvo = nome || `backup_${tipo}_${quando.toISOString().slice(0, 10)}_${quando.getTime()}.sql.gz`;
  fs.writeFileSync(path.join(dirLocal, alvo), conteudo);
  return alvo;
}

const ficheiros = () => fs.readdirSync(dirLocal).sort();

// Registo de `backup_logs` falso com `update` a SÉRIO (atribui de verdade): sem
// isto, uma limpeza que apagasse a referência passaria despercebida.
function logFalso(id, dados) {
  const log = { id, ...dados };
  log.update = async (novos) => {
    Object.assign(log, novos);
    return log;
  };
  return log;
}

// ── Unidades: nome, validação e segurança de caminho ───────────────
function testeUnidadesInventario() {
  // Nome auto-descritivo: tipo + data + instante.
  const n = inventario.analisarNome('backup_semanal_2026-09-21_1790000000000.sql.gz');
  assert.ok(n, 'um nome bem formado é reconhecido');
  assert.strictEqual(n.tipo, 'semanal');
  assert.strictEqual(n.data, '2026-09-21');
  assert.strictEqual(n.criadoEm.getTime(), 1790000000000);

  // Tudo o resto é RECUSADO (nunca é tratado como backup).
  for (const nome of [
    'Ata da assembleia.pdf',
    'backup_diario_2026-09-21.sql.gz', // sem epoch
    'backup_extra_2026-09-21_1.sql.gz', // tipo desconhecido
    'backup_diario_2026-09-21_1790000000000.zip', // extensão errada
    'backup_diario_2026-09-21_99999999999999999999.sql.gz', // data fora do intervalo
    '../backup_diario_2026-09-21_1.sql.gz',
    'sub/backup_diario_2026-09-21_1.sql.gz',
  ]) {
    assert.strictEqual(inventario.analisarNome(nome), null, `nome recusado: ${nome}`);
  }

  // Path traversal: só passa um nome simples e conforme, dentro do diretório.
  for (const nome of ['../../etc/passwd', '..\\windows\\system32', '/etc/passwd', 'Ata.pdf', '', null, 'backup_diario_2026-09-21_1.sql.gz/../x']) {
    assert.strictEqual(inventario.caminhoSeguro(dirLocal, nome), null, `caminho recusado: ${nome}`);
  }
  const bom = inventario.caminhoSeguro(dirLocal, 'backup_diario_2026-09-21_1790000000000.sql.gz');
  assert.strictEqual(path.dirname(bom), path.resolve(dirLocal), 'o caminho aceite fica DENTRO do diretório');

  // Validação do ficheiro: vazio e não-gzip são inválidos.
  const vazio = path.join(dirLocal, 'backup_diario_2026-09-21_1.sql.gz');
  fs.writeFileSync(vazio, Buffer.alloc(0));
  assert.strictEqual(inventario.validarFicheiro(vazio).valido, false);
  assert.strictEqual(inventario.validarFicheiro(vazio).motivo, 'vazio');
  const texto = path.join(dirLocal, 'backup_diario_2026-09-21_2.sql.gz');
  fs.writeFileSync(texto, Buffer.from('isto nao e gzip'));
  assert.strictEqual(inventario.validarFicheiro(texto).valido, false);
  assert.strictEqual(inventario.validarFicheiro(texto).motivo, 'nao_e_gzip');
  const bomFicheiro = path.join(dirLocal, 'backup_diario_2026-09-21_3.sql.gz');
  fs.writeFileSync(bomFicheiro, GZ);
  const v = inventario.validarFicheiro(bomFicheiro);
  assert.strictEqual(v.valido, true);
  assert.strictEqual(v.tamanho, GZ.length);
  limparDir();
  console.log('  ✓ nome, caminho e validação: um documento nunca passa por backup');
}

// ── Unidades: retenção ──────────────────────────────────────────────
function testeUnidadesRetencao() {
  // Mínimo de 30 dias, SEM máximo artificial.
  assert.strictEqual(retencao.DIAS_MINIMO, 30);
  for (const valor of [null, undefined, '', 'abc', '29', 0, -1, 29.5]) {
    assert.strictEqual(retencao.normalizarDias(valor).ok, false, `recusado: ${JSON.stringify(valor)}`);
  }
  for (const valor of [30, '30', 60, 90, 180, 365, 730, 3650, 36500]) {
    assert.strictEqual(retencao.normalizarDias(valor).ok, true, `aceite: ${valor}`);
  }
  assert.ok(retencao.DIAS_MAXIMO > 365, 'não há um máximo de 30 dias');
  assert.strictEqual(retencao.normalizarDias('30').dias, 30);
  assert.strictEqual(retencao.normalizarDias(3650).dias, 3650, 'retenções longas são aceites');

  // Seleção por IDADE (nunca por número de ficheiros).
  const agora = new Date('2026-09-21T12:00:00Z');
  const item = (nome, dias, valido = true) => ({ nome, criadoEm: new Date(agora.getTime() - dias * DIA), valido });
  const antigos = [item('a', 100), item('b', 90), item('c', 1)];
  const r1 = retencao.selecionarPorIdade({ itens: antigos, dias: 30, agora });
  assert.deepStrictEqual(r1.apagar.map((i) => i.nome).sort(), ['a', 'b'], 'só os mais antigos do que 30 dias são candidatos');
  assert.deepStrictEqual(r1.manter.map((i) => i.nome), ['c']);

  // PROTEÇÃO: todos fora do prazo ⇒ o mais recente VÁLIDO fica.
  const todosAntigos = [item('a', 300), item('b', 200), item('c', 100)];
  const r2 = retencao.selecionarPorIdade({ itens: todosAntigos, dias: 30, agora });
  assert.deepStrictEqual(r2.apagar.map((i) => i.nome), ['a', 'b'], 'nunca se apaga o último backup válido');
  assert.strictEqual(r2.protegido.nome, 'c');

  // A proteção é do último VÁLIDO: um inválido mais recente não conta.
  const comInvalidos = [item('a', 300), item('b', 250), item('x', 100, false)];
  const r3 = retencao.selecionarPorIdade({ itens: comInvalidos, dias: 30, agora });
  assert.deepStrictEqual(r3.apagar.map((i) => i.nome).sort(), ['a', 'x'], 'o inválido não é protegido');
  assert.strictEqual(r3.protegido.nome, 'b', 'protege-se o último backup VÁLIDO');

  // Sem nenhum válido não há nada a proteger (e um ficheiro inválido não é backup).
  const soInvalidos = [item('a', 300, false), item('b', 200, false)];
  const r4 = retencao.selecionarPorIdade({ itens: soInvalidos, dias: 30, agora });
  assert.strictEqual(r4.apagar.length, 2);
  assert.strictEqual(r4.protegido, null);

  // Corte por DATA explícita (eliminação manual) usa a mesma proteção.
  const r5 = retencao.selecionarPorIdade({ itens: todosAntigos, limite: new Date(agora.getTime() - 10 * DIA), agora });
  assert.deepStrictEqual(r5.apagar.map((i) => i.nome), ['a', 'b']);
  assert.strictEqual(r5.protegido.nome, 'c');

  // Eliminação individual: recusada quando deixaria a instalação sem backup.
  assert.strictEqual(retencao.podeApagarIndividual({ valido: true }, [{ valido: true }]).ok, false);
  assert.strictEqual(retencao.podeApagarIndividual({ valido: true }, [{ valido: true }, { valido: true }]).ok, true);
  assert.strictEqual(retencao.podeApagarIndividual({ valido: false }, [{ valido: true }]).ok, true, 'um ficheiro inválido não é o último backup');
  console.log('  ✓ retenção por idade, mínimo 30, sem máximo e com proteção do último válido');
}

// ── A — sem cloud ──────────────────────────────────────────────────
async function testeA() {
  reiniciar();
  const log = await job.executarBackup('diario');
  assert.strictEqual(log.estado, 'concluido', 'sem cloud: conclui');
  assert.ok(log.tamanho > 0, 'sem cloud: a cópia local tem tamanho registado');
  assert.strictEqual(log.ficheiro_drive_id, undefined, 'sem cloud: nenhum localizador');
  assert.strictEqual(log.erro, null, 'sem cloud: nenhum erro');
  assert.strictEqual(estado.uploads.length, 0, 'sem cloud: nenhum upload tentado');

  const lista = ficheiros();
  assert.strictEqual(lista.length, 1, 'exatamente uma cópia local');
  const v = inventario.validarFicheiro(path.join(dirLocal, lista[0]));
  assert.strictEqual(v.valido, true, 'a cópia local é um gzip válido');
  assert.strictEqual(v.tamanho, log.tamanho, 'o tamanho registado é o do ficheiro em disco');
  assert.ok(inventario.analisarNome(lista[0]), 'o nome é auto-descritivo (tipo + data + instante)');
  console.log('  ✓ A. sem cloud, a cópia local é criada e validada');
}

// ── B — cloud funcional ────────────────────────────────────────────
async function testeB() {
  reiniciar();
  estado.storage.destino = 'google_drive';
  estado.storage.ligacao = { condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' };
  estado.storage.localizador = 'gd:ficheiro-1';
  const log = await job.executarBackup('manual');

  assert.strictEqual(estado.uploads.length, 1, 'com destino utilizável há upload');
  assert.strictEqual(estado.uploads[0].nome, 'google_drive');
  assert.strictEqual(estado.uploads[0].opcoes.condominioId, null, 'ligação de plataforma: sem condomínio');
  assert.strictEqual(estado.uploads[0].opcoes.parentFolderId, 'pasta-backups');
  assert.strictEqual(log.estado, 'concluido');
  assert.strictEqual(log.ficheiro_drive_id, 'gd:ficheiro-1', 'a cópia cloud fica registada');
  assert.ok(log.tamanho > 0, 'a cópia local fica registada');
  assert.strictEqual(ficheiros().length, 1, 'as duas cópias coexistem (local + cloud)');

  const apresentado = inventario.apresentarLista({ diretorio: dirLocal, logs: [log], rotulos: ROTULOS });
  assert.strictEqual(apresentado.itens[0].estado, 'local_com_cloud');
  assert.strictEqual(apresentado.itens[0].temCloud, true);
  assert.strictEqual(apresentado.itens[0].cloud.rotulo, 'Google Drive');
  console.log('  ✓ B. com cloud funcional ficam as duas cópias, ambas registadas');
}

// ── C — cloud indisponível ─────────────────────────────────────────
async function testeC() {
  reiniciar();
  loja.set(retencao.CHAVES.retencaoLocal, '30');
  // Um backup antigo que JÁ devia ter saído: prova que a retenção local corre
  // mesmo com a cópia cloud a falhar.
  const antigo = escreverBackup({ dias: 100 });
  estado.storage.destino = 'dropbox';
  estado.storage.ligacao = { condominioId: null, conta: null, origem: 'plataforma' };
  estado.storage.erroUpload = '503 service unavailable';

  const log = await job.executarBackup('diario');
  assert.strictEqual(estado.uploads.length, 1, 'a cópia cloud foi tentada');
  assert.strictEqual(log.estado, 'concluido', 'a falha da cloud não transforma um backup válido em erro');
  assert.ok(/503 service unavailable/.test(log.erro), 'o motivo fica registado');
  assert.strictEqual(log.ficheiro_drive_id, undefined, 'falha da cloud: nenhum localizador');

  const lista = ficheiros();
  assert.ok(!lista.includes(antigo), 'a retenção LOCAL correu apesar da falha da cloud');
  assert.strictEqual(lista.length, 1, 'a cópia local nova continua lá');
  assert.strictEqual(inventario.validarFicheiro(path.join(dirLocal, lista[0])).valido, true);
  console.log('  ✓ C. cloud indisponível: a cópia local é preservada e a retenção local corre');
}

// ── D — credenciais cloud inválidas ────────────────────────────────
async function testeD() {
  reiniciar();
  estado.storage.destino = 'onedrive';
  estado.storage.ligacao = { condominioId: null, conta: null, origem: 'plataforma' };
  estado.storage.erroUpload = 'invalid_grant: AADSTS700082';
  const log = await job.executarBackup('diario');
  assert.strictEqual(log.estado, 'concluido', 'a cópia local é independente das credenciais da cloud');
  assert.ok(/invalid_grant/.test(log.erro), 'o erro de autenticação fica registado');
  assert.strictEqual(ficheiros().length, 1, 'a cópia local existe');
  const apresentado = inventario.apresentarLista({ diretorio: dirLocal, logs: [log], rotulos: ROTULOS });
  assert.strictEqual(apresentado.itens[0].estado, 'local_copia_cloud_falhada');
  assert.ok(!/invalid_grant/.test(apresentado.itens[0].rotulo), 'o rótulo do estado não despeja a mensagem técnica');
  console.log('  ✓ D. credenciais cloud inválidas: o local é independente e o erro é registado');
}

// ── E — falha do backup local ──────────────────────────────────────
async function testeE() {
  // E1: o dump falha.
  reiniciar();
  estado.storage.destino = 'google_drive';
  estado.storage.ligacao = { condominioId: null, conta: null, origem: 'plataforma' };
  estado.dumpFalha = 'mysqldump: command not found';
  const log = await job.executarBackup('diario');
  assert.strictEqual(log.estado, 'erro', 'sem dump não há backup: o ciclo falha');
  assert.strictEqual(ficheiros().length, 0, 'não se inventa uma cópia local');
  assert.strictEqual(log.tamanho, undefined, 'sem cópia local não há tamanho');
  assert.strictEqual(estado.uploads.length, 0, 'sem backup local NÃO se copia para a cloud');

  // E2: a cópia local não se consegue escrever.
  reiniciar();
  const bloqueador = path.join(dirLocal, 'bloqueador');
  fs.writeFileSync(bloqueador, 'nao e um diretorio');
  const original = process.env.BACKUP_LOCAL_DIR;
  process.env.BACKUP_LOCAL_DIR = path.join(bloqueador, 'sub');
  const log2 = await job.executarBackup('diario');
  process.env.BACKUP_LOCAL_DIR = original;
  assert.strictEqual(log2.estado, 'erro', 'sem cópia local o ciclo FALHA');
  assert.strictEqual(estado.uploads.length, 0, 'a cloud nunca é tratada como substituto do local');

  // E3: o ficheiro é escrito mas o conteúdo NÃO é um dump comprimido válido.
  // A validação da cópia local é o que impede um ficheiro truncado/corrompido de
  // passar por backup — e o ciclo tem de FALHAR, não de seguir para a cloud.
  reiniciar();
  estado.storage.destino = 'google_drive';
  estado.storage.ligacao = { condominioId: null, conta: null, origem: 'plataforma' };
  const gzipOriginal = zlib.gzipSync;
  zlib.gzipSync = () => Buffer.from('isto nao e um gzip');
  const log3 = await job.executarBackup('diario');
  zlib.gzipSync = gzipOriginal;
  assert.strictEqual(log3.estado, 'erro', 'uma cópia local inválida FALHA o ciclo');
  assert.strictEqual(log3.tamanho, undefined, 'sem cópia local válida não se registra tamanho');
  assert.strictEqual(estado.uploads.length, 0, 'sem cópia local válida não há cópia cloud');
  assert.ok(/validação/.test(log3.erro), `o motivo é a validação (${log3.erro})`);
  console.log('  ✓ E. falha do backup local falha o ciclo — a cloud não é substituto');
}

// ── F — retenção local ─────────────────────────────────────────────
async function testeF() {
  reiniciar();
  loja.set(retencao.CHAVES.retencaoLocal, '30');
  const dentro = escreverBackup({ dias: 5 });
  const fora1 = escreverBackup({ dias: 40 });
  const fora2 = escreverBackup({ dias: 200 });

  const r = await job.limparBackupsLocais({ dias: 30 });
  assert.deepStrictEqual(r.apagados.map((a) => a.nome).sort(), [fora1, fora2].sort(), 'só os que passaram o prazo');
  assert.deepStrictEqual(ficheiros(), [dentro], 'os que estão dentro da retenção permanecem');
  assert.strictEqual(r.erros.length, 0);

  // O filtro é por IDADE e não «apagar tudo menos o mais recente»: um backup
  // dentro do prazo que NÃO é o mais recente tem de sobreviver. (Sem este caso,
  // «apagar tudo + proteger o mais recente» daria o mesmo resultado.)
  reiniciar();
  const b200 = escreverBackup({ dias: 200 });
  const b100 = escreverBackup({ dias: 100 });
  const b5 = escreverBackup({ dias: 5 });
  const b1 = escreverBackup({ dias: 1 });
  const rIdade = await job.limparBackupsLocais({ dias: 30 });
  assert.deepStrictEqual(rIdade.apagados.map((a) => a.nome).sort(), [b200, b100].sort(), 'só os que têm mais de 30 dias');
  assert.deepStrictEqual(ficheiros(), [b1, b5].sort(), 'os backups dentro do prazo ficam — mesmo os que não são os mais recentes');

  // Proteção: TODOS fora do prazo ⇒ fica o mais recente.
  reiniciar();
  const a = escreverBackup({ dias: 400 });
  const b = escreverBackup({ dias: 300 });
  const c = escreverBackup({ dias: 200 });
  const r2 = await job.limparBackupsLocais({ dias: 30 });
  assert.deepStrictEqual(ficheiros(), [c], 'nunca se fica sem backup local');
  assert.strictEqual(r2.protegido.nome, c);
  assert.deepStrictEqual(r2.apagados.map((x) => x.nome).sort(), [a, b].sort());

  // A retenção CONFIGURADA manda sobre o `.env`.
  reiniciar();
  process.env.BACKUP_DAILY_RETENTION = '3650';
  loja.set(retencao.CHAVES.retencaoLocal, '30');
  const velho = escreverBackup({ dias: 60 });
  const recente2 = escreverBackup({ dias: 1 });
  await job.limparBackupsLocais({ dias: (await job.configuracaoRetencao()).retencaoLocal });
  assert.deepStrictEqual(ficheiros(), [recente2], 'a retenção gravada (30) venceu o .env (3650)');
  delete process.env.BACKUP_DAILY_RETENTION;
  assert.ok(velho);
  console.log('  ✓ F. retenção local por idade, com o último backup válido sempre protegido');
}

// ── G — retenção cloud independente ────────────────────────────────
async function testeG() {
  reiniciar();
  const localRecente = escreverBackup({ dias: 1 });
  const antigo = new Date(Date.now() - 200 * DIA);
  const recente = new Date(Date.now() - 2 * DIA);
  estado.logsAntigos = [
    logFalso(1, { tipo: 'diario', estado: 'concluido', data: antigo, ficheiro_drive_id: 'gd:velho-1', tamanho: 10 }),
    logFalso(2, { tipo: 'diario', estado: 'concluido', data: antigo, ficheiro_drive_id: 'gd:velho-2', tamanho: 11 }),
  ];
  const ligacao = { condominioId: 7, conta: 'gestao@exemplo.pt', origem: 'condominio' };

  const r = await job.limparBackupsCloud({ dias: 30, ligacao });
  assert.strictEqual(r.apagados.length, 2, 'as duas cópias cloud antigas foram removidas');
  assert.strictEqual(r.suportado, true);
  // ⛔ ÂMBITO: a remoção tem de usar a ligação real (antes era chamada SEM
  // condomínio e resolvia os tokens da plataforma — apagava na conta errada).
  assert.deepStrictEqual(estado.apagadosCloud.map((a) => a.condominioId), [7, 7], 'a remoção usa o âmbito da ligação');
  assert.deepStrictEqual(estado.apagadosCloud.map((a) => a.localizador), ['gd:velho-1', 'gd:velho-2']);
  // A referência é limpa para o registo não anunciar uma cópia que já não existe.
  assert.strictEqual(estado.logsAntigos[0].ficheiro_drive_id, null);
  // A limpeza cloud NÃO toca em ficheiros locais.
  assert.deepStrictEqual(ficheiros(), [localRecente], 'a limpeza cloud não apaga backups locais');
  assert.ok(!ficheiros().includes(localRecente) === false);

  // O filtro por idade vai para a consulta (não se apaga o que está dentro do prazo).
  const consulta = estado.consultas.find((c) => c.where && c.where.ficheiro_drive_id);
  assert.ok(consulta, 'a limpeza cloud consulta o registo por referência');
  assert.ok(consulta.where.data, 'a limpeza cloud é por DATA (idade), não por número de ficheiros');

  // Provedor sem remoção (Dropbox): registar em vez de fingir.
  reiniciar();
  const local = escreverBackup({ dias: 1 });
  estado.storage.resultadoApagar = false;
  estado.logsAntigos = [
    logFalso(1, { tipo: 'diario', estado: 'concluido', data: antigo, ficheiro_drive_id: 'dbx:x', tamanho: 10 }),
  ];
  const r2 = await job.limparBackupsCloud({ dias: 30, ligacao });
  assert.strictEqual(r2.suportado, false, 'o provedor sem remoção é assinalado');
  assert.deepStrictEqual(r2.erros.map((e) => e.erro), ['provedor_sem_remocao']);
  assert.strictEqual(r2.apagados.length, 0, 'sem remoção real nada é dado como apagado');
  assert.strictEqual(estado.logsAntigos[0].ficheiro_drive_id, 'dbx:x', 'sem remoção confirmada, a referência NÃO é limpa');
  assert.deepStrictEqual(ficheiros(), [local], 'a limpeza cloud não apaga backups locais');

  // Falha de autenticação na cloud: nenhuma eliminação LOCAL.
  reiniciar();
  const local2 = escreverBackup({ dias: 1 });
  estado.storage.erroApagar = '401 invalid_grant';
  estado.logsAntigos = [
    logFalso(1, { tipo: 'diario', estado: 'concluido', data: antigo, ficheiro_drive_id: 'od:y', tamanho: 10 }),
  ];
  const r3 = await job.limparBackupsCloud({ dias: 30, ligacao });
  assert.strictEqual(r3.apagados.length, 0);
  assert.ok(/invalid_grant/.test(r3.erros[0].erro));
  assert.strictEqual(estado.logsAntigos[0].ficheiro_drive_id, 'od:y', 'uma falha de remoção não limpa a referência');
  assert.deepStrictEqual(ficheiros(), [local2], 'uma falha de autenticação cloud não apaga nada localmente');
  assert.ok(recente);
  console.log('  ✓ G. a retenção cloud é independente, usa o âmbito certo e nunca apaga o local');
}

// ── H — métricas reais ─────────────────────────────────────────────
async function testeH() {
  reiniciar();
  const maisAntigo = escreverBackup({ dias: 100, conteudo: zlib.gzipSync(Buffer.from('a'.repeat(1000))) });
  const recente = escreverBackup({ dias: 1, conteudo: zlib.gzipSync(Buffer.from('b'.repeat(500))) });
  // Um ficheiro que NÃO é um backup (documento) na mesma pasta.
  fs.writeFileSync(path.join(dirLocal, 'Ata da assembleia.pdf'), Buffer.from('conteudo documental'));

  const medicao = inventario.medir(inventario.listar(dirLocal).itens);
  const bytesEsperados =
    fs.statSync(path.join(dirLocal, maisAntigo)).size + fs.statSync(path.join(dirLocal, recente)).size;
  assert.strictEqual(medicao.numero, 2, 'conta apenas os backups válidos');
  assert.strictEqual(medicao.bytes, bytesEsperados, 'o espaço é medido a partir dos ficheiros reais');
  assert.strictEqual(medicao.invalidos, 0);
  assert.ok(medicao.maisAntigo < medicao.maisRecente, 'mais antigo antes do mais recente');
  assert.strictEqual(medicao.ultimo.nome, recente, 'o último é o mais recente');

  const lista = inventario.listar(dirLocal);
  assert.deepStrictEqual(lista.ignorados, ['Ata da assembleia.pdf'], 'um documento na pasta é IGNORADO');

  // A área do Super Admin usa a mesma medição (uma só verdade).
  const daArea = await job.listarBackupsLocais();
  assert.strictEqual(daArea.medicao.numero, 2);
  assert.strictEqual(daArea.medicao.bytes, bytesEsperados);
  assert.strictEqual(daArea.ignorados.length, 1);
  assert.strictEqual(daArea.itens.length, 2, 'o documento não entra na lista de backups');
  assert.ok(daArea.itens.every((i) => i.tipoRotulo), 'cada backup traz o rótulo do tipo');
  console.log('  ✓ H. métricas medidas a partir dos ficheiros reais, sem contar documentos');
}

// ── I — eliminação manual ──────────────────────────────────────────
async function testeI() {
  reiniciar();
  const a = escreverBackup({ dias: 10 });
  const b = escreverBackup({ dias: 5 });

  // Individual: permitida enquanto houver mais do que um backup válido.
  const r1 = job.apagarBackupLocal({ nome: a });
  assert.strictEqual(r1.ok, true, 'um backup entre vários pode ser eliminado');
  assert.deepStrictEqual(ficheiros(), [b]);

  // Proteção do último backup válido.
  const r2 = job.apagarBackupLocal({ nome: b });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.motivo, 'ultimo_backup_valido');
  assert.deepStrictEqual(ficheiros(), [b], 'o último backup não é eliminado');

  // Path traversal e nomes que não são backups: recusados.
  for (const nome of ['../../etc/passwd', 'Ata.pdf', 'backup_diario_2026-01-01.sql.gz', '']) {
    const r = job.apagarBackupLocal({ nome });
    assert.strictEqual(r.ok, false, `recusado: ${nome}`);
    assert.strictEqual(r.motivo, 'nome_invalido');
  }
  assert.deepStrictEqual(ficheiros(), [b], 'nenhuma recusa apagou nada');

  // Por data: remove as anteriores, preserva as posteriores.
  reiniciar();
  const velho1 = escreverBackup({ dias: 300 });
  const velho2 = escreverBackup({ dias: 200 });
  const novo = escreverBackup({ dias: 2 });
  const limite = new Date(Date.now() - 30 * DIA).toISOString().slice(0, 10);
  const r3 = await job.apagarBackupsAntesDe({ dataLimite: limite });
  assert.strictEqual(r3.ok, true);
  assert.deepStrictEqual(r3.apagados.map((x) => x.nome).sort(), [velho1, velho2].sort());
  assert.deepStrictEqual(ficheiros(), [novo]);

  // Por data com TODOS anteriores: o último válido é preservado.
  reiniciar();
  escreverBackup({ dias: 300 });
  escreverBackup({ dias: 200 });
  const r4 = await job.apagarBackupsAntesDe({ dataLimite: new Date().toISOString().slice(0, 10) });
  assert.strictEqual(r4.apagados.length, 1, 'só um é removido');
  assert.strictEqual(ficheiros().length, 1, 'a instalação nunca fica sem backup local');
  assert.ok(r4.protegido, 'o protegido é reportado');

  // Data inválida: recusada sem tocar em nada.
  const r5 = await job.apagarBackupsAntesDe({ dataLimite: 'ontem' });
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(r5.motivo, 'data_invalida');
  assert.strictEqual(ficheiros().length, 1);
  console.log('  ✓ I. eliminação manual (individual e por data) com a proteção do último backup');
}

// ── K — documentos separados dos backups ───────────────────────────
function testeK() {
  reiniciar();
  const doc = path.join(dirLocal, 'Recibo 2026-01.pdf');
  fs.writeFileSync(doc, Buffer.from('documento do condomínio'));

  // A rotina de retenção não toca em ficheiros documentais, mesmo muito antigos.
  const { itens } = inventario.listar(dirLocal);
  assert.strictEqual(itens.length, 0, 'um documento não é um item de backup');
  const decisao = retencao.selecionarPorIdade({ itens, dias: 30 });
  assert.strictEqual(decisao.apagar.length, 0, 'nada a apagar: o documento não é candidato');
  assert.ok(fs.existsSync(doc), 'o documento continua intacto');

  // Fonte: o mecanismo de backup não conhece documentos nem os copia.
  // As verificações são sobre o CÓDIGO (as palavras aparecem legitimamente nos
  // comentários que explicam precisamente que os documentos ficam de fora).
  const fonte = ler('jobs/backup.js');
  assert.ok(!/\bDocumento\b/.test(fonte), 'o job não usa o modelo de documentos');
  assert.ok(!/\.models/.test(fonte) || !/Documento/.test(fonte), 'o job não importa o modelo de documentos');
  for (const proibido of ['\\bzip\\b', '\\bzipar\\b', 'espelho', 'sincroniz']) {
    assert.ok(!new RegExp(proibido, 'i').test(fonte), `o job de backups não deve conter «${proibido}»`);
  }
  const fonteInventario = ler('helpers/backup-inventario.js');
  assert.ok(!/require\(['"]\.\.\/models/.test(fonteInventario), 'o inventário não lê a base de dados (não pode tocar em documentos)');
  assert.ok(!/require\(['"]\.\.\/helpers\/storage/.test(fonteInventario), 'o inventário não fala com o armazenamento documental');

  // E o espaço dos backups é independente do espaço dos documentos: a medição
  // dos backups só olha para a pasta de backups.
  const medicao = inventario.medir(itens);
  assert.strictEqual(medicao.bytes, 0, 'os documentos não entram no espaço dos backups');
  fs.rmSync(doc, { force: true });
  console.log('  ✓ K. os documentos são um eixo separado — nunca entram no backup local');
}

// ── J (parte offline): a limpeza automática pode ser desligada ─────
async function testeLimpezaDesligada() {
  reiniciar();
  const antigo = escreverBackup({ dias: 400 });
  const recente = escreverBackup({ dias: 1 });
  loja.set(retencao.CHAVES.retencaoLocal, '30');
  loja.set(retencao.CHAVES.limpezaAutomatica, '0');

  const r = await job.executarLimpeza();
  assert.strictEqual(r.executada, false, 'com a limpeza desligada nada corre');
  assert.strictEqual(r.motivo, 'limpeza_desativada');
  assert.deepStrictEqual(ficheiros(), [antigo, recente].sort(), 'nada foi removido');

  // Mas a limpeza MANUAL (forçada) corre sempre.
  const r2 = await job.executarLimpeza({ forcar: true });
  assert.strictEqual(r2.executada, true);
  assert.deepStrictEqual(ficheiros(), [recente], 'a limpeza forçada corre mesmo com a automática desligada');
  assert.strictEqual(loja.get(retencao.CHAVES.ultimaLimpeza) !== undefined, true, 'a última limpeza fica registada');
  assert.ok(String(loja.get(retencao.CHAVES.resultadoLimpeza)).includes('local'), 'o resultado fica registado');
  console.log('  ✓ limpeza automática desligável; a limpeza manual corre sempre e fica registada');
}

(async () => {
  testeUnidadesInventario();
  testeUnidadesRetencao();
  await testeA();
  await testeB();
  await testeC();
  await testeD();
  await testeE();
  await testeF();
  await testeG();
  await testeH();
  await testeI();
  testeK();
  await testeLimpezaDesligada();
  cp.execFile = execFileOriginal;
  fs.rmSync(dirLocal, { recursive: true, force: true });
  console.log('✓ Testes de inventário, retenção e gestão manual dos backups passaram (sem base de dados).');
})().catch((err) => {
  cp.execFile = execFileOriginal;
  try { fs.rmSync(dirLocal, { recursive: true, force: true }); } catch (e) { /* nada */ }
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
