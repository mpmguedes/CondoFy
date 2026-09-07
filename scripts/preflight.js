// Pré-verificação das migrações (ordem, duplicados) e das suites — sem BD.
// Utilização: node scripts/preflight.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'migrations');

function main() {
  const ficheiros = fs
    .readdirSync(dir)
    .filter((f) => /^\d{14}-.*\.js$/.test(f))
    .sort();
  if (!ficheiros.length) {
    console.error('✗ Não foram encontradas migrações (formato esperado YYYYMMDDHHmmss-nome.js).');
    process.exit(1);
  }

  const ids = ficheiros.map((f) => f.slice(0, 14));
  const unicos = new Set(ids);
  if (unicos.size !== ids.length) {
    console.error('✗ Há migrações com o mesmo identificador de data/hora.');
    process.exit(1);
  }

  console.log(`✓ ${ficheiros.length} migrações em ordem sequencial:`);
  ficheiros.forEach((f) => console.log('   ' + f));

  // Carrega cada migração (up/down) para confirmar que são módulos válidos
  // (não há efeitos laterais: o ficheiro apenas exporta { up, down }).
  for (const f of ficheiros) {
    const mod = require(path.join(dir, f));
    if (typeof mod.up !== 'function' || typeof mod.down !== 'function') {
      console.error(`✗ ${f}: esperado export { up, down }.`);
      process.exit(1);
    }
  }
  console.log('✓ Migrações carregam e exportam up/down corretamente.');
  console.log('Próximo passo no servidor com BD: npm run db:migrate (ver docs/DEPLOY-MULTITENANT.md).');
}

main();
