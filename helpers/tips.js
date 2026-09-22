// ─────────────────────────────────────────────────────────────────────
// MOTOR ÚNICO dos Tips contextuais do backoffice — ORIENTAÇÃO, não alarme.
//
// Não existe — nem deve passar a existir — um segundo motor de Tips. Quem
// quiser acrescentar um tip junta UMA entrada a um registo e o resto (âmbito,
// áreas, prioridade, condição, dispensa e apresentação) já funciona. Há dois
// registos, mas um só motor:
//   · `REGISTO`, neste ficheiro    → condomínio: frações, contas, assembleias,
//                                    armazenamento;
//   · `helpers/tips/registo-administracao.js` → administração: backups e
//                                    armazenamento (acrescentado abaixo).
//
// Distinção que este ficheiro existe para manter:
//   · `helpers/dashboard.js` → SINAIS: «há 3 quotas em atraso». Factos
//     operacionais que exigem decisão hoje. Um zero não é um sinal.
//   · `helpers/tips.js`      → TIPS: «as quotas são distribuídas pela
//     permilagem, e a soma não fecha 1000‰». Explicam, orientam e ajudam a
//     compreender. Só aparecem quando a situação descrita EXISTE mesmo.
//
// Princípios (os mesmos do motor do portal, `helpers/recomendacoes.js`):
//  1. O ESTADO REAL manda. Um tip só é elegível se a sua condição continuar
//     verdadeira no momento do pedido. Ser dispensado não o mantém vivo depois
//     de a situação desaparecer.
//  2. Não se inventam factos. Cada condição lê um dado que já existe (frações,
//     permilagem, contas, titulares, atas, destino de backups). Nada de
//     contadores de «novidade» que o sistema não saiba responder.
//  3. Não se guarda o que se pode deduzir. Persiste-se apenas o que NÃO é
//     dedutível: que o tip foi dispensado e até quando. O cumprimento não se
//     guarda — lê-se do estado real.
//  4. A ação de cada tip é FIXA e vem daqui, nunca do browser: um identificador
//     manipulado não pode originar um destino arbitrário.
//
// ÂMBITO (`ambito`) — a que se refere o tip: 'condominio' ou 'instalacao'.
// ÁREAS (`areas`) — em que PÁGINAS pode aparecer: o motor filtra quando a página
//   indica `ctx.area`, pelo que o mesmo tip não aparece em todo o backoffice.
// PRIORIDADE — a do tipo, ou uma própria da definição quando o tipo não chega
//   para ordenar (é o caso dos tips de backups, ordenados entre si).
//
// ISOLAMENTO: os tips são POR CONDOMÍNIO. A mesma instalação pode ter um
// condomínio com a permilagem por fechar e outro em ordem; dispensar num não
// pode esconder no outro. Por isso a chave de dispensa inclui o condomínio
// (`tip:<id>@c<id>`) e sem condomínio válido não se apresenta nada. A chave
// cabe na coluna existente `recomendacao` (STRING(60)) e usa o índice único
// `(user_id, recomendacao)` — SEM coluna nova e SEM migração.
//
// Este ficheiro é PURO na parte que decide (sem base de dados, sem rede). As
// únicas funções que falam com o modelo são `carregarDispensas`/
// `registarDispensa` — tal como no motor do portal, cuja mecânica de janela de
// dispensa é REUTILIZADA de propósito, para haver uma só implementação.
// ─────────────────────────────────────────────────────────────────────
const { RecomendacaoEstado } = require('../models');
const {
  DIAS_REAPRESENTACAO_PADRAO,
  estaDispensada,
  proximaApresentacao,
} = require('./recomendacoes');

// Registo da ADMINISTRAÇÃO (armazenamento e backups). Vive num ficheiro próprio
// por ser outro domínio, mas entra no MESMO registo deste motor — não há um
// segundo motor, uma segunda prioridade nem uma segunda tabela de dispensa.
const registoAdministracao = require('./tips/registo-administracao');

// Quantos tips se apresentam ao mesmo tempo. Ao contrário dos sinais (uma lista
// que o utilizador varre), um tip é orientação: dois ou três bastam para não
// transformar o painel num manual. O resto fica elegível e aparece à medida que
// os primeiros forem resolvidos ou dispensados.
const LIMITE_APRESENTACAO = 3;

