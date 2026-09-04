const express = require('express');
const { eAdmin } = require('../helpers/eAdmin');

const router = express.Router();
router.use(eAdmin);

// Páginas ainda não implementadas: placeholder integrado na navegação.
const MODULOS = {
  votacoes: { titulo: 'Votações', icono: 'how_to_vote' },
  calendario: { titulo: 'Calendário', icono: 'calendar_month' },
  amenidades: { titulo: 'Amenidades', icono: 'weekend' },
  tickets: { titulo: 'Tickets', icono: 'confirmation_number' },
  fornecedores: { titulo: 'Fornecedores', icono: 'local_shipping' },
  seguros: { titulo: 'Seguros', icono: 'shield' },
};

router.get('/:modulo', (req, res, next) => {
  const info = MODULOS[req.params.modulo];
  if (!info) return next();
  res.render('admin/placeholder', {
    titulo: info.titulo,
    modulo: info.titulo,
    icono: info.icono,
  });
});

module.exports = router;
