// ═══════════════════════════════════════════════════════════════════
// Reautenticação — confirmação da IDENTIDADE do utilizador autenticado.
//
// Extraído de `routes/saida-condominio.js` (P54-3), onde vivia local, para ser
// reutilizado por qualquer operação crítica que exija prova de identidade
// adicional (alterar credenciais SMTP, sair de um condomínio).
//
// ⛔ NÃO é um segundo mecanismo: é o MESMO, agora partilhado. A regra do projeto
//    é explícita — duas implementações da mesma regra divergem. `saida-condominio`
//    passou a delegar aqui, com o comportamento inalterado.
//
// Porque é que isto é uma prova de intenção e não um formalismo: a password é
// verificada contra `req.user.password_hash` com bcrypt, no servidor. Uma sessão
// roubada (cookie) NÃO chega para alterar credenciais — é preciso conhecer a
// password da conta. É a barreira que a confirmação de interface não dá.
//
// ⛔ A password NUNCA é: guardada, registada, devolvida, posta em auditoria, em
//    HTML, em URLs ou em `req.session`. É lida de `req.body`, comparada e
//    descartada no fim da função. As mensagens de erro são FIXAS e não ecoam
//    nem o valor introduzido nem o hash.
//
// Se a conta tem 2FA por aplicação ativo, o código TOTP é exigido também: sem
// ele, uma password conhecida (reutilizada, escrita num sítio) bastaria para
// mudar as credenciais de email de toda a instalação.
// ═══════════════════════════════════════════════════════════════════
'use strict';
const bcrypt = require('bcryptjs');
const doisfatores = require('./doisfatores');

// Nomes dos campos no corpo do pedido. Fixos e documentados: a interface tem de
// os usar e os testes fixam-nos para que uma renomeação não passe despercebida.
const CAMPO_PASSWORD = 'password';
const CAMPO_2FA = 'codigo_2fa';

// Devolve `{ ok: true }` ou `{ ok: false, erro }` com mensagem FIXA.
//
// `campos` permite ao chamador adaptar os nomes (ex.: um formulário que já use
// `password` para outra coisa); por omissão usa os nomes canónicos.
function reautenticacaoValida(req, { campos = {} } = {}) {
  const nomePassword = campos.password || CAMPO_PASSWORD;
  const nome2fa = campos.codigo2fa || CAMPO_2FA;

  const password = String((req.body && req.body[nomePassword]) || '');
  if (!password) return { ok: false, erro: 'Indique a sua palavra-passe para confirmar.' };

  const hash = req.user && req.user.password_hash;
  if (!hash || !bcrypt.compareSync(password, hash)) {
    return { ok: false, erro: 'Palavra-passe incorreta.' };
  }

  if (req.user.two_fa_ativo && req.user.two_fa_metodo === 'totp') {
    const codigo = String((req.body && req.body[nome2fa]) || '').replace(/\s+/g, '');
    if (!codigo) return { ok: false, erro: 'Indique o código da aplicação de autenticação.' };
    if (!req.user.two_fa_totp_secret || !doisfatores.verificarTOTP(req.user.two_fa_totp_secret, codigo)) {
      return { ok: false, erro: 'Código de autenticação inválido.' };
    }
  }

  return { ok: true };
}

// A conta exige segundo fator? (para a interface pedir o campo certo)
const exigeSegundoFator = (user) => Boolean(user && user.two_fa_ativo && user.two_fa_metodo === 'totp');

module.exports = {
  reautenticacaoValida,
  exigeSegundoFator,
  CAMPO_PASSWORD,
  CAMPO_2FA,
};
