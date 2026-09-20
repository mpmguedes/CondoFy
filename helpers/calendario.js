// Agregação dos acontecimentos do condomínio para o calendário.
//
// O calendário lê TRÊS origens:
//   • Assembleias (data, hora, local, estado, tipo) — inclui a convocatória;
//   • Avisos programados (data_programada) — comunicações com data marcada;
//   • Eventos ad-hoc (`eventos`) — acontecimentos do condomínio sem módulo
//     de origem próprio, criados e editados no próprio calendário.
//
// As duas primeiras são AGREGADAS a partir das tabelas que já existiam; a
// terceira tem tabela própria (`eventos`, migration 20260101000078), porque
// não há nenhum módulo onde um acontecimento avulso possa viver. Não se
// reutiliza `agenda_items`: um item da ordem de trabalhos pertence sempre a
// uma assembleia (`assembleia_id` NOT NULL) e transporta deliberação/FCR.
//
// Todas as consultas filtram OBRIGATORIAMENTE por `condominio_id`, para que
// nenhum utilizador possa ver acontecimentos de outro condomínio.
//
// Este módulo é usado pelo calendário da administração. O portal do condómino
// tem a sua própria leitura, deliberadamente independente (área separada);
// o formato dos eventos aqui definido é compatível com ele, para que uma
// adopção futura não exija reescrever a agregação.

const { Op } = require('sequelize');
const { Assembleia, Aviso, Evento } = require('../models');

// Rótulos de estado da assembleia (os mesmos da listagem de assembleias).
const ESTADOS_ASSEMBLEIA = {
  rascunho: { rotulo: 'Rascunho', classe: 'text-bg-secondary' },
  agendada: { rotulo: 'Agendada', classe: 'text-bg-warning' },
  convocada: { rotulo: 'Convocada', classe: 'text-bg-info' },
  realizada: { rotulo: 'Realizada', classe: 'text-bg-success' },
  cancelada: { rotulo: 'Cancelada', classe: 'text-bg-dark' },
};

const TIPOS_ASSEMBLEIA = {
  ordinaria: 'Ordinária',
  extraordinaria: 'Extraordinária',
  urgencia: 'Urgência',
};

// Tipos de acontecimento apresentáveis. `todos` serve para o filtro da vista.
const TIPOS_EVENTO = {
  assembleia: { rotulo: 'Assembleia', icone: 'forum' },
  aviso: { rotulo: 'Comunicação programada', icone: 'campaign' },
  evento: { rotulo: 'Evento', icone: 'event' },
};

// Data local segura: `data` (DATEONLY) chega como 'YYYY-MM-DD'; comparar
// strings ISO evita o desvio de um dia provocado pelo fuso horário.
function dataISO(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${valor.getFullYear()}-${mes}-${dia}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(valor));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// «Hoje» no fuso local, em ISO. Não se usa toISOString() (converteria para UTC
// e, perto da meia-noite, mudaria o dia).
function hojeISO(referencia) {
  return dataISO(referencia || new Date());
}

function estadoAssembleia(estado) {
  return ESTADOS_ASSEMBLEIA[estado] || { rotulo: estado || '—', classe: 'text-bg-light border' };
}

// Uma assembleia cancelada nunca aparece no calendário; as restantes aparecem
// todas (mesmo as já realizadas), porque o histórico é consultável.
function assembleiaVisivel(assembleia) {
  return String(assembleia.estado || '') !== 'cancelada';
}

// Normaliza uma assembleia no formato de evento do calendário.
function eventoDeAssembleia(assembleia) {
  const a = typeof assembleia.toJSON === 'function' ? assembleia.toJSON() : assembleia;
  const tipoRotulo = TIPOS_ASSEMBLEIA[a.tipo] || null;
  const estado = estadoAssembleia(a.estado);
  const titulo = a.numero ? `Assembleia ${a.numero}` : 'Assembleia de condóminos';
  return {
    origem: 'assembleia',
    id: a.id,
    data: dataISO(a.data),
    tipo: 'assembleia',
    tipoRotulo: TIPOS_EVENTO.assembleia.rotulo,
    icone: TIPOS_EVENTO.assembleia.icone,
    titulo,
    tituloDetalhe: tipoRotulo,
    hora: a.hora || null,
    local: a.local || null,
    descricao: a.ordem_trabalhos || null,
    estadoRotulo: estado.rotulo,
    estadoClasse: estado.classe,
    encerrado: ['realizada', 'cancelada'].includes(String(a.estado || '')),
    // Relevante: uma assembleia é sempre um acontecimento relevante do
    // condomínio — é uma reunião formal dos condóminos.
    relevante: true,
    link: `/admin/assembleias/${a.id}`,
  };
}

