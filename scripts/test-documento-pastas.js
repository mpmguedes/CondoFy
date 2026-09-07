// Testes das pastas da biblioteca de documentos (base + personalizadas).
// Utilização: node scripts/test-documento-pastas.js
const assert = require('assert');
const { PASTAS_BASE, pastasPersonalizadas, mapaPastas, novaKey } = require('../helpers/documento-pastas');

function testarBase() {
  assert.ok(PASTAS_BASE.outros === 'Outros', 'pasta Outros existe na base');
  const semCustom = mapaPastas(null);
  assert.ok(semCustom.outros, 'mapa sem personalizadas inclui Outros');
  assert.ok(semCustom.atas === 'Atas', 'mapa inclui pastas base');
}

function testarPersonalizadas() {
  const cond = { documento_pastas: JSON.stringify([
    { key: 'c-licencas', nome: 'Licenças' },
    { key: '', nome: 'Inválida' },
    { key: 'c-x', nome: '' },
    'lixo',
  ]) };
  const lista = pastasPersonalizadas(cond);
  assert.deepStrictEqual(lista, [{ key: 'c-licencas', nome: 'Licenças' }], 'filtra entradas inválidas');

  const mapa = mapaPastas(cond);
  assert.strictEqual(mapa['c-licencas'], 'Licenças', 'personalizada no mapa');
  assert.ok(mapa.outros, 'Outros mantém-se com personalizadas');

  assert.deepStrictEqual(pastasPersonalizadas({ documento_pastas: 'não-json' }), [], 'JSON inválido → vazio');
  assert.deepStrictEqual(pastasPersonalizadas({}), [], 'sem coluna → vazio');
}

function testarNovaKey() {
  const existentes = new Set(Object.keys(mapaPastas(null)));
  const k1 = novaKey('Garagem', existentes);
  assert.ok(k1.startsWith('c-garagem'), 'key com prefixo c-');
  assert.ok(!existentes.has(k1), 'key nova não colide');

  // Colisão resolve com sufixo.
  const colide = new Set(['c-licencas']);
  const a = novaKey('Licenças', colide);
  colide.add(a);
  const b = novaKey('Licenças', colide);
  assert.notStrictEqual(a, b, 'colisão gera key distinta');
  assert.ok(a.startsWith('c-licencas'), 'slug preservado');
}

testarBase();
testarPersonalizadas();
testarNovaKey();
console.log('✓ Testes das pastas de documentos passaram (sem base de dados).');
