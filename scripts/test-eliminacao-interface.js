// ═══════════════════════════════════════════════════════════════════
// Interface do ciclo de estado do condomínio (Super Admin) — teste REAL
//
// O que este teste existe para impedir:
//
//   O servidor exige, no POST a `/:id/estado`, uma `acao` explícita
//   (`desativar`|`reativar`) e — quando é desativação — um `motivo`. As vistas
//   do painel global NÃO enviavam nenhum dos dois: o botão fazia POST sem
//   `acao` nem `motivo`, o handler recusava sempre, e a operação era
//   IMPOSSÍVEL pela interface. Nenhum teste o apanhou porque os testes do ciclo
//   de vida chamam `/desativar` e `/reativar` diretamente — provam o SERVIDOR,
//   nunca a PONTE entre a vista e o servidor.
//
// Este teste fecha essa ponte: RENDERIZA as vistas reais (com o mesmo motor de
// Handlebars do app.js) e confronta os formulários que o HTML produz com os
// campos que o handler lê. A fonte da verdade dos campos é o PRÓPRIO HANDLER,
// lido do ficheiro — não uma lista escrita à mão neste teste, que ficaria
// desatualizada em silêncio.
//
// Utilização: node scripts/test-eliminacao-interface.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const VISTA_LISTA = 'views/admin/global/condominios.handlebars';
const VISTA_DETALHE = 'views/admin/global/condominio.handlebars';
// Nome relativo à raiz de vistas, que é o que `res.render` espera.
const NOME_LISTA = 'admin/global/condominios';
const NOME_DETALHE = 'admin/global/condominio';
const HANDLER = 'routes/global-admin.js';

// ── Contadores ───────────────────────────────────────────────────────
let passou = 0;
const falhas = [];
function titulo(t) { console.log(`\n── ${t}`); }
function ok(msg) { passou += 1; console.log(`  ✓ ${msg}`); }
function mau(msg) { falhas.push(msg); console.log(`  ✗ ${msg}`); }

// ── Motor de vistas: o MESMO do app.js (layouts + partials + helpers) ─
function renderizar(vista, dados) {
  const app = express();
  app.engine('handlebars', engine({
    defaultLayout: 'main',
    helpers: require('../helpers/handlebars-helpers'),
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));

  // `res.render` síncrono para dentro de uma promessa: o layout `main` exige
  // várias variáveis de `res.locals`, pelo que se fornecem valores mínimos.
  app.use((req, res, next) => {
    res.locals.user = { id: 1, nome: 'Super', email: 's@x.pt', role_global: 'super_admin' };
    res.locals.isAdmin = true;
    res.locals.meusCondominios = [];
    res.locals.condominioAtivo = null;
    res.locals.condominio = null;
    res.locals.currentPath = req.path;
    res.locals.appName = 'GesCondu';
    res.locals.currentYear = new Date().getFullYear();
    res.locals.sessaoAvisoMs = 120000;
    res.locals.sessaoIdleMs = 7200000;
    next();
  });

  return new Promise((resolve, reject) => {
    app.get('/_teste', (req, res) => res.render(vista, dados, (err, html) => {
      if (err) return reject(err);
      resolve(html);
    }));
    const servidor = app.listen(0, '127.0.0.1', () => {
      const http = require('http');
      http.get({ host: '127.0.0.1', port: servidor.address().port, path: '/_teste' }, (res) => {
        let corpo = '';
        res.on('data', (d) => { corpo += d; });
        res.on('end', () => { servidor.close(); resolve(corpo); });
      }).on('error', (e) => { servidor.close(); reject(e); });
    });
  });
}

// ── Extração dos formulários do HTML ────────────────────────────────
// Devolve [{ action, method, campos:Set, temObrigatorio:bool }].
function formularios(html) {
  const lista = [];
  const reForm = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = reForm.exec(html)) !== null) {
    const attrs = m[1];
    const corpo = m[2];
    const action = (attrs.match(/action="([^"]*)"/i) || [])[1] || '';
    const method = ((attrs.match(/method="([^"]*)"/i) || [])[1] || 'GET').toUpperCase();
    const campos = new Set();
    let obrigatorio = false;
    for (const c of corpo.matchAll(/<input\b[^>]*>/gi)) {
      const tag = c[0];
      const nome = (tag.match(/name="([^"]*)"/i) || [])[1];
      if (nome) campos.add(nome);
      if (/\brequired\b/i.test(tag)) obrigatorio = true;
    }
    for (const c of corpo.matchAll(/<select\b[\s\S]*?<\/select>/gi)) {
      const nome = (c[0].match(/name="([^"]*)"/i) || [])[1];
      if (nome) campos.add(nome);
    }
    for (const c of corpo.matchAll(/<textarea\b[^>]*>/gi)) {
      const nome = (c[0].match(/name="([^"]*)"/i) || [])[1];
      if (nome) campos.add(nome);
    }
    lista.push({ action, method, campos, obrigatorio, corpo });
  }
  return lista;
}

