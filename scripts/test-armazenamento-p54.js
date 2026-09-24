// ═══════════════════════════════════════════════════════════════════
// P54-4 — Modo consulta/edição protegido para Armazenamento e Backups.
//
// Prova quatro camadas:
//   A. VISTA (estática) — as áreas de CAMPOS passam pelo padrão P54-0
//      (`_modo-edicao`), as AÇÕES continuam ações, e não há um único segredo
//      nesta área (nem por campo, nem em `sensivel`, nem no HTML).
//   B. COMPONENTE — o parcial aceita `confirmar` (e só o escreve quando é
//      pedido) e o script NÃO limpa o estado sujo quando o envio foi
//      intercetado pela confirmação. Provado a correr o JS a sério num DOM
//      falso, com eventos a borbulhar (mesmo método do `test-modo-edicao.js`).
//   C. ROTAS (HTTP, sem BD) — autorização, isolamento por condomínio, campo
//      omitido que preserva o valor, valores inválidos recusados e POST
//      direto (sem passar pela interface).
//   D. RETENÇÃO (unidade) — limites, tipos, negativos, valores absurdos,
//      campo omitido e atomicidade (recusar não grava NADA).
//
// Utilização: node scripts/test-armazenamento-p54.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const express = require('express');
const handlebars = require('handlebars');
const { engine } = require('express-handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const falhas = [];
const exigir = (cond, msg) => { if (!cond) falhas.push(msg); };
const ok = (msg) => console.log(`OK   ${msg}`);

const VISTA = 'views/admin/configuracao/armazenamento.handlebars';
const VISTA_GLOBAL = 'views/admin/global/armazenamento.handlebars';
const PARCIAL = 'views/partials/_modo-edicao.handlebars';
const SCRIPT = 'public/js/modo-edicao.js';

// ═══════════════════════════════════════════════════════════════════
// A. A VISTA — o padrão aplicado às áreas de campos
// ═══════════════════════════════════════════════════════════════════
console.log('\n── A. Vista: consulta/edição nas áreas de campos ──');

const vista = ler(VISTA);
const vistaGlobal = ler(VISTA_GLOBAL);

// ── A1. As três áreas de campos do condomínio usam o padrão ─────────
const BLOCOS = [
  { id: 'armazenamentoPrincipal', acao: '/admin/config/armazenamento/principal', o: 'armazenamento dos documentos' },
  { id: 'backupDestino', acao: '/admin/config/armazenamento/backups', o: 'destino dos backups' },
  { id: 'drivePasta', acao: '/admin/config/drive/opcoes', o: 'pasta de destino do Drive' },
];
for (const b of BLOCOS) {
  exigir(new RegExp(`\\{\\{#> _modo-edicao id="${b.id}"`).test(vista),
    `${b.o}: usa o padrão P54-0 com o id «${b.id}»`);
  exigir(vista.includes(`acao="${b.acao}"`), `${b.o}: a ação do bloco é a rota real (${b.acao})`);
}
ok(`as ${BLOCOS.length} áreas de campos usam o padrão P54-0 (ids + ações reais)`);

// ── A2. Já não existe um formulário permanentemente armado ──────────
// A prova é a ausência do `<form>` escrito à mão: o formulário passa a ser
// gerado pelo parcial, com `hidden` no estado de consulta.
for (const b of BLOCOS) {
  const cru = new RegExp(`<form[^>]*action="${b.acao.replace(/[/]/g, '\\/')}"`);
  exigir(!cru.test(vista), `${b.o}: deixou de haver um <form> permanentemente armado na vista`);
}
ok('nenhuma das áreas de campos tem um <form> permanentemente armado');
exigir(/data-modo-edicao/.test(ler(PARCIAL)), 'o formulário passa a vir do parcial (data-modo-edicao)');

// ── A3. As AÇÕES continuam AÇÕES (não são campos) ───────────────────
// Ligar/Desligar/Testar/Estrutura/Limpar são operações, não configuração: o
// padrão consulta/edição não se aplica a elas (a distinção já é a do P54-2).
const ACOES = [
  ['/admin/config/armazenamento/{{nome}}/testar', 'testar ligação'],
  ['/admin/config/armazenamento/{{nome}}/desligar', 'desligar ligação'],
  ['/admin/config/drive/estrutura', 'criar/verificar estrutura'],
];
for (const [acao, o] of ACOES) {
  // Comparação por substring: a rota pode levar `?ambito=plataforma` a seguir.
  exigir(vista.includes(`action="${acao}`), `${o}: continua a ser uma ação (${acao})`);
}
ok(`as ${ACOES.length} ações continuam ações — o padrão só se aplica a campos`);
// A eliminação da ligação (ação destrutiva) mantém a confirmação que já tinha.
exigir(/data-confirmar="[^"]*Desligar/.test(vista), 'desligar mantém a confirmação (ação destrutiva)');
ok('desligar mantém a confirmação adicional que já existia');

