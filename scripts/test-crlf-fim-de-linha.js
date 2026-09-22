// ═══════════════════════════════════════════════════════════════════
// T-P38 — prova de que as regexes com `\n` literal eram FRÁGEIS e de que a
// normalização do fim-de-linha na leitura as torna independentes do clone.
//
// A dívida (P38): várias suítes comparam CÓDIGO-FONTE com `\n` literal — por
// exemplo `/MovimentoBancario,\n\} = require\('\.\.\/models'\)/` exige um `\n`
// IMEDIATAMENTE a seguir à vírgula. Com LF no disco passa; com CRLF — um
// checkout feito com `core.autocrlf=true` — o `\r` a mais faz a regex não casar
// e a suíte acusa uma regressão que não existe.
//
// Esta suíte prova as duas metades, para cada par (padrão, ficheiro-fonte):
//   · o padrão TAL COMO ESTÁ na suíte não casa com o conteúdo em CRLF — a
//     fragilidade é real e observável, não teórica;
//   · o mesmo padrão casa com o conteúdo NORMALIZADO, que é exatamente o que as
//     suítes passam a fazer na leitura (`ler`/`lerCss` com `.replace(/\r\n/g,'\n')`).
//
// E verifica o encadeamento: cada suíte tem de continuar a normalizar, senão o
// defeito volta em silêncio.
//
// ⛔ Não escreve NADA no disco: a conversão para CRLF é feita EM MEMÓRIA sobre
//    o conteúdo real. Escrever CRLF num ficheiro que outra frente está a editar
//    seria um risco desnecessário — e a P53 mostra como um harness pode morrer
//    a meio e deixar o alvo alterado.
//
// Utilização: node scripts/test-crlf-fim-de-linha.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const lerReal = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const paraCRLF = (s) => s.replace(/\n/g, '\r\n');
const paraLF = (s) => s.replace(/\r\n/g, '\n');

