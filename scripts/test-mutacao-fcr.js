// ═══════════════════════════════════════════════════════════════════
// C2 — Testes de MUTAÇÃO do cálculo das quotas (FCR).
//
// Um teste que passa não prova nada se não falhar quando o código é quebrado.
// Aqui aplica-se, uma a uma, uma mutação REAL ao código-fonte, corre-se o teste
// que a deve detetar e verifica-se que ele FALHA. No fim, restaura-se o
// ficheiro BYTE A BYTE e confirma-se com o hash.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com `fs.writeFileSync` + verificação por sha256.
//
// Mutações cobertas (o que C2 fechou):
//   1. `calcularQuota` volta à fórmula LEGADA (base = total; fcr = base × pct/100;
//      total = base + fcr) — a inflação que a regra D1 proíbe;
//   2. `calcularQuotasOrcamento` deixa de acrescentar o FCR às despesas antes de
//      distribuir (a regra «despesas + FCR = total a distribuir» desaparece);
//   3. a pré-visualização do browser deixa de acrescentar o FCR (volta a
//      distribuir as despesas, divergindo do servidor).
//
// Utilização: node scripts/test-mutacao-fcr.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Corre um script de teste num processo separado e devolve o desfecho.
// Distingue-se «o teste FALHOU» (deteção) de «o teste foi INTERROMPIDO»
// (timeout/SIGTERM) — uma execução morta não prova nada.
const RESULTADO = { PASSOU: 'passou', FALHOU: 'falhou', INTERROMPIDO: 'interrompido' };

function resultadoDoTeste(script) {
  try {
    execFileSync(process.execPath, [path.join(RAIZ, 'scripts', script)], {
      cwd: RAIZ, stdio: 'pipe', timeout: 120000,
    });
    return RESULTADO.PASSOU;
  } catch (e) {
    return e && e.signal ? RESULTADO.INTERROMPIDO : RESULTADO.FALHOU;
  }
}

// Aplica uma mutação, corre o teste (tem de FALHAR) e restaura o ficheiro.
// O restauro é SEMPRE byte a byte, no `finally` — nunca `git checkout`.
function mutacao({ nome, ficheiro, de, para, global = false, script }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);

  const carimbo = `${Date.now()}-${process.pid}`;
  const backup = path.join(RAIZ, `.mutation-backup-${carimbo}.tmp`);
  fs.writeFileSync(backup, original);
  fs.writeFileSync(`${backup}.alvo`, ficheiro);

  try {
    assert.ok(original.includes(de),
      `mutação impossível: o padrão a mutar não existe em ${ficheiro}`);
    const mutado = global
      ? original.split(de).join(para)
      : original.replace(de, para);
    assert.notStrictEqual(mutado, original, `mutação ${nome}: nada mudou`);
    fs.writeFileSync(alvo, mutado);

    const resultado = resultadoDoTeste(script);
    assert.notStrictEqual(resultado, RESULTADO.INTERROMPIDO,
      `execução interrompida (timeout/SIGTERM) ao testar «${nome}»: inconclusivo, ` +
      'a mutação não conta como detetada — voltar a correr');
    assert.notStrictEqual(resultado, RESULTADO.PASSOU,
      `mutação NÃO detetada: ${script} continuou a passar com «${nome}» aplicada`);
    feito(`«${nome}» → ${script} FALHA (a mutação é detetada)`);
  } finally {
    fs.writeFileSync(alvo, fs.readFileSync(backup));
    fs.unlinkSync(backup);
    if (fs.existsSync(`${backup}.alvo`)) fs.unlinkSync(`${backup}.alvo`);
    assert.strictEqual(hash(fs.readFileSync(alvo, 'utf8')), hashOriginal,
      `restauro de ${ficheiro} não ficou idêntico ao original`);
  }
}

(async () => {
  console.log('C2 — testes de mutação do cálculo das quotas (FCR)');

  // Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
  // ficheiro alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original, pelo que
  // o órfão se REPÕE (o `.alvo` diz em que ficheiro).
  const orfaos = fs.readdirSync(RAIZ)
    .filter((f) => /^\.mutation-backup-\d+-\d+\.tmp$/.test(f))
    .sort();
  if (orfaos.length) {
    const ultimo = orfaos[orfaos.length - 1];
    const ficheiroAlvo = path.join(RAIZ, `${ultimo}.alvo`);
    if (fs.existsSync(ficheiroAlvo)) {
      const rel = fs.readFileSync(ficheiroAlvo, 'utf8').trim();
      const destino = path.join(RAIZ, rel);
      if (fs.existsSync(destino)) {
        const conteudo = fs.readFileSync(path.join(RAIZ, ultimo), 'utf8');
        if (fs.readFileSync(destino, 'utf8') !== conteudo) {
          fs.writeFileSync(destino, conteudo);
          console.log(`  ⚠ interrupção anterior detetada: ${rel} reposto a partir de ${ultimo}`);
        }
      }
    } else {
      console.log(`  · backup órfão sem «.alvo»: conservado para inspeção (${ultimo})`);
    }
    for (const f of orfaos) {
      fs.unlinkSync(path.join(RAIZ, f));
      if (fs.existsSync(path.join(RAIZ, `${f}.alvo`))) {
        fs.unlinkSync(path.join(RAIZ, `${f}.alvo`));
      }
    }
    console.log(`  · ${orfaos.length} backup(s) órfão(s) de execução anterior limpo(s)`);
  }

  // ── 1. `calcularQuota` volta à fórmula LEGADA (infla o total) ────
  // D1 exige `totalC` inalterado (o FCR é componente). A fórmula antiga
  // `totalC = baseC + round(baseC × pct/100)` infla o valor a pagar — é
  // exatamente o defeito que C2 fechou. Testes T1/T2 e a regra C2 têm de morder.
  mutacao({
    nome: '1. `calcularQuota` volta à fórmula legada (FCR somado à base)',
    ficheiro: 'helpers/quotas-calc.js',
    de: '  const partes = dividirComponentesQuota(totalC, fcrPercentagem);\n',
    para: '  const _p = parseFloat(fcrPercentagem) || 0;\n'
        + '  const partes = { baseC: totalC, fcrC: Math.round((totalC * _p) / 100) };\n'
        + '  partes.totalC = partes.baseC + partes.fcrC;\n'
        + '  partes.fcrPercentagem = _p;\n',
    script: 'test-fcr-base.js',
  });

  // ── 2. O modo orçamento deixa de acrescentar o FCR às despesas ───
  // A regra exige `total a distribuir = despesas + FCR`. Sem o acréscimo, o
  // total distribuído são as despesas puras — a regra de negócio desaparece.
  mutacao({
    nome: '2. modo orçamento deixa de acrescentar o FCR às despesas',
    ficheiro: 'helpers/quotas-calc.js',
    de: '  const totalC = acrescentarFcrAoTotal(despesasC, fcrP);',
    para: '  const totalC = despesasC;',
    script: 'test-fcr-base.js',
  });

  // ── 3. A pré-visualização do browser deixa de acrescentar o FCR ──
  // A vista tem de espelhar o servidor; sem `totalComFcr` no modo orçamento,
  // a pré-visualização volta a distribuir as despesas e diverge do gravado.
  mutacao({
    nome: '3. pré-visualização do browser deixa de acrescentar o FCR',
    ficheiro: 'views/admin/quotas/gerar.handlebars',
    de: '      const totalAnual = totalComFcr(despesas, pctFcr());',
    para: '      const totalAnual = despesas;',
    script: 'test-fcr-base.js',
  });

  console.log(`\n✓ Testes de mutação do FCR passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
