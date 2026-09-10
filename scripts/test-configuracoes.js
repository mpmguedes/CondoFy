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
  next();
});
app.use('/admin', router);

const pedir = (url) => new Promise((resolve, reject) => {
  const servidor = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: servidor.address().port, path: url }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, corpo }); });
    }).on('error', (e) => { servidor.close(); reject(e); });
  });
});

const TAB1 = 'href="/admin/config"';
const TAB2 = 'href="/admin/config/armazenamento"';
const TAB3 = 'href="/admin/config/automacoes"';

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

  // 2. Separador 2 — Armazenamento e Backups (mesmas funções, novo acesso)
  r = await pedir('/admin/config/armazenamento');
  assert.strictEqual(r.status, 200, 'GET /admin/config/armazenamento responde 200');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB2}`), 'armazenamento: separador 2 ativo');
  assert.ok(r.corpo.includes('id="google-drive"') && r.corpo.includes('admin@gmail.com'), 'armazenamento: estado do Google Drive');
  assert.ok(r.corpo.includes('Pasta de destino no Google Drive'), 'armazenamento: pasta de destino');
  assert.ok(r.corpo.includes('name="backups_drive"'), 'armazenamento: backups da base de dados');
  assert.ok(r.corpo.includes('action="/admin/config/drive/opcoes"'), 'armazenamento: gravação das opções');
  assert.ok(r.corpo.includes('action="/admin/config/drive/testar"'), 'armazenamento: testar ligação');
  assert.ok(r.corpo.includes('action="/admin/config/drive/estrutura"'), 'armazenamento: estrutura de pastas');
  assert.ok(r.corpo.includes('modalDesligarDrive'), 'armazenamento: modal de desligar');
  assert.ok(!r.corpo.includes('name="designacao"'), 'armazenamento: sem campos do condomínio');
  assert.ok(!r.corpo.includes('auto_convocatoria_drive'), 'armazenamento: sem automações');

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

  // 4. Navegação direta entre os três separadores, a partir de qualquer um
  for (const url of ['/admin/config', '/admin/config/armazenamento', '/admin/config/automacoes']) {
    const x = await pedir(url);
    assert.ok([TAB1, TAB2, TAB3].every((t) => x.corpo.includes(t)), `navegação: 3 separadores a partir de ${url}`);
    assert.ok(x.corpo.includes('class="config-tab active"'), `navegação: um ativo em ${url}`);
  }

  // 5. Rotas de gravação existentes mantêm-se
  const rotas = router.stack.filter((l) => l.route)
    .map((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path);
  for (const esperada of ['GET /config', 'POST /config', 'GET /config/armazenamento', 'GET /config/automacoes', 'POST /config/automacoes', 'POST /config/drive/opcoes', 'POST /config/drive/testar', 'POST /config/drive/estrutura', 'POST /config/drive/desligar', 'GET /config/drive/ligar', 'GET /config/drive/callback']) {
    assert.ok(rotas.includes(esperada), `rota preservada: ${esperada}`);
  }
  // Isolamento por condomínio/papel continua aplicado a nível do router.
  const middleware = router.stack.filter((l) => !l.route).length;
  assert.strictEqual(middleware, 2, 'isolamento: middleware de condomínio ativo e papel no router');

  models.UserCondominio.findOne = orig.userCondominioFindOne;
  models.BackupLog.findOne = orig.backupLogFindOne;

  console.log('✓ Testes dos separadores de Configurações passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
