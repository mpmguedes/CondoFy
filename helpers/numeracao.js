const sequelize = require('../config/database');
const { Numeracao } = require('../models');

// Gera o próximo número de documento de forma persistente e única.
// Ex.: tipo 'aviso_quota', ano 2026 → "2026/0001", "2026/0002", ...
// A sequência é independente do id interno e nunca é reutilizada.
//
// `jaUsado(numero)` — predicado ASSÍNCRONO opcional, fornecido pelo chamador,
// que responde se o número já existe na tabela de destino. A série pode ficar
// atrasada em relação aos documentos já gravados (importação, restauro de
// backup, alinhamento manual da sequência); sem esta verificação o gerador
// devolveria indefinidamente um número já ocupado e o documento nunca seria
// gravado. Com ela, o gerador salta para o primeiro número livre.
// ⚠️ O chamador tem de verificar DENTRO da mesma transação `t` (é o que garante
// que dois pedidos concorrentes não ficam com o mesmo número: o `FOR UPDATE`
// sobre a linha de `numeracoes` serializa-os).
const MAX_SALTOS = 1000;

function comporNumero(formato, ano, sequencia) {
  return String(formato || '{ano}/{sequencia}')
    .replace('{ano}', String(ano))
    .replace('{sequencia}', String(sequencia).padStart(4, '0'));
}

async function proximoNumero(tipoDocumento, { ano, transaction, jaUsado } = {}) {
  const anoNum = ano || new Date().getFullYear();
  const t = transaction || (await sequelize.transaction());
  let own = false;
  if (!transaction) {
    own = true;
  }
  try {
    let numeracao = await Numeracao.findOne({
      where: { tipo_documento: tipoDocumento, ano: anoNum },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!numeracao) {
      numeracao = await Numeracao.create(
        { tipo_documento: tipoDocumento, ano: anoNum, sequencia: 0, formato: '{ano}/{sequencia}' },
        { transaction: t }
      );
    }

    const formato = numeracao.formato || '{ano}/{sequencia}';
    let sequencia = numeracao.sequencia + 1;
    let numero = comporNumero(formato, anoNum, sequencia);

    if (typeof jaUsado === 'function') {
      let saltos = 0;
      while (await jaUsado(numero)) {
        saltos += 1;
        if (saltos > MAX_SALTOS) {
          throw new Error(
            `Não há número livre para o documento "${tipoDocumento}" de ${anoNum}: ` +
            `${numero} e os ${MAX_SALTOS} seguintes já estão usados. A sequência precisa de ser reconciliada.`
          );
        }
        sequencia += 1;
        numero = comporNumero(formato, anoNum, sequencia);
      }
    }

    await numeracao.update({ sequencia }, { transaction: t });

    if (own) {
      await t.commit();
    }
    return numero;
  } catch (err) {
    if (own) {
      await t.rollback();
    }
    throw err;
  }
}

module.exports = { proximoNumero, comporNumero, MAX_SALTOS };
