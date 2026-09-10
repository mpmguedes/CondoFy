// ─────────────────────────────────────────────────────────────────────
// Acesso a documentos — camada ÚNICA e obrigatória de autorização.
//
// INVARIANTE DE SEGURANÇA DO GESCONDU
//   Nenhum documento é acessível por link direto sem autorização. Conhecer
//   um id, um nome de ficheiro ou um caminho não dá acesso a nada: o ficheiro
//   só sai do backend depois de verificar, pela ordem indicada:
//
//     1. existe sessão/autenticação válida?   (req.user / req.isAuthenticated)
//     2. quem é o utilizador autenticado?     (req.user.id)
//     3. a que condomínio pertence?           (req.condominioId, da sessão)
//     4. que documento é pedido e pertence a esse condomínio?
//        (documentos.condominio_id === req.condominioId)
//     5. esse utilizador tem permissão para ESTE documento?
//        (admin/gestor do condomínio: todos; condómino: só os disponibilizados)
//
//   A autorização é sempre Utilizador → Condomínio → Documento, nunca
//   Utilizador → Documento. O condomínio NUNCA vem do pedido (query/body) —
//   vem da sessão, validada por helpers/tenant.js.
//
// O ficheiro é servido por streaming a partir do provedor de armazenamento
// (helpers/storage.abrirFluxo). Nenhum link do fornecedor (Drive/Dropbox/
// OneDrive) é devolvido ao browser: links de partilha públicos não são
// criados nem usados.
//
// Links temporários (para destinatários externos de email, sem conta no
// GesCondu): assinados com HMAC-SHA256, ligados ao documento E ao condomínio,
// com validade limitada e emitidos apenas depois da autorização acima. Não
// transformam o documento num ficheiro público: expiram, são de uso único por
// documento e cada acesso fica registado na auditoria. Para quem tem conta,
// o caminho é sempre a rota autenticada.
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { Documento } = require('../models');
const { audit } = require('./audit');
const storage = require('./storage');

// Papéis que podem ver todos os documentos do condomínio (o router já valida
// o papel; aqui repetimos a verificação como defesa em profundidade).
const PAPEIS_GESTAO = new Set(['admin', 'gestor']);

const MOTIVO = {
  SEM_SESSAO: 'sem_sessao',
  SEM_CONDOMINIO: 'sem_condominio',
  NAO_ENCONTRADO: 'nao_encontrado',
  // Existe mas pertence a outro condomínio (isolamento multi-tenant).
  OUTRO_CONDOMINIO: 'outro_condominio',
  SEM_PERMISSAO: 'sem_permissao',
  SEM_FICHEIRO: 'sem_ficheiro',
  PROVEDOR_INDISPONIVEL: 'provedor_indisponivel',
  LIGACAO_INVALIDA: 'ligacao_invalida',
};

const MENSAGENS = {
  [MOTIVO.SEM_SESSAO]: 'Inicie sessão para aceder aos documentos.',
  [MOTIVO.SEM_CONDOMINIO]: 'Selecione um condomínio para aceder aos documentos.',
  // A mesma mensagem para "não existe" e "é de outro condomínio": não se
  // revela o conteúdo nem a que condomínio pertence.
  [MOTIVO.NAO_ENCONTRADO]: 'Documento não encontrado.',
  [MOTIVO.OUTRO_CONDOMINIO]: 'Documento não encontrado.',
  [MOTIVO.SEM_PERMISSAO]: 'Não tem permissões para aceder a este documento.',
  [MOTIVO.SEM_FICHEIRO]: 'Este documento não tem ficheiro associado (apenas referência externa).',
  [MOTIVO.PROVEDOR_INDISPONIVEL]: 'O armazenamento do condomínio não está ligado. Contacte o administrador.',
  [MOTIVO.LIGACAO_INVALIDA]: 'Não foi possível obter o documento no serviço de armazenamento.',
};

function recusar(motivo) {
  return { ok: false, motivo, mensagem: MENSAGENS[motivo] || 'Acesso negado.' };
}

