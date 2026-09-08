/**
 * Validação e formatação de NIF (número de contribuinte) e IBAN portugueses.
 *
 * - Sem dependências externas e sem qualquer chamada de rede.
 * - Fonte única: o mesmo ficheiro é usado pelo browser (window.ValidacaoFiscal)
 *   e pelo backend (require('.../public/js/validacao-fiscal')). Assim o
 *   algoritmo existe num só lugar e não pode divergir entre frontend/backend.
 * - Valida apenas a matemática do NIF/IBAN. NÃO verifica se a conta bancária
 *   existe nem consulta entidades externas.
 *
 * Convenções de retorno: { ok, valor, mensagem, motivo }
 *  - valor: forma normalizada (NIF: 9 dígitos; IBAN: sem espaços, maiúsculas)
 *  - mensagem: texto para a interface (nunca técnico)
 *  - motivo: uso interno/testes ('vazio' | 'formato' | 'prefixo' | 'controlo' |
 *    'comprimento' | 'pais')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ValidacaoFiscal = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MENSAGEM_NIF = 'NIF inválido. Verifique o número introduzido.';
  var MENSAGEM_IBAN = 'IBAN inválido. Verifique o número introduzido.';

  // Separadores tolerados na introdução (espaços, incluindo não separáveis,
  // ponto, hífen, barra e travessões). Não remove letras nem outros caracteres.
  var SEPARADORES = /[\s.\-\u00A0\u2013\u2014/]/g;

  // ─────────────────────────── NIF ───────────────────────────

  function normalizarNif(valor) {
    return String(valor == null ? '' : valor).replace(SEPARADORES, '');
  }

  // Primeiro dígito: 1,2,3 singulares · 5 coletivas · 6 entidades públicas ·
  // 7 outras entidades · 8 empresário em nome individual · 9 condomínios e
  // outras. "45" corresponde a contribuinte não residente.
  function prefixoNifValido(nif) {
    if (nif.charAt(0) === '4') return nif.slice(0, 2) === '45';
    return '12356789'.indexOf(nif.charAt(0)) !== -1;
  }

  // Dígito de controlo: pesos 9..2 sobre os 8 primeiros dígitos; módulo 11.
  function digitoControloNif(nif) {
    var soma = 0;
    for (var i = 0; i < 8; i++) soma += Number(nif.charAt(i)) * (9 - i);
    var resto = soma % 11;
    var dv = 11 - resto;
    return dv >= 10 ? 0 : dv;
  }

  function validarNif(valor) {
    var bruto = String(valor == null ? '' : valor).trim();
    if (!bruto) return { ok: true, valor: '', mensagem: '', motivo: 'vazio' };

    var nif = normalizarNif(bruto);
    if (!/^\d{9}$/.test(nif)) return { ok: false, valor: nif, mensagem: MENSAGEM_NIF, motivo: 'formato' };
    if (!prefixoNifValido(nif)) return { ok: false, valor: nif, mensagem: MENSAGEM_NIF, motivo: 'prefixo' };
    if (digitoControloNif(nif) !== Number(nif.charAt(8))) {
      return { ok: false, valor: nif, mensagem: MENSAGEM_NIF, motivo: 'controlo' };
    }
    return { ok: true, valor: nif, mensagem: '', motivo: '' };
  }

  // Apresentação: "123 456 789" (o valor guardado continua a ser 123456789).
  function formatarNif(valor) {
    var nif = normalizarNif(valor);
    if (!/^\d{9}$/.test(nif)) return String(valor == null ? '' : valor).trim();
    return nif.slice(0, 3) + ' ' + nif.slice(3, 6) + ' ' + nif.slice(6);
  }

  // ─────────────────────────── IBAN ───────────────────────────

  function normalizarIban(valor) {
    return String(valor == null ? '' : valor).replace(SEPARADORES, '').toUpperCase();
  }

  // Comprimentos oficiais dos países mais usados num condomínio português.
  // Países fora desta tabela são aceites com o intervalo genérico (15-34).
  var COMPRIMENTO_PAIS = {
    PT: 25, ES: 24, FR: 27, DE: 22, IT: 27, NL: 18, BE: 16, LU: 20,
    GB: 22, IE: 22, CH: 21, AT: 20, AD: 24, MC: 27, SM: 27, GI: 23,
  };

  // MOD-97: mover os 4 primeiros caracteres para o fim e converter letras em
  // números (A=10 … Z=35), acumulando módulo 97 dígito a dígito (sem BigInt).
  function mod97(iban) {
    var reordenado = iban.slice(4) + iban.slice(0, 4);
    var resto = 0;
    for (var i = 0; i < reordenado.length; i++) {
      var c = reordenado.charAt(i);
      var codigo = c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c;
      for (var j = 0; j < codigo.length; j++) {
        resto = (resto * 10 + Number(codigo.charAt(j))) % 97;
      }
    }
    return resto;
  }

  /**
   * @param {string} valor
   * @param {{exigirPT?: boolean}} [opcoes] exigirPT restringe a IBANs portugueses.
   */
  function validarIban(valor, opcoes) {
    var op = opcoes || {};
    var bruto = String(valor == null ? '' : valor).trim();
    if (!bruto) return { ok: true, valor: '', pais: '', mensagem: '', motivo: 'vazio' };

    var iban = normalizarIban(bruto);
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
      return { ok: false, valor: iban, pais: iban.slice(0, 2), mensagem: MENSAGEM_IBAN, motivo: 'formato' };
    }

    var pais = iban.slice(0, 2);
    if (pais === 'PT' && iban.length !== 25) {
      return { ok: false, valor: iban, pais: pais, mensagem: MENSAGEM_IBAN, motivo: 'comprimento' };
    }
    var esperado = COMPRIMENTO_PAIS[pais];
    if (esperado && iban.length !== esperado) {
      return { ok: false, valor: iban, pais: pais, mensagem: MENSAGEM_IBAN, motivo: 'comprimento' };
    }
    if (op.exigirPT && pais !== 'PT') {
      return { ok: false, valor: iban, pais: pais, mensagem: MENSAGEM_IBAN, motivo: 'pais' };
    }
    if (mod97(iban) !== 1) {
      return { ok: false, valor: iban, pais: pais, mensagem: MENSAGEM_IBAN, motivo: 'controlo' };
    }
    return { ok: true, valor: iban, pais: pais, mensagem: '', motivo: '' };
  }

  // Apresentação: "PT50 0002 0123 1234 5678 9015 4" (guardado sem espaços).
  // Tolerante a valores parciais (formatação durante a escrita).
  function formatarIban(valor) {
    var iban = normalizarIban(valor);
    if (!iban) return '';
    return iban.replace(/(.{4})(?=.)/g, '$1 ');
  }

  // ───────────────────── Interface (browser) ─────────────────────
  // Só corre no browser; no Node estas funções existem mas não são usadas.

  var rotulos = { nif: 'NIF', iban: 'IBAN' };

  function ehNavegador() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
  }

  function garantirFeedback(input) {
    var descrito = input.getAttribute('aria-describedby');
    var el = descrito ? document.getElementById(descrito) : null;
    if (el) return el;

    el = document.createElement('span');
    el.className = 'campo-validacao';
    el.id = (input.id || input.name || 'campo') + '-validacao';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', el.id);

    // Fica na linha do rótulo: não altera a altura do formulário.
    var rotulo = input.closest('.mb-3') ? input.closest('.mb-3').querySelector('label') : null;
    if (rotulo) rotulo.appendChild(el);
    else input.insertAdjacentElement('afterend', el);
    return el;
  }

  function limparEstado(input, feedback) {
    input.classList.remove('is-valid', 'is-invalid');
    input.removeAttribute('aria-invalid');
    feedback.textContent = '';
    feedback.className = 'campo-validacao';
  }

  function mostrarEstado(input, feedback, resultado, rotulo) {
    if (resultado.ok) {
      input.classList.remove('is-invalid');
      input.classList.add('is-valid');
      input.removeAttribute('aria-invalid');
      feedback.className = 'campo-validacao campo-validacao-ok';
      feedback.textContent = '\u2713 ' + rotulo + ' válido';
    } else {
      input.classList.remove('is-valid');
      input.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      feedback.className = 'campo-validacao campo-validacao-erro';
      feedback.textContent = resultado.mensagem;
    }
  }

  // Comprimento a partir do qual já vale a pena avaliar (evita erros prematuros).
  function prontoParaValidar(tipo, normalizado) {
    if (tipo === 'nif') return normalizado.length >= 9;
    if (normalizado.slice(0, 2) === 'PT') return normalizado.length >= 25;
    return normalizado.length >= 15;
  }

  // Formata o IBAN no próprio campo preservando o cursor.
  function formatarCampoIban(input) {
    var valor = input.value;
    var inicio = input.selectionStart;
    var fim = input.selectionEnd;
    var significativosAntes = valor.slice(0, inicio).replace(/[^0-9A-Za-z]/g, '').length;
    var formatado = formatarIban(valor);
    if (formatado === valor) return;

    input.value = formatado;
    var pos = 0;
    var contados = 0;
    while (pos < formatado.length && contados < significativosAntes) {
      if (/[0-9A-Za-z]/.test(formatado.charAt(pos))) contados++;
      pos++;
    }
    // Seleção ativa: colapsa no fim do texto significativo anterior (previsível).
    input.setSelectionRange(pos, pos);
  }

  function avaliar(input, feedback, rotulo, forcar) {
    var tipo = input.getAttribute('data-validar');
    var valor = input.value;
    var normalizado = tipo === 'nif' ? normalizarNif(valor) : normalizarIban(valor);

    if (!normalizado) {
      limparEstado(input, feedback);
      return null;
    }
    if (!forcar && !prontoParaValidar(tipo, normalizado)) {
      limparEstado(input, feedback);
      return null;
    }
    var resultado = tipo === 'nif' ? validarNif(valor) : validarIban(valor);
    if (resultado.ok && !valor.trim()) {
      limparEstado(input, feedback);
      return resultado;
    }
    mostrarEstado(input, feedback, resultado, rotulo);
    return resultado;
  }

  function iniciarCampo(input) {
    var tipo = input.getAttribute('data-validar');
    if (tipo !== 'nif' && tipo !== 'iban') return;
    var rotulo = rotulos[tipo];
    var feedback = garantirFeedback(input);

    // Backspace/Delete sobre um espaço: avança o cursor para apagar o
    // algarismo/letra adjacente em vez de "reformatar" o espaço.
    input.addEventListener('keydown', function (ev) {
      if (tipo !== 'iban') return;
      if (input.selectionStart !== input.selectionEnd) return;
      if (ev.key === 'Backspace' && input.selectionStart > 0) {
        if (/\s$/.test(input.value.slice(0, input.selectionStart))) {
          input.setSelectionRange(input.selectionStart - 1, input.selectionStart - 1);
        }
      } else if (ev.key === 'Delete' && input.selectionStart < input.value.length) {
        if (/^\s/.test(input.value.slice(input.selectionStart))) {
          input.setSelectionRange(input.selectionStart + 1, input.selectionStart + 1);
        }
      }
    });

    input.addEventListener('input', function () {
      if (tipo === 'iban') formatarCampoIban(input);
      avaliar(input, feedback, rotulo, false);
    });

    input.addEventListener('blur', function () {
      avaliar(input, feedback, rotulo, true);
    });

    // Campos pré-preenchidos (edição): mostra o IBAN já formatado e avalia
    // sem esperar interação. O valor guardado só muda se o registo for gravado.
    if (input.value.trim()) {
      if (tipo === 'iban') formatarCampoIban(input);
      avaliar(input, feedback, rotulo, true);
    }
  }

  function iniciarValidacaoCampos(raiz) {
    if (!ehNavegador()) return 0;
    var alvo = raiz || document;
    var campos = alvo.querySelectorAll('[data-validar="nif"], [data-validar="iban"]');
    for (var i = 0; i < campos.length; i++) {
      if (!campos[i].dataset.validacaoIniciada) {
        campos[i].dataset.validacaoIniciada = '1';
        iniciarCampo(campos[i]);
      }
    }
    return campos.length;
  }

  if (ehNavegador()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { iniciarValidacaoCampos(); });
    } else {
      iniciarValidacaoCampos();
    }
  }

  return {
    MENSAGEM_NIF: MENSAGEM_NIF,
    MENSAGEM_IBAN: MENSAGEM_IBAN,
    normalizarNif: normalizarNif,
    validarNif: validarNif,
    formatarNif: formatarNif,
    normalizarIban: normalizarIban,
    validarIban: validarIban,
    formatarIban: formatarIban,
    mod97: mod97,
    iniciarValidacaoCampos: iniciarValidacaoCampos,
  };
});
