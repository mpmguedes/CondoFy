// ═══════════════════════════════════════════════════════════════════
// P54-1 — Validação da configuração SMTP (pura, sem BD e sem efeitos).
//
// Porque é que isto existe. Até aqui `guardarConfigSmtp` **não validava nada**:
// fazia `trim()` e coerção de tipos. Consequências medidas (spec P54, §2):
//
//   L1 — `port='abc'` era gravado tal e qual e só dava `NaN` mais tarde, no
//        `construirTransporte`; `host` aceitava `""`, `"a b c"`, `"https://x/y"`.
//   L2 — `fromName` só perdia as aspas: um `\r\n` ia **direto para o cabeçalho
//        `From:`** por interpolação de template (injeção de cabeçalho).
//   L3 — `tls` fora de `on/true/true` era gravado como `'false'` **em silêncio**,
//        desligando o TLS sem aviso — a mesma classe de defeito do P50.
//
// Este módulo é **puro e determinístico**: não lê BD, não escreve, não consulta
// o ambiente. Recebe os valores, devolve `{ ok, valores, erros, avisos }`.
//
// ── Regras de desenho ────────────────────────────────────────────────
//
// 1. **Nunca devolve nem ecoa a password.** Os erros e os avisos são
//    `{ campo, codigo, mensagem }` — o `codigo` identifica a regra e a
//    `mensagem` é uma frase FIXA, sem qualquer valor interpolado. Um valor
//    nunca entra numa mensagem, logo uma password nunca pode escapar por aí.
//    O campo `pass` é validado mas **não** sai em `valores` (ver `passDefinida`).
//
// 2. **«Ausente» ≠ «inválido».** Um campo ausente significa «não mexer» (é o
//    que `guardarConfigSmtp` sempre fez e o que a interface espera de um
//    formulário parcial). Só os valores PRESENTES são validados. Isto é o que
//    torna a mudança retrocompatível: nenhum valor hoje aceite e
//    semanticamente válido passa a ser recusado.
//
// 3. **Sem conversões silenciosas.** `tls` fora do conjunto fechado é ERRO —
//    não vira `'false'`. É a regra V6 e o fecho do L3.
//
// 4. **Erro bloqueia; aviso não.** Só `erros` impede a gravação. `avisos`
//    assinala coerências duvidosas (V8: TLS numa porta não habitual) que não
//    devem impedir um operador de guardar o que quer que seja.
// ═══════════════════════════════════════════════════════════════════
'use strict';

// ── Reutilização do validador de email do projeto ────────────────────
// `helpers/contactos.js` tem exatamente esta expressão (`EMAIL_RE`, l.93), mas
// NÃO a exporta — só `validarContactos`, que valida uma lista de contactos e
// arrasta `../models` no `require`. Importá-lo tornaria este módulo impuro e
// dependente da BD, contra o requisito de ser um validador puro e testável.
// Mantém-se por isso a MESMA expressão, para que os dois sítios concordem sobre
// o que é um email válido; se um dia divergirem, é aqui que se vê.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hostname RFC 1123: rótulos alfanuméricos com hífenes interiores.
const ROTULO = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOST_RE = new RegExp(`^${ROTULO}(?:\\.${ROTULO})*$`);
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const MAX = { host: 253, user: 255, from: 254, fromName: 120 };
const PORTA = { MIN: 1, MAX: 65535, PADRAO: '587' };
// Portas em que o TLS é habitual. Fora destas, V8 avisa (não bloqueia): há
// servidores internos legítimos noutras portas, e o P50 mostrou o custo de
// decidir pelo operador.
const PORTAS_TLS_HABITUAIS = [465, 587, 25, 2525];
const PASS_MIN = 4;

// V6 — conjunto FECHADO. A chave é o valor tal como chega (do `body` ou de um
// chamador programático); o valor é o que fica gravado.
const TLS_ACEITES = new Map([
  [true, 'true'],
  ['true', 'true'],
  ['on', 'true'],
  [false, 'false'],
  ['false', 'false'],
  ['off', 'false'],
]);

