// ═══════════════════════════════════════════════════════════════════
// Percentagem do FCR sobre o orçamento — testes de MUTAÇÃO.
//
// Um teste que passa não prova nada se não falhar quando o código é quebrado.
// Aqui aplica-se, uma a uma, uma mutação REAL ao código-fonte, corre-se o teste
// que a deve detetar e verifica-se que ele FALHA. No fim, restaura-se o
// ficheiro BYTE A BYTE e confirma-se com o hash.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//
// Mutações cobertas:
//   1. o FCR deixa de ser acrescentado ao total das despesas (uplift removido);
//   2. a rota passa a aplicar 0% em vez da percentagem configurada;
//   3. a configuração por condomínio deixa de ter precedência (só a global);
//   4. o campo da percentagem desaparece do formulário de configuração;
//   5. o plano do orçamento passa a incluir o FCR (fecha a lacuna do «Emitir»)
//      → prova que a caracterização da lacuna é um «tripwire» real.
//   6. a emissão deixa de gravar as componentes (valor_fcr nulo);
//   7. o balancete soma o FCR POR CIMA do valor da quota (dupla contagem).
//
// Utilização: node scripts/test-mutacao-fcr-orcamento.js
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

function mutacao({ nome, ficheiro, de, para, script }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);

  const bkp = backupMut.criar({ alvo, ficheiro, raiz: RAIZ });

  try {
    assert.ok(original.includes(de),
      `mutação impossível: o padrão a mutar não existe em ${ficheiro}`);
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

const SCRIPT = 'test-fcr-orcamento.js';

(async () => {
  console.log('Percentagem do FCR sobre o orçamento — testes de mutação');

  // Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
  // ficheiro alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original, pelo que
  // o órfão se REPÕE (o `.alvo` diz em que ficheiro).
  backupMut.varrerResiduos({ raiz: RAIZ });

  // ── 1. O FCR deixa de ser acrescentado ao total ─────────────────
  // Sem o uplift, o orçamento de 12.000 € passa a financiar 12.000 € em vez de
  // 13.200 € — o fundo desaparece da quota.
  mutacao({
    nome: '1. o FCR deixa de ser acrescentado ao total das despesas',
    ficheiro: 'helpers/quotas-calc.js',
    de: '  const totalC = acrescentarFcrAoTotal(despesasC, fcrP);',
    para: '  const totalC = despesasC;',
    script: SCRIPT,
  });

  // ── 2. A rota aplica 0% em vez da percentagem configurada ───────
  mutacao({
    nome: '2. a rota passa a aplicar 0% em vez da percentagem configurada',
    ficheiro: 'routes/financeiro.js',
    de: '      fcrPercentagem: fcrOrcamento,',
    para: '      fcrPercentagem: 0,',
    script: SCRIPT,
  });

  // ── 3. A configuração por condomínio perde a precedência ────────
  mutacao({
    nome: '3. a configuração por condomínio deixa de ter precedência',
    ficheiro: 'helpers/quotas-config.js',
    de: '  const doCondominio = chaveDoCondominio(chave, condominioId);',
    para: '  const doCondominio = null;',
    script: SCRIPT,
  });

  // ── 4. O campo da percentagem desaparece do formulário ──────────
  mutacao({
    nome: '4. o campo da percentagem desaparece do formulário de configuração',
    ficheiro: 'views/admin/quotas/listar.handlebars',
    de: 'name="fcr_percentagem"',
    para: 'name="fcr_percentagem_x"',
    script: SCRIPT,
  });

  // ── 5. O plano do orçamento deixa de aplicar o FCR ──────────────
  // Sem o acréscimo, o plano volta a representar só as despesas (12.000 €) e as
  // quotas emitidas pelo orçamento ficam sem fundo.
  mutacao({
    nome: '5. o plano do orçamento deixa de aplicar o FCR',
    ficheiro: 'helpers/plano.js',
    de: '    const valorC = fcrP > 0 ? acrescentarFcrAoTotal(despesasC, fcrP) : despesasC;',
    para: '    const valorC = despesasC;',
    script: SCRIPT,
  });

  // ── 6. A emissão volta a gravar só o valor, sem componentes ─────
  mutacao({
    nome: '6. a emissão do orçamento volta a gravar a quota sem as componentes de FCR',
    ficheiro: 'routes/orcamento.js',
    de: '          valor_fcr: fromCents(partes.fcrC),',
    para: '          valor_fcr: null,',
    script: SCRIPT,
  });

  // ── 7. O balancete soma o FCR por cima do valor da quota ────────
  // Dupla contagem: o FCR já está DENTRO de `q.valor` (a quota vale o total).
  // Somá-lo outra vez inflaciona o lançado em 100 € no cenário da secção G —
  // é esta a hipótese que a validação da dupla contabilização tem de travar.
  mutacao({
    nome: '7. o balancete soma o FCR por cima do valor da quota (dupla contagem)',
    ficheiro: 'helpers/relatorio-financeiro.js',
    de: '    atual.lancadoC += toCents(q.valor);',
    para: '    atual.lancadoC += toCents(q.valor) + toCents(q.valor_fcr);',
    script: SCRIPT,
  });

  console.log(`\n✓ Testes de mutação da percentagem do FCR passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
