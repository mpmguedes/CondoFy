const express = require('express');
const { eAdmin } = require('../helpers/eAdmin');

const router = express.Router();
router.use(eAdmin);

// Páginas ainda não implementadas: placeholder integrado na navegação,
// com sugestão contextual para o utilizador continuar a trabalhar.
const MODULOS = {
  votacoes: {
    titulo: 'Votações',
    icono: 'how_to_vote',
    sugestao: 'As votações são preparadas nas Assembleias (ordem de trabalhos e convocatórias).',
    linkTexto: 'Ir para Assembleias',
    link: '/admin/assembleias',
  },
  calendario: {
    titulo: 'Calendário',
    icono: 'calendar_month',
    sugestao: 'Agende os acontecimentos do condomínio através das Assembleias.',
    linkTexto: 'Ir para Assembleias',
    link: '/admin/assembleias',
  },
  amenidades: {
    titulo: 'Amenidades',
    icono: 'weekend',
    sugestao: 'Enquanto as amenidades não estão disponíveis, comunique com os condóminos pelos avisos.',
    linkTexto: 'Ir para Comunicações',
    link: '/admin/avisos',
  },
  tickets: {
    titulo: 'Tickets',
    icono: 'confirmation_number',
    sugestao: 'Use os avisos para comunicar assuntos urgentes com os condóminos.',
    linkTexto: 'Ir para Comunicações',
    link: '/admin/avisos',
  },
  seguros: {
    titulo: 'Seguros',
    icono: 'shield',
    sugestao: 'Guarde as apólices e comprovativos dos seguros na biblioteca de documentos.',
    linkTexto: 'Ir para Documentos',
    link: '/admin/documentos',
  },
};

router.get('/:modulo', (req, res, next) => {
  const info = MODULOS[req.params.modulo];
  if (!info) return next();
  res.render('admin/placeholder', {
    titulo: info.titulo,
    modulo: info.titulo,
    icono: info.icono,
    sugestao: info.sugestao,
    linkTexto: info.linkTexto,
    link: info.link,
  });
});

module.exports = router;
