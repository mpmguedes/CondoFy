const { Condominio } = require('../models');

let cache = null;
let cacheAt = 0;
const TTL = 60 * 1000; // 60 segundos

// Devolve a configuração do condomínio (uma única linha), com cache ligeiro.
async function getCondominio({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < TTL) {
    return cache;
  }
  cache = (await Condominio.findOne()) || null;
  cacheAt = now;
  return cache;
}

function clearCondominioCache() {
  cache = null;
  cacheAt = 0;
}

module.exports = { getCondominio, clearCondominioCache };
