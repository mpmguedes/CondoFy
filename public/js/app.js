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
  var cabecalho = document.getElementById('modalConfirmarCabecalho');

  function mostrar(opcoes) {
    if (titulo) titulo.textContent = opcoes.titulo || 'Confirmar';
    if (mensagem) mensagem.textContent = opcoes.mensagem || 'Tem a certeza?';
    if (botaoAcao) {
      botaoAcao.textContent = opcoes.acao || 'Confirmar';
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
})();
