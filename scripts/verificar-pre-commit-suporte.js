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

// ── §26.12 (ACHADO-01) — /documentos decide a vista num só ponto ───
// A allow-list fecha o CAMINHO, não o RAMO DE RENDER. O ACHADO-01 vivia
// exatamente aqui: o ramo `?pasta=recibos` fazia `return res.render(<vista de
// GESTÃO>)` com o nome literal, saltando a decisão `req.suporte ? … : …`. Como
// `req.path` não tem query string, a allow-list (e o próprio teste) aprovavam
// todas as variantes — o suporte recebia a vista administrativa dos recibos.
//
// Verificação estática, complementar ao T4.0 (que prova por HTTP): no handler
// `GET /documentos`, TODOS os `res.render` têm de passar pela função de decisão
// `vistaDeDocumentos`, que é a única que consulta `req.suporte`. Um
// `res.render` com nome literal ou com uma vista de gestão faz falhar aqui.
console.log('\n§26.12 (ACHADO-01) o handler de /documentos decide a vista num só ponto?');
const docSrc = fs.readFileSync(require('path').join(__dirname, '..', 'routes', 'documentos.js'), 'utf8');

// Extrai o bloco do handler `GET /documentos` por contagem de chavetes.
const blocoHandler = (() => {
  const m = /router\.get\('\/documentos'/.exec(docSrc);
  if (!m) return null;
  let nivel = 0;
  let vistoAbre = false;
  let fim = m.index;
  for (; fim < docSrc.length; fim += 1) {
    const c = docSrc[fim];
    if (c === '{') { nivel += 1; vistoAbre = true; } else if (c === '}') { nivel -= 1; if (vistoAbre && nivel === 0) { fim += 1; break; } }
  }
  return docSrc.slice(m.index, fim);
})();
console.log('       handler de GET /documentos localizado     →', ok(Boolean(blocoHandler)));

if (blocoHandler) {
  // Remove comentários ANTES de procurar renders: os comentários deste handler
  // DOCUMENTAM o defeito e citam `<vista de gestão>` — procurar dentro deles
  // daria um falso positivo. O que se verifica é o CÓDIGO.
  const blocoCodigo = blocoHandler
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  // Extrai a EXPRESSÃO de vista de cada `res.render(<expr>, …)` respeitando
  // parênteses ANINHADOS — `vistaDeDocumentos(req, 'x')` contém vírgulas e um
  // parêntese interno, pelo que um regex `([^,)]*)` truncaria a expressão.
  const expressoesDeVista = [];
  const marca = /res\.render\(/g;
  let mm;
  while ((mm = marca.exec(blocoCodigo)) !== null) {
    let i = mm.index + mm[0].length;
    let nivel = 1;
    let fimExpr = i;
    for (; fimExpr < blocoCodigo.length; fimExpr += 1) {
      const c = blocoCodigo[fimExpr];
      if (c === '(') nivel += 1;
      else if (c === ')') { nivel -= 1; if (nivel === 0) break; }
      else if (c === ',' && nivel === 1) break;
    }
    expressoesDeVista.push(blocoCodigo.slice(i, fimExpr).trim());
  }

  // (a) Não pode haver render com nome LITERAL de vista de documentos.
  const literais = expressoesDeVista.filter((e) => /^['"`]admin\/documentos\//.test(e));
  console.log('       nenhum render com vista literal          →', ok(literais.length === 0));
  if (literais.length) literais.forEach((l) => console.log('         · vista literal: ' + l));

  // (b) Nenhuma vista de GESTÃO pode ser renderizada sem passar pela decisão.
  const GESTAO = ['biblioteca', 'listar', 'recibos', 'recibos-anos'];
  const vistasGestaoCrus = expressoesDeVista.filter(
    (e) => !/^vistaDeDocumentos\(/.test(e) && GESTAO.some((g) => e.includes(g))
  );
  console.log('       vistas de gestão só via decisão          →', ok(vistasGestaoCrus.length === 0));
  if (vistasGestaoCrus.length) vistasGestaoCrus.forEach((v) => console.log('         · render de gestão fora da decisão: ' + v));

  // (c) Todos os renders do handler passam pela função de decisão.
  const semDecisao = expressoesDeVista.filter((e) => !/^vistaDeDocumentos\(req,/.test(e));
  console.log('       todos os renders via vistaDeDocumentos   →', ok(semDecisao.length === 0));
  if (semDecisao.length) semDecisao.forEach((e) => console.log('         · render sem decisão: ' + e));

  // (d) A própria decisão tem de consultar `req.suporte`.
  console.log('       vistaDeDocumentos consulta req.suporte   →', ok(/function vistaDeDocumentos\(req[\s\S]{0,400}?req\.suporte/.test(docSrc)));
  console.log(`       (${expressoesDeVista.length} render(s) no handler de /documentos)`);
}
