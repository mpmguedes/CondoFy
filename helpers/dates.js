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

// Data local segura (evita desvio de dia em strings YYYY-MM-DD por causa do fuso).
function asDateLocal(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

const DIAS_SEMANA = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

// "Terça-feira"
function diaSemana(value) {
  const d = asDateLocal(value);
  return d ? DIAS_SEMANA[d.getDay()] : '';
}

// "15 de março de 2026"
function formatDateExtenso(value) {
  const d = asDateLocal(value);
  if (!d) return '';
  return `${d.getDate()} de ${MESES[d.getMonth()].toLowerCase()} de ${d.getFullYear()}`;
}

module.exports = {
  formatDate,
  formatDateTime,
  toDateInput,
  currentYear,
  monthName,
  MESES,
  diaSemana,
  formatDateExtenso,
};
