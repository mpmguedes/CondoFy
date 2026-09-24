// ═══════════════════════════════════════════════════════════════════
// P54-2 — Confirmação com diff da configuração SMTP (D4b).
//
// O script do diff vive INLINE em `views/admin/configuracao/email.handlebars`
// (não se criou um ficheiro novo nem se tocou no layout). Aqui ele é
// EXTRAÍDO da vista e corrido a SÉRIO num DOM falso — a mesma técnica do
// `test-modo-edicao.js`. Sem isto, as regras do diff seriam afirmações.
//
// ⛔ Este teste NÃO trata a confirmação como controlo de segurança: ela é de
// INTERFACE. A confirmação server-side é o P54-3. O que se prova aqui é que a
// caixa mostra o que vai mudar, que NENHUM segredo passa por ela e que não há
// envio quando não há alterações.
//
// Utilização: node scripts/test-modo-edicao-smtp.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const VISTA = 'views/admin/configuracao/email.handlebars';
const PARCIAL = 'views/partials/_modo-edicao.handlebars';

const falhas = [];
const exigir = (cond, msg) => { if (!cond) falhas.push(msg); };
const ok = (msg) => console.log(`OK   ${msg}`);

// ═══════════════════════════════════════════════════════════════════
// A. Extração e coerência com o P54-0
// ═══════════════════════════════════════════════════════════════════
console.log('\n── A. O script do diff e o acoplamento com o P54-0 ──');

const fonteVista = fs.readFileSync(path.join(RAIZ, VISTA), 'utf8');
const fonteParcial = fs.readFileSync(path.join(RAIZ, PARCIAL), 'utf8');

const script = (fonteVista.match(/<script>[\s\S]*?<\/script>/g) || [])
  .filter((s) => s.includes('smtpDiffModal'))[0] || '';
