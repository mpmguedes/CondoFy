// ═══════════════════════════════════════════════════════════════════
// P53 — Testes do helper `scripts/helpers/backup-mutacao.js`.
//
// Prova, com comportamento (não por inspeção), que a gestão de backups dos
// harnesses de mutação deixou de depender de `unlink`/`rm`:
//   · o backup existe durante a mutação e repõe o alvo BYTE A BYTE;
//   · a limpeza afasta o backup da árvore do projeto por RENAME;
//   · durante um ciclo completo NÃO há uma única chamada a `unlink`/`rm`;
//   · EXDEV tem fallback seguro (o backup não desaparece);
//   · a guarda impede afastar o backup com o alvo ainda mutado;
//   · resíduos existentes são repostos e afastados.
//
// A bancada vive em `os.tmpdir()` (isenta no shim do host), pelo que este
// teste não consome orçamento de eliminações nem deixa resíduos no repo.
//
// Utilização: node scripts/test-backup-mutacao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const backupMut = require('./helpers/backup-mutacao');

let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };
const secao = (t) => console.log(`\n${t}`);

// ── Bancada isolada ────────────────────────────────────────────────
const BANCADA = path.join(os.tmpdir(), `gescondu-p53-bancada-${process.pid}`);
const ALVO = path.join(BANCADA, 'alvo.js');

function preparar() {
  fs.mkdirSync(BANCADA, { recursive: true });
  fs.writeFileSync(ALVO, 'const x = 1;\n');
}

// Contador de eliminações: prova por comportamento que o helper não apaga.
const eliminacoes = { unlinkSync: 0, rmSync: 0, rmdirSync: 0, unlink: 0, rm: 0, rmdir: 0 };
function comContagem(fn) {
  const orig = {};
  for (const k of Object.keys(eliminacoes)) {
    if (typeof fs[k] !== 'function') continue;
    orig[k] = fs[k];
    fs[k] = (...a) => { eliminacoes[k] += 1; return orig[k](...a); };
  }
  try { return fn(); } finally {
    for (const k of Object.keys(orig)) fs[k] = orig[k];
  }
}
const zerar = () => { for (const k of Object.keys(eliminacoes)) eliminacoes[k] = 0; };
const totalEliminacoes = () => Object.values(eliminacoes).reduce((s, v) => s + v, 0);

