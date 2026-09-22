// ─────────────────────────────────────────────────────────────────────
// Tips da administração — armazenamento e backups (registo PURO).
//
// Este ficheiro contém APENAS definições: identificador, domínio (`area`),
// páginas onde pode aparecer (`areas`), âmbito, tipo, prioridade, condição
// (pura) e ação FIXA. Não fala com a base de dados, não lê ficheiros e não
// decide nada sozinho — quem decide é o MOTOR ÚNICO, `helpers/tips.js`, que
// junta este registo ao seu e trata da elegibilidade, da prioridade e da
// dispensa.
//
// ── Como este registo se liga ao motor ─────────────────────────────
// `helpers/tips.js` acrescenta estas entradas ao seu `REGISTO`. Não há um
// segundo motor, uma segunda prioridade nem uma segunda tabela de dispensa: a
// chave de dispensa é a do motor (`tip:<id>@c<id>`) e a tabela é a mesma
// (`recomendacao_estados`, sem coluna nova e sem migração).
//
//  · `area`   → DOMÍNIO do tip (rótulo de diagnóstico; ex.: 'armazenamento').
//  · `areas`  → PÁGINAS onde pode aparecer. O motor só filtra quando a página
//               indica `ctx.area`; um tip com `areas` não aparece noutra página.
//               É isto que impede o mesmo tip de aparecer em todo o backoffice.
//  · `ambito` → 'instalacao' (o facto é da instalação inteira) ou 'condominio'.
//  · `tipo`   → tem de existir em `TIPOS`/`PRIORIDADE` do motor.
//  · `publico`→ papel MÍNIMO. Todos estes exigem `admin`: o destino
//               (`/admin/config/armazenamento`) está atrás de `comPapel('admin')`
//               e mostrar isto a um gestor seria um beco sem saída (302).
//
// ⛔ REGRAS DESTE REGISTO (não negociáveis)
//
// 1. NENHUMA condição pode ser inventada. Cada uma lê um dado que já existe e
//    que é observável no momento do pedido. Dos exemplos pedidos, três NÃO têm
//    condição alcançável e estão documentados em `docs/TIPS-CONTEXTUAIS.md`:
//      · «retenção abaixo do mínimo» — `helpers/backup-retencao.js` faz clamp
//        ao mínimo (30) em TODOS os caminhos (`lerConfiguracao`), pelo que um
//        valor abaixo de 30 não existe;
//      · «backup automático não configurado» — `jobs/scheduler.js` agenda
//        `executarBackup('diario')` incondicionalmente e `jobs/backup.js` não
//        consulta `helpers/automacoes.js`, logo o interruptor
//        `auto_backups_automatico` não governa nada;
//      · «retenção no mínimo» — a única página onde a retenção se ajusta é
//        `/global/armazenamento`, reservada ao Super Admin. O motor de tips
//        conhece papéis de CONDOMÍNIO (`admin`/`gestor`/`leitura`) e não
//        distingue um Super Admin, pelo que o CTA seria um beco sem saída —
//        exatamente o que `publico` existe para evitar. Fica de fora.
//
// 2. ISOLAMENTO ENTRE CONDOMÍNIOS. Nenhuma condição pode revelar dados de outro
//    condomínio. Só se usam:
//      · `ctx.armazenamento.provedores` — ligações DESTE condomínio;
//      · `ctx.armazenamento.plataforma` — ligações da INSTALAÇÃO (a página de
//        armazenamento já as mostra a qualquer admin de condomínio);
//      · `ctx.backup` — estado/destino da INSTALAÇÃO (idem).
//    ⛔ Nunca se escreve o NOME de uma conta nas mensagens, e nunca se usa
//    `ligacoes.ligacaoParaBackup()` para resolver ligações (pode resolver para a
//    ligação de OUTRO condomínio).
//
// 3. Só se afirma o que é verdadeiro para CADA provedor. A criação/reutilização
//    de pastas existe nos TRÊS provedores (`pastaDeBackups` em `google-drive.js`,
//    `dropbox.js` e `onedrive.js`). A remoção de ficheiros NÃO existe na Dropbox
//    (sem `apagarArquivo`) — é dito explicitamente, e só quando esse for o
//    destino configurado.
//
// 4. A ação vem SEMPRE daqui e é interna. Um identificador manipulado não pode
//    originar um destino arbitrário (o motor recusa antes de qualquer escrita).
//
// 5. NÃO DUPLICAÇÃO. Cada situação tem UM tip. Onde dois tips descreveriam a
//    mesma situação, ficou um só — ver a nota junto de cada condição.
// ─────────────────────────────────────────────────────────────────────

