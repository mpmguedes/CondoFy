// ─────────────────────────────────────────────────────────────────────
// Conteúdo e dados das páginas públicas de produto (homepage e pedido de
// acesso).
//
// Porque existe: a homepage precisa dos mesmos dados em dois sítios — no HTML
// (texto visível) e no JSON-LD (dados estruturados para os motores de busca) —
// e as duas páginas partilham o cabeçalho, o rodapé e a folha de estilos. Ter
// uma única fonte evita que o que é mostrado e o que é declarado divirjam.
//
// Regras de conteúdo (seguidas à letra):
//  · nada de preços, testemunhos, números de clientes ou estatísticas;
//  · só funcionalidades que existem hoje na aplicação;
//  · o acesso é por convite e isso é dito de forma explícita;
//  · qualquer afirmação sobre segurança é verificável no próprio sistema.
//
// A identificação de contacto para pedidos de acesso vem do ambiente
// (ACESSO_EMAIL; se não existir, usa LEGAL_EMAIL). Sem configuração, a página
// di-lo claramente em vez de inventar um endereço.
// ─────────────────────────────────────────────────────────────────────

const RECURSO_CSS = '/css/home.css?v=20260910b';
const RECURSO_JS = '/js/home.js?v=20260910b';

const TITULO_HOME = 'GesCondu — Gestão de condomínios simples, organizada e transparente';
const DESCRICAO_HOME =
  'O GesCondu centraliza a gestão do condomínio: quotas, contas, documentos, assembleias, comunicações e muito mais numa única plataforma.';
const DESCRICAO_ACESSO =
  'O acesso ao GesCondu está disponível por convite. Veja como pedir acesso à plataforma de gestão de condomínios.';

// ── Perguntas frequentes (texto visível + JSON-LD) ──────────────────
const FAQ = [
  {
    pergunta: 'O GesCondu substitui o administrador do condomínio?',
    resposta: [
      'Não. O GesCondu é uma plataforma de apoio à administração de condomínios: organiza quotas, despesas, documentos, assembleias e comunicação, mas não presta serviços de contabilidade, de advocacia nem substitui quem administra.',
    ],
  },
  {
    pergunta: 'Quem pode utilizar o GesCondu?',
    resposta: [
      'Quem administra o condomínio — incluindo quando são os próprios condóminos a assumir essa tarefa —, empresas que gerem vários condomínios e os condóminos, que têm um portal próprio com a informação da sua fração.',
    ],
  },
  {
    pergunta: 'Preciso de instalar alguma coisa?',
    resposta: [
      'Não. O GesCondu funciona no navegador, num computador ou num telemóvel. Não é preciso instalar programas nem manter servidores: cada pessoa entra com a sua conta de utilizador.',
    ],
  },
  {
    pergunta: 'Os condóminos têm acesso à plataforma?',
    resposta: [
      'Sim, por convite do administrador do condomínio. Cada condómino entra com a sua conta e consulta a situação da sua fração, os recibos, os documentos do condomínio, as assembleias e os avisos.',
    ],
  },
  {
    pergunta: 'Posso consultar quotas e recibos?',
    resposta: [
      'Sim. Quem administra acompanha as quotas lançadas, recebidas e em atraso, por fração e por período. O condómino consulta a situação da sua fração, os pagamentos registados e os recibos em PDF.',
    ],
  },
  {
    pergunta: 'Posso gerir mais do que um condomínio?',
    resposta: [
      'Sim. A mesma conta pode ter acesso a vários condomínios, com permissões definidas para cada um. Os dados, as contas e os documentos de cada condomínio ficam separados dos restantes.',
    ],
  },
  {
    pergunta: 'Os documentos ficam organizados na plataforma?',
    resposta: [
      'Sim. Recibos, comprovativos, faturas, convocatórias, atas e apólices ficam na biblioteca de documentos do condomínio, organizados por área e por ano. Quando o armazenamento externo está configurado, os documentos são guardados na conta do próprio condomínio (Google Drive, Dropbox ou OneDrive).',
    ],
  },
  {
    pergunta: 'Existe aplicação para telemóvel?',
    resposta: [
      'Não existe aplicação para instalar. A plataforma funciona no navegador do telemóvel e o portal do condómino foi desenhado para ecrãs pequenos — para consultar quotas, recibos, documentos e avisos onde for mais prático.',
    ],
  },
  {
    pergunta: 'Como posso obter acesso?',
    resposta: [
      'Neste momento, o acesso ao GesCondu está disponível por convite. Se administra um condomínio e quer conhecer a plataforma, peça acesso: indicamos o que é necessário e, estando tudo em ordem, enviamos o convite para criar a conta.',
      'Se já recebeu um convite, a ligação enviada por email permite definir a palavra-passe e entrar.',
    ],
    ligacao: { href: '/pedir-acesso', texto: 'Pedir acesso ao GesCondu' },
  },
];