// ── A4. Confirmação adicional nas alterações CRÍTICAS ───────────────
// As três alterações que a especificação do P54-4 nomeia como críticas levam
// confirmação: mudar o serviço dos documentos (os documentos NOVOS passam a ir
// para outro lado), mudar o destino dos backups (instalação inteira) e mudar a
// retenção (decide o que a limpeza apaga).
//
// `perigo` distingue o ALCANCE: o estilo de perigo fica para o que muda o
// comportamento de TODA a instalação ou pode levar a eliminação de dados. A
// escolha do serviço dos documentos é significativa mas não é destrutiva (não
// move nem apaga ficheiros), pelo que leva confirmação SEM o estilo de perigo.
const CRITICOS = [
  { id: 'armazenamentoPrincipal', o: 'armazenamento principal', fonte: vista, perigo: false },
  { id: 'backupDestino', o: 'destino dos backups (instalação inteira)', fonte: vista, perigo: true },
  { id: 'retencaoBackups', o: 'retenção (decide o que a limpeza apaga)', fonte: vistaGlobal, perigo: true },
];
for (const c of CRITICOS) {
  const bloco = c.fonte.slice(c.fonte.indexOf(`id="${c.id}"`));
  const corpo = bloco.slice(0, bloco.indexOf('{{/_modo-edicao}}'));
  exigir(/confirmar="/.test(corpo), `${c.o}: leva confirmação adicional ao guardar`);
  if (c.perigo) exigir(/confirmarPerigo="1"/.test(corpo), `${c.o}: a confirmação é marcada como de perigo`);
  else exigir(!/confirmarPerigo/.test(corpo), `${c.o}: NÃO é marcada como de perigo (não é destrutiva)`);
}
ok(`${CRITICOS.length} alterações críticas levam confirmação (${CRITICOS.filter((c) => c.perigo).length} marcadas como de perigo)`);

// ⛔ E não se inventa confirmação onde ela não é necessária: o nome da pasta do
// Drive é reversível, não move nem apaga nada e não muda o destino de nada.
const blocoPasta = vista.slice(vista.indexOf('id="drivePasta"'));
exigir(!/confirmar="/.test(blocoPasta.slice(0, blocoPasta.indexOf('{{/_modo-edicao}}'))),
  'a pasta do Drive NÃO inventa uma confirmação que o risco não justifica');
ok('pasta do Drive sem confirmação inventada (reversível, não move nem apaga)');

// ── A5. Retenção também usa o padrão ────────────────────────────────
exigir(/id="retencaoBackups"/.test(vistaGlobal), 'a retenção usa o padrão P54-0');
exigir(!/<form action="\/global\/armazenamento\/retencao"/.test(vistaGlobal),
  'a retenção deixou de ter um <form> permanentemente armado');
ok('a retenção (a configuração mais destrutiva) usa o padrão e não tem form armado');

// ── A6. SEGREDOS: nesta área não há um único segredo ────────────────
// As credenciais OAuth vivem no `.env` e os tokens em `configuracoes` só mudam
// pelo fluxo OAuth. Se aparecesse uma linha `sensivel` aqui, seria um defeito.
//
// ⛔ A verificação corre sobre os ATRIBUTOS (o interior das tags), não sobre a
// prosa: a vista nomeia de propósito a variável de ambiente
// (`GOOGLE_REFRESH_TOKEN`) para dizer ao administrador onde a remover — o NOME
// não é o segredo, e proibi-lo obrigaria a esconder uma instrução útil.
const NOMES_DE_SEGREDO = ['access_token', 'refresh_token', 'client_secret', 'api_key', 'password', 'palavra-passe'];
const atributosDe = (html) => (html.match(/<[^>]*>/g) || []).join('\n');
for (const vistaAlvo of [VISTA, VISTA_GLOBAL]) {
  const fonte = ler(vistaAlvo);
  const atributos = atributosDe(fonte);
  for (const nome of NOMES_DE_SEGREDO) {
    exigir(!new RegExp(nome, 'i').test(atributos), `${vistaAlvo}: nenhum atributo menciona «${nome}»`);
  }
  exigir(!/sensivel\s*:\s*true/.test(fonte), `${vistaAlvo}: nenhuma linha é marcada como sensível`);
  // Nenhum valor de campo pode vir de um segredo.
  exigir(!/\bvalue="\{\{[^}]*(token|secret|password)/i.test(fonte),
    `${vistaAlvo}: nenhum campo recebe um segredo no \`value\``);
}
ok(`nenhum segredo em atributos nas duas vistas (${NOMES_DE_SEGREDO.length} nomes verificados)`);

// ── A7. Validação de interface coerente com a do servidor ───────────
exigir(/name="provedor"[^>]*required/.test(vista), 'o grupo de rádio é `required` (não se guarda «nada escolhido»)');
exigir(/id="pastaRaiz"[^>]*maxlength="100"/.test(vista),
  'a pasta tem `maxlength` igual ao limite do servidor (100)');
ok('interface: rádio obrigatório e `maxlength` da pasta alinhado com o servidor');

// ═══════════════════════════════════════════════════════════════════
// B. O COMPONENTE — confirmação + estado sujo
// ═══════════════════════════════════════════════════════════════════
console.log('\n── B. Componente: `confirmar` e estado sujo ──');

const fonteParcial = ler(PARCIAL);
handlebars.registerPartial('_modo-edicao', fonteParcial);
const js = ler(SCRIPT);

// ── B1. `confirmar` escreve o `data-confirmar` da aplicação ─────────
const molde = handlebars.compile(
  '{{#> _modo-edicao id="x" acao="/a" linhas=linhas confirmar="Tem a certeza?" '
  + 'confirmarTitulo="T" confirmarAcao="A" confirmarPerigo="1"}}'
  + '<input name="provedor" value="p">'
  + '{{/_modo-edicao}}'
);
const comConfirmar = molde({ linhas: [{ rotulo: 'R', valor: 'V' }] });
const tagCom = (/<form[^>]*data-me-form[^>]*>/.exec(comConfirmar) || [])[0] || '';
exigir(/data-confirmar="Tem a certeza\?"/.test(tagCom), '`confirmar` escreve `data-confirmar` no formulário');
exigir(/data-confirmar-titulo="T"/.test(tagCom), '`confirmarTitulo` é propagado');
exigir(/data-confirmar-acao="A"/.test(tagCom), '`confirmarAcao` é propagado');
exigir(/data-confirmar-perigo="1"/.test(tagCom), '`confirmarPerigo` é propagado');
ok('`confirmar` reutiliza o `data-confirmar` da aplicação (não há um segundo diálogo)');

// ── B2. Sem `confirmar` NÃO se escreve confirmação ──────────────────
const semConfirmar = handlebars.compile(
  '{{#> _modo-edicao id="y" acao="/b" linhas=linhas}}<input name="q" value="1">{{/_modo-edicao}}'
)({ linhas: [{ rotulo: 'R', valor: 'V' }] });
const tagSem = (/<form[^>]*data-me-form[^>]*>/.exec(semConfirmar) || [])[0] || '';
exigir(!/data-confirmar/.test(tagSem), 'sem `confirmar` o formulário não ganha `data-confirmar`');
ok('sem `confirmar` não se inventa confirmação');

// ── B3/B4. Comportamento do script num DOM falso ────────────────────
class No {
  constructor(tag, attrs) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.filhos = []; this.pai = null; this.listeners = {};
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.focos = 0; this.type = this.attrs.type || (this.tagName === 'INPUT' ? 'text' : undefined);
    this.name = this.attrs.name || '';
  }
  get classList() {
    const l = String(this.attrs.class || '').split(/\s+/).filter(Boolean);
    return { contains: (c) => l.includes(c) };
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  focus() { this.focos += 1; }
  juntar(...nos) { nos.forEach((n) => { n.pai = this; this.filhos.push(n); }); return this; }
  get elements() {
    const saida = [];
    (function p(no) { for (const f of no.filhos) { if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(f.tagName)) saida.push(f); p(f); } })(this);
    return saida;
  }
}
function corresponde(el, sel) {
  const s = sel.trim();
  if (s.startsWith('[') && s.endsWith(']')) return el.hasAttribute(s.slice(1, -1));
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  return el.tagName === s.toUpperCase();
}
function descendentes(raiz) {
  const saida = [];
  (function p(no) { for (const f of no.filhos) { saida.push(f); p(f); } })(raiz);
  return saida;
}
No.prototype.closest = function (sel) { let n = this; while (n) { if (corresponde(n, sel)) return n; n = n.pai; } return null; };
No.prototype.querySelector = function (sel) { return descendentes(this).find((n) => corresponde(n, sel)) || null; };

