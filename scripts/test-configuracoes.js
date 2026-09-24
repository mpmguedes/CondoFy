// ═══════════════════════════════════════════════════════════════════
// Testes das Configurações — separadores do módulo (sem base de dados)
//   Configuração do Condomínio | Armazenamento e Backups | Documentos e Automações
//   | Email / SMTP | Auditoria
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
const bcrypt = require('bcryptjs');
const { engine } = require('express-handlebars');

// ── Duplos de teste (BD e integrações) ─────────────────────────────
const models = require('../models');
const orig = {
  userCondominioFindOne: models.UserCondominio.findOne,
  backupLogFindOne: models.BackupLog.findOne,
  auditLogFindAll: models.AuditLog.findAll,
  auditLogCreate: models.AuditLog.create,
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
// As rotas de gravação chamam `audit()` → `AuditLog.create`. Sem este duplo, o
// teste (que se quer SEM BD) tentaria escrever no log de auditoria real.
// P54-3 (V14) — as gravações passam a ser auditadas com os CAMPOS alterados.
// Captura-se o payload para o poder afirmar (nomes apenas, nunca valores).
const auditoriaGravada = [];
models.AuditLog.create = async (dados) => { auditoriaGravada.push(dados); return {}; };

// P54-3 — a gravação da configuração SMTP corre dentro de uma TRANSAÇÃO (V9).
// Sem BD, substitui-se por uma transação em memória: o teste HTTP só precisa de
// provar que o fluxo a abre e a fecha; a atomicidade real prova-se no
// `test-smtp-validacao.js`, que exercita o mailer a sério.
if (models.sequelize && models.sequelize.transaction) {
  models.sequelize.transaction = async () => ({ commit: async () => {}, rollback: async () => {} });
}
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

// SMTP: o separador Email/SMTP lê o estado pelo `helpers/mailer` (que leria a
// tabela `configuracoes`) e escreve/valida por ele. Substitui-se só o que toca
// na BD/rede; a superfície do módulo mantém-se intacta — é a MESMA que a fila
// de emails usa, para que não exista uma segunda configuração.
const mailer = require('../helpers/mailer');
const smtpGuardado = [];
const smtpTestado = [];
const smtpEnviado = [];
// O estado devolvido pelo mailer é MUTÁVEL para o teste poder provar que a vista
// reflete o valor GUARDADO — e não uma opção fixa. `tls` faz parte do contrato
// real de `obterEstadoSmtp()` (P50): o stub tem de o imitar, senão não prova nada.
let estadoSmtpStub = {
  configurado: true,
  servidor: 'smtp.gmail.com',
  porta: '587',
  utilizador: 'condominio@gmail.com',
  remetente: 'condominio@gmail.com',
  nomeRemetente: 'Administração do Condomínio',
  tls: true,
  seguranca: 'STARTTLS (587)',
  temPassword: true,
};
mailer.obterEstadoSmtp = async () => ({ ...estadoSmtpStub });
// P54-3 (V14) — o contrato do mailer passou a incluir os NOMES dos campos
// alterados; o duplo tem de o imitar, senão o teste mediria um contrato que já
// não existe. O teste da rota só verifica que os nomes CHEGAM à auditoria — o
// cálculo real é provado no `test-smtp-validacao.js`.
mailer.guardarConfigSmtp = async (dados) => {
  smtpGuardado.push(dados);
  return { ok: true, alterados: ['host', 'port', 'user', 'pass', 'tls', 'from', 'fromName'], avisos: [] };
};
mailer.testarLigacao = async () => { smtpTestado.push(true); return { ok: true, servidor: 'smtp.gmail.com' }; };
mailer.enviarEmailTeste = async (dados) => { smtpEnviado.push(dados); return { ok: true, messageId: '<teste@exemplo.pt>' }; };

const automacoes = require('../helpers/automacoes');
const GRUPOS = [{
  rotulo: 'Assembleias',
  tipos: [{ tipo: 'convocatoria', rotulo: 'Convocatória de assembleia', drive: true, email: true, automatico: false }],
}];
automacoes.listarAutomacoes = async () => GRUPOS;

// Destino de backups: a interface tem de aceitar exatamente o que o job de
// backups consegue usar (`ligacaoDeBackup`) — nem mais, nem menos. A ligação e a
// gravação são substituídas para o teste controlar os dois casos.
const storage = require('../helpers/storage');
const ligacoesBackup = {
  dropbox: { condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' },
  onedrive: { condominioId: null, conta: null, origem: null },
  google_drive: { condominioId: null, conta: null, origem: null },
};
const destinosGravados = [];
storage.ligacaoDeBackup = (provedor) => ligacoesBackup[provedor] || { condominioId: null, conta: null, origem: null };
storage.definirDestinoDeBackup = async (nome) => { destinosGravados.push(nome === undefined ? null : nome); return nome; };

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

// O utilizador autenticado é MUTÁVEL: a maioria das rotas é de um admin de
// condomínio, mas as operações da INSTALAÇÃO (destino dos backups) exigem
// Super Admin (`users.role_global = 'super_admin'`) — ver A6.1.
// P54-3 (V11) — a gravação exige reautenticação: as contas de teste têm de ter
// um hash REAL, contra o qual o helper compara a password submetida. Custo 4 (e
// não 10) porque é um teste: o que se prova é a comparação, não o custo.
const PASSWORD_TESTE = 'palavra-passe-de-teste';
const HASH_TESTE = bcrypt.hashSync(PASSWORD_TESTE, 4);
const UTILIZADOR_ADMIN = { id: 1, nome: 'Administrador', email: 'admin@exemplo.pt', role_global: 'admin', password_hash: HASH_TESTE };
const UTILIZADOR_SUPER = { id: 9, nome: 'Super Admin', email: 'super@exemplo.pt', role_global: 'super_admin', password_hash: HASH_TESTE };
let UTILIZADOR = UTILIZADOR_ADMIN;

// Sessão PARTILHADA entre pedidos: a confirmação server-side (P54-3) vive na
// sessão e o fluxo real é «preparar num pedido → gravar no seguinte». Uma
// sessão nova por pedido tornaria esse fluxo impossível de exercitar.
const sessaoTeste = { condominio_ativo_id: 1 };

app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = UTILIZADOR;
  req.session = sessaoTeste;
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
app.use(express.urlencoded({ extended: true }));
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

// Pedido POST (form-urlencoded), para as rotas de gravação.
const enviar = (url, corpo) => new Promise((resolve, reject) => {
  const dados = new URLSearchParams(corpo).toString();
  const servidor = app.listen(0, '127.0.0.1', () => {
    const req = http.request({
      host: '127.0.0.1',
      port: servidor.address().port,
      path: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) },
    }, (res) => {
      let resposta = '';
      res.on('data', (d) => { resposta += d; });
      res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, corpo: resposta, location: res.headers.location }); });
    });
    req.on('error', (e) => { servidor.close(); reject(e); });
    req.end(dados);
  });
});

