const { Configuracao } = require('../models');

// Leitura/escrita de configurações chave-valor persistentes.
async function getConfig(chave, fallback = null) {
  const reg = await Configuracao.findOne({ where: { chave } });
  return reg ? reg.valor : fallback;
}

async function setConfig(chave, valor) {
  const [reg] = await Configuracao.findOrCreate({
    where: { chave },
    defaults: { valor },
  });
  if (reg.valor !== valor) {
    reg.valor = valor;
    await reg.save();
  }
  return reg;
}

module.exports = { getConfig, setConfig };
