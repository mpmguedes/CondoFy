// ═══════════════════════════════════════════════════════════════════
// P53-FOLLOWUP — Auto-teste do helper `correr-processo`.
//
// Prova, por comportamento, que o helper:
//   1. corre o filho e classifica PASSOU / FALHOU corretamente;
//   2. preserva stdout, stderr e exit code;
//   3. classifica uma falha de SPAWN como ERRO_EXECUCAO (nunca FALHOU —
//      era esta a confusão que produzia os verdes vazios);
//   4. faz `executarOuFalhar` abortar com mensagem de infraestrutura;
//   5. distingue SIGTERM (INTERROMPIDO) de exit code ≠ 0 (FALHOU);
//   6. resolve o `EBUSY` real deste host (prova de execução real do filho).
//
// Utilização: node scripts/test-correr-processo.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const correrProc = require('./helpers/correr-processo');

const { ESTADO } = correrProc;
let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const BANCO = path.join(os.tmpdir(), 'a2-p53f-autoteste');
fs.mkdirSync(BANCO, { recursive: true });

// O erro REAL do `EBUSY` deste host (ou `null` se o ambiente não tiver o bug).
// Recolhido no arranque para ser reutilizado em várias secções.
const erroReal = (() => {
  try {
    cp.execFileSync(process.execPath, ['-e', '0'], { stdio: 'pipe' });
    return null;
  } catch (e) { return e; }
})();

function escreverSonda(nome, codigo) {
  const p = path.join(BANCO, nome);
  fs.writeFileSync(p, codigo);
  return p;
}

