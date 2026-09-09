/**
 * Tema da interface GesCondu (claro/escuro).
 *
 * O atributo <html data-theme="dark"> ativa o tema escuro definido em
 * styles.css. A escolha segue, por esta ordem:
 *   1. preferência guardada pelo utilizador (localStorage 'gescondu-tema');
 *   2. preferência do sistema (prefers-color-scheme).
 *
 * API (opcional, para um futuro botão de tema):
 *   GesConduTema.definir('claro' | 'escuro')  → fixa a preferência
 *   GesConduTema.automatico()                 → volta a seguir o sistema
 *   GesConduTema.atual()                      → 'claro' | 'escuro'
 *
 * A aplicação inicial acontece inline no <head> (evita flash de tema claro);
 * este ficheiro apenas mantém a sessão sincronizada com o sistema.
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
    return tema;
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

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var aoMudar = function () {
      if (!guardado()) aplicar();
    };
    if (mq.addEventListener) mq.addEventListener('change', aoMudar);
    else if (mq.addListener) mq.addListener(aoMudar);
  }

  window.GesConduTema = { atual: atual, aplicar: aplicar, definir: definir, automatico: automatico };
})();