// Formulários que publicam para a rota de estado.
const formsDeEstado = (html) =>
  formularios(html).filter((f) => f.method === 'POST' && /\/estado(\?|$|")/.test(f.action));

// ── A verdade vem do HANDLER, não deste teste ───────────────────────
// Lê do `routes/global-admin.js` os campos de `req.body` que o handler do
// ciclo de estado consulta. Se amanhã o handler passar a exigir outro campo,
// este teste apercebe-se sem ninguém se lembrar de o atualizar.
function camposLidosPeloHandler() {
  const src = ler(HANDLER);
  const campos = new Set();
  for (const m of src.matchAll(/req\.body\.([A-Za-z_][A-Za-z0-9_]*)/g)) campos.add(m[1]);
  return campos;
}

// As ações que o HANDLER aceita. Derivadas da constante do próprio handler.
function acoesAceitas() {
  const src = ler(HANDLER);
  const m = src.match(/const\s+ACOES_ESTADO\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'ACOES_ESTADO tem de existir em routes/global-admin.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

async function main() {
  console.log('═══ Interface do ciclo de estado do condomínio — testes offline ═══');

  const condominioAtivo = {
    id: 7,
    designacao: 'Condomínio Jardim',
    estado: 'ativo',
    morada: 'Rua das Flores 1',
    nif: '123456789',
  };
  const condominioInativo = { ...condominioAtivo, estado: 'inativo' };

  const htmlAtivo = await renderizar(NOME_DETALHE, {
    titulo: condominioAtivo.designacao,
    condominio: condominioAtivo,
    nFracoes: 4,
    associacoes: [],
  });
  const htmlInativo = await renderizar(NOME_DETALHE, {
    titulo: condominioInativo.designacao,
    condominio: condominioInativo,
    nFracoes: 4,
    associacoes: [],
  });
  const htmlLista = await renderizar(NOME_LISTA, {
    titulo: 'Condomínios · Global',
    lista: [
      { id: 7, designacao: 'Condomínio Jardim', estado: 'ativo', morada: 'Rua das Flores 1', membros: 2, fracoes: 4 },
      { id: 8, designacao: 'Condomínio Norte', estado: 'inativo', morada: 'Av. Central 9', membros: 1, fracoes: 3 },
    ],
  });

  // ── 1. As vistas renderizam ────────────────────────────────────────
  titulo('1. As vistas reais renderizam (a ponte existe)');
  {
    assert.ok(htmlAtivo.length > 200, 'a vista de detalhe tem de renderizar conteúdo');
    assert.ok(htmlLista.length > 200, 'a lista tem de renderizar conteúdo');
    ok('vista de detalhe e lista renderizam com o motor do app.js');
  }

  // ── 2. A LISTA: nenhum POST a /estado sem `acao` ───────────────────
  titulo('2. Lista — reativar envia `acao`, e não há POST cego');
  {
    const fs_ = formsDeEstado(htmlLista);
    for (const f of fs_) {
      const acao = [...f.campos].includes('acao');
      assert.ok(acao, `o formulário POST a ${f.action} tem de enviar \`acao\` explícita`);
    }
    // O estado ativo NÃO pode desativar por aqui: o motivo é obrigatório e não
    // há onde o escrever numa linha de tabela.
    const formsAtivo = fs_.filter((f) => /condominios\/7\/estado/.test(f.action));
    assert.strictEqual(formsAtivo.length, 0,
      'a linha de um condomínio ATIVO não pode fazer POST direto à desativação: falta o motivo');
    const formsInativo = fs_.filter((f) => /condominios\/8\/estado/.test(f.action));
    assert.strictEqual(formsInativo.length, 1, 'a linha de um condomínio desativado tem o POST de reativação');
    assert.ok(formsInativo[0].campos.has('acao'), 'a reativação tem de enviar `acao`');
    const valorAcao = (formsInativo[0].corpo.match(/name="acao"[^>]*value="([^"]*)"/) || [])[1];
    assert.strictEqual(valorAcao, 'reativar', 'o valor da ação na lista tem de ser `reativar`');
    ok('lista: reativação envia acao=reativar; desativação não é feita por POST cego');
  }

  // ── 3. DETALHE: desativar envia `acao` + `motivo` obrigatório ──────
  titulo('3. Detalhe (ativo) — desativar envia `acao` e `motivo` obrigatório');
  {
    const f = formsDeEstado(htmlAtivo);
    assert.strictEqual(f.length, 1, 'a vista de um condomínio ativo tem UM formulário de estado');
    assert.ok(f[0].campos.has('acao'), 'tem de enviar `acao`');
    assert.ok(f[0].campos.has('motivo'), 'tem de enviar `motivo`');
    const valorAcao = (f[0].corpo.match(/name="acao"[^>]*value="([^"]*)"/) || [])[1];
    assert.strictEqual(valorAcao, 'desativar', 'o valor da ação tem de ser `desativar`');
    assert.ok(f[0].obrigatorio, 'o campo `motivo` tem de ser `required` no HTML');
    const campoMotivo = (f[0].corpo.match(/<input\b[^>]*name="motivo"[^>]*>/i) || [])[0];
    assert.ok(campoMotivo && /\brequired\b/i.test(campoMotivo), 'o `motivo` tem de estar marcado required');
    ok('detalhe ativo: acao=desativar + motivo required, ambos no mesmo formulário');
  }

  // ── 4. DETALHE: reativar envia `acao`, e NÃO exige motivo ──────────
  titulo('4. Detalhe (inativo) — reativar envia `acao` e não pede motivo');
  {
    const f = formsDeEstado(htmlInativo);
    assert.strictEqual(f.length, 1, 'a vista de um condomínio desativado tem UM formulário de estado');
    assert.ok(f[0].campos.has('acao'), 'tem de enviar `acao`');
    const valorAcao = (f[0].corpo.match(/name="acao"[^>]*value="([^"]*)"/) || [])[1];
    assert.strictEqual(valorAcao, 'reativar', 'o valor da ação tem de ser `reativar`');
    assert.ok(!f[0].campos.has('motivo'), 'reativar NÃO exige motivo (decisão de produto)');
    ok('detalhe inativo: acao=reativar, sem campo de motivo');
  }

  // ── 5. Os valores de `acao` são os que o HANDLER aceita ────────────
  titulo('5. Toda a `acao` enviada é aceite pelo handler (deriva do próprio handler)');
  {
    const aceitas = acoesAceitas();
    assert.ok(aceitas.length >= 2, 'o handler tem de declarar as ações aceites');
    for (const html of [htmlLista, htmlAtivo, htmlInativo]) {
      for (const f of formsDeEstado(html)) {
        for (const c of f.corpo.matchAll(/name="acao"[^>]*value="([^"]*)"/g)) {
          assert.ok(aceitas.includes(c[1]),
            `a vista envia acao="${c[1]}", que o handler não aceita (aceita: ${aceitas.join(', ')})`);
        }
      }
    }
    ok(`valores de acao enviados pertencem a {${aceitas.join(' · ')}}`);
  }

  // ── 6. A vista só envia campos que o handler conhece ──────────────
  titulo('6. Nenhum campo inventado nos formulários de estado');
  {
    const lidos = camposLidosPeloHandler();
    for (const html of [htmlLista, htmlAtivo, htmlInativo]) {
      for (const f of formsDeEstado(html)) {
        for (const nome of f.campos) {
          assert.ok(lidos.has(nome),
            `o formulário envia \`${nome}\`, que o handler não lê (lê: ${[...lidos].join(', ')})`);
        }
      }
    }
    ok('todos os campos enviados são lidos pelo handler');
  }

  // ── 7. O POST continua a ir para a rota que o handler serve ────────
  titulo('7. O destino do POST é uma rota declarada no handler');
  {
    const src = ler(HANDLER);
    for (const html of [htmlLista, htmlAtivo, htmlInativo]) {
      for (const f of formsDeEstado(html)) {
        assert.ok(/\/condominios\/\d+\/estado$/.test(f.action),
          `destino inesperado: ${f.action}`);
        assert.ok(src.includes(`'/global/condominios/:id/estado'`),
          'a rota destino tem de estar declarada no handler');
      }
    }
    ok('o destino POST /global/condominios/:id/estado existe no handler');
  }

  // ── 8. A eliminação definitiva mantém a sua proteção ───────────────
  titulo('8. Eliminação definitiva — proteção preservada (fora do âmbito, mas não pode regredir)');
  {
    const fElim = formularios(htmlInativo).find((f) => /\/eliminar$/.test(f.action));
    assert.ok(fElim, 'a vista de um condomínio desativado tem o formulário de eliminação');
    assert.ok(fElim.campos.has('confirmo'), 'a eliminação tem de enviar `confirmo`');
    assert.ok(fElim.obrigatorio, '`confirmo` tem de ser required');
    ok('eliminação mantém o campo `confirmo` obrigatório');
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (falhas.length) {
    console.log(`✗ FALHARAM ${falhas.length} verificação(ões):`);
    for (const f of falhas) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log(`✓ Interface do ciclo de estado: ${passou} verificações passaram (sem BD).`);
  process.exit(0);
}

main().catch((e) => { console.error('ERRO:', e && e.message); process.exit(1); });
