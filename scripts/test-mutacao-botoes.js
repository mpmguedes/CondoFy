// ═══════════════════════════════════════════════════════════════════
// A7 — Testes de MUTAÇÃO do contrato de botões e da acessibilidade.
//
// `scripts/test-botoes-a11y.js` passa. Isso, sozinho, não prova nada: um teste
// que passa também passa quando o CSS está quebrado e ele não olha para lá.
// Aqui quebra-se o código de propósito, uma mutação de cada vez, e exige-se
// que o teste FALHE — e que falhe PELA RAZÃO CERTA (a mensagem da asserção
// esperada), não por um efeito colateral.
//
// Mutações (alvo: `public/css/styles.css` e duas vistas):
//   1. Fase 1 — reintroduzir um segundo `.btn` global (a cascata volta a
//      decidir por ordem de aparição, que é o defeito que a frente corrigiu);
//   2. Fase 3 — o estado desativado volta a atenuar por `opacity`;
//   3. Fase 3 — texto desativado com contraste insuficiente (tema claro);
//   4. Fase 3 — fundo desativado indistinguível do ativo (tema escuro);
//   5. Fase 3B — anel de foco quase da cor da página (tema claro);
//   6. Fase 3B — remover a regra de foco dos botões;
//   7. Fase 3B — anel declarado só com `outline-color` (o Bootstrap 5.3 zera a
//      largura e o anel deixa de ser desenhado — defeito real, medido);
//   8. Fase 3B — o número escrito no comentário do token deixa de conferir com
//      a medição (um número documentado errado é uma afirmação, não uma prova);
//   9. Fase 4 — contrato de altura com valor errado;
//  10. Fase 4 — a "bolinha" deixa de ser circular;
//  11. Fase 2 — controlo só-ícone sem nome acessível;
//  12. Fase 2 — ícone decorativo sem `aria-hidden` (a ligadura do ícone entra
//      no nome acessível do botão).
//
// ── Nomes de backup próprios (árvore partilhada) ───────────────────
// Os outros harnesses varrem `^\.mutation-backup-\d+-\d+\.tmp$` e afastam tudo
// o que encontram — incluindo o backup de uma execução alheia ainda a correr.
// Este harness usa o prefixo `mutation-backup-botoes-`, que não casa com
// aquele padrão, e a sua varredura de arranque só olha para os seus resíduos.
// Ainda assim, nunca correr em paralelo com outro harness de mutação.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com `fs.writeFileSync` + verificação por sha256 no `finally`.
//
// Utilização: node scripts/test-mutacao-botoes.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupMut = require('./helpers/backup-mutacao');
const correrProc = require('./helpers/correr-processo');

const RAIZ = path.join(__dirname, '..');
const PREFIXO = 'mutation-backup-botoes-';
const SCRIPT = 'test-botoes-a11y.js';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const RESULTADO = { PASSOU: 'passou', FALHOU: 'falhou', INTERROMPIDO: 'interrompido' };

// Corre o teste num processo separado. ⛔ Ver `helpers/correr-processo.js`: o
// filho corre com STDIN em `ignore` (mata o `EBUSY` deste host) e uma falha de
// spawn ABORTA, em vez de ser tomada por «o teste FALHOU» (= mutação detetada).
function correrTeste() {
  const r = correrProc.executarOuFalhar(process.execPath, [path.join(RAIZ, 'scripts', SCRIPT)], {
    cwd: RAIZ, timeout: 120000,
  });
  if (r.estado === correrProc.ESTADO.PASSOU) return { resultado: RESULTADO.PASSOU, saida: r.saida };
  if (r.estado === correrProc.ESTADO.INTERROMPIDO) return { resultado: RESULTADO.INTERROMPIDO, saida: r.saida };
  return { resultado: RESULTADO.FALHOU, saida: r.saida };
}

