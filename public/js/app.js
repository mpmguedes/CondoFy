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
// inferior (não existe um segundo menu/drawer).
(function () {
  const shell = document.getElementById('appShell');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const toggleTopo = document.getElementById('sidebarToggle');
  const toggleMenu = document.getElementById('sidebarToggleBottom');
  if (!shell || (!toggleTopo && !toggleMenu)) return;

  const botoes = [toggleTopo, toggleMenu].filter(Boolean);
  const mobile = () => window.innerWidth <= 991;

  // Estado visual/semântico: item "Menu" ativo enquanto o drawer estiver aberto.
  function sincronizar() {
    const aberto = mobile() && sidebar.classList.contains('open');
    if (toggleMenu) {
      toggleMenu.classList.toggle('menu-aberto', aberto);
      toggleMenu.setAttribute('aria-expanded', aberto ? 'true' : 'false');
    }
    if (toggleTopo) toggleTopo.setAttribute('aria-expanded', aberto ? 'true' : 'false');
    if (backdrop) backdrop.classList.toggle('show', aberto);
  }

  function alternar() {
    if (mobile()) {
      sidebar.classList.toggle('open');
    } else {
      shell.classList.toggle('collapsed');
      localStorage.setItem('condofy_sidebar_collapsed', shell.classList.contains('collapsed') ? '1' : '0');
    }
    sincronizar();
  }

  function fechar() {
    sidebar.classList.remove('open');
    sincronizar();
  }

  if (localStorage.getItem('condofy_sidebar_collapsed') === '1' && !mobile()) {
    shell.classList.add('collapsed');
  }

  botoes.forEach((b) => b.addEventListener('click', alternar));
  if (backdrop) backdrop.addEventListener('click', fechar);

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
