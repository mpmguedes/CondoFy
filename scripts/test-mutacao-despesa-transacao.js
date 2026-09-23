// ═══════════════════════════════════════════════════════════════════
// P16 — Testes de MUTAÇÃO da atomicidade despesa ↔ movimento bancário.
//
// `scripts/test-despesa-transacao.js` passa. Isso, sozinho, não prova nada:
// um teste que passa também passa quando o código está quebrado e ele não
// olha para lá. Aqui quebra-se `helpers/movimentos.js` de propósito, uma
// mutação de cada vez, e exige-se que o teste FALHE — e que o FALHE pela
// razão certa.
//
// ── Âmbito deliberado: SÓ `helpers/movimentos.js` ──────────────────
// A correção de P16 tocou também em `routes/financeiro.js` (os três
// handlers passaram a propagar a transação). Esse ficheiro NÃO é mutado
// aqui, por uma razão de risco, não de desleixo: está a ser editado agora
// por outra frente (FCR/orçamento) e mutá-lo — mesmo por dois segundos —
// podia (a) fazer falhar uma suite alheia a correr em paralelo e (b)
// sobrepor-se a uma gravação do editor no momento do restauro.
//
// A propagação dos CALLERS fica, ainda assim, coberta por mutação: a
// mutação 1 desliga a transação DENTRO do helper e o cenário 5 do teste
// falha. É o mesmo defeito observável que os callers a passar `undefined`
// produzem — se alguém voltar a passar `undefined`, o cenário 5 apanha-o.
// Ou seja, a mutação 1 prova que a asserção que deteta o defeito dos
// callers MORDE.
//
// ── Nomes de backup próprios (colisão em árvore partilhada) ────────
// Os harnesses existentes varrem `^\.mutation-backup-\d+-\d+\.tmp$` no
// arranque e APAGAM tudo o que encontram — incluindo o backup de uma
// execução alheia ainda a correr, o que faz o restauro dessa execução
// falhar com ENOENT e deixa o ficheiro MUTADO. Para não participar nessa
// colisão, este harness usa o prefixo `mutation-backup-movimentos-`, que
// não casa com o regex dos outros, e a sua varredura de arranque só olha
// para os seus próprios resíduos.
//
// ⛔ Nunca se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com `fs.writeFileSync` + verificação por sha256 no `finally`.
//
// Mutações (ficheiro alvo: `helpers/movimentos.js`, teste alvo:
// `test-despesa-transacao.js`). Não basta o teste falhar: tem de falhar NA
// ASSERÇÃO indicada — falhar noutro cenário não prova que a invariante em
// causa está vigiada.
//   1. o helper ignora a transação que recebe                 → 5d. (rollback)
//   2. volta a guarda «só atualiza se já estiver confirmado»  → 9h. (saldo)
//   3. a atualização deixa de gravar `estado: 'confirmado'`   → 9h. (saldo)
//   4. o movimento NOVO nasce 'anulado'                       → 1j. (saldo)
//   5. a anulação do movimento perde a transação              → 7h. (rollback)
//
// Utilização: node scripts/test-mutacao-despesa-transacao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupMut = require('./helpers/backup-mutacao');
const correrProc = require('./helpers/correr-processo');

