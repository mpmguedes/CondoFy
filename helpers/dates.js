// Utilitários de datas em formato PT-PT.

const MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// DD/MM/YYYY
function formatDate(value) {
  const d = asDate(value);
  if (!d) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getFullYear()}`;
}

// DD/MM/YYYY HH:MM
function formatDateTime(value) {
  const d = asDate(value);
  if (!d) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)} ${hh}:${mm}`;
}

// YYYY-MM-DD (para campos <input type="date">)
function toDateInput(value) {
  const d = asDate(value);
  if (!d) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function currentYear() {
  return new Date().getFullYear();
}

function monthName(mes) {
  const idx = Number(mes);
  return MESES[idx - 1] || String(mes);
}

module.exports = { formatDate, formatDateTime, toDateInput, currentYear, monthName, MESES };
