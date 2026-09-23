// ═══════════════════════════════════════════════════════════════════
// P53-FOLLOWUP — Execução de processos-filho DISCRIMINANTE.
//
// Um harness de mutação só pode declarar «mutação detetada» quando o
// processo-filho REALMENTE arrancou, executou o alvo e terminou com um
// desfecho. O ambiente do host pode impedir o arranque do filho — neste
// host, `execFileSync(..., { stdio: 'pipe' })` falha com `EBUSY` porque o
// **pipe de STDIN** é recusado — e o `catch` de um harness ingénuo
// interpretava esse erro de INFRAESTRUTURA como «o teste falhou», isto é,
// como mutação detetada. O resultado era um verde vazio: nenhuma das
// mutações chegava a ser executada e o harness dizia «N mutações, todas
// detetadas».
//
// Este helper fecha essa porta:
//   1. corre o filho com STDIN em `ignore` (a causa do `EBUSY`), preservando
//      stdout/stderr em pipe (necessários ao diagnóstico) e o exit code;
//   2. classifica o desfecho em três estados que NÃO se confundem:
//        · PASSOU        — o filho correu e saiu com 0;
//        · FALHOU        — o filho correu e saiu com código ≠ 0 (deteção);
//        · INTERROMPIDO  — o filho correu e foi morto por um sinal
//                          (timeout/SIGTERM): inconclusivo;
//        · ERRO_EXECUCAO — o filho NÃO chegou a correr (spawn falhou:
//                          EBUSY/ENOENT/EACCES/…). Nunca é uma deteção.
//   3. quando o estado é ERRO_EXECUCAO, lança uma falha EXPLÍCITA e com
//      mensagem inequívoca de infraestrutura (não uma asserção de mutação).
//
// ⛔ Não usa rename nem eliminações. Não toca no safe-delete. Não altera
//    nenhum ficheiro do repositório.
// ═══════════════════════════════════════════════════════════════════
const { execFileSync } = require('child_process');

// Desfechos possíveis de uma execução de processo-filho.
const ESTADO = {
  PASSOU: 'passou',
  FALHOU: 'falhou',
  INTERROMPIDO: 'interrompido',
  ERRO_EXECUCAO: 'erro-de-execucao',
};

// Códigos de erro do `child_process` que provam que o filho não correu.
// `EBUSY` é o observado neste host; os restantes cobrem as falhas de spawn
// clássicas. `status` nulo em todos eles (nunca houve processo para sair).
const ERROS_DE_SPAWN = new Set([
  'EBUSY', 'ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM', 'E2BIG', 'EINVAL',
]);

let _exec = execFileSync;
let _spawnInjetado = false;

// ── Deteção de «o filho correu» ────────────────────────────────────
// Um erro com `status` numérico significa que o processo EXISTIU e saiu com
// esse código (deteção). Um erro com `signal` significa que o processo
// existiu e foi morto (inconclusivo). Um erro SEM `status` e SEM `signal`,
// com código na lista de spawn, significa que o processo NUNCA existiu.
function eErroDeSpawn(e) {
  if (!e) return false;
  if (typeof e.status === 'number') return false; // houve processo: saiu com código
  if (e.signal) return false;                     // houve processo: morto por sinal
  if (e.code && ERROS_DE_SPAWN.has(e.code)) return true;
  return false;
}

function classificar(erro) {
  if (!erro) return ESTADO.PASSOU;
  if (eErroDeSpawn(erro)) return ESTADO.ERRO_EXECUCAO;
  if (erro.signal) return ESTADO.INTERROMPIDO;
  return ESTADO.FALHOU;
}

// Detalhe técnico do erro, para a mensagem de infraestrutura.
function detalhe(erro) {
  if (!erro) return 'sem erro';
  const partes = [`code=${erro.code}`, `status=${erro.status}`, `signal=${erro.signal}`];
  const msg = String(erro.message || '').split('\n')[0];
  if (msg) partes.push(`msg=${msg}`);
  if (erro.errno !== undefined) partes.push(`errno=${erro.errno}`);
  return partes.join(' ');
}

