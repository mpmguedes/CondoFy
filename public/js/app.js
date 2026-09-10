// Efeito ripple (Material) em botões
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn, .quick-action');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const diameter = Math.max(rect.width, rect.height);
  const radius = diameter / 2;
  const circle = document.createElement('span');
  circle.style.width = circle.style.height = `${diameter}px`;
  circle.style.left = `${e.clientX - rect.left - radius}px`;
  circle.style.top = `${e.clientY - rect.top - radius}px`;
  circle.classList.add('ripple');
  btn.appendChild(circle);
  setTimeout(() => circle.remove(), 600);
});

// Auto-fechar alertas (snackbar) após 5s
document.querySelectorAll('.alert-dismissible').forEach((a) => {
  setTimeout(() => {
    const btn = a.querySelector('.btn-close');
    if (btn) btn.click();
  }, 5000);
});

// Sidebar: recolher (desktop) / drawer (mobile)
// O mesmo comportamento serve o botão do cabeçalho e o item "Menu" da barra
// inferior (não existe um segundo menu/drawer). Delegação de eventos: funciona
// mesmo que os botões sejam renderizados depois do script.
(function () {
  const shell = document.getElementById('appShell');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!shell || !sidebar) return;

  const mobile = () => window.innerWidth <= 991;
  const botoes = () => Array.prototype.slice.call(document.querySelectorAll('[data-sidebar-toggle]'));

  function alternar() {
    if (mobile()) {
      sidebar.classList.toggle('open');
    } else {
      shell.classList.toggle('collapsed');
      try {
        localStorage.setItem('condofy_sidebar_collapsed', shell.classList.contains('collapsed') ? '1' : '0');
      } catch (e) { /* localStorage indisponível: ignora */ }
    }
    sincronizar();
  }

  function fechar() {
    sidebar.classList.remove('open');
    sincronizar();
  }

  // Estado visual/semântico: item "Menu" ativo enquanto o drawer estiver aberto.
  function sincronizar() {
    const aberto = mobile() && sidebar.classList.contains('open');
    botoes().forEach((b) => b.setAttribute('aria-expanded', aberto ? 'true' : 'false'));
    const menu = document.getElementById('sidebarToggleBottom');
    if (menu) menu.classList.toggle('menu-aberto', aberto);
    if (backdrop) backdrop.classList.toggle('show', aberto);
  }

  try {
    if (localStorage.getItem('condofy_sidebar_collapsed') === '1' && !mobile()) {
      shell.classList.add('collapsed');
    }
  } catch (e) { /* localStorage indisponível: ignora */ }

  // Um único listener para todos os botões (cabeçalho + barra inferior).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sidebar-toggle]');
    if (btn) {
      e.preventDefault();
      alternar();
      return;
    }
    if (backdrop && e.target === backdrop) fechar();
  });

  // Teclado: ESC fecha o drawer.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) fechar();
  });

  // Ao passar para desktop, garantir que o drawer não fica aberto.
  window.addEventListener('resize', () => {
    if (!mobile() && sidebar.classList.contains('open')) fechar();
  });

  sincronizar();
})();

