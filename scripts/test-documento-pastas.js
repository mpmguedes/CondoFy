// Testes das pastas da biblioteca de documentos (base + personalizadas).
// Utilização: node scripts/test-documento-pastas.js
const assert = require('assert');
const { PASTAS_BASE, pastasPersonalizadas, mapaPastas, novaKey, resolverPastaDocumento } = require('../helpers/documento-pastas');

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

const VALIDAS = Object.keys(PASTAS_BASE);

function testarResolvedorPasta() {
  // Sem escolha → pasta por tipo.
  assert.strictEqual(resolverPastaDocumento({ tipo: 'recibo', pastasValidas: VALIDAS }).pasta, 'recibos', 'recibo sem escolha → recibos');
  assert.strictEqual(resolverPastaDocumento({ tipo: 'ata', pastasValidas: VALIDAS }).pasta, 'atas', 'ata sem escolha → atas');
  assert.strictEqual(resolverPastaDocumento({ tipo: 'convocatoria', pastasValidas: VALIDAS }).pasta, 'convocatorias', 'convocatória sem escolha → convocatorias');
  assert.strictEqual(resolverPastaDocumento({ tipo: 'aviso_quota', pastasValidas: VALIDAS }).pasta, 'outros', 'aviso de quota → outros');

  // Escolha válida e compatível é respeitada.
  let d = resolverPastaDocumento({ tipo: 'recibo', pastaEscolhida: 'recibos', pastasValidas: VALIDAS });
  assert.deepStrictEqual(d, { pasta: 'recibos', corrigida: false }, 'recibo em recibos mantém-se');
  // "outros" aceita qualquer tipo.
  d = resolverPastaDocumento({ tipo: 'fatura', pastaEscolhida: 'outros', pastasValidas: VALIDAS });
  assert.deepStrictEqual(d, { pasta: 'outros', corrigida: false }, 'outros é catch-all');
  // Atas/convocatórias podem viver em assembleias.
  assert.strictEqual(resolverPastaDocumento({ tipo: 'ata', pastaEscolhida: 'assembleias', pastasValidas: VALIDAS }).pasta, 'assembleias', 'ata em assembleias compatível');

  // Escolha incompatível → correção automática previsível.
  d = resolverPastaDocumento({ tipo: 'recibo', pastaEscolhida: 'contratos', pastasValidas: VALIDAS });
  assert.strictEqual(d.pasta, 'recibos', 'recibo em contratos é corrigido para recibos');
  assert.strictEqual(d.corrigida, true, 'marca correção automática');

  // Tipo "outro" respeita qualquer pasta válida.
  assert.strictEqual(resolverPastaDocumento({ tipo: 'outro', pastaEscolhida: 'contratos', pastasValidas: VALIDAS }).pasta, 'contratos', 'outro respeita escolha');

  // Escolha inválida/inexistente → pasta do tipo.
  assert.strictEqual(resolverPastaDocumento({ tipo: 'recibo', pastaEscolhida: 'antiga', pastasValidas: VALIDAS }).pasta, 'recibos', 'pasta antiga/inválida é substituída');

  // Pasta personalizada válida é mantida (passe nas validadas).
  d = resolverPastaDocumento({ tipo: 'outro', pastaEscolhida: 'c-obras', pastasValidas: [...VALIDAS, 'c-obras'] });
  assert.deepStrictEqual(d, { pasta: 'c-obras', corrigida: false }, 'pasta personalizada mantém-se');
}

testarBase();
testarPersonalizadas();
testarNovaKey();
testarResolvedorPasta();
console.log('✓ Testes das pastas de documentos passaram (sem base de dados).');