// Páginas (chaves de área) onde um tip pode aparecer. O motor filtra por
// `ctx.area`; um tip sem `areas` aparece em qualquer página do seu âmbito.
const AREAS = {
  inicio: 'inicio',
  armazenamento: 'armazenamento',
  documentos: 'documentos',
};

// Provedores com remoção de ficheiros implementada (verificado no código, não
// assumido): `google-drive.js` delega em `helpers/drive.js`; `onedrive.js`
// exporta `apagarArquivo`; `dropbox.js` NÃO tem o método.
const PROVEDORES_COM_REMOCAO = new Set(['google_drive', 'onedrive']);

const ROTULO_PROVEDOR = {
  google_drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
};

// Dias sem backups a partir dos quais se sugere verificar o processo.
const DIAS_DESATUALIZADO = 7;

// A página onde se escolhe o destino e se ligam os serviços. Todos os CTAs
// deste registo apontam para aqui: é o único destino que os torna acionáveis.
const URL_ARMAZENAMENTO = '/admin/config/armazenamento';

function texto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Provedores com ligação UTILIZÁVEL, vistos DESTE condomínio: a ligação da
// instalação (plataforma) ou a ligação do próprio condomínio. NUNCA a de outro
// condomínio.
function provedoresLigados(ctx) {
  const a = (ctx && ctx.armazenamento) || {};
  const nomes = new Set();
  for (const p of Array.isArray(a.provedores) ? a.provedores : []) {
    if (p && (p.ligado || p.ligadoPlataforma)) nomes.add(p.nome);
  }
  for (const p of Array.isArray(a.plataforma) ? a.plataforma : []) {
    if (p && p.ligado) nomes.add(p.nome);
  }
  return [...nomes];
}

function rotuloDe(nome) {
  return ROTULO_PROVEDOR[nome] || texto(nome) || 'o serviço';
}

// O estado do último backup está disponível no contexto?
// (`helpers/backup-estado.js` — nunca se inventa um estado em falta)
function temBackup(ctx) {
  return Boolean(ctx && ctx.backup && typeof ctx.backup === 'object');
}

