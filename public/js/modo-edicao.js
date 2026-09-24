// ══════════════════════════════════════════════════════════════════
// P54-0 — PADRÃO «CONSULTA → EDITAR → CANCELAR → GUARDAR»
//
// Fundação reutilizável para as configurações sensíveis (P54). Par do parcial
// `views/partials/_modo-edicao.handlebars` e de `public/css/modo-edicao.css`.
//
// Contrato (não depende de nenhuma página em concreto):
//   · por omissão o bloco está em CONSULTA — o formulário está `hidden` e
//     nenhum campo é focável ou clicável;
//   · `Editar` ativa o formulário, guarda os valores originais e põe o foco no
//     primeiro campo editável;
//   · `Cancelar` restaura os valores capturados e NUNCA submete; se não houver
//     alterações cancela de imediato, se houver pede confirmação;
//   · ao sair, o foco volta ao botão `Editar`;
//   · com alterações pendentes, a saída da página é protegida (`beforeunload`);
//   · o estado sujo é limpo ao cancelar e ao submeter.
//
// Delegação de eventos em `document`: funciona mesmo que os blocos sejam
// renderizados depois deste script (mesmo padrão de `public/js/app.js`).
//
// ⛔ SEGREDOS. A cópia dos valores originais vive APENAS em memória (closure),
// nunca é escrita no DOM, em atributos, em `localStorage` nem na consola. Não
// há validação de backend neste ficheiro: é só o padrão de UI.
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var CONSULTA = 'consulta';
  var EDICAO = 'edicao';

  var MSG_ABANDONO = 'Há alterações por guardar. Se sair agora, perdem-se.';
  var TITULO_ABANDONO = 'Descartar alterações?';
  var ACAO_ABANDONO = 'Descartar';

  // Valores originais por formulário. ⛔ Só em memória (ver nota de segredos).
  var originais = new WeakMap();
  // Blocos com alterações pendentes — alimenta a guarda de saída.
  var sujos = new Set();

  // ── Leitura/escrita dos campos ────────────────────────────────────
  // `form.elements` é a coleção nativa dos controlos do formulário: inclui
  // apenas descendentes do próprio form (não apanha campos de outro bloco).
  function campos(form) {
    if (!form || !form.elements) return [];
    return Array.prototype.slice.call(form.elements);
  }

  // Um controlo «com nome» é o que participa na submissão. Sem nome não há nada
  // a guardar nem a restaurar; desativado não entra no envio.
  function comNome(c) {
    return Boolean(c) && Boolean(c.name) && !c.disabled;
  }

  function copiar(form) {
    var mapa = {};
    campos(form).forEach(function (c) {
      if (!comNome(c)) return;
      mapa[c.name] = { valor: c.value, marcado: Boolean(c.checked) };
    });
    return mapa;
  }

  function restaurar(form, mapa) {
    campos(form).forEach(function (c) {
      if (!comNome(c) || !Object.prototype.hasOwnProperty.call(mapa, c.name)) return;
      var antes = mapa[c.name];
      if (c.value !== antes.valor) c.value = antes.valor;
      if (c.type === 'checkbox' || c.type === 'radio') c.checked = antes.marcado;
    });
  }

  function alterado(form, mapa) {
    return campos(form).some(function (c) {
      if (!comNome(c) || !Object.prototype.hasOwnProperty.call(mapa, c.name)) return false;
      var antes = mapa[c.name];
      if (String(c.value) !== String(antes.valor)) return true;
      if (c.type === 'checkbox' || c.type === 'radio') return Boolean(c.checked) !== antes.marcado;
      return false;
    });
  }

  // ── Estado do bloco ───────────────────────────────────────────────
  function partes(bloco) {
    return {
      consulta: bloco.querySelector('[data-me-consulta]'),
      form: bloco.querySelector('[data-me-form]'),
      editar: bloco.querySelector('[data-me-editar]')
    };
  }

  function estadoDe(bloco) {
    return bloco.getAttribute('data-me-estado') || CONSULTA;
  }

  // Troca o estado. A consulta e o formulário nunca ficam ativos ao mesmo
  // tempo: um fica `hidden` quando o outro aparece.
  function aplicar(bloco, estado) {
    var p = partes(bloco);
    var emEdicao = estado === EDICAO;
    bloco.setAttribute('data-me-estado', estado);
    if (p.consulta) p.consulta.hidden = emEdicao;
    if (p.form) p.form.hidden = !emEdicao;
    if (p.editar) {
      // `aria-expanded` reflete o estado real do formulário controlado.
      p.editar.setAttribute('aria-expanded', emEdicao ? 'true' : 'false');
      // Em edição o botão fica inerte (não desaparece: um controlo que some
      // deixa o utilizador sem referência). `Cancelar` é o caminho de volta.
      p.editar.disabled = emEdicao;
    }
    return p;
  }

  function focar(el) {
    if (el && typeof el.focus === 'function') el.focus();
  }

  function primeiroEditavel(form) {
    return campos(form).filter(function (c) {
      return comNome(c) && c.type !== 'hidden';
    })[0] || null;
  }

  function entrarEmEdicao(bloco) {
    var p = aplicar(bloco, EDICAO);
    if (!p.form) return;
    originais.set(p.form, copiar(p.form));
    sujos.delete(bloco);
    focar(primeiroEditavel(p.form));
  }

  function voltarAConsulta(bloco) {
    var p = partes(bloco);
    if (p.form) {
      var mapa = originais.get(p.form);
      if (mapa) restaurar(p.form, mapa);
      originais.delete(p.form);
    }
    sujos.delete(bloco);
    aplicar(bloco, CONSULTA);
    // Devolve o foco ao ponto de partida, para o teclado não voltar ao topo.
    if (p.editar) focar(p.editar);
  }

  // ── Confirmação (reutiliza a caixa da aplicação) ───────────────────
  function confirmar(mensagem) {
    if (typeof window.GesConduConfirmar === 'function') {
      return window.GesConduConfirmar(mensagem, {
        titulo: TITULO_ABANDONO,
        acao: ACAO_ABANDONO,
        perigo: true
      });
    }
    // Recurso quando `app.js` não está carregado (ex.: página sem a caixa).
    var ok = typeof window.confirm === 'function' ? window.confirm(mensagem) : true;
    return Promise.resolve(Boolean(ok));
  }

  function mensagemAbandono(bloco) {
    var propria = bloco.getAttribute('data-me-confirmar-abandono');
    return propria && propria.trim() ? propria : MSG_ABANDONO;
  }

  function cancelar(bloco) {
    var p = partes(bloco);
    if (!p.form) return;
    var mapa = originais.get(p.form);
    // Sem alterações não há nada a perder: cancela de imediato, sem perguntar.
    if (!mapa || !alterado(p.form, mapa)) {
      voltarAConsulta(bloco);
      return;
    }
    confirmar(mensagemAbandono(bloco)).then(function (descartar) {
      if (descartar) voltarAConsulta(bloco);
    });
  }

  // ── Eventos (delegação) ───────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var alvo = ev.target;
    if (!alvo || typeof alvo.closest !== 'function') return;

    var editar = alvo.closest('[data-me-editar]');
    if (editar) {
      var blocoEditar = editar.closest('[data-modo-edicao]');
      if (blocoEditar) entrarEmEdicao(blocoEditar);
      return;
    }

    var cancelarBtn = alvo.closest('[data-me-cancelar]');
    if (cancelarBtn) {
      var blocoCancelar = cancelarBtn.closest('[data-modo-edicao]');
      if (blocoCancelar) cancelar(blocoCancelar);
    }
  });

  function marcarSujo(ev) {
    var alvo = ev.target;
    if (!alvo || typeof alvo.closest !== 'function') return;
    var form = alvo.closest('[data-me-form]');
    if (!form) return;
    var bloco = form.closest('[data-modo-edicao]');
    if (!bloco) return;
    var mapa = originais.get(form);
    if (!mapa) return;
    if (alterado(form, mapa)) sujos.add(bloco);
    else sujos.delete(bloco);
  }
  document.addEventListener('input', marcarSujo);
  document.addEventListener('change', marcarSujo);

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || typeof form.closest !== 'function') return;
    var bloco = form.closest('[data-modo-edicao]');
    if (!bloco) return;

    // ⛔ Em consulta NÃO se submete. É a garantia contra o envio acidental
    // (Enter, autofill, script) mesmo que o `hidden` seja anulado por CSS de
    // fora: a decisão não depende do aspeto visual.
    if (estadoDe(bloco) !== EDICAO) {
      ev.preventDefault();
      return;
    }

    // Em edição o envio é legítimo: limpa o estado sujo para a guarda de saída
    // não bloquear a navegação que o próprio utilizador pediu. NÃO há validação
    // de backend aqui — o envio segue intacto.
    sujos.delete(bloco);
    originais.delete(form);
  });

  // ── Guarda de saída ───────────────────────────────────────────────
  window.addEventListener('beforeunload', function (ev) {
    if (sujos.size === 0) return;
    ev.preventDefault();
    // Os browsers modernos ignoram o texto e mostram a sua própria mensagem;
    // o valor devolvido mantém o comportamento dos antigos.
    ev.returnValue = MSG_ABANDONO;
    return MSG_ABANDONO;
  });
})();
