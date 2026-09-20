// ─────────────────────────────────────────────────────────────────────
// Calendário do condomínio (administração).
//
// Não existe — nem se cria — uma tabela de eventos paralela às assembleias
// e às comunicações: o calendário AGREGA os acontecimentos datados, através
// de `helpers/calendario.js`:
//   • Assembleias (não canceladas) — data, hora, local, estado, tipo;
//   • Avisos programados (`data_programada`) — comunicações com data marcada;
//   • Eventos ad-hoc (`eventos`) — os únicos com CRUD no próprio calendário,
//     porque não têm módulo de origem (ver routes/eventos.js).
//
// Isolamento multi-condomínio: o router usa o condomínio ativo da sessão
// (`tenant.comCondominioAtivo`) e TODAS as leituras filtram por
// `condominio_id` (dentro do helper). Um utilizador nunca vê acontecimentos
// de outro condomínio.
//
// Acesso: o mesmo papel das áreas operacionais do dia-a-dia (gestor), para
// que a administração — admin e gestor — possa usar o calendário. A criação
// e edição de acontecimentos continua a fazer-se nos módulos de origem
// (Assembleias e Comunicações), a partir dos atalhos do calendário.
//
// Nota deliberada: este módulo NÃO está na allow-list do suporte
// (`helpers/suporte-allowlist.js`). Não tem vista de diagnóstico minimizada,
// e a regra da allow-list é que uma rota nova nasce INACESSÍVEL ao suporte.
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const tenant = require('../helpers/tenant');
const calendario = require('../helpers/calendario');
const { toDateInput } = require('../helpers/dates');

const router = express.Router();

// Acesso: condomínio ativo da sessão (associação real validada pelo tenant).
router.use(tenant.comCondominioAtivo);
// Papel ≥ gestor: abrange admin e gestor do condomínio.
router.use(tenant.comPapel('gestor'));

// Filtros de tipo aceites. Qualquer outro valor é ignorado (mostra tudo).
const FILTROS = ['assembleia', 'aviso', 'evento'];

function lerFiltros(query) {
  const tipo = FILTROS.includes(String(query.tipo || '')) ? String(query.tipo) : '';
  // Mês no formato YYYY-MM; só filtra quando bem formado.
  const mes = /^\d{4}-\d{2}$/.test(String(query.mes || '')) ? String(query.mes) : '';
  return { tipo, mes };
}

// Aplica os filtros de tipo e de mês a uma lista de eventos.
function aplicarFiltros(eventos, { tipo, mes }) {
  return eventos.filter((e) => {
    if (tipo && e.tipo !== tipo) return false;
    if (mes && String(e.data || '').slice(0, 7) !== mes) return false;
    return true;
  });
}

// Meses presentes nos eventos, para o seletor da vista (do mais recente para
// o mais antigo). Não se inventam meses sem acontecimentos.
const MESES_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function mesesDisponiveis(eventos) {
  const vistos = new Set();
  const lista = [];
  for (const e of eventos) {
    const chave = String(e.data || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(chave) || vistos.has(chave)) continue;
    vistos.add(chave);
    const [ano, mes] = chave.split('-');
    lista.push({ valor: chave, etiqueta: `${MESES_PT[Number(mes) - 1]} ${ano}` });
  }
  return lista.sort((a, b) => (a.valor < b.valor ? 1 : -1));
}

// ── Calendário do condomínio ────────────────────────────────────────
// `?tipo=assembleia|aviso|evento` e `?mes=YYYY-MM` filtram a lista.
// A criação faz-se no topo da vista: evento ad-hoc no próprio calendário;
// assembleias e comunicações nos módulos de origem.
router.get('/calendario', async (req, res) => {
  const filtros = lerFiltros(req.query);
  try {
    const todos = await calendario.eventosDoCondominio(req.condominioId);
    const filtrados = aplicarFiltros(todos, filtros);
    // `separarPorData` devolve proximos (a partir de hoje) + passados
    // (do mais recente para o mais antigo) + o destaque.
    const separado = calendario.separarPorData(filtrados);

    return res.render('admin/calendario', {
      titulo: 'Calendário',
      filtros,
      mesDeHoje: toDateInput(new Date()).slice(0, 7),
      meses: mesesDisponiveis(todos),
      temFiltros: Boolean(filtros.tipo || filtros.mes),
      totalSemFiltros: todos.length,
      totalRelevantes: separado.totalRelevantes,
      proximos: separado.proximos,
      passados: separado.passados,
      proximo: separado.proximo,
      total: separado.total,
      hoje: separado.hoje,
    });
  } catch (err) {
    console.error('[calendario] erro ao carregar os acontecimentos:', err);
    req.flash('error_msg', 'Não foi possível carregar o calendário.');
    return res.redirect('/admin');
  }
});

module.exports = router;
