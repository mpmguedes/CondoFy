// ═══════════════════════════════════════════════════════════════════
// P53-FOLLOWUP — TESTE B: FALHA DE SPAWN NÃO CONTA COMO MUTAÇÃO.
//
// Método (verification-only, não entra no produto):
//   · injeta no helper `correr-processo` uma função de execução que falha SEMPRE
//     com a forma EXATA do erro de spawn deste host (EBUSY, errno -4082,
//     status null, signal null) — isto é, o filho NUNCA corre;
//   · corre o harness REAL `test-mutacao-fcr.js` num processo-filho;
//   · exige que o harness ABORTE com a mensagem de infraestrutura e que NUNCA
//     imprima «todas detetadas» nem conte mutação alguma.
//
// Prova, pelo lado oposto, que a correção não transformou as falhas em
// sucesso: antes desta frente, este mesmo cenário produzia EXIT 0 e
// «3 mutações, todas detetadas».
//
// Utilização: node scripts/test-falha-spawn.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const RAIZ = path.join(__dirname, '..');
const correrProc = require('./helpers/correr-processo');

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Preload que injeta a falha de spawn no harness alvo. Escrito em os.tmpdir()
// para não deixar nada dentro da árvore do repositório.
// Conteúdo dos ficheiros-alvo tal como estão no repositório (HEAD). Lido UMA
// vez, por git, antes de qualquer injeção — para depois se poder comparar o
// estado em disco sem depender de processos-filho. Nota: usa-se o próprio
// helper (`correr`) para o git, porque `spawnSync` com `stdio: 'pipe'` sofre
// do mesmo EBUSY — é precisamente o defeito que esta frente estuda.
const ORIGINAIS = (() => {
  const mapa = {};
  for (const rel of ['helpers/quotas-calc.js']) {
    const r = correrProc.executarOuFalhar('git', ['show', `HEAD:${rel}`], { cwd: RAIZ });
    mapa[rel] = r.saida;
  }
  return mapa;
})();

const PRELOAD = path.join(os.tmpdir(), 'a2-p53f-preload-falha-spawn.cjs');

function escreverPreload() {
  fs.writeFileSync(PRELOAD, `
// Injetado só para este teste: toda a execução de processo-filho falha com a
// forma EXATA do EBUSY deste host. O filho nunca chega a correr.
const alvo = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'helpers', 'correr-processo.js'))});
alvo.__testes.definirExec(function falhaSempre() {
  const e = new Error('spawnSync node.exe EBUSY');
  e.code = 'EBUSY';
  e.errno = -4082;
  e.status = null;
  e.signal = null;
  throw e;
});
`);
  return PRELOAD;
}

(function principal() {
  console.log('P53-FOLLOWUP — teste B: falha de spawn não é mutação detetada');

  // ── 1. O cenário controlado aborta o harness REAL ───────────────
  titulo('1. Harness real com spawn sempre falhado → aborta, não deteta');
  {
    const preload = escreverPreload();
    const r = cp.spawnSync(process.execPath,
      ['--require', preload, path.join(RAIZ, 'scripts', 'test-mutacao-fcr.js')],
      { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });

    const saida = `${r.stdout || ''}${r.stderr || ''}`;
    assert.notStrictEqual(r.status, 0,
      '⛔ o harness NÃO pode terminar com sucesso quando o filho nunca correu');
    assert.ok(saida.includes(correrProc.PREFIXO_INFRA),
      'a saída tem de conter a mensagem inequívoca de infraestrutura');
    assert.ok(/não chegou a correr/i.test(saida),
      'a mensagem tem de dizer que o processo-filho não chegou a correr');
    assert.ok(!/todas detetadas/i.test(saida),
      '⛔ a saída NÃO pode afirmar que todas as mutações foram detetadas');
    feito(`harness abortou (status=${r.status}) com mensagem de infraestrutura`);

    // Nenhuma mutação pode ter sido contada como detetada.
    const contagem = (saida.match(/a mutação é detetada/g) || []).length;
    assert.strictEqual(contagem, 0,
      `⛔ nenhuma mutação pode ser dada por detetada sem o filho correr (contadas: ${contagem})`);
    feito('zero mutações contadas como detetadas');

    // O ficheiro alvo tem de ficar intacto (o `finally` repõe). Compara-se o
    // conteúdo atual com o do repositório (HEAD) — sem invocar processos-filho,
    // porque o próprio `git` sofreria do mesmo EBUSY que estamos a estudar.
    const alvoRel = 'helpers/quotas-calc.js';
    const alvo = path.join(RAIZ, alvoRel);
    const noDisco = fs.readFileSync(alvo, 'utf8');
    assert.strictEqual(noDisco, ORIGINAIS[alvoRel],
      'o alvo mutado tem de ser reposto mesmo com o harness a abortar');
    feito('alvo reposto byte a byte apesar do aborto');
  }

  // ── 2. Contraste: sem a injeção, o MESMO harness é verde ────────
  titulo('2. Contraste — sem injeção o harness deteta as mutações a sério');
  {
    const r = cp.spawnSync(process.execPath,
      [path.join(RAIZ, 'scripts', 'test-mutacao-fcr.js')],
      { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const saida = `${r.stdout || ''}${r.stderr || ''}`;
    assert.strictEqual(r.status, 0, 'sem falha de spawn o harness tem de passar');
    assert.ok(/3 mutações, todas detetadas/.test(saida),
      'tem de detetar exatamente as 3 mutações do FCR');
    feito('sem injeção: 3 mutações detetadas (a correção não cegou o harness)');
  }

  // ── 3. Verificação de que o preload não ficou na árvore ─────────
  titulo('3. O mecanismo de teste não ficou no repositório');
  {
    assert.ok(!PRELOAD.startsWith(RAIZ),
      'o preload tem de viver fora da árvore do repositório');
    feito(`preload fora da árvore (${PRELOAD})`);
  }

  console.log(`\n✓ Teste B passou (${n} verificações): falha de spawn nunca conta como deteção.`);
})();
