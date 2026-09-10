// ─────────────────────────────────────────────────────────────────────
// Cliente HTTP mínimo para os provedores de armazenamento alternativos
// (Dropbox, OneDrive). Usa o fetch nativo do Node (sem dependências novas),
// com tempo limite, normalização de erros e garantia de que nenhum token
// aparece em mensagens/logs.
// ─────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.STORAGE_HTTP_TIMEOUT_MS || 30000);

// Remove credenciais de qualquer texto que possa ser mostrado/logado.
function sanitizar(texto) {
  return String(texto == null ? '' : texto)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/(access_token|refresh_token|client_secret|code)"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]+/gi, '$1=***')
    .slice(0, 500);
}

function urlComQuery(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function corpoFormulario(dados = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(dados)) {
    if (v !== undefined && v !== null) p.append(k, String(v));
  }
  return p.toString();
}

// Pedido genérico. `resposta` traz sempre { ok, status, headers } e, conforme
// o pedido, `dados` (JSON), `texto` ou `buffer`.
async function pedir(url, opcoes = {}) {
  const { method = 'GET', headers = {}, body, json = null, form = null, binario = false, timeoutMs = TIMEOUT_MS } = opcoes;
  const cabecalhos = { ...headers };
  let corpo = body;
  if (form) {
    cabecalhos['Content-Type'] = cabecalhos['Content-Type'] || 'application/x-www-form-urlencoded';
    corpo = corpoFormulario(form);
  } else if (json !== null) {
    cabecalhos['Content-Type'] = cabecalhos['Content-Type'] || 'application/json';
    corpo = JSON.stringify(json);
  }
  let resposta;
  try {
    resposta = await fetch(url, {
      method,
      headers: cabecalhos,
      body: corpo,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const motivo = err && err.name === 'TimeoutError' ? `sem resposta em ${timeoutMs} ms` : sanitizar(err && err.message);
    const e = new Error(motivo || 'falha de rede');
    e.codigo = 'REDE';
    throw e;
  }
  const saida = { ok: resposta.ok, status: resposta.status, headers: resposta.headers };
  try {
    if (binario) {
      saida.buffer = Buffer.from(await resposta.arrayBuffer());
    } else {
      saida.texto = await resposta.text();
      if (saida.texto) {
        try {
          saida.dados = JSON.parse(saida.texto);
        } catch (err) {
          saida.dados = null;
        }
      }
    }
  } catch (err) {
    saida.texto = '';
    saida.dados = null;
  }
  return saida;
}

// Extrai uma mensagem de erro legível de uma resposta de API.
function mensagemErro(resposta, fallback = 'erro desconhecido') {
  if (!resposta) return fallback;
  const d = resposta.dados || {};
  const candidatos = [
    d.error_description,
    d.error && d.error.message,
    d.error && d.error['@message'],
    d.error_summary,
    d.error,
    d.message,
    resposta.texto,
  ];
  for (const c of candidatos) {
    if (typeof c === 'string' && c.trim()) return sanitizar(c.trim());
  }
  return `${fallback} (HTTP ${resposta.status || '?'})`;
}

// Erro de API normalizado (nunca inclui tokens).
function erroApi(provedor, resposta, contexto = '') {
  const e = new Error(`${provedor}: ${contexto ? contexto + ' — ' : ''}${mensagemErro(resposta)}`);
  e.status = resposta && resposta.status;
  e.provedor = provedor;
  return e;
}

function revogado(resposta) {
  return Boolean(resposta && (resposta.status === 401 || resposta.status === 403));
}

module.exports = { TIMEOUT_MS, sanitizar, urlComQuery, corpoFormulario, pedir, mensagemErro, erroApi, revogado };