// ── Execução ───────────────────────────────────────────────────────
// `opcoes` aceita o mesmo que `execFileSync` (cwd, timeout, encoding, maxBuffer),
// mas `stdio` é gerido aqui: STDIN é sempre `ignore` (a correção do `EBUSY`) e
// stdout/stderr mantêm-se em pipe, tal como antes.
//
// Devolve SEMPRE um objeto — nunca lança por causa do desfecho do filho. Lança
// apenas se o spawn tiver falhado, e nesse caso com uma mensagem que diz
// explicitamente que é infraestrutura (ver `executarOuFalhar`).
function correr(comando, args, opcoes = {}) {
  const opt = Object.assign({}, opcoes);
  opt.cwd = opt.cwd || process.cwd();
  opt.stdio = ['ignore', 'pipe', 'pipe']; // ⛔ stdin: 'ignore' — mata o EBUSY
  delete opt.stdin;
  if (opt.encoding === undefined) opt.encoding = 'utf8';

  try {
    const saida = _exec(comando, args, opt);
    return { estado: ESTADO.PASSOU, saida: String(saida === null || saida === undefined ? '' : saida), erro: null };
  } catch (e) {
    const stdout = e && e.stdout !== null && e.stdout !== undefined ? String(e.stdout) : '';
    const stderr = e && e.stderr !== null && e.stderr !== undefined ? String(e.stderr) : '';
    return { estado: classificar(e), saida: `${stdout}${stderr}`, erro: e, stdout, stderr };
  }
}

// ── Corrida que FALHA ALTO em erro de infraestrutura ───────────────
// Usada pelos harnesses: um erro de spawn dispara uma falha explícita, com
// prefixo inequívoco, ANTES de qualquer asserção sobre a mutação. Assim é
// impossível confundir «não consegui executar» com «detetei a mutação».
const PREFIXO_INFRA = '[P53-FOLLOWUP] FALHA DE INFRAESTRUTURA — o processo-filho não chegou a correr';

function executarOuFalhar(comando, args, opcoes = {}) {
  const r = correr(comando, args, opcoes);
  if (r.estado === ESTADO.ERRO_EXECUCAO) {
    const err = new Error(
      `${PREFIXO_INFRA}\n`
      + `  comando: ${comando}\n`
      + `  args:    ${JSON.stringify(args)}\n`
      + `  erro:    ${detalhe(r.erro)}\n`
      + '  Isto NÃO é uma mutação detetada: é uma falha de execução. '
      + 'Sem processo-filho não há prova nenhuma e o harness tem de abortar.'
    );
    err.infraestrutura = true;
    err.desfecho = r;
    throw err;
  }
  return r;
}

// ── Conveniências para os harnesses ────────────────────────────────
// `correrScriptDeTeste`: corre `node scripts/<script>` e devolve o estado.
function correrScriptDeTeste(raiz, script) {
  return correr(process.execPath, [require('path').join(raiz, 'scripts', script)], {
    cwd: raiz, timeout: 120000,
  });
}

// `verificarSintaxe`: corre `node --check <ficheiro>`. Distingue três casos:
//   · true    — o ficheiro é JavaScript válido;
//   · false   — o ficheiro é JavaScript INVÁLIDO (erro de sintaxe do filho);
//   · lança   — houve falha de infraestrutura (não dá para afirmar nada).
// Sem esta distinção, uma falha de spawn (EBUSY) era lida como «código
// inválido» — foi exatamente o que deu «produziu código inválido» no
// test-mutacao-despesa-transacao.js antes desta frente.
//
// Nota: `node --check` sai com código ≠ 0 quando a sintaxe é inválida. Esse
// não-zero é um RESULTADO (finding), não uma falha de execução — por isso o
// estado esperado aqui é FALHOU, e só ERRO_EXECUCAO aborta.
function verificarSintaxe(raiz, ficheiro) {
  const r = executarOuFalhar(process.execPath, ['--check', ficheiro], { cwd: raiz });
  return r.estado === ESTADO.PASSOU;
}

// ── Injeção para testes (verification-only) ────────────────────────
// Permite a um teste provocar controladamente uma falha de spawn, sem mexer
// no ambiente nem em proteções do host.
const __testes = {
  definirExec(fn) { _exec = fn; _spawnInjetado = true; },
  reporExec() { _exec = execFileSync; _spawnInjetado = false; },
  execInjetado() { return _spawnInjetado; },
};

module.exports = {
  ESTADO,
  ERROS_DE_SPAWN,
  PREFIXO_INFRA,
  eErroDeSpawn,
  classificar,
  detalhe,
  correr,
  executarOuFalhar,
  correrScriptDeTeste,
  verificarSintaxe,
  __testes,
};
