const { toNumber, fromCents } = require('./money');

// Calcula o valor de uma quota a partir da permilagem da fração.
// - valorPermilagem: valor em euros por cada 1‰ (ex.: 0.1000 € → 0,10 € por ‰)
// - fcrPercentagem: percentagem do Fundo Comum de Reserva (ex.: 10)
// Fórmula:
//   base  = permilagem × valorPorPermilagem
//   fcr   = base × fcrPercentagem / 100
//   total = base + fcr
function calcularQuota(permilagem, valorPermilagem, fcrPercentagem = 0) {
  const perm = parseFloat(String(permilagem).replace(',', '.')) || 0;
  const valorPorPermilagemC = Math.round(toNumber(valorPermilagem) * 100); // cêntimos por ‰
  const baseC = Math.round(perm * valorPorPermilagemC);
  const fcrC = Math.round((baseC * (parseFloat(fcrPercentagem) || 0)) / 100);
  const totalC = baseC + fcrC;

  return {
    baseC,
    fcrC,
    totalC,
    base: fromCents(baseC),
    fcr: fromCents(fcrC),
    total: fromCents(totalC),
  };
}

// Divide um total em euros por n frações em partes iguais (sem perdas de cêntimos).
// Devolve um array com os valores em euros, soma === total.
function dividirIgual(total, n) {
  const { toCents } = require('./money');
  const totalC = toCents(total);
  const base = Math.floor(totalC / n);
  let resto = totalC - base * n;
  const partes = new Array(n).fill(base);
  for (let i = 0; i < resto; i++) partes[i] += 1;
  return partes.map((c) => fromCents(c));
}

module.exports = { calcularQuota, dividirIgual };