// Mensagens FIXAS por código — deliberadamente sem valores interpolados.
const MENSAGENS = {
  host_obrigatorio: 'O servidor (host) é obrigatório quando há remetente ou utilizador.',
  host_invalido: 'O servidor (host) não tem um formato válido.',
  host_com_quebra_de_linha: 'O servidor (host) contém quebras de linha ou separadores.',
  host_muito_longo: `O servidor (host) excede ${MAX.host} caracteres.`,
  porta_invalida: `A porta tem de ser um número inteiro entre ${PORTA.MIN} e ${PORTA.MAX}.`,
  user_com_quebra_de_linha: 'O utilizador contém quebras de linha.',
  user_muito_longo: `O utilizador excede ${MAX.user} caracteres.`,
  from_obrigatorio: 'O remetente (from) é obrigatório.',
  from_invalido: 'O remetente (from) não é um email válido.',
  from_com_controle: 'O remetente (from) contém caracteres de controlo.',
  from_muito_longo: `O remetente (from) excede ${MAX.from} caracteres.`,
  from_name_muito_longo: `O nome do remetente excede ${MAX.fromName} caracteres.`,
  tls_invalido: 'A opção de segurança (TLS) tem de ser «true», «false», «on» ou «off».',
  password_curta: `A password tem de ter pelo menos ${PASS_MIN} caracteres.`,
  password_com_quebra_de_linha: 'A password contém quebras de linha.',
  tls_porta_incoerente: 'O TLS está ligado numa porta que não é habitualmente usada para TLS.',
  from_name_saneado: 'O nome do remetente tinha quebras de linha, que foram removidas.',
};

// Códigos que podem aparecer em `avisos` (não bloqueiam).
const CODIGOS_DE_AVISO = ['tls_porta_incoerente', 'from_name_saneado'];

// Erro de validação. Leva apenas CÓDIGOS e NOMES de campo — nunca valores.
class ErroValidacaoSmtp extends Error {
  constructor(erros) {
    const campos = [...new Set((erros || []).map((e) => e.campo))].join(', ');
    super(`Configuração SMTP inválida (${campos || 'sem campos'})`);
    this.name = 'ErroValidacaoSmtp';
    this.codigo = 'smtp_invalido';
    this.erros = erros || [];
    // Marca estável para o chamador distinguir de uma falha de BD sem inspecionar
    // a mensagem (que é genérica de propósito).
    this.validacao = true;
  }
}

// ── Auxiliares puros ─────────────────────────────────────────────────
const presente = (v) => v !== undefined && v !== null;
const texto = (v) => (presente(v) ? String(v) : '');
const temQuebraDeLinha = (s) => /[\r\n]/.test(s);
const temControle = (s) => /[\x00-\x1f\x7f]/.test(s);

// Host ou IPv4 (V1). Um IPv4 também satisfaz o formato de hostname (só dígitos
// e pontos), pelo que os octetos são verificados à parte — `999.999.999.999`
// não é um endereço válido e não deve passar só por ter a forma certa.
function hostValido(host) {
  if (!HOST_RE.test(host)) return false;
  if (IPV4_RE.test(host)) return host.split('.').every((o) => Number(o) <= 255);
  return true;
}

// Porta (V2): inteiro 1–65535. Aceita número e string numérica (a interface
// envia string). Recusa `NaN`, decimais, notação científica, negativos e vazios.
function normalizarPorta(valor) {
  const bruto = texto(valor).trim();
  if (bruto === '') return { ok: true, valor: PORTA.PADRAO };
  if (!/^\d+$/.test(bruto)) return { ok: false };
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < PORTA.MIN || n > PORTA.MAX) return { ok: false };
  return { ok: true, valor: String(n) };
}