// ═══════════════════════════════════════════════════════════════════
function main() {
  preparar();

  // ── 1. Ficheiro normal: o backup fica íntegro ──────────────────
  secao('1. criar() — ficheiro normal');
  {
    const antes = fs.readFileSync(ALVO);
    const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
    assert.ok(fs.existsSync(reg.backup), '1a. o backup existe');
    assert.ok(fs.existsSync(reg.marcador), '1b. o marcador existe');
    assert.ok(fs.readFileSync(reg.backup).equals(antes), '1c. o backup é idêntico ao original');
    assert.strictEqual(fs.readFileSync(reg.marcador, 'utf8'), 'alvo.js', '1d. o marcador diz o ficheiro relativo');
    assert.strictEqual(reg.sha256, backupMut.sha256(antes), '1e. o sha256 registado confere');
    assert.strictEqual(reg.conteudo.length, antes.length, '1f. o conteúdo guardado tem o mesmo tamanho');
    ok('backup criado, íntegro e com marcador correto');

    // Restaurar e limpar para não deixar resíduo desta secção.
    backupMut.restaurar(reg);
    const r = backupMut.limpar(reg);
    assert.strictEqual(r.ok, true, '1g. limpeza concluída');
  }

  // ── 2. Ficheiro inexistente ────────────────────────────────────
  secao('2. criar() — ficheiro inexistente');
  {
    assert.throws(
      () => backupMut.criar({ alvo: path.join(BANCADA, 'nao-existe.js'), ficheiro: 'nao-existe.js', raiz: BANCADA }),
      (e) => e && e.code === 'ENOENT',
      '2a. lança ENOENT (não cria um backup vazio que pareceria válido)'
    );
    assert.throws(() => backupMut.criar({ alvo: null, ficheiro: 'x' }), /alvo.*obrigat/i, '2b. alvo em falta é recusado');
    assert.throws(() => backupMut.criar({ alvo: ALVO }), /ficheiro.*obrigat/i, '2c. ficheiro em falta é recusado');
    ok('ficheiro inexistente e argumentos em falta: recusados com erro claro');
  }

  // ── 3. Restauração byte a byte (inclui bytes NÃO-utf8) ─────────
  secao('3. restaurar() — byte a byte, incluindo binário');
  {
    const binario = Buffer.from([0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x01, 0x41]);
    fs.writeFileSync(ALVO, binario);
    const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
    fs.writeFileSync(ALVO, Buffer.from('MUTADO'));
    assert.ok(!fs.readFileSync(ALVO).equals(binario), '3a. o alvo está mesmo mutado');

    const r = backupMut.restaurar(reg);
    assert.strictEqual(r.ok, true, '3b. o restauro confere o sha256');
    assert.ok(fs.readFileSync(ALVO).equals(binario), '3c. o alvo voltou BYTE A BYTE (bytes não-utf8 incluídos)');
    assert.strictEqual(backupMut.sha256(fs.readFileSync(ALVO)), reg.sha256, '3d. o sha256 do alvo é o do original');
    backupMut.limpar(reg);

    fs.writeFileSync(ALVO, 'const x = 1;\n');
    ok('restauro byte a byte (binário com 0x00/0xff/0x80)');
  }

  // ── 4. Limpeza: sai da árvore, sem eliminação ──────────────────
  secao('4. limpar() — afasta por rename, ZERO eliminações');
  {
    const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
    const backupAntes = reg.backup;
    assert.ok(fs.existsSync(backupAntes), '4a. o backup existe antes da limpeza');

    zerar();
    const r = comContagem(() => backupMut.limpar(reg));
    assert.strictEqual(r.ok, true, '4b. a limpeza correu');
    assert.strictEqual(r.via, 'rename-tmp', '4c. o caminho normal é o rename para os.tmpdir()');
    assert.strictEqual(totalEliminacoes(), 0, `4d. NENHUMA chamada a unlink/rm (${JSON.stringify(eliminacoes)})`);
    assert.ok(!fs.existsSync(backupAntes), '4e. o backup saiu da árvore do projeto');
    assert.ok(!fs.existsSync(reg.marcador), '4f. o marcador saiu também');
    assert.ok(fs.existsSync(r.destino), '4g. e está íntegro no destino temporário');
    assert.ok(r.destino.startsWith(os.tmpdir()), '4h. o destino está FORA da árvore do projeto (os.tmpdir)');
    ok('limpeza por rename para os.tmpdir(): 0 eliminações, backup preservado no destino');
  }

  // ── 5. Ciclo completo: nenhuma eliminação em lado nenhum ───────
  secao('5. Ciclo criar → mutar → restaurar → limpar: ZERO eliminações');
  {
    zerar();
    const r = comContagem(() => {
      const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
      fs.writeFileSync(ALVO, 'mutado');
      backupMut.restaurar(reg);
      return backupMut.limpar(reg);
    });
    assert.strictEqual(r.ok, true, '5a. o ciclo concluiu');
    assert.strictEqual(totalEliminacoes(), 0, `5b. o ciclo inteiro não eliminou nada (${JSON.stringify(eliminacoes)})`);
    ok('o mecanismo anterior (unlink) foi REALMENTE eliminado do caminho');
  }

  // ── 6. Erro DURANTE a mutação: o finally ainda repõe e limpa ───
  secao('6. Erro durante a mutação — o restauro no finally funciona');
  {
    const original = fs.readFileSync(ALVO);
    let capturado = null;
    let limpeza = null;
    try {
      const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
      try {
        fs.writeFileSync(ALVO, 'MUTADO A MEIO');
        throw new Error('falha simulada a meio da mutação');
      } finally {
        backupMut.restaurar(reg);
        limpeza = backupMut.limpar(reg);
      }
    } catch (e) { capturado = e; }

    assert.ok(capturado && /falha simulada/.test(capturado.message), '6a. o erro propagou (não foi engolido)');
    assert.strictEqual(limpeza.ok, true, '6b. a limpeza correu apesar do erro');
    assert.ok(fs.readFileSync(ALVO).equals(original), '6c. o alvo ficou reposto apesar do erro');
    ok('erro a meio: propaga, repõe e limpa — sem deixar o alvo mutado');
  }

  // ── 7. Erro DURANTE a restauração ──────────────────────────────
  secao('7. Erro durante a restauração — falha explícita, sem fingir sucesso');
  {
    const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
    // Simular o backup perdido (por exemplo, removido por engano entre os passos).
    fs.renameSync(reg.backup, `${reg.backup}.sumido`);
    assert.throws(
      () => backupMut.restaurar(reg),
      /backup desapareceu|NÃO foi reposto/,
      '7a. restaurar sem backup lança erro explícito (não deixa o alvo mutado em silêncio)'
    );
    fs.renameSync(`${reg.backup}.sumido`, reg.backup); // repor para a limpeza
    backupMut.limpar(reg);
    assert.throws(() => backupMut.restaurar({}), /registo inválido/, '7b. registo inválido é recusado');
    ok('restauração sem backup: erro explícito e diagnosticável');
  }

  // ── 8. EXDEV simulado ──────────────────────────────────────────
  secao('8. EXDEV — fallback seguro, o backup NÃO desaparece');
  {
    const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
    const backupAntes = reg.backup;

    // Injetar um rename que devolve EXDEV sempre que o destino sai do DIRETÓRIO
    // de origem. É o que «volume diferente» significa para este teste: a bancada
    // vive em os.tmpdir(), pelo que comparar com os.tmpdir() daria EXDEV também
    // ao fallback (que é local por construção) e não testaria nada.
    const originalRename = backupMut.__testes.renameAtual;
    backupMut.__testes.definirRename((de, para) => {
      if (path.dirname(path.resolve(para)) !== path.dirname(path.resolve(de))) {
        const e = new Error('EXDEV: cross-device link not permitted');
        e.code = 'EXDEV';
        throw e;
      }
      return originalRename(de, para);
    });

    zerar();
    let r;
    try {
      r = comContagem(() => backupMut.limpar(reg));
    } finally {
      backupMut.__testes.reporRename();
    }

    assert.strictEqual(r.ok, true, '8a. o fallback concluiu (não rebentou)');
    assert.strictEqual(r.via, 'rename-local-exdev', '8b. foi pelo fallback local');
    assert.strictEqual(totalEliminacoes(), 0, `8c. o fallback NÃO eliminou nada (${JSON.stringify(eliminacoes)})`);
    assert.ok(!fs.existsSync(backupAntes), '8d. o backup saiu do nome vigiado');
    assert.ok(fs.existsSync(r.destino), '8e. o backup CONTINUA recuperável (não desapareceu)');
    assert.ok(r.destino.includes(backupMut.PREFIXO_INATIVO), '8f. ficou marcado com o prefixo de inativo');
    assert.ok(fs.readFileSync(r.destino).equals(fs.readFileSync(ALVO)),
      '8g. o conteúdo do backup é o original (o alvo está reposto)');
    assert.ok(r.destino.startsWith(BANCADA), '8h. o fallback fica DENTRO da árvore (mesmo volume, sem EXDEV)');

    // O alvo não ficou mutado em momento nenhum.
    assert.strictEqual(backupMut.sha256(fs.readFileSync(ALVO)), reg.sha256, '8i. o alvo está reposto');
    ok('EXDEV: backup conservado (renomeado no local), alvo reposto, zero eliminações');

    // Limpar o resíduo do fallback (pela mesma via, sem unlink).
    const r2 = backupMut.varrerResiduos({ raiz: BANCADA, silencioso: true });
    assert.ok(r2.movidos >= 1 || !fs.existsSync(r.destino), '8j. o resíduo do fallback é apanhado pelo varrimento');
  }

  // ── 9. Guarda: NÃO afastar o backup com o alvo mutado ──────────
  secao('9. Guarda de segurança — backup NÃO é afastado com o alvo mutado');
  {
    const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA });
    fs.writeFileSync(ALVO, 'AINDA MUTADO');
    const r = backupMut.limpar(reg);
    assert.strictEqual(r.ok, false, '9a. a limpeza é recusada');
    assert.ok(/NÃO está reposto/.test(r.motivo), '9b. o motivo diz que o alvo não está reposto');
    assert.ok(fs.existsSync(reg.backup), '9c. o backup CONTINUA no lugar (é a única cópia de recuperação)');
    assert.ok(!r.destino, '9d. nada foi afastado');
    // Repor e limpar.
    backupMut.restaurar(reg);
    assert.strictEqual(backupMut.limpar(reg).ok, true, '9e. depois de reposto, a limpeza corre');
    ok('o backup nunca é afastado enquanto o alvo estiver mutado');
  }

  // ── 10. Resíduos existentes: repõe e afasta ────────────────────
  secao('10. varrerResiduos() — repõe o alvo órfão e afasta o resíduo');
  {
    // Semear um resíduo que finge uma execução morta a meio: o backup tem o
    // ORIGINAL e o alvo está MUTADO.
    const original = 'const bom = true;\n';
    const backupFalso = path.join(BANCADA, '.mutation-backup-1111111111111-99999.tmp');
    fs.writeFileSync(backupFalso, original);
    fs.writeFileSync(`${backupFalso}.alvo`, 'alvo.js');
    fs.writeFileSync(ALVO, 'const bom = false; // MUTADO\n');

    zerar();
    const r = comContagem(() => backupMut.varrerResiduos({ raiz: BANCADA, silencioso: true }));
    assert.deepStrictEqual(r.repostos, ['alvo.js'], '10a. o alvo órfão foi reposto');
    assert.strictEqual(fs.readFileSync(ALVO, 'utf8'), original, '10b. o alvo voltou ao original');
    assert.ok(r.movidos >= 1, '10c. o resíduo foi afastado');
    assert.ok(!fs.existsSync(backupFalso), '10d. o resíduo saiu da árvore');
    assert.strictEqual(totalEliminacoes(), 0, `10e. o varrimento não eliminou nada (${JSON.stringify(eliminacoes)})`);
    ok('resíduo existente: alvo reposto a partir do backup e resíduo afastado (sem eliminação)');

    // Marcador `.alvo` sozinho (o `.tmp` já não existe): afastado sem rebentar.
    const soAlvo = path.join(BANCADA, '.mutation-backup-2222222222222-88888.tmp.alvo');
    fs.writeFileSync(soAlvo, 'alvo.js');
    const r2 = backupMut.varrerResiduos({ raiz: BANCADA, silencioso: true });
    assert.ok(!fs.existsSync(soAlvo), '10f. o marcador sozinho foi afastado');
    ok('marcador «.alvo» sozinho: afastado (lixo inofensivo, alvo já reposto)');
  }

  // ── 11. Prefixo próprio (harness da transação) ────────────────
  secao('11. Prefixo próprio — o varrimento respeita o prefixo do harness');
  {
    const PREFIXO = '.mutation-backup-movimentos-';
    const reg = backupMut.criar({ alvo: ALVO, ficheiro: 'alvo.js', raiz: BANCADA, prefixo: PREFIXO });
    assert.ok(path.basename(reg.backup).startsWith(PREFIXO), '11a. o backup usa o prefixo pedido');
    // Um resíduo de OUTRO harness não pode ser tocado por este varrimento.
    const alheio = path.join(BANCADA, '.mutation-backup-3333333333333-77777.tmp');
    fs.writeFileSync(alheio, 'de outro harness');
    const r = backupMut.varrerResiduos({ raiz: BANCADA, prefixo: PREFIXO, silencioso: true });
    assert.ok(fs.existsSync(alheio), '11b. o resíduo de OUTRO prefixo não foi tocado');
    assert.ok(r.movidos >= 1, '11c. o resíduo deste prefixo foi afastado');
    assert.ok(!fs.existsSync(reg.backup), '11d. o backup deste prefixo saiu da árvore');
    assert.strictEqual(backupMut.sha256(fs.readFileSync(ALVO)), reg.sha256,
      '11e. o alvo nunca foi mutado nesta secção');
    // O `alheio` fica para o harness a que pertence; afastá-lo agora pela via do
    // helper (padrão por omissão) para não deixar resíduo na bancada.
    backupMut.varrerResiduos({ raiz: BANCADA, silencioso: true });
    assert.ok(!fs.existsSync(alheio), '11f. o resíduo alheio é apanhado pelo varrimento do SEU padrão');
    ok('o varrimento é limitado ao prefixo do harness (não toca resíduos alheios)');
  }

  // ── 12. O módulo não contém eliminações ───────────────────────
  secao('12. O helper não tem caminho de eliminação');
  {
    const fonte = fs.readFileSync(path.join(RAIZ, 'scripts', 'helpers', 'backup-mutacao.js'), 'utf8');
    // Remover COMENTÁRIOS antes de procurar: a documentação do módulo menciona
    // as APIs proibidas de propósito (explica o problema que o helper resolve).
    // Procurar no texto todo daria um falso positivo.
    const codigo = fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // Verificação auxiliar: a prova por comportamento já foi feita nas secções
    // 4, 5, 8 e 10 (contador de eliminações a ZERO em cada caminho).
    for (const proibido of ['unlinkSync', 'unlink(', 'rmSync', 'rmdirSync', 'fs.rm(', 'fs.rmdir(']) {
      assert.ok(!codigo.includes(proibido), `12. o helper não pode conter «${proibido}» no código`);
    }
    ok('nenhuma API de eliminação no helper (comportamento confirmado nas secções 4, 5, 8 e 10)');
  }

  // ── 13. Resíduos LEGADOS (`ORFAO-*`, marcador `.alvo.inativo`) ─
  secao('13. varrerResiduos() — resíduos legados (ORFAO-*, .alvo.inativo)');
  {
    // Formato deixado por frentes ANTERIORES ao helper: o backup renomeado à mão
    // para `ORFAO-*` e o marcador com o sufixo `.inativo`. Sem reconhecimento
    // explícito, este lixo ficaria na raiz do repositório para sempre.
    const original = 'const legado = true;\n';
    const legadoTmp = path.join(BANCADA, 'ORFAO-mutation-backup-4444444444444-66666.tmp');
    const legadoAlvo = `${legadoTmp}.alvo.inativo`;
    fs.writeFileSync(legadoTmp, original);
    fs.writeFileSync(legadoAlvo, 'alvo.js');
    fs.writeFileSync(ALVO, 'const legado = false; // MUTADO\n');

    zerar();
    const r = comContagem(() => backupMut.varrerResiduos({ raiz: BANCADA, silencioso: true }));
    assert.deepStrictEqual(r.repostos, ['alvo.js'], '13a. o alvo órfão legado foi reposto');
    assert.strictEqual(fs.readFileSync(ALVO, 'utf8'), original, '13b. o alvo voltou ao original');
    assert.ok(!fs.existsSync(legadoTmp), '13c. o resíduo legado (.tmp) saiu da árvore');
    assert.ok(!fs.existsSync(legadoAlvo), '13d. o marcador legado (.alvo.inativo) saiu da árvore');
    assert.strictEqual(totalEliminacoes(), 0, `13e. o varrimento não eliminou nada (${JSON.stringify(eliminacoes)})`);
    ok('resíduo legado ORFAO-* (marcador .alvo.inativo): reposto e afastado sem eliminação');
  }

  console.log(`\n✓ P53 (backup-mutacao): ${n} verificações passaram.`);
}

main();
