// ═══════════════════════════════════════════════════════════════════
// P56 — Testes de MUTAÇÃO da regra «Orçamento → Quota».
//
// Um teste que passa não prova nada se não falhar quando o código é quebrado.
// Aqui aplica-se, uma a uma, uma mutação REAL ao código-fonte, corre-se o teste
// que a deve detetar e verifica-se que ele FALHA. No fim, restaura-se o
// ficheiro BYTE A BYTE e confirma-se com o hash.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com `fs.writeFileSync` + verificação por sha256.
//
// Mutações cobertas (as regras que o P56 introduziu):
//   1. o vínculo `orcamento_id` deixa de ser gravado na emissão por orçamento;
//   2. a validação de sobreposição desaparece da CRIAÇÃO;
//   3. a comparação de intervalos inverte-se (sobrepõe ≠ sobrepõe);
//   4. `ignorarId` desaparece da EDIÇÃO (o orçamento colide consigo mesmo);
//   5. a validação do período de 12 meses desaparece da CRIAÇÃO;
//   6. a validação do período de 12 meses desaparece da APROVAÇÃO
//      (a barreira que apanha dados antigos).
//
// Utilização: node scripts/test-mutacao-p56.js
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

// Cadeia-oráculo POR MUTAÇÃO: cada mutação é detetada pelas suítes que
// REALMENTE cobrem a regra mutada. Exigir que uma suíte cujo objeto é outro
// detete a mutação seria exigir um falso verde — e o harness tem de o recusar.
const SUITE_PRINCIPAL = 'test-orcamento-quota-p56.js';
const SUITE_HTTP = 'test-orcamento-quota-p56-http.js';
const SUITE_EDIT = 'test-orcamento-quota-p56-edit.js';
const TODAS = [SUITE_PRINCIPAL, SUITE_HTTP, SUITE_EDIT];

function mutacaoEmCadeia(opcoes) {
  const suites = opcoes.suites || TODAS;
  titulo(opcoes.nome);
  const alvo = path.join(RAIZ, opcoes.ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);
  const bkp = backupMut.criar({ alvo, ficheiro: opcoes.ficheiro, raiz: RAIZ });

  try {
    assert.ok(original.includes(opcoes.de),
      `mutação impossível: o padrão a mutar não existe em ${opcoes.ficheiro}`);
    const mutado = opcoes.global
      ? original.split(opcoes.de).join(opcoes.para)
      : original.replace(opcoes.de, opcoes.para);
    assert.notStrictEqual(mutado, original, `mutação ${opcoes.nome}: nada mudou`);
    fs.writeFileSync(alvo, mutado);

    const passou = [];
    for (const script of suites) {
      const r = resultadoDoTeste(script);
      assert.notStrictEqual(r, RESULTADO.INTERROMPIDO,
        `execução interrompida (timeout/SIGTERM) em ${script}: inconclusivo — voltar a correr`);
      if (r === RESULTADO.PASSOU) passou.push(script);
    }
    assert.strictEqual(passou.length, 0,
      `mutação NÃO detetada por: ${passou.join(', ')} — a prova tem um falso verde`);
    feito(`«${opcoes.nome}» → ${suites.length} suíte(s) do P56 FALHAM (mutação detetada)`);
  } finally {
    backupMut.restaurar(bkp);
    backupMut.limpar(bkp);
    assert.strictEqual(hash(fs.readFileSync(alvo, 'utf8')), hashOriginal,
      `restauro de ${opcoes.ficheiro} não ficou idêntico ao original`);
  }
}

