const express = require('express');
const { Pessoa, Fracao } = require('../models');
const { eAutenticado } = require('../helpers/eAdmin');
const { resumoFracao, resumoCondominio, resumoOrcamento } = require('../helpers/saldos');

const router = express.Router();

router.use(eAutenticado);

// Área do condómino — dashboard simples e claro.
router.get('/', async (req, res) => {
  let pessoa = null;
  let fracoesComResumo = [];
  let resumo = null;

  if (req.user.pessoa_id) {
    pessoa = await Pessoa.findByPk(req.user.pessoa_id, {
      include: [{ model: Fracao, as: 'fracoes', through: { attributes: ['vinculo'] } }],
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

  // Transparência: situação financeira global (sem dados de terceiros).
  resumo = await resumoCondominio();
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
