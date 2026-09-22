// ─────────────────────────────────────────────────────────────────────
// Tips contextuais do painel — melhoria progressiva (apresentação).
//
// O X de dispensa é um formulário POST normal: funciona SEM este ficheiro.
// Aqui só se acrescenta o que o HTML sozinho não dá:
//   · defesa contra duplo envio (um segundo clique/Enter não volta a gravar);
//   · um estado de carregamento visível (aria-busy + indicador, ver
//     `.gc-tip[aria-busy="true"]` em public/css/styles.css);
//   · saída discreta do cartão, e só quando o utilizador aceita movimento.
//
// Este ficheiro NÃO decide que tip mostrar, nem para onde vai a ação: isso é do
// motor (`helpers/tips.js`) e do próprio formulário, respetivamente. Não há
// aqui nenhuma condição de elegibilidade.
// ─────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  function semMovimento() {
    return Boolean(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function preparar(form) {
    if (form.dataset.tipsLigado === '1') return; // idempotente (pode correr 2x)
    var cartao = form.closest ? form.closest('.gc-tip') : null;
    var botao = form.querySelector('.gc-tip-x');
    if (!cartao || !botao) return;
    form.dataset.tipsLigado = '1';

    var enviado = false;

    form.addEventListener('submit', function (ev) {
      // Duplo envio: a partir daqui o cartão está inerte (pointer-events: none)
      // e o botão desativado, mas o teclado ainda pode submeter — trava-se aqui.
      if (enviado) {
        ev.preventDefault();
        return;
      }
      enviado = true;

      cartao.setAttribute('aria-busy', 'true');
      botao.disabled = true;

      // Saída discreta: só com movimento aceite. Sem isto (ou com movimento
      // reduzido) o formulário segue o caminho normal e a página muda logo.
      if (!semMovimento()) {
        ev.preventDefault();
        cartao.style.transition = 'opacity 0.16s ease, transform 0.16s ease';
        cartao.style.opacity = '0';
        cartao.style.transform = 'translateY(-4px)';
        window.setTimeout(function () {
          form.submit(); // já tratado acima: não volta a passar pelo listener
        }, 160);
      }
    });
  }

  function iniciar() {
    var formularios = document.querySelectorAll('.gc-tip-dispensar');
    for (var i = 0; i < formularios.length; i++) preparar(formularios[i]);
  }

  // O script é carregado com `defer` a partir do parcial, logo os cartões já
  // existem. A guarda mantém-no correto mesmo sem `defer`.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
