// ═══════════════════════════════════════════════════════════════════
// P54-0 — Padrão «consulta → Editar → Cancelar → Guardar».
//
// Prova três camadas:
//   A. ESTÁTICA — o parcial renderiza o que o contrato diz (consulta só com
//      texto, `hidden` no formulário, `aria-expanded`/`aria-controls`, e a
//      regra de segredos: `sensivel` imprime a máscara e IGNORA o valor).
//   B. ESTRUTURAL — a folha de estilo é namespaceada, não redefine o design
//      system e não usa `!important`; o JS não valida nem inventa rotas.
//   C. COMPORTAMENTO — o `public/js/modo-edicao.js` a correr a SÉRIO num DOM
//      falso (vm), com eventos a BORBULHAR até ao `document`, que é onde o
//      script delega. Sem isto, as alíneas de comportamento seriam afirmações.
//
// ⛔ O DOM falso implementa exatamente as APIs que o script usa (o mesmo
// método de `test-modal-confirmar.js`). O que não é usado não é implementado —
// e o que é implementado comporta-se como no browser (propriedades `hidden`/
// `disabled`/`value`/`checked`, delegação por bolha, `preventDefault`).
//
// Utilização: node scripts/test-modo-edicao.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const handlebars = require('handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const falhas = [];
const exigir = (cond, msg) => { if (!cond) falhas.push(msg); };
const ok = (msg) => console.log(`OK   ${msg}`);

// ═══════════════════════════════════════════════════════════════════
// A. O PARCIAL
// ═══════════════════════════════════════════════════════════════════
console.log('\n── A. O parcial `_modo-edicao.handlebars` ──');

const CAMINHO_PARCIAL = 'views/partials/_modo-edicao.handlebars';
exigir(fs.existsSync(path.join(RAIZ, CAMINHO_PARCIAL)), 'o parcial existe');
const fonteParcial = ler(CAMINHO_PARCIAL);
handlebars.registerPartial('_modo-edicao', fonteParcial);

const LINHAS = [
  { rotulo: 'Servidor', valor: 'smtp.exemplo.pt' },
  { rotulo: 'Porta', valor: '587' },
  { rotulo: 'Password', valor: 'SEGREDO-QUE-NAO-PODE-SAIR', sensivel: true, estado: 'Definida' },
];

// Invocado como o consumidor o invoca: parcial de BLOCO, com os campos lá dentro.
const molde = handlebars.compile(
  '{{#> _modo-edicao id="smtp" acao="/admin/config/email/smtp" titulo="Configuração SMTP" linhas=linhas}}'
  + '<label for="smtp-host">Servidor</label><input id="smtp-host" name="host" value="smtp.exemplo.pt">'
  + '<input type="password" name="password" value="">'
  + '{{/_modo-edicao}}'
);
const html = molde({ linhas: LINHAS });

exigir(/data-modo-edicao/.test(html), 'o bloco raiz tem `data-modo-edicao`');
exigir(/data-me-estado="consulta"/.test(html), 'o estado inicial é `consulta`');
ok('o bloco nasce em estado `consulta`');

// ── A1. Consulta: só texto, nenhum controlo editável ────────────────
const blocoConsulta = (/<div class="me-consulta"[^>]*>([\s\S]*?)<\/div>\s*<form/.exec(html) || [])[1] || '';
exigir(blocoConsulta.length > 0, 'a região de consulta existe');
exigir(!/<(input|select|textarea)\b/i.test(blocoConsulta),
  'a região de CONSULTA não contém um único input/select/textarea');
exigir(/smtp\.exemplo\.pt/.test(blocoConsulta), 'os valores aparecem como TEXTO');
ok('consulta: valores em texto, zero controlos editáveis na região de consulta');

// ── A2. O formulário nasce oculto (impede a submissão acidental) ────
const tagForm = (/<form[^>]*data-me-form[^>]*>/.exec(html) || [])[0] || '';
exigir(/\bhidden\b/.test(tagForm), 'o formulário nasce com o atributo `hidden`');
ok('o formulário nasce `hidden` (nada dentro é focável nem clicável em consulta)');

