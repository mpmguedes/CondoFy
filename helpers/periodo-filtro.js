// ─────────────────────────────────────────────────────────────────────
// Resolução do PERÍODO de consulta (filtro por datas) — puro, sem BD.
//
// Porque existe: a listagem da Central de Emails cresce com a aplicação e
// deixar o histórico inteiro sem filtro torna a página inutilizável. O período
// é resolvido AQUI — uma só vez, fora da rota — para que:
//
//   · as regras de calendário (mês em curso, mês anterior, últimos N dias)
//     sejam testáveis sem HTTP nem base de dados;
//   · o filtro seja aplicado À CONSULTA (`Op.between`), nunca escondendo
//     registos no frontend depois de os carregar todos;
//   · a MESMA resolução sirva a vista de administração e a de diagnóstico,
//     para que o suporte não passe a ver um histórico silenciosamente truncado.
//
// ⛔ NÃO apaga nem altera emails: é exclusivamente um filtro de leitura.
//
// Este módulo não conhece Sequelize nem o nome da coluna a filtrar — devolve
// apenas o intervalo; quem consulta decide onde o aplicar.
// ─────────────────────────────────────────────────────────────────────
const {
  toDateInput,
  primeiroDiaDoMes,
  somarDias,
  inicioDoDia,
  fimDoDia,
} = require('./dates');

// Atalhos apresentados na interface. `personalizado` NÃO tem intervalo próprio:
// significa «usar as datas escritas nos campos de data».
const ATALHOS = [
  { id: 'este-mes', rotulo: 'Este mês' },
  { id: 'mes-anterior', rotulo: 'Mês anterior' },
  { id: 'ultimos-7', rotulo: 'Últimos 7 dias' },
  { id: 'ultimos-30', rotulo: 'Últimos 30 dias' },
  { id: 'personalizado', rotulo: 'Personalizado' },
];

// Atalhos com intervalo CALCULADO (todos menos `personalizado`).
const IDS_ATALHO = ATALHOS.filter((a) => a.id !== 'personalizado').map((a) => a.id);

// 'YYYY-MM-DD' → Date local à meia-noite, ou `null` se não for uma data válida.
//
// Validação ESTRITA: `new Date(2026, 1, 30)` transbordaria em SILÊNCIO para
// 2 de março (e `2026-13-01` para janeiro do ano seguinte). Um parâmetro de
// query manipulado nunca deve produzir um intervalo diferente do escrito, pelo
// que os componentes são reconferidos depois de construída a data.
function dataDeInput(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor == null ? '' : valor).trim());
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const d = new Date(ano, mes - 1, dia);
  if (d.getFullYear() !== ano || d.getMonth() !== mes - 1 || d.getDate() !== dia) return null;
  return d;
}

// Intervalo [de, ate] (ambos inclusive, à meia-noite local) de um atalho.
// Devolve `null` para um atalho desconhecido ou para `personalizado`.
function intervaloDoAtalho(id, agora = new Date()) {
  const hoje = inicioDoDia(agora);
  switch (id) {
    case 'este-mes':
      // Mês em curso até hoje (o intervalo por omissão da listagem).
      return { de: primeiroDiaDoMes(agora), ate: hoje };
    case 'mes-anterior': {
      // Último dia do mês anterior: o dia antes do 1.º do mês em curso.
      const ultimoAnterior = somarDias(primeiroDiaDoMes(agora), -1);
      return { de: primeiroDiaDoMes(ultimoAnterior), ate: ultimoAnterior };
    }
    case 'ultimos-7':
      // «Últimos 7 dias» inclui hoje: hoje + os 6 dias anteriores.
      return { de: somarDias(hoje, -6), ate: hoje };
    case 'ultimos-30':
      return { de: somarDias(hoje, -29), ate: hoje };
    default:
      return null;
  }
}

// Resolve o período efetivo a partir da query do pedido.
//
// Prioridade:
//   1. `?periodo=<atalho>` válido  → o intervalo do atalho (ignora `de`/`ate`,
//      que o formulário envia sempre e que poderiam contradizer o atalho);
//   2. `?de=` / `?ate=` válidos    → o intervalo personalizado escrito;
//   3. ausência de ambos           → mês em curso até hoje.
//
// Devolve `{ de, ate, deInput, ateInput, atalho, rotulo }`:
//   · `de`/`ate`  — instantes prontos para a consulta (início e fim do dia,
//     ambos INCLUSIVOS);
//   · `deInput`/`ateInput` — 'YYYY-MM-DD', para os campos de data da vista;
//   · `atalho`/`rotulo` — atalho ativo, DERIVADO do intervalo efetivo.
function resolverPeriodo(query = {}, agora = new Date()) {
  const q = query || {};
  const hoje = inicioDoDia(agora) || new Date();

  const pedido = String(q.periodo == null ? '' : q.periodo);
  const preset = IDS_ATALHO.includes(pedido) ? intervaloDoAtalho(pedido, agora) : null;

  let de;
  let ate;

  if (preset) {
    de = preset.de;
    ate = preset.ate;
  } else {
    de = dataDeInput(q.de) || primeiroDiaDoMes(agora);
    ate = dataDeInput(q.ate) || hoje;
    // Um intervalo invertido (inicial posterior à final) não devolveria nada e
    // leria como «não há emails»; normaliza-se para a ordem cronológica — o que
    // o utilizador vê nos campos passa a ser o intervalo realmente aplicado.
    if (de.getTime() > ate.getTime()) {
      const troca = de;
      de = ate;
      ate = troca;
    }
  }

  const deInput = toDateInput(de);
  const ateInput = toDateInput(ate);

  // O atalho ativo é DERIVADO do intervalo efetivo (e não do parâmetro): assim
  // a entrada inicial — sem parâmetros — aparece como «Este mês», e não como
  // «Personalizado».
  //
  // Coincidências MEDIDAS (intervalos realmente iguais, pelo que a consulta é a
  // mesma — muda apenas o botão assinalado): até ao dia 7, «Este mês» e
  // «Últimos 7 dias» dão o mesmo intervalo; no dia 30, «Este mês» e «Últimos
  // 30 dias». A ordem de `IDS_ATALHO` decide (ganha sempre «Este mês»).
  // Comportamento registado no Roadmap (P51).
  let atalho = 'personalizado';
  for (const id of IDS_ATALHO) {
    const iv = intervaloDoAtalho(id, agora);
    if (iv && toDateInput(iv.de) === deInput && toDateInput(iv.ate) === ateInput) {
      atalho = id;
      break;
    }
  }

  return {
    de: inicioDoDia(de),
    ate: fimDoDia(ate),
    deInput,
    ateInput,
    atalho,
    rotulo: (ATALHOS.find((a) => a.id === atalho) || {}).rotulo || 'Personalizado',
  };
}

module.exports = {
  ATALHOS,
  IDS_ATALHO,
  dataDeInput,
  intervaloDoAtalho,
  resolverPeriodo,
};
