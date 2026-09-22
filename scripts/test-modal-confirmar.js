// ═══════════════════════════════════════════════════════════════════
// Modal de confirmação — `public/js/app.js` a correr a SÉRIO (P1).
//
// O ficheiro é um script de browser: não se pode «require». Aqui é executado
// num DOM falso (vm + elementos mínimos) que implementa exatamente as APIs que
// ele usa. Prova-se o comportamento real do clique de confirmação:
//
//   · um envio só acontece depois de confirmado;
//   · confirmar envia UMA vez — um duplo clique rápido não volta a submeter;
//   · a marca `data-confirmado` é de um só envio (não fica presa e não deixa
//     passar um envio posterior sem confirmação);
//   · sem `requestSubmit` (browser antigo) o caminho nativo não deixa o
//     formulário marcado como «já confirmado».
//
// Utilização: node scripts/test-modal-confirmar.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');

// ── DOM falso ──────────────────────────────────────────────────────
class El {
  constructor(id, attrs) {
    this.id = id || '';
    this.attrs = Object.assign({}, attrs || {});
    this.listeners = {};
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.style = {};
    const classes = new Set();
    this.classList = {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
      toggle: (c, forcar) => {
        const quer = forcar === undefined ? !classes.has(c) : Boolean(forcar);
        if (quer) classes.add(c); else classes.delete(c);
        return quer;
      },
    };
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  addEventListener(tipo, fn) { (this.listeners[tipo] = this.listeners[tipo] || []).push(fn); }
  disparar(tipo, ev) { (this.listeners[tipo] || []).forEach((fn) => fn(ev || {})); }
  appendChild() {}
  querySelector() { return null; }
  remove() {}
  click() {}
  getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 }; }
}

const elementos = {};
const criar = (id, attrs) => { const el = new El(id, attrs); elementos[id] = el; return el; };
const modalEl = criar('modalConfirmarGesCondu');
criar('modalConfirmarTitulo');
criar('modalConfirmarMensagem');
const botaoAcao = criar('modalConfirmarAcao');
criar('modalConfirmarCancelar');
criar('modalConfirmarCabecalho');

const ouvintesDocumento = {};
const documento = {
  readyState: 'complete',
  getElementById: (id) => elementos[id] || null,
  querySelectorAll: () => [],
  createElement: (tag) => new El(tag),
  addEventListener: (tipo, fn, captura) => {
    (ouvintesDocumento[tipo] = ouvintesDocumento[tipo] || []).push({ fn, captura });
  },
};

const modal = { mostrado: 0, escondido: 0 };
class ModalFalso {
  constructor() { this.el = null; }
  show() { modal.mostrado += 1; }
  hide() { modal.escondido += 1; }
}

const armazem = new Map();
const localStorageFalso = {
  getItem: (k) => (armazem.has(k) ? armazem.get(k) : null),
  setItem: (k, v) => { armazem.set(k, v); },
};
const janela = {
  innerWidth: 1400,
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  localStorage: localStorageFalso,
  location: { href: '' },
  open: () => null,
  alert: () => {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
};
janela.window = janela;

const sandbox = {
  document: documento,
  window: janela,
  bootstrap: { Modal: ModalFalso },
  localStorage: localStorageFalso,
  setTimeout,
  clearTimeout,
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(RAIZ, 'public', 'js', 'app.js'), 'utf8'),
  sandbox,
  { filename: 'public/js/app.js' }
);

// ── Ferramentas do teste ───────────────────────────────────────────
// Submeter = disparar o evento `submit` do documento (fase de captura), como o
// browser faz. `preventDefault` é contado para saber se o envio foi travado.
function submeter(form) {
  const ev = { target: form, preventDefault: () => { ev.travado = true; } };
  ouvintesDocumento.submit.forEach(({ fn }) => fn(ev));
  return Boolean(ev.travado);
}

