// ─────────────────────────────────────────────────────────────────────
// Contexto dos Tips de armazenamento — ponte entre os dados REAIS e o motor.
//
// O motor (`helpers/tips.js`) é PURO: não vai buscar nada. Quem reúne os factos
// que as condições consomem é este ficheiro. Há duas metades bem separadas:
//
//  · `contextoDeArmazenamento(...)` é PURA: recebe o que já foi carregado e
//    devolve o objeto que as condições do registo consomem. É o que os testes
//    exercitam, sem base de dados.
//  · `tipsDaPagina(...)` recebe esses dados JÁ carregados pela rota (a página de
//    armazenamento já os tem, via `routes/configuracao.js:dadosArmazenamento`),
//    lê as dispensas desta conta e pede a decisão ao motor. Não faz leituras
//    próprias — não há uma segunda ida à base de dados por causa dos tips.
//
// ⛔ O QUE ESTE FICHEIRO NUNCA FAZ
//  · Não chama `ligacoes.ligacaoParaBackup()`: limita-se a copiar o booleano
//    `usavel` que `storage.estadoDoCondominio` já calcula e que a própria página
//    de armazenamento mostra. Nada de resolver ligações por conta própria.
//  · Não copia contas, tokens nem nomes de contas para o contexto: os tips não
//    têm por onde revelar a conta de outro condomínio, mesmo que alguém escreva
//    uma condição nova com pressa.
//  · Não inventa o que não conseguiu ler: se um dado faltar, o campo fica
//    ausente e a condição correspondente simplesmente não é satisfeita — nunca
//    se mostra um aviso falso.
// ─────────────────────────────────────────────────────────────────────

const MS_POR_DIA = 86400000;

function diasDesde(data, agora) {
  if (!data) return null;
  const t = new Date(data).getTime();
  if (!Number.isFinite(t)) return null;
  const a = new Date(agora === null || agora === undefined ? Date.now() : agora).getTime();
  if (!Number.isFinite(a)) return null;
  const dias = Math.floor((a - t) / MS_POR_DIA);
  return Number.isFinite(dias) ? dias : null;
}

function positivo(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Parte PURA ──────────────────────────────────────────────────────
// `estadoArmazenamento` = o que `storage.estadoDoCondominio(cid)` devolve
//                         (dentro de `dados.armazenamento`).
// `ultimoBackupEstado`  = o que `helpers/backup-estado.js:interpretar` devolve
//                         para a última linha de `backup_logs` (ou null).
function contextoDeArmazenamento({ area, condominioId, papel, estadoArmazenamento, ultimoBackupEstado, agora } = {}) {
  const a = estadoArmazenamento && typeof estadoArmazenamento === 'object' ? estadoArmazenamento : {};

  // Só os CAMPOS necessários, deliberadamente: sem contas, sem tokens, sem
  // nomes de contas. `ligadoPlataforma` é a ligação da INSTALAÇÃO que serve
  // este condomínio (a mesma que a página mostra).
  const provedores = (Array.isArray(a.provedores) ? a.provedores : []).map((p) => ({
    nome: p && p.nome ? String(p.nome) : null,
    ligado: Boolean(p && p.ligado),
    ligadoPlataforma: Boolean(p && p.ligadoPlataforma),
  })).filter((p) => p.nome);

  const plataforma = (Array.isArray(a.plataforma) ? a.plataforma : []).map((p) => ({
    nome: p && p.nome ? String(p.nome) : null,
    ligado: Boolean(p && p.ligado),
  })).filter((p) => p.nome);

  const b = a.backup && typeof a.backup === 'object' ? a.backup : {};
  const est = ultimoBackupEstado && typeof ultimoBackupEstado === 'object' ? ultimoBackupEstado : {};

  return {
    area: area ? String(area) : null,
    condominioId: positivo(condominioId),
    papel: papel || null,
    armazenamento: { provedores, plataforma },
    backup: {
      estado: est.estado || null,
      temLocal: Boolean(est.temLocal),
      destino: b.destino || null,
      // Booleano da fachada (`estadoDoCondominio`): um destino configurado sem
      // ligação utilizável é ignorado pelo job de backups. Explícito para o
      // registo poder exigir `false` sem inventar a situação.
      usavel: b.usavel === true,
      diasDesde: diasDesde(est.data, agora),
    },
  };
}

// ── Decisão para uma página ─────────────────────────────────────────
// `dados` = o que `routes/configuracao.js:dadosArmazenamento(cid)` devolve.
// Junta o contexto, lê as dispensas DESTA conta e pede a decisão ao motor.
//
// `ambitos` por omissão = condomínio + instalação, que são os âmbitos que uma
// página de administração pode mostrar.
async function tipsDaPagina({ area, condominioId, userId, papel, dados, agora, limite, ambitos } = {}) {
  const tips = require('../tips.js');
  const ctx = contextoDeArmazenamento({
    area,
    condominioId,
    papel,
    estadoArmazenamento: dados && dados.armazenamento,
    ultimoBackupEstado: dados && dados.ultimoBackupEstado,
    agora,
  });
  const dispensas = await tips.carregarDispensas(userId);
  return tips.escolher(
    {
      ...ctx,
      agora,
      ambito: ambitos || [tips.AMBITOS.condominio, tips.AMBITOS.instalacao],
    },
    dispensas,
    limite === undefined ? tips.LIMITE_APRESENTACAO : limite
  );
}

module.exports = { MS_POR_DIA, diasDesde, contextoDeArmazenamento, tipsDaPagina };
