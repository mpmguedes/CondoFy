/**
 * Bloqueio automático da sessão no cliente.
 *
 * Complementa a verificação do servidor (helpers/sessao.js):
 *  · avisa 2 minutos antes de expirar, com botão "Continuar sessão";
 *  · mantém a sessão viva enquanto o utilizador interage (no máximo 1 pedido/min);
 *  · ao voltar de hibernação/suspensão (visibilitychange/focus/pageshow) confirma
 *    com o servidor e, se a sessão já não for válida, volta ao login;
 *  · ao expirar, redireciona para /login?expirada=1.
 *
 * O servidor é sempre a fonte de verdade: se responder que não há sessão, o
 * cliente termina imediatamente. Sem dependências e sem chamadas externas.
 */
(function () {
  'use strict';

  var cfg = window.__SESSAO__;
  if (!cfg || !Number(cfg.expiraEm)) return;

  var expiraEm = Number(cfg.expiraEm);
  var avisoMs = Number(cfg.avisoMs) || 120000;
  var renovarUrl = cfg.renovar || '/sessao/renovar';
  var estadoUrl = cfg.estado || '/sessao/estado';
  var loginUrl = cfg.login || '/login?expirada=1';

  var INTERVALO_PING_MS = 60000; // no máximo 1 renovação por minuto
  var INTERVALO_ESTADO_MS = 10000; // no máximo 1 verificação por 10 s

  var ultimoPing = 0;
  var ultimaVerificacao = 0;
  var temporizadorAviso = null;
  var temporizadorFim = null;
  var aviso = null;
  var aTerminar = false;

  function limparTemporizadores() {
    if (temporizadorAviso) { clearTimeout(temporizadorAviso); temporizadorAviso = null; }
    if (temporizadorFim) { clearTimeout(temporizadorFim); temporizadorFim = null; }
  }

  function esconderAviso() {
    if (aviso && aviso.parentNode) aviso.parentNode.removeChild(aviso);
    aviso = null;
  }

  function expirar() {
    if (aTerminar) return;
    aTerminar = true;
    limparTemporizadores();
    esconderAviso();
    window.location.replace(loginUrl);
  }

  function mostrarAviso() {
    if (aviso || aTerminar) return;
    var minutos = Math.max(1, Math.round((expiraEm - Date.now()) / 60000));

    aviso = document.createElement('div');
    aviso.className = 'sessao-aviso';
    aviso.setAttribute('role', 'alert');
    aviso.setAttribute('aria-live', 'assertive');

    var texto = document.createElement('div');
    texto.className = 'sessao-aviso-texto';
    texto.textContent = 'A sua sessão expira em ' + minutos + ' min por inatividade.';

    var acoes = document.createElement('div');
    acoes.className = 'sessao-aviso-acoes';

    var continuar = document.createElement('button');
    continuar.type = 'button';
    continuar.className = 'btn btn-sm btn-primary';
    continuar.textContent = 'Continuar sessão';
    continuar.addEventListener('click', function () { renovar(); });

    var sair = document.createElement('a');
    sair.className = 'btn btn-sm btn-outline-secondary';
    sair.href = '/logout';
    sair.textContent = 'Terminar sessão';

    acoes.appendChild(continuar);
    acoes.appendChild(sair);
    aviso.appendChild(texto);
    aviso.appendChild(acoes);
    document.body.appendChild(aviso);
    continuar.focus();
  }

  function agendar() {
    limparTemporizadores();
    var faltam = expiraEm - Date.now();
    if (faltam <= 0) return expirar();
    if (faltam > avisoMs) {
      temporizadorAviso = setTimeout(mostrarAviso, faltam - avisoMs);
    } else {
      mostrarAviso();
    }
    temporizadorFim = setTimeout(expirar, faltam);
  }

  function aplicarEstado(dados) {
    if (!dados || dados.autenticado !== true || !dados.expiraEm) return expirar();
    expiraEm = Number(dados.expiraEm);
    esconderAviso();
    agendar();
    return null;
  }

  function pedir(url, metodo) {
    return fetch(url, {
      method: metodo || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(aplicarEstado)
      .catch(function () { /* rede em baixo: decide no próximo pedido ao servidor */ });
  }

  function renovar() {
    ultimoPing = Date.now();
    return pedir(renovarUrl, 'POST');
  }

  function verificarEstado() {
    var agora = Date.now();
    if (agora - ultimaVerificacao < INTERVALO_ESTADO_MS) return;
    ultimaVerificacao = agora;
    // Já passou do limite: nem vale a pena perguntar.
    if (agora > expiraEm) return expirar();
    return pedir(estadoUrl, 'GET');
  }

  // Atividade do utilizador → mantém a sessão viva (com limite de frequência).
  var EVENTOS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  function aoInteragir() {
    if (aTerminar) return;
    if (Date.now() - ultimoPing < INTERVALO_PING_MS) return;
    if (Date.now() > expiraEm - avisoMs) return; // aviso/botão já estão visíveis
    renovar();
  }
  for (var i = 0; i < EVENTOS.length; i++) {
    window.addEventListener(EVENTOS[i], aoInteragir, { passive: true });
  }

  // Retoma de hibernação/suspensão ou volta ao separador.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) verificarEstado();
  });
  window.addEventListener('focus', verificarEstado);
  window.addEventListener('pageshow', verificarEstado);

  agendar();
})();
