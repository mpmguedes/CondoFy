// Testes do StorageProvider (fachada de armazenamento) — sem rede/BD.
// Utilização: node scripts/test-storage.js
const assert = require('assert');
const storage = require('../helpers/storage');

function testarProvedor() {
  assert.strictEqual(storage.nome(), 'google_drive', 'provedor por omissão google_drive');
  assert.strictEqual(typeof storage.isConfigured(), 'boolean', 'isConfigured devolve booleano');

  // Provedor desconhecido cai para o default (google_drive).
  const ant = process.env.STORAGE_PROVIDER;
  process.env.STORAGE_PROVIDER = 'falso_provedor';
  try {
    assert.strictEqual(storage.nome(), 'google_drive', 'provedor desconhecido → default');
  } finally {
    if (ant === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = ant;
  }

  // Interface esperada.
  for (const fn of ['uploadArquivo', 'pastaParaDocumento', 'pastaParaFornecedor', 'descargarArquivo', 'estadoLigacao', 'testarLigacao', 'criarEstruturaPastas', 'obterPastaCondominioId', 'linkPastaDrive']) {
    assert.strictEqual(typeof storage[fn], 'function', `método ${fn} disponível`);
  }
}

testarProvedor();
console.log('✓ Testes do StorageProvider passaram (sem rede).');