// Tipos (o rótulo é o que a interface mostra).
//   · `risco`      → algo que está a correr mal no CONTEÚDO do condomínio
//                    (ex.: a permilagem não fecha 1000‰);
//   · `aviso`      → algo que está a correr mal na OPERAÇÃO (ex.: o backup
//                    falhou). Distinto de `risco` de propósito: o rótulo de
//                    `risco` fala de cálculo e seria falso para um backup.
const TIPOS = {
  risco: 'Atenção ao cálculo',
  aviso: 'Atenção',
  conclusao: 'Por completar',
  compreensao: 'Vale a pena saber',
  descoberta: 'Funcionalidade pouco óbvia',
};

// Prioridade: número maior = apresentado primeiro. Empate resolvido pela ordem
// do registo (apresentação determinística). Uma definição pode sobrepor esta
// prioridade com `prioridade` própria (ver `prioridadeDe`) quando o tipo não
// chega para a ordenar.
const PRIORIDADE = {
  risco: 100,
  aviso: 90,
  conclusao: 80,
  compreensao: 50,
  descoberta: 30,
};

// Papéis (espelha `helpers/tenant.js: PAPEIS`) — usado para não mostrar a um
// gestor um tip cujo destino exige `admin` (levaria a um 302).
const PAPEIS = { admin: 30, gestor: 20, leitura: 10 };
function papelSuficiente(papel, minimo) {
  return (PAPEIS[papel] || 0) >= (PAPEIS[minimo] || 99);
}

// ── Âmbito, áreas e prioridade própria ──────────────────────────────
// `ambito` — a que se refere o tip:
//   · 'condominio'  → ao condomínio ativo (frações, contas, atas);
//   · 'instalacao'  → à instalação inteira (backups, armazenamento).
// O motor só filtra por âmbito quando a página o pede (`ctx.ambito`, um âmbito
// ou uma lista). Sem pedido, não se filtra — é o comportamento anterior a esta
// generalização, para não mudar o que as páginas já apresentam.
const AMBITOS = { condominio: 'condominio', instalacao: 'instalacao' };

function ambitoDe(definicao) {
  const a = definicao && definicao.ambito;
  return AMBITOS[a] ? a : AMBITOS.condominio;
}

function aceitaAmbito(definicao, pedido) {
  if (pedido === undefined || pedido === null) return true;
  const ambito = ambitoDe(definicao);
  if (Array.isArray(pedido)) {
    const lista = pedido.filter((a) => AMBITOS[a]);
    return lista.length ? lista.includes(ambito) : true;
  }
  return AMBITOS[pedido] ? ambito === pedido : true;
}

// `areas` — em que PÁGINAS o tip pode aparecer. Só se filtra quando a página
// indica `ctx.area`; um tip sem `areas` (ou com a área na lista) passa. É isto
// que impede o mesmo tip de aparecer em todo o backoffice.
function aceitaArea(definicao, area) {
  if (!area) return true;
  if (!Array.isArray(definicao.areas)) return true;
  return definicao.areas.includes(area);
}

// Prioridade efetiva: a própria, quando declarada; senão a do tipo.
function prioridadeDe(definicao) {
  const propria = Number(definicao && definicao.prioridade);
  if (Number.isFinite(propria)) return propria;
  return PRIORIDADE[definicao && definicao.tipo] || 0;
}

