const express = require('express');
const tenant = require('../helpers/tenant');

const router = express.Router();

// Módulos ainda não implementados, todos do backoffice do CONDOMÍNIO.
// O acesso segue o das funcionalidades que representam (não `users.role`, que é
// legado): a página só é servida a quem tem condomínio ativo e papel suficiente.
// `minimo` espelha a visibilidade na navegação (`condominioAtivo.role`):
//  - 'gestor' → visíveis a admin e gestor (Assembleias, Fornecedores, Comunicações);
//  - 'admin'  → escondidos ao gestor na navegação e reservados ao admin.
const router_guarda = (minimo) => {
  if (minimo === 'admin') return [tenant.comCondominioAtivo, tenant.comPapel('admin')];
  return [tenant.comCondominioAtivo, tenant.comPapel('gestor')];
};

// Páginas ainda não implementadas: placeholder integrado na navegação,
// com sugestão contextual para o utilizador continuar a trabalhar.
const MODULOS = {
  votacoes: {
    titulo: 'Votações',
    icono: 'how_to_vote',
    minimo: 'gestor',
    sugestao: 'As votações são preparadas nas Assembleias (ordem de trabalhos e convocatórias).',
    linkTexto: 'Ir para Assembleias',
    link: '/admin/assembleias',
  },
  amenidades: {
    titulo: 'Amenidades',
    icono: 'weekend',
    minimo: 'gestor',
    sugestao: 'Enquanto as amenidades não estão disponíveis, comunique com os condóminos pelos avisos.',
    linkTexto: 'Ir para Comunicações',
    link: '/admin/avisos',
  },
  tickets: {
    titulo: 'Tickets',
    icono: 'confirmation_number',
    minimo: 'admin',
    sugestao: 'Use os avisos para comunicar assuntos urgentes com os condóminos.',
    linkTexto: 'Ir para Comunicações',
    link: '/admin/avisos',
  },
  seguros: {
    titulo: 'Seguros',
    icono: 'shield',
    minimo: 'admin',
    sugestao: 'Guarde as apólices e comprovativos dos seguros na biblioteca de documentos.',
    linkTexto: 'Ir para Documentos',
    link: '/admin/documentos',
  },
};

router.get('/:modulo', (req, res, next) => {
  const info = MODULOS[req.params.modulo];
  if (!info) return next();
  // Guarda por módulo: cada placeholder exige o papel do módulo real que
  // representa. Executa a cadeia completa para que os guardas de condomínio
  // definam `req.papelCondominio` antes de `comPapel` decidir.
  const guards = router_guarda(info.minimo);
  let i = 0;
  const passo = (err) => {
    if (err) return next(err);
    const g = guards[i++];
    if (!g) {
      return res.render('admin/placeholder', {
        titulo: info.titulo,
        modulo: info.titulo,
        icono: info.icono,
        sugestao: info.sugestao,
        linkTexto: info.linkTexto,
        link: info.link,
      });
    }
    return g(req, res, passo);
  };
  passo();
});

module.exports = router;
module.exports.MODULOS = MODULOS;