// Formulário «moderno» (com `requestSubmit`, como todos os browsers suportados).
function novoFormulario(id, attrs) {
  const form = new El(id, attrs);
  form.envios = 0;
  form.marcaNoEnvio = null;
  form.requestSubmit = function requestSubmit() {
    form.envios += 1;
    form.marcaNoEnvio = form.getAttribute('data-confirmado');
    // O browser dispara o `submit` a seguir a `requestSubmit()`: o handler do
    // documento tem de reconhecer a marca e deixar passar.
    submeter(form);
  };
  return form;
}

// ── Testes ─────────────────────────────────────────────────────────
const form = novoFormulario('form-eliminar', { 'data-confirmar': 'Eliminar esta fração?', 'data-confirmar-perigo': '1' });

// 1. Submeter sem confirmar: a caixa abre e NADA é enviado.
assert.strictEqual(submeter(form), true, 'o envio é travado à espera de confirmação');
assert.strictEqual(form.envios, 0, 'nada foi enviado antes de confirmar');
assert.strictEqual(modal.mostrado, 1, 'a caixa de confirmação abre');

// 2. Confirmar: envia UMA vez, com a marca posta durante o envio.
botaoAcao.disparar('click');
assert.strictEqual(form.envios, 1, 'confirmar envia');
assert.strictEqual(form.marcaNoEnvio, '1', 'o envio confirmado leva a marca');
assert.strictEqual(form.getAttribute('data-confirmado'), null, 'a marca é de um só envio');
assert.strictEqual(botaoAcao.disabled, true, 'o botão fica desativado no primeiro clique (P1)');

// 3. Duplo clique rápido: o segundo clique não volta a submeter.
botaoAcao.disparar('click');
botaoAcao.disparar('click');
assert.strictEqual(form.envios, 1, 'o duplo clique NÃO volta a submeter');

// 4. Fechar a caixa reativa o botão (a próxima confirmação tem de funcionar).
modalEl.disparar('hidden.bs.modal');
assert.strictEqual(botaoAcao.disabled, false, 'a caixa fechada reativa o botão');

// 5. Um envio posterior volta a pedir confirmação (a marca não ficou presa).
assert.strictEqual(submeter(form), true, 'volta a pedir confirmação');
assert.strictEqual(form.envios, 1, 'e continua sem enviar até confirmar');
assert.strictEqual(modal.mostrado, 2, 'a caixa abre outra vez');

// 6. Cancelar (fechar sem confirmar) não envia nada.
modalEl.disparar('hidden.bs.modal');
assert.strictEqual(form.envios, 1, 'cancelar não envia');
assert.strictEqual(botaoAcao.disabled, false, 'cancelar reativa o botão');

// 7. Browser antigo (sem `requestSubmit`): caminho nativo, sem marca presa.
const formAntigo = new El('form-antigo', { 'data-confirmar': 'Eliminar?' });
formAntigo.nativos = 0;
formAntigo.submit = function submit() { formAntigo.nativos += 1; };
assert.strictEqual(submeter(formAntigo), true, 'sem requestSubmit: também espera confirmação');
botaoAcao.disparar('click');
assert.strictEqual(formAntigo.nativos, 1, 'envia pelo caminho nativo');
assert.strictEqual(formAntigo.hasAttribute('data-confirmar'), false, 'deixa de ser interceptado pela caixa');
assert.strictEqual(formAntigo.hasAttribute('data-confirmado'), false, 'não fica nenhuma marca presa');
assert.strictEqual(submeter(formAntigo), false, 'um envio posterior não é interceptado (não há falso «já confirmado»)');

// 8. A caixa serve também para avisos (modo «aviso»): só Fechar, sem Cancelar.
sandbox.window.GesConduAviso('O documento não pôde ser aberto.', { titulo: 'Não foi possível abrir' });
assert.strictEqual(elementos.modalConfirmarTitulo.textContent, 'Não foi possível abrir', 'o aviso usa o título dado');
assert.strictEqual(botaoAcao.textContent, 'Fechar', 'em modo aviso o botão é «Fechar»');

console.log('✓ Testes do modal de confirmação passaram (DOM falso, sem browser).');
