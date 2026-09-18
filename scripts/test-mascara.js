// ═══════════════════════════════════════════════════════════════════
// helpers/mascara.js — testes unitários (T7).
//
// O módulo é PURO (sem I/O, sem BD), por isso corre sem duplos de nada.
// Utilização: node scripts/test-mascara.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const m = require(path.join(RAIZ, 'helpers/mascara'));

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);
const igual = (obtido, esperado, nome) => {
  assert.strictEqual(obtido, esperado, `${nome}: esperado «${esperado}», obtido «${obtido}»`);
  feito(nome);
};

console.log('\nTestes de helpers/mascara.js (puro, sem BD)');

// ── IBAN ───────────────────────────────────────────────────────────
titulo('IBAN');
// O país fica visível (diagnóstico) e o grupo final de 4 caracteres reais
// mantém-se separado dos ocultos; o comprimento total é preservado.
igual(m.iban('PT50000201231234567890154'), 'PT50 **** **** **** **** * 0154', 'IBAN PT de 25 caracteres');
igual(m.iban('PT50 0002 0123 1234 5678 9015 4'), 'PT50 **** **** **** **** * 0154', 'IBAN PT com espaços');
igual(m.iban('pt50000201231234567890154'), 'PT50 **** **** **** **** * 0154', 'minúsculas normalizadas');
// Estrangeiro: o país continua visível e os últimos 4 mantêm-se.
igual(m.iban('DE89370400440532013000'), 'DE89 **** **** **** ** 3000', 'IBAN estrangeiro (DE, 22)');
igual(m.iban('ES9121000418450200051332'), 'ES91 **** **** **** **** 1332', 'IBAN estrangeiro (ES, 24)');
igual(m.iban(''), '—', 'IBAN vazio → ausente');
igual(m.iban(null), '—', 'IBAN null → ausente');
igual(m.iban(undefined), '—', 'IBAN undefined → ausente');
igual(m.iban('   '), '—', 'IBAN só espaços → ausente');
// Inválido / irreconhecível.
igual(m.iban('ABC'), '***', 'IBAN inválido (curto, sem forma) → ***');
igual(m.iban('1234567890'), '***', 'IBAN sem código de país → ***');
igual(m.iban('texto livre'), '***', 'IBAN texto livre → ***');
// Nunca mostra o corpo completo.
assert.ok(!m.iban('PT50000201231234567890154').includes('0002'), 'IBAN: o início do corpo nunca aparece');
assert.ok(!m.iban('PT50000201231234567890154').includes('1234'), 'IBAN: o miolo do corpo nunca aparece');
feito('IBAN: corpo intermédio nunca é revelado');

// ── NIF ────────────────────────────────────────────────────────────
titulo('NIF');
igual(m.nif('123456789'), '123***789', 'NIF canónico 123456789');
igual(m.nif('123 456 789'), '123***789', 'NIF formatado com espaços');
igual(m.nif('123.456.789'), '123***789', 'NIF com pontos');
igual(m.nif(''), '—', 'NIF vazio → ausente');
igual(m.nif(null), '—', 'NIF null → ausente');
igual(m.nif('12345678'), '***', 'NIF com 8 dígitos → ***');
igual(m.nif('1234567890'), '***', 'NIF com 10 dígitos → ***');
igual(m.nif('abcdefghi'), '***', 'NIF não numérico → ***');
igual(m.nif('12345678a'), '***', 'NIF alfanumérico → ***');

// Um NIF inválido mas com 9 dígitos continua a ser mascarado como NIF — o
// dígito de controlo errado é precisamente o problema que se quer VER.
igual(m.nif('000000000'), '000***000', 'NIF com 9 dígitos mantém a forma (mesmo inválido)');
feito('NIF: 9 dígitos é mascarado na forma canónica, o resto falha fechado');

// ── E-mail ─────────────────────────────────────────────────────────
titulo('E-mail');
igual(m.email('maria@dominio.pt'), 'm***@dominio.pt', 'e-mail simples');
igual(m.email('maria.silva@dominio.pt'), 'm***@dominio.pt', 'e-mail com pontos na parte local');
igual(m.email('  ana@exemplo.com  '), 'a***@exemplo.com', 'e-mail com espaços à volta');
igual(m.email('j@a.b'), 'j***@a.b', 'e-mail curto (parte local de 1 caractere)');
igual(m.email(''), '—', 'e-mail vazio → ausente');
igual(m.email(null), '—', 'e-mail null → ausente');
igual(m.email('semarroba'), '***', 'e-mail sem @ → ***');
igual(m.email('a@b'), '***', 'e-mail com domínio sem ponto → ***');
igual(m.email('a@b@c.pt'), '***', 'e-mail com dois @ → ***');
igual(m.email('@dominio.pt'), '***', 'e-mail sem parte local → ***');
igual(m.email('maria@'), '***', 'e-mail sem domínio → ***');
// O domínio mantém-se SEMPRE visível (é o que interessa para diagnóstico).
assert.ok(m.email('maria@condominio.pt').endsWith('@condominio.pt'), 'e-mail: domínio preservado');
feito('e-mail: domínio visível, parte local reduzida à inicial');

