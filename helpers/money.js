// Utilitários monetários (EUR).
// Valores na base de dados são DECIMAL; o driver mysql2 devolve-os como string
// (ex.: "1234.56"). Trabalhamos internamente em cêntimos para evitar erros de
// vírgula flutuante.

function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  const str = String(value).replace(/€/g, '').trim();
  // Aceita "1.234,56" (pt) e "1234.56" (en/BD)
  const normalized = str.includes(',')
    ? str.replace(/\./g, '').replace(',', '.')
    : str;
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fromCents(cents) {
  return (cents || 0) / 100;
}

function toNumber(value) {
  return fromCents(toCents(value));
}

// Formato PT-PT: 1.234,56 €
function formatEUR(value) {
  const cents = toCents(value);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const eur = Math.floor(abs / 100);
  const cent = String(abs % 100).padStart(2, '0');
  const eurStr = String(eur).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${eurStr},${cent} €`;
}

// Aceita input do formulário ("1234,56" ou "1234.56") e devolve valor em cêntimos
function parseInputToCents(value) {
  return toCents(value);
}

module.exports = { toCents, fromCents, toNumber, formatEUR, parseInputToCents };