// Aplica uma mutação, corre o teste (tem de FALHAR pela razão esperada) e
// restaura o ficheiro byte a byte.
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
    nome: 'Fase 1: reintroduzir um segundo `.btn` global (a cascata volta a decidir por ordem)',
    ficheiro: 'public/css/styles.css',
    de: '.btn:disabled, .btn.disabled, fieldset:disabled .btn {',
    para: '.btn { border-radius: 20px; }\n.btn:disabled, .btn.disabled, fieldset:disabled .btn {',
    espera: /\.btn: 2 definições globais/,
  },
  {
    nome: 'Fase 3: o estado desativado volta a atenuar por opacidade',
    ficheiro: 'public/css/styles.css',
    de: '  opacity: 1;\n  background: var(--c-disabled-bg);',
    para: '  opacity: 0.55;\n  background: var(--c-disabled-bg);',
    espera: /opacity: 1|opacity fracionária/,
  },
  {
    nome: 'Fase 3: texto desativado com contraste insuficiente (tema claro)',
    ficheiro: 'public/css/styles.css',
    de: '--c-disabled-text: #4E687D;',
    para: '--c-disabled-text: #C8D8E4;',
    espera: /desativado \(claro\)/,
  },
  {
    // ⛔ O tema escuro tinha o fundo desativado colado à superfície ativa
    // (passo de luminância 0.012): legível, mas indistinguível de um botão
    // ativo. A mutação repõe exatamente esse valor.
    nome: 'Fase 3: fundo desativado indistinguível do ativo (tema escuro)',
    ficheiro: 'public/css/styles.css',
    de: '  --c-disabled-bg: #2E5F8C;',
    para: '  --c-disabled-bg: #12395E;',
    espera: /distingue-se do ativo \(passo de luminância/,
  },
  {
    nome: 'Fase 3B: anel de foco quase da cor da página (tema claro)',
    ficheiro: 'public/css/styles.css',
    de: '--c-focus-ring: #06213F;',
    para: '--c-focus-ring: #EDF4F8;',
    espera: /anel \(claro\) sobre a página/,
  },
  {
    nome: 'Fase 3B: remover a regra de foco dos botões',
    ficheiro: 'public/css/styles.css',
    de: '.btn:focus-visible { outline: 2px solid var(--c-focus-ring); outline-offset: 2px; }\n',
    para: '',
    espera: /regra \.btn:focus-visible existe/,
  },
  {
    // ⛔ Esta mutação reproduz o defeito REAL que só o browser revelou: o
    // Bootstrap 5.3 define `.btn:focus-visible { outline: 0 }` com a mesma
    // especificidade (0,2,0) e é carregado antes desta folha, pelo que
    // declarar apenas `outline-color` deixa a largura a 0 — o anel não é
    // desenhado (medido: `outline-width: 0px; outline-style: none`).
    nome: 'Fase 3B: anel só com `outline-color` (o Bootstrap zera a largura)',
    ficheiro: 'public/css/styles.css',
    de: '.btn:focus-visible { outline: 2px solid var(--c-focus-ring); outline-offset: 2px; }',
    para: '.btn:focus-visible { outline-color: var(--c-focus-ring); outline-offset: 2px; }',
    espera: /desenha o anel com o atalho `outline` COMPLETO/,
  },
  {
    // ⛔ O comentário do token do anel claro dizia 14,98:1 quando a medição dá
    // 15,29:1. Um número documentado que não confere com o cálculo é uma
    // afirmação, não uma prova — e envelhece em silêncio quando a cor muda.
    nome: 'Fase 3B: número do comentário do anel não confere com a medição',
    ficheiro: 'public/css/styles.css',
    de: '15,29:1 sobre o fundo da pagina */',
    para: '14,98:1 sobre o fundo da pagina */',
    espera: /número do comentário do anel \(claro\)/,
  },
  {
    nome: 'Fase 4: contrato de altura com valor errado',
    ficheiro: 'public/css/styles.css',
    de: '--ctl-h: 36px;',
    para: '--ctl-h: 40px;',
    espera: /--ctl-h declarado/,
  },
  {
    nome: 'Fase 4: a "bolinha" deixa de ser circular',
    ficheiro: 'public/css/styles.css',
    de: '  border-radius: 50%;\n  color: var(--nav-text-muted);',
    para: '  border-radius: 8px;\n  color: var(--nav-text-muted);',
    espera: /circular/,
  },
  {
    nome: 'Fase 2: controlo só-ícone sem nome acessível',
    ficheiro: 'views/admin/global/condominios.handlebars',
    de: '<button aria-label="Criar condomínio"',
    para: '<button',
    espera: /sem nome acessível/,
  },
  {
    nome: 'Fase 2: ícone decorativo sem aria-hidden (polui o nome do botão)',
    ficheiro: 'views/admin/documentos/recibos.handlebars',
    de: 'me-1" aria-hidden="true"',
    para: 'me-1"',
    espera: /decorativos sem aria-hidden/,
  },
];

console.log('A7 — testes de mutação: contrato de botões, estado desativado, foco e acessibilidade');

// Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
// alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original, pelo que o órfão
// se repõe a partir dele (o `.alvo` diz em que ficheiro).
backupMut.varrerResiduos({ raiz: RAIZ, prefixo: PREFIXO });

// ── Pré-condição: sem mutação, o teste tem de PASSAR ────────────────
// Sem isto, uma mutação «detetada» podia ser apenas um teste que já falhava.
titulo('Pré-condição: o teste passa no código atual');
const inicial = correrTeste();
assert.notStrictEqual(inicial.resultado, RESULTADO.INTERROMPIDO,
  'execução interrompida na pré-condição: inconclusivo');
assert.strictEqual(inicial.resultado, RESULTADO.PASSOU,
  `${SCRIPT} já falhava ANTES de qualquer mutação — a prova por mutação seria vazia:\n`
  + inicial.saida.split('\n').slice(-15).join('\n'));
feito(`${SCRIPT} passa sem mutação (a prova tem base)`);

// ── Mutações ────────────────────────────────────────────────────────
for (const m of MUTACOES) mutacao(m);

console.log(`\n✓ ${nTestes} verificações: ${MUTACOES.length} mutações, todas detetadas pela razão certa.`);
console.log('✓ Todos os alvos restaurados byte a byte (sha256 conferido).');
