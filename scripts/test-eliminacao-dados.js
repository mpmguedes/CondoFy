// ═══════════════════════════════════════════════════════════════════
// Edição dos dados do condomínio (Super Admin) — teste REAL da ponte
//
// O que este teste existe para impedir:
//
//   A designação, a morada, o código postal, a localidade e o NIF eram
//   escritos UMA única vez, na criação (`POST /global/condominios`), e nunca
//   mais. A edição vivia em `/admin/config`, atrás de
//   `tenant.comCondominioAtivo` + `tenant.comPapel('admin')` — o que deixava
//   dois buracos que só o Super Admin podia tapar:
//
//    1. Um erro cometido na criação só era corrigível por um admin do
//       condomínio e, se ainda não existir nenhum associado, por NINGUÉM. A
//       única saída era eliminar o condomínio (a operação mais destrutiva do
//       sistema) para corrigir um nome.
//    2. Um condomínio DESATIVADO é ineditável por completo: sem contexto
//       ativo, nem o admin nem o suporte lá entram.
//
// Este teste fecha as duas coisas e fá-lo em duas frentes, porque uma só não
// chegaria:
//
//   A. A PONTE vista↔servidor. Os testes de rota provam o SERVIDOR; uma vista
//      que não envie os campos certos deixa a operação impossível sem que
//      nenhum teste se aperceba (foi exatamente esse o defeito da Lacuna A).
//      Aqui RENDERIZA-SE a vista real e confrontam-se os formulários que o
//      HTML produz com os campos que o handler lê — sendo a fonte da verdade
//      de `CAMPOS_EDITAVEIS` e das rotas o PRÓPRIO handler, lido do ficheiro.
//
//   B. O COMPORTAMENTO do handler, exercitado sem BD. Não basta a vista
//      enviar os campos: o servidor tem de recusar o que é inválido, AUDITAR
//      a recusa, não escrever nada quando não há alterações a guardar e
//      registar em auditoria só o que mudou, com o valor antigo e o novo.
//
// Utilização: node scripts/test-eliminacao-dados.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const VISTA_DETALHE = 'views/admin/global/condominio.handlebars';
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

const formDeDados = (html) =>
  formularios(html).filter((f) => f.method === 'POST' && /\/dados(\?|$|")/.test(f.action))[0] || null;

// ── A verdade vem do HANDLER, não deste teste ───────────────────────

// `CAMPOS_EDITAVEIS` é declarado no handler. Este teste NÃO o escreve à mão:
// se amanhã o handler passar a editar (ou deixar de editar) um campo, a vista
// tem de acompanhar, e o teste apercebe-se sozinho.
function camposEditaveisDoHandler() {
  const src = ler(HANDLER);
  const m = src.match(/const\s+CAMPOS_EDITAVEIS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'CAMPOS_EDITAVEIS tem de existir em routes/global-admin.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// Todos os campos de `req.body` lidos pelo handler de edição (extraídos do
// corpo do handler, para não contaminar com os `req.body` das outras rotas).
function handlerDeEdicao() {
  const src = ler(HANDLER);
  const inicio = src.indexOf("router.post('/global/condominios/:id/dados'");
  assert.ok(inicio !== -1, 'a rota POST /global/condominios/:id/dados tem de existir');
  const seguinte = src.indexOf('\nrouter.', inicio + 10);
  return src.slice(inicio, seguinte === -1 ? src.length : seguinte);
}

function camposLidosPeloHandlerDeEdicao() {
  const campos = new Set();
  for (const m of handlerDeEdicao().matchAll(/req\.body\.([A-Za-z_][A-Za-z0-9_]*)/g)) campos.add(m[1]);
  return campos;
}

// ── Execução do handler sem BD ──────────────────────────────────────
// O handler é montado a partir do router REAL, com os modelos, a auditoria e
// a validação de NIF substituídos. O stub de auditoria GRAVA as linhas: um
// stub no-op mediria zero eventos e o teste «passaria» sem provar nada.
const CAMINHO_MODELS = require.resolve('../models');
const CACHED_MODELS = require.cache[CAMINHO_MODELS];
const CACHED_AUDIT = require.cache[require.resolve('../helpers/audit')];
const CACHED_FISCAL = require.cache[require.resolve('../public/js/validacao-fiscal')];
const CACHED_TENANT = require.cache[require.resolve('../helpers/tenant')];

async function exercerHandler({ corpo, condominio, inexistente = false }) {
  const eventos = [];
  const updates = [];
  const estado = { designacao: condominio.designacao, morada: condominio.morada, codigo_postal: condominio.codigo_postal, localidade: condominio.localidade, nif: condominio.nif };

  const linha = { ...condominio, ...estado, update: async (dados) => { updates.push(dados); Object.assign(estado, dados); return { ...condominio, ...estado }; } };
  require.cache[CAMINHO_MODELS] = {
    id: CAMINHO_MODELS, filename: CAMINHO_MODELS, loaded: true,
    exports: {
      // `inexistente` modela o único caso que o id não consegue exprimir: um
      // id válido para o pedido mas sem linha na BD. Sem esta opção o stub
      // devolveria sempre a linha e o teste 12 estaria a testar-se a si mesmo.
      Condominio: { findByPk: async () => (inexistente ? null : linha) },
      User: {}, UserCondominio: {}, Fracao: {}, AuditLog: {},
    },
  };
  require.cache[require.resolve('../helpers/audit')] = {
    id: require.resolve('../helpers/audit'), filename: require.resolve('../helpers/audit'), loaded: true,
    exports: { audit: async (ev) => { eventos.push(ev); } },
  };
  require.cache[require.resolve('../helpers/tenant')] = {
    id: require.resolve('../helpers/tenant'), filename: require.resolve('../helpers/tenant'), loaded: true,
    exports: { eSuperAdmin: () => true, eAutenticado: () => true },
  };

  const caminhoRouter = require.resolve('../routes/global-admin');
  delete require.cache[caminhoRouter];
  const router = require('../routes/global-admin');

  const capturado = {};
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.user = { id: 99, email: 'super@x.pt', role_global: 'super_admin' };
    req.isAuthenticated = () => true;
    req.flash = (tipo, msg) => { (capturado[tipo] = capturado[tipo] || []).push(msg); };
    // Captura o corpo JSON que o router devolve, para inspecionar o estado
    // final sem depender de uma BD.
    const jsonOriginal = res.json.bind(res);
    res.json = (dados) => { capturado.json = dados; return jsonOriginal(dados); };
    // O handler responde por redirect; o corpo não interessa ao assert, mas
    // evita que o pedido fique pendurado à espera de resposta.
    const redirectOriginal = res.redirect.bind(res);
    res.redirect = (url) => { capturado.redirect = url; return redirectOriginal(url); };
    next();
  });
  // O router declara `/global/…`; aqui monta-se na raiz para o pedido ser
  // direto (`/global/condominios/:id/dados`), sem o prefixo duplicado do shim.
  app.use(router);
  app.use((err, req, res, _next) => { capturado.erro = err && err.message; res.status(500).json({ erro: capturado.erro }); });

  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const http = require('http');
  const dados = new URLSearchParams(corpo).toString();
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: servidor.address().port, path: `/global/condominios/${condominio.id}/dados`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
  servidor.close();

  // Repõe o cache para não contaminar os testes seguintes nem outros ficheiros.
  if (CACHED_MODELS) require.cache[CAMINHO_MODELS] = CACHED_MODELS; else delete require.cache[CAMINHO_MODELS];
  if (CACHED_AUDIT) require.cache[require.resolve('../helpers/audit')] = CACHED_AUDIT;
  if (CACHED_FISCAL) require.cache[require.resolve('../public/js/validacao-fiscal')] = CACHED_FISCAL;
  if (CACHED_TENANT) require.cache[require.resolve('../helpers/tenant')] = CACHED_TENANT;
  delete require.cache[caminhoRouter];

  return { eventos, updates, estado, capturado };
}

async function main() {
  console.log('═══ Edição dos dados do condomínio (Super Admin) — testes offline ═══');

  const condominio = {
    id: 11,
    designacao: 'Condomínio Jardim',
    morada: 'Rua das Flores 1',
    codigo_postal: '1000-100',
    localidade: 'Lisboa',
    nif: '123456789',
    estado: 'ativo',
  };

  const htmlAtivo = await renderizar(NOME_DETALHE, {
    titulo: condominio.designacao, condominio, nFracoes: 4, associacoes: [],
  });
  const htmlInativo = await renderizar(NOME_DETALHE, {
    titulo: condominio.designacao, condominio: { ...condominio, estado: 'inativo' }, nFracoes: 4, associacoes: [],
  });

  // ── 1. A vista renderiza e tem o formulário de dados ───────────────
  titulo('1. A vista de detalhe expõe um formulário de edição dos dados');
  {
    assert.ok(htmlAtivo.length > 200, 'a vista tem de renderizar conteúdo');
    const f = formDeDados(htmlAtivo);
    assert.ok(f, 'não existe formulário POST a `/dados`: a edição continua impossível');
    assert.ok(/\/condominios\/\d+\/dados$/.test(f.action), `destino inesperado: ${f.action}`);
    ok('a vista de detalhe tem um POST a /global/condominios/:id/dados');
  }

  // ── 2. Os campos enviados cobrem TODOS os que o handler edita ──────
  titulo('2. A vista envia todos os campos que o handler edita (verdade vem do handler)');
  {
    const editaveis = camposEditaveisDoHandler();
    assert.ok(editaveis.length >= 5, `CAMPOS_EDITAVEIS parece incompleto: ${editaveis.join(', ')}`);
    const f = formDeDados(htmlAtivo);
    for (const campo of editaveis) {
      assert.ok(f.campos.has(campo),
        `a vista não envia \`${campo}\`, que o handler edita — o campo ficaria a NULL em cada gravação`);
    }
    ok(`a vista envia os ${editaveis.length} campos editáveis: ${editaveis.join(', ')}`);
  }

  // ── 3. A designação é obrigatória na vista (o servidor recusa sem ela) ─
  titulo('3. A designação é `required` no HTML (o servidor recusa sem ela)');
  {
    const f = formDeDados(htmlAtivo);
    const campo = (f.corpo.match(/<input\b[^>]*name="designacao"[^>]*>/i) || [])[0];
    assert.ok(campo, 'tem de existir um campo `designacao`');
    assert.ok(/\brequired\b/i.test(campo), '`designacao` tem de estar marcado required');
    ok('designacao required no formulário de dados');
  }

  // ── 4. A vista não inventa campos que o handler não lê ────────────
  titulo('4. Nenhum campo inventado no formulário de dados');
  {
    const lidos = camposLidosPeloHandlerDeEdicao();
    const f = formDeDados(htmlAtivo);
    for (const nome of f.campos) {
      assert.ok(lidos.has(nome), `a vista envia \`${nome}\`, que o handler de edição não lê (lê: ${[...lidos].join(', ')})`);
    }
    ok('todos os campos do formulário são lidos pelo handler de edição');
  }

  // ── 5. Os valores são PRÉ-PREENCHIDOS com o estado atual ───────────
  titulo('5. Os campos vêm pré-preenchidos com o valor atual (editar, não reescrever)');
  {
    const f = formDeDados(htmlAtivo);
    for (const [campo, valor] of [['designacao', condominio.designacao], ['morada', condominio.morada], ['nif', condominio.nif]]) {
      const tag = (f.corpo.match(new RegExp(`<input\\b[^>]*name="${campo}"[^>]*>`, 'i')) || [])[0];
      assert.ok(tag, `falta o campo ${campo}`);
      const v = (tag.match(/\bvalue="([^"]*)"/i) || [])[1];
      assert.strictEqual(v, valor, `o campo ${campo} devia vir preenchido com «${valor}» e veio «${v}»`);
    }
    ok('os campos vêm preenchidos com os dados atuais do condomínio');
  }

  // ── 6. O formulário existe também com o condomínio DESATIVADO ──────
  titulo('6. Um condomínio DESATIVADO também é editável (o buraco que motivou esta rota)');
  {
    const f = formDeDados(htmlInativo);
    assert.ok(f, 'um condomínio desativado tem de poder corrigir os seus dados — é o caso em que /admin/config é inacessível');
    ok('a vista de um condomínio desativado mantém o formulário de dados');
  }

  // ── 7. Gravação válida: atualiza e audita SÓ o que mudou ───────────
  titulo('7. Gravação válida — atualiza o registo e audita apenas os campos alterados');
  {
    const { eventos, updates, estado } = await exercerHandler({
      condominio,
      corpo: { designacao: 'Condomínio Jardim (corrigido)', morada: condominio.morada, codigo_postal: condominio.codigo_postal, localidade: condominio.localidade, nif: condominio.nif },
    });
    assert.strictEqual(updates.length, 1, 'a gravação válida tem de produzir UM update');
    assert.strictEqual(estado.designacao, 'Condomínio Jardim (corrigido)', 'a designação tem de ficar gravada');
    assert.strictEqual(eventos.length, 1, 'tem de produzir exatamente UM evento de auditoria');
    assert.strictEqual(eventos[0].acao, 'condominio_editado', `ação inesperada: ${eventos[0].acao}`);
    assert.strictEqual(eventos[0].entidade, 'Condominio', 'a entidade auditada tem de ser o condomínio');
    assert.strictEqual(String(eventos[0].entidadeId), String(condominio.id), 'o evento tem de apontar para o condomínio certo');
    const d = eventos[0].detalhes || {};
    assert.ok(d.designacao, 'o evento tem de registar a designação alterada');
    assert.deepStrictEqual(Object.keys(d).sort(), ['designacao'],
      `só a designação mudou, mas o evento registou: ${Object.keys(d).join(', ')}`);
    assert.strictEqual(d.designacao.de, condominio.designacao, 'o evento tem de guardar o valor ANTIGO');
    assert.strictEqual(d.designacao.para, 'Condomínio Jardim (corrigido)', 'o evento tem de guardar o valor NOVO');
    ok('gravação válida: 1 update, 1 evento `condominio_editado` com {de, para} só do campo alterado');
  }

  // ── 8. Sem designação: recusa AUDITADA e nada escrito ─────────────
  titulo('8. Designação vazia — recusa auditada, sem escrever nada');
  {
    const { eventos, updates, estado } = await exercerHandler({
      condominio,
      corpo: { designacao: '   ', morada: 'Nova morada' },
    });
    assert.strictEqual(updates.length, 0, 'não pode haver update quando a designação falta');
    assert.strictEqual(estado.morada, condominio.morada, 'nada pode ser gravado na recusa');
    assert.strictEqual(eventos.length, 1, 'a recusa tem de deixar rasto na auditoria');
    assert.strictEqual(eventos[0].acao, 'condominio_edicao_recusada', `ação inesperada: ${eventos[0].acao}`);
    assert.strictEqual(eventos[0].detalhes.motivo, 'designacao_obrigatoria', `motivo inesperado: ${eventos[0].detalhes.motivo}`);
    assert.strictEqual(eventos[0].detalhes.resultado, 'recusado', 'o evento tem de marcar o resultado como recusado');
    ok('designação vazia: 0 escritas, 1 evento `condominio_edicao_recusada`/designacao_obrigatoria');
  }

  // ── 9. NIF inválido: recusa AUDITADA e nada escrito ──────────────
  titulo('9. NIF inválido — recusa auditada, sem escrever nada');
  {
    const { eventos, updates, estado } = await exercerHandler({
      condominio,
      corpo: { designacao: 'Outro nome', nif: '123' },
    });
    assert.strictEqual(updates.length, 0, 'um NIF inválido não pode gravar nada');
    assert.strictEqual(estado.designacao, condominio.designacao, 'a designação não pode ser alterada na recusa');
    assert.strictEqual(eventos.length, 1, 'a recusa tem de deixar rasto na auditoria');
    assert.strictEqual(eventos[0].acao, 'condominio_edicao_recusada', `ação inesperada: ${eventos[0].acao}`);
    assert.strictEqual(eventos[0].detalhes.motivo, 'nif_invalido', `motivo inesperado: ${eventos[0].detalhes.motivo}`);
    ok('NIF inválido: 0 escritas, 1 evento `condominio_edicao_recusada`/nif_invalido');
  }

  // ── 10. Sem alterações: 0 updates e NENHUM evento ────────────────
  titulo('10. Sem alterações — não escreve e não produz um evento vazio');
  {
    const { eventos, updates } = await exercerHandler({
      condominio,
      corpo: { designacao: condominio.designacao, morada: condominio.morada, codigo_postal: condominio.codigo_postal, localidade: condominio.localidade, nif: condominio.nif },
    });
    assert.strictEqual(updates.length, 0, 'reenviar os mesmos dados não pode escrever');
    assert.strictEqual(eventos.length, 0, 'reenviar os mesmos dados não pode gerar um evento de auditoria');
    ok('sem alterações: 0 escritas e 0 eventos (sem auditoria de vazio)');
  }

  // ── 11. Campos opcionais esvaziados ficam a NULL, e isso é auditado ─
  titulo('11. Limpar um campo opcional grava NULL e registra a transição');
  {
    const { eventos, updates, estado } = await exercerHandler({
      condominio,
      corpo: { designacao: condominio.designacao, morada: '', codigo_postal: condominio.codigo_postal, localidade: condominio.localidade, nif: condominio.nif },
    });
    assert.strictEqual(updates.length, 1, 'limpar a morada é uma alteração e tem de gravar');
    assert.strictEqual(estado.morada, null, 'a morada limpa tem de ficar a NULL');
    assert.deepStrictEqual(Object.keys(eventos[0].detalhes).sort(), ['morada'], 'só a morada mudou');
    assert.strictEqual(eventos[0].detalhes.morada.de, condominio.morada, 'o valor antigo tem de ficar no evento');
    assert.strictEqual(eventos[0].detalhes.morada.para, null, 'o valor novo é NULL');
    ok('campo opcional esvaziado: NULL gravado e transição {de, para} registada');
  }

  // ── 12. Condomínio inexistente: recusa sem escrever ──────────────
  titulo('12. Condomínio inexistente — recusa sem escrever nada');
  {
    const { eventos, updates, capturado } = await exercerHandler({
      condominio,
      inexistente: true,
      corpo: { designacao: 'X' },
    });
    assert.strictEqual(updates.length, 0, 'não pode haver update para um condomínio inexistente');
    assert.strictEqual(eventos.length, 0, 'sem condomínio não há entidade a auditar');
    assert.ok((capturado.error_msg || []).length > 0, 'tem de haver mensagem de erro para o operador');
    ok('condomínio inexistente: recusa com mensagem, sem escrita e sem evento');
  }

  // ── 13. A rota está declarada e é distinta da rota de criação ────
  titulo('13. A rota declara-se no handler e não colide com a criação');
  {
    const src = ler(HANDLER);
    assert.ok(src.includes("router.post('/global/condominios/:id/dados'"), 'a rota de edição tem de estar declarada');
    assert.ok(src.includes("router.post('/global/condominios'"), 'a criação tem de continuar a existir');
    ok('rota de edição declarada, criação intacta');
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (falhas.length) {
    console.log(`✗ FALHARAM ${falhas.length} verificação(ões):`);
    for (const f of falhas) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log(`✓ Edição dos dados do condomínio: ${passou} verificações passaram (sem BD).`);
  process.exit(0);
}

main().catch((e) => { console.error('ERRO:', e && e.stack); process.exit(1); });