const documento = new No('#document');
documento.addEventListener = No.prototype.addEventListener.bind(documento);
const janela = {
  addEventListener: (t, fn) => documento.addEventListener(`win:${t}`, fn),
  GesConduConfirmar: () => Promise.resolve(true),
};
const sandbox = { document: documento, window: janela, Promise, Set, WeakMap, WeakSet, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: SCRIPT });

// Evento com bolha. `intercetado` simula o `data-confirmar` do `app.js`, que
// corre na fase de CAPTURA e faz `preventDefault` antes deste handler (bolha):
// `defaultPrevented` fica a `true` quando o envio NÃO chegou a acontecer.
function disparar(alvo, tipo, intercetado) {
  const ev = {
    target: alvo,
    defaultPrevented: Boolean(intercetado),
    preventDefault() { ev.travado = true; ev.defaultPrevented = true; },
    travado: false,
  };
  let n = alvo;
  while (n) { (n.listeners[tipo] || []).forEach((fn) => fn(ev)); n = n.pai; }
  return ev;
}
const tick = () => new Promise((r) => setImmediate(r));

function construirBloco() {
  const bloco = new No('div', { 'data-modo-edicao': '', 'data-me-estado': 'consulta' });
  const consulta = new No('div', { 'data-me-consulta': '' });
  const editar = new No('button', { 'data-me-editar': '', 'aria-expanded': 'false' });
  consulta.juntar(editar);
  const form = new No('form', { 'data-me-form': '', id: 'bk-form' });
  form.hidden = true;
  const destino = new No('input', { name: 'provedor', type: 'text' });
  destino.value = 'dropbox';
  const guardar = new No('button', { 'data-me-guardar': '', type: 'submit' });
  const cancelar = new No('button', { 'data-me-cancelar': '', type: 'button' });
  form.juntar(destino, guardar, cancelar);
  bloco.juntar(consulta, form);
  return { bloco, consulta, editar, form, destino, guardar, cancelar };
}

