const express = require('express');
const { Pessoa, Fracao } = require('../models');
const { eAutenticado } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const { resumoFracao, resumoCondominio, resumoOrcamento } = require('../helpers/saldos');

const router = express.Router();

router.use(eAutenticado);
// Isolamento: a área do condómino mostra apenas o condomínio ativo (sessão).
router.use(tenant.comCondominioAtivo);

// Área do condómino — dashboard simples e claro.
router.get('/', async (req, res) => {
  let pessoa = null;
  let fracoesComResumo = [];
  let resumo = null;

  // A pessoa só é mostrada se pertencer ao condomínio ativo (evita expor
  // dados de outro condomínio ao trocar o condomínio na sidebar).
  if (req.user.pessoa_id) {
    pessoa = await Pessoa.findOne({
      where: { id: req.user.pessoa_id, condominio_id: req.condominioId },
      include: [
        {
          model: Fracao,
          as: 'fracoes',
          through: { attributes: ['vinculo'] },
          where: { condominio_id: req.condominioId },
        },
      ],
    });
    if (pessoa && pessoa.fracoes) {
      fracoesComResumo = await Promise.all(
        pessoa.fracoes.map(async (f) => ({
          ...f.toJSON(),
          resumo: await resumoFracao(f.id),
        }))
      );
    }
  }

  // Transparência: situação financeira global do condomínio ATIVO (sem
  // dados de terceiros/outros condomínios).
  resumo = await resumoCondominio(req.condominioId);
  const orcamento = await resumoOrcamento();

  res.render('condomino/dashboard', {
    titulo: 'A minha área',
    pessoa,
    fracoesComResumo,
    resumo,
    orcamento,
  });
});

module.exports = router;
