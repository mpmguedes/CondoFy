/**
 * Aparência da interface GesCondu: tema (claro/escuro) e escala de texto.
 *
 * TEMA — o atributo <html data-theme="dark"> ativa o tema escuro definido em
 * styles.css. A escolha segue, por esta ordem:
 *   1. preferência guardada pelo utilizador (localStorage 'gescondu-tema');
 *   2. preferência do sistema (prefers-color-scheme).
 *
 * TEXTO — o atributo <html data-font="normal|large|xlarge"> define a escala
 * tipográfica global (Normal · Grande · Muito grande), aplicada em styles.css
 * pela variável --font-scale. A escolha fica em localStorage
 * ('gescondu-fonte'), como o tema, e é uma preferência de acessibilidade do
 * utilizador: não é guardada na base de dados e sobrevive a logout/login.
 *
 * API do tema:
 *   GesConduTema.definir('claro' | 'escuro')  → fixa a preferência
 *   GesConduTema.automatico()                 → volta a seguir o sistema
 *   GesConduTema.atual()                      → 'claro' | 'escuro'
 *
 * API do texto:
 *   GesConduFonte.definir('normal'|'large'|'xlarge')
 *   GesConduFonte.atual()
 *   GesConduFonte.OPCOES                       → [{ valor, rotulo, descricao }]
 *
 * Botões com data-tema-toggle (parcial _tema-toggle) alternam o tema e
 * refletem o estado em aria-pressed/ícone; as opções com data-fonte-opcao
 * mostram o nível de texto escolhido (aria-checked + marca visual). A aplicação
 * inicial acontece inline no <head> (evita flash); este ficheiro liga os
 * controlos e mantém a sessão sincronizada com o sistema.
 */
(function () {
  'use strict';

  var CHAVE = 'gescondu-tema';
  var CHAVE_FONTE = 'gescondu-fonte';
  var FONTES = ['normal', 'large', 'xlarge'];
  var RAIZ = document.documentElement;

  function guardado() {
    try {
      var v = localStorage.getItem(CHAVE);
      return v === 'claro' || v === 'escuro' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function sistemaPrefereEscuro() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function atual() {
    return guardado() || (sistemaPrefereEscuro() ? 'escuro' : 'claro');
  }

  function aplicar() {
    var tema = atual();
    RAIZ.setAttribute('data-theme', tema === 'escuro' ? 'dark' : 'light');
    sincronizarBotoes(tema);
    return tema;
  }

  // Botões com data-tema-toggle: ícone e aria-pressed refletem o estado atual.
  function sincronizarBotoes(tema) {
    var escuro = tema === 'escuro';
    var botoes = document.querySelectorAll('[data-tema-toggle]');
    for (var i = 0; i < botoes.length; i++) {
      var b = botoes[i];
      b.setAttribute('aria-pressed', escuro ? 'true' : 'false');
      var icone = b.querySelector('.material-symbols-outlined');
      if (icone) icone.textContent = escuro ? 'light_mode' : 'dark_mode';
      b.setAttribute('title', escuro ? 'Passar para tema claro' : 'Passar para tema escuro');
    }
  }

  function ligarBotoes() {
    var botoes = document.querySelectorAll('[data-tema-toggle]');
    for (var i = 0; i < botoes.length; i++) {
      if (botoes[i].dataset.temaLigado) continue;
      botoes[i].dataset.temaLigado = '1';
      botoes[i].addEventListener('click', function () {
        definir(atual() === 'escuro' ? 'claro' : 'escuro');
      });
    }
    sincronizarBotoes(atual());
  }

  function definir(tema) {
    try { localStorage.setItem(CHAVE, tema === 'escuro' ? 'escuro' : 'claro'); } catch (e) {}
    return aplicar();
  }

  function automatico() {
    try { localStorage.removeItem(CHAVE); } catch (e) {}
    return aplicar();
  }

  // ── Escala de texto (acessibilidade) ────────────────────────────────
  function fonteGuardada() {
    try {
      var v = localStorage.getItem(CHAVE_FONTE);
      return FONTES.indexOf(v) >= 0 ? v : null;
    } catch (e) {
      return null;
    }
  }

  function fonteAtual() {
    return fonteGuardada() || 'normal';
  }

  function aplicarFonte(nivel) {
    var escolhido = FONTES.indexOf(nivel) >= 0 ? nivel : 'normal';
    RAIZ.setAttribute('data-font', escolhido);
    sincronizarOpcoesDeFonte(escolhido);
    return escolhido;
  }

  // Cada opção mostra o estado por marca visual (ícone) e por acessibilidade
  // (aria-checked) — nunca apenas pela cor.
  function sincronizarOpcoesDeFonte(nivel) {
    var opcoes = document.querySelectorAll('[data-fonte-opcao]');
    for (var i = 0; i < opcoes.length; i++) {
      var escolhida = opcoes[i].getAttribute('data-fonte-opcao') === nivel;
      opcoes[i].setAttribute('aria-checked', escolhida ? 'true' : 'false');
      var marca = opcoes[i].querySelector('[data-fonte-marca]');
      if (marca) marca.classList.toggle('invisible', !escolhida);
      if (escolhida) opcoes[i].classList.add('active');
      else opcoes[i].classList.remove('active');
    }
    var botao = document.querySelector('[data-fonte-toggle]');
    if (botao) {
      var rotulo = { normal: 'Normal', large: 'Grande', xlarge: 'Muito grande' }[nivel] || 'Normal';
      botao.setAttribute('aria-label', 'Tamanho do texto: ' + rotulo);
      botao.setAttribute('title', 'Tamanho do texto: ' + rotulo);
    }
  }

  function ligarOpcoesDeFonte() {
    // O <head> já aplicou o atributo (sem flash); esta chamada garante-o em
    // qualquer página e sincroniza o estado do menu.
    aplicarFonte(fonteAtual());
    var opcoes = document.querySelectorAll('[data-fonte-opcao]');
    for (var i = 0; i < opcoes.length; i++) {
      if (opcoes[i].dataset.fonteLigada) continue;
      opcoes[i].dataset.fonteLigada = '1';
      opcoes[i].addEventListener('click', function (ev) {
        definirFonte(ev.currentTarget.getAttribute('data-fonte-opcao'));
      });
    }
    sincronizarOpcoesDeFonte(fonteAtual());
  }

  function definirFonte(nivel) {
    var escolhido = FONTES.indexOf(nivel) >= 0 ? nivel : 'normal';
    try { localStorage.setItem(CHAVE_FONTE, escolhido); } catch (e) {}
    return aplicarFonte(escolhido);
  }

  aplicar();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      ligarBotoes();
      ligarOpcoesDeFonte();
    });
  } else {
    ligarBotoes();
    ligarOpcoesDeFonte();
  }

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var aoMudar = function () {
      if (!guardado()) aplicar();
    };
    if (mq.addEventListener) mq.addEventListener('change', aoMudar);
    else if (mq.addListener) mq.addListener(aoMudar);
  }

  window.GesConduTema = { atual: atual, aplicar: aplicar, definir: definir, automatico: automatico, ligarBotoes: ligarBotoes };
  window.GesConduFonte = {
    atual: fonteAtual,
    aplicar: aplicarFonte,
    definir: definirFonte,
    ligarOpcoes: ligarOpcoesDeFonte,
    OPCOES: [
      { valor: 'normal', rotulo: 'Normal' },
      { valor: 'large', rotulo: 'Grande' },
      { valor: 'xlarge', rotulo: 'Muito grande' },
    ],
  };
})();
