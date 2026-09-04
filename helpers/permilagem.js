const { toNumber } = require('./money');

// Soma a permilagem de um conjunto de frações.
function somaPermilagem(fracoes) {
  return fracoes.reduce((s, f) => s + (toNumber(f.permilagem) || 0), 0);
}

// Devolve { total, diff, ok } — ok quando a soma é 1000‰.
function validarPermilagem(fracoes) {
  const total = somaPermilagem(fracoes);
  return { total, diff: 1000 - total, ok: Math.abs(total - 1000) < 0.01 };
}

module.exports = { somaPermilagem, validarPermilagem };
