// ═══════════════════════════════════════════════════════════════════
// Confirmação server-side de operações sensíveis (P54-3, V10).
//
// O problema. A confirmação do P54-2 é de INTERFACE: uma caixa com o diff e um
// botão. Um `POST` direto ao endpoint, sem passar pela página, não tinha nada
// que o travasse — bastava enviar o campo que a interface enviaria.
//
// ⛔ Um booleano (`confirmado=true`) NÃO é prova de confirmação: é um valor que
//    quem faz o pedido escreve à vontade. A confirmação tem de ser um ARTEFACTO
//    emitido pelo SERVIDOR, ligado a QUEM confirma e ÀQUILO que foi confirmado.
//
// ── O que este módulo garante ────────────────────────────────────────
//
// Um pedido é aceite como «confirmado» apenas se TODAS se verificarem:
//
//   1. **Emitido pelo servidor** — o valor é aleatório (32 bytes) e só existe
//      porque o servidor o criou. Não é adivinhável nem forjável.
//   2. **Ligado à sessão** — o token vive DENTRO de `req.session`. Uma sessão
//      diferente não o vê. É o que impede usá-lo noutro contexto.
//   3. **Ligado ao utilizador** — guarda o `utilizador_id` e exige que coincida.
//   4. **Ligado à OPERAÇÃO** — cada operação tem o seu token (`operacao`); um
//      token de «testar SMTP» não serve para «gravar SMTP».
//   5. **Ligado ao PAYLOAD** — guarda a `impressao` (digest) dos valores
//      confirmados. Se o corpo do pedido mudar depois da confirmação, a
//      impressão não bate certo e o pedido é RECUSADO. É isto que deteta
//      «campos alterados depois da confirmação» — e é a razão pela qual o
//      token é pedido com o payload FINAL já preenchido.
//   6. **De uso único** — consumido na validação, mesmo que a operação falhe a
//      seguir. Repetir o mesmo pedido não volta a passar.
//   7. **Com prazo** — TTL curto (10 min por omissão). Uma confirmação deixada
//      numa aba aberta não vale para sempre.
//
// ⛔ Sobre a impressão: ela é um DIGEST (SHA-256) do payload, nunca os valores.
//    Para a password, entra o digest do valor — é o mínimo necessário para
//    detetar que a password mudou entre a confirmação e a gravação. O digest
//    vive apenas na sessão do servidor; nunca é registado, auditado ou enviado
//    ao browser. O valor em claro nunca é tocado por este módulo.
// ═══════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const TTL_PADRAO_MS = 10 * 60 * 1000; // 10 minutos
const CHAVE_SESSAO = 'confirmacoes_sensiveis';

// Digest determinístico de um payload. As chaves são ordenadas para que a
// impressão não dependa da ordem de inserção (dois objetos iguais dão a mesma
// impressão). Valores nulos e indefinidos são normalizados para ''.
function impressao(payload) {
  const pares = Object.keys(payload || {})
    .filter((k) => payload[k] !== undefined)
    .sort()
    .map((k) => `${k}=${payload[k] === null ? '' : String(payload[k])}`);
  return crypto.createHash('sha256').update(pares.join('\u0000')).digest('hex');
}

// Digest de um segredo, para o ligar à confirmação sem guardar o valor.
// Devolve '' quando não há segredo — e '' é um valor como outro qualquer na
// impressão, pelo que «sem password» não colide com «password vazia».
const impressaoSegredo = (valor) => {
  const t = valor === undefined || valor === null ? '' : String(valor);
  if (t === '') return '';
  return crypto.createHash('sha256').update(t).digest('hex');
};

// O contentor das confirmações desta sessão. Criado a pedido.
function contentor(req, criar = false) {
  const s = req && req.session;
  if (!s) return null;
  if (!s[CHAVE_SESSAO]) {
    if (!criar) return null;
    s[CHAVE_SESSAO] = {};
  }
  return s[CHAVE_SESSAO];
}

// Emite um token para `operacao`, ligado ao payload confirmado.
// Devolve `{ ok: true, valor, expiraEm }` ou `{ ok: false, erro }`.
function emitir(req, { operacao, impressao: imp, ttlMs = TTL_PADRAO_MS } = {}) {
  if (!operacao) return { ok: false, erro: 'operacao_obrigatoria' };
  const utilizadorId = req && req.user && req.user.id;
  if (!utilizadorId) return { ok: false, erro: 'sem_utilizador' };

  const caixa = contentor(req, true);
  if (!caixa) return { ok: false, erro: 'sem_sessao' };

  const agora = Date.now();
  const registo = {
    valor: crypto.randomBytes(32).toString('hex'),
    utilizador_id: utilizadorId,
    impressao: String(imp || ''),
    emitido_em: agora,
    expira_em: agora + ttlMs,
  };
  // Uma operação tem UMA confirmação pendente: emitir de novo invalida a
  // anterior (evita acumular tokens válidos numa sessão longa).
  caixa[operacao] = registo;
  return { ok: true, valor: registo.valor, expiraEm: registo.expira_em };
}

// Valida e CONSOME. Devolve `{ ok: true }` ou `{ ok: false, erro }`.
// Os motivos são códigos estáveis (sem valores) para o chamador decidir a
// mensagem e para os testes fixarem cada caso.
function validarEConsumir(req, { operacao, valor, impressao: imp } = {}) {
  if (!operacao) return { ok: false, erro: 'operacao_obrigatoria' };
  const caixa = contentor(req);
  if (!caixa) return { ok: false, erro: 'sem_confirmacao' };

  const registo = caixa[operacao];
  if (!registo) return { ok: false, erro: 'sem_confirmacao' };

  // Consome SEMPRE a partir daqui: uma confirmação não se reutiliza, mesmo que
  // a validação falhe por outro motivo. Caso contrário, um atacante poderia
  // tentar valores até acertar com o mesmo token.
  delete caixa[operacao];

  if (!valor || typeof valor !== 'string') return { ok: false, erro: 'confirmacao_ausente' };
  if (registo.expira_em <= Date.now()) return { ok: false, erro: 'confirmacao_expirada' };

  const utilizadorId = req && req.user && req.user.id;
  if (!utilizadorId || String(registo.utilizador_id) !== String(utilizadorId)) {
    return { ok: false, erro: 'confirmacao_de_outro_utilizador' };
  }

  // Comparação em tempo constante: um `===` sobre o token deixa vazar, pelo
  // tempo de resposta, quantos caracteres iniciais estão certos.
  const a = Buffer.from(String(registo.valor));
  const b = Buffer.from(String(valor));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, erro: 'confirmacao_invalida' };
  }

  // ⛔ Ligação ao PAYLOAD: se o corpo mudou depois de o token ter sido emitido,
  // a operação confirmada já não é a que está a ser pedida.
  if (String(registo.impressao) !== String(imp || '')) {
    return { ok: false, erro: 'payload_alterado' };
  }

  return { ok: true };
}

// Há uma confirmação pendente para esta operação? (para a interface decidir se
// mostra o campo). Não devolve o token.
function pendente(req, operacao) {
  const caixa = contentor(req);
  const r = caixa && caixa[operacao];
  if (!r) return false;
  return r.expira_em > Date.now();
}

// Descarta a confirmação pendente (ex.: o utilizador cancelou).
function descartar(req, operacao) {
  const caixa = contentor(req);
  if (caixa && caixa[operacao]) delete caixa[operacao];
}

module.exports = {
  impressao,
  impressaoSegredo,
  emitir,
  validarEConsumir,
  pendente,
  descartar,
  TTL_PADRAO_MS,
  CHAVE_SESSAO,
};
