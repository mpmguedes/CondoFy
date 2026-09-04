// Valida as vistas Handlebars: compila e renderiza cada uma com um contexto mínimo.
// Utilização: node scripts/check-templates.js
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('../helpers/handlebars-helpers');

Object.entries(helpers).forEach(([k, v]) => handlebars.registerHelper(k, v));

const viewsDir = path.join(__dirname, '..', 'views');
const smoke = {
  condominio: { designacao: 'Condomínio Teste' },
  user: { nome: 'Utilizador Teste', role: 'admin' },
  isAdmin: true,
  fracoes: [],
  pessoas: [],
  users: [],
  pessoa: null,
  fracao: null,
  error: null,
  success_msg: [],
  error_msg: [],
  titulo: 'Teste',
};

// Regista os partials (views/partials/*.handlebars)
const partialsDir = path.join(viewsDir, 'partials');
if (fs.existsSync(partialsDir)) {
  for (const entry of fs.readdirSync(partialsDir)) {
    if (entry.endsWith('.handlebars')) {
      const name = entry.replace('.handlebars', '');
      handlebars.registerPartial(name, fs.readFileSync(path.join(partialsDir, entry), 'utf8'));
    }
  }
}

let failed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith('.handlebars')) {
      const rel = path.relative(viewsDir, full);
      const src = fs.readFileSync(full, 'utf8');
      try {
        const tpl = handlebars.compile(src);
        tpl(smoke);
        console.log('OK   ' + rel);
      } catch (e) {
        failed++;
        console.log('FAIL ' + rel + ' -> ' + e.message);
      }
    }
  }
}

walk(viewsDir);
console.log(failed === 0 ? '\nTodas as vistas compilam e renderizam.' : `\n${failed} vista(s) com erro.`);
process.exit(failed === 0 ? 0 : 1);
