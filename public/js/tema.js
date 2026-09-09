/**
 * Tema da interface GesCondu (claro/escuro).
 *
 * O atributo <html data-theme="dark"> ativa o tema escuro definido em
 * styles.css. A escolha segue, por esta ordem:
 *   1. preferência guardada pelo utilizador (localStorage 'gescondu-tema');
 *   2. preferência do sistema (prefers-color-scheme).
 *
 * API:
 *   GesConduTema.definir('claro' | 'escuro')  → fixa a preferência
 *   GesConduTema.automatico()                 → volta a seguir o sistema
 *   GesConduTema.atual()                      → 'claro' | 'escuro'
 *
 * Botões com data-tema-toggle (parcial _tema-toggle) alternam e refletem o
 * estado em aria-pressed/ícone. A aplicação inicial acontece inline no <head>
 * (evita flash do tema errado); este ficheiro liga os botões e mantém a sessão
 * sincronizada com o sistema.
 */
(function () {
  'use strict';

  var CHAVE = 'gescondu-tema';
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

  aplicar();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ligarBotoes);
  } else {
    ligarBotoes();
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
})();
