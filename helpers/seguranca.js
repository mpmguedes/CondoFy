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

// ── CSRF ────────────────────────────────────────────────────────────
// Proteção por origem/referer para pedidos de escrita: quando o browser
// envia Origin (todos os POST fetch e formulários modernos), a origem tem
// de bater com o host da aplicação. Pedidos sem Origin/Referer (clientes
// antigos/APIs internas) passam — o cookie SameSite=Lax cobre o CSRF clássico.
function protegerOrigem(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(req.method)) return next();
  const host = req.get('host');
  const originHeader = req.headers.origin;
  const referer = req.headers.referer;
  const origem = originHeader || referer;
  if (!origem) return next();

  const alvo = originHeader || referer;
  try {
    const u = new URL(alvo);
    return u.host === host ? next() : res.status(403).send('Pedido rejeitado (origem não permitida).');
  } catch (err) {
    return alvo.startsWith(`${req.protocol}://${host}`) ? next() : res.status(403).send('Pedido rejeitado (origem não permitida).');
  }
}

module.exports = { createLimiter, protegerOrigem };

