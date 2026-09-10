const { formatEUR } = require('./money');
const { formatDate, formatDateTime, toDateInput, currentYear, monthName } = require('./dates');

// Helpers Handlebars usados nas views.
module.exports = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  and: (a, b) => Boolean(a) && Boolean(b),
  or: (a, b) => Boolean(a) || Boolean(b),
  not: (a) => !a,
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
  // urlDocumento(doc, area) → rota INTERNA de acesso ao ficheiro do documento.
  // Os documentos nunca são servidos por links do fornecedor (Drive/Dropbox/
  // OneDrive): o ficheiro passa sempre pelo backend, que verifica sessão,
  // condomínio e permissões (helpers/documentos-acesso.js).
  // Devolve null quando o documento não tem ficheiro guardado (nesse caso a
  // vista pode mostrar o link externo indicado pelo administrador, se existir).
  urlDocumento: (doc, area) => {
    if (!doc || !doc.id || !doc.drive_file_id) return null;
    const base = area === 'condomino' ? '/condomino/documentos' : '/admin/documentos';
    return `${base}/${doc.id}/ficheiro`;
  },
  // urlDocumentoExterno(doc) → link externo introduzido pelo administrador
  // (apenas quando NÃO há ficheiro guardado no armazenamento do condomínio).
  urlDocumentoExterno: (doc) => {
    if (!doc || doc.drive_file_id) return null;
    return doc.url || null;
  },
  // startsPath(path, prefix) → true se o path é igual ou está dentro do prefixo
  startsPath: (path, prefix) => Boolean(path && (path === prefix || path.startsWith(prefix + '/'))),
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
