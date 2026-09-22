// ─────────────────────────────────────────────────────────────────────
// Tokens de uso único — convite de ativação e reposição de palavra-passe.
//
// O token é um SEGREDO PORTADOR: quem o apresentar fica com a conta. Por isso
// NUNCA é guardado. Guarda-se apenas o DIGEST SHA-256, exatamente como já
// acontece com `two_fa_email_codigo_hash` e `two_fa_recovery_hash` em
// helpers/doisfatores.js.
//
// Consequências (deliberadas):
//
//   · um dump da base de dados deixa de dar acesso a contas alheias — de um
//     digest não se reconstrói o link que foi enviado por email;
//   · o servidor não precisa de ler o token de volta: compara o digest do token
//     APRESENTADO com o digest guardado. É a mesma pesquisa por igualdade de
//     antes, agora sobre o digest, pelo que nenhum fluxo muda.
//
// O token em claro só existe no link enviado por email e no pedido do
// utilizador — nunca em repouso.
//
// ── Compatibilidade ─────────────────────────────────────────────────
// Os tokens emitidos antes desta alteração estão em texto simples. São aceites
// UMA última vez (pesquisa pelo valor literal) e convertidos para digest no
// momento em que são usados, pelo que nenhum convite ou pedido de reposição em
// curso é invalidado. A conversão dos que nunca forem usados é feita pela
// migração `20260101000079-segredos-em-repouso.js`.
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// SHA-256 em hexadecimal MINÚSCULO (64 caracteres). A caixa é fixada de
// propósito: é o formato gravado e comparado, e não pode depender da collation
// da base de dados.
function digest(valor) {
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
}

const FORMATO_DIGEST = /^[0-9a-f]{64}$/;

function ehDigest(valor) {
  return typeof valor === 'string' && FORMATO_DIGEST.test(valor);
}

// Procura um utilizador pelo token apresentado.
//
//   User   modelo Sequelize (ou duplo) com `findOne`
//   campo  'convite_token' | 'reset_token'
//   token  valor apresentado pelo utilizador (vem do URL)
//
// Devolve a instância encontrada ou null. Nunca lança por causa da conversão:
// um token válido não pode ser invalidado por uma falha ao reescrever o digest.
async function utilizadorPorToken(User, campo, token, { where = {} } = {}) {
  const bruto = String(token == null ? '' : token);
  if (!bruto) return null;

  const porDigest = await User.findOne({ where: { ...where, [campo]: digest(bruto) } });
  if (porDigest) return porDigest;

  // Token emitido antes desta alteração (texto simples): aceite e convertido.
  const legado = await User.findOne({ where: { ...where, [campo]: bruto } });
  if (!legado) return null;
  try {
    await legado.update({ [campo]: digest(bruto) });
  } catch (err) {
    // A conversão falhou (BD indisponível, por exemplo). O token continua
    // válido em texto simples e a conversão volta a ser tentada na utilização
    // seguinte — não se falha o fluxo do utilizador por causa disto.
  }
  return legado;
}

module.exports = { digest, ehDigest, utilizadorPorToken };