async function comportamento() {
  // B3 — envio INTERCETADO pela confirmação: o estado sujo e os ORIGINAIS têm
  // de sobreviver. Sem a guarda do `defaultPrevented`, o `Cancelar` deixava de
  // conseguir restaurar o valor (o bloco ficava preso em edição).
  let d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.editar, 'click');
  d.destino.value = 'onedrive';
  disparar(d.destino, 'input');
  let ev = disparar(d.form, 'submit', true);          // confirmação pendente
  exigir(ev.travado === false, 'B3: o script não trava o envio intercetado (não é ele que confirma)');
  let evSaida = disparar(documento, 'win:beforeunload');
  exigir(evSaida.travado === true, 'B3: o estado sujo SOBREVIVE ao envio intercetado');
  disparar(d.cancelar, 'click');
  await tick();
  exigir(d.destino.value === 'dropbox',
    'B3: `Cancelar` ainda RESTAURA o valor (os originais não foram descartados pelo envio intercetado)');
  exigir(d.bloco.getAttribute('data-me-estado') === 'consulta', 'B3: volta a consulta');
  ok('envio intercetado pela confirmação não destrói o estado sujo nem os originais');

  // B4 — envio REAL (já confirmado): limpa o estado, para a navegação que o
  // próprio utilizador pediu não ser travada pela guarda de saída.
  d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.editar, 'click');
  d.destino.value = 'onedrive';
  disparar(d.destino, 'input');
  ev = disparar(d.form, 'submit', false);             // envio a sério
  exigir(ev.travado === false, 'B4: em edição o envio segue (o JS não valida)');
  evSaida = disparar(documento, 'win:beforeunload');
  exigir(evSaida.travado === false, 'B4: o envio real limpa o estado sujo');
  ok('envio real limpa o estado sujo (não bloqueia a navegação pedida)');
}

// ═══════════════════════════════════════════════════════════════════
// C. AS ROTAS — autorização, isolamento, campo omitido, POST direto
// ═══════════════════════════════════════════════════════════════════
console.log('\n── C. Rotas (HTTP, sem BD) ──');

