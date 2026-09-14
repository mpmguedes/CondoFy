/* ============================================================
   GesCondu — Homepage pública: comportamento mínimo.

   Só três coisas, todas opcionais (a página funciona sem JavaScript):
     1. animação de entrada suave dos blocos marcados com .hp-reveal;
     2. contagem progressiva dos valores marcados com data-hp-contar;
     3. fecha o menu mobile ao escolher uma ligação.

   Não há bibliotecas nem pedidos de rede. Respeita
   `prefers-reduced-motion` (nesse caso não anima nada).
   ============================================================ */
(function () {
  'use strict';

  var semMovimento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── 1. Animação de entrada ─────────────────────────────────────────
  function revelar() {
    var alvos = document.querySelectorAll('.hp-reveal');
    if (semMovimento || !('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(alvos, function (el) { el.classList.add('hp-visivel'); });
      return;
    }
    var observador = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (entrada) {
        if (!entrada.isIntersecting) return;
        entrada.target.classList.add('hp-visivel');
        observador.unobserve(entrada.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(alvos, function (el) { observador.observe(el); });
  }

  // ── 2. Contagem progressiva (euro/permilagem já formatados) ────────
  // O valor final está sempre no HTML (o JavaScript só o anima), pelo que o
  // conteúdo é legível sem JavaScript e para leitores de ecrã.
  function formatar(valorC, formato) {
    var inteiro = Math.round(valorC);
    if (formato === 'eur') {
      return (inteiro / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    }
    return inteiro.toLocaleString('pt-PT');
  }

  function contar() {
    var alvos = document.querySelectorAll('[data-hp-contar]');
    if (semMovimento || !('IntersectionObserver' in window)) return;
    var observador = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (entrada) {
        if (!entrada.isIntersecting) return;
        var el = entrada.target;
        observador.unobserve(el);
        var destino = Number(el.getAttribute('data-hp-contar')) || 0;
        var formato = el.getAttribute('data-hp-formato') || 'numero';
        var inicio = null;
        var duracao = 700;
        function passo(ts) {
          if (inicio === null) inicio = ts;
          var t = Math.min(1, (ts - inicio) / duracao);
          var suave = 1 - Math.pow(1 - t, 3);
          el.textContent = formatar(destino * suave, formato);
          if (t < 1) window.requestAnimationFrame(passo);
          else el.textContent = formatar(destino, formato);
        }
        window.requestAnimationFrame(passo);
      });
    }, { threshold: 0.4 });
    Array.prototype.forEach.call(alvos, function (el) { observador.observe(el); });
  }

  // ── 3. Menu mobile ────────────────────────────────────────────────
  function menuMobile() {
    var menu = document.getElementById('hpMenuMobile');
    if (!menu) return;
    menu.addEventListener('click', function (evento) {
      if (evento.target.closest('a')) menu.removeAttribute('open');
    });
    document.addEventListener('keydown', function (evento) {
      if (evento.key === 'Escape' && menu.hasAttribute('open')) menu.removeAttribute('open');
    });
  }

  function iniciar() {
    revelar();
    contar();
    menuMobile();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
