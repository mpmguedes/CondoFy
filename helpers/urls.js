// ─────────────────────────────────────────────────────────────────────
// URLs introduzidas por utilizadores (referências externas).
//
// Existe um único ponto de decisão: uma URL só é mostrada/guardada quando é
// http(s) absoluta e válida. Tudo o resto (`javascript:`, `data:`, `vbscript:`,
// esquemas personalizados, texto solto) é descartado — devolvendo null, para
// que a vista simplesmente não apresente a ligação.
//
// Usado em três sítios, para não haver regras divergentes:
//  · `helpers/handlebars-helpers.js` → `urlDocumentoExterno` (o que chega às vistas);
//  · `routes/documentos.js` → gravação da referência externa de um documento;
//  · `routes/documentos.js` → listagem de gestão (dados antigos já gravados).
// ─────────────────────────────────────────────────────────────────────

// Devolve a URL normalizada quando é http(s) válida; caso contrário, null.
function urlExternaSegura(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return null;
  let url;
  try {
    url = new URL(texto);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.toString();
}

// Versão booleana (para condições em vistas e testes).
function eUrlExternaSegura(valor) {
  return urlExternaSegura(valor) !== null;
}

module.exports = { urlExternaSegura, eUrlExternaSegura };