const models = require('../models');
models.UserCondominio.findOne = async () => ({ role: 'admin', condominio_id: 1 });
models.BackupLog.findOne = async () => null;
models.AuditLog.create = async () => ({});

const condominio = require('../helpers/condominio');
condominio.getCondominio = async () => ({ id: 1, designacao: 'Condomínio Teste', toJSON() { return this; } });

// Configurações: captura-se o que é ESCRITO (para provar campo omitido).
const config = require('../helpers/config');
const configGravada = [];
config.getConfig = async (chave, defeito) => (chave === 'drive_auto_backups' ? '1' : defeito);
config.setConfig = async (chave, valor) => { configGravada.push({ chave, valor }); return {}; };

const drive = require('../helpers/drive');
drive.estadoLigacao = async () => ({ ligado: true, ativo: true, credenciais: true, viaEnv: false, conta: 'admin@gmail.com' });

const porServico = require('../helpers/documentos-por-servico');
porServico.contarPorServico = async () => ({});
porServico.documentosDoServico = () => 0;

const tips = require('../helpers/tips/contexto');
tips.tipsDaPagina = async () => ({ apresentar: [], total: 0, outras: [], limite: 0 });

// ── Storage: estado mutável, para controlar cada cenário ────────────
const storage = require('../helpers/storage');
const estado = {
  provedores: [
    { nome: 'google_drive', rotulo: 'Google Drive', icone: 'bi bi-google', ligado: true, principal: false, disponivel: true, conta: 'a@gmail.com' },
    { nome: 'dropbox', rotulo: 'Dropbox', icone: 'bi bi-dropbox', ligado: true, principal: true, disponivel: true, conta: 'a@dropbox.com' },
    { nome: 'onedrive', rotulo: 'OneDrive', icone: 'bi bi-microsoft', ligado: false, principal: false, disponivel: true },
  ],
  backup: { destino: 'dropbox', rotulo: 'Dropbox', conta: 'backups@exemplo.pt', icone: 'bi bi-dropbox', usavel: true, avisoPartilhado: false },
};
const principaisGravados = [];
const destinosGravados = [];
let ligacaoBackup = { condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' };

storage.provedores = () => estado.provedores.map((p) => p.nome);
storage.estadoDoCondominio = async () => ({
  escolhido: 'dropbox',
  temLigacoes: true,
  backup: { ...estado.backup },
  provedores: estado.provedores.map((p) => ({ ...p })),
});
storage.obterProvedor = (nome) => {
  const p = estado.provedores.find((x) => x.nome === nome);
  if (!p) return null;
  return {
    rotulo: () => p.rotulo,
    icone: () => p.icone,
    isConfigured: () => p.ligado,
    desligar: async () => {},
    testarLigacao: async () => ({ ok: true, conta: p.conta || null }),
  };
};
storage.definirPrincipalDoCondominio = async (cid, nome) => { principaisGravados.push({ cid, nome }); return nome; };
storage.ligacaoDeBackup = () => ligacaoBackup;
storage.definirDestinoDeBackup = async (nome) => { destinosGravados.push(nome === undefined ? null : nome); return nome; };
storage.inicializar = async () => {};

const router = require('../routes/configuracao');

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

// O utilizador é mutável: as operações da INSTALAÇÃO exigem Super Admin.
let UTILIZADOR = { id: 1, nome: 'Admin', email: 'a@b.pt', role_global: 'admin' };
const SESSION = { condominio_ativo_id: 1 };
const flashes = [];

app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = UTILIZADOR;
  req.session = SESSION;
  req.flash = (tipo, msg) => { if (msg) flashes.push({ tipo, msg }); return req; };
  res.locals.user = req.user;
  res.locals.isAdmin = true;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = { id: 1, designacao: 'Condomínio Teste', role: 'admin' };
  res.locals.condominio = { id: 1, designacao: 'Condomínio Teste' };
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = new Date().getFullYear();
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use('/admin', router);

const pedir = (url) => new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: s.address().port, path: url }, (res) => {
      let c = ''; res.on('data', (d) => { c += d; });
      res.on('end', () => { s.close(); resolve({ status: res.statusCode, corpo: c, location: res.headers.location }); });
    }).on('error', (e) => { s.close(); reject(e); });
  });
});
const enviar = (url, corpo) => new Promise((resolve, reject) => {
  const dados = new URLSearchParams(corpo || {}).toString();
  const s = app.listen(0, '127.0.0.1', () => {
    const req = http.request({
      host: '127.0.0.1', port: s.address().port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) },
    }, (res) => {
      let c = ''; res.on('data', (d) => { c += d; });
      res.on('end', () => { s.close(); resolve({ status: res.statusCode, corpo: c, location: res.headers.location }); });
    });
    req.on('error', (e) => { s.close(); reject(e); });
    req.end(dados);
  });
});
const ultimoFlash = () => (flashes.length ? flashes[flashes.length - 1] : null);
const limpar = () => { flashes.length = 0; };

