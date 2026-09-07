// ─────────────────────────────────────────────────────────────────────
// Segurança transversal — rate limiting simples em memória (sem Redis).
// Adequado a instalação de processo único; limites por chave (ip:rotulo).
// ─────────────────────────────────────────────────────────────────────

// createLimiter({ rotulo, max, janelaMs, msg }) → middleware Express.
// Em caso de excesso responde 429 e mostra flash (não bloqueia o processo).
function createLimiter({ rotulo, max = 10, janelaMs = 10 * 60 * 1000, msg }) {
  const mapa = new Map(); // chave → { contagem, inicio }

  return (req, res, next) => {
    const chave = `${rotulo}:${req.ip || 'desconhecido'}`;
    const agora = Date.now();
    const anterior = mapa.get(chave);
    if (!anterior || agora - anterior.inicio >= janelaMs) {
      mapa.set(chave, { contagem: 1, inicio: agora });
      return next();
    }
    if (anterior.contagem >= max) {
      req.flash('error_msg', msg || 'Demasiadas tentativas. Aguarde alguns minutos e tente novamente.');
      return res.status(429).redirect(req.originalUrl && req.originalUrl !== '/' ? req.originalUrl.split('?')[0] : '/');
    }
    anterior.contagem += 1;
    mapa.set(chave, anterior);
    return next();
  };
}

module.exports = { createLimiter };