(async () => {
  console.log('P56 — testes de mutação da regra «Orçamento → Quota»');

  // Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
  // ficheiro alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original, pelo que
  // o órfão se REPÕE (o `.alvo` diz em que ficheiro).
  backupMut.varrerResiduos({ raiz: RAIZ });

  // ── 1. O vínculo `orcamento_id` deixa de ser gravado ────────────
  // O defeito original (P56): a quota gerada pelo método «orçamento» perdia o
  // vínculo. Sem a escrita, o teste HTTP tem de detetar `orcamento_id` nulo.
  mutacaoEmCadeia({
    nome: '1. a emissão por orçamento deixa de gravar `orcamento_id`',
    ficheiro: 'routes/financeiro.js',
    de: '            orcamento_id: metodo === \'orcamento\' ? orcamentoId : null,\n',
    para: '',
    suites: [SUITE_HTTP, SUITE_PRINCIPAL],
  });

  // ── 2. A validação de sobreposição desaparece da CRIAÇÃO ────────
  // Sem o `conflitoDePeriodo`, dois orçamentos do mesmo condomínio passam a
  // poder sobrepor-se — a regra central do P56 desaparece.
  mutacaoEmCadeia({
    nome: '2. a CRIAÇÃO deixa de validar a sobreposição de períodos',
    ficheiro: 'routes/orcamento.js',
    de: '  const conflito = orcamentoPeriodo.conflitoDePeriodo({ dataInicio, dataFim }, existentes);\n'
      + '  if (conflito) {\n'
      + '    req.flash(\'error_msg\', orcamentoPeriodo.mensagemConflito(conflito));\n'
      + '    return res.redirect(\'/admin/orcamento/nova\');\n'
      + '  }\n',
    para: '  const conflito = null;\n',
    suites: [SUITE_PRINCIPAL],
  });

  // ── 3. A comparação de intervalos inverte-se ────────────────────
  // `sobrepoeSe` invertida: a sobreposição deixa de ser detetada e passa a
  // detetar o contrário — períodos válidos seriam recusados e vice-versa.
  mutacaoEmCadeia({
    nome: '3. a comparação de intervalos inverte-se (sobreposição deixa de ser vista)',
    ficheiro: 'helpers/orcamento-periodo.js',
    de: '  return a.primeiro <= b.ultimo && b.primeiro <= a.ultimo;',
    para: '  return a.primeiro > b.ultimo || b.primeiro > a.ultimo;',
    suites: [SUITE_PRINCIPAL],
  });

  // ── 4. `ignorarId` desaparece da EDIÇÃO ────────────────────────
  // Sem `ignorarId`, o próprio orçamento entra na lista de existentes e colide
  // consigo mesmo: a edição sem mexer no período torna-se impossível.
  mutacaoEmCadeia({
    nome: '4. a EDIÇÃO deixa de ignorar o próprio orçamento (`ignorarId` cai)',
    ficheiro: 'routes/orcamento.js',
    de: '      existentes,\n      { ignorarId: orcamento.id }\n    );',
    para: '      existentes\n    );',
    suites: [SUITE_EDIT],
  });

  // ── 5. A validação do período desaparece da CRIAÇÃO ────────────
  // Sem `periodoValido`, o período de 13 meses volta a ser aceite e a 13.ª
  // quota volta a ser gerada em silêncio.
  mutacaoEmCadeia({
    nome: '5. a CRIAÇÃO deixa de validar o período de 12 meses',
    ficheiro: 'routes/orcamento.js',
    de: '    const periodo = orcamentoPeriodo.periodoValido(dataInicio, dataFim);\n'
      + '    if (!periodo.ok) {\n'
      + '      req.flash(\'error_msg\', mensagemPeriodoInvalido(periodo.motivo));\n'
      + '      return res.redirect(\'/admin/orcamento/nova\');\n'
      + '    }\n',
    para: '    const periodo = { ok: true, motivo: null };\n',
    // Só a suíte principal cobre a validação de período na CRIAÇÃO; a suíte de
    // edição tem por objeto a EDIÇÃO (a sua secção 5 testa a rota de edição).
    // Incluí-la aqui seria exigir-lhe um falso verde.
    suites: [SUITE_PRINCIPAL],
  });

  // ── 6. A validação do período desaparece da APROVAÇÃO ──────────
  // A aprovação é a última barreira: é ela que apanha orçamentos criados ANTES
  // da regra (dados existentes com 13 meses).
  mutacaoEmCadeia({
    nome: '6. a APROVAÇÃO deixa de validar o período (a barreira contra dados antigos cai)',
    ficheiro: 'routes/orcamento.js',
    de: '  if (!periodo.ok) {\n'
      + '    req.flash(\'error_msg\', `O período não corresponde a 12 meses de calendário inteiros. ${mensagemPeriodoInvalido(periodo.motivo)}`);\n'
      + '    return res.redirect(`/admin/orcamento/${orcamento.id}`);\n'
      + '  }\n',
    para: '',
    suites: [SUITE_PRINCIPAL],
  });

  console.log(`\n✓ Testes de mutação do P56 passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
