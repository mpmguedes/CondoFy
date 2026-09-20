// ═══════════════════════════════════════════════════════════════════
// C3 — Testes de MUTAÇÃO da distribuição mensal das quotas orçamentadas.
//
// Um teste que passa não prova nada se não falhar quando o código é quebrado.
// Aqui aplica-se, uma a uma, uma mutação REAL ao código-fonte, corre-se o teste
// que a deve detetar e verifica-se que ele FALHA. No fim, restaura-se o
// ficheiro BYTE A BYTE e confirma-se com o hash.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com `fs.writeFileSync` + verificação por sha256.
//
// Mutações cobertas (o que C3 fechou):
//   1. volta a divisão mensal com `floor` POR FRAÇÃO e o resto somado atirado à
//      última — o defeito que inflava o ano (`Σ meses > totalC`);
//   2. a repartição mensal passa a usar o valor ANUAL para todos os meses
//      (inflação de 12×);
//   3. o FCR do ano deixa de ser a soma exata da repartição mensal (volta a
//      arredondar mês a mês, somando os erros);
//   4. a rota volta a gravar o valor ANUAL em cada mês;
//   5. a pré-visualização volta a mostrar `mensal × 12` em vez do anual exato.
//
// Utilização: node scripts/test-mutacao-mensal.js
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
  console.log('C3 — testes de mutação da distribuição mensal das quotas');

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

  // ── 1. Volta o `floor` por fração com o resto atirado à última ───
  // É o defeito exato de C3: cada fração perde `anual mod meses`, o resto
  // somado é maior do que a perda de uma só fração, e o último mês fica
  // inflacionado — `Σ meses > totalC`.
  mutacao({
    nome: '1. divisão mensal volta ao `floor` por fração + resto na última',
    ficheiro: 'helpers/quotas-calc.js',
    de: '    const cotasMes = distribuirPorPesos(\n'
        + '      d.valorC,\n'
        + '      Array.from({ length: nMeses }, (_, i) => ({ fracaoId: i, peso: 1 }))\n'
        + '    );\n'
        + '    mensalC.push(cotasMes.map((p) => p.valorC));',
    para: '    const _m = [];\n'
        + '    for (let i = 0; i < nMeses; i++) _m.push(Math.floor(d.valorC / nMeses));\n'
        + '    mensalC.push(_m);\n'
        + '    { const _soma = mensalC[mensalC.length - 1].reduce((s, v) => s + v, 0) * nMeses;\n'
        + '      const _resto = totalC - _soma;\n'
        + '      if (_resto > 0) mensalC[mensalC.length - 1][nMeses - 1] += _resto; }',
    script: 'test-quotas-mensal.js',
  });

  // ── 2. A repartição mensal deixa de dividir por 12 ──────────────
  // Se o divisor deixar de ser o número de meses, cada mês vale o total do ano
  // (inflação de 12×) e o fecho anual rompe-se.
  mutacao({
    nome: '2. a repartição mensal deixa de dividir pelo número de meses',
    ficheiro: 'helpers/quotas-calc.js',
    de: '    const cotasMes = distribuirPorPesos(\n'
        + '      d.valorC,\n'
        + '      Array.from({ length: nMeses }, (_, i) => ({ fracaoId: i, peso: 1 }))\n'
        + '    );',
    para: '    const cotasMes = distribuirPorPesos(\n'
        + '      d.valorC * nMeses,\n'
        + '      Array.from({ length: nMeses }, (_, i) => ({ fracaoId: i, peso: 1 }))\n'
        + '    );',
    script: 'test-quotas-mensal.js',
  });

  // ── 3. O FCR do ano volta a ser arredondado mês a mês ───────────
  // A soma de 12 arredondamentos afasta o FCR anual do valor exato (499,92 €
  // em vez de 500,00 €). O teste tem de detetar essa deriva.
  mutacao({
    nome: '3. o FCR do ano deixa de fechar com a soma da repartição mensal',
    ficheiro: 'helpers/quotas-calc.js',
    de: '    const fcrAnoC = dividirComponentesQuota(d.valorC, fcrP).fcrC;',
    para: '    const fcrAnoC = dividirComponentesQuota(d.valorC, fcrP).fcrC;\n'
        + '    fcrMensalC.push(Array.from({ length: nMeses }, () => fcrAnoC));',
    script: 'test-quotas-mensal.js',
  });

  // ── 4. A rota volta a gravar o valor ANUAL em cada mês ──────────
  // Sem `porMes[m-1]`, o valor gravado em cada quota é o total do ano.
  mutacao({
    nome: '4. a rota volta a gravar o valor anual em cada mês',
    ficheiro: 'routes/financeiro.js',
    de: '        const mV = (v.porMes && v.porMes[m - 1]) || v;',
    para: '        const mV = v;',
    script: 'test-quotas-mensal.js',
  });

  // ── 5. A pré-visualização volta a `mensal × 12` ─────────────────
  // A soma de mensais arredondados volta a divergir do total anual exato.
  mutacao({
    nome: '5. a pré-visualização volta a mostrar `mensal × 12`',
    ficheiro: 'views/admin/quotas/gerar.handlebars',
    de: "      document.getElementById('previewTotal').textContent = fmt(this.ehAno() ? totalAno : totalMes);",
    para: "      document.getElementById('previewTotal').textContent = fmt(this.ehAno() ? totalMes * 12 : totalMes);",
    script: 'test-quotas-mensal.js',
  });

  console.log(`\n✓ Testes de mutação da distribuição mensal passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
