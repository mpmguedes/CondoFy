// ═══════════════════════════════════════════════════════════════════
// P54-7 — MUTAÇÃO do âmbito por condomínio e da proteção da gravação das
// AUTOMAÇÕES DE DOCUMENTOS.
//
// `scripts/test-automacoes-isolamento.js` passa. Isso, sozinho, não prova
// nada: um teste que passa também passa quando o âmbito está quebrado e ele não
// olha para lá. Aqui quebra-se o código de propósito, uma mutação de cada vez, e
// exige-se que o teste FALHE — e que falhe PELA RAZÃO CERTA.
//
// Mutações:
//   1. a gravação volta a escrever a chave GLOBAL (o defeito que o P54-7
//      corrige: um condomínio a mudar a automação de todos);
//   2. `gravarNoAmbito` deixa de exigir âmbito e cai na chave global;
//   3. a leitura deixa de dar precedência à chave do condomínio (a específica
//      passa a ser ignorada);
//   4. `validarCorpo` deixa de exigir o marcador de submissão completa (um POST
//      direto volta a desligar tudo em silêncio);
//   5. `validarCorpo` deixa de rejeitar campos desconhecidos (aceita um
//      `condominioId` vindo do corpo — o âmbito deixa de ser confiável);
//   6. a rota de gravação tira o âmbito do CORPO do pedido em vez do tenant;
//   7. a rota de consulta deixa de passar o condomínio (a página mostra a
//      automação herdada em vez da do condomínio);
//   8. a vista deixa de enviar o marcador de submissão completa;
//   9. a vista volta a ter um formulário próprio (componente duplicado);
//  10. o consumidor (`routes/financeiro.js`) volta a ler a automação SEM o
//      condomínio — a decisão de um passa a governar a geração de todos.
//
// ── Nomes de backup próprios (árvore partilhada) ───────────────────
// Outros harnesses varrem `^\.mutation-backup-\d+-\d+\.tmp$` e afastam tudo o
// que encontram — incluindo o backup de uma execução alheia ainda a correr.
// Este usa o prefixo `mutation-backup-auto-`, que não casa com aquele padrão.
// ⛔ Ainda assim, NUNCA correr em paralelo com outro harness de mutação.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com cópia integral + verificação por sha256 no `finally`.
//
// Utilização: node scripts/test-mutacao-automacoes.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupMut = require('./helpers/backup-mutacao');
const correrProc = require('./helpers/correr-processo');

const RAIZ = path.join(__dirname, '..');
const PREFIXO = 'mutation-backup-auto-';
const SCRIPT = 'test-automacoes-isolamento.js';
const AMBITO = 'helpers/config-ambito.js';
const AUTO = 'helpers/automacoes.js';
const ROTA = 'routes/configuracao.js';
const VISTA = 'views/admin/configuracao/automacoes.handlebars';
const CONSUMIDOR = 'routes/financeiro.js';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const RESULTADO = { PASSOU: 'passou', FALHOU: 'falhou', INTERROMPIDO: 'interrompido' };

function correrTeste() {
  const r = correrProc.executarOuFalhar(process.execPath, [path.join(RAIZ, 'scripts', SCRIPT)], {
    cwd: RAIZ, timeout: 120000,
  });
  if (r.estado === correrProc.ESTADO.PASSOU) return { resultado: RESULTADO.PASSOU, saida: r.saida };
  if (r.estado === correrProc.ESTADO.INTERROMPIDO) return { resultado: RESULTADO.INTERROMPIDO, saida: r.saida };
  return { resultado: RESULTADO.FALHOU, saida: r.saida };
}

