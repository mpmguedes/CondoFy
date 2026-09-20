// ─────────────────────────────────────────────────────────────────────
// Páginas legais PÚBLICAS: Política de Privacidade e Termos de Utilização.
//
//  · GET /politica-privacidade
//  · GET /termos
//
// São públicas por natureza: NÃO exigem sessão, condomínio ativo nem qualquer
// permissão (obrigatório para as indicar na Google Auth Platform → Branding).
// Não usam `tenant` nem guardas de sessão e não dependem de dados de negócio.
//
// Utilizam o layout público já existente (`blank`, o mesmo das páginas de
// entrada e de seleção de condomínio) e o parcial `_pagina-legal`, que dá a
// casca (cabeçalho, cartão de leitura e rodapé) com os estilos da aplicação.
//
// ── Identificação do responsável pelo tratamento ────────────────────
// Nada é inventado: a identificação e o contacto vêm do ambiente. Variáveis
// (todas opcionais, ver .env.example):
//   LEGAL_ENTIDADE   nome do responsável pelo tratamento
//   LEGAL_NIF        NIF/NIPC
//   LEGAL_MORADA     endereço
//   LEGAL_EMAIL      email de contacto (privacidade e termos)
//   LEGAL_TELEFONE   telefone (opcional)
// Enquanto não estiverem definidas, a página mostra marcadores bem visíveis
// («[CONFIGURAR …]») e uma caixa com os elementos em falta — que desaparece
// automaticamente assim que a configuração existir.
//
// O domínio apresentado é o do próprio pedido (req.get('host')), pelo que as
// páginas são corretas em produção e em desenvolvimento sem configuração extra.
//
// ── Versão dos documentos ───────────────────────────────────────────
// Ao rever o texto, atualizar VERSAO e ATUALIZADO (aparece nas duas páginas).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const homePublica = require('../helpers/home-publica');

const router = express.Router();

const VERSAO = '1.0';
const ATUALIZADO = '2026-09-10';

// Descrição própria de cada página legal, usada na meta description e na
// partilha (Open Graph). São páginas indexáveis como as restantes públicas,
// pelo que têm a mesma informação técnica de SEO da homepage e do pedido de
// acesso, em vez de ficarem sem metadados.
const DESCRICOES = {
  '/politica-privacidade':
    'Política de Privacidade do GesCondu: que dados pessoais são tratados na plataforma de gestão de condomínios, para que finalidades, durante quanto tempo e que direitos podem ser exercidos.',
  '/termos':
    'Termos de Utilização do GesCondu: condições de acesso e utilização da plataforma de gestão de condomínios, responsabilidades de cada parte e direitos do utilizador.',
};

// Elementos que a página legal exige e que só a configuração da instalação pode
// fornecer (nunca preenchidos com dados inventados).
const ELEMENTOS = [
  { chave: 'entidade', variavel: 'LEGAL_ENTIDADE', rotulo: 'Identificação do responsável pelo tratamento (entidade)' },
  { chave: 'nif', variavel: 'LEGAL_NIF', rotulo: 'NIF/NIPC do responsável' },
  { chave: 'morada', variavel: 'LEGAL_MORADA', rotulo: 'Endereço do responsável' },
  { chave: 'email', variavel: 'LEGAL_EMAIL', rotulo: 'Email de contacto' },
];

function valorDoAmbiente(nome) {
  const texto = String(process.env[nome] || '').trim();
  return texto || null;
}

