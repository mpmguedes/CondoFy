const { formatEUR } = require('./money');
const { formatDate, formatDateTime, toDateInput, currentYear, monthName } = require('./dates');

// Helpers Handlebars usados nas views.
module.exports = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  and: (a, b) => Boolean(a) && Boolean(b),
  or: (a, b) => Boolean(a) || Boolean(b),
  gt: (a, b) => Number(a) > Number(b),
  lt: (a, b) => Number(a) < Number(b),
  inc: (n) => Number(n) + 1,
  formatDate: (v) => formatDate(v),
  formatDateTime: (v) => formatDateTime(v),
  dateInput: (v) => toDateInput(v),
  eur: (v) => formatEUR(v),
  monthName: (m) => monthName(m),
  currentYear: () => currentYear(),
  currentMonth: () => new Date().getMonth() + 1,
  json: (obj) => JSON.stringify(obj),
  // selected(option, current) → 'selected' se iguais
  selected: (a, b) => (String(a) === String(b) ? 'selected' : ''),
  // checked(a) → 'checked' se verdadeiro
  checked: (a) => (a ? 'checked' : ''),
  // isActive(path, prefix) → 'active' se o path atual pertence a esse item
  isActive: (path, prefix) => (path === prefix || (path && path.startsWith(prefix + '/'))) ? 'active' : '',
  // saudacao() → cumprimento conforme a hora do dia
  saudacao: () => {
    const h = new Date().getHours();
    if (h < 12) return 'Bom dia';
    if (h < 19) return 'Boa tarde';
    return 'Boa noite';
  },
  // iniciais(nome) → iniciais para avatar
  iniciais: (nome) =>
    nome
      ? nome
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .map((p) => p[0])
          .join('')
          .toUpperCase()
      : '?',
};
