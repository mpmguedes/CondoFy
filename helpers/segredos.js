// ─────────────────────────────────────────────────────────────────────
// Segredos em repouso que vivem em COLUNAS (fora do ciclo das credenciais
// de armazenamento).
//
// A tabela `configuracoes` guarda as credenciais OAuth cifradas através de
// helpers/armazenamento/cifra.js. Este módulo aplica a MESMA proteção a dois
// segredos que não passam por lá:
//
//   · `users.two_fa_totp_secret`  — segredo TOTP (2FA por aplicação);
//   · `configuracoes.smtp_pass`   — password SMTP (mesma tabela, mas fora do
//                                   ciclo das credenciais de armazenamento).
//
// Não existe uma segunda implementação criptográfica: tudo delega em
// helpers/armazenamento/cifra.js (AES-256-GCM, chave da instalação em
// ENCRYPTION_KEY, formato `enc:v1:<kid>:<iv>:<tag>:<ct>`).
//
// ── Porque a degradação é diferente da do armazenamento ─────────────
// O armazenamento RECUSA operar sem ENCRYPTION_KEY: sem chave as credenciais
// ficam «não ligadas» e a interface di-lo, sem consequências para o resto da
// aplicação. Aqui a falha é de outra natureza:
//
//   · sem chave, recusar a password SMTP deixaria a instalação SEM EMAIL
//     (convites, reposições de password, avisos) — uma regressão funcional;
//   · sem chave, recusar o segredo TOTP deixaria utilizadores SEM 2FA.
//
// Por isso a regra aqui é:
//
//   · COM chave  → o valor é guardado cifrado e lido decifrado;
//   · SEM chave  → o valor é guardado e lido em texto simples (exatamente o
//                  comportamento anterior, sem regressão) e é emitido UM
//                  aviso administrativo, uma única vez;
//   · valor antigo em texto simples (instalação anterior a esta alteração)
//                  → continua a ser usado tal e qual; a substituição pela
//                  versão cifrada acontece na escrita seguinte (migração
//                  transparente, como em helpers/armazenamento/ligacoes.js).
//
// Nunca são registados em log a chave, os valores ou os ciphertexts.
// ─────────────────────────────────────────────────────────────────────
const cifra = require('./armazenamento/cifra');

// Contexto (AAD) de cada segredo. Fica autenticado na cifragem: um valor
// copiado de uma coluna para outra deixa de decifrar. É um valor FIXO por
// campo (e não o id da linha) de propósito: a cifragem tem de funcionar em
// `create`, quando o id ainda não existe.
const CONTEXTOS = {
  totp: 'users:two_fa_totp_secret',
  smtpPass: 'configuracoes:smtp_pass',
};

const CONTEXTO_VALIDO = new Set(Object.values(CONTEXTOS));

let avisoEmitido = false;

function cifraDisponivel() {
  try {
    return cifra.estado().configurada;
  } catch (err) {
    return false;
  }
}

// Aviso único (não repetido a cada leitura): sem chave nada é cifrado.
function avisarSemChave(contexto) {
  if (avisoEmitido) return;
  avisoEmitido = true;
  console.warn(
    `[segredos] ENCRYPTION_KEY não configurada: «${contexto}» continua a ser guardado em texto simples. ` +
      'Configure a chave em Configurações → Armazenamento e Backups para o cifrar em repouso.'
  );
}

// Repõe o aviso (usado pelos testes; não tem efeito em produção).
function reiniciarAviso() {
  avisoEmitido = false;
}

// ── Cifrar (para guardar) ───────────────────────────────────────────
// `null`/`''` passam intactos: não há segredo para proteger e alterar o valor
// mudaria a semântica de "sem segredo" (ex.: desativar o 2FA escreve null).
function proteger(valor, contexto) {
  if (!CONTEXTO_VALIDO.has(contexto)) throw new Error(`Contexto de segredo desconhecido: ${contexto}`);
  if (valor === null || valor === undefined) return valor;
  const texto = String(valor);
  if (texto === '') return texto;
  if (!cifraDisponivel()) {
    avisarSemChave(contexto);
    return texto;
  }
  return cifra.cifrar(texto, { contexto });
}

// ── Ler (de um valor guardado) ──────────────────────────────────────
// Devolve sempre um objeto — NUNCA lança:
//   { valor, cifrado, precisaMigrar, erro }
//     valor         texto em claro (ou o próprio valor, se ainda for simples)
//     cifrado       true quando o valor guardado estava no formato cifrado
//     precisaMigrar true quando está em texto simples e já HÁ chave (o
//                   chamador pode substituí-lo pela versão cifrada)
//     erro          erro de cifra, quando o valor não pôde ser decifrado
//                   (o chamador decide o que fazer; aqui devolve valor null,
//                   para que um segredo ilegível nunca seja usado às cegas)
function ler(valor, contexto) {
  if (!CONTEXTO_VALIDO.has(contexto)) throw new Error(`Contexto de segredo desconhecido: ${contexto}`);
  if (valor === null || valor === undefined) return { valor: null, cifrado: false, precisaMigrar: false, erro: null };
  const bruto = String(valor);
  if (bruto === '') return { valor: '', cifrado: false, precisaMigrar: false, erro: null };

  if (!cifra.estaCifrado(bruto)) {
    // Texto simples: instalação anterior a esta alteração, ou sem chave.
    return { valor: bruto, cifrado: false, precisaMigrar: cifraDisponivel(), erro: null };
  }

  try {
    const r = cifra.decifrar(bruto, { contexto });
    return { valor: r.texto, cifrado: true, precisaMigrar: false, erro: null };
  } catch (err) {
    // Chave diferente ou valor alterado. Um segredo ilegível não é usado.
    return { valor: null, cifrado: true, precisaMigrar: false, erro: err };
  }
}

// ── Conveniências por campo ─────────────────────────────────────────
const protegerTotp = (v) => proteger(v, CONTEXTOS.totp);
const lerTotp = (v) => ler(v, CONTEXTOS.totp);
const protegerPasswordSmtp = (v) => proteger(v, CONTEXTOS.smtpPass);
const lerPasswordSmtp = (v) => ler(v, CONTEXTOS.smtpPass);

// Estado para a interface/diagnóstico (sem segredos).
function estado() {
  const e = cifra.estado();
  return {
    cifra: e.configurada,
    algoritmo: e.algoritmo,
    contextos: Object.values(CONTEXTOS),
    aviso: e.mensagem || null,
  };
}

module.exports = {
  CONTEXTOS,
  cifraDisponivel,
  proteger,
  ler,
  protegerTotp,
  lerTotp,
  protegerPasswordSmtp,
  lerPasswordSmtp,
  estado,
  reiniciarAviso,
};
