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
(function () {
  const shell = document.getElementById('appShell');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const toggle = document.getElementById('sidebarToggle');
  if (!shell || !toggle) return;

  if (localStorage.getItem('condofy_sidebar_collapsed') === '1' && window.innerWidth > 991) {
    shell.classList.add('collapsed');
  }

  toggle.addEventListener('click', () => {
    if (window.innerWidth <= 991) {
      const open = sidebar.classList.toggle('open');
      if (backdrop) backdrop.classList.toggle('show', open);
    } else {
      shell.classList.toggle('collapsed');
      localStorage.setItem('condofy_sidebar_collapsed', shell.classList.contains('collapsed') ? '1' : '0');
    }
  });

  if (backdrop) {
    backdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      backdrop.classList.remove('show');
    });
  }
})();