exigir(script.length > 0, 'o script do diff existe na vista');
const codigo = script.replace(/^<script>/, '').replace(/<\/script>$/, '');
exigir(!/\{\{/.test(codigo), 'o script é PURO (sem expressões Handlebars) — pode ser corrido isolado');
ok('script extraído da vista e sem expressões Handlebars');

// O parcial P54-0 gera o id do formulário como `<id>-form`. Se um dia mudar,
// este teste avisa antes de a página deixar de funcionar em silêncio.
exigir(/id="\{\{id\}\}-form"/.test(fonteParcial),
  'o parcial P54-0 continua a gerar `<id>-form` (o id de que o script depende)');
exigir(/getElementById\('smtp-form'\)/.test(codigo),
  'o script liga-se ao id `smtp-form`, que é o que `id="smtp"` produz no parcial');
exigir(/{{#> _modo-edicao id="smtp"/.test(fonteVista),
  'a vista invoca o parcial com `id="smtp"` (o mesmo de que o script depende)');
ok('o id do formulário é coerente entre a vista, o parcial e o script');

// ═══════════════════════════════════════════════════════════════════
// B. DOM falso
// ═══════════════════════════════════════════════════════════════════
console.log('\n── B. Comportamento do diff (DOM falso) ──');

class No {
  constructor(tag, attrs) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.filhos = [];
    this.pai = null;
    this.listeners = {};
    this.value = '';
    this.textContent = '';
  }
  get firstChild() { return this.filhos[0] || null; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  juntar(...nos) { nos.forEach((n) => { n.pai = this; this.filhos.push(n); }); return this; }
  appendChild(n) { return this.juntar(n); }
  removeChild(n) { const i = this.filhos.indexOf(n); if (i >= 0) this.filhos.splice(i, 1); return n; }
}

// Seletor do script: `[attr]`, `tag[attr="valor"]`, `.classe` ou `tag`.
// ⛔ Tem de suportar o COMPOSTO: `label[for="smtp_host"]` (rótulo do campo) e
// `option[selected]` (valor original do select) são os dois que o script usa —
// sem eles, o diff mostraria o `name` em vez do rótulo e detetaria uma
// alteração de TLS que não existe.
function corresponde(el, sel) {
  const s = sel.trim();
  const comAtributo = /^([a-zA-Z][\w-]*)?\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
  if (comAtributo) {
    const [, tag, attr, valor] = comAtributo;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (!el.hasAttribute(attr)) return false;
    return valor === undefined ? true : el.getAttribute(attr) === valor;
  }
  const comClasse = /^([a-zA-Z][\w-]*)?\.([\w-]+)$/.exec(s);
  if (comClasse) {
    const [, tag, cls] = comClasse;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    return String(el.attrs.class || '').split(/\s+/).includes(cls);
  }
  return el.tagName === s.toUpperCase();
}
function descendentes(raiz) {
  const saida = [];
  (function p(no) { for (const f of no.filhos) { saida.push(f); p(f); } })(raiz);
  return saida;
}
No.prototype.querySelector = function (sel) { return descendentes(this).find((n) => corresponde(n, sel)) || null; };
No.prototype.querySelectorAll = function (sel) { return descendentes(this).filter((n) => corresponde(n, sel)); };

// Um campo do formulário: `label` + `input`/`select` com valor original.
function campo(tipo, nome, id, rotulo, valorOriginal, opcoes) {
  const lab = new No('label', { for: id });
  lab.textContent = rotulo;
  let el;
  if (tipo === 'select') {
    el = new No('select', { name: nome, id });
    el.value = valorOriginal;
    for (const o of opcoes) {
      const opt = new No('option', { value: o.valor });
      if (o.valor === valorOriginal) opt.setAttribute('selected', '');
      opt.textContent = o.texto;
      opt.value = o.valor;
      el.juntar(opt);
    }
  } else {
    el = new No('input', { name: nome, id, value: valorOriginal, type: tipo });
    el.value = valorOriginal;
  }
  return { lab, el };
}

// Monta o formulário com os campos REAIS da página SMTP.
function montarFormulario() {
  const form = new No('form', { id: 'smtp-form', 'data-me-form': '', 'data-modo-edicao': '' });
  const campos = [
    campo('text', 'host', 'smtp_host', 'Servidor SMTP', 'smtp.gmail.com'),
    campo('text', 'port', 'smtp_port', 'Porta', '587'),
    campo('select', 'tls', 'smtp_tls', 'Segurança', 'true', [
      { valor: 'true', texto: 'Usar TLS (587/465)' }, { valor: 'false', texto: 'Sem TLS' },
    ]),
    campo('text', 'user', 'smtp_user', 'Utilizador', 'condominio@gmail.com'),
    campo('password', 'pass', 'smtp_pass', 'Password (deixe vazio para manter a atual)', ''),
    campo('email', 'from', 'smtp_from', 'Email do remetente', 'condominio@gmail.com'),
    campo('text', 'from_name', 'smtp_from_name', 'Nome do remetente', 'Administração do Condomínio'),
  ];
  const nos = [];
  for (const c of campos) { nos.push(c.lab, c.el); }
  form.juntar(...nos);
  form.elements = campos.map((c) => c.el);
  form.envios = 0;
  form.submitsNativos = 0;
  form.requestSubmit = function () { form.envios += 1; };
  // O fallback para browsers sem `requestSubmit` despacha um evento sintético
  // (para o P54-0 limpar o estado sujo) e chama `form.submit()`. Os dois têm de
  // existir no duplo, senão o caminho antigo não era testado de facto.
  form.dispatchEvent = function (ev) { (form.listeners.submit || []).forEach((fn) => fn(ev)); return true; };
  form.submit = function () { form.submitsNativos += 1; };
  return { form, campos: Object.fromEntries(campos.map((c, i) => [['host', 'port', 'tls', 'user', 'pass', 'from', 'from_name'][i], c.el])) };
}

function ambiente(form, opcoes) {
  opcoes = opcoes || {};
  const corpo = new No('tbody', { id: 'smtpDiffCorpo' });
  const botaoConfirmar = new No('button', { id: 'smtpDiffConfirmar' });
  const modalEl = new No('div', { id: 'smtpDiffModal' });
  const porId = { 'smtp-form': form, smtpDiffModal: modalEl, smtpDiffCorpo: corpo, smtpDiffConfirmar: botaoConfirmar };
  const modal = { mostrado: 0, escondido: 0 };
  const ModalFalso = class { show() { modal.mostrado += 1; } hide() { modal.escondido += 1; } };
  // `readyState` e a presença do `bootstrap` são configuráveis: é o que permite
  // reproduzir a ordem real do layout (conteúdo da vista ANTES do Bootstrap).
  const documento = {
    readyState: opcoes.readyState || 'complete',
    listeners: {},
    getElementById: (id) => porId[id] || null,
    createElement: (tag) => new No(tag),
    addEventListener: (t, fn) => { (documento.listeners[t] = documento.listeners[t] || []).push(fn); },
  };
  const avisos = [];
  const janela = {
    GesConduAviso: (texto) => avisos.push(texto),
    alert: (texto) => avisos.push(texto),
  };
  const sandbox = {
    document: documento,
    window: janela,
    bootstrap: opcoes.semBootstrap ? undefined : { Modal: ModalFalso },
    Event: class { constructor(tipo, o) { this.type = tipo; this.bubbles = !!(o && o.bubbles); } },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(codigo, sandbox, { filename: VISTA });
  return { corpo, botaoConfirmar, modal, avisos, janela, documento, sandbox, ModalFalso };
}

// Dispara o `submit` do formulário. `stopPropagation` é contado, porque é o que
// impede o P54-0 de limpar o estado sujo num envio que ainda não aconteceu.
function submeter(form) {
  const ev = { target: form, preventDefault() { ev.travado = true; }, stopPropagation() { ev.parado = true; }, travado: false, parado: false };
  (form.listeners.submit || []).forEach((fn) => fn(ev));
  return ev;
}
const linhas = (corpo) => corpo.filhos.map((tr) => tr.filhos.map((c) => c.textContent));

// ── B1. Sem alterações: não submete e avisa ─────────────────────────
let m = montarFormulario();
let amb = ambiente(m.form);
let ev = submeter(m.form);
exigir(ev.travado === true, 'B1: sem alterações o envio é travado (não há gravação desnecessária)');
exigir(ev.parado === true, 'B1: o evento não chega ao P54-0 (o estado sujo mantém-se)');
exigir(amb.modal.mostrado === 0, 'B1: sem alterações não abre a caixa de confirmação');
exigir(amb.avisos.length === 1 && /Não há alterações/.test(amb.avisos[0]),
  'B1: sem alterações explica porquê, em vez de gravar em silêncio');
ok('sem alterações: não submete, não abre a caixa e explica porquê');

// ── B2. Uma alteração gera diff e abre a confirmação ────────────────
m = montarFormulario();
amb = ambiente(m.form);
m.campos.host.value = 'smtp.outro.pt';
ev = submeter(m.form);
exigir(ev.travado === true, 'B2: com alterações o envio é travado até haver confirmação');
exigir(amb.modal.mostrado === 1, 'B2: a caixa de confirmação abre');
const tabela = linhas(amb.corpo);
exigir(tabela.length === 2, `B2: o diff tem a alteração + a linha da password (obtido: ${tabela.length})`);
exigir(tabela[0][0] === 'Servidor SMTP' && tabela[0][1] === 'smtp.gmail.com' && tabela[0][2] === 'smtp.outro.pt',
  `B2: a linha mostra o campo e o antes→depois (obtido: ${JSON.stringify(tabela[0])})`);
ok('alteração: o diff mostra «campo · antes · depois» e a confirmação é pedida');

// ── B3. Só os campos ALTERADOS entram no diff ───────────────────────
m = montarFormulario();
amb = ambiente(m.form);
m.campos.port.value = '465';
submeter(m.form);
const t3 = linhas(amb.corpo);
exigir(t3.length === 2, 'B3: um só campo alterado dá uma só linha (+ password)');
exigir(t3[0][0] === 'Porta', 'B3: a linha é a do campo alterado, não a de outro');
exigir(!t3.some((l) => l[0] === 'Servidor SMTP'), 'B3: um campo não alterado NÃO aparece no diff');
ok('o diff mostra apenas os campos alterados');

// ── B4. TLS apresentado de forma legível ────────────────────────────
m = montarFormulario();
amb = ambiente(m.form);
m.campos.tls.value = 'false';
submeter(m.form);
const t4 = linhas(amb.corpo);
exigir(t4.length === 2 && t4[0][0] === 'Segurança', 'B4: a alteração do TLS entra no diff');
exigir(t4[0][1] === 'Usar TLS (587/465)' && t4[0][2] === 'Sem TLS',
  `B4: o TLS é apresentado pelo texto legível, não por true/false (obtido: ${JSON.stringify(t4[0])})`);
exigir(!JSON.stringify(t4).includes('"true"') && !JSON.stringify(t4).includes('"false"'),
  'B4: nenhum valor cru true/false aparece no diff');
ok('TLS legível no diff («Usar TLS (587/465)» → «Sem TLS»)');

// ── B5. A password NUNCA aparece no diff ────────────────────────────
m = montarFormulario();
amb = ambiente(m.form);
m.campos.pass.value = 'UmaPasswordMuitoSecreta-42';
submeter(m.form);
const t5 = linhas(amb.corpo);
const serializado = JSON.stringify(t5);
exigir(!serializado.includes('UmaPasswordMuitoSecreta-42'),
  'B5: o conteúdo da password NÃO aparece no diff');
exigir(t5.some((l) => l[0] === 'Password' && l[1] === '(mantida)' && l[2] === '(alterada)'),
  `B5: com password preenchida o diff diz «(mantida) → (alterada)» (obtido: ${serializado})`);
ok('password preenchida: o diff diz «(alterada)» e nunca mostra o conteúdo');

// ── B6. Password mantida ≠ password vazia ───────────────────────────
m = montarFormulario();
amb = ambiente(m.form);
m.campos.from.value = 'novo@exemplo.pt';   // altera OUTRO campo, password fica vazia
submeter(m.form);
const t6 = linhas(amb.corpo);
exigir(t6.some((l) => l[0] === 'Password' && l[1] === '(mantida)' && l[2] === '(mantida)'),
  `B6: com o campo vazio a password é «(mantida)», não «(alterada)» (obtido: ${JSON.stringify(t6)})`);
ok('password vazia: interpretada como «(mantida)» — não é confundida com «(alterada)»');

// ── B7. Só a password preenchida, sem mais alterações, já pede confirmação ──
m = montarFormulario();
amb = ambiente(m.form);
m.campos.pass.value = 'OutraPasswordSecreta-7';
submeter(m.form);
exigir(amb.modal.mostrado === 1, 'B7: fornecer uma password nova é uma alteração a confirmar');
const t7 = linhas(amb.corpo);
exigir(t7.length === 1, 'B7: o diff só tem a linha da password (não há mais alterações)');
exigir(!JSON.stringify(t7).includes('OutraPasswordSecreta-7'), 'B7: e continua a não mostrar o conteúdo');
ok('password nova sozinha: pede confirmação e não revela o conteúdo');

// ── B8. Confirmar submete; o segundo envio não é travado ────────────
m = montarFormulario();
amb = ambiente(m.form);
m.campos.host.value = 'smtp.outro.pt';
submeter(m.form);
amb.botaoConfirmar.listeners.click.forEach((fn) => fn({}));
exigir(amb.modal.escondido === 1, 'B8: confirmar fecha a caixa');
exigir(m.form.envios === 1, 'B8: confirmar submete UMA vez');
exigir(m.form.getAttribute('data-smtp-confirmado') === '1',
  'B8: a marca do envio confirmado fica no formulário até o segundo envio a consumir');
const ev2 = submeter(m.form);
exigir(ev2.travado === false, 'B8: o envio já confirmado NÃO volta a ser travado');
exigir(ev2.parado === false, 'B8: e deixa o evento chegar ao P54-0 (que limpa o estado sujo)');
exigir(m.form.getAttribute('data-smtp-confirmado') === null, 'B8: a marca é de UM só envio');
ok('confirmar submete uma vez e o segundo envio segue limpo para o P54-0');

// ── B9. Cancelar a caixa não submete ────────────────────────────────
m = montarFormulario();
amb = ambiente(m.form);
m.campos.host.value = 'smtp.outro.pt';
submeter(m.form);
exigir(m.form.envios === 0, 'B9: abrir a caixa não submete nada');
exigir(m.form.getAttribute('data-smtp-confirmado') === null, 'B9: sem confirmação não fica marca nenhuma');
ok('abrir (e fechar) a caixa não submete — a gravação exige a ação explícita');

// ── B10. Sem `requestSubmit` (browser antigo) continua a submeter ───
m = montarFormulario();
amb = ambiente(m.form);
delete m.form.requestSubmit;
m.campos.host.value = 'smtp.outro.pt';
submeter(m.form);
amb.botaoConfirmar.listeners.click.forEach((fn) => fn({}));
exigir(m.form.submitsNativos === 1, 'B10: o fallback submete na mesma (uma vez)');
exigir(m.form.getAttribute('data-smtp-confirmado') === null,
  'B10: a marca é consumida pelo evento sintético (o aviso de saída não fica preso)');
ok('browser sem `requestSubmit`: o fallback submete e consome a marca antes do envio');

// ── B11. O Bootstrap chega DEPOIS do conteúdo da vista ──────────────
// ⛔ Defeito REAL, medido no browser: o layout põe o Bootstrap no fim do
// `<body>`, pelo que neste ponto `bootstrap` ainda não existe. A guarda
// abandonava o script EM SILÊNCIO e a confirmação com diff nunca acontecia —
// em produção, sem erro nenhum na consola. O script tem de ESPERAR pelo
// `DOMContentLoaded`, que corre depois de todos os scripts do layout.
m = montarFormulario();
amb = ambiente(m.form, { readyState: 'loading', semBootstrap: true });
const ouvintesDCL = amb.documento.listeners.DOMContentLoaded || [];
exigir(ouvintesDCL.length === 1,
  'B11: com o documento a carregar, o script ESPERA pelo DOMContentLoaded (não desiste em silêncio)');
exigir(amb.modal.mostrado === 0, 'B11: e ainda não fez nada antes disso');
exigir((m.form.listeners.submit || []).length === 0,
  'B11: sem Bootstrap ainda não há handler de submit (nada de meias-ligações)');
// O layout carrega o Bootstrap a seguir; só então o DOMContentLoaded dispara.
amb.sandbox.bootstrap = { Modal: amb.ModalFalso };
ouvintesDCL.forEach((fn) => fn({}));
m.campos.host.value = 'smtp.depois.pt';
submeter(m.form);
exigir(amb.modal.mostrado === 1,
  'B11: depois do DOMContentLoaded o diff funciona (o Bootstrap já existe)');
ok('Bootstrap a chegar depois: o script espera e liga-se no DOMContentLoaded');

// ── Resultado ───────────────────────────────────────────────────────
if (falhas.length) {
  assert.fail(`invariantes do P54-2 (diff SMTP) violadas:\n  - ${falhas.join('\n  - ')}`);
}
console.log('\n✓ Confirmação com diff da configuração SMTP conforme (11 cenários, DOM falso).');
