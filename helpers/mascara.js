// ─────────────────────────────────────────────────────────────────────
// MÁSCARAS de dados pessoais e financeiros.
//
// Para que serve: o acesso de suporte (nível `diagnostico`) precisa de LER
// dados reais para diagnosticar — mas não precisa de IDENTIFICAR pessoas nem
// de conhecer números de conta por inteiro. As vistas de suporte passam os
// valores por estas funções, e o que fica visível é o mínimo que ainda permite
// responder a «este dado está preenchido?», «está correto?», «de quem é?» sem
// expor o dado em si.
//
// Contrato deste módulo:
//   · PURO — sem I/O, sem estado, sem base de dados, sem data/hora implícita.
//   · Determinístico: a mesma entrada devolve sempre a mesma saída.
//   · Nunca lança: qualquer entrada inesperada (null, undefined, número,
//     objeto, texto livre, lixo) devolve uma máscara segura em vez de erro. Uma
//     vista não pode rebentar por causa de um dado sujo na base de dados.
//   · Falha FECHADA: quando não é possível reconhecer o valor, mostra `***` —
//     nunca devolve o valor original «por precaução».
//
// A validação fiscal (NIF/IBAN) NÃO é reimplementada aqui: vem de
// `public/js/validacao-fiscal.js`, o mesmo ficheiro que o browser usa
// (`window.ValidacaoFiscal`). Uma regra fiscal duplicada divergiria da que
// valida os formulários — e passaria a haver duas verdades sobre o mesmo NIF.
// ─────────────────────────────────────────────────────────────────────
const fiscal = require('../public/js/validacao-fiscal');

// ── Constantes de forma ────────────────────────────────────────────
// O caractere de máscara é um único `*` repetido: legível em texto, em
// `title=` e em CSV exportado, e sem ambiguidade com o dígito 0 ou a letra O.
const OCULTO = '*';
const VAZIO = '—'; // valor ausente (não é o mesmo que «mascarado»)
const DESCONHECIDO = '***'; // valor presente mas irreconhecível

// ── Normalização de entrada ────────────────────────────────────────
// Aceita string, número e null/undefined. Tudo o resto (arrays, objetos,
// booleanos) é tratado como ausente, para nunca acabar a imprimir
// `[object Object]` numa vista.
function texto(valor) {
  if (valor === null || valor === undefined) return '';
  const t = typeof valor;
  if (t === 'string') return valor;
  if (t === 'number') return Number.isFinite(valor) ? String(valor) : '';
  return '';
}

// `true` quando não há nada a mostrar (campo vazio ou ausente). A vista de
// suporte distingue três situações — «sem dado», «mascarado», «válido» — e é
// aqui que a primeira se decide.
function ausente(valor) {
  return texto(valor).trim() === '';
}

// ── IBAN ───────────────────────────────────────────────────────────
// Mostra o PAÍS e os ÚLTIMOS 4 caracteres, preservando o agrupamento de 4 em 4
// que o utilizador já conhece dos formulários (`formatarIban`).
//
//   PT50 0002 0123 1234 5678 9015 4  →  PT50 •••• •••• •••• •••• 9015 4
//
// O país fica à vista de propósito: para diagnóstico, «conta portuguesa ou
// estrangeira» é informação útil e não identifica ninguém. O resto é oculto
// com um só caractere por posição, para o comprimento continuar legível.
function iban(valor) {
  if (ausente(valor)) return VAZIO;
  const normalizado = fiscal.normalizarIban(texto(valor));
  if (!normalizado) return VAZIO;

  // Reconhecível como IBAN: 2 letras de país + 2 dígitos + corpo alfanumérico.
  // Os comprimentos oficiais variam por país (15-34); não se impõe um total,
  // para não recusar IBAN estrangeiros legítimos de países fora da tabela.
  const forma = /^[A-Z]{2}\d{2}[A-Z0-9]+$/;
  if (!forma.test(normalizado) || normalizado.length < 8) return DESCONHECIDO;

  const pais = normalizado.slice(0, 4); // ex.: 'PT50'
  const corpo = normalizado.slice(4);
  // Com 1-4 caracteres de corpo não há nada a ocultar que valha a pena: mostra-se.
  const visiveis = 4;
  if (corpo.length <= visiveis) return `${pais} ${corpo}`;

  // Reconstrói o IBAN **posição a posição**, com o MESMO comprimento do
  // original: cada caractere oculto é um `*`, e o comprimento continua a ser
  // verificável (útil para diagnóstico). O grupo final visível fica separado
  // dos ocultos, para não restar dúvida sobre o que está à vista.
  const ultimos = corpo.slice(-visiveis);
  const ocultos = OCULTO.repeat(corpo.length - visiveis);

  // Blocos de 4 nos ocultos (o resto fica no fim) + o grupo visível.
  // 17 ocultos → «**** **** **** **** *»; depois, separado, «0154».
  return `${pais} ${ocultos.replace(/(.{4})/g, '$1 ').trimEnd()} ${ultimos}`;
}