// ── Telefone ───────────────────────────────────────────────────────
titulo('Telefone');
igual(m.telefone('912 345 678'), '*** *** 678', 'telefone PT com espaços');
igual(m.telefone('+351 912 345 678'), '*** *** *** 678', 'telefone com indicativo');
igual(m.telefone('912345678'), '*** *** 678', 'telefone sem separadores');
igual(m.telefone('+351912345678'), '*** *** *** 678', 'telefone com + e sem espaços');
igual(m.telefone('(912) 345-678'), '*** *** 678', 'telefone com parênteses e hífen');
igual(m.telefone(''), '—', 'telefone vazio → ausente');
igual(m.telefone(null), '—', 'telefone null → ausente');
igual(m.telefone('sem telefone'), '***', 'texto livre sem dígitos → ***');
igual(m.telefone('abc'), '***', 'texto livre sem dígitos (curto) → ***');
igual(m.telefone('12'), '***', '2 dígitos → *** (curto demais)');
igual(m.telefone('123'), '***', '3 dígitos → *** (curto demais)');
igual(m.telefone('1234'), '*** 234', '4 dígitos → últimos 3 visíveis');
igual(m.telefone('  '), '—', 'telefone só espaços → ausente');
// Os primeiros dígitos nunca aparecem.
assert.ok(!m.telefone('912345678').includes('912'), 'telefone: o prefixo nunca é revelado');
feito('telefone: só os últimos 3 dígitos ficam visíveis');

// ── Propriedades transversais ──────────────────────────────────────
titulo('Propriedades transversais');
// Determinismo: a mesma entrada devolve sempre a mesma saída.
for (const [fn, valor] of [[m.iban, 'PT50000201231234567890154'], [m.nif, '123456789'], [m.email, 'maria@dominio.pt'], [m.telefone, '912 345 678']]) {
  assert.strictEqual(fn(valor), fn(valor), 'determinístico');
}
feito('todas as máscaras são determinísticas');

// Nunca lança, seja qual for a entrada.
const entradas = [null, undefined, '', 0, 1, 12345, true, false, {}, [], [1, 2], () => {}, NaN, Infinity, 'x'.repeat(500), '💥'];
for (const e of entradas) {
  for (const [nome, fn] of [['iban', m.iban], ['nif', m.nif], ['email', m.email], ['telefone', m.telefone]]) {
    let r;
    assert.doesNotThrow(() => { r = fn(e); }, `${nome} não pode lançar para ${JSON.stringify(e)}`);
    assert.strictEqual(typeof r, 'string', `${nome} devolve sempre string`);
    assert.ok(r.length > 0 || r === '', `${nome} devolve sempre texto imprimível`);
  }
}
feito('nenhuma máscara lança e todas devolvem texto');

// `ausente()` distingue «sem dado» de «mascarado».
assert.ok(m.ausente('') && m.ausente(null) && m.ausente(undefined) && m.ausente('  '), 'ausente() reconhece vazio');
assert.ok(!m.ausente('x') && !m.ausente(0), 'ausente() não considera «x» nem 0 como ausentes');
feito('ausente() separa «sem dado» de «mascarado»');

// Um valor ausente devolve SEMPRE o marcador de ausência (não `***`): a vista
// precisa de distinguir «não há telefone» de «há telefone mas não é legível».
for (const fn of [m.iban, m.nif, m.email, m.telefone]) {
  assert.strictEqual(fn(''), m.VAZIO, 'ausente devolve VAZIO');
  assert.strictEqual(fn(null), m.VAZIO, 'null devolve VAZIO');
  assert.notStrictEqual(fn('valor plausível'), m.VAZIO, 'valor presente não é VAZIO');
}
feito('ausente → «—», presente → mascarado ou «***»');

console.log(`\n✓ Testes de helpers/mascara.js passaram (${n} verificações, sem BD).`);
