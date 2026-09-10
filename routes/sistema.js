const express = require('express');
const tenant = require('../helpers/tenant');
const { executarBackup } = require('../jobs/backup');

const router = express.Router();
// Sistema (backup) — módulo de plataforma/condomínio admin.
// A auditoria passou para Configurações → separador "Auditoria"
// (/admin/config/auditoria, em routes/configuracao.js).
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('admin'));

router.post('/sistema/backup', async (req, res) => {
  req.flash('success_msg', 'Backup manual iniciado.');
  executarBackup('manual')
    .then((log) => {
      console.log('[backup-manual]', log.estado);
    })
    .catch((err) => console.error('[backup-manual] erro:', err.message));
  res.redirect('/admin');
});

module.exports = router;
