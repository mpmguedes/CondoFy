// ═══════════════════════════════════════════════════════════════════
// P37 — Testes de MUTAÇÃO dos valores monetários da exportação (RGPD).
//
// Um teste que passa não prova nada se não falhar quando o código é quebrado.
// O defeito P37 (`formatEUR(toCents(x))` — conversão dupla) fazia TODAS as
// colunas monetárias dos CSV saírem 100× maiores, e passou despercebido porque
// `test-titularidades.js` só verificava estrutura, nunca valores. O cenário K
// desse teste afirma agora a LINHA COMPLETA de cada CSV.
//
// Aqui prova-se que essa asserção MORDE: aplica-se, uma a uma, a regressão
// real a cada ponto de formatação, corre-se `test-titularidades.js` e
// verifica-se que FALHA. No fim o ficheiro é restaurado BYTE A BYTE e
// confirmado por sha256.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//
// Utilização: node scripts/test-mutacao-exportacao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const backupMut = require('./helpers/backup-mutacao');

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
function mutacao({ nome, ficheiro, de, para, script }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);

  // Backup ao lado, com o caminho do alvo em `.alvo`: um órfão de uma execução
  // morta a meio é REPOSTO pelo varrimento de arranque em vez de só apagado.
  const bkp = backupMut.criar({ alvo, ficheiro, raiz: RAIZ });

  try {
    assert.ok(original.includes(de),
      `mutação impossível: o padrão a mutar não existe em ${ficheiro}`);
    // O padrão tem de ser ÚNICO: com duas ocorrências, um `replace` mutaria a
    // primeira e a mutação deixaria de provar o que diz provar.
    const ocorrencias = original.split(de).length - 1;
    assert.strictEqual(ocorrencias, 1,
      `padrão não é único em ${ficheiro} (${ocorrencias} ocorrências) — acrescentar contexto`);
    const mutado = original.replace(de, para);
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
  console.log('T-P37 — testes de mutação dos valores monetários da exportação');

  // Varrimento de arranque: uma execução anterior morta a meio (SIGTERM,
  // timeout, Ctrl-C) deixou o ficheiro alvo MUTADO no working copy. Cada backup
  // é uma cópia integral do original, pelo que o órfão se REPÕE.
  backupMut.varrerResiduos({ raiz: RAIZ });

  // ── 1. A unidade do formatador volta a ser ambígua ───────────────
  // `formatEURCents` existe precisamente para NÃO converter. Se voltar a
  // multiplicar por 100, a unidade deixa de estar garantida e o defeito P37
  // reaparece por outro caminho.
  mutacao({
    nome: '1. formatEURCents volta a multiplicar por 100 (unidade ambígua)',
    ficheiro: 'helpers/money.js',
    de: 'const n = Math.round(Number(cents) || 0);',
    para: 'const n = Math.round(Number(cents) || 0) * 100;',
    script: 'test-titularidades.js',
  });

  // ── 2. Quotas: valor pago volta a ser formatado como euros ───────
  // `valorC`/`pagoC` estão em cêntimos: passá-los a `formatEUR` (que espera
  // euros) é exatamente o defeito original.
  mutacao({
    nome: '2. quotas: valor e pago voltam a ser passados como euros',
    ficheiro: 'helpers/exportacao-dados.js',
    de: 'formatEURCents(valorC), formatEURCents(pagoC),',
    para: 'formatEUR(valorC), formatEUR(pagoC),',
    script: 'test-titularidades.js',
  });

  // ── 3. Quotas: «em dívida» volta a ser formatado como euros ──────
  mutacao({
    nome: '3. quotas: «em dívida» volta a ser passado como euros',
    ficheiro: 'helpers/exportacao-dados.js',
    de: 'formatEURCents(Math.max(0, valorC - pagoC))',
    para: 'formatEUR(Math.max(0, valorC - pagoC))',
    script: 'test-titularidades.js',
  });

  // ── 4. Parcelas de quota extraordinária: conversão dupla ─────────
  mutacao({
    nome: '4. parcelas extraordinárias: conversão dupla (formatEUR(toCents(...)))',
    ficheiro: 'helpers/exportacao-dados.js',
    de: 'p.parcela_numero,\n            formatEUR(p.valor),',
    para: 'p.parcela_numero,\n            formatEUR(toCents(p.valor)),',
    script: 'test-titularidades.js',
  });

  // ── 5. Pagamentos: conversão dupla ───────────────────────────────
  mutacao({
    nome: '5. pagamentos: conversão dupla (formatEUR(toCents(...)))',
    ficheiro: 'helpers/exportacao-dados.js',
    de: "p.data_pagamento || '', formatEUR(p.valor),",
    para: "p.data_pagamento || '', formatEUR(toCents(p.valor)),",
    script: 'test-titularidades.js',
  });

  // ── 6. Recibos: conversão dupla ──────────────────────────────────
  mutacao({
    nome: '6. recibos: conversão dupla (formatEUR(toCents(...)))',
    ficheiro: 'helpers/exportacao-dados.js',
    de: "r.tipo, formatEUR(r.valor), r.data_emissao",
    para: "r.tipo, formatEUR(toCents(r.valor)), r.data_emissao",
    script: 'test-titularidades.js',
  });

  console.log(`\n✓ Testes de mutação do P37 passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((err) => {
  console.error('\n✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
