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
const backupMut = require('./helpers/backup-mutacao');
const correrProc = require('./helpers/correr-processo');

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
  // ⛔ P53-FOLLOWUP: ver `helpers/correr-processo.js` — o filho corre com stdin
  // em `ignore` (mata o `EBUSY` deste host) e uma falha de spawn aborta em vez
  // de ser tomada por «o teste FALHOU» (= mutação detetada).
  const r = correrProc.executarOuFalhar(process.execPath, [path.join(RAIZ, 'scripts', script)], {
    cwd: RAIZ, timeout: 120000,
  });
  if (r.estado === correrProc.ESTADO.PASSOU) return RESULTADO.PASSOU;
  return r.estado === correrProc.ESTADO.INTERROMPIDO ? RESULTADO.INTERROMPIDO : RESULTADO.FALHOU;
}

// Aplica uma mutação, corre o teste (tem de FALHAR) e restaura o ficheiro.
// O restauro é SEMPRE byte a byte, no `finally` — nunca `git checkout`.
function mutacao({ nome, ficheiro, de, para, global = false, script }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);

  const bkp = backupMut.criar({ alvo, ficheiro, raiz: RAIZ });

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
    backupMut.restaurar(bkp);
    backupMut.limpar(bkp);
    assert.strictEqual(hash(fs.readFileSync(alvo, 'utf8')), hashOriginal,
      `restauro de ${ficheiro} não ficou idêntico ao original`);
  }
}

(async () => {
  console.log('C2 — testes de mutação do cálculo das quotas (FCR)');

  // Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
  // ficheiro alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original, pelo que
  // o órfão se REPÕE (o `.alvo` diz em que ficheiro).
  backupMut.varrerResiduos({ raiz: RAIZ });

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

  // ── 3. A pré-visualização deixa de usar os valores do SERVIDOR ──
  // P20: a vista passou a apresentar a pré-visualização calculada no servidor
  // (já não há fórmula no browser). Se o método orçamento passar a ler o bloco
  // do método permilagem, a vista volta a mostrar números que o servidor não
  // vai gravar.
  mutacao({
    nome: '3. a pré-visualização do método orçamento deixa de usar os valores do servidor',
    ficheiro: 'views/admin/quotas/gerar.handlebars',
    de: "      ? ((PREVISAO.orcamento[document.getElementById('wOrcamento').value] || {})[f.id] || null)",
    para: '      ? (PREVISAO.permilagem[f.id] || null)',
    script: 'test-fcr-base.js',
  });

  console.log(`\n✓ Testes de mutação do FCR passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
