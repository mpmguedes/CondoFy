const express = require('express');
const tenant = require('../helpers/tenant');
const { executarBackup } = require('../jobs/backup');

const router = express.Router();
// Sistema (backup) — módulo de plataforma/condomínio admin.
// A auditoria passou para Configurações → separador "Auditoria"
// (/admin/config/auditoria, em routes/configuracao.js).
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('admin'));

// O backup é da INSTALAÇÃO (o dump contém dados de TODOS os condomínios), pelo
// que o disparo manual é uma operação da administração global: só um Super
// Admin a pode fazer (`tenant.apenasSuperAdmin`, decidido por
// `users.role_global`). Sem esta guarda, um admin de condomínio iniciava um
// backup da instalação inteira. A guarda corre ANTES do handler, pelo que um
// pedido recusado não chega a arrancar o backup.
router.post('/sistema/backup', tenant.apenasSuperAdmin, async (req, res) => {
  req.flash('success_msg', 'Backup manual iniciado.');
  executarBackup('manual')
    .then((log) => {
      console.log('[backup-manual]', log.estado);
    })
    .catch((err) => console.error('[backup-manual] erro:', err.message));
  res.redirect('/admin');
});

module.exports = router;
