const express = require('express');
const { AuditLog, User } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const { executarBackup } = require('../jobs/backup');

const router = express.Router();
router.use(eAdmin);

router.get('/auditoria', async (req, res) => {
  const logs = await AuditLog.findAll({
    include: [{ model: User, as: 'user', attributes: ['nome', 'email'] }],
    order: [['id', 'DESC']],
    limit: 300,
  });
  res.render('admin/sistema/auditoria', { titulo: 'Auditoria', logs });
});

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