// ── Caixa de confirmação no layout da aplicação ──────────────────────
// Substitui o confirm() nativo do browser: qualquer formulário com
// data-confirmar abre a modal do GesCondu (Bootstrap, nas cores da app) e só
// submete depois de confirmado. Atributos opcionais: data-confirmar-titulo,
// data-confirmar-acao, data-confirmar-perigo="1".
(function () {
  var modalEl = document.getElementById('modalConfirmarGesCondu');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  var modal = new bootstrap.Modal(modalEl);
  var formPendente = null;
  var respostaPendente = null;

  var titulo = document.getElementById('modalConfirmarTitulo');
  var mensagem = document.getElementById('modalConfirmarMensagem');
  var botaoAcao = document.getElementById('modalConfirmarAcao');
  var botaoCancelar = document.getElementById('modalConfirmarCancelar');
  var cabecalho = document.getElementById('modalConfirmarCabecalho');

  // `modo`: 'confirmar' (Cancelar + Confirmar) ou 'aviso' (só Fechar).
  function mostrar(opcoes) {
    var aviso = opcoes.modo === 'aviso';
    if (titulo) titulo.textContent = opcoes.titulo || (aviso ? 'Aviso' : 'Confirmar');
    if (mensagem) mensagem.textContent = opcoes.mensagem || (aviso ? '' : 'Tem a certeza?');
    if (botaoCancelar) botaoCancelar.classList.toggle('d-none', aviso);
    if (botaoAcao) {
      botaoAcao.textContent = opcoes.acao || (aviso ? 'Fechar' : 'Confirmar');
      botaoAcao.className = 'btn ' + (opcoes.perigo ? 'btn-danger' : 'btn-primary');
    }
    if (cabecalho) cabecalho.className = 'modal-header text-white ' + (opcoes.perigo ? 'bg-danger' : 'bg-primary');
    modal.show();
  }

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || !form.getAttribute || !form.hasAttribute('data-confirmar')) return;
    if (form.getAttribute('data-confirmado') === '1') { form.removeAttribute('data-confirmado'); return; }
    ev.preventDefault();
    formPendente = form;
    respostaPendente = null;
    mostrar({
      mensagem: form.getAttribute('data-confirmar'),
      titulo: form.getAttribute('data-confirmar-titulo'),
      acao: form.getAttribute('data-confirmar-acao'),
      perigo: form.getAttribute('data-confirmar-perigo') === '1',
    });
  }, true);

  if (botaoAcao) {
    botaoAcao.addEventListener('click', function () {
      modal.hide();
      if (respostaPendente) { var r = respostaPendente; respostaPendente = null; r(true); return; }
      if (!formPendente) return;
      var form = formPendente;
      formPendente = null;
      form.setAttribute('data-confirmado', '1');
      if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
    });
  }

  modalEl.addEventListener('hidden.bs.modal', function () {
    formPendente = null;
    if (respostaPendente) { var r = respostaPendente; respostaPendente = null; r(false); }
  });

  // API para mensagens dinâmicas (não cabem num atributo):
  //   if (await GesConduConfirmar('…', { perigo: true })) { … }
  window.GesConduConfirmar = function (mensagemTexto, opcoes) {
    opcoes = opcoes || {};
    return new Promise(function (resolve) {
      respostaPendente = resolve;
      formPendente = null;
      mostrar({ mensagem: mensagemTexto, titulo: opcoes.titulo, acao: opcoes.acao, perigo: opcoes.perigo });
    });
  };

  // Aviso simples (só "Fechar"), na mesma caixa da aplicação:
  //   GesConduAviso('O armazenamento do condomínio não está ligado.');
  window.GesConduAviso = function (mensagemTexto, opcoes) {
    opcoes = opcoes || {};
    respostaPendente = null;
    formPendente = null;
    mostrar({
      modo: 'aviso',
      mensagem: mensagemTexto,
      titulo: opcoes.titulo,
      acao: opcoes.acao,
      perigo: Boolean(opcoes.perigo),
    });
  };
})();

// ── Abrir documentos: aviso na aplicação em vez de janela nova ───────
// Ver/Descarregar de um documento passa primeiro por ?verificacao=1 (resposta
// JSON, sem entregar o ficheiro). Se o documento não estiver acessível — serviço
// de armazenamento desligado, ficheiro apagado, conta revogada — a explicação
// aparece na caixa da aplicação, em vez de abrir uma janela com texto simples
// que obrigava o utilizador a voltar atrás. Se estiver acessível, abre como
// sempre (nova janela ou no mesmo separador, conforme o link original).
(function () {
  var seletor = 'a[href*="/documentos/"][href*="/ficheiro"]';

  function abrirComoAntes(a, href) {
    if (a.getAttribute('target') === '_blank') {
      var nova = window.open(href, '_blank', 'noopener');
      if (nova) nova.opener = null;
      return;
    }
    window.location.href = href;
  }

  function avisar(mensagemTexto) {
    if (typeof window.GesConduAviso === 'function') {
      window.GesConduAviso(mensagemTexto, { titulo: 'Não foi possível abrir o documento' });
      return;
    }
    window.alert(mensagemTexto);
  }

  document.addEventListener(
    'click',
    function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var alvo = ev.target && ev.target.closest ? ev.target.closest(seletor) : null;
      if (!alvo || alvo.dataset.semVerificacao === '1') return;
      var href = alvo.getAttribute('href') || '';
      // Só o ficheiro de um documento com id (a rota de link temporário, sem
      // sessão, mantém o comportamento antigo).
      if (!/\/documentos\/\d+\/ficheiro/.test(href)) return;
      ev.preventDefault();

      var url = href + (href.indexOf('?') === -1 ? '?' : '&') + 'verificacao=1';
      var pedido = window.fetch
        ? window.fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        : Promise.reject(new Error('sem fetch'));

      pedido
        .then(function (r) {
          return r
            .json()
            .then(function (dados) {
              return { ok: r.ok, dados: dados || {} };
            })
            .catch(function () {
              return { ok: false, dados: {} };
            });
        })
        .then(function (res) {
          if (res.ok && res.dados.ok) {
            abrirComoAntes(alvo, href);
            return;
          }
          if (res.dados && res.dados.mensagem) {
            avisar(res.dados.mensagem);
            return;
          }
          // Sem resposta da verificação (sessão expirada, rede): tenta abrir
          // como antes, para não bloquear o acesso legítimo.
          abrirComoAntes(alvo, href);
        })
        .catch(function () {
          abrirComoAntes(alvo, href);
        });
    },
    true
  );
})();