// ── A3. aria ────────────────────────────────────────────────────────
const tagEditar = (/<button[^>]*data-me-editar[^>]*>/.exec(html) || [])[0] || '';
exigir(/aria-expanded="false"/.test(tagEditar), 'o botão Editar tem `aria-expanded="false"` inicial');
exigir(/aria-controls="smtp-form"/.test(tagEditar), 'o botão Editar aponta para o formulário via `aria-controls`');
exigir(/id="smtp-form"/.test(tagForm), 'o `aria-controls` casa com o `id` real do formulário');
exigir(!/aria-controls="[^"]*"[^>]*aria-controls=/.test(html), 'não há `aria-controls` duplicado');
ok('aria: `aria-expanded` inicial + `aria-controls` a apontar para o `id` do formulário');

// Um botão de Cancelar que não seja `type="button"` submeteria o formulário.
const tagCancelar = (/<button[^>]*data-me-cancelar[^>]*>/.exec(html) || [])[0] || '';
exigir(/type="button"/.test(tagCancelar), 'o botão Cancelar é `type="button"` (nunca submete)');
exigir(/type="submit"/.test((/<button[^>]*data-me-guardar[^>]*>/.exec(html) || [])[0] || ''),
  'o botão Guardar é `type="submit"`');
ok('Cancelar é `type="button"` e Guardar é `type="submit"`');

// ── A4. Segredos: a máscara manda, o valor NUNCA sai ────────────────
exigir(!/SEGREDO-QUE-NAO-PODE-SAIR/.test(html),
  'uma linha `sensivel: true` NÃO imprime o valor (nem no HTML, nem num atributo)');
exigir(/me-mascara/.test(html), 'uma linha `sensivel: true` imprime a máscara');
exigir(/Definida/.test(html), 'o `estado` (texto seguro) continua a ser apresentado');
ok('segredos: `sensivel` imprime a máscara e ignora o `valor` — o segredo não sai no HTML');

// A máscara por omissão, sem `mascara` explícita.
const htmlSoMascara = molde({ linhas: [{ rotulo: 'Chave', valor: 'NAO-PODE-SAIR', sensivel: true }] });
exigir(!/NAO-PODE-SAIR/.test(htmlSoMascara), 'sem `mascara` explícita o valor continua a não sair');
exigir(/•••••/.test(htmlSoMascara), 'a máscara por omissão é apresentada');
ok('a máscara por omissão funciona sem configuração do consumidor');

// ── A5. Os campos do consumidor entram DENTRO do formulário ─────────
const corpoForm = (/<form[^>]*data-me-form[^>]*>([\s\S]*?)<\/form>/.exec(html) || [])[1] || '';
exigir(/name="host"/.test(corpoForm), 'os campos do bloco do consumidor ficam dentro do formulário');
exigir(/name="password"/.test(corpoForm), 'o campo de password do consumidor fica dentro do formulário');
exigir(/data-me-guardar/.test(corpoForm) && /data-me-cancelar/.test(corpoForm),
  'as ações (Guardar/Cancelar) ficam dentro do formulário, depois dos campos');
ok('o bloco do consumidor é injetado dentro do `<form>`, antes das ações');

// ── A6. `id` é obrigatório (o `aria-controls` depende dele) ─────────
exigir(/^<div class="me" id="\{\{id\}\}"/m.test(fonteParcial.trim()) || /id="\{\{id\}\}"/.test(fonteParcial),
  'o parcial usa `{{id}}` como identificador do bloco');
ok('o parcial exige um `id` (prefixa o id do formulário)');

// ═══════════════════════════════════════════════════════════════════
// B. ESTRUTURAL — CSS e JS
// ═══════════════════════════════════════════════════════════════════
console.log('\n── B. Folha de estilo e script ──');

const CAMINHO_CSS = 'public/css/modo-edicao.css';
const CAMINHO_JS = 'public/js/modo-edicao.js';
exigir(fs.existsSync(path.join(RAIZ, CAMINHO_CSS)), 'a folha modo-edicao.css existe');
exigir(fs.existsSync(path.join(RAIZ, CAMINHO_JS)), 'o script modo-edicao.js existe');
const css = ler(CAMINHO_CSS);
const js = ler(CAMINHO_JS);
ok('os três ficheiros do padrão existem (parcial, folha, script)');