async function rotas() {
  // ── C1. A página nasce em CONSULTA e mostra os valores como texto ──
  let r = await pedir('/admin/config/armazenamento');
  exigir(r.status === 200, `C1: GET responde 200 (${r.status})`);
  exigir(/data-me-estado="consulta"/.test(r.corpo), 'C1: os blocos nascem em `consulta`');
  exigir(/data-me-form[^>]*hidden/.test(r.corpo), 'C1: os formulários nascem `hidden`');
  exigir(/Dropbox/.test(r.corpo), 'C1: o serviço principal aparece (como texto)');
  exigir(/backups@exemplo\.pt/.test(r.corpo), 'C1: a conta do destino aparece (não é segredo)');
  ok('C1: página em consulta, com os valores atuais apresentados');

  // ── C2. Nenhum segredo no HTML servido ────────────────────────────
  // Sobre os ATRIBUTOS (o interior das tags): é aí que um segredo chegaria ao
  // browser. A prosa pode nomear a variável de ambiente (não é o segredo).
  const atributosServidos = atributosDe(r.corpo);
  for (const nome of NOMES_DE_SEGREDO) {
    exigir(!new RegExp(nome, 'i').test(atributosServidos), `C2: nenhum atributo do HTML contém «${nome}»`);
  }
  ok('C2: o HTML servido não entrega nenhum segredo em atributos');

  // ── C3. POST direto válido grava no condomínio da SESSÃO ──────────
  principaisGravados.length = 0; limpar();
  r = await enviar('/admin/config/armazenamento/principal', { provedor: 'google_drive' });
  exigir(principaisGravados.length === 1, 'C3: o POST válido grava (a rota é a autoridade, não a interface)');
  exigir(principaisGravados[0].cid === 1, 'C3: grava no condomínio da SESSÃO (id 1)');
  exigir(principaisGravados[0].nome === 'google_drive', 'C3: grava o serviço pedido');
  ok('C3: POST direto válido grava no condomínio da sessão');

  // ── C4. ISOLAMENTO: `condominio_id` no corpo é IGNORADO ───────────
  principaisGravados.length = 0;
  await enviar('/admin/config/armazenamento/principal', { provedor: 'google_drive', condominio_id: '999' });
  exigir(principaisGravados.length === 1 && principaisGravados[0].cid === 1,
    'C4: `condominio_id` enviado no corpo é IGNORADO (o condomínio vem da sessão)');
  ok('C4: não se pode alterar outro condomínio por `condominio_id` no corpo');

  // ── C5. Serviço NÃO ligado a este condomínio é recusado ───────────
  principaisGravados.length = 0; limpar();
  await enviar('/admin/config/armazenamento/principal', { provedor: 'onedrive' });
  exigir(principaisGravados.length === 0, 'C5: um serviço não ligado NÃO é aceite como principal');
  exigir(/error/i.test(ultimoFlash() ? ultimoFlash().tipo : ''), 'C5: e a recusa é comunicada');
  ok('C5: serviço não ligado é recusado (e nada é gravado)');

  // ── C6. Serviço inexistente é recusado ────────────────────────────
  principaisGravados.length = 0; limpar();
  await enviar('/admin/config/armazenamento/principal', { provedor: 'servico-inventado' });
  exigir(principaisGravados.length === 0, 'C6: um serviço inventado NÃO é aceite');
  ok('C6: serviço inexistente é recusado');

  // ── C7. Destino de backups: só Super Admin ────────────────────────
  UTILIZADOR = { id: 1, nome: 'Admin', email: 'a@b.pt', role_global: 'admin' };
  destinosGravados.length = 0; limpar();
  r = await enviar('/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  exigir(destinosGravados.length === 0, 'C7: um admin de condomínio NÃO muda o destino dos backups');
  exigir(r.status === 302, 'C7: é redirecionado (recusa), não grava');
  ok('C7: o destino dos backups (da instalação) exige Super Admin');

  // ── C8. Com Super Admin e ligação utilizável: grava ───────────────
  UTILIZADOR = { id: 9, nome: 'Super', email: 's@b.pt', role_global: 'super_admin' };
  destinosGravados.length = 0; limpar();
  await enviar('/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  exigir(destinosGravados.length === 1 && destinosGravados[0] === 'dropbox',
    'C8: com Super Admin e ligação utilizável, o destino é gravado');
  ok('C8: Super Admin grava o destino quando a ligação é utilizável');

  // ── C9. Destino sem ligação utilizável é recusado ─────────────────
  destinosGravados.length = 0; limpar();
  ligacaoBackup = { condominioId: null, conta: null, origem: null };
  await enviar('/admin/config/armazenamento/backups', { provedor: 'dropbox' });
  exigir(destinosGravados.length === 0, 'C9: um destino sem ligação utilizável é recusado');
  ok('C9: destino sem ligação utilizável é recusado (o job não o poderia usar)');
  ligacaoBackup = { condominioId: null, conta: 'backups@exemplo.pt', origem: 'plataforma' };

  // ── C10. CAMPO OMITIDO preserva o valor (drive/opcoes) ────────────
  configGravada.length = 0; limpar();
  await enviar('/admin/config/drive/opcoes', { pasta_raiz: 'Documentos' });
  const chaves = configGravada.map((c) => c.chave);
  exigir(chaves.includes('google_drive_root_folder'), 'C10: a pasta é gravada');
  exigir(!chaves.includes('drive_auto_backups'),
    'C10: `drive_auto_backups` NÃO é tocado quando o campo é omitido (antes era desligado em silêncio)');
  ok('C10: campo omitido preserva o valor — a cópia automática não é desligada por omissão');

  // ── C11. Campo PRESENTE é gravado ─────────────────────────────────
  configGravada.length = 0; limpar();
  await enviar('/admin/config/drive/opcoes', { pasta_raiz: 'Documentos', backups_drive: 'on' });
  const auto = configGravada.find((c) => c.chave === 'drive_auto_backups');
  exigir(auto && auto.valor === '1', 'C11: com o campo presente, a opção é gravada');
  ok('C11: campo presente é gravado');

  // ── C12. Nome de pasta inválido é recusado ────────────────────────
  for (const [mau, porque] of [['a/b', 'separador «/»'], ['a\\b', 'separador «\\»'], ['x'.repeat(101), 'demasiado longo']]) {
    configGravada.length = 0; limpar();
    await enviar('/admin/config/drive/opcoes', { pasta_raiz: mau });
    exigir(configGravada.length === 0, `C12: nome com ${porque} é recusado e NADA é gravado`);
  }
  ok('C12: nomes de pasta inválidos (separadores, demasiado longos) são recusados');

  // ── C13. Pedido sem nenhum campo é recusado ───────────────────────
  configGravada.length = 0; limpar();
  await enviar('/admin/config/drive/opcoes', {});
  exigir(configGravada.length === 0, 'C13: um pedido sem campos não grava nada');
  ok('C13: pedido vazio é recusado');

  // ── C14. Campos inesperados são ignorados ─────────────────────────
  configGravada.length = 0; limpar();
  await enviar('/admin/config/drive/opcoes', { pasta_raiz: 'Ok', administrador: '1', __proto__: 'x' });
  const inesperado = configGravada.find((c) => !['google_drive_root_folder', 'drive_auto_backups'].includes(c.chave));
  exigir(!inesperado, 'C14: campos inesperados não são gravados (só as chaves conhecidas)');
  ok('C14: campos inesperados são ignorados');
}

// ═══════════════════════════════════════════════════════════════════
// D. RETENÇÃO — limites, tipos, omissão e atomicidade
// ═══════════════════════════════════════════════════════════════════
console.log('\n── D. Retenção: validação e atomicidade ──');

async function retencao() {
  const ret = require('../helpers/backup-retencao');

  // ── D1. Valores inválidos são recusados ───────────────────────────
  const INVALIDOS = [
    [-1, 'negativo'],
    [0, 'zero'],
    [29, 'abaixo do mínimo'],
    [36501, 'acima do máximo'],
    [30.5, 'não inteiro'],
    ['abc', 'não numérico'],
    ['', 'vazio'],
    [null, 'nulo'],
    [undefined, 'omitido'],
  ];
  for (const [valor, porque] of INVALIDOS) {
    const r = await ret.gravarConfiguracao({ retencaoLocal: valor, retencaoCloud: 90 });
    exigir(r.ok === false, `D1: retenção local ${porque} é recusada`);
  }
  ok(`D1: ${INVALIDOS.length} valores inválidos recusados (negativo, zero, fora dos limites, não inteiro, não numérico, vazio, omitido)`);

  // ── D2. O mínimo e o máximo são exatamente os declarados ──────────
  let r = await ret.gravarConfiguracao({ retencaoLocal: ret.DIAS_MINIMO, retencaoCloud: ret.DIAS_MINIMO });
  exigir(r.ok === true, `D2: o mínimo (${ret.DIAS_MINIMO}) é aceite`);
  r = await ret.gravarConfiguracao({ retencaoLocal: ret.DIAS_MAXIMO, retencaoCloud: ret.DIAS_MAXIMO });
  exigir(r.ok === true, `D2: o máximo (${ret.DIAS_MAXIMO}) é aceite`);
  r = await ret.gravarConfiguracao({ retencaoLocal: ret.DIAS_MINIMO - 1, retencaoCloud: 90 });
  exigir(r.ok === false, 'D2: um dia abaixo do mínimo é recusado');
  r = await ret.gravarConfiguracao({ retencaoLocal: ret.DIAS_MAXIMO + 1, retencaoCloud: 90 });
  exigir(r.ok === false, 'D2: um dia acima do máximo é recusado');
  ok('D2: limites exatos (mínimo e máximo) — nem um dia a menos, nem um a mais');

  // ── D3. ATOMICIDADE: recusar não grava NADA ───────────────────────
  // O 2.º valor é válido; se a gravação fosse feita à medida da validação, a
  // retenção cloud ficaria alterada com a local recusada.
  configGravada.length = 0;
  r = await ret.gravarConfiguracao({ retencaoLocal: 5, retencaoCloud: 365 });
  exigir(r.ok === false, 'D3: um valor inválido recusa o pedido inteiro');
  exigir(configGravada.length === 0, 'D3: e NADA é gravado (nem o valor válido do outro campo)');
  ok('D3: recusar é atómico — não grava nenhum dos campos');

  // ── D4. O limite informativo nunca é negativo nem zero ────────────
  configGravada.length = 0;
  r = await ret.gravarConfiguracao({ retencaoLocal: 90, retencaoCloud: 90, limiteLocalGb: -5 });
  exigir(r.ok === false, 'D4: um limite informativo negativo é recusado');
  exigir(configGravada.length === 0, 'D4: e nada é gravado');
  configGravada.length = 0;
  r = await ret.gravarConfiguracao({ retencaoLocal: 90, retencaoCloud: 90, limiteLocalGb: '' });
  exigir(r.ok === true, 'D4: limite vazio é aceite (sem limite definido)');
  ok('D4: o limite informativo recusa valores não positivos e aceita o vazio');

  // ── D5. A retenção é por IDADE, e o último backup válido é protegido ─
  const agora = new Date('2026-09-24T12:00:00Z');
  const dias = (n) => new Date(agora.getTime() - n * 86400000);
  const selecao = ret.selecionarPorIdade({
    itens: [
      { criadoEm: dias(200), valido: true },
      { criadoEm: dias(100), valido: true },
      { criadoEm: dias(50), valido: true },
    ],
    dias: 30,
    agora,
  });
  exigir(selecao.apagar.length === 2, 'D5: são selecionados para apagar os que excedem a retenção');
  exigir(selecao.protegido !== null, 'D5: o backup mais recente válido é preservado');
  exigir(!selecao.apagar.includes(selecao.protegido), 'D5: o protegido não está na lista de apagar');
  ok('D5: retenção por idade, com o último backup válido sempre preservado');
}

// ═══════════════════════════════════════════════════════════════════
(async () => {
  await comportamento();
  await rotas();
  await retencao();

  if (falhas.length) {
    assert.fail(`invariantes do P54-4 violadas:\n  - ${falhas.join('\n  - ')}`);
  }
  console.log('\n✓ P54-4 conforme: consulta/edição em armazenamento, backups e retenção;'
    + ' rotas com autorização, isolamento e campo omitido preservado.');
})().catch((e) => { console.error('✗ ' + e.message); if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });
