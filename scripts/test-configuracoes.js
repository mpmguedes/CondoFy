// ═══════════════════════════════════════════════════════════════════
// Testes das Configurações — separadores do módulo (sem base de dados)
//   Configuração do Condomínio | Armazenamento e Backups | Documentos e Automações
//
// Monta o router real num servidor Express com o mesmo motor de vistas do
// app.js (layouts + partials + helpers) e verifica, na resposta HTTP, que
// cada separador mostra apenas a sua área e que as rotas de gravação
// continuam iguais. Os acessos à BD são substituídos por duplos.
// Utilização: node scripts/test-configuracoes.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');

// ── Duplos de teste (BD e integrações) ─────────────────────────────
const models = require('../models');
const orig = {
  userCondominioFindOne: models.UserCondominio.findOne,
  backupLogFindOne: models.BackupLog.findOne,
  auditLogFindAll: models.AuditLog.findAll,
};

const condominioFake = {
  id: 1,
  designacao: 'Condomínio do Edifício Residencial Vista Mar',
  administracao_nome: 'Gestcondomínio, Unipessoal Lda.',
  website: 'www.gestcondominio.pt',
  nif: '500000000',
  morada: 'Rua Doutor António José de Almeida, 1234',
  codigo_postal: '1000-000',
  localidade: 'Lisboa',
  email: 'geral@gestcondominio.pt',
  telefone: '213 456 789',
  iban_principal: 'PT50 0002 0123 1234 5678 9015 4',
  identidade_visual: 'designacao',
  logotipo: null,
  toJSON() { return { ...this, toJSON: undefined }; },
};

models.UserCondominio.findOne = async () => ({ role: 'admin', condominio_id: 1 });
models.BackupLog.findOne = async () => null;
models.AuditLog.findAll = async () => ([
  { data_hora: new Date('2026-09-09T10:15:00Z'), user: { nome: 'Administrador', email: 'admin@exemplo.pt' }, acao: 'editar_configuração', entidade: 'Condominio', entidade_id: 1, detalhes: null },
  { data_hora: new Date('2026-09-08T18:02:00Z'), user: null, acao: 'criar_quota', entidade: 'Quota', entidade_id: 42, detalhes: '{"mes":9}' },
]);

// Helpers com BD: substituídos antes de carregar o router (que os importa).
const condominio = require('../helpers/condominio');
condominio.getCondominio = async () => ({ ...condominioFake });
const config = require('../helpers/config');
config.getConfig = async (chave, defeito) => (chave === 'drive_auto_backups' ? '1' : defeito);
const drive = require('../helpers/drive');
const estadoDrive = { ativo: true, credenciais: true, ligado: true, viaEnv: false, conta: 'admin@gmail.com', redirectUriDefinido: true };
drive.estadoLigacao = async () => ({ ...estadoDrive });
const automacoes = require('../helpers/automacoes');
const GRUPOS = [{
  rotulo: 'Assembleias',
  tipos: [{ tipo: 'convocatoria', rotulo: 'Convocatória de assembleia', drive: true, email: true, automatico: false }],
}];
automacoes.listarAutomacoes = async () => GRUPOS;

const router = require('../routes/configuracao');

// ── App de teste com o mesmo motor de vistas do app.js ─────────────
const app = express();
app.engine('handlebars', engine({
  defaultLayout: 'main',
  helpers: require('../helpers/handlebars-helpers'),
  layoutsDir: path.join(__dirname, '..', 'views', 'layouts'),
  partialsDir: path.join(__dirname, '..', 'views', 'partials'),
  runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
}));
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, '..', 'views'));
app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = { id: 1, nome: 'Administrador', email: 'admin@exemplo.pt', role_global: 'admin' };
  req.session = { condominio_ativo_id: 1 };
  req.flash = () => req;
  // Locais que o app.js define para o layout (navegação lateral, etc.).
  res.locals.user = req.user;
  res.locals.isAdmin = true;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = { id: 1, designacao: condominioFake.designacao, role: 'admin' };
  res.locals.condominio = condominioFake;
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = new Date().getFullYear();
  res.locals.tarefas = null;
  next();
});
app.use('/admin', router);

const pedir = (url) => new Promise((resolve, reject) => {
  const servidor = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: servidor.address().port, path: url }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        servidor.close();
        resolve({ status: res.statusCode, corpo, location: res.headers.location });
      });
    }).on('error', (e) => { servidor.close(); reject(e); });
  });
});

const TAB1 = 'href="/admin/config"';
const TAB2 = 'href="/admin/config/armazenamento"';
const TAB3 = 'href="/admin/config/automacoes"';
const TAB4 = 'href="/admin/config/auditoria"';

(async () => {
  // 1. Separador 1 — Configuração do Condomínio (campos intactos)
  let r = await pedir('/admin/config');
  assert.strictEqual(r.status, 200, 'GET /admin/config responde 200');
  assert.ok(r.corpo.includes('class="config-tabs"'), 'config: barra de separadores');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB1}`), 'config: separador 1 ativo por defeito');
  assert.ok(r.corpo.includes('aria-current="page"'), 'config: estado ativo assinalado');
  assert.ok(r.corpo.includes(TAB2) && r.corpo.includes(TAB3), 'config: separadores 2 e 3 acessíveis');
  assert.ok(r.corpo.includes('name="designacao"'), 'config: campo designação');
  assert.ok(r.corpo.includes('name="iban_principal"') && r.corpo.includes('data-validar="iban"'), 'config: pagamentos e validação');
  assert.ok(r.corpo.includes('enctype="multipart/form-data"'), 'config: upload do logótipo');
  assert.ok(!r.corpo.includes('Pasta de destino no Google Drive'), 'config: sem armazenamento no separador 1');
  assert.ok(!r.corpo.includes('modalDesligarDrive'), 'config: sem modal do Drive no separador 1');
  assert.ok(!r.corpo.includes('Configurar automações'), 'config: botão antigo das automações removido');

  // 2. Separador 2 — Armazenamento e Backups (serviços, principal e backups)
  r = await pedir('/admin/config/armazenamento');
  assert.strictEqual(r.status, 200, 'GET /admin/config/armazenamento responde 200');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB2}`), 'armazenamento: separador 2 ativo');
  // Três serviços, cada um com o seu cartão e estado.
  assert.ok(r.corpo.includes('Ligações aos serviços'), 'armazenamento: secção de ligações');
  for (const nome of ['google_drive', 'dropbox', 'onedrive']) {
    assert.ok(r.corpo.includes(`id="${nome}"`), `armazenamento: cartão do serviço ${nome}`);
  }
  assert.ok(r.corpo.includes('Google Drive') && r.corpo.includes('Dropbox') && r.corpo.includes('Microsoft OneDrive'), 'armazenamento: serviços nomeados');
  // Escolha do serviço para documentos e para backups (sem autorizar de novo).
  assert.ok(r.corpo.includes('Armazenamento dos documentos'), 'armazenamento: secção do armazenamento dos documentos');
  assert.ok(r.corpo.includes('action="/admin/config/armazenamento/principal"'), 'armazenamento: gravação do armazenamento dos documentos');
  assert.ok(r.corpo.includes('Backups'), 'armazenamento: secção de backups');
  assert.ok(r.corpo.includes('action="/admin/config/armazenamento/backups"'), 'armazenamento: gravação do destino de backups');
  assert.ok(!r.corpo.includes('Ligar para backups'), 'armazenamento: não pede autorização nova para os backups');
  assert.ok(r.corpo.includes('name="pasta_raiz"'), 'armazenamento: pasta raiz do Google Drive mantida');
  assert.ok(r.corpo.includes('privados'), 'armazenamento: explica que os documentos ficam privados');
  // Sem credenciais na instalação: mensagem amigável, nunca detalhes técnicos.
  assert.ok(r.corpo.includes('Disponível após configuração pelo administrador do GesCondu.'), 'armazenamento: mensagem amigável');
  assert.ok(!r.corpo.includes('.env'), 'armazenamento: nunca menciona .env');
  assert.ok(!r.corpo.includes('desativada no'), 'armazenamento: sem mensagens de desativação técnica');
  assert.ok(!r.corpo.includes('name="designacao"'), 'armazenamento: sem campos do condomínio');
  assert.ok(!r.corpo.includes('auto_convocatoria_drive'), 'armazenamento: sem automações');

  // 2.1 Serviço disponível na instalação mas ainda não ligado: a página mostra
  // a ação de ligar (o fluxo OAuth é sempre iniciado pelo backend).
  process.env.DROPBOX_ENABLED = 'true';
  process.env.DROPBOX_APP_KEY = 'chave-de-teste';
  process.env.DROPBOX_APP_SECRET = 'segredo-de-teste';
  try {
    const rDropbox = await pedir('/admin/config/armazenamento');
    assert.ok(rDropbox.corpo.includes('href="/admin/config/armazenamento/dropbox/ligar"'), 'armazenamento: ligar Dropbox disponível');
    assert.ok(rDropbox.corpo.includes('Ligar Dropbox'), 'armazenamento: texto do botão de ligar');
    assert.ok(rDropbox.corpo.includes('href="/admin/config/armazenamento/dropbox/ligar"'), 'armazenamento: ligar Dropbox disponível');
    assert.ok(!rDropbox.corpo.includes('href="/admin/config/armazenamento/onedrive/ligar"'), 'armazenamento: OneDrive sem credenciais não mostra ligação');
    // Regressão: "Desligar (plataforma)" tem de passar o âmbito ao adaptador,
    // senão a ligação de backups fica sempre a aparecer como ligada.
    const fonteRotas = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'configuracao.js'), 'utf8');
    assert.ok(/p\.desligar\(plataforma \? null : req\.condominioId, \{ plataforma \}\)/.test(fonteRotas), 'armazenamento: desligar passa o âmbito de plataforma');
    assert.ok(/plataforma: guardado\.ambito === 'plataforma'/.test(fonteRotas), 'armazenamento: callback indica o âmbito de plataforma');
    // Regressão: o Google Drive tem rotas próprias (Redirect URI registado no
    // Google); as rotas genéricas têm de delegar nelas, senão "Ligar/Desligar/
    // Testar" no Drive não fazia nada.
    for (const acao of ['ligar', 'desligar', 'testar']) {
      assert.ok(new RegExp(`ROTAS_DRIVE\\.${acao}`).test(fonteRotas), `armazenamento: rota genérica delega o ${acao} do Drive`);
    }
    // Regressão: quando a conta é revogada no fornecedor, o teste falha e os
    // tokens guardados são removidos. A página tem de recarregar o estado (senão
    // o serviço continuava a aparecer "Ligado ✓" sem forma de o desligar) e
    // dizer explicitamente que a ligação foi removida.
    assert.ok(/await storage\.inicializar\(\)\.catch/.test(fonteRotas), 'armazenamento: testar recarrega o estado após falha');
    assert.ok(/await drive\.inicializar\(\)\.catch/.test(fonteRotas), 'armazenamento: testar do Drive recarrega o estado após falha');
    assert.ok(fonteRotas.includes('A ligação foi removida porque a autorização já não é válida'), 'armazenamento: explica que a ligação inválida foi removida');
  } finally {
    delete process.env.DROPBOX_ENABLED;
    delete process.env.DROPBOX_APP_KEY;
    delete process.env.DROPBOX_APP_SECRET;
  }

  // 3. Separador 3 — Documentos e Automações (área antes atrás de um botão)
  r = await pedir('/admin/config/automacoes');
  assert.strictEqual(r.status, 200, 'GET /admin/config/automacoes responde 200');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB3}`), 'automações: separador 3 ativo');
  assert.ok(r.corpo.includes('name="auto_convocatoria_drive"'), 'automações: opção Guardar no Drive');
  assert.ok(r.corpo.includes('name="auto_convocatoria_email"'), 'automações: opção Disponível para email');
  assert.ok(r.corpo.includes('name="auto_convocatoria_automatico"'), 'automações: opção Enviar automaticamente');
  assert.ok(r.corpo.includes('action="/admin/config/automacoes"'), 'automações: gravação intacta');
  assert.ok(r.corpo.includes('Convocatória de assembleia'), 'automações: tipos de documento listados');
  assert.ok(!r.corpo.includes('arrow_back'), 'automações: botão antigo de retrocesso removido');
  assert.ok(r.corpo.includes('href="/admin/emails"'), 'automações: atalho para a central de emails');
  assert.ok(!r.corpo.includes('name="designacao"'), 'automações: sem campos do condomínio');

  // 4. Separador 4 — Auditoria (antes com entrada própria no menu principal)
  r = await pedir('/admin/config/auditoria');
  assert.strictEqual(r.status, 200, 'GET /admin/config/auditoria responde 200');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB4}`), 'auditoria: separador 4 ativo');
  assert.ok(r.corpo.includes('Administrador') && r.corpo.includes('criar_quota'), 'auditoria: registos listados');
  assert.ok(r.corpo.includes('Sem registos de auditoria.') === false, 'auditoria: com registos não mostra estado vazio');
  const menu = r.corpo.split('\n').filter((l) => /sidebar-item/.test(l) && /(config|auditoria)/.test(l)).map((l) => l.trim()).join(' | ');
  assert.ok(r.corpo.includes('class="sidebar-item active" href="/admin/config"'), 'auditoria: menu lateral mantém Configuração ativa', menu);
  assert.ok(!r.corpo.includes('href="/admin/auditoria"'), 'auditoria: entrada antiga do menu removida');

  // Estado vazio da auditoria
  const findAll = models.AuditLog.findAll;
  models.AuditLog.findAll = async () => [];
  const vazio = await pedir('/admin/config/auditoria');
  assert.ok(vazio.corpo.includes('Sem registos de auditoria.'), 'auditoria: estado vazio');
  models.AuditLog.findAll = findAll;

  // Endereço antigo continua a levar ao separador novo
  const antigo = await pedir('/admin/auditoria');
  assert.strictEqual(antigo.status, 302, 'auditoria: endereço antigo responde 302', String(antigo.status));
  assert.strictEqual(antigo.location, '/admin/config/auditoria', 'auditoria: endereço antigo redireciona para o separador');

  // 5. Navegação direta entre os quatro separadores, a partir de qualquer um
  for (const url of ['/admin/config', '/admin/config/armazenamento', '/admin/config/automacoes', '/admin/config/auditoria']) {
    const x = await pedir(url);
    assert.ok([TAB1, TAB2, TAB3, TAB4].every((t) => x.corpo.includes(t)), `navegação: 4 separadores a partir de ${url}`);
    assert.ok(x.corpo.includes('class="config-tab active"'), `navegação: um ativo em ${url}`);
  }

  // 6. Rotas de gravação existentes mantêm-se
  const rotas = router.stack.filter((l) => l.route)
    .map((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path);
  for (const esperada of ['GET /config', 'POST /config', 'GET /config/armazenamento', 'GET /config/automacoes', 'POST /config/automacoes', 'GET /config/auditoria', 'GET /auditoria', 'POST /config/armazenamento/provedor', 'GET /config/armazenamento/:provedor/ligar', 'GET /config/armazenamento/:provedor/callback', 'POST /config/armazenamento/:provedor/desligar', 'POST /config/armazenamento/:provedor/testar', 'POST /config/drive/opcoes', 'POST /config/drive/testar', 'POST /config/drive/estrutura', 'POST /config/drive/desligar', 'GET /config/drive/ligar', 'GET /config/drive/callback']) {
    assert.ok(rotas.includes(esperada), `rota preservada: ${esperada}`);
  }
  // Isolamento por condomínio/papel continua aplicado a nível do router.
  const middleware = router.stack.filter((l) => !l.route).length;
  assert.strictEqual(middleware, 2, 'isolamento: middleware de condomínio ativo e papel no router');

  models.UserCondominio.findOne = orig.userCondominioFindOne;
  models.BackupLog.findOne = orig.backupLogFindOne;
  models.AuditLog.findAll = orig.auditLogFindAll;

  console.log('✓ Testes dos separadores de Configurações passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
