// ─────────────────────────────────────────────────────────────────────
// Páginas legais PÚBLICAS: Política de Privacidade e Termos de Utilização.
//
//  · GET /politica-privacidade
//  · GET /termos
//
// São públicas por natureza: NÃO exigem sessão, condomínio ativo nem qualquer
// permissão (obrigatório para as indicar na Google Auth Platform → Branding).
// Não usam `tenant`/`eAdmin` e não dependem de dados de negócio.
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

const router = express.Router();

const VERSAO = '1.0';
const ATUALIZADO = '2026-09-10';

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

// Política de Privacidade (pública).
router.get('/politica-privacidade', (req, res) => {
  res.render('publicas/politica-privacidade', {
    layout: 'blank',
    titulo: 'Política de Privacidade',
    legal: dadosLegais(req),
  });
});

// Termos de Utilização (pública).
router.get('/termos', (req, res) => {
  res.render('publicas/termos', {
    layout: 'blank',
    titulo: 'Termos de Utilização',
    legal: dadosLegais(req),
  });
});

module.exports = router;
module.exports.dadosLegais = dadosLegais;
module.exports.VERSAO = VERSAO;
module.exports.ATUALIZADO = ATUALIZADO;
