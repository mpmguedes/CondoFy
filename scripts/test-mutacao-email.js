// ═══════════════════════════════════════════════════════════════════
// MUTAÇÃO — provam que os testes de Email/SMTP, período e comunicações
// MORDEM (P52).
//
// Um teste que passa não prova nada se não falhar quando o código é quebrado.
// Aqui aplica-se, uma a uma, uma mutação REAL ao código-fonte, corre-se o teste
// que a deve detetar e verifica-se que ele FALHA. No fim, restaura-se o
// ficheiro BYTE A BYTE e confirma-se com o hash.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real, e
//    este repositório tem várias frentes a decorrer na mesma working tree).
//    Backup com `fs.writeFileSync` + verificação por sha256.
//
// ⛔ ÂNCORA ÚNICA — a lição paga em P52. `String.prototype.replace` com uma
//    string muta a PRIMEIRA ocorrência; uma âncora que ocorra duas vezes muta a
//    linha errada e a prova não vale nada (aconteceu com
//    `condominioId: req.condominioId,`, que existe 2× em `routes/configuracao.js`).
//    Este harness CONTA as ocorrências e recusa-se a correr se a âncora não for
//    exatamente 1. É por isso que aqui só se mutam ficheiros desta frente.
//
// Mutações cobertas:
//   1. P51 — o atalho volta a ser derivado do intervalo (ignora o botão pedido);
//   2. o intervalo invertido deixa de ser normalizado;
//   3. o período por omissão passa a ser o histórico inteiro;
//   4. P50 — `obterEstadoSmtp()` deixa de devolver `tls` como booleano;
//   5. P50 — o `<select name="tls">` volta a ter `selected` fixo;
//   6. P29 — o disparo automático usa o critério de deduplicação do manual
//      (perde a idempotência: `erro`/`cancelado` deixam de bloquear);
//   7. P29 — a rota manual usa o critério do automático (deixa de reenviar
//      depois de um erro, que era o comportamento anterior).
//
// Utilização: node scripts/test-mutacao-email.js
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

// Distinguir «o teste FALHOU» de «o teste foi INTERROMPIDO». Uma execução morta
// pelo `timeout` (SIGTERM) também cai no `catch`, mas NÃO é uma deteção: é um
// processo sem desfecho. Tomá-la por deteção daria a mutação por boa num estado
// em que pode nem ter sido restaurada.
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
//
// O restauro é SEMPRE byte a byte, no `finally`. Se o processo for morto a meio
// (SIGTERM/timeout) fica um backup órfão — e o backup guarda o ORIGINAL, pelo
// que um órfão nunca perde conteúdo. O varrimento de arranque repõe-no.
function mutacao({ nome, ficheiro, de, para, script }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);

  // ⛔ A âncora tem de ocorrer EXATAMENTE uma vez. Sem isto, um `replace` muta a
  // primeira ocorrência — possivelmente a linha errada — e a «prova» é vazia.
  const ocorrencias = original.split(de).length - 1;
  assert.strictEqual(ocorrencias, 1,
    `a âncora de «${nome}» tem de ocorrer exatamente 1× em ${ficheiro} (ocorre ${ocorrencias}×) — sem âncora única a mutação não prova nada`);

  const bkp = backupMut.criar({ alvo, ficheiro, raiz: RAIZ });

  let resultado = null;
  try {
    fs.writeFileSync(alvo, original.replace(de, para));
    assert.notStrictEqual(fs.readFileSync(alvo, 'utf8'), original, 'a mutação tem de alterar o ficheiro');
    resultado = resultadoDoTeste(script);
  } finally {
    backupMut.restaurar(bkp);
    assert.strictEqual(hash(fs.readFileSync(alvo, 'utf8')), hashOriginal, `restauro de ${ficheiro} tem de ser byte a byte`);
    backupMut.limpar(bkp);
  }

  assert.strictEqual(resultado, RESULTADO.FALHOU,
    `«${nome}» devia ser detetada por ${script} (resultado: ${resultado})`);
  feito(`${script} detetou a mutação e ${ficheiro} ficou reposto (sha256 conferido)`);
}

// Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
// ficheiro alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original, pelo que
// se repõe o alvo a partir dele em vez de só apagar o lixo.
function varrerBackupsOrfaos() {
  // Repõe alvos órfãos e afasta os resíduos pela via do helper: rename para
  // fora da árvore, sem uma única eliminação (o `safe-delete` deixa de ser tocado).
  backupMut.varrerResiduos({ raiz: RAIZ });
}

