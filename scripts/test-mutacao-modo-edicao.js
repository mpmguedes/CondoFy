// ═══════════════════════════════════════════════════════════════════
// P54-0 — MUTAÇÃO do padrão «consulta → Editar → Cancelar → Guardar».
//
// `scripts/test-modo-edicao.js` passa. Isso, sozinho, não prova nada: um teste
// que passa também passa quando o padrão está quebrado e ele não olha para lá.
// Aqui quebra-se o código de propósito, uma mutação de cada vez, e exige-se que
// o teste FALHE — e que falhe PELA RAZÃO CERTA, não por um efeito colateral.
//
// Mutações (alvos: o parcial, a folha e o script):
//   1. o formulário deixa de nascer `hidden` (abria-se a porta à edição
//      acidental em consulta — o defeito central que o P54 combate);
//   2. a regra de segredos inverte-se (`{{#unless sensivel}}`): a máscara passa
//      a ser mostrada nas linhas normais e o SEGREDO sai no HTML das sensíveis;
//   3. o botão Editar perde `aria-expanded`;
//   4. o botão Cancelar passa a `type="submit"` (passaria a submeter!);
//   5. um seletor fora do namespace `.me` entra na folha;
//   6. a folha passa a usar `!important`;
//   7. o JS deixa de travar a submissão em consulta;
//   8. o JS deixa de restaurar os valores ao cancelar;
//   9. o JS deixa de focar o primeiro campo ao entrar em edição;
//  10. o JS deixa de devolver o foco ao botão Editar;
//  11. o JS deixa de proteger a saída com alterações pendentes;
//  12. o JS deixa de manter `aria-expanded` coerente com o estado.
//
// ── Nomes de backup próprios (árvore partilhada) ───────────────────
// Outros harnesses varrem `^\.mutation-backup-\d+-\d+\.tmp$` e afastam tudo o
// que encontram — incluindo o backup de uma execução alheia ainda a correr.
// Este usa o prefixo `mutation-backup-modoedicao-`, que não casa com aquele
// padrão. Ainda assim, nunca correr em paralelo com outro harness de mutação.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com `fs.writeFileSync` + verificação por sha256 no `finally`.
//
// Utilização: node scripts/test-mutacao-modo-edicao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupMut = require('./helpers/backup-mutacao');
const correrProc = require('./helpers/correr-processo');

const RAIZ = path.join(__dirname, '..');
const PREFIXO = 'mutation-backup-modoedicao-';
const SCRIPT = 'test-modo-edicao.js';
const PARCIAL = 'views/partials/_modo-edicao.handlebars';
const CSS = 'public/css/modo-edicao.css';
const JS = 'public/js/modo-edicao.js';
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
    // ⛔ É o defeito central que o P54 combate: sem `hidden`, os campos ficam
    // focáveis e submetíveis em consulta — a alteração acidental que se quer
    // impedir (foi o que aconteceu no P50, com o TLS).
    nome: 'o formulário deixa de nascer `hidden`',
    ficheiro: PARCIAL,
    de: 'action="{{acao}}" hidden>',
    para: 'action="{{acao}}">',
    espera: /nasce com o atributo/,
  },
  {
    // ⛔ Remove o ramo da máscara: TODAS as linhas passam a imprimir o valor,
    // incluindo as `sensivel: true` — o segredo sai no HTML.
    // (Uma variante anterior trocava só `#if` por `#unless` e deixava o `{{/if}}`:
    // o template nem compilava, e o teste falhava por erro de PARSER, não pela
    // regra. Uma mutação malformada não prova nada — foi substituída.)
    nome: 'a regra de segredos cai (a linha sensível imprime o valor real)',
    ficheiro: PARCIAL,
    de: '          {{#if sensivel}}\n'
      + '          <span class="me-mascara" aria-hidden="true">{{#if mascara}}{{mascara}}{{else}}•••••{{/if}}</span>\n'
      + '          <span class="me-visually-hidden">valor protegido</span>\n'
      + '          {{else}}\n'
      + '          {{#if valor}}{{valor}}{{else}}—{{/if}}\n'
      + '          {{/if}}\n',
    para: '          {{#if valor}}{{valor}}{{else}}—{{/if}}\n',
    espera: /NÃO imprime o valor/,
  },
  {
    nome: 'o botão Editar perde o `aria-expanded`',
    ficheiro: PARCIAL,
    de: 'aria-expanded="false" aria-controls="{{id}}-form">',
    para: 'aria-controls="{{id}}-form">',
    espera: /Editar tem/,
  },
  {
    // ⛔ Um botão de Cancelar que submete é o oposto do que o padrão promete.
    nome: 'o botão Cancelar passa a `type="submit"`',
    ficheiro: PARCIAL,
    de: '<button type="button" class="me-btn me-btn-cancelar" data-me-cancelar>',
    para: '<button class="me-btn me-btn-cancelar" data-me-cancelar>',
    espera: /nunca submete/,
  },
  {
    nome: 'entra um seletor fora do namespace `.me` na folha',
    ficheiro: CSS,
    de: '.me-form { margin: 0; }',
    para: '.qualquer-coisa { margin: 0; }\n.me-form { margin: 0; }',
    espera: /fora do namespace/,
  },
  {
    nome: 'a folha passa a usar `!important`',
    ficheiro: CSS,
    de: '.me-form { margin: 0; }',
    para: '.me-form { margin: 0 !important; }',
    espera: /não usa/,
  },
  {
    // ⛔ Sem isto, um Enter num campo (ou um autofill) submeteria o formulário
    // mesmo em consulta — a submissão acidental.
    nome: 'o JS deixa de travar a submissão em consulta',
    ficheiro: JS,
    de: '    if (estadoDe(bloco) !== EDICAO) {\n      ev.preventDefault();\n      return;\n    }\n',
    para: '',
    espera: /submeter em consulta é travado/,
  },
  {
    nome: 'o JS deixa de restaurar os valores ao cancelar',
    ficheiro: JS,
    de: '      if (mapa) restaurar(p.form, mapa);\n',
    para: '',
    espera: /RESTAURA o valor original/,
  },
  {
    nome: 'o JS deixa de focar o primeiro campo ao entrar em edição',
    ficheiro: JS,
    de: '    focar(primeiroEditavel(p.form));\n',
    para: '',
    espera: /foco vai para o primeiro campo editável/,
  },
  {
    nome: 'o JS deixa de devolver o foco ao botão Editar',
    ficheiro: JS,
    de: '    if (p.editar) focar(p.editar);\n',
    para: '',
    espera: /o foco volta ao botão Editar/,
  },
  {
    nome: 'o JS deixa de proteger a saída com alterações pendentes',
    ficheiro: JS,
    de: '    if (sujos.size === 0) return;\n',
    para: '',
    espera: /sair da página não é travado/,
  },
  {
    nome: 'o JS deixa de manter `aria-expanded` coerente com o estado',
    ficheiro: JS,
    de: "      p.editar.setAttribute('aria-expanded', emEdicao ? 'true' : 'false');\n",
    para: '',
    espera: /aria-expanded/,
  },
];

console.log('P54-0 — testes de mutação: padrão consulta / edição / cancelar / guardar');

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
