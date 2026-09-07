const { Condominio } = require('../models');

let cache = null;
let cacheAt = 0;
const TTL = 60 * 1000; // 60 segundos
const cachePorId = new Map();

// Devolve o condomínio (por id quando indicado — fluxo multi-condomínio —
// ou o único/primeiro existente para compatibilidade com fluxos antigos).
async function getCondominio({ force = false, id = null } = {}) {
  const now = Date.now();
  if (id) {
    const anterior = cachePorId.get(id);
    if (!force && anterior && now - anterior.at < TTL) {
      return anterior.condominio;
    }
    const condominio = await Condominio.findByPk(id);
    if (condominio) cachePorId.set(id, { at: now, condominio });
    else cachePorId.delete(id);
    return condominio;
  }
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
  cachePorId.clear();
}

module.exports = { getCondominio, clearCondominioCache };
