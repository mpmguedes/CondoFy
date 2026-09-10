const express = require('express');
const tenant = require('../helpers/tenant');
const router = express.Router();

// Decisão pura do destino após autenticação (testável offline):
//  - sem condomínio ESCOLHIDO válido na sessão → voltar sempre a
//    "Os meus condomínios" (mesmo com apenas um condomínio);
//  - com condomínio escolhido → dashboard conforme o papel (legado mantido).
function destinoAposLogin({ meus = [], ativo = null, user = {} } = {}) {
  const valido = meus.some((c) => c.id === ativo);
  if (!valido) {
    return { redirecionar: '/condominios', limparAtivo: Boolean(ativo) };
  }
  const global = user.role_global === 'super_admin';
  return { redirecionar: user.role === 'admin' || global ? '/admin' : '/condomino', limparAtivo: false };
}

// Página inicial: LOGIN → "Os meus condomínios" → escolha → dashboard.
// Sem sessão, a raiz serve a HOMEPAGE PÚBLICA (nome da aplicação visível) em vez
// de redirecionar para a entrada: era essa a única razão da verificação da
// marca na Google Auth Platform («o nome do app não corresponde ao nome na
// página inicial»). A homepage não exige sessão nem condomínio e usa o layout
// público já existente; o percurso de quem tem sessão fica exatamente igual.
router.get('/', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.render('publicas/home', { layout: 'blank' });
  }
  try {
    const meus = await tenant.listarCondominios(req.user.id);
    const decisao = destinoAposLogin({ meus, ativo: tenant.ativo(req), user: req.user });
    if (decisao.limparAtivo) {
      delete req.session.condominio_ativo_id;
    }
    return res.redirect(decisao.redirecionar);
  } catch (err) {
    console.error('[home]', err.message);
    req.flash('error_msg', 'Ocorreu um erro ao preparar a sua área.');
    return res.redirect('/login');
  }
});

module.exports = router;
module.exports.destinoAposLogin = destinoAposLogin;