// ── Contexto comum às páginas públicas de produto ───────────────────
function urlBase(req) {
  const host = String((req && req.get && req.get('host')) || '').trim();
  if (!host) return null;
  const protocolo = (req && req.protocol) || 'https';
  return `${protocolo}://${host}`;
}

// Endereço para pedidos de acesso (configurável; nunca inventado).
function emailAcesso() {
  const escolhido = String(process.env.ACESSO_EMAIL || '').trim();
  if (escolhido) return escolhido;
  const legal = String(process.env.LEGAL_EMAIL || '').trim();
  return legal || null;
}

// Correio pré-preenchido: poupa uma ida e volta a quem pede acesso.
function linkPedidoAcesso(email) {
  if (!email) return null;
  const assunto = 'Pedido de acesso ao GesCondu';
  const corpo = [
    'Olá,',
    '',
    'Gostaria de pedir acesso ao GesCondu.',
    '',
    'Nome: ',
    'Condomínio (designação e localidade): ',
    'Número de frações: ',
    'Função (administrador do condomínio / empresa de administração / condómino): ',
    '',
    'Obrigado.',
  ].join('\n');
  return `mailto:${email}?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;
}

function recursosHtml() {
  return `<link rel="stylesheet" href="${RECURSO_CSS}" />`;
}

function scriptHtml() {
  return `<script src="${RECURSO_JS}" defer></script>`;
}

// Dados estruturados: apenas o que é verdadeiro e verificável.
// Sem preços (offers), sem avaliações (aggregateRating/review) e sem números
// de utilizadores — nada disso existe na página nem seria honesto declará-lo.
function dadosEstruturados({ base, descricao, comFaq }) {
  const grafo = [
    {
      '@type': 'WebSite',
      '@id': `${base || ''}/#site`,
      name: 'GesCondu',
      url: `${base || ''}/`,
      inLanguage: 'pt-PT',
      description: descricao,
    },
    {
      '@type': 'SoftwareApplication',
      name: 'GesCondu',
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Gestão de condomínios',
      operatingSystem: 'Web',
      inLanguage: 'pt-PT',
      url: `${base || ''}/`,
      description:
        'Plataforma portuguesa de gestão de condomínios: quotas, orçamento, despesas, contas bancárias, documentos, assembleias, comunicações e relatórios financeiros.',
    },
  ];
  if (comFaq) {
    grafo.push({
      '@type': 'FAQPage',
      mainEntity: FAQ.map((item) => ({
        '@type': 'Question',
        name: item.pergunta,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.resposta.join(' '),
        },
      })),
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': grafo });
}

// Locals da homepage pública.
function dadosHome(req) {
  const base = urlBase(req);
  return {
    tituloCompleto: TITULO_HOME,
    descricao: DESCRICAO_HOME,
    urlCanonica: base ? `${base}/` : null,
    ogTitulo: TITULO_HOME,
    ogTipo: 'website',
    ogSite: 'GesCondu',
    ogLocale: 'pt_PT',
    ogImagem: base ? `${base}/img/gescondu-logo-ativo.png` : null,
    temaCor: '#06213F',
    jsonLd: dadosEstruturados({ base, descricao: DESCRICAO_HOME, comFaq: true }),
    headExtra: recursosHtml(),
    scriptsExtra: scriptHtml(),
    corpoClass: 'home-publica',
    faq: FAQ.map((item) => ({ pergunta: item.pergunta, resposta: item.resposta, ligacao: item.ligacao || null })),
  };
}

// Locals da página «Pedir acesso».
function dadosPedidoAcesso(req) {
  const base = urlBase(req);
  const email = emailAcesso();
  return {
    titulo: 'Pedir acesso',
    tituloCompleto: 'Pedir acesso ao GesCondu — acesso por convite',
    descricao: DESCRICAO_ACESSO,
    urlCanonica: base ? `${base}/pedir-acesso` : null,
    ogTitulo: 'Pedir acesso ao GesCondu',
    ogTipo: 'website',
    ogSite: 'GesCondu',
    ogLocale: 'pt_PT',
    temaCor: '#06213F',
    jsonLd: dadosEstruturados({ base, descricao: DESCRICAO_ACESSO, comFaq: false }),
    headExtra: recursosHtml(),
    corpoClass: 'home-publica',
    acessoEmail: email,
    acessoLink: linkPedidoAcesso(email),
  };
}

module.exports = {
  TITULO_HOME,
  DESCRICAO_HOME,
  DESCRICAO_ACESSO,
  FAQ,
  urlBase,
  emailAcesso,
  linkPedidoAcesso,
  dadosHome,
  dadosPedidoAcesso,
};