// Código HTTP de cada recusa. A autorização é sempre Utilizador → Condomínio →
// Documento; um documento que não pertence ao condomínio ativo (ou sem
// permissão) resulta em 403 Forbidden, nunca na entrega do ficheiro.
const HTTP = {
  [MOTIVO.SEM_SESSAO]: 401,
  [MOTIVO.SEM_CONDOMINIO]: 401,
  [MOTIVO.NAO_ENCONTRADO]: 404,
  [MOTIVO.SEM_PERMISSAO]: 403,
  [MOTIVO.SEM_FICHEIRO]: 404,
  [MOTIVO.PROVEDOR_INDISPONIVEL]: 503,
  [MOTIVO.LIGACAO_INVALIDA]: 502,
  // Um documento que existe mas é de OUTRO condomínio: 403 (pedido do
  // projeto). Para não facilitar a enumeração de ids, a mensagem é a mesma de
  // um documento inexistente.
  [MOTIVO.OUTRO_CONDOMINIO]: 403,
};

// Utilizador autenticado (req.user) — nunca confiar apenas no pedido.
function utilizadorDe(req) {
  if (!req || !req.user) return null;
  if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) return null;
  return req.user;
}

// Condomínio ativo: vem SEMPRE da sessão validada (helpers/tenant.js).
function condominioDe(req) {
  const cid = req && req.condominioId ? Number(req.condominioId) : null;
  return Number.isFinite(cid) && cid > 0 ? cid : null;
}

// Pode ver todos os documentos do condomínio? (admin/gestor)
function podeVerTudo(req) {
  const papel = req && req.papelCondominio ? String(req.papelCondominio) : '';
  return PAPEIS_GESTAO.has(papel);
}

// Permissão sobre o documento concreto.
function temPermissao(req, documento) {
  if (podeVerTudo(req)) return true;
  // Área do condómino: só documentos explicitamente disponibilizados.
  return Boolean(documento.disponivel_condominos);
}

// ── Autorização ─────────────────────────────────────────────────────
// `area`: 'gestao' (admin/gestor) ou 'condomino' (só disponibilizados).
// Devolve { ok:true, documento } ou { ok:false, motivo, mensagem }.
async function autorizarAcessoDocumento({ documentoId, req, area = 'gestao' }) {
  const utilizador = utilizadorDe(req);
  if (!utilizador) return recusar(MOTIVO.SEM_SESSAO);

  const condominioId = condominioDe(req);
  if (!condominioId) return recusar(MOTIVO.SEM_CONDOMINIO);

  const id = Number(documentoId);
  if (!Number.isFinite(id) || id <= 0) return recusar(MOTIVO.NAO_ENCONTRADO);

  // A consulta já exige o condomínio ativo: um id de outro condomínio não
  // devolve registo nenhum (não há caminho Utilizador → Documento).
  const documento = await Documento.findOne({ where: { id, condominio_id: condominioId } });
  if (!documento) {
    // Distingue "não existe" de "existe noutro condomínio" apenas para
    // responder 403 no segundo caso (exigência do projeto). A mensagem
    // apresentada é igual, para não revelar o condomínio alheio.
    const alheio = await Documento.findOne({ where: { id }, attributes: ['id'] }).catch(() => null);
    return recusar(alheio ? MOTIVO.OUTRO_CONDOMINIO : MOTIVO.NAO_ENCONTRADO);
  }

  if (area === 'condomino') {
    if (!documento.disponivel_condominos) return recusar(MOTIVO.SEM_PERMISSAO);
  } else if (!temPermissao(req, documento)) {
    return recusar(MOTIVO.SEM_PERMISSAO);
  }

  return { ok: true, documento, utilizador, condominioId };
}