// Como `enviar`, mas com o corpo já interpretado como JSON: as rotas de
// preparação da confirmação (P54-3) respondem JSON, não um redirect.
const enviarJson = async (url, corpo) => {
  const r = await enviar(url, corpo);
  let dados = null;
  try { dados = JSON.parse(r.corpo); } catch (err) { dados = null; }
  return { ...r, dados };
};

const TAB1 = 'href="/admin/config"';
const TAB2 = 'href="/admin/config/armazenamento"';
const TAB3 = 'href="/admin/config/automacoes"';
const TAB4 = 'href="/admin/config/email"';
const TAB5 = 'href="/admin/config/auditoria"';

(async () => {
  // 1. Separador 1 — Configuração do Condomínio (campos intactos)
  let r = await pedir('/admin/config');
  assert.strictEqual(r.status, 200, 'GET /admin/config responde 200');
  assert.ok(r.corpo.includes('class="config-tabs"'), 'config: barra de separadores');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB1}`), 'config: separador 1 ativo por defeito');
  assert.ok(r.corpo.includes('aria-current="page"'), 'config: estado ativo assinalado');
  assert.ok(r.corpo.includes(TAB2) && r.corpo.includes(TAB3), 'config: separadores 2 e 3 acessíveis');
  assert.ok(r.corpo.includes(TAB4) && r.corpo.includes(TAB5), 'config: separadores 4 (Email/SMTP) e 5 (Auditoria) acessíveis');
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

  // 4. Separador 4 — Email / SMTP (antes na Central de Emails)
  r = await pedir('/admin/config/email');
  assert.strictEqual(r.status, 200, 'GET /admin/config/email responde 200');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB4}`), 'email: separador 4 ativo');
  // Os campos SMTP que existiam na Central de Emails continuam a existir, aqui.
  for (const campo of ['name="host"', 'name="port"', 'name="tls"', 'name="user"', 'name="pass"', 'name="from"', 'name="from_name"']) {
    assert.ok(r.corpo.includes(campo), `email: campo SMTP preservado (${campo})`);
  }
  assert.ok(r.corpo.includes('action="/admin/config/email/smtp"'), 'email: gravação da configuração SMTP');
  assert.ok(r.corpo.includes('action="/admin/config/email/smtp/testar"'), 'email: testar ligação');
  assert.ok(r.corpo.includes('action="/admin/config/email/teste"'), 'email: envio de email de teste');
  // As duas áreas ficam SEPARADAS: a configuração (campos) e a validação (teste)
  // são cartões distintos, com âncoras próprias — nunca um só bloco misturado.
  assert.ok(r.corpo.includes('id="smtp"') && r.corpo.includes('id="teste"'), 'email: configuração e teste em áreas distintas');
  assert.ok(r.corpo.includes('Configuração do serviço de email') && r.corpo.includes('Validação da configuração'), 'email: áreas identificadas por título próprio');
  // O envio de teste NÃO é um campo de configuração: o formulário de teste não
  // traz nenhum campo SMTP.
  const blocoTeste = r.corpo.slice(r.corpo.indexOf('id="teste"'));
  for (const campo of ['name="host"', 'name="port"', 'name="user"', 'name="pass"']) {
    assert.ok(!blocoTeste.includes(campo), `email: o bloco de teste não expõe o campo de configuração ${campo}`);
  }
  assert.ok(blocoTeste.includes('name="para"') && blocoTeste.includes('name="assunto"') && blocoTeste.includes('name="mensagem"'), 'email: o teste pede apenas destino/assunto/mensagem');
  // A password nunca é impressa (apenas o indicador «Definida»).
  assert.ok(!/name="pass"[^>]*value="[^"]+"/.test(r.corpo), 'email: a password SMTP nunca é preenchida na vista');
  assert.ok(r.corpo.includes('Definida'), 'email: indicador de password definida');

  // 4.0 P50 — o `<select name="tls">` reflete o valor GUARDADO.
  // Um `selected` fixo na opção «Usar TLS» fazia o formulário contradizer a
  // linha «Segurança» logo acima e, ao gravar (mesmo só para mudar a password),
  // enviava `tls=true` — sobrepondo um `smtp_tls='false'` guardado.
  // A asserção olha para o BLOCO do select e para o atributo `selected`, e não
  // para a presença das strings: a presença passaria com qualquer dos estados.
  const opcoesTlsSelecionadas = (html) => {
    const inicio = html.indexOf('id="smtp_tls"');
    assert.ok(inicio !== -1, 'P50: o select do TLS existe na página');
    const bloco = html.slice(inicio);
    const select = bloco.slice(0, bloco.indexOf('</select>'));
    return [...select.matchAll(/<option value="(true|false)"([^>]*)>/g)]
      .filter((o) => /\bselected\b/.test(o[2]))
      .map((o) => o[1]);
  };
  assert.deepStrictEqual(opcoesTlsSelecionadas(r.corpo), ['true'],
    'P50: com tls guardado = true, é «Usar TLS» que fica assinalado');
  // O mesmo formulário com o TLS GUARDADO desligado tem de assinalar «Sem TLS».
  estadoSmtpStub = { ...estadoSmtpStub, tls: false, seguranca: 'Sem TLS' };
  const rSemTls = await pedir('/admin/config/email');
  assert.deepStrictEqual(opcoesTlsSelecionadas(rSemTls.corpo), ['false'],
    'P50: com tls guardado = false, é «Sem TLS» que fica assinalado');
  assert.ok(!/<option value="true"[^>]*\bselected\b/.test(rSemTls.corpo),
    'P50: a opção «Usar TLS» NÃO fica assinalada quando o valor guardado é false');
  assert.ok(rSemTls.corpo.includes('Sem TLS'),
    'P50: a linha «Segurança» e o select concordam quando o TLS está desligado');
  estadoSmtpStub = { ...estadoSmtpStub, tls: true, seguranca: 'STARTTLS (587)' };

  // 4.1 P54-3 — o fluxo passou a ser PREPARAR (o servidor emite a confirmação)
  // e só depois GRAVAR. As rotas de escrita continuam a reutilizar o MESMO
  // mailer (sem segunda configuração).
  let postEmail;
  const CORPO_SMTP = {
    host: 'smtp.exemplo.pt', port: '465', user: 'u@exemplo.pt', pass: 'segredo',
    tls: 'true', from: 'geral@exemplo.pt', from_name: 'Administração',
  };

  // ⛔ POST direto, como faria quem tentasse contornar a interface: sem
  // confirmação e sem palavra-passe. Tem de ser RECUSADO e não gravar nada.
  smtpGuardado.length = 0;
  postEmail = await enviar('/admin/config/email/smtp', CORPO_SMTP);
  assert.strictEqual(postEmail.status, 302, 'P54-3: POST direto responde 302 (não rebenta)');
  assert.strictEqual(postEmail.location, '/admin/config/email', 'P54-3: POST direto volta ao separador');
  assert.strictEqual(smtpGuardado.length, 0, '⛔ P54-3: POST direto sem confirmação NÃO grava nada');

  // V11 — a preparação exige a palavra-passe da conta.
  const prepMau = await enviarJson('/admin/config/email/smtp/preparar', { ...CORPO_SMTP, password: 'palavra-passe-errada' });
  assert.strictEqual(prepMau.status, 403, 'P54-3: preparação com palavra-passe errada ⇒ 403');
  assert.ok(!prepMau.dados || !prepMau.dados.token, 'P54-3: e não emite token nenhum');

  // V10 — com a identidade provada, o SERVIDOR emite a confirmação.
  const prep = await enviarJson('/admin/config/email/smtp/preparar', { ...CORPO_SMTP, password: PASSWORD_TESTE });
  assert.strictEqual(prep.status, 200, 'P54-3: preparação válida ⇒ 200');
  assert.ok(prep.dados && typeof prep.dados.token === 'string' && prep.dados.token.length >= 32,
    'P54-3: o servidor devolve um token de confirmação');

  // Com o token, a gravação passa e chega ao mailer com os campos certos.
  auditoriaGravada.length = 0;
  smtpGuardado.length = 0;
  postEmail = await enviar('/admin/config/email/smtp', { ...CORPO_SMTP, password: PASSWORD_TESTE, _confirmacao: prep.dados.token });
  assert.strictEqual(postEmail.status, 302, 'email: guardar SMTP responde 302');
  assert.strictEqual(postEmail.location, '/admin/config/email', 'email: guardar SMTP volta ao separador');
  assert.deepStrictEqual(smtpGuardado, [{ host: 'smtp.exemplo.pt', port: '465', user: 'u@exemplo.pt', pass: 'segredo', tls: 'true', from: 'geral@exemplo.pt', fromName: 'Administração' }],
    'email: guardar SMTP passa os campos ao mailer existente');

  // V14 — a auditoria regista os NOMES dos campos alterados e NENHUM valor.
  const evSmtp = auditoriaGravada.filter((e) => e.acao === 'configurar_smtp');
  assert.strictEqual(evSmtp.length, 1, 'P54-3: a gravação é auditada exatamente uma vez');
  const detSmtp = JSON.parse(evSmtp[0].detalhes);
  assert.ok(Array.isArray(detSmtp.campos_alterados), 'V14: o evento tem `campos_alterados`');
  assert.ok(detSmtp.campos_alterados.includes('host'), 'V14: o host alterado aparece na lista');
  assert.ok(!JSON.stringify(evSmtp[0]).includes('segredo'),
    '⛔ V14: nenhum valor (e muito menos a password) entra no evento de auditoria');

  // 4.1b P54-1 — uma gravação RECUSADA pela validação não pode derrubar a rota.
  // `guardarConfigSmtp` passou a lançar `ErroValidacaoSmtp` ANTES de escrever
  // (porta não numérica, CR/LF no remetente, TLS inesperado). É um modo de falha
  // NOVO para a rota: sem esta prova, um `throw` não apanhado daria 500 ao
  // administrador em vez de voltar ao separador com um erro.
  const guardarSmtpOriginal = mailer.guardarConfigSmtp;
  mailer.guardarConfigSmtp = async () => {
    const erro = new Error('Configuração SMTP inválida (port)');
    erro.name = 'ErroValidacaoSmtp';
    erro.validacao = true;
    erro.erros = [{ campo: 'port', codigo: 'porta_invalida', mensagem: 'A porta tem de ser um número inteiro.' }];
    throw erro;
  };
  const postRecusado = await enviar('/admin/config/email/smtp', { host: 'smtp.exemplo.pt', port: 'abc', from: 'geral@exemplo.pt' });
  mailer.guardarConfigSmtp = guardarSmtpOriginal;
  assert.strictEqual(postRecusado.status, 302, 'P54-1: gravação recusada responde 302 (nunca 500)');
  assert.strictEqual(postRecusado.location, '/admin/config/email', 'P54-1: a gravação recusada volta ao separador');
  assert.strictEqual(mailer.guardarConfigSmtp, guardarSmtpOriginal, 'P54-1: o duplo da gravação foi reposto');

  smtpTestado.length = 0;
  postEmail = await enviar('/admin/config/email/smtp/testar', {});
  assert.strictEqual(postEmail.location, '/admin/config/email', 'email: testar ligação volta ao separador');
  assert.deepStrictEqual(smtpTestado, [true], 'email: testar ligação usa mailer.testarLigacao');

  smtpEnviado.length = 0;
  postEmail = await enviar('/admin/config/email/teste', { para: 'destino@exemplo.pt', assunto: 'Olá', mensagem: 'Teste' });
  assert.strictEqual(postEmail.location, '/admin/config/email', 'email: envio de teste volta ao separador');
  assert.strictEqual(smtpEnviado.length, 1, 'email: envio de teste usa mailer.enviarEmailTeste');
  assert.strictEqual(smtpEnviado[0].para, 'destino@exemplo.pt', 'email: envio de teste leva o destinatário');
  assert.strictEqual(smtpEnviado[0].condominioId, 1, 'email: envio de teste usa o condomínio ATIVO (nome do remetente)');
  // Sem destinatário não se envia nada (e volta com erro, não rebenta).
  smtpEnviado.length = 0;
  postEmail = await enviar('/admin/config/email/teste', { para: '   ' });
  assert.strictEqual(postEmail.location, '/admin/config/email', 'email: teste sem destinatário volta ao separador');
  assert.deepStrictEqual(smtpEnviado, [], 'email: teste sem destinatário não envia');

  // ── 4.2 P54-2 — modo CONSULTA/EDIÇÃO e proteção de segredos ────────
  // A página nasce em consulta: o formulário está `hidden` e o botão `Editar` é
  // o único caminho para os campos. Sem isto, o P54 não existe nesta página.
  r = await pedir('/admin/config/email');
  assert.ok(r.corpo.includes('data-modo-edicao'), 'P54-2: a área SMTP usa o padrão P54-0');
  assert.ok(r.corpo.includes('data-me-estado="consulta"'), 'P54-2: a página nasce em modo CONSULTA');
  const blocoSmtp = r.corpo.slice(r.corpo.indexOf('id="smtp"'), r.corpo.indexOf('id="teste"'));
  assert.ok(blocoSmtp.length > 0, 'P54-2: o bloco SMTP existe antes da área de teste');
  assert.ok(/<form[^>]*data-me-form[^>]*\bhidden\b/.test(blocoSmtp),
    'P54-2: o formulário SMTP nasce `hidden` (nada submetível sem Editar)');
  assert.ok(blocoSmtp.includes('data-me-editar'), 'P54-2: existe o botão Editar');
  assert.ok(/aria-controls="smtp-form"/.test(blocoSmtp), 'P54-2: o Editar tem `aria-controls`');
  assert.ok(/id="smtp-form"/.test(blocoSmtp), 'P54-2: o `aria-controls` aponta para o id real do formulário');
  assert.ok(/aria-expanded="false"/.test(blocoSmtp), 'P54-2: o Editar nasce com `aria-expanded="false"`');
  // Os campos continuam TODOS lá dentro (nomes preservados) — o padrão é uma
  // camada de apresentação, não uma reescrita do formulário.
  for (const campo of ['name="host"', 'name="port"', 'name="tls"', 'name="user"', 'name="pass"', 'name="from"', 'name="from_name"']) {
    assert.ok(blocoSmtp.includes(campo), `P54-2: o campo ${campo} mantém-se dentro do formulário`);
  }
  // A consulta apresenta a password por ESTADO, com máscara — nunca por valor.
  assert.ok(blocoSmtp.includes('Definida'), 'P54-2: a consulta mostra o estado da password');
  assert.ok(blocoSmtp.includes('me-mascara'), 'P54-2: a password é apresentada com máscara');

  // ⛔ Nenhum caminho pode pôr a password no HTML. Prova-se com um SENTINELA:
  // injeta-se um valor no estado que a vista recebe e exige-se que ele NÃO
  // apareça em lado nenhum da página. Se a vista o imprimisse, apareceria aqui.
  const SENTINELA = 'SEGREDO-QUE-NAO-PODE-SAIR-9f3a';
  estadoSmtpStub = { ...estadoSmtpStub, password: SENTINELA, pass: SENTINELA };
  const rSentinela = await pedir('/admin/config/email');
  assert.ok(!rSentinela.corpo.includes(SENTINELA),
    'P54-2: um valor de password presente no estado NUNCA chega ao HTML');
  estadoSmtpStub = { ...estadoSmtpStub };
  delete estadoSmtpStub.password;
  delete estadoSmtpStub.pass;

  assert.ok(!/name="pass"[^>]*value="[^"]+"/.test(r.corpo), 'P54-2: o campo da password não leva `value`');
  assert.ok(!/data-[a-z-]*pass[a-z-]*\s*=/i.test(r.corpo), 'P54-2: nenhum atributo `data-*` transporta a password');

  // A confirmação com diff (D4b) existe, é acessível e não inventa rotas.
  assert.ok(r.corpo.includes('id="smtpDiffModal"'), 'P54-2: existe a caixa de confirmação com diff');
  assert.ok(/aria-labelledby="smtpDiffTitulo"/.test(r.corpo), 'P54-2: a caixa tem título associado');
  assert.ok(r.corpo.includes('id="smtpDiffCorpo"'), 'P54-2: a caixa tem um corpo onde pintar o diff');
  assert.ok(r.corpo.includes('id="smtpDiffConfirmar"'), 'P54-2: a confirmação é uma ação explícita (botão próprio)');
  assert.ok(r.corpo.includes('action="/admin/config/email/smtp"'),
    'P54-2: a rota de gravação NÃO mudou (nenhum endpoint novo)');
  assert.ok(r.corpo.includes('action="/admin/config/email/smtp/testar"'), 'P54-2: a rota de teste mantém-se');
  assert.ok(r.corpo.includes('action="/admin/config/email/teste"'), 'P54-2: a rota de envio de teste mantém-se');
  // O script do diff é PURO (sem expressões Handlebars), para poder ser extraído
  // e corrido num DOM falso pelo teste específico do P54-2.
  const scriptDiff = (r.corpo.match(/<script>[\s\S]*?<\/script>/g) || [])
    .filter((s) => s.includes('smtpDiffModal'))[0] || '';
  assert.ok(scriptDiff.length > 0, 'P54-2: o script do diff está na página');
  assert.ok(!/\{\{/.test(scriptDiff), 'P54-2: o script do diff não tem expressões Handlebars');

  // 5. Separador 5 — Auditoria (antes com entrada própria no menu principal)
  r = await pedir('/admin/config/auditoria');
  assert.strictEqual(r.status, 200, 'GET /admin/config/auditoria responde 200');
  assert.ok(r.corpo.includes(`class="config-tab active" ${TAB5}`), 'auditoria: separador 5 ativo');
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

  // 6. Navegação direta entre os cinco separadores, a partir de qualquer um
  for (const url of ['/admin/config', '/admin/config/armazenamento', '/admin/config/automacoes', '/admin/config/email', '/admin/config/auditoria']) {
    const x = await pedir(url);
    assert.ok([TAB1, TAB2, TAB3, TAB4, TAB5].every((t) => x.corpo.includes(t)), `navegação: 5 separadores a partir de ${url}`);
    assert.ok(x.corpo.includes('class="config-tab active"'), `navegação: um ativo em ${url}`);
  }

  // 7. Destino de backups: operação da INSTALAÇÃO ⇒ só Super Admin (A6.1).
  // A interface só aceita o que o job consegue usar, e um admin de condomínio
  // não pode mexer no destino global.
  destinosGravados.length = 0;

  // Um admin de CONDOMÍNIO é recusado e NÃO grava nada.
  UTILIZADOR = UTILIZADOR_ADMIN;
  let post = await enviar('/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  assert.strictEqual(post.status, 302, 'backups: admin de condomínio é recusado (302)');
  assert.strictEqual(post.location, '/admin', 'backups: admin de condomínio volta ao painel');
  assert.deepStrictEqual(destinosGravados, [], 'backups: admin de condomínio não altera o destino');

  // Um Super Admin grava — um destino com ligação utilizável…
  UTILIZADOR = UTILIZADOR_SUPER;
  post = await enviar('/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  assert.strictEqual(post.status, 302, 'backups: gravação responde 302');
  assert.strictEqual(post.location, '/admin/config/armazenamento', 'backups: volta para a página');
  assert.deepStrictEqual(destinosGravados, ['dropbox'], 'backups: destino utilizável é gravado');
  // …um destino sem ligação utilizável NÃO é gravado (o job ignorá-lo-ia e os
  // backups ficariam no servidor enquanto a página anunciava uma cópia cloud).
  post = await enviar('/admin/config/armazenamento/backups', { provedor: 'onedrive' });
  assert.strictEqual(post.status, 302, 'backups: destino inutilizável responde 302 (com erro)');
  assert.deepStrictEqual(destinosGravados, ['dropbox'], 'backups: destino sem ligação utilizável não é gravado');
  // …e "só neste servidor" continua a poder ser escolhido em qualquer altura.
  post = await enviar('/admin/config/armazenamento/backups', { provedor: 'nenhum' });
  assert.deepStrictEqual(destinosGravados, ['dropbox', null], 'backups: «só neste servidor» é gravado');
  UTILIZADOR = UTILIZADOR_ADMIN;

  // 7. Desligar um serviço só liberta o destino dos backups quando não resta
  // NENHUMA ligação utilizável para ele (de plataforma ou de um condomínio).
  // Sem esta regra, desligar a ligação da plataforma apagava um destino que
  // continuava a funcionar.
  const registo = require('../helpers/armazenamento/provedores');
  const desligarOriginal = registo.dropbox.desligar;
  const desligados = [];
  registo.dropbox.desligar = async (condominioId, opcoes) => { desligados.push({ condominioId, opcoes }); };
  storage.inicializar = async () => {};
  storage.destinoDeBackup = async () => 'dropbox';
  destinosGravados.length = 0;

  ligacoesBackup.dropbox = { condominioId: 7, conta: 'gestao@exemplo.pt', origem: 'condominio' };
  // P54-4 (reforço): `?ambito=plataforma` é operação da INSTALAÇÃO — um admin de
  // condomínio é RECUSADO e o adaptador NÃO é chamado. Sem esta guarda, um POST
  // direto deixava-o desligar a ligação de que a instalação inteira depende.
  UTILIZADOR = UTILIZADOR_ADMIN;
  await enviar('/admin/config/armazenamento/dropbox/desligar?ambito=plataforma', {});
  assert.deepStrictEqual(desligados, [],
    'desligar: admin de condomínio NÃO chega ao adaptador em âmbito de plataforma');
  assert.deepStrictEqual(destinosGravados, [],
    'desligar: admin de condomínio não altera o destino dos backups');
  // …mas um Super Admin pode: o âmbito de plataforma chega ao adaptador com
  // `condominioId: null` (a ligação da instalação, não a de um condomínio).
  UTILIZADOR = UTILIZADOR_SUPER;
  await enviar('/admin/config/armazenamento/dropbox/desligar?ambito=plataforma', {});
  assert.deepStrictEqual(desligados, [{ condominioId: null, opcoes: { plataforma: true } }],
    'desligar: Super Admin passa o âmbito de plataforma ao adaptador');
  assert.deepStrictEqual(destinosGravados, [],
    'desligar: mantém o destino dos backups enquanto restar uma ligação utilizável');

  ligacoesBackup.dropbox = { condominioId: null, conta: null, origem: null };
  // Âmbito de CONDOMÍNIO (sem `?ambito=plataforma`): um admin de condomínio
  // continua a poder desligá-lo — a guarda nova só trava o âmbito de plataforma.
  UTILIZADOR = UTILIZADOR_ADMIN;
  await enviar('/admin/config/armazenamento/dropbox/desligar', {});
  assert.deepStrictEqual(destinosGravados, [null],
    'desligar: liberta o destino dos backups quando não resta nenhuma ligação utilizável');
  registo.dropbox.desligar = desligarOriginal;

  // 9. Rotas de gravação existentes mantêm-se
  const rotas = router.stack.filter((l) => l.route)
    .map((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path);
  for (const esperada of ['GET /config', 'POST /config', 'GET /config/armazenamento', 'GET /config/automacoes', 'POST /config/automacoes', 'GET /config/email', 'POST /config/email/smtp', 'POST /config/email/smtp/testar', 'POST /config/email/teste', 'GET /config/auditoria', 'GET /auditoria', 'POST /config/armazenamento/provedor', 'GET /config/armazenamento/:provedor/ligar', 'GET /config/armazenamento/:provedor/callback', 'POST /config/armazenamento/:provedor/desligar', 'POST /config/armazenamento/:provedor/testar', 'POST /config/drive/opcoes', 'POST /config/drive/testar', 'POST /config/drive/estrutura', 'POST /config/drive/desligar', 'GET /config/drive/ligar', 'GET /config/drive/callback']) {
    assert.ok(rotas.includes(esperada), `rota preservada: ${esperada}`);
  }
  // Isolamento por condomínio/papel continua aplicado a nível do router.
  // (As rotas novas de Email/SMTP NÃO acrescentam middleware próprio: herdam a
  // guarda do router — `comCondominioAtivo` + `comPapel('admin')` — e por isso
  // ficam fora do alcance do suporte diagnóstico, que não tem papel.)
  const middleware = router.stack.filter((l) => !l.route).length;
  assert.strictEqual(middleware, 2, 'isolamento: middleware de condomínio ativo e papel no router');

  models.UserCondominio.findOne = orig.userCondominioFindOne;
  models.BackupLog.findOne = orig.backupLogFindOne;
  models.AuditLog.findAll = orig.auditLogFindAll;
  models.AuditLog.create = orig.auditLogCreate;

  console.log('✓ Testes dos separadores de Configurações passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