// ── Registo de tips ─────────────────────────────────────────────────
// `condicao(ctx)` é a elegibilidade: devolve `{ mensagem }` quando o tip deve
// aparecer, ou null quando a situação não existe.
// `publico` é o papel MÍNIMO para o ver (o destino tem de ser alcançável).
// `acao` é fixa. `dismissivel` decide se se pode dispensar.
//
// Nenhuma condição afirma algo que o código não confirme: cada mensagem foi
// escrita a partir do comportamento real dos ajudantes que lhe dão origem
// (ver `docs/TIPS-CONTEXTUAIS.md`, onde cada tip cita a sua prova).
const REGISTO = [
  // ── Estrutura e frações ───────────────────────────────────────────
  {
    id: 'fracoes_por_definir',
    area: 'estrutura',
    tipo: 'conclusao',
    publico: 'gestor',
    dismissivel: true,
    titulo: 'O condomínio ainda não tem frações',
    acao: { texto: 'Criar frações', url: '/admin/fracoes' },
    condicao(ctx) {
      const f = ctx && ctx.fracoes;
      if (!f || Number(f.n) !== 0) return null;
      return {
        mensagem: 'As frações são a base das quotas, das despesas e dos titulares. '
          + 'Enquanto não existirem, não há permilagem para distribuir nem condóminos a associar.',
      };
    },
  },

  {
    id: 'permilagem_incompleta',
    area: 'estrutura',
    tipo: 'risco',
    publico: 'gestor',
    dismissivel: true,
    titulo: 'A permilagem das frações não soma 1000‰',
    acao: { texto: 'Rever frações', url: '/admin/fracoes' },
    condicao(ctx) {
      const f = ctx && ctx.fracoes;
      if (!f || Number(f.n) <= 0 || f.permilagemOk) return null;
      const total = Number(f.permilagemTotal) || 0;
      return {
        mensagem: `A soma das permilagens é ${total}‰, quando o total do condomínio é 1000‰. `
          + 'As quotas e as despesas são distribuídas por esta proporção: se a soma não fechar, '
          + 'os valores de cada fração não correspondem ao total do condomínio.',
      };
    },
  },

  {
    id: 'fracoes_sem_titular',
    area: 'estrutura',
    tipo: 'conclusao',
    publico: 'gestor',
    dismissivel: true,
    titulo: 'Há frações sem titular associado',
    acao: { texto: 'Ver frações', url: '/admin/fracoes' },
    condicao(ctx) {
      const f = ctx && ctx.fracoes;
      if (!f || Number(f.n) <= 0) return null;
      const sem = Number(f.semTitular) || 0;
      if (sem <= 0) return null;
      return {
        mensagem: `${sem} fração(ões) sem proprietário nem arrendatário associado. `
          + 'Os avisos, as quotas e os contactos dessas frações não têm destinatário.',
      };
    },
  },

  // ── Financeiro ────────────────────────────────────────────────────
  {
    id: 'contas_por_definir',
    area: 'financeiro',
    tipo: 'conclusao',
    publico: 'gestor',
    dismissivel: true,
    titulo: 'Ainda não há contas bancárias registadas',
    acao: { texto: 'Criar conta', url: '/admin/contas/nova' },
    condicao(ctx) {
      const c = ctx && ctx.contas;
      if (!c || Number(c.n) !== 0) return null;
      return {
        mensagem: 'Os pagamentos, as despesas e o extrato ligam-se a movimentos de uma conta. '
          + 'Sem uma conta registada, não há saldo nem conciliação a acompanhar.',
      };
    },
  },

  {
    id: 'conta_fundo_reserva_em_falta',
    area: 'financeiro',
    tipo: 'conclusao',
    publico: 'gestor',
    dismissivel: true,
    titulo: 'Falta a conta do Fundo Comum de Reserva',
    acao: { texto: 'Gerir contas', url: '/admin/contas' },
    condicao(ctx) {
      const c = ctx && ctx.contas;
      // Sem contas nenhumas, o tip anterior já o diz — não se repetem avisos.
      if (!c || Number(c.n) <= 0) return null;
      if (Number(c.fundoReserva) > 0) return null;
      return {
        mensagem: 'As quotas incluem Fundo Comum de Reserva, mas não existe nenhuma conta desse tipo. '
          + 'Sem ela, o valor do fundo fica misturado com a conta corrente e não pode ser '
          + 'transferido nem acompanhado à parte.',
      };
    },
  },

  // ── Assembleias ───────────────────────────────────────────────────
  {
    id: 'assembleias_sem_ata',
    area: 'assembleias',
    tipo: 'conclusao',
    publico: 'gestor',
    dismissivel: true,
    titulo: 'Há assembleias realizadas sem ata',
    acao: { texto: 'Ver assembleias', url: '/admin/assembleias' },
    condicao(ctx) {
      const a = ctx && ctx.assembleias;
      if (!a) return null;
      const n = Number(a.realizadasSemAta) || 0;
      if (n <= 0) return null;
      return {
        mensagem: `${n} assembleia(s) marcadas como realizadas ainda não têm ata registada. `
          + 'A ata é o registo do que foi deliberado — e é dela que constam os valores aprovados.',
      };
    },
  },

  // ── Armazenamento e backups ───────────────────────────────────────
  {
    id: 'backup_sem_copia_externa',
    area: 'armazenamento',
    tipo: 'compreensao',
    // O destino dos backups configura-se em Configuração → Armazenamento, que
    // exige `admin`: mostrar isto a um gestor seria um beco sem saída.
    publico: 'admin',
    dismissivel: true,
    titulo: 'Os backups estão só neste servidor',
    acao: { texto: 'Escolher destino', url: '/admin/config/armazenamento' },
    condicao(ctx) {
      const b = ctx && ctx.backup;
      // Só faz sentido recomendar quando a ação é sequer possível: sem nenhuma
      // ligação de armazenamento, a página já explica como ligar um serviço.
      if (!b || b.temLigacoes !== true) return null;
      if (b.destino) return null;
      // Quando se sabe QUE serviços estão ligados, diz-se — é a diferença entre
      // «ligue um serviço» e «já tem um que pode servir». Sem essa informação a
      // mensagem fica genérica: nunca se inventa o nome de um serviço.
      const ligados = registoAdministracao.provedoresLigados(ctx);
      if (ligados.length) {
        return {
          mensagem: 'As cópias de segurança ficam apenas neste servidor, apesar de já ter '
            + `${ligados.map(registoAdministracao.rotuloDe).join(' e ')} ligado — pode usá-lo `
            + 'como segunda cópia, fora do servidor, sem autorizar outra conta. A cópia local '
            + 'continua a ser feita em qualquer caso.',
        };
      }
      return {
        mensagem: 'As cópias de segurança ficam apenas neste servidor. Uma cópia no serviço de '
          + 'armazenamento protege contra a perda do servidor — a cópia local continua a ser '
          + 'feita em qualquer caso.',
      };
    },
  },
];

