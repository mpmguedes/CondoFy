// ═══════════════════════════════════════════════════════════════════
// T6 — PII nas vistas de suporte (sem BD, sem rede).
//
// Prova que as vistas servidas ao suporte diagnóstico NÃO expõem dados
// pessoais por inteiro. Faz-se em DOIS níveis, porque nenhum deles chega só:
//
//   (a) ESTÁTICO — as vistas `*-suporte.handlebars` usam os helpers de máscara
//       (`maskIban`/`maskNif`/`maskEmail`/`maskTelefone`) e não imprimem os
//       campos crus correspondentes. Uma vista nova que mostre um email por
//       inteiro falha aqui.
//   (b) RENDER — as vistas de suporte renderizam com dados de exemplo e o HTML
//       resultante não contém o valor original, só a máscara. É esta parte que
//       deteta a mutação «remover a máscara de uma vista».
//
// Utilização: node scripts/test-mascara-vistas.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// ── Vistas de suporte e os campos que TÊM de estar mascarados ───────
// `proibido`: padrões que NÃO podem aparecer na vista (impressão crua).
// `exigido`: padrões que TÊM de aparecer (a máscara).
const VISTAS = [
  {
    ficheiro: 'views/admin/condominos/listar-suporte.handlebars',
    exigido: [/maskEmail/, /maskTelefone/, /maskNif/],
    proibido: [/\{\{\s*(?:pessoa\.)?email\s*\}\}/, /\{\{\s*(?:pessoa\.)?telefone\s*\}\}/, /\{\{\s*(?:pessoa\.)?nif\s*\}\}/],
  },
  {
    ficheiro: 'views/admin/contas/listar-suporte.handlebars',
    exigido: [/maskIban/],
    proibido: [/\{\{\s*(?:conta\.)?iban\s*\}\}/],
  },
  {
    ficheiro: 'views/admin/emails/index-suporte.handlebars',
    exigido: [/maskEmail/],
    // Os campos crus nunca podem ser IMPRESSOS. Comentários Handlebars
    // (`{{!-- … --}}`) não são impressos — a procura é por `{{ campo }}`.
    proibido: [/\{\{\s*[\w.]*destinatario_email\s*\}\}/, /\{\{\s*corpo\s*\}\}/, /\{\{\s*corpo_html\s*\}\}/, /\{\{\s*[\w.]*anexo_caminho\s*\}\}/],
  },
  {
    ficheiro: 'views/admin/pagamentos/detalhe-suporte.handlebars',
    exigido: [],
    // O METADADO do comprovativo (estado/data) pode aparecer; o FICHEIRO e
    // qualquer ligação para o servir/validar/substituir, não. Um `{{#if …}}`
    // (condição) não imprime — só `{{ … }}` (expressão) imprime.
    proibido: [/\/comprovativo\b/, /\{\{\s*[\w.]*comprovativo_ficheiro\s*\}\}/, /\{\{\s*[\w.]*comprovativo_url\s*\}\}/, /\{\{\s*(?:pagamento\.)?iban\s*\}\}/, /\{\{\s*[\w.]*titular[\w.]*\s*\}\}/],
  },
];

// ── (a) Verificação estática ───────────────────────────────────────
titulo('T6.a — as vistas de suporte usam máscaras e não imprimem PII crua');
for (const v of VISTAS) {
  const p = path.join(RAIZ, v.ficheiro);
  assert.ok(fs.existsSync(p), `a vista ${v.ficheiro} existe`);
  const src = fs.readFileSync(p, 'utf8');

  for (const re of v.exigido) {
    assert.ok(re.test(src), `${v.ficheiro}: tem de usar o helper ${re}`);
  }
  for (const re of v.proibido) {
    assert.ok(!re.test(src), `${v.ficheiro}: NÃO pode imprimir o campo cru ${re}`);
  }
  feito(`${v.ficheiro}: máscaras presentes, campos crus ausentes`);
}

// ── (b) Verificação por RENDER ─────────────────────────────────────
// Compila com o Handlebars direto (o `engine` do express-handlebars tem uma
// assinatura própria que não facilita o render isolado). Registam-se os MESMOS
// helpers e partials que a aplicação usa.
titulo('T6.b — o render não deixa passar o valor original');

const Handlebars = require('handlebars');
const partialsDir = path.join(RAIZ, 'views', 'partials');
for (const f of fs.readdirSync(partialsDir)) {
  if (!f.endsWith('.handlebars')) continue;
  Handlebars.registerPartial(f.replace(/\.handlebars$/, ''),
    fs.readFileSync(path.join(partialsDir, f), 'utf8'));
}
Handlebars.registerHelper(require('../helpers/handlebars-helpers'));
const compilar = (ficheiro) =>
  Handlebars.compile(fs.readFileSync(path.join(RAIZ, ficheiro), 'utf8'));

const EMAIL = 'maria.silva@dominio.pt';
const TELEFONE = '912 345 678';
const NIF = '123456789';

const html = compilar('views/admin/condominos/listar-suporte.handlebars')({
  titulo: 'Condóminos',
  pessoas: [{
    id: 1, nome: 'Maria Silva', email: EMAIL, telefone: TELEFONE, nif: NIF,
    fracoes: [{ designacao: 'A' }],
  }],
});

assert.ok(!html.includes(EMAIL), 'o render NÃO pode conter o email original');
assert.ok(!html.includes(NIF), 'o render NÃO pode conter o NIF original');
feito('o email e o NIF originais não aparecem no HTML');

// A máscara esperada tem de estar presente (prova que o campo é mostrado,
// mas despersonalizado).
assert.ok(/m\*\*\*@dominio\.pt/.test(html), 'o email aparece mascarado (m***@dominio.pt)');
feito('o email aparece mascarado (m***@dominio.pt)');
assert.ok(/123\*\*\*789/.test(html), 'o NIF aparece mascarado (123***789)');
feito('o NIF aparece mascarado (123***789)');
// O telefone: só os últimos 3 dígitos.
assert.ok(/678/.test(html) && !/912\s*345\s*678/.test(html), 'o telefone aparece só com os últimos 3 dígitos');
feito('o telefone aparece só com os últimos 3 dígitos');

console.log(`\n✓ Testes de PII nas vistas de suporte passaram (${nTestes} verificações, sem BD).`);
