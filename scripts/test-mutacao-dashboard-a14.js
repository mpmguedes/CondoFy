// ══════════════════════════════════════════════════════════════════════
// A14 §9 — prova por mutação da SEPARAÇÃO entre «Precisa de atenção» e
// «Preparação do condomínio».
//
// A invariante: «ainda não configurou X» NUNCA é apresentado como um problema,
// e um problema real nunca é apresentado como falta de configuração. Quebra-se
// o código de propósito e exige-se que o oráculo FALHE pela razão certa.
//
// ⛔ Cada mutação é SINTATICAMENTE VÁLIDA: uma mutação que parte o Handlebars
//    (ou o JS) faz o teste falhar por 500/parse — isso é infraestrutura, não é
//    a invariante, e não prova nada.
//
// Utilização: node scripts/test-mutacao-dashboard-a14.js
// ⛔ Nunca em paralelo com outros `test-mutacao-*` (partilham a convenção de
//    cópias de segurança na raiz).
// ══════════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..');
// Helper DISCRIMINANTE: distingue «o teste falhou» de «o teste não chegou a
// correr» (EBUSY do host no spawn). Sem ele, uma falha de infraestrutura era
// lida como «mutação detetada».
const proc = require('./helpers/correr-processo');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const escrever = (rel, txt) => fs.writeFileSync(path.join(RAIZ, rel), txt);

function correrOraculo(script) {
  const r = proc.executarOuFalhar(process.execPath, [path.join(RAIZ, 'scripts', script)], {
    cwd: RAIZ, timeout: 180000,
  });
  return { passou: r.estado === proc.ESTADO.PASSOU, saida: r.saida || '' };
}

const MUTACOES = [
  {
    // O orçamento por concluir é PREPARAÇÃO. Passá-lo para «atenção» é
    // exatamente a mistura que o A14 §9 proíbe.
    nome: 'o orçamento por concluir passa a ser apresentado como problema',
    ficheiro: 'helpers/dashboard.js',
    de: "      // O orçamento do ano por concluir é PREPARAÇÃO, não um problema\n"
      + "      // (decisão de 2026-09-24): falta fechar o ano, não há nada errado.\n"
      + "      categoria: 'preparacao',",
    para: "      categoria: 'atencao',",
    oraculo: 'test-dashboard-painel.js',
    espera: /categoria «preparação»|categoria «preparacao»|orçamento por concluir é PREPARAÇÃO/,
  },
  {
    // `separarSinais` é o ÚNICO sítio que conhece as duas listas. Se deixar de
    // separar, a preparação desaparece e tudo vai para a atenção.
    nome: '`separarSinais` deixa de separar (tudo vai para a atenção)',
    ficheiro: 'helpers/dashboard.js',
    de: "    if (s.categoria === 'preparacao') preparacao.push(s);\n    else atencao.push(s);",
    para: '    atencao.push(s);',
    oraculo: 'test-dashboard-painel.js',
    espera: /a atenção fica vazia|os três sinais de preparação/,
  },
  {
    // A vista volta ao comportamento antigo: a lista de ATENÇÃO percorre o
    // CONJUNTO dos sinais, o que mete «Orçamento em rascunho» ao lado de
    // «quotas em atraso».
    nome: 'a lista de atenção volta a percorrer todos os sinais (mistura)',
    ficheiro: 'views/admin/dashboard.handlebars',
    de: '{{#each sinaisAtencao}}',
    para: '{{#each sinais}}',
    oraculo: 'test-rotas-admin-dashboard.js',
    espera: /NÃO está na atenção|não entra na lista de sinais/,
  },
  {
    // Simétrica: a PREPARAÇÃO passa a percorrer o conjunto, e um problema real
    // aparece como «falta de configuração».
    nome: 'a lista de preparação passa a percorrer todos os sinais (mistura)',
    ficheiro: 'views/admin/dashboard.handlebars',
    de: '{{#each sinaisPreparacao}}',
    para: '{{#each sinais}}',
    oraculo: 'test-rotas-admin-dashboard.js',
    espera: /NÃO está na preparação/,
  },
];

// ── Salvaguarda de TODOS os alvos ANTES de mutar ─────────────────────
// Um harness morto a meio deixa o alvo mutado; com as cópias feitas aqui há
// sempre como repor e conferir por hash.
const salvaguarda = new Map();
for (const m of MUTACOES) {
  if (salvaguarda.has(m.ficheiro)) continue;
  const texto = ler(m.ficheiro);
  salvaguarda.set(m.ficheiro, { texto, hash: hash(texto) });
}

console.log('A14 §9 — mutações da separação atenção / preparação');

// Pré-condição: os dois oráculos passam ANTES de qualquer mutação.
for (const script of [...new Set(MUTACOES.map((m) => m.oraculo))]) {
  const antes = correrOraculo(script);
  assert.ok(antes.passou, `${script} já falhava ANTES das mutações\n${antes.saida.slice(-800)}`);
  console.log(`  ✓ pré-condição: ${script} passa sem mutação`);
}

let detetadas = 0;
for (const m of MUTACOES) {
  const original = salvaguarda.get(m.ficheiro);
  try {
    // ⛔ Âncora ÚNICA: uma âncora que aparece mais do que uma vez não prova
    //    nada (podia estar a mutar outra ocorrência).
    const ocorrencias = original.texto.split(m.de).length - 1;
    assert.strictEqual(ocorrencias, 1,
      `mutação impossível: a âncora aparece ${ocorrencias}× em ${m.ficheiro}`);
    escrever(m.ficheiro, original.texto.replace(m.de, m.para));

    const r = correrOraculo(m.oraculo);
    assert.ok(!r.passou, `mutação NÃO detetada: «${m.nome}» — ${m.oraculo} continuou a passar`);
    assert.ok(m.espera.test(r.saida),
      `detetada pela razão ERRADA: esperava ${m.espera}\n${r.saida.slice(-900)}`);
    detetadas += 1;
    console.log(`  ✓ «${m.nome}» → ${m.oraculo} FALHA pela razão certa (${m.espera})`);
  } finally {
    const rec = salvaguarda.get(m.ficheiro);
    escrever(m.ficheiro, rec.texto);
    assert.strictEqual(hash(ler(m.ficheiro)), rec.hash,
      `restauro de ${m.ficheiro} não ficou byte a byte`);
  }
}

// Todos os alvos repostos: prova final, fora do `finally`.
for (const [f, rec] of salvaguarda) {
  assert.strictEqual(hash(ler(f)), rec.hash, `${f} ficou alterado`);
}
console.log(`\n✓ ${detetadas}/${MUTACOES.length} mutações detetadas pela razão certa.`);
console.log(`✓ ${salvaguarda.size} alvos restaurados byte a byte (sha256 conferido).`);