// ── Serviço do ficheiro ─────────────────────────────────────────────
function nomeSeguro(nome) {
  return String(nome || 'documento')
    .replace(/[\r\n"\\/]+/g, '_')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 120) || 'documento';
}

// Envia o documento para a resposta HTTP, em streaming, a partir do provedor.
// `disposicao`: 'inline' (ver no browser) ou 'attachment' (descarregar).
async function servirDocumento({ documento, res, req, disposicao = 'inline', via = 'sessao' }) {
  if (!documento || !documento.drive_file_id) {
    return { ok: false, motivo: MOTIVO.SEM_FICHEIRO, mensagem: MENSAGENS[MOTIVO.SEM_FICHEIRO] };
  }
  const condominioId = Number(documento.condominio_id);
  let abertura;
  try {
    abertura = await storage.abrirFluxo(documento.drive_file_id, condominioId);
  } catch (err) {
    console.error('[documentos-acesso] falha ao abrir o documento:', err.message);
    // Distingue "ligação em baixo" de "erro do fornecedor" para dar uma
    // mensagem útil sem revelar detalhes internos.
    let ligado = false;
    try {
      ligado = await storage.isConfiguredPara(condominioId);
    } catch (e) {
      ligado = false;
    }
    return {
      ok: false,
      motivo: ligado ? MOTIVO.LIGACAO_INVALIDA : MOTIVO.PROVEDOR_INDISPONIVEL,
      mensagem: ligado ? MENSAGENS[MOTIVO.LIGACAO_INVALIDA] : MENSAGENS[MOTIVO.PROVEDOR_INDISPONIVEL],
    };
  }

  const tamanho = abertura.tamanho || (documento.tamanho ? Number(documento.tamanho) : null);
  res.setHeader('Content-Type', documento.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposicao === 'attachment' ? 'attachment' : 'inline'}; filename="${nomeSeguro(documento.nome)}"`);
  if (tamanho && Number.isFinite(tamanho)) res.setHeader('Content-Length', String(tamanho));
  // Documento privado: nunca guardar em caches partilhadas, nunca deixar o
  // browser adivinhar o tipo nem executar conteúdo dentro do documento.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; object-src 'none'");

  audit({
    userId: req && req.user ? req.user.id : null,
    acao: 'abrir_documento',
    entidade: 'Documento',
    entidadeId: documento.id,
    detalhes: { via, condominio_id: condominioId, disposicao },
  }).catch(() => {});

  const fluxo = abertura.fluxo;
  return new Promise((resolve) => {
    let terminado = false;
    const fechar = (r) => {
      if (terminado) return;
      terminado = true;
      if (fluxo && typeof fluxo.destroy === 'function') fluxo.destroy();
      resolve(r);
    };
    fluxo.on('error', (err) => {
      console.error('[documentos-acesso] erro no fluxo do documento:', err.message);
      if (!res.headersSent) res.status(502);
      res.end();
      fechar({ ok: false, motivo: MOTIVO.LIGACAO_INVALIDA, mensagem: MENSAGENS[MOTIVO.LIGACAO_INVALIDA] });
    });
    res.on('close', () => fechar({ ok: true, interrompido: true }));
    res.on('finish', () => fechar({ ok: true }));
    fluxo.pipe(res);
  });
}

// ── URLs internas (o único caminho de acesso) ───────────────────────
// Só existe rota interna quando o documento tem ficheiro guardado: um
// documento sem ficheiro (apenas referência externa) não tem nada para servir.
function urlInterna(documento, { area = 'gestao', disposicao = null } = {}) {
  if (!documento || !documento.id || !documento.drive_file_id) return null;
  const base = area === 'condomino' ? '/condomino/documentos' : '/admin/documentos';
  const sufixo = disposicao === 'attachment' ? '?descarregar=1' : '';
  return `${base}/${documento.id}/ficheiro${sufixo}`;
}

// ── Links temporários (destinatários externos de email) ─────────────
// Segredo: DOC_LINK_SECRET ou SESSION_SECRET. Sem segredo configurado, os
// links temporários ficam DESATIVADOS (fail-safe): devolve null e quem chama
// usa a rota autenticada.
const TTL_PADRAO_SEGUNDOS = Number(process.env.DOC_LINK_TTL_HOURS || 168) * 3600; // 7 dias

function segredo() {
  return String(process.env.DOC_LINK_SECRET || process.env.SESSION_SECRET || '').trim();
}

function linksTemporariosAtivos() {
  return Boolean(segredo()) && process.env.DOC_LINK_TEMPORARIO !== '0';
}

function assinar(payload) {
  return crypto.createHmac('sha256', segredo()).update(payload).digest('base64url');
}

// Emite um link temporário para UM documento de UM condomínio. Só deve ser
// chamado depois de autorizar quem o pede (rotas autenticadas).
function criarLinkTemporario({ documentoId, condominioId, validadeSegundos = TTL_PADRAO_SEGUNDOS, baseUrl = '' }) {
  if (!linksTemporariosAtivos()) return null;
  const id = Number(documentoId);
  const cid = Number(condominioId);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(cid) || cid <= 0) return null;
  const expira = Math.floor(Date.now() / 1000) + Math.max(60, Number(validadeSegundos) || TTL_PADRAO_SEGUNDOS);
  const payload = `${id}.${cid}.${expira}`;
  const token = `${payload}.${assinar(payload)}`;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return { url: `${base}/documentos/ficheiro/${token}`, expira, token };
}

// Verifica o token: assinatura (comparação em tempo constante) + validade.
function verificarLinkTemporario(token) {
  if (!linksTemporariosAtivos()) return { ok: false, motivo: 'desativado' };
  const partes = String(token || '').split('.');
  if (partes.length !== 4) return { ok: false, motivo: 'invalido' };
  const [idTxt, cidTxt, expTxt, assinatura] = partes;
  const payload = `${idTxt}.${cidTxt}.${expTxt}`;
  const esperada = assinar(payload);
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, motivo: 'invalido' };
  const expira = Number(expTxt);
  if (!Number.isFinite(expira) || expira * 1000 < Date.now()) return { ok: false, motivo: 'expirado' };
  const documentoId = Number(idTxt);
  const condominioId = Number(cidTxt);
  if (!documentoId || !condominioId) return { ok: false, motivo: 'invalido' };
  return { ok: true, documentoId, condominioId, expira };
}

// Documento de um link temporário: confirma que o documento ainda existe E
// que pertence ao condomínio que o token autoriza (defesa em profundidade).
async function documentoDeLinkTemporario(token) {
  const verificado = verificarLinkTemporario(token);
  if (!verificado.ok) return verificado;
  const documento = await Documento.findOne({
    where: { id: verificado.documentoId, condominio_id: verificado.condominioId },
  });
  if (!documento) return { ok: false, motivo: MOTIVO.NAO_ENCONTRADO };
  if (!documento.drive_file_id) return { ok: false, motivo: MOTIVO.SEM_FICHEIRO };
  return { ok: true, documento, condominioId: verificado.condominioId, expira: verificado.expira };
}

// URL absoluta da rota interna (para emails).
function urlInternaAbsoluta(documento, { baseUrl = '', area = 'gestao' } = {}) {
  const rel = urlInterna(documento, { area });
  if (!rel) return null;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base ? `${base}${rel}` : rel;
}

// Link para incluir em emails.
//  · destinatário com conta no GesCondu → rota autenticada (exige sessão);
//  · destinatário externo (fornecedor, email manual) → link temporário
//    assinado, com validade limitada, emitido SÓ porque um administrador
//    autenticado pediu o envio; se os links temporários estiverem desativados
//    devolve null (o documento segue em anexo, quando aplicável);
//  · documento sem ficheiro guardado → mantém a referência externa que o
//    administrador indicou (não é um documento do armazenamento do GesCondu).
function urlParaEmail({ documento, baseUrl = '', destinatarioInterno = false }) {
  if (!documento || !documento.id) return null;
  if (!documento.drive_file_id) return documento.url || null;
  if (destinatarioInterno) return urlInternaAbsoluta(documento, { baseUrl, area: 'condomino' });
  const link = criarLinkTemporario({
    documentoId: documento.id,
    condominioId: documento.condominio_id,
    baseUrl,
  });
  return link ? link.url : null;
}

// ── Resposta HTTP de recusa ─────────────────────────────────────────
// Usada pelas rotas que servem ficheiros: devolve o código correto
// (401 sem sessão, 403 sem permissão ou de outro condomínio, 404 inexistente)
// e nunca o conteúdo do documento.
function responderRecusa(res, resultado) {
  const status = HTTP[resultado && resultado.motivo] || 403;
  if (res.headersSent) {
    res.end();
    return status;
  }
  res.status(status);
  res.type('text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(resultado && resultado.mensagem ? resultado.mensagem : 'Acesso negado.');
  return status;
}

module.exports = {
  MOTIVO,
  MENSAGENS,
  HTTP,
  PAPEIS_GESTAO,
  TTL_PADRAO_SEGUNDOS,
  autorizarAcessoDocumento,
  servirDocumento,
  responderRecusa,
  urlInterna,
  urlInternaAbsoluta,
  urlParaEmail,
  nomeSeguro,
  criarLinkTemporario,
  verificarLinkTemporario,
  documentoDeLinkTemporario,
  linksTemporariosAtivos,
  utilizadorDe,
  condominioDe,
};