// Normaliza um aviso programado no formato de evento do calendário.
function eventoDeAviso(aviso) {
  const a = typeof aviso.toJSON === 'function' ? aviso.toJSON() : aviso;
  return {
    origem: 'aviso',
    id: a.id,
    data: dataISO(a.data_programada),
    tipo: 'aviso',
    tipoRotulo: TIPOS_EVENTO.aviso.rotulo,
    icone: TIPOS_EVENTO.aviso.icone,
    titulo: a.assunto,
    tituloDetalhe: null,
    hora: null,
    local: null,
    descricao: a.mensagem || null,
    estadoRotulo: null,
    estadoClasse: null,
    encerrado: false,
    // Uma comunicação programada é informativa, não é um acontecimento
    // do condomínio em si — fica fora do destaque de «relevante».
    relevante: false,
    link: `/admin/avisos/${a.id}`,
  };
}

// Normaliza um evento ad-hoc no formato de evento do calendário.
// A forma devolvida é IDÊNTICA à das outras origens: quem consome a
// agregação (vista, filtros, ordenação) não precisa de saber de onde vem.
function eventoDeEvento(evento) {
  const e = typeof evento.toJSON === 'function' ? evento.toJSON() : evento;
  return {
    origem: 'evento',
    id: e.id,
    data: dataISO(e.data),
    tipo: 'evento',
    tipoRotulo: TIPOS_EVENTO.evento.rotulo,
    icone: TIPOS_EVENTO.evento.icone,
    titulo: e.titulo,
    tituloDetalhe: null,
    hora: e.hora || null,
    horaFim: e.hora_fim || null,
    local: e.local || null,
    descricao: e.descricao || null,
    estadoRotulo: null,
    estadoClasse: null,
    encerrado: false,
    // Relevante: um evento ad-hoc é um acontecimento do condomínio (ao
    // contrário de uma comunicação programada, que é informativa).
    relevante: true,
    // Editável no próprio calendário — ao contrário de assembleias e avisos,
    // que se editam nos módulos de origem.
    editavel: true,
    link: `/admin/calendario/eventos/${e.id}`,
  };
}

// Ordena por data (e, em empate, por hora e id) de forma estável.
function compararEventos(a, b) {
  const da = a.data || '';
  const db = b.data || '';
  if (da !== db) return da < db ? -1 : 1;
  const ha = a.hora || '';
  const hb = b.hora || '';
  if (ha !== hb) return ha < hb ? -1 : 1;
  return (a.id || 0) - (b.id || 0);
}

// Lê e agrega os acontecimentos do condomínio indicado.
// `condominioId` é obrigatório: sem ele devolve vazio, em vez de tudo.
async function eventosDoCondominio(condominioId, opcoes = {}) {
  if (!condominioId) return [];

  const assembleias = await Assembleia.findAll({
    where: { condominio_id: condominioId },
    order: [['data', 'ASC'], ['id', 'ASC']],
  });

  const avisos = await Aviso.findAll({
    where: { condominio_id: condominioId, data_programada: { [Op.ne]: null } },
    order: [['data_programada', 'ASC'], ['id', 'ASC']],
  });

  const eventosAdHoc = await Evento.findAll({
    where: { condominio_id: condominioId },
    order: [['data', 'ASC'], ['id', 'ASC']],
  });

  const eventos = [
    ...assembleias.filter(assembleiaVisivel).map(eventoDeAssembleia),
    ...avisos.map(eventoDeAviso),
    ...eventosAdHoc.map(eventoDeEvento),
  ]
    .filter((e) => e.data)
    .sort(compararEventos);

  if (opcoes.tipo) return eventos.filter((e) => e.tipo === opcoes.tipo);
  return eventos;
}

// Separa em futuros (a partir de hoje, inclusive) e passados (do mais recente
// para o mais antigo). Devolve também o destaque e a contagem de relevantes,
// para a vista não repetir lógica.
function separarPorData(eventos, referencia) {
  const hoje = hojeISO(referencia);
  const proximos = eventos.filter((e) => String(e.data || '') >= hoje);
  const passados = eventos.filter((e) => String(e.data || '') < hoje).reverse();
  return {
    hoje,
    proximos,
    passados,
    proximo: proximos.length ? proximos[0] : null,
    total: eventos.length,
    totalRelevantes: eventos.filter((e) => e.relevante).length,
  };
}

module.exports = {
  eventosDoCondominio,
  separarPorData,
  dataISO,
  hojeISO,
  compararEventos,
  eventoDeAssembleia,
  eventoDeAviso,
  eventoDeEvento,
  ESTADOS_ASSEMBLEIA,
  TIPOS_ASSEMBLEIA,
  TIPOS_EVENTO,
};