(async () => {
  varrerBackupsOrfaos();

  titulo('P51 — o atalho volta a ser derivado do intervalo');
  mutacao({
    nome: '1. o atalho ignora o botão pedido e é sempre derivado',
    ficheiro: 'helpers/periodo-filtro.js',
    de: '  if (IDS_ATALHO.includes(pedido)) {\n    atalho = pedido;\n  } else {',
    para: '  if (false) {\n    atalho = pedido;\n  } else {',
    script: 'test-periodo-filtro.js',
  });

  titulo('período — normalização do intervalo invertido');
  mutacao({
    nome: '2. o intervalo invertido deixa de ser normalizado',
    ficheiro: 'helpers/periodo-filtro.js',
    de: '    if (de.getTime() > ate.getTime()) {',
    para: '    if (false) {',
    script: 'test-periodo-filtro.js',
  });

  titulo('período — o intervalo por omissão');
  mutacao({
    nome: '3. o período por omissão passa a ser o histórico inteiro',
    ficheiro: 'helpers/periodo-filtro.js',
    de: '    de = dataDeInput(q.de) || primeiroDiaDoMes(agora);',
    para: '    de = dataDeInput(q.de) || new Date(1970, 0, 1);',
    script: 'test-periodo-filtro.js',
  });

  titulo('P50 — o estado SMTP para a interface');
  mutacao({
    nome: '4. `obterEstadoSmtp()` devolve `tls` como string (não booleano)',
    ficheiro: 'helpers/mailer.js',
    de: '    tls,\n',
    para: '    tls: cfg.tls,\n',
    script: 'test-smtp-estado.js',
  });

  titulo('P50 — o formulário do TLS');
  mutacao({
    nome: '5. o `<select name="tls">` volta a ter `selected` fixo',
    ficheiro: 'views/admin/configuracao/email.handlebars',
    de: '<option value="true" {{#if estadoSmtp.tls}}selected{{/if}}>',
    para: '<option value="true" selected>',
    script: 'test-configuracoes.js',
  });

  titulo('P29 — idempotência do disparo automático');
  mutacao({
    nome: '6. o disparo automático usa o critério de deduplicação do manual',
    ficheiro: 'jobs/avisos-programados.js',
    de: '        estadosJaDespachados: ESTADOS_DESPACHADOS,',
    para: "        estadosJaDespachados: ['pendente', 'a_enviar', 'enviado'],",
    script: 'test-avisos-programados.js',
  });

  titulo('P29 — a rota manual reenvia depois de um erro');
  mutacao({
    nome: '7. a rota manual passa a usar o critério do automático',
    ficheiro: 'routes/avisos.js',
    de: '    estadosJaDespachados: ESTADOS_EM_CURSO,',
    para: "    estadosJaDespachados: ['pendente', 'a_enviar', 'enviado', 'erro', 'cancelado'],",
    script: 'test-avisos-programados.js',
  });

  titulo('Lembretes/atrasos — o dia da janela em componentes LOCAIS');
  mutacao({
    nome: '8. o fim da janela do lembrete volta ao `toISOString()` (dia recuado em fusos positivos)',
    ficheiro: 'jobs/automatizacao.js',
    de: '  const fimLembrete = toDateInput(somarDias(hoje, diasLembrete));',
    para: '  const fimLembrete = somarDias(hoje, diasLembrete).toISOString().slice(0, 10);',
    script: 'test-lembretes-automaticos.js',
  });

  mutacao({
    nome: '9. o início da janela do lembrete volta ao `toISOString()` (o «hoje» recua um dia)',
    ficheiro: 'jobs/automatizacao.js',
    de: '  const hojeISO = toDateInput(hoje);',
    para: '  const hojeISO = hoje.toISOString().slice(0, 10);',
    script: 'test-lembretes-automaticos.js',
  });

  titulo('Lembretes/atrasos — a folga de recuperação de dias perdidos');
  mutacao({
    nome: '10. a janela de atraso volta ao dia exato (uma paragem perde a coorte para sempre)',
    ficheiro: 'jobs/automatizacao.js',
    de: '  const inicioAtraso = toDateInput(somarDias(hoje, -diasAtraso - DIAS_RECUPERACAO));',
    para: '  const inicioAtraso = toDateInput(somarDias(hoje, -diasAtraso));',
    script: 'test-lembretes-automaticos.js',
  });

  titulo('Lembretes/atrasos — o marcador de envio na fila');
  mutacao({
    nome: '11. o marcador deixa de travar o reenvio (a janela relativa reenviaria todos os dias)',
    ficheiro: 'jobs/automatizacao.js',
    de: '    if (jaDespachado.has(`${Number(q.id)}:${assunto}`)) {',
    para: '    if (false) {',
    script: 'test-lembretes-automaticos.js',
  });

  titulo('Lembretes/atrasos — o assunto é a chave do marcador');
  mutacao({
    nome: '12. o assunto enviado diverge da chave do marcador (reescrita isolada de um dos dois)',
    ficheiro: 'jobs/automatizacao.js',
    de: '    const assunto = ehAtraso ? ASSUNTO_ATRASO : ASSUNTO_LEMBRETE;',
    para: "    const assunto = ehAtraso ? 'Aviso de atraso (quota em dívida)' : ASSUNTO_LEMBRETE;",
    script: 'test-lembretes-automaticos.js',
  });

  console.log(`\n✓ Testes de mutação de Email/SMTP, comunicações e lembretes passaram (${nTestes} mutações, todas detetadas e revertidas por sha256).`);
})().catch((e) => {
  console.error('\n✗ FALHA:', e.message);
  process.exit(1);
});