function mutacao({ nome, ficheiro, de, para, espera }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);
  const bkp = backupMut.criar({ alvo, ficheiro, raiz: RAIZ, prefixo: PREFIXO });

  try {
    assert.ok(original.includes(de), `mutação impossível: o padrão a mutar não existe em ${ficheiro}`);
    const mutado = original.replace(de, para);
    assert.notStrictEqual(mutado, original, `mutação «${nome}»: nada mudou`);
    fs.writeFileSync(alvo, mutado);

    const { resultado, saida } = correrTeste();
    assert.notStrictEqual(resultado, RESULTADO.INTERROMPIDO,
      `execução interrompida (timeout/SIGTERM) ao testar «${nome}»: inconclusivo — voltar a correr`);
    assert.notStrictEqual(resultado, RESULTADO.PASSOU,
      `mutação NÃO detetada: ${SCRIPT} continuou a passar com «${nome}» aplicada`);
    assert.ok(espera.test(saida),
      `mutação detetada pela razão ERRADA: esperava ${espera} na saída do teste.\n`
      + `Saída observada:\n${saida.split('\n').slice(-12).join('\n')}`);
    feito(`«${nome}» → ${SCRIPT} FALHA pela razão certa (${espera})`);
  } finally {
    const restauro = backupMut.restaurar(bkp);
    assert.ok(restauro.ok, `restauro de ${ficheiro} não ficou idêntico ao original`);
    backupMut.limpar(bkp);
    assert.strictEqual(hash(fs.readFileSync(alvo, 'utf8')), hashOriginal,
      `restauro de ${ficheiro} não ficou idêntico ao original`);
  }
}