(function principal() {  console.log('P53-FOLLOWUP — auto-teste do helper de execução discriminante');

  // ── 1. Desfecho normal ──────────────────────────────────────────
  titulo('1. Execução normal: PASSOU preserva stdout');
  {
    const r = correrProc.correr(process.execPath, ['-e', 'process.stdout.write("TUDO_BEM")']);
    assert.strictEqual(r.estado, ESTADO.PASSOU, 'um filho que sai com 0 tem de dar PASSOU');
    assert.strictEqual(r.saida, 'TUDO_BEM', 'stdout tem de ser preservado');
    feito('filho com exit 0 → PASSOU com stdout capturado');
  }

  // ── 2. Exit code ≠ 0 vira FALHOU (é a deteção) ──────────────────
  titulo('2. Exit code ≠ 0 → FALHOU');
  {
    const r = correrProc.correr(process.execPath,
      ['-e', 'process.stdout.write("SAIDA_ANTES"); process.stderr.write("ERRO_DEPOIS"); process.exit(7)']);
    assert.strictEqual(r.estado, ESTADO.FALHOU, 'exit ≠ 0 depois de correr é FALHOU');
    assert.strictEqual(r.erro.status, 7, 'o exit code tem de ser preservado');
    assert.ok(r.stdout.includes('SAIDA_ANTES'), 'stdout do filho tem de chegar ao pai');
    assert.ok(r.stderr.includes('ERRO_DEPOIS'), 'stderr do filho tem de chegar ao pai');
    assert.ok(r.saida.includes('SAIDA_ANTES') && r.saida.includes('ERRO_DEPOIS'),
      'a saída combinada tem de conter os dois canais');
    feito('exit 7 → FALHOU com stdout+stderr e status preservados');
  }

  // ── 3. Morte por sinal: INTERROMPIDO quando o sinal é observável ─
  titulo('3. Morte por sinal → INTERROMPIDO');
  {
    // 3a. Forma portável: o sinal está no erro.
    const formaPortavel = new Error('Command failed');
    formaPortavel.signal = 'SIGTERM';
    assert.strictEqual(correrProc.classificar(formaPortavel), ESTADO.INTERROMPIDO,
      'um erro COM sinal é inconclusivo, nunca uma deteção');
    assert.notStrictEqual(correrProc.classificar(formaPortavel), ESTADO.FALHOU,
      '⛔ um erro com sinal não pode ser FALHOU (seria uma deteção falsa)');
    feito('erro com signal → INTERROMPIDO (distinto de FALHOU)');

    // 3b. Forma REAL neste host (Windows): o Node NÃO expõe o sinal em
    //     `e.signal` — deixa `signal: null` e fabrica `status: 1`. Documenta-se
    //     o comportamento observado para que ninguém o confunda com deteção
    //     legítima (um SIGTERM do `timeout` tem `status: 1`, tal como um
    //     `process.exit(1)`; a diferença não é observável pela API).
    const sonda = escreverSonda('suicida.js', 'process.kill(process.pid, "SIGTERM");');
    const r = correrProc.correr(process.execPath, [sonda]);
    if (r.erro && r.erro.signal) {
      assert.strictEqual(r.estado, ESTADO.INTERROMPIDO);
      feito(`SIGTERM → INTERROMPIDO (signal=${r.erro.signal}, forma POSIX)`);
    } else {
      assert.strictEqual(r.estado, ESTADO.FALHOU,
        'neste host o sinal não é observável: cai em FALHOU como qualquer exit ≠ 0');
      assert.strictEqual(r.erro.errno, undefined,
        'a marca de «correu» neste host é `errno === undefined`');
      feito('SIGTERM → forma Windows (signal não exposto, errno=undefined) — '
        + 'distinguido de spawn pelo `errno`');
    }
  }

  // ── 4. FALHA DE SPAWN → ERRO_EXECUCAO (o coração da frente) ─────
  titulo('4. Falha de spawn → ERRO_EXECUCAO e NUNCA FALHOU');
  {
    // 4a. Binário inexistente (ENOENT) — o caso mais claro.
    const r1 = correrProc.correr(path.join(BANCO, 'nao-existe-mesmo.exe'), []);
    assert.strictEqual(r1.estado, ESTADO.ERRO_EXECUCAO,
      'ENOENT é falha de execução, não deteção');
    assert.notStrictEqual(r1.estado, ESTADO.FALHOU,
      '⛔ uma falha de spawn NUNCA pode ser classificada como FALHOU (seria uma deteção falsa)');
    assert.strictEqual(r1.erro.code, 'ENOENT');
    feito('ENOENT → ERRO_EXECUCAO (não FALHOU)');

    // 4b. EBUSY sintético — exatamente a forma do erro observado neste host,
    //     reproduzida com `execFileSync` real sobre um `stdio: 'pipe'`.
    if (erroReal && erroReal.code === 'EBUSY') {
      assert.strictEqual(correrProc.classificar(erroReal), ESTADO.ERRO_EXECUCAO,
        'o EBUSY REAL deste host tem de ser classificado como ERRO_EXECUCAO');
      feito(`EBUSY real deste host → ERRO_EXECUCAO (${correrProc.detalhe(erroReal)})`);
    } else {
      // Sem o bug no ambiente, a classificação é provada pela forma do erro.
      const falso = new Error('spawn EBUSY');
      falso.code = 'EBUSY';
      falso.errno = -4082;
      falso.status = null;
      falso.signal = null;
      assert.strictEqual(correrProc.classificar(falso), ESTADO.ERRO_EXECUCAO);
      feito('EBUSY (forma sintética) → ERRO_EXECUCAO [ambiente sem o bug]');
    }

    // 4c. Taxonomia: nenhum erro de spawn pode cair em FALHOU.
    for (const codigo of correrProc.ERROS_DE_SPAWN) {
      const e = new Error('spawn ' + codigo);
      e.code = codigo; e.status = null; e.signal = null;
      assert.strictEqual(correrProc.classificar(e), ESTADO.ERRO_EXECUCAO,
        `${codigo} tem de ser ERRO_EXECUCAO`);
    }
    feito(`${correrProc.ERROS_DE_SPAWN.size} códigos de spawn classificados como ERRO_EXECUCAO`);
  }

  // ── 5. executarOuFalhar aborta com mensagem de infraestrutura ───
  titulo('5. executarOuFalhar aborta com mensagem inequívoca');
  {
    let apanhado = null;
    try {
      correrProc.executarOuFalhar(path.join(BANCO, 'nao-existe-mesmo.exe'), []);
    } catch (e) { apanhado = e; }
    assert.ok(apanhado, 'tem de lançar em falha de infraestrutura');
    assert.strictEqual(apanhado.infraestrutura, true, 'tem de estar marcado como infraestrutura');
    assert.ok(apanhado.message.includes(correrProc.PREFIXO_INFRA),
      'a mensagem tem de conter o prefixo de infraestrutura');
    assert.ok(/não chegou a correr/i.test(apanhado.message),
      'a mensagem tem de dizer que o filho não correu');
    assert.ok(/Isto NÃO é uma mutação detetada/i.test(apanhado.message),
      'a mensagem tem de NEGAR explicitamente que seja uma mutação detetada');
    assert.ok(!/✓/.test(apanhado.message),
      'a mensagem não pode conter marcadores de sucesso');

    // E o caso normal não lança:
    const ok = correrProc.executarOuFalhar(process.execPath, ['-e', 'process.exit(2)']);
    assert.strictEqual(ok.estado, ESTADO.FALHOU, 'exit ≠ 0 devolve FALHOU, não lança');
    feito('aborta por infraestrutura; exit ≠ 0 passa como FALHOU');
  }

  // ── 6. PROVA DE EXECUÇÃO REAL (o EBUSY está resolvido) ──────────
  titulo('6. Prova de execução real do filho (efeito colateral observável)');
  {
    const marca = path.join(BANCO, 'marca-execucao.txt');
    if (fs.existsSync(marca)) fs.renameSync(marca, `${marca}.inativo`);
    fs.writeFileSync(marca, 'AINDA_NAO_CORREU');

    const r = correrProc.correr(process.execPath,
      ['-e', 'require("fs").writeFileSync(process.argv[1], "FILHO_CORREU")', marca]);
    assert.strictEqual(r.estado, ESTADO.PASSOU, 'o filho tem de correr');
    assert.strictEqual(fs.readFileSync(marca, 'utf8'), 'FILHO_CORREU',
      '⛔ o filho TEM de ter executado de facto — um stdout vazio seria um verde vazio');
    feito('o filho executou de facto (efeito colateral confirmado no disco)');

    // Contraste explícito: o comando original (stdio:'pipe') NÃO executa.
    if (erroReal && erroReal.code === 'EBUSY') {
      const marca2 = path.join(BANCO, 'marca-execucao-original.txt');
      if (fs.existsSync(marca2)) fs.renameSync(marca2, `${marca2}.inativo`);
      fs.writeFileSync(marca2, 'AINDA_NAO_CORREU');
      try {
        cp.execFileSync(process.execPath,
          ['-e', 'require("fs").writeFileSync(process.argv[1], "FILHO_CORREU")', marca2],
          { stdio: 'pipe' });
      } catch (e) { /* esperado */ }
      assert.strictEqual(fs.readFileSync(marca2, 'utf8'), 'AINDA_NAO_CORREU',
        'confirmação do defeito: com stdio:pipe o filho NÃO corre');
      feito('contraste provado: com stdio:pipe o filho não corre (defeito)');
    }
  }

  // ── 7. verificarSintaxe distingue inválido de inexecutável ──────
  titulo('7. verificarSintaxe: válido / inválido / inexecutável');
  {
    const valido = escreverSonda('sintaxe-ok.js', 'const a = 1;\n');
    const invalido = escreverSonda('sintaxe-mau.js', 'function ( { \n');
    assert.strictEqual(correrProc.verificarSintaxe(BANCO, valido), true,
      'código válido tem de dar true');
    assert.strictEqual(correrProc.verificarSintaxe(BANCO, invalido), false,
      'código inválido tem de dar false');

    // Inexecutável: injeta uma falha de spawn e confirma que LANÇA em vez de
    // devolver `false` (que seria lido como «código inválido», tal como o
    // falso «produziu código inválido» observado no despesa-transacao).
    correrProc.__testes.definirExec(() => {
      const e = new Error('spawn EBUSY');
      e.code = 'EBUSY'; e.errno = -4082; e.status = null; e.signal = null;
      throw e;
    });
    let apanhado = null;
    try {
      correrProc.verificarSintaxe(BANCO, valido);
    } catch (e) { apanhado = e; }
    correrProc.__testes.reporExec();
    assert.ok(apanhado && apanhado.infraestrutura,
      '⛔ com falha de spawn a verificação de sintaxe tem de ABORTAR, não dizer «inválido»');
    feito('válido→true, inválido→false, inexecutável→aborta (não «inválido»)');
  }

  // ── 8. Discriminador fundamental: `errno` ───────────────────────
  // Neste host (Windows) o `status` NÃO distingue uma falha de spawn de um
  // exit code: o Node põe `status: 1` em qualquer exceção sem `errno`. A
  // marca fiável de «o filho nunca correu» é **`errno` numérico** (EBUSY
  // -4082, ENOENT -4058); um processo que existiu deixa `errno: undefined`.
  titulo('8. Discriminador `errno` (spawn falhado vs. processo que correu)');
  {
    const spawnFalhado = (() => {
      try { cp.execFileSync(process.execPath, ['-e', '0'], { stdio: 'pipe' }); return null; }
      catch (e) { return e; }
    })();
    const correuEFalhou = (() => {
      try { cp.execFileSync(process.execPath, ['-e', 'process.exit(7)'], { stdio: ['ignore', 'pipe', 'pipe'] }); return null; }
      catch (e) { return e; }
    })();

    if (spawnFalhado) {
      assert.notStrictEqual(spawnFalhado.errno, undefined,
        'uma falha de spawn tem `errno` numérico neste host');
      assert.strictEqual(correrProc.classificar(spawnFalhado), ESTADO.ERRO_EXECUCAO);
      feito(`spawn falhado: errno=${spawnFalhado.errno} → ERRO_EXECUCAO`);
    }

    assert.strictEqual(correuEFalhou.errno, undefined,
      'um processo que correu deixa `errno` indefinido, mesmo com exit ≠ 0');
    assert.strictEqual(correrProc.classificar(correuEFalhou), ESTADO.FALHOU);
    feito('processo que correu e falhou: errno=undefined → FALHOU (deteção legítima)');

    // A prova de que a distinção não é acidental: os dois objetos têm o MESMO
    // `status` (1 vs 7 difere, mas ambos numéricos) — o que os separa é o errno.
    assert.strictEqual(typeof correuEFalhou.status, 'number',
      'ambos os desfechos trazem `status` numérico: por isso o `status` não serve de discriminador');
    feito('confirmado: o `status` não discrimina — só o `errno` discrimina');
  }

  // ── 9. Injeção reposta ──────────────────────────────────────────
  titulo('9. Estado da injeção de teste');
  {
    assert.strictEqual(correrProc.__testes.execInjetado(), false,
      'a injeção tem de ficar reposta no fim do auto-teste');
    feito('injeção de teste reposta (sem efeito residual)');
  }

  console.log(`\n✓ Auto-teste do helper de execução passou (${n} verificações).`);
})();