const REGISTO = [
  // ── 1. O último backup FALHOU por completo ────────────────────────
  // `estado === 'erro'` vem de `backup-estado.interpretar`: não houve cópia
  // local. É o caso mais grave, logo a prioridade mais alta deste registo.
  {
    id: 'backup_ultimo_falhou',
    area: 'armazenamento',
    areas: [AREAS.armazenamento],
    ambito: 'instalacao',
    tipo: 'aviso',
    publico: 'admin',
    prioridade: 95,
    dismissivel: true,
    titulo: 'O último backup falhou',
    icone: 'error',
    condicao(ctx) {
      if (!temBackup(ctx) || ctx.backup.estado !== 'erro') return null;
      return {
        mensagem: 'A cópia de segurança não chegou a ser concluída — o servidor ficou sem '
          + 'uma cópia local recente. Verifique o espaço em disco e volte a executar o backup.',
      };
    },
    acao: { texto: 'Ver backups', url: URL_ARMAZENAMENTO },
  },

  // ── 2. Sem backups recentes ───────────────────────────────────────
  // Substitui o exemplo «backup automático não configurado», que não tem
  // condição verdadeira (ver a nota no topo). ⛔ NÃO DUPLICAÇÃO: quando o último
  // backup falhou, quem fala é o tip nº 1 ou o nº 4 — este cala-se para não
  // haver dois avisos sobre o mesmo backup.
  {
    id: 'backup_desatualizado',
    area: 'armazenamento',
    areas: [AREAS.armazenamento],
    ambito: 'instalacao',
    tipo: 'aviso',
    publico: 'admin',
    prioridade: 88,
    dismissivel: true,
    titulo: 'Sem backups recentes',
    icone: 'schedule',
    condicao(ctx) {
      if (!temBackup(ctx)) return null;
      const estado = ctx.backup.estado;
      if (estado === 'em_curso') return null; // está a acontecer agora: nada a recomendar
      if (estado === 'erro' || estado === 'local_copia_cloud_falhada') return null; // já têm tip próprio
      if (estado === 'sem_historico') {
        return {
          mensagem: 'Ainda não existe nenhum backup registado nesta instalação. A cópia local é '
            + 'obrigatória e é a que permite recuperar o sistema.',
        };
      }
      const dias = Number(ctx.backup.diasDesde);
      if (!Number.isFinite(dias) || dias <= DIAS_DESATUALIZADO) return null;
      return {
        mensagem: `O último backup registado tem ${dias} dias. A cópia local é feita `
          + 'automaticamente todos os dias — um intervalo deste tamanho costuma significar '
          + 'que o processo deixou de correr.',
      };
    },
    acao: { texto: 'Ver backups', url: URL_ARMAZENAMENTO },
  },

  // ── 3. Destino configurado mas sem ligação utilizável ─────────────
  // `usavel === false` é EXPLÍCITO de propósito: um contexto que não traga o
  // campo não faz aparecer um aviso falso (nunca se inventa a situação).
  {
    id: 'backup_destino_sem_ligacao',
    area: 'armazenamento',
    areas: [AREAS.armazenamento],
    ambito: 'instalacao',
    tipo: 'aviso',
    publico: 'admin',
    prioridade: 85,
    dismissivel: true,
    titulo: 'O destino dos backups não tem ligação ativa',
    icone: 'link_off',
    condicao(ctx) {
      if (!temBackup(ctx) || !ctx.backup.destino) return null;
      if (ctx.backup.usavel !== false) return null;
      return {
        mensagem: `Está escolhido ${rotuloDe(ctx.backup.destino)} como destino das cópias de `
          + 'segurança, mas não existe nenhuma autorização utilizável para esse serviço — '
          + 'os backups estão a ficar apenas neste servidor.',
      };
    },
    acao: { texto: 'Ligar conta', url: URL_ARMAZENAMENTO },
  },

  // ── 4. A cópia na cloud do último backup não foi criada ───────────
  // `local_copia_cloud_falhada`: a cópia local existe, a segunda não. A mensagem
  // tranquiliza primeiro (os dados estão salvos) e só depois aponta o que falta.
  {
    id: 'backup_cloud_nao_criada',
    area: 'armazenamento',
    areas: [AREAS.armazenamento],
    ambito: 'instalacao',
    tipo: 'aviso',
    publico: 'admin',
    prioridade: 80,
    dismissivel: true,
    titulo: 'A cópia na cloud do último backup não foi criada',
    icone: 'cloud_off',
    condicao(ctx) {
      if (!temBackup(ctx) || ctx.backup.estado !== 'local_copia_cloud_falhada') return null;
      return {
        mensagem: 'O backup local foi concluído — os dados estão salvos neste servidor — mas a '
          + 'segunda cópia, no serviço externo, não chegou a ser feita. Confirme a autorização '
          + 'do serviço escolhido para os backups.',
      };
    },
    acao: { texto: 'Ver backups', url: URL_ARMAZENAMENTO },
  },

  // ── 5. Há um serviço ligado que podia receber os backups ──────────
  // ⛔ NÃO DUPLICAÇÃO: só quando JÁ HÁ destino escolhido (sem destino, quem fala
  // é `backup_sem_copia_externa`, no registo do motor). São mutuamente
  // exclusivos por construção: um exige `destino`, o outro exige a sua ausência.
  {
    id: 'backup_servico_ligado_sem_uso',
    area: 'armazenamento',
    areas: [AREAS.armazenamento],
    ambito: 'instalacao',
    tipo: 'descoberta',
    publico: 'admin',
    prioridade: 60,
    dismissivel: true,
    titulo: 'Há um serviço ligado que pode receber os backups',
    icone: 'cloud_sync',
    condicao(ctx) {
      if (!temBackup(ctx) || !ctx.backup.destino) return null;
      const destino = ctx.backup.destino;
      const alternativos = provedoresLigados(ctx).filter((n) => n !== destino);
      if (!alternativos.length) return null;
      return {
        mensagem: `Além de ${rotuloDe(destino)}, também tem ${alternativos.map(rotuloDe).join(' e ')} `
          + 'ligado. Qualquer serviço ligado pode receber as cópias de segurança — escolha o que '
          + 'preferir; a cópia local no servidor mantém-se sempre.',
      };
    },
    acao: { texto: 'Mudar destino', url: URL_ARMAZENAMENTO },
  },

  // ── 6. Documentos e backups são coisas diferentes ─────────────────
  // A condição é a PRÓPRIA presença na página de armazenamento: é lá que a
  // confusão entre as duas secções acontece, e em nenhum outro sítio se explica
  // isto. Fora da área, não aparece.
  {
    id: 'armazenamento_documentos_e_backups',
    area: 'armazenamento',
    areas: [AREAS.armazenamento],
    ambito: 'instalacao',
    tipo: 'compreensao',
    publico: 'admin',
    prioridade: 25,
    dismissivel: true,
    dias: 90,
    titulo: 'Documentos e backups são coisas diferentes',
    icone: 'help',
    condicao(ctx) {
      if (!ctx || ctx.area !== AREAS.armazenamento) return null;
      return {
        mensagem: 'Os documentos do condomínio ficam num serviço escolhido por si (e cada '
          + 'condomínio pode ter o seu). As cópias de segurança são da instalação inteira e '
          + 'podem ir para um serviço diferente — mudar um não muda o outro.',
      };
    },
    acao: { texto: 'Ver as duas secções', url: URL_ARMAZENAMENTO },
  },

  // ── 7. Estrutura de pastas: o que o GesCondu faz, por provedor ────
  // Só se afirma o que é verdade para os provedores LIGADOS. A limitação da
  // Dropbox (não permite remover ficheiros) só é dita quando é o caso.
  {
    id: 'armazenamento_estrutura_por_provedor',
    area: 'armazenamento',
    areas: [AREAS.armazenamento],
    ambito: 'instalacao',
    tipo: 'descoberta',
    publico: 'admin',
    prioridade: 22,
    dismissivel: true,
    dias: 90,
    titulo: 'As pastas são criadas automaticamente',
    icone: 'folder_managed',
    condicao(ctx) {
      const ligados = provedoresLigados(ctx);
      if (!ligados.length) return null;
      const destino = temBackup(ctx) ? ctx.backup.destino : null;
      const nomes = ligados.map(rotuloDe).join(' e ');
      let mensagem = `Nos serviços suportados — ${nomes} — o GesCondu cria as pastas de que `
        + 'precisa e reutiliza as que já existem: não é preciso preparar nada à mão nem há '
        + 'pastas duplicadas.';
      if (destino && !PROVEDORES_COM_REMOCAO.has(destino)) {
        mensagem += ` Nota: ${rotuloDe(destino)} está escolhido para os backups, mas a limpeza `
          + 'automática não consegue remover ficheiros nesse serviço — as cópias antigas vão '
          + 'acumulando-se lá.';
      }
      return { mensagem };
    },
    acao: { texto: 'Ver pastas', url: URL_ARMAZENAMENTO },
  },
];

module.exports = {
  AREAS,
  REGISTO,
  PROVEDORES_COM_REMOCAO,
  DIAS_DESATUALIZADO,
  URL_ARMAZENAMENTO,
  provedoresLigados,
  rotuloDe,
};