const RAIZ = path.join(__dirname, '..');
const ALVO = path.join(RAIZ, 'helpers', 'movimentos.js');
const REL_ALVO = 'helpers/movimentos.js';
const TESTE = 'test-despesa-transacao.js';
const PREFIXO = '.mutation-backup-movimentos-';
const RE_RESIDUO = /^\.mutation-backup-movimentos-\d+-\d+\.tmp$/;

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
let nMutacoes = 0;
const feito = (nome) => { nMutacoes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Corre o teste alvo num processo separado e devolve o desfecho COM a saída.
// Distingue-se «o teste FALHOU» (deteção) de «o teste foi INTERROMPIDO»
// (timeout/SIGTERM): uma execução morta não prova nada e não pode contar como
// mutação detetada. A saída é devolvida para se poder exigir que a falha seja
// NA ASSERÇÃO ESPERADA — falhar noutro cenário não é prova nenhuma.
const RESULTADO = { PASSOU: 'passou', FALHOU: 'falhou', INTERROMPIDO: 'interrompido' };

function correrTeste() {
  // ⛔ P53-FOLLOWUP: ver `helpers/correr-processo.js`. Uma falha de spawn
  // (EBUSY) aborta aqui com mensagem de infraestrutura em vez de devolver
  // FALHOU — era esse FALHOU espúrio que fazia o harness declarar a mutação
  // detetada sem o filho alguma vez ter corrido.
  const r = correrProc.executarOuFalhar(process.execPath, [path.join(RAIZ, 'scripts', TESTE)], {
    cwd: RAIZ, timeout: 120000,
  });
  const resultado = r.estado === correrProc.ESTADO.PASSOU ? RESULTADO.PASSOU
    : (r.estado === correrProc.ESTADO.INTERROMPIDO ? RESULTADO.INTERROMPIDO : RESULTADO.FALHOU);
  return { resultado, saida: r.saida };
}

// Aplica uma mutação, corre o teste (tem de FALHAR, e falhar na asserção
// indicada) e restaura o ficheiro.
// `ocorrencias` é OBRIGATÓRIO: uma âncora que aparece 2× e é substituída só
// na primeira não prova nada (a segunda ocorrência continua a fazer o que
// devia e o teste passa por engano).
function mutacao({ nome, de, para, ocorrencias = 1, falhaEm }) {
  titulo(nome);
  const original = fs.readFileSync(ALVO, 'utf8');
  const hashOriginal = hash(original);

  const contagem = original.split(de).length - 1;
  assert.strictEqual(contagem, ocorrencias,
    `mutação impossível: «${nome}» — a âncora ocorre ${contagem}× em ${REL_ALVO} `
    + `(esperado ${ocorrencias}×); âncora não única não prova nada`);
  assert.ok(falhaEm, `mutação «${nome}» sem asserção esperada: a prova seria cega`);

  const bkp = backupMut.criar({ alvo: ALVO, ficheiro: REL_ALVO, raiz: RAIZ, prefixo: PREFIXO });

  try {
    const mutado = original.split(de).join(para);
    assert.notStrictEqual(mutado, original, `mutação ${nome}: nada mudou`);
    fs.writeFileSync(ALVO, mutado);

    // Uma mutação que não COMPILA faria o teste falhar por erro de carregamento
    // do módulo, não por detetar o defeito — seria uma deteção FALSA. Exige-se
    // que o código mutado continue a ser JavaScript válido.
    //
    // ⛔ P53-FOLLOWUP: `verificarSintaxe` distingue «código inválido» (false) de
    // «não consegui executar» (aborta). Antes, um EBUSY do host caía no `catch`
    // e era reportado como «produziu código inválido» — uma atribuição FALSA,
    // que escondia uma falha de infraestrutura atrás de um erro de sintaxe.
    if (!correrProc.verificarSintaxe(RAIZ, ALVO)) {
      assert.fail(`mutação «${nome}» produziu código inválido (erro de sintaxe): `
        + 'a falha do teste não provaria nada');
    }

    const { resultado, saida } = correrTeste();
    assert.notStrictEqual(resultado, RESULTADO.INTERROMPIDO,
      `execução interrompida (timeout/SIGTERM) ao testar «${nome}»: inconclusivo — `
      + 'não conta como detetada, voltar a correr');
    assert.notStrictEqual(resultado, RESULTADO.PASSOU,
      `mutação NÃO detetada: ${TESTE} continuou a passar com «${nome}» aplicada`);
    // Falhar «em qualquer sítio» não chega: exige-se a asserção que descreve o
    // defeito. Uma mutação que só rebentasse noutro cenário não provaria que a
    // invariante em causa está de facto a ser vigiada.
    assert.ok(saida.includes(falhaEm),
      `mutação «${nome}» foi detetada, mas NÃO em «${falhaEm}» — o teste falhou por `
      + `outra razão, logo não vigia a invariante que a mutação quebra.\nSaída:\n${saida}`);
    feito(`«${nome}» → ${TESTE} falha em ${falhaEm} (a mutação é detetada no sítio certo)`);
  } finally {
    backupMut.restaurar(bkp);
    backupMut.limpar(bkp);
    assert.strictEqual(hash(fs.readFileSync(ALVO, 'utf8')), hashOriginal,
      `restauro de ${REL_ALVO} não ficou idêntico ao original`);
  }
}

(async () => {
  console.log('P16 — testes de mutação da atomicidade despesa ↔ movimento');

  // Varrimento de arranque, limitado aos resíduos DESTE harness. Uma execução
  // morta a meio deixa o backup órfão E o alvo mutado; cada backup é uma cópia
  // integral do original, pelo que o órfão se repõe (o `.alvo` diz em que
  // ficheiro). Os resíduos de outros harnesses não se tocam.
  backupMut.varrerResiduos({ raiz: RAIZ, prefixo: PREFIXO });

  // ── 1. O helper ignora a transação que recebe ────────────────────
  // É o defeito P16 na sua forma observável: a escrita do movimento deixa de
  // viajar na transação da despesa e passa a ser autocommit, sobrevivendo ao
  // rollback. O cenário 5 (falha de commit) tem de o apanhar.
  mutacao({
    nome: '1. o helper ignora a transação recebida (volta ao defeito P16)',
    de: 'async function sincronizarMovimentoDespesa(despesa, userId, transaction, condominioId) {\n'
      + '  const cid = condominioId || despesa.condominio_id || null;',
    para: 'async function sincronizarMovimentoDespesa(despesa, userId, transaction, condominioId) {\n'
      + '  transaction = undefined; // MUTAÇÃO: escrita autocommit, fora da transação\n'
      + '  const cid = condominioId || despesa.condominio_id || null;',
    falhaEm: '5d.', // «o movimento NÃO sobreviveu ao rollback»
  });

  // ── 2. Volta a guarda «só atualiza se já estiver confirmado» ─────
  // É exatamente o defeito que a entrega fechou: com a guarda, um movimento
  // ANULADO nunca é reposto quando a despesa volta a estar paga, e fica uma
  // despesa paga SEM saída a contar no saldo — em silêncio.
  //
  // A mutação é o bloco inteiro (com a guarda FECHADA): uma guarda aberta
  // seria erro de sintaxe e o teste falharia por não conseguir carregar o
  // módulo, não por detetar o defeito — deteção falsa.
  const BLOCO_UPDATE = '    if (movimento) {\n'
    + '      await movimento.update(\n'
    + '        {\n'
    + '          conta_bancaria_id: despesa.conta_bancaria_id,\n'
    + '          condominio_id: cid,\n'
    + '          data: despesa.data || new Date(),\n'
    + '          valor: despesa.valor,\n'
    + '          descricao: despesa.descricao,\n'
    + '          categoria_id: despesa.categoria_id,\n'
    + '          estado: \'confirmado\',\n'
    + '        },\n'
    + '        { transaction }\n'
    + '      );\n';
  const BLOCO_UPDATE_COM_GUARDA = '    if (movimento) {\n'
    + '      if (movimento.estado === \'confirmado\') {\n'
    + '      await movimento.update(\n'
    + '        {\n'
    + '          conta_bancaria_id: despesa.conta_bancaria_id,\n'
    + '          condominio_id: cid,\n'
    + '          data: despesa.data || new Date(),\n'
    + '          valor: despesa.valor,\n'
    + '          descricao: despesa.descricao,\n'
    + '          categoria_id: despesa.categoria_id,\n'
    + '          estado: \'confirmado\',\n'
    + '        },\n'
    + '        { transaction }\n'
    + '      );\n'
    + '      }\n';
  mutacao({
    nome: '2. volta a guarda: o movimento anulado deixa de ser reposto',
    de: BLOCO_UPDATE,
    para: BLOCO_UPDATE_COM_GUARDA,
    falhaEm: '9h.', // «o movimento volta a contar no saldo»
  });

  // ── 3. A atualização deixa de gravar `estado: 'confirmado'` ──────
  // Sem o campo, o movimento conserva o estado anterior: um movimento anulado
  // continua anulado depois de a despesa voltar a estar paga.
  mutacao({
    nome: '3. a atualização deixa de repor `estado: \'confirmado\'`',
    de: '          categoria_id: despesa.categoria_id,\n'
      + '          estado: \'confirmado\',\n'
      + '        },',
    para: '          categoria_id: despesa.categoria_id,\n'
      + '        },',
    falhaEm: '9h.', // «o movimento volta a contar no saldo»
  });

  // ── 4. O movimento NOVO nasce 'anulado' ──────────────────────────
  // Uma despesa paga cujo movimento nasce anulado não desconta no saldo desde
  // o primeiro instante. O cenário 1 tem de o apanhar.
  mutacao({
    nome: '4. o movimento novo nasce \'anulado\' em vez de \'confirmado\'',
    de: '      created_by: userId || null,\n'
      + '      estado: \'confirmado\',\n'
      + '    },',
    para: '      created_by: userId || null,\n'
      + '      estado: \'anulado\',\n'
      + '    },',
    falhaEm: '1j.', // «confirmado (desconta no saldo)»
  });

  // ── 5. A anulação perde a transação ──────────────────────────────
  // O outro caminho de escrita: se a anulação do movimento for autocommit,
  // sobrevive ao rollback e a despesa fica por anular com o movimento já
  // anulado — divergência silenciosa. O cenário 7 (falha de commit) apanha-a.
  mutacao({
    nome: '5. a anulação do movimento perde a transação (autocommit)',
    de: '    await movimento.update({ estado: \'anulado\' }, { transaction });',
    para: '    await movimento.update({ estado: \'anulado\' }, {});',
    falhaEm: '7h.', // «o movimento ficou confirmado (sem divergência)»
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(` OK — ${nMutacoes} mutações, todas detetadas e revertidas (helpers/movimentos.js intacto).`);
  console.log('═══════════════════════════════════════════════════════════════');
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