let n = 0;
const ok = (t) => { n += 1; console.log(`  ✓ ${t}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// ── A. Os padrões que as suítes usam, e a fonte a que se aplicam ────
// `padrao.toString()` tem de aparecer VERBATIM no ficheiro da suíte: se alguém
// mudar a regex, esta prova falha em vez de continuar a testar uma versão que
// já não existe em lado nenhum.
const CASOS = [
  {
    suite: 'scripts/test-movimentos-integridade.js',
    fonte: 'helpers/movimentos.js',
    padrao: /condominioId,\n/g,
    nota: 'contagem das duas pontas da transferência que recebem condominioId',
  },
  {
    suite: 'scripts/test-movimentos-integridade.js',
    fonte: 'helpers/fcr.js',
    padrao: /await registarTransferencia\(\{[\s\S]*?\n    \}\);/g,
    nota: 'bloco da chamada a registarTransferencia no FCR',
  },
  {
    suite: 'scripts/test-movimentos-integridade.js',
    fonte: 'routes/financeiro.js',
    padrao: /MovimentoBancario,\n\} = require\('\.\.\/models'\)/,
    nota: 'importação de MovimentoBancario na rota',
  },
  {
    suite: 'scripts/test-movimentos-integridade.js',
    fonte: 'helpers/fcr.js',
    padrao: /estado: 'confirmado',\s*\n\s*condominio_id: condominioId,/,
    nota: 'filtro de pagamentos confirmados do condomínio',
  },
  {
    suite: 'scripts/test-autorizacao-arquitetura.js',
    fonte: 'helpers/suporte-allowlist.js',
    padrao: /const ROUTERS = \{([\s\S]*?)\n\};/,
    nota: 'mapa ROUTERS da allow-list',
  },
];

// Um padrão é FRÁGIL quando deixa de casar só por o `\r` estar lá. Alguns dos
// `\n` são, na prática, absorvidos por `[\s\S]*?` ou `\s*` — esses são
// «incidentalmente seguros». Reportam-se como tal, em vez de se fingir que
// todos partiam.
const frageis = [];
const seguros = [];

for (const caso of CASOS) {
  titulo(`${caso.fonte} — ${caso.nota}`);
  const fonteSuite = lerReal(caso.suite);
  assert.ok(fonteSuite.includes(caso.padrao.toString()),
    `o padrão ${caso.padrao} já não existe em ${caso.suite} — atualizar esta prova`);
  ok(`o padrão continua a ser o usado em ${path.basename(caso.suite)}`);

  const lf = lerReal(caso.fonte);
  assert.ok(caso.padrao.test(lf), `${caso.fonte}: o padrão não casa com o conteúdo em LF (baseline)`);
  ok(`casa com o conteúdo em LF (baseline, ${path.basename(caso.fonte)})`);

  // O `\r` a mais tem de fazer a diferença — senão não havia dívida a resolver.
  const crlf = paraCRLF(lf);
  if (caso.padrao.test(crlf)) {
    seguros.push(`${caso.fonte} → ${caso.padrao}`);
    ok('também casa em CRLF (incidentalmente seguro: o `\\n` é absorvido por `[\\s\\S]*?`/`\\s*`)');
  } else {
    frageis.push(`${caso.fonte} → ${caso.padrao}`);
    ok('NÃO casa em CRLF — a fragilidade é real');
    assert.ok(caso.padrao.test(paraLF(crlf)),
      `${caso.fonte}: a normalização para LF tinha de repor o casamento`);
    ok('a normalização para LF repõe o casamento (é o que a suíte passa a fazer)');
  }
}

// ── B. O encadeamento: as suítes normalizam na LEITURA ─────────────
// Sem isto, a prova acima seria sobre um mecanismo que ninguém usa.
titulo('Encadeamento: normalização na leitura');
const NORMALIZACOES = [
  {
    ficheiro: 'scripts/test-autorizacao-arquitetura.js',
    ancora: "const ler = (rel) => require('fs').readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\\r\\n/g, '\\n');",
  },
  {
    ficheiro: 'scripts/test-contraste.js',
    ancora: "const lerCss = (nome) => fs.readFileSync(path.join(RAIZ, 'public', 'css', nome), 'utf8').replace(/\\r\\n/g, '\\n');",
  },
  {
    ficheiro: 'scripts/test-movimentos-integridade.js',
    ancora: "const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\\r\\n/g, '\\n');",
  },
];
for (const { ficheiro, ancora } of NORMALIZACOES) {
  const fonte = lerReal(ficheiro);
  const ocorrencias = fonte.split(ancora).length - 1;
  assert.strictEqual(ocorrencias, 1,
    `${ficheiro}: a normalização do fim-de-linha tem de existir exatamente 1× (encontrada ${ocorrencias}×)`);
  ok(`${path.basename(ficheiro)} lê com normalização CRLF→LF`);
}

// ── C. A exceção, verificada em vez de afirmada ────────────────────
// `test-documentos-acesso.js` foi listado na auditoria, mas não tem regex de
// `\n` sobre código-fonte: os `\r\n` que lá estão são DADOS de teste (fixtures
// que provam a recusa de CRLF em cabeçalhos). Aqui prova-se que nenhum `\n`
// literal escapa desses dois usos.
titulo('Exceção verificada: test-documentos-acesso.js');
const fonteDocAcesso = lerReal('scripts/test-documentos-acesso.js');
const semFixtures = fonteDocAcesso
  .replace(/\\r\\n/g, '')     // dados de teste com CRLF (fixtures)
  .replace(/\[\\r\\n\]/g, ''); // classes de caracteres `[\r\n]` (a recusa)
assert.ok(!/\\n/.test(semFixtures),
  'test-documentos-acesso.js: apareceu um `\\n` literal fora de `\\r\\n`/`[\\r\\n]` — verificar se é regex sobre código-fonte');
ok('todos os `\\n` do ficheiro são `\\r\\n` de fixture ou a classe `[\\r\\n]`');

// ── D. Não vacuidade ───────────────────────────────────────────────
// Se nenhum padrão fosse frágil, esta prova não estaria a provar nada e a
// dívida P38 seria uma invenção da auditoria.
titulo('Não vacuidade');
assert.ok(frageis.length >= 1,
  `nenhum padrão se mostrou frágil em CRLF — rever a dívida P38 (${CASOS.length} padrões analisados)`);
ok(`${frageis.length} padrão(ões) FRÁGIL(EIS) em CRLF, ${seguros.length} incidentalmente seguro(s)`);
for (const f of frageis) console.log(`      · frágil: ${f}`);
for (const s of seguros) console.log(`      · seguro: ${s}`);

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log(` ✓ P38 — ${n} verificações passaram. A fragilidade em CRLF é real e a`);
console.log('   normalização na leitura resolve-a (nada foi escrito no disco).');
console.log('═══════════════════════════════════════════════════════════════');
