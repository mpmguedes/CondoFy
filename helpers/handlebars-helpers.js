const { formatEUR } = require('./money');
const { formatDate, formatDateTime, toDateInput, currentYear, monthName, diaSemana } = require('./dates');
const { urlExternaSegura } = require('./urls');
const mascara = require('./mascara');

// bytes(v) → '1,8 GB' | '850 MB' | '—'.
// Usado pelas áreas de armazenamento/backups (a única forma de apresentar um
// tamanho: as vistas não fazem contas). Devolve '—' quando não há valor — nunca
// «0 B» para um dado ausente, que se leria como «vazio».
function formatBytes(valor) {
  const n = Number(valor);
  if (valor === null || valor === undefined || valor === '' || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  const UNIDADES = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < UNIDADES.length - 1) {
    x /= 1024;
    i += 1;
  }
  // Sem decimais nos bytes e nos valores ≥ 100 (evita «999,9 KB»).
  const casas = i === 0 || x >= 100 ? 0 : 1;
  return `${x.toFixed(casas).replace('.', ',')} ${UNIDADES[i]}`;
}

// Predicado ÚNICO do «item ativo» da navegação. `isActive` (a classe) e
// `ariaCurrent` (a semântica) partilham-no: se cada um tivesse a sua cópia, a
// cor e o anúncio do leitor de ecrã podiam discordar sem que ninguém notasse.
function eAtivo(path, prefix) {
  return path === prefix || Boolean(path && path.startsWith(prefix + '/'));
}

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
  // diaSemana: «Segunda-feira» — ajuda a situar rapidamente datas de assembleias,
  // avisos e eventos (já existia em helpers/dates.js, só não estava na vista).
  diaSemana: (v) => diaSemana(v),
  dateInput: (v) => toDateInput(v),
  eur: (v) => formatEUR(v),
  bytes: (v) => formatBytes(v),
  monthName: (m) => monthName(m),
  currentYear: () => currentYear(),
  currentMonth: () => new Date().getMonth() + 1,
  json: (obj) => JSON.stringify(obj),
  // selected(option, current) → 'selected' se iguais
  selected: (a, b) => (String(a) === String(b) ? 'selected' : ''),
  // checked(a) → 'checked' se verdadeiro
  checked: (a) => (a ? 'checked' : ''),
  // isActive(path, prefix) → 'active' se o path atual pertence a esse item
  isActive: (path, prefix) => (eAtivo(path, prefix) ? 'active' : ''),
  // ariaCurrent(path, prefix) → `aria-current="page"` se o path atual pertence
  // a esse item. A14 §2/§14: o estado ativo NÃO pode depender só da cor — um
  // leitor de ecrã não vê a classe `active`. O predicado é PARTILHADO com
  // `isActive` (uma única regra: se divergissem, a cor e a semântica
  // discordariam em silêncio).
  ariaCurrent: (path, prefix) => (eAtivo(path, prefix) ? 'aria-current="page"' : ''),
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
  // Passa por `urlExternaSegura`: uma referência gravada antes desta validação
  // (ou alterada diretamente na base de dados) nunca chega ao href como
  // `javascript:`/`data:`.
  urlDocumentoExterno: (doc) => {
    if (!doc || doc.drive_file_id) return null;
    return urlExternaSegura(doc.url);
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
  // ── Máscaras (vistas de suporte diagnóstico) ─────────────────────
  // O acesso de suporte lê dados reais para diagnosticar, mas não precisa de
  // IDENTIFICAR pessoas nem de conhecer números de conta por inteiro. Estas
  // funções são a única forma de uma vista de suporte apresentar IBAN/NIF/
  // e-mail/telefone. Ver `helpers/mascara.js` (puro, sem I/O e sem BD) para o
  // contrato completo — incluindo a distinção entre «sem dado» («—») e «valor
  // irreconhecível» («***»), que a vista pode querer representar de forma
  // diferente do valor mascarado.
  maskIban: (v) => mascara.iban(v),
  maskNif: (v) => mascara.nif(v),
  maskEmail: (v) => mascara.email(v),
  maskTelefone: (v) => mascara.telefone(v),
  // mascaraAusente(v) → true quando não há nada a mostrar (campo vazio ou
  // ausente). Permite à vista escrever «—» em vez de passar a máscara.
  mascaraAusente: (v) => mascara.ausente(v),
};