// Dados de identificação/contacto apresentados nas páginas legais.
function dadosLegais(req) {
  const host = String((req && req.get && req.get('host')) || '').trim();
  const protocolo = req && req.protocol ? req.protocol : 'https';
  const legal = {
    entidade: valorDoAmbiente('LEGAL_ENTIDADE'),
    nif: valorDoAmbiente('LEGAL_NIF'),
    morada: valorDoAmbiente('LEGAL_MORADA'),
    email: valorDoAmbiente('LEGAL_EMAIL'),
    telefone: valorDoAmbiente('LEGAL_TELEFONE'),
    dominio: host.replace(/^www\./, '') || null,
    urlBase: host ? `${protocolo}://${host}` : null,
    versao: VERSAO,
    atualizado: ATUALIZADO,
  };
  // Elementos em falta: listados na página (com a variável a definir) e nunca
  // substituídos por informação inventada.
  legal.emFalta = ELEMENTOS.filter((e) => !legal[e.chave]).map((e) => ({
    variavel: e.variavel,
    rotulo: e.rotulo,
    marcador: `[CONFIGURAR ${e.rotulo.toUpperCase()}]`,
  }));
  return legal;
}

// Locals de SEO/partilha das páginas legais. Seguem o mesmo contrato que
// `helpers/home-publica.dadosHome`/`dadosPedidoAcesso` — os campos que o layout
// `blank` já sabe consumir — para que as páginas legais fiquem ao nível das
// restantes páginas públicas (título próprio, descrição, canónica e Open Graph).
function dadosSeoLegais(req, caminho, titulo) {
  const base = homePublica.urlBase(req);
  const descricao = DESCRICOES[caminho];
  return {
    titulo,
    descricao,
    urlCanonica: base ? `${base}${caminho}` : null,
    ogTitulo: `${titulo} · GesCondu`,
    ogTipo: 'website',
    ogSite: 'GesCondu',
    ogLocale: 'pt_PT',
    temaCor: '#06213F',
  };
}

// Política de Privacidade (pública).
router.get('/politica-privacidade', (req, res) => {
  res.render('publicas/politica-privacidade', {
    layout: 'blank',
    ...dadosSeoLegais(req, '/politica-privacidade', 'Política de Privacidade'),
    legal: dadosLegais(req),
  });
});

// Termos de Utilização (pública).
router.get('/termos', (req, res) => {
  res.render('publicas/termos', {
    layout: 'blank',
    ...dadosSeoLegais(req, '/termos', 'Termos de Utilização'),
    legal: dadosLegais(req),
  });
});

// Pedir acesso (pública): o registo não é aberto nesta aplicação — as contas de
// condóminos e de outros membros são criadas por convite. Esta página explica
// como pedir acesso e apresenta o canal de contacto definido no ambiente
// (ACESSO_EMAIL ou, na falta dele, LEGAL_EMAIL). Sem configuração, di-lo de
// forma explícita, em vez de apresentar um endereço inventado.
router.get('/pedir-acesso', (req, res) => {
  res.render('publicas/pedir-acesso', {
    layout: 'blank',
    ...homePublica.dadosPedidoAcesso(req),
  });
});

// ── SEO técnico: /robots.txt e /sitemap.xml ─────────────────────────
// Servidos a partir do domínio do próprio pedido (não há domínio fixo no
// código): funcionam em produção e em ambiente de teste sem configuração.
// Só entram páginas públicas — as áreas autenticadas ficam excluídas.
const PAGINAS_PUBLICAS = ['/', '/pedir-acesso', '/politica-privacidade', '/termos'];
const AREAS_PRIVADAS = ['/admin', '/condomino', '/conta', '/login', '/logout', '/documentos'];

router.get('/robots.txt', (req, res) => {
  const base = homePublica.urlBase(req);
  const linhas = [
    'User-agent: *',
    'Allow: /',
    ...AREAS_PRIVADAS.map((area) => `Disallow: ${area}`),
  ];
  if (base) linhas.push(`Sitemap: ${base}/sitemap.xml`);
  res.type('text/plain').send(`${linhas.join('\n')}\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const base = homePublica.urlBase(req);
  if (!base) {
    return res.status(503).type('text/plain').send('Domínio indisponível.\n');
  }
  const urls = PAGINAS_PUBLICAS.map(
    (caminho) => `  <url><loc>${base}${caminho}</loc></url>`
  ).join('\n');
  res
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

module.exports = router;
module.exports.dadosLegais = dadosLegais;
module.exports.VERSAO = VERSAO;
module.exports.ATUALIZADO = ATUALIZADO;
