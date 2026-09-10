// ─────────────────────────────────────────────────────────────────────
// Cabeçalhos HTTP de ficheiro (nome e tipo de conteúdo) — ponto único.
//
// PORQUÊ: os cabeçalhos HTTP só aceitam Latin-1. Definir um
// `Content-Disposition` com um nome que tenha um caractere fora desse intervalo
// (travessão "–", aspas curvas, emoji, escrita não latina) faz o Node lançar
// `ERR_INVALID_CHAR` em `res.setHeader`. Dentro de uma rota `async` sem
// try/catch, essa exceção torna-se uma rejeição não tratada e **derruba o
// processo do servidor** — atrás de um proxy, o utilizador vê um 502 e a
// aplicação reinicia (perdendo pedidos em curso).
//
// SOLUÇÃO: enviar o nome duas vezes, como manda o RFC 6266/5987:
//   · `filename="…"`       → versão ASCII (para browsers antigos);
//   · `filename*=UTF-8''…` → nome completo em UTF-8 percentual (browsers atuais).
// O nome mostrado ao utilizador nunca se perde: só a variante ASCII é
// reduzida. O tipo de conteúdo é validado (tipo/subtipo) pela mesma razão.
// ─────────────────────────────────────────────────────────────────────

// Nome saneado, mantendo acentos e escrita não latina (é o nome que o browser
// mostra e o que segue em `filename*`). Remove CR/LF/aspas/barras e limites de
// tamanho — nunca pode quebrar o cabeçalho nem sugerir caminhos.
function nomeSeguro(nome, defeito = 'documento') {
  return (
    String(nome == null ? '' : nome)
      .replace(/[\r\n"\\/]+/g, '_')
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .trim()
      .slice(0, 120) || defeito
  );
}

// Variante para o parâmetro simples `filename="…"`: só ASCII imprimível.
function nomeAscii(nome, defeito = 'documento') {
  return nomeSeguro(nome, defeito).replace(/[^\x20-\x7e]/g, '_') || defeito;
}

// `filename*` (RFC 5987): UTF-8 percentual.
function nomeCodificado(nome, defeito = 'documento') {
  return encodeURIComponent(nomeSeguro(nome, defeito)).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// Cabeçalho completo: `inline` (ver) ou `attachment` (descarregar).
function disposicao(nome, tipo = 'inline', defeito = 'documento') {
  const modo = tipo === 'attachment' ? 'attachment' : 'inline';
  return `${modo}; filename="${nomeAscii(nome, defeito)}"; filename*=UTF-8''${nomeCodificado(nome, defeito)}`;
}

// Tipo de conteúdo seguro: só "tipo/subtipo". O mime pode vir da base de dados
// (gravado a partir de um upload), por isso nunca vai em bruto para um
// cabeçalho.
function tipoSeguro(mimeType) {
  const tipo = String(mimeType == null ? '' : mimeType).trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(tipo) ? tipo : 'application/octet-stream';
}

// Aplica os dois cabeçalhos de uma vez, de forma defensiva: nunca lança (se o
// nome ou o tipo forem inesperados, cai no valor genérico).
function aplicarCabecalhos(res, { nome, tipo, mimeType, defeito = 'documento' } = {}) {
  try {
    res.setHeader('Content-Type', tipoSeguro(mimeType));
    res.setHeader('Content-Disposition', disposicao(nome, tipo, defeito));
    return true;
  } catch (err) {
    console.error('[cabecalhos] não foi possível definir os cabeçalhos do ficheiro:', err && err.message);
    return false;
  }
}

module.exports = {
  nomeSeguro,
  nomeAscii,
  nomeCodificado,
  disposicao,
  tipoSeguro,
  aplicarCabecalhos,
};