// ── B1. Namespace: todos os seletores começam por `.me` ─────────────
const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '');
const seletores = [];
for (const m of semComentarios.matchAll(/([^{}]+)\{/g)) {
  const bruto = m[1].trim();
  if (!bruto || bruto.startsWith('@')) continue;
  bruto.split(',').forEach((s) => seletores.push(s.trim()));
}
const foraDoNamespace = seletores.filter((s) => !/^\.me(\b|[-.:[])/.test(s));
assert.deepStrictEqual(foraDoNamespace, [],
  `seletores fora do namespace .me: ${foraDoNamespace.join(' | ')}`);
ok(`${seletores.length} seletores, TODOS dentro do namespace .me`);
// E não colidem com as utilities de espaçamento do Bootstrap (`me-0`..`me-5`,
// `me-auto`, `me-{breakpoint}-*`).
const COLISAO_BOOTSTRAP = /^\.me-(?:[0-5]|auto)(?:\b|[-.:[])/;
const colisoes = seletores.filter((s) => COLISAO_BOOTSTRAP.test(s));
assert.deepStrictEqual(colisoes, [], `colisão com utilities do Bootstrap: ${colisoes.join(' | ')}`);
ok('nenhuma classe colide com as utilities de espaçamento do Bootstrap');

// ⛔ As verificações estruturais correm sobre o CÓDIGO, não sobre a prosa: os
// comentários deste padrão mencionam `!important` e `localStorage` para os
// proibir, e uma verificação ingénua lia essas palavras e acusava o próprio
// aviso. (É a mesma armadilha dos comentários de token em `styles.css`.)
const jsSemComentarios = js
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

// ── B2. Não redefine o design system ────────────────────────────────
exigir(!/!important/.test(semComentarios), 'a folha não usa `!important`');
exigir(!/(^|\})\s*:root\b/m.test(semComentarios), 'a folha não redeclara `:root`');
for (const classe of ['.btn', '.card', '.form-control', '.quick-action', '.icon-btn', '.table']) {
  exigir(!new RegExp(`(^|[},])\\s*\\${classe}(?![\\w-])`).test(semComentarios),
    `a folha não redefine a classe do design system \`${classe}\``);
}
ok('a folha não usa `!important`, não redeclara `:root` e não redefine classes do design system');

// ── B3. Consome tokens (com valor de recurso) e é utilizável ao toque ─
exigir(/var\(--c-primary\b/.test(css), 'usa o token de cor primária');
exigir(/var\(--radius-sm\b/.test(css), 'usa o token de raio');
exigir(/var\(--ctl-h\b/.test(css), 'usa o token de altura de controlo');
exigir(/var\(--c-focus-ring\b/.test(css), 'usa o token do anel de foco');
exigir(/var\(--c-disabled-text\b/.test(css), 'usa os tokens do estado desativado');
exigir(!/opacity:\s*0?\.\d/.test(semComentarios), 'não atenua por opacidade fracionária (usa cor)');
ok('consome os tokens do design system (cor, raio, altura, foco, desativado)');

exigir(/@media\s*\(max-width:\s*575\.98px\)/.test(css), 'tem um bloco de ecrã estreito');
exigir(/\.me-btn:focus-visible/.test(css), 'define um anel de foco visível próprio');
exigir(/\.me-form\[hidden\]/.test(css), 'garante que o `hidden` do formulário manda (não é anulado por CSS)');
ok('mobile e foco: bloco estreito, anel de foco próprio e `[hidden]` garantido');

// ── B4. O JS não valida nem inventa rotas ───────────────────────────
exigir(!/fetch\s*\(|XMLHttpRequest/.test(jsSemComentarios),
  'o JS não faz pedidos próprios (não inventa endpoints)');
exigir(!/\.submit\s*\(\s*\)/.test(jsSemComentarios),
  'o JS nunca chama `form.submit()` (não força envios)');
exigir(!/localStorage|sessionStorage/.test(jsSemComentarios),
  'o JS não persiste valores em armazenamento do browser (poderia guardar segredos)');
exigir(!/console\.(log|info|warn|error)/.test(jsSemComentarios),
  'o JS não escreve valores na consola');
exigir(/GesConduConfirmar/.test(jsSemComentarios), 'reutiliza a caixa de confirmação da aplicação');
exigir(/window\.confirm/.test(jsSemComentarios),
  'tem recurso para quando a caixa da aplicação não está carregada');
ok('o JS não faz pedidos, não força envios, não persiste nem imprime valores');

// ── B5. Registado globalmente no layout, depois de app.js ───────────
const layout = ler('views/layouts/main.handlebars');
exigir(/href="\/css\/modo-edicao\.css\?v=/.test(layout), 'a folha está referenciada no layout `main`');
exigir(/src="\/js\/modo-edicao\.js\?v=/.test(layout), 'o script está referenciado no layout `main`');
exigir(layout.indexOf('/js/app.js') < layout.indexOf('/js/modo-edicao.js'),
  'o script carrega DEPOIS de app.js (de que depende GesConduConfirmar)');
ok('registado no layout `main`, com o script depois de app.js');

// ═══════════════════════════════════════════════════════════════════
// C. COMPORTAMENTO — o script a correr num DOM falso
// ═══════════════════════════════════════════════════════════════════
console.log('\n── C. Comportamento (DOM falso, eventos com bolha) ──');

// ── C0. O DOM falso ─────────────────────────────────────────────────
class No {
  constructor(tag, attrs) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.filhos = [];
    this.pai = null;
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.focos = 0;
    this.type = this.attrs.type || (this.tagName === 'INPUT' ? 'text' : undefined);
    this.name = this.attrs.name || '';
  }
  get classList() {
    const lista = String(this.attrs.class || '').split(/\s+/).filter(Boolean);
    return { contains: (c) => lista.includes(c) };
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  focus() { this.focos += 1; }
  juntar(...nos) { nos.forEach((n) => { n.pai = this; this.filhos.push(n); }); return this; }
  // `form.elements`: os controlos descendentes (como no browser).
  get elements() {
    const saida = [];
    (function percorrer(no) {
      for (const f of no.filhos) {
        if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(f.tagName)) saida.push(f);
        percorrer(f);
      }
    })(this);
    return saida;
  }
}

// Seletor simples: `[attr]`, `.classe` ou `tag`. É tudo o que o script usa.
function corresponde(el, sel) {
  const s = sel.trim();
  if (s.startsWith('[') && s.endsWith(']')) return el.hasAttribute(s.slice(1, -1));
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  return el.tagName === s.toUpperCase();
}
function descendentes(raiz) {
  const saida = [];
  (function percorrer(no) {
    for (const f of no.filhos) { saida.push(f); percorrer(f); }
  })(raiz);
  return saida;
}
No.prototype.closest = function closest(sel) {
  let no = this;
  while (no) { if (corresponde(no, sel)) return no; no = no.pai; }
  return null;
};
No.prototype.querySelector = function querySelector(sel) {
  return descendentes(this).find((n) => corresponde(n, sel)) || null;
};

// ── C1. A árvore: o mesmo markup que o parcial produz ───────────────
function construirBloco() {
  const bloco = new No('div', { 'data-modo-edicao': '', 'data-me-estado': 'consulta' });
  const consulta = new No('div', { 'data-me-consulta': '' });
  const editar = new No('button', { 'data-me-editar': '', 'aria-expanded': 'false', 'aria-controls': 'smtp-form' });
  consulta.juntar(editar);
  const form = new No('form', { 'data-me-form': '', id: 'smtp-form' });
  form.hidden = true;
  const host = new No('input', { name: 'host', type: 'text' });
  host.value = 'smtp.exemplo.pt';
  const tls = new No('input', { name: 'tls', type: 'checkbox' });
  tls.checked = true;
  const guardar = new No('button', { 'data-me-guardar': '', type: 'submit' });
  const cancelar = new No('button', { 'data-me-cancelar': '', type: 'button' });
  form.juntar(host, tls, guardar, cancelar);
  bloco.juntar(consulta, form);
  return { bloco, consulta, editar, form, host, tls, guardar, cancelar };
}

const documento = new No('#document');
documento.addEventListener = No.prototype.addEventListener.bind(documento);

const pedidosConfirmar = [];
let respostaConfirmar = true;
const janela = {
  addEventListener: (t, fn) => documento.addEventListener(`win:${t}`, fn),
  GesConduConfirmar: (msg, opcoes) => {
    pedidosConfirmar.push({ msg, opcoes });
    return Promise.resolve(respostaConfirmar);
  },
};

const sandbox = { document: documento, window: janela, Promise, Set, WeakMap, WeakSet, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: 'public/js/modo-edicao.js' });

// Dispara um evento COM BOLHA: do alvo até ao documento (é onde o script delega).
function disparar(alvo, tipo) {
  const ev = { target: alvo, preventDefault() { ev.travado = true; }, travado: false };
  let no = alvo;
  while (no) {
    (no.listeners[tipo] || []).forEach((fn) => fn(ev));
    no = no.pai;
  }
  return ev;
}
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  // ── C2. Estado inicial ────────────────────────────────────────────
  let d = construirBloco();
  documento.juntar(d.bloco);
  exigir(d.form.hidden === true, 'C2: o formulário começa oculto');
  exigir(d.bloco.getAttribute('data-me-estado') === 'consulta', 'C2: começa em consulta');
  ok('estado inicial: consulta, formulário oculto');

  // ── C3. Em consulta, submeter é BLOQUEADO ─────────────────────────
  let ev = disparar(d.form, 'submit');
  exigir(ev.travado === true, 'C3: submeter em consulta é travado (preventDefault)');
  ok('em consulta o envio é travado — não há submissão acidental');

  // ── C4. Editar ativa o modo de edição + foco no 1.º campo ─────────
  disparar(d.editar, 'click');
  exigir(d.bloco.getAttribute('data-me-estado') === 'edicao', 'C4: o estado passa a `edicao`');
  exigir(d.form.hidden === false, 'C4: o formulário fica visível');
  exigir(d.consulta.hidden === true, 'C4: a consulta fica oculta (nunca as duas ativas)');
  exigir(d.editar.getAttribute('aria-expanded') === 'true', 'C4: `aria-expanded` passa a `true`');
  exigir(d.editar.disabled === true, 'C4: o botão Editar fica inerte em edição');
  exigir(d.host.focos === 1, 'C4: o foco vai para o primeiro campo editável');
  ok('Editar: formulário visível, consulta oculta, aria-expanded=true, foco no 1.º campo');

  // ── C5. Submeter em edição NÃO é travado ──────────────────────────
  ev = disparar(d.form, 'submit');
  exigir(ev.travado === false, 'C5: em edição o envio segue (o JS não valida nem trava)');
  ok('em edição o envio segue normalmente (sem validação de backend)');

  // ── C6. Dirty state: detetado e limpo ─────────────────────────────
  d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.editar, 'click');
  let evSaida = disparar(documento, 'win:beforeunload');
  exigir(evSaida.travado === false, 'C6: sem alterações, sair da página não é travado');
  d.host.value = 'outro.servidor.pt';
  disparar(d.host, 'input');
  evSaida = disparar(documento, 'win:beforeunload');
  exigir(evSaida.travado === true, 'C6: com alterações, sair da página é travado');
  ok('dirty: detetado ao escrever (guarda de saída ativa)');

  // ── C7. Cancelar COM alterações: confirma e restaura ──────────────
  pedidosConfirmar.length = 0;
  respostaConfirmar = true;
  disparar(d.cancelar, 'click');
  await tick();
  exigir(pedidosConfirmar.length === 1, 'C7: com alterações pede confirmação antes de descartar');
  exigir(d.host.value === 'smtp.exemplo.pt', 'C7: cancelar RESTAURA o valor original');
  exigir(d.bloco.getAttribute('data-me-estado') === 'consulta', 'C7: volta ao estado de consulta');
  exigir(d.form.hidden === true, 'C7: o formulário volta a ficar oculto');
  exigir(d.editar.disabled === false, 'C7: o botão Editar volta a estar ativo');
  exigir(d.editar.focos === 1, 'C7: o foco volta ao botão Editar');
  evSaida = disparar(documento, 'win:beforeunload');
  exigir(evSaida.travado === false, 'C7: o estado sujo é limpo ao cancelar');
  ok('Cancelar: confirma, restaura os valores, devolve o foco e limpa o estado sujo');

  // ── C8. Cancelar SEM alterações: não pergunta nada ────────────────
  d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.editar, 'click');
  pedidosConfirmar.length = 0;
  disparar(d.cancelar, 'click');
  await tick();
  exigir(pedidosConfirmar.length === 0, 'C8: sem alterações cancela de imediato (não pergunta)');
  exigir(d.bloco.getAttribute('data-me-estado') === 'consulta', 'C8: cancela na mesma');
  ok('Cancelar sem alterações: cancela de imediato, sem confirmação');

  // ── C9. Cancelar NUNCA submete ────────────────────────────────────
  d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.editar, 'click');
  d.host.value = 'alterado.pt';
  disparar(d.host, 'input');
  respostaConfirmar = true;
  disparar(d.cancelar, 'click');
  await tick();
  exigir(d.cancelar.type === 'button', 'C9: o botão Cancelar é `type="button"`');
  // O formulário está oculto depois de cancelar: um envio a partir dele seria travado.
  ev = disparar(d.form, 'submit');
  exigir(ev.travado === true, 'C9: depois de cancelar, um envio do formulário é travado');
  ok('Cancelar não submete — e o formulário volta ao estado que trava envios');

  // ── C10. Descartar = NÃO (mantém a edição) ────────────────────────
  d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.editar, 'click');
  d.host.value = 'a-meio.pt';
  disparar(d.host, 'input');
  respostaConfirmar = false;
  disparar(d.cancelar, 'click');
  await tick();
  exigir(d.bloco.getAttribute('data-me-estado') === 'edicao', 'C10: recusar o descarte mantém a edição');
  exigir(d.host.value === 'a-meio.pt', 'C10: e não perde o que estava escrito');
  ok('recusar a confirmação mantém a edição e o que estava escrito');

  // ── C11. Checkbox também conta para o estado sujo ─────────────────
  d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.editar, 'click');
  d.tls.checked = false;
  disparar(d.tls, 'change');
  evSaida = disparar(documento, 'win:beforeunload');
  exigir(evSaida.travado === true, 'C11: desmarcar uma checkbox marca o estado sujo');
  respostaConfirmar = true;
  disparar(d.cancelar, 'click');
  await tick();
  exigir(d.tls.checked === true, 'C11: cancelar restaura também o estado da checkbox');
  ok('checkbox: alteração detetada e restaurada ao cancelar');

  // ── C12. Vários blocos são independentes ──────────────────────────
  const dA = construirBloco();
  const dB = construirBloco();
  documento.juntar(dA.bloco, dB.bloco);
  disparar(dA.editar, 'click');
  exigir(dA.form.hidden === false && dB.form.hidden === true,
    'C12: editar um bloco não abre o outro');
  dA.host.value = 'x.pt';
  disparar(dA.host, 'input');
  disparar(dA.cancelar, 'click');
  await tick();
  exigir(dB.form.hidden === true, 'C12: o segundo bloco mantém-se em consulta');
  ok('vários blocos na mesma página são independentes');

  // ── C13. Antes de `Editar`, nada está guardado (sem fuga) ─────────
  d = construirBloco();
  documento.juntar(d.bloco);
  disparar(d.cancelar, 'click');   // cancelar sem nunca ter editado
  await tick();
  exigir(d.bloco.getAttribute('data-me-estado') === 'consulta',
    'C13: cancelar antes de editar é inofensivo');
  ok('cancelar sem edição prévia não rebenta nem muda nada');

  // ── Resultado ─────────────────────────────────────────────────────
  if (falhas.length) {
    assert.fail(`invariantes do padrão P54-0 violadas:\n  - ${falhas.join('\n  - ')}`);
  }
  console.log('\n✓ Padrão «consulta → Editar → Cancelar → Guardar» conforme'
    + ` (${seletores.length} seletores namespaceados, ${pedidosConfirmar.length >= 0 ? 'comportamento' : ''} provado num DOM falso).`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