// ── Registo da administração (armazenamento e backups) ──────────────
// Acrescentado ao MESMO registo: uma prioridade, uma tabela de dispensa, uma
// apresentação. A filtragem por `areas` garante que nenhum destes aparece numa
// página que não seja a de armazenamento, e o `publico: 'admin'` que nenhum
// chega a um gestor (o destino exige admin).
for (const definicao of registoAdministracao.REGISTO) {
  REGISTO.push(definicao);
}

// ── Chave de dispensa (com âmbito) ──────────────────────────────────
// A coluna `recomendacao` é STRING(60): `tip:` + id (≤ 40) + `@c` + id do
// condomínio cabe sempre.
function chaveDeDispensa(tipId, condominioId) {
  const id = String(tipId == null ? '' : tipId);
  const c = Number(condominioId);
  if (!id || !Number.isInteger(c) || c <= 0) return null;
  const chave = `tip:${id}@c${c}`;
  return chave.length <= 60 ? chave : null;
}

// ── Partes puras ────────────────────────────────────────────────────
function instante(valor) {
  if (!valor) return 0;
  if (valor instanceof Date) return valor.getTime();
  const t = new Date(valor).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Definições que o sistema conhece (validação de identificadores e testes).
function definicoes() {
  return REGISTO.map((d) => ({
    id: d.id,
    area: d.area,
    areas: Array.isArray(d.areas) ? [...d.areas] : null,
    ambito: ambitoDe(d),
    tipo: d.tipo,
    publico: d.publico,
    dismissivel: Boolean(d.dismissivel),
    prioridade: prioridadeDe(d),
  }));
}

function porId(id) {
  const chave = String(id == null ? '' : id);
  return REGISTO.find((d) => d.id === chave) || null;
}

function podeDispensar(id) {
  const definicao = porId(id);
  return Boolean(definicao && definicao.dismissivel);
}

// Que tips estão elegíveis AGORA?
// `dispensas`: mapa { chave: registo } com o estado persistido. Nada mais é
// consultado. Sem condomínio válido não há tips (o âmbito é por condomínio).
function elegiveis(ctx = {}, dispensas = {}) {
  const condominioId = Number(ctx.condominioId);
  if (!Number.isInteger(condominioId) || condominioId <= 0) return [];

  const agora = instante(ctx.agora) || Date.now();
  const area = ctx.area ? String(ctx.area) : null;
  const saida = [];

  for (const definicao of REGISTO) {
    // Âmbito: a página pode pedir só os tips de condomínio ou só os da
    // instalação. Sem pedido, não se filtra (comportamento anterior).
    if (!aceitaAmbito(definicao, ctx.ambito)) continue;
    // Área: um tip que declara `areas` só aparece nas suas páginas.
    if (!aceitaArea(definicao, area)) continue;
    // Público: um tip cujo destino exige um papel que o utilizador não tem não
    // é apresentado (evita links que resultariam num 302).
    if (!papelSuficiente(ctx.papel, definicao.publico)) continue;

    const dados = definicao.condicao(ctx);
    if (!dados) continue; // a situação não existe: o estado real venceu

    const chave = chaveDeDispensa(definicao.id, condominioId);
    const registo = chave && dispensas ? dispensas[chave] : null;
    if (definicao.dismissivel && estaDispensada(registo, agora)) continue;

    saida.push({
      id: definicao.id,
      area: definicao.area,
      tipo: definicao.tipo,
      rotulo: TIPOS[definicao.tipo] || 'Sugestão',
      publico: definicao.publico,
      titulo: definicao.titulo,
      mensagem: dados.mensagem,
      icone: definicao.icone || 'lightbulb',
      acao: { texto: definicao.acao.texto, url: definicao.acao.url },
      dismissivel: Boolean(definicao.dismissivel),
      prioridade: prioridadeDe(definicao),
      // Onde o tip está registado (diagnóstico/testes), nunca o destino.
      origem: chave || null,
    });
  }

  const ordem = new Map(REGISTO.map((d, i) => [d.id, i]));
  return saida.sort(
    (a, b) => (b.prioridade - a.prioridade) || ((ordem.get(a.id) || 0) - (ordem.get(b.id) || 0))
  );
}

// A decisão da apresentação: no máximo `limite` tips.
function escolher(ctx = {}, dispensas = {}, limite = LIMITE_APRESENTACAO) {
  const lista = elegiveis(ctx, dispensas);
  const n = Number.isInteger(limite) && limite >= 0 ? limite : LIMITE_APRESENTACAO;
  return {
    apresentar: lista.slice(0, n),
    total: lista.length,
    // As restantes ficam identificadas (diagnóstico/testes) mas não se
    // apresentam agora: aparecem quando as primeiras forem resolvidas.
    outras: lista.slice(n),
    limite: n,
  };
}

// ── Persistência da dispensa (única parte com base de dados) ────────
// Reutiliza `recomendacao_estados`: é a mesma decisão (que sugestão é que esta
// conta já dispensou e até quando), e a chave com âmbito (`tip:…@c<id>`)
// mantém-na separada das recomendações do portal, que o motor do portal
// continua a validar contra o seu próprio registo.
async function carregarDispensas(userId) {
  if (!userId) return {};
  const linhas = await RecomendacaoEstado.findAll({ where: { user_id: userId }, raw: true });
  const mapa = {};
  for (const linha of linhas) mapa[linha.recomendacao] = linha;
  return mapa;
}

async function registarDispensa({ userId, tip, condominioId, dias = DIAS_REAPRESENTACAO_PADRAO, agora = Date.now() }) {
  const chave = chaveDeDispensa(tip, condominioId);
  if (!userId || !chave || !podeDispensar(tip)) return { ok: false, motivo: 'tip_invalido' };

  const base = instante(agora) || Date.now();
  const em = new Date(base);
  const ate = new Date(proximaApresentacao(dias, base));
  const intervalo = Number(dias) > 0 ? Number(dias) : DIAS_REAPRESENTACAO_PADRAO;

  const existente = await RecomendacaoEstado.findOne({ where: { user_id: userId, recomendacao: chave } });
  if (existente) {
    await existente.update({ dispensada_em: em, dispensada_ate: ate, intervalo_dias: intervalo });
    return { ok: true, criada: false, chave };
  }
  await RecomendacaoEstado.create({
    user_id: userId,
    recomendacao: chave,
    dispensada_em: em,
    dispensada_ate: ate,
    intervalo_dias: intervalo,
  });
  return { ok: true, criada: true, chave };
}

module.exports = {
  LIMITE_APRESENTACAO,
  DIAS_REAPRESENTACAO_PADRAO,
  TIPOS,
  PRIORIDADE,
  PAPEIS,
  AMBITOS,
  AREAS: registoAdministracao.AREAS,
  REGISTO,
  definicoes,
  porId,
  podeDispensar,
  papelSuficiente,
  ambitoDe,
  aceitaAmbito,
  aceitaArea,
  prioridadeDe,
  chaveDeDispensa,
  elegiveis,
  escolher,
  carregarDispensas,
  registarDispensa,
};