// ── Validador ────────────────────────────────────────────────────────
// `dados`  — valores submetidos (só os presentes são validados).
// `contexto` — opcional: `{ atual }` com os valores EFETIVAMENTE guardados,
//   para as regras que dependem do estado final (V1: o host é obrigatório
//   quando o remetente/utilizador efetivos existem). Sem ele, a regra avalia
//   apenas o que vem em `dados`.
function validarConfigSmtp(dados = {}, contexto = {}) {
  const d = dados || {};
  const atual = (contexto && contexto.atual) || {};
  const erros = [];
  const avisos = [];
  const valores = {};
  const erro = (campo, codigo) => erros.push({ campo, codigo, mensagem: MENSAGENS[codigo] });
  const aviso = (campo, codigo) => avisos.push({ campo, codigo, mensagem: MENSAGENS[codigo] });

  // ── V1 — host ───────────────────────────────────────────────────
  if (presente(d.host)) {
    const host = texto(d.host).trim();
    valores.host = host;
    if (host !== '') {
      if (temQuebraDeLinha(host) || /\t/.test(host)) erro('host', 'host_com_quebra_de_linha');
      else if (/\s/.test(host)) erro('host', 'host_invalido');
      else if (host.length > MAX.host) erro('host', 'host_muito_longo');
      else if (!hostValido(host)) erro('host', 'host_invalido');
    }
  }

  // ── V2 — porta ──────────────────────────────────────────────────
  if (presente(d.port)) {
    const p = normalizarPorta(d.port);
    if (!p.ok) erro('port', 'porta_invalida');
    else valores.port = p.valor;
  }

  // ── V3 — utilizador ─────────────────────────────────────────────
  if (presente(d.user)) {
    const user = texto(d.user).trim();
    valores.user = user;
    if (temQuebraDeLinha(user)) erro('user', 'user_com_quebra_de_linha');
    else if (user.length > MAX.user) erro('user', 'user_muito_longo');
  }

  // ── V4 — remetente ──────────────────────────────────────────────
  if (presente(d.from)) {
    const from = texto(d.from).trim();
    valores.from = from;
    if (from === '') erro('from', 'from_obrigatorio');
    else if (temControle(from)) erro('from', 'from_com_controle');
    else if (from.length > MAX.from) erro('from', 'from_muito_longo');
    else if (!EMAIL_RE.test(from)) erro('from', 'from_invalido');
  }

  // ── V5 — nome do remetente ──────────────────────────────────────
  // Aqui o valor é SANEADO, não recusado: um `\r\n` vindo de um copiar-colar
  // não deve impedir a gravação, mas também não pode chegar ao cabeçalho. O
  // saneamento é assinalado num aviso — corrigir em silêncio seria a mesma
  // classe de defeito que esta frente fecha.
  //
  // Remove-se o `\r`/`\n` (leitura LITERAL de V5), não se substitui por espaço:
  // a regra é «remover TODOS os `\r` e `\n`». O espaço a mais que sobra de um
  // corte no meio é colapsado a seguir, para o nome não ficar com duplos.
  if (presente(d.fromName)) {
    const bruto = texto(d.fromName);
    const limpo = bruto.replace(/[\r\n]+/g, '').replace(/\s+/g, ' ').trim();
    valores.fromName = limpo;
    if (limpo !== bruto.trim()) aviso('fromName', 'from_name_saneado');
    if (limpo.length > MAX.fromName) erro('fromName', 'from_name_muito_longo');
  }

  // ── V6 — TLS (conjunto FECHADO, sem conversão silenciosa) ───────
  if (presente(d.tls)) {
    if (TLS_ACEITES.has(d.tls)) valores.tls = TLS_ACEITES.get(d.tls);
    else erro('tls', 'tls_invalido');
  }

  // ── V7 — password ───────────────────────────────────────────────
  // Validada sem sair deste módulo: `valores` NÃO leva a password. O chamador
  // guarda-a a partir do valor original, e `passDefinida` diz-lhe se deve.
  let passDefinida = false;
  if (presente(d.pass) && texto(d.pass).trim() !== '') {
    const pass = texto(d.pass);
    if (temQuebraDeLinha(pass)) erro('pass', 'password_com_quebra_de_linha');
    else if (pass.length < PASS_MIN) erro('pass', 'password_curta');
    else passDefinida = true;
  }

  // ── V1 (parte 2) — host obrigatório se houver remetente/utilizador ─
  // Avaliado sobre o estado EFETIVO (guardado + submetido): um formulário que
  // só altere o `from` de uma configuração que já tem host não pode ser
  // recusado por «falta de host».
  const hostEfetivo = presente(d.host) ? valores.host : texto(atual.host).trim();
  const fromEfetivo = presente(d.from) ? valores.from : texto(atual.from).trim();
  const userEfetivo = presente(d.user) ? valores.user : texto(atual.user).trim();
  if (!hostEfetivo && (fromEfetivo || userEfetivo)) erro('host', 'host_obrigatorio');

  // ── V8 — coerência TLS/porta (AVISO, nunca bloqueio) ────────────
  const tlsEfetivo = presente(d.tls) ? valores.tls : texto(atual.tls).trim();
  const portaEfetiva = presente(d.port) ? valores.port : texto(atual.port).trim();
  if (tlsEfetivo === 'true' && portaEfetiva && !PORTAS_TLS_HABITUAIS.includes(Number(portaEfetiva))) {
    aviso('port', 'tls_porta_incoerente');
  }

  return { ok: erros.length === 0, valores, erros, avisos, passDefinida };
}

module.exports = {
  validarConfigSmtp,
  ErroValidacaoSmtp,
  // Expostos para os testes e para quem precise das MESMAS fronteiras.
  MAX,
  PORTA,
  PASS_MIN,
  PORTAS_TLS_HABITUAIS,
  TLS_ACEITES,
  CODIGOS_DE_AVISO,
  MENSAGENS,
  EMAIL_RE,
  hostValido,
  normalizarPorta,
};
