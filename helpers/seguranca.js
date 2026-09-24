// ─────────────────────────────────────────────────────────────────────
// Segurança transversal — rate limiting simples em memória (sem Redis).
// Adequado a instalação de processo único; limites por chave (ip:rotulo).
// ─────────────────────────────────────────────────────────────────────

// ── Identidade para limites de operações AUTENTICADAS ────────────────
// O limite por IP serve o LOGIN (onde ainda não há identidade). Numa operação
// já autenticada, o IP é a chave errada nos dois sentidos:
//   · um atacante com sessão válida escapa mudando de rede/proxy;
//   · vários administradores atrás do mesmo NAT bloqueiam-se uns aos outros.
// Por isso a chave é o UTILIZADOR e, na sua falta, a SESSÃO, e só em último
// recurso o IP. Nunca apenas o IP (requisito do P54-3).
function identidadeAutenticada(req) {
  const id = req && req.user && req.user.id;
  if (id) return `u:${id}`;
  const sessao = req && req.sessionID;
  if (sessao) return `s:${sessao}`;
  return `ip:${(req && req.ip) || 'desconhecido'}`;
}

// createLimiter({ rotulo, max, janelaMs, msg, chaveDe }) → middleware Express.
// Em caso de excesso responde 429 e mostra flash (não bloqueia o processo).
//
// `chaveDe(req)` é opcional e permite escolher a IDENTIDADE a limitar. Sem ele
// mantém-se o comportamento anterior (por IP), pelo que os limites do login em
// `routes/auth.js` não mudam. Para operações autenticadas usar
// `chaveDe: identidadeAutenticada`.
function createLimiter({ rotulo, max = 10, janelaMs = 10 * 60 * 1000, msg, chaveDe }) {
  const mapa = new Map(); // chave → { contagem, inicio }
  const identidade = typeof chaveDe === 'function' ? chaveDe : (req) => (req && req.ip) || 'desconhecido';

  return (req, res, next) => {
    const chave = `${rotulo}:${identidade(req)}`;
    const agora = Date.now();
    const anterior = mapa.get(chave);
    if (!anterior || agora - anterior.inicio >= janelaMs) {
      mapa.set(chave, { contagem: 1, inicio: agora });
      return next();
    }
    if (anterior.contagem >= max) {
      req.flash('error_msg', msg || 'Demasiadas tentativas. Aguarde alguns minutos e tente novamente.');
      const destino = req.originalUrl && req.originalUrl !== '/' ? req.originalUrl.split('?')[0] : '/';
      // ⛔ `res.status(429).redirect(url)` NÃO devolve 429: o `redirect` do
      // Express repõe o estado a 302, e o 429 PERDIA-SE — quem fosse limitado
      // via um redirect normal e não percebia porquê (nem um teste o detetava).
      // A forma correta é entregar o estado ao próprio `redirect`.
      return res.redirect(429, destino);
    }
    anterior.contagem += 1;
    mapa.set(chave, anterior);
    return next();
  };
}

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

module.exports = { createLimiter, identidadeAutenticada, protegerOrigem };

