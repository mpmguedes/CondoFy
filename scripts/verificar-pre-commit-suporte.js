// Verificação §26 (6-11) — pré-commit. Só LEITURA, sem BD.
const fs = require('fs');
const L = require('../helpers/suporte-allowlist').LISTA;
const todos = [].concat(...Object.values(L).map((a) => a.map((e) => e.rotulo)));
const exato = (r) => todos.includes(r);

const ok = (b) => (b ? 'SIM ✓' : 'NAO ✗');

console.log('§26.6  nenhuma sub-rota de /documentos  →', ok(todos.filter((r) => r.startsWith('/documentos')).join(',') === '/documentos'));
console.log('§26.7  /fracoes/:id excluído             →', ok(!todos.some((r) => /^\/fracoes\//.test(r))));
console.log('       /fracoes (lista) admitido         →', ok(exato('/fracoes')));
// Nota: `/condominos` (lista de proprietários do backoffice, admitida COM vista
// mascarada) NÃO é o portal `/condomino`. A comparação tem de ser ao prefixo
// exato `/condomino` ou `/condomino/…`, não a qualquer coisa que o contenha.
console.log('§26.8  nenhuma rota /condomino (portal)   →', ok(!todos.some((r) => r === '/condomino' || r.startsWith('/condomino/'))));
console.log('§20    convocatória excluída             →', ok(!todos.some((r) => /convocatoria/.test(r))));
console.log('§21    só /emails (sem smtp/teste)       →', ok(todos.filter((r) => r.startsWith('/emails')).join(',') === '/emails'));

console.log('\n§26.9  /quotas tem scoping?');
const qm = fs.readFileSync(require('path').join(__dirname, '..', 'routes', 'quotas-modulo.js'), 'utf8');
const fin = fs.readFileSync(require('path').join(__dirname, '..', 'routes', 'financeiro.js'), 'utf8');
console.log('       quotas-modulo: { ano, condominio_id: cid }  →', ok(/Quota\.findAll\(\{\s*where:\s*\{\s*ano,\s*condominio_id:\s*cid\s*\}\s*\}\)/.test(qm)));
console.log('       financeiro: { condominio_id: req.condominioId } →', ok(/const where = \{\s*condominio_id:\s*req\.condominioId\s*\}/.test(fin)));

console.log('\n§26.10 PII mascarada nas vistas de suporte?');
const vistas = [
  ['condominos/listar-suporte', /maskEmail/],
  ['condominos/listar-suporte', /maskNif/],
  ['condominos/listar-suporte', /maskTelefone/],
  ['contas/listar-suporte', /maskIban/],
  ['pagamentos/detalhe-suporte', null],
  ['emails/index-suporte', /maskEmail/],
];
for (const [v, re] of vistas) {
  const p = require('path').join(__dirname, '..', 'views', 'admin', v + '.handlebars');
  if (!fs.existsSync(p)) { console.log(`       ${v} → inexistente ✗`); continue; }
  const s = fs.readFileSync(p, 'utf8');
  if (re === null) { console.log(`       ${v} → existe (sem PII a mascarar)`); continue; }
  console.log(`       ${v} usa ${re.source} →`, ok(re.test(s)));
}

console.log('\n§26.11 nenhum segredo renderizado?');
const suspeitos = ['SMTP_PASS', 'smtp_pass', 'drive_file_id', 'drive_folder_id', 'refresh_token', 'access_token', 'client_secret', 'password'];
let achou = [];
for (const d of ['views/admin']) {
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = require('path').join(dir, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/-suporte\.handlebars$/.test(f)) continue;
      // Remove os COMENTÁRIOS Handlebars (`{{!-- … --}}`) antes de procurar: os
      // comentários DOCUMENTAM o que a vista NÃO expõe, pelo que citam
      // precisamente esses nomes. Procurar dentro deles daria falsos positivos.
      const s = fs.readFileSync(p, 'utf8').replace(/\{\{!--[\s\S]*?--\}\}/g, '');
      // procura a CHAVE em contexto de OUTPUT ({{ … }}), não em comentário.
      for (const c of suspeitos) {
        const re = new RegExp('\\{\\{[^}]*' + c + '[^}]*\\}\\}', 'i');
        if (re.test(s)) achou.push(`${p}: ${c}`);
      }
    }
  };
  walk(require('path').join(__dirname, '..', d));
}
console.log('       segredos em output de vistas de suporte →', ok(achou.length === 0));
if (achou.length) achou.forEach((a) => console.log('         · ' + a));