// ── NIF ────────────────────────────────────────────────────────────
// Preserva o primeiro e o último terços e oculta o miolo — permite confirmar
// «é o NIF da pessoa certa?» e «está bem formado?» sem o expor.
//
//   123456789  →  123***789
//
// Um valor com menos de 9 dígitos não é um NIF português: devolve `***`. Não se
// valida o dígito de controlo: um NIF mal formado é precisamente um dos
// problemas que o suporte tem de conseguir VER, por isso a máscara não o
// rejeita — só o torna irreconhecível quando o formato é impossível.
function nif(valor) {
  if (ausente(valor)) return VAZIO;
  const normalizado = fiscal.normalizarNif(texto(valor));
  if (!/^\d{9}$/.test(normalizado)) return DESCONHECIDO;
  return `${normalizado.slice(0, 3)}${OCULTO.repeat(3)}${normalizado.slice(6)}`;
}

// ── E-mail ─────────────────────────────────────────────────────────
// Preserva o DOMÍNIO inteiro — é o que interessa para diagnóstico (o
// condomínio escreve para `@gmail.com`? para um domínio próprio? há um typo no
// domínio?) — e reduz a parte local à primeira letra, com uma máscara de
// largura fixa (o comprimento da parte local não é informação útil e é, por si
// só, um sinal identificativo fraco mas evitável).
//
//   maria@dominio.pt  →  m***@dominio.pt
//
// Sem `@`, ou com uma forma que não permite identificar um domínio, devolve
// `***`: nunca se mostra um valor que não se conseguiu interpretar.
function email(valor) {
  if (ausente(valor)) return VAZIO;
  const limpo = texto(valor).trim();
  const partes = limpo.split('@');
  if (partes.length !== 2) return DESCONHECIDO;

  const local = partes[0];
  const dominio = partes[1];
  // Um domínio sem ponto não é um domínio (e evita mascarar algo que afinal
  // não é um e-mail, mostrando a parte depois do `@`).
  if (!local || !dominio || !dominio.includes('.')) return DESCONHECIDO;

  return `${local.charAt(0)}***@${dominio}`;
}

// ── Telefone ───────────────────────────────────────────────────────
// Mostra os ÚLTIMOS 3 DÍGITOS quando existem. É o suficiente para confirmar
// «é o número que penso?» e distingue «sem telefone» de «telefone inválido».
//
//   912 345 678        →  *** *** 678
//   +351 912 345 678   →  *** *** 678
//   texto livre        →  ***
//
// A máscara trabalha sobre DÍGITOS, não sobre o texto original: preservar a
// pontuação de um valor inválido poderia deixar passar parte do número.
function telefone(valor) {
  if (ausente(valor)) return VAZIO;
  const digitos = texto(valor).replace(/\D/g, '');
  // Menos de 4 dígitos: o que sobrava (1-3 dígitos) ficaria quase todo visível
  // e não é um telefone em nenhum formato razoável.
  if (digitos.length < 4) return DESCONHECIDO;
  const ultimos = digitos.slice(-3);
  const ocultos = OCULTO.repeat(Math.max(3, digitos.length - 3));
  return `${agruparDigitos(ocultos)} ${ultimos}`.trim();
}

// Agrupa a parte oculta em blocos de 3, para o resultado ter o aspeto de um
// número e não uma barra contínua de asteriscos.
function agruparDigitos(cadeia) {
  return String(cadeia).replace(/(.{3})(?=.)/g, '$1 ');
}

module.exports = {
  OCULTO,
  VAZIO,
  DESCONHECIDO,
  ausente,
  iban,
  nif,
  email,
  telefone,
};