const MUTACOES = [
  {
    // ⛔ O defeito central do P54-7: a gravação de um condomínio a escrever a
    // chave global, que TODOS herdam.
    // Detetada pela asserção MAIS DIRETA — «a chave global (herdada) nunca é
    // reescrita» —, que corre primeiro; sem essa ordem, a mutação era apanhada
    // mais tarde e por um sintoma (A a ler o valor que B escreveu), não pela
    // causa.
    nome: 'a gravação volta a escrever a chave global (ignora o âmbito)',
    ficheiro: AMBITO,
    de: '  return setConfig(chaveDoCondominio(chave, id), String(valor));',
    para: '  return setConfig(chave, String(valor));',
    espera: /chave GLOBAL \(herdada\) nunca é reescrita/,
  },
  {
    // ⛔ Sem âmbito, cair na chave global é precisamente o que não pode acontecer.
    // A asserção que a apanha é o `assert.rejects` de `testeSemAmbitoRecusa`:
    // sem exceção, o `assert.rejects` falha com «âmbito inválido (…) tinha de
    // ser recusado».
    nome: '`gravarNoAmbito` deixa de exigir âmbito e cai na chave global',
    ficheiro: AMBITO,
    de: '  if (!id) {\n'
      + '    throw new Error(\n'
      + "      `${origem || 'gravarNoAmbito'} exige um condominioId válido `\n"
      + "      + '(não é possível gravar configuração sem âmbito).'\n"
      + '    );\n'
      + '  }\n',
    para: '  if (!id) return setConfig(chave, String(valor));\n',
    espera: /âmbito inválido/,
  },
  {
    nome: 'a leitura deixa de dar precedência à chave do condomínio',
    ficheiro: AMBITO,
    de: '  const doCondominio = chaveDoCondominio(chave, condominioId);\n'
      + '  if (doCondominio) {\n'
      + '    const valor = await getConfig(doCondominio, null);\n'
      + "    if (valor !== null && valor !== '') return valor;\n"
      + '  }\n',
    para: '',
    espera: /específica do condomínio ganha à global/,
  },
  {
    // ⛔ Sem o marcador, «campo ausente» (checkbox desmarcada) confunde-se com
    // «formulário nunca submetido» e um POST direto desliga tudo.
    nome: 'deixa de exigir o marcador de submissão completa',
    ficheiro: AUTO,
    de: "  if (corpo[MARCADOR] !== '1') {\n"
      + '    return {\n'
      + '      ok: false,\n'
      + "      motivo: 'submissao_incompleta',\n"
      + "      mensagem: 'A submissão não foi identificada como completa. Recarregue a página e tente de novo '\n"
      + "        + '(nenhuma automação foi alterada).',\n"
      + '    };\n'
      + '  }\n',
    para: '',
    espera: /sem marcador de submissão completa/,
  },
  {
    // ⛔ Aceitar o condomínio pelo corpo é aceitar que o cliente escolha o âmbito.
    nome: 'deixa de rejeitar campos desconhecidos (aceita o condomínio pelo corpo)',
    ficheiro: AUTO,
    de: '  const conhecidas = new Set([MARCADOR, ...chavesConhecidas()]);\n'
      + '  const desconhecidas = Object.keys(corpo).filter((k) => !conhecidas.has(k));\n'
      + '  if (desconhecidas.length) {\n'
      + '    return {\n'
      + '      ok: false,\n'
      + "      motivo: 'campo_desconhecido',\n"
      + '      campos: desconhecidas,\n'
      + "      mensagem: `Campo não reconhecido: ${desconhecidas.join(', ')}. Nada foi alterado.`,\n"
      + '    };\n'
      + '  }\n',
    para: '',
    espera: /desconhecido|não reconhecido|Missing expected rejection/,
  },
  {
    nome: 'a rota de gravação tira o âmbito do CORPO do pedido em vez do tenant',
    ficheiro: ROTA,
    de: 'guardarAutomacoes(req.body, req.condominioId)',
    para: 'guardarAutomacoes(req.body, req.body.condominioId)',
    espera: /o âmbito da gravação vem do tenant/,
  },
  {
    // O `listarAutomacoes()` sem âmbito lê a chave HERDADA: a página mostra e
    // pré-marca a automação global, e o administrador guarda a decisão de outro.
    // Detetada pela asserção que exige `req.condominioId` na consulta.
    nome: 'a rota de consulta deixa de passar o condomínio (mostra a chave herdada)',
    ficheiro: ROTA,
    de: '  const grupos = await listarAutomacoes(req.condominioId);',
    para: '  const grupos = await listarAutomacoes();',
    espera: /a consulta é feita no âmbito do condomínio ativo/,
  },
  {
    nome: 'a vista deixa de enviar o marcador de submissão completa',
    ficheiro: VISTA,
    de: '  <input type="hidden" name="_automacoes" value="1" />\n',
    para: '',
    espera: /a vista envia o marcador/,
  },
  {
    nome: 'a vista volta a ter um formulário próprio (componente duplicado)',
    ficheiro: VISTA,
    de: '{{#> _modo-edicao id="automacoes" acao="/admin/config/automacoes"',
    para: '<form action="/admin/config/automacoes" method="POST">\n'
      + '{{#> _modo-edicao id="automacoes" acao="/admin/config/automacoes"',
    espera: /não há um segundo formulário próprio/,
  },
  {
    nome: 'o consumidor volta a ler a automação sem o condomínio',
    ficheiro: CONSUMIDOR,
    de: "automacaoAtiva('quotas', 'drive', req.condominioId)",
    para: "automacaoAtiva('quotas', 'drive')",
    espera: /TODAS as leituras do consumidor levam o condomínio ativo/,
  },
];

console.log('P54-7 — testes de mutação: âmbito por condomínio e proteção da gravação das automações');

// Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
// alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original.
backupMut.varrerResiduos({ raiz: RAIZ, prefixo: PREFIXO });

// ── Pré-condição: sem mutação, o teste tem de PASSAR ────────────────
titulo('Pré-condição: o teste passa no código atual');
const inicial = correrTeste();
assert.notStrictEqual(inicial.resultado, RESULTADO.INTERROMPIDO,
  'execução interrompida na pré-condição: inconclusivo');
assert.strictEqual(inicial.resultado, RESULTADO.PASSOU,
  `${SCRIPT} já falhava ANTES de qualquer mutação — a prova por mutação seria vazia:\n`
  + inicial.saida.split('\n').slice(-15).join('\n'));
feito(`${SCRIPT} passa sem mutação (a prova tem base)`);

for (const m of MUTACOES) mutacao(m);

console.log(`\n✓ ${nTestes} verificações: ${MUTACOES.length} mutações, todas detetadas pela razão certa.`);
console.log('✓ Todos os alvos restaurados byte a byte (sha256 conferido).');
