// ═══════════════════════════════════════════════════════════════════
// Avisos PROGRAMADOS — disparo automático por `data_programada` (P29).
//
// O que este teste prova, e que nenhuma asserção de HTML poderia provar:
//
//   1. um aviso `programado` com data JÁ ATINGIDA é enfileirado;
//   2. um aviso com data FUTURA não é tocado;
//   3. um aviso já despachado NÃO é reenviado — a tarefa corre todos os dias e
//      a condição `data_programada <= hoje` continua verdadeira, pelo que a
//      idempotência tem de vir da deduplicação, não da consulta;
//   4. `erro` e `cancelado` também contam como despachados (um cancelado não é
//      ressuscitado; um que falhou não entra em ciclo diário);
//   5. o envio MANUAL mantém o critério mais largo (só `pendente/a_enviar/
//      enviado` bloqueiam) — depois de um erro, carregar em «Enviar» reenvia;
//   6. isolamento: só condomínios ATIVOS, e cada aviso é tratado com o
//      `condominio_id` da PRÓPRIA linha (nunca um condomínio assumido);
//   7. a preferência «Avisos → email» desliga o disparo automático;
//   8. o documento em anexo tem de ser do MESMO condomínio (guarda IDOR).
//
// Utilização: node scripts/test-avisos-programados.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

// ── Duplos ─────────────────────────────────────────────────────────
// Instalados ANTES de carregar o motor: `helpers/avisos-envio.js` desestrutura
// `enfileirarEmail` no carregamento, pelo que o duplo tem de lá estar primeiro.
const emailFila = require('../helpers/email-fila');
const enfileirados = [];
emailFila.enfileirarEmail = async (dados) => { enfileirados.push(dados); return { id: enfileirados.length }; };

const drive = require('../helpers/drive');
let driveLigado = false;
drive.isConfigured = () => driveLigado;
drive.descargarArquivo = async () => Buffer.from('pdf');

const condominio = require('../helpers/condominio');
const CONDOMINIOS = {
  1: { id: 1, designacao: 'Condomínio A', administracao_nome: 'Gestão A' },
  2: { id: 2, designacao: 'Condomínio B', administracao_nome: 'Gestão B' },
};
condominio.getCondominio = async ({ id }) => CONDOMINIOS[Number(id)] || null;

const documentosAcesso = require('../helpers/documentos-acesso');
documentosAcesso.urlParaEmail = ({ documento, baseUrl }) => (baseUrl ? `${baseUrl}/documentos/ficheiro/tok${documento.id}` : `/documentos/ficheiro/tok${documento.id}`);

const notificacoes = require('../helpers/notificacoes');
let avisosEmailAtivo = true;
const preferenciasConsultadas = [];
notificacoes.estaAtivo = async (evento, canal) => {
  preferenciasConsultadas.push(`${evento}:${canal}`);
  if (evento === 'avisos' && canal === 'email') return avisosEmailAtivo;
  return true;
};

// Modelos: tabelas em memória. O duplo IMITA a BD — aplica o `where` — para que
// o teste não passe só porque devolveu o que lhe foi pedido.
const models = require('../models');
let AVISOS = [];
let DESTINATARIOS = [];
let FILA = [];
let PESSOAS = [];
let DOCUMENTOS = [];
let CONDOMINIOS_ATIVOS = [];

const ondeIgual = (linha, where) => Object.entries(where || {}).every(([k, v]) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    // Um `where` pode ter VÁRIOS operadores no mesmo campo (`{ [Op.ne]: null,
    // [Op.lte]: hoje }`). Ler só o primeiro símbolo deixaria o `lte` por
    // aplicar e o teste passaria a aceitar avisos futuros.
    return Object.getOwnPropertySymbols(v).every((sym) => {
      const op = sym.toString();
      const alvo = v[sym];
      if (op.includes('ne')) return linha[k] !== null && linha[k] !== undefined && linha[k] !== alvo;
      if (op.includes('lte')) return linha[k] !== null && linha[k] !== undefined && String(linha[k]) <= String(alvo);
      if (op.includes('in')) return alvo.map(Number).includes(Number(linha[k]));
      return true;
    });
  }
  return linha[k] === v;
});

models.Aviso.findAll = async ({ where }) => AVISOS.filter((a) => ondeIgual(a, where));
models.AvisoDestinatario.findAll = async ({ where }) => DESTINATARIOS.filter((d) => ondeIgual(d, where));
models.EmailFila.findAll = async ({ where }) => FILA.filter((f) => {
  if (!ondeIgual(f, { aviso_id: where.aviso_id })) return false;
  const estados = where.estado && where.estado[Object.getOwnPropertySymbols(where.estado)[0]];
  return Array.isArray(estados) ? estados.includes(f.estado) : true;
});
models.Pessoa.findAll = async ({ where }) => PESSOAS.filter((p) => ondeIgual(p, where));
models.Documento.findOne = async ({ where }) => DOCUMENTOS.find((d) => ondeIgual(d, where)) || null;
models.Condominio.findAll = async () => CONDOMINIOS_ATIVOS.map((id) => ({ id }));

const { enviarAvisosProgramados, baseUrlPublica } = require('../jobs/avisos-programados');
const { enfileirarAviso, ESTADOS_EM_CURSO, ESTADOS_DESPACHADOS, linkAbsoluto } = require('../helpers/avisos-envio');

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Dia fixo: 2026-09-22 (data do trabalho).
const HOJE = new Date(2026, 8, 22, 9, 0, 0);

function reiniciar() {
  enfileirados.length = 0;
  preferenciasConsultadas.length = 0;
  AVISOS = [];
  DESTINATARIOS = [];
  FILA = [];
  PESSOAS = [];
  DOCUMENTOS = [];
  CONDOMINIOS_ATIVOS = [1, 2];
  driveLigado = false;
  avisosEmailAtivo = true;
  delete process.env.APP_URL;
}

// Um aviso com dois destinatários com email, num condomínio.
function semearAviso({ id = 1, condominioId = 1, tipo = 'programado', data = '2026-09-20', documentoId = null, pessoas = [[10, 'Ana', 'ana@x.pt'], [11, 'Rui', 'rui@x.pt']] } = {}) {
  AVISOS.push({ id, condominio_id: condominioId, tipo, assunto: `Aviso ${id}`, mensagem: 'Corpo', documento_id: documentoId, data_programada: data });
  for (const [pid, nome, email] of pessoas) {
    DESTINATARIOS.push({ aviso_id: id, pessoa_id: pid, pessoa: { id: pid, nome, email } });
    if (!PESSOAS.some((p) => p.id === pid)) PESSOAS.push({ id: pid, condominio_id: condominioId, email, nome });
  }
}

async function main() {
  // ── 1. Um aviso programado com data atingida é enfileirado ────────
  titulo('disparo de um aviso programado já vencido');
  reiniciar();
  semearAviso({ id: 1, data: '2026-09-20' });
  let r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.avisos, 1, 'o aviso programado vencido é encontrado');
  assert.strictEqual(r.enfileirados, 2, 'os dois destinatários com email são enfileirados');
  assert.strictEqual(enfileirados.length, 2, 'chegaram 2 mensagens à fila');
  assert.strictEqual(enfileirados[0].aviso_id, 1, 'a mensagem fica ligada ao aviso (deduplicação futura)');
  assert.strictEqual(enfileirados[0].condominioId, 1, 'a mensagem leva o condomínio do aviso (remetente correto)');
  assert.strictEqual(enfileirados[0].entidade_tipo, 'Aviso', 'a origem fica registada');
  assert.ok(enfileirados[0].assunto.includes('Aviso 1'), 'o assunto vem do aviso');
  assert.ok(enfileirados[0].corpo_html, 'a mensagem leva versão HTML');
  assert.ok(enfileirados[0].corpo, 'a mensagem leva versão texto');
  feito('aviso programado vencido → enfileirado para todos os destinatários com email');

  // ── 2. Data futura não é tocada ───────────────────────────────────
  titulo('a data futura não dispara');
  reiniciar();
  semearAviso({ id: 1, data: '2026-10-01' });
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.avisos, 0, 'um aviso com data futura não é selecionado');
  assert.strictEqual(enfileirados.length, 0, 'nada é enfileirado');
  // O dia exato CONTA (o job corre nesse dia).
  reiniciar();
  semearAviso({ id: 1, data: '2026-09-22' });
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.enfileirados, 2, 'um aviso com data = hoje dispara no próprio dia');
  feito('data futura ignorada; data de hoje dispara');

  // ── 3. Idempotência: não reenvia o que já foi despachado ──────────
  titulo('idempotência — a tarefa corre todos os dias');
  reiniciar();
  semearAviso({ id: 1, data: '2026-09-20' });
  await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(enfileirados.length, 2, '1.ª execução: 2 mensagens');
  // A fila passou a ter as duas linhas (pendente). O aviso continua vencido.
  FILA = [
    { aviso_id: 1, destinatario_email: 'ana@x.pt', estado: 'pendente' },
    { aviso_id: 1, destinatario_email: 'rui@x.pt', estado: 'enviado' },
  ];
  const antes = enfileirados.length;
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.avisos, 1, 'o aviso continua a ser encontrado (a data segue vencida)');
  assert.strictEqual(r.enfileirados, 0, 'mas NÃO é reenfileirado — é isto que torna a tarefa idempotente');
  assert.strictEqual(enfileirados.length, antes, 'nenhuma mensagem nova foi para a fila');
  feito('2.ª execução no mesmo aviso não reenvia (deduplicação por aviso_id)');

  // ── 4. `erro` e `cancelado` também bloqueiam o automático ─────────
  titulo('erro e cancelado contam como despachados (disparo automático)');
  for (const estado of ['erro', 'cancelado', 'a_enviar']) {
    reiniciar();
    semearAviso({ id: 1, data: '2026-09-20' });
    FILA = [
      { aviso_id: 1, destinatario_email: 'ana@x.pt', estado },
      { aviso_id: 1, destinatario_email: 'rui@x.pt', estado },
    ];
    r = await enviarAvisosProgramados({ agora: HOJE });
    assert.strictEqual(r.enfileirados, 0, `estado '${estado}': o automático não reenvia`);
  }
  assert.ok(ESTADOS_DESPACHADOS.includes('erro') && ESTADOS_DESPACHADOS.includes('cancelado'),
    'o critério do automático inclui erro e cancelado');
  assert.ok(!ESTADOS_EM_CURSO.includes('erro') && !ESTADOS_EM_CURSO.includes('cancelado'),
    'o critério do manual NÃO inclui erro/cancelado (reenvio deliberado)');
  feito('erro/cancelado/a_enviar bloqueiam o disparo automático');

  // ── 5. O envio MANUAL mantém o critério mais largo ────────────────
  titulo('o envio manual reenvia depois de um erro');
  reiniciar();
  semearAviso({ id: 1, data: '2026-09-20' });
  const aviso1 = AVISOS[0];
  FILA = [{ aviso_id: 1, destinatario_email: 'ana@x.pt', estado: 'erro' }];
  let rm = await enfileirarAviso({ aviso: aviso1, condominioId: 1, estadosJaDespachados: ESTADOS_EM_CURSO });
  // A Ana tem uma linha em `erro`: com o critério do MANUAL ela não bloqueia,
  // por isso volta à fila (a par do Rui, que nunca teve linha nenhuma).
  assert.strictEqual(rm.enfileirados, 2, 'o manual volta a enfileirar os dois');
  assert.ok(enfileirados.some((e) => e.destinatario_email === 'ana@x.pt'),
    'o manual reenvia quem estava em erro');
  // E o mesmo aviso pelo automático bloqueia a Ana (o erro conta como tratado).
  enfileirados.length = 0;
  rm = await enfileirarAviso({ aviso: aviso1, condominioId: 1, estadosJaDespachados: ESTADOS_DESPACHADOS });
  assert.strictEqual(rm.enfileirados, 1, 'o automático só enfileira quem nunca foi tratado');
  assert.deepStrictEqual(enfileirados.map((e) => e.destinatario_email), ['rui@x.pt'],
    'o automático NÃO reenvia quem está em erro (só o Rui, sem linha, segue)');
  feito('manual reenvia após erro; automático não');

  // ── 6. Isolamento por condomínio ──────────────────────────────────
  titulo('isolamento — só condomínios ativos, cada aviso no seu condomínio');
  reiniciar();
  CONDOMINIOS_ATIVOS = [1]; // o condomínio 2 está INATIVO
  semearAviso({ id: 1, condominioId: 1, data: '2026-09-20' });
  semearAviso({ id: 2, condominioId: 2, data: '2026-09-20', pessoas: [[20, 'Zé', 'ze@y.pt']] });
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.avisos, 1, 'o aviso do condomínio INATIVO não é sequer lido');
  assert.strictEqual(enfileirados.length, 2, 'só saem as mensagens do condomínio ativo');
  assert.ok(enfileirados.every((e) => e.condominioId === 1), 'todas as mensagens levam o condomínio 1');
  // Com os dois ativos, cada aviso usa o SEU condomínio.
  reiniciar();
  semearAviso({ id: 1, condominioId: 1, data: '2026-09-20' });
  semearAviso({ id: 2, condominioId: 2, data: '2026-09-20', pessoas: [[20, 'Zé', 'ze@y.pt']] });
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.enfileirados, 3, 'com os dois ativos, saem os 3 destinatários');
  assert.deepStrictEqual([...new Set(enfileirados.map((e) => e.condominioId))].sort(), [1, 2],
    'cada mensagem leva o condomínio da PRÓPRIA linha (nunca um assumido)');
  const doAviso2 = enfileirados.filter((e) => e.aviso_id === 2);
  assert.ok(doAviso2.every((e) => e.condominioId === 2), 'o aviso 2 sai pelo condomínio 2');
  feito('só condomínios ativos; condomínio derivado da própria linha');

  // ── 7. A preferência «Avisos → email» desliga o automático ────────
  titulo('preferência «Avisos → email»');
  reiniciar();
  semearAviso({ id: 1, data: '2026-09-20' });
  avisosEmailAtivo = false;
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.desativado, true, 'com a preferência desligada, o disparo é desativado');
  assert.strictEqual(enfileirados.length, 0, 'nada é enfileirado com a preferência desligada');
  assert.ok(preferenciasConsultadas.includes('avisos:email'), 'a preferência «avisos:email» é consultada');
  avisosEmailAtivo = true;
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.enfileirados, 2, 'com a preferência ligada, volta a enviar');
  feito('a preferência de notificação governa o disparo automático');

  // ── 8. Anexo: o documento tem de ser do MESMO condomínio ──────────
  titulo('guarda IDOR no documento em anexo');
  reiniciar();
  driveLigado = true;
  // Documento do condomínio 2 associado a um aviso do condomínio 1.
  semearAviso({ id: 1, condominioId: 1, data: '2026-09-20', documentoId: 99 });
  DOCUMENTOS = [{ id: 99, condominio_id: 2, drive_file_id: 'drv-99', nome: 'alheio.pdf' }];
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.enfileirados, 2, 'o aviso sai na mesma (o anexo é acessório)');
  assert.ok(enfileirados.every((e) => !e.anexoBuffer), 'o documento de OUTRO condomínio não é anexado');
  assert.ok(enfileirados.every((e) => e.documento_id === 99), 'a referência ao documento mantém-se (não é apagada)');
  // Com o documento certo, é anexado.
  reiniciar();
  driveLigado = true;
  semearAviso({ id: 1, condominioId: 1, data: '2026-09-20', documentoId: 99 });
  DOCUMENTOS = [{ id: 99, condominio_id: 1, drive_file_id: 'drv-99', nome: 'certo.pdf' }];
  await enviarAvisosProgramados({ agora: HOJE });
  assert.ok(enfileirados.every((e) => e.anexoBuffer), 'o documento do MESMO condomínio é anexado');
  assert.strictEqual(enfileirados[0].anexoNome, 'certo.pdf', 'o anexo leva o nome do documento');
  feito('documento de outro condomínio nunca é anexado');

  // ── 9. Links: nunca relativos ─────────────────────────────────────
  titulo('links de email — nunca relativos');
  assert.strictEqual(linkAbsoluto('/documentos/ficheiro/x'), null, 'um link relativo é descartado');
  assert.strictEqual(linkAbsoluto('https://g.pt/documentos/ficheiro/x'), 'https://g.pt/documentos/ficheiro/x', 'um link absoluto passa');
  assert.strictEqual(linkAbsoluto(null), null, 'sem link não há link');
  assert.strictEqual(baseUrlPublica({}), '', 'sem APP_URL não se inventa um endereço');
  assert.strictEqual(baseUrlPublica({ APP_URL: 'https://gescondu.pt/' }), 'https://gescondu.pt', 'APP_URL é normalizado (barra final removida)');
  // Sem APP_URL, o documento com Drive não produz link (seria relativo).
  reiniciar();
  driveLigado = true;
  semearAviso({ id: 1, condominioId: 1, data: '2026-09-20', documentoId: 99 });
  DOCUMENTOS = [{ id: 99, condominio_id: 1, drive_file_id: 'drv-99', nome: 'certo.pdf' }];
  await enviarAvisosProgramados({ agora: HOJE });
  assert.ok(enfileirados.every((e) => e.anexoBuffer), 'sem APP_URL o documento segue em anexo');
  assert.ok(enfileirados.every((e) => !/\/documentos\/ficheiro/.test(String(e.corpo_html || ''))),
    'sem base absoluta não sai um link relativo (não clicável) no email');
  // Com APP_URL, o link absoluto aparece.
  reiniciar();
  driveLigado = true;
  process.env.APP_URL = 'https://gescondu.pt';
  semearAviso({ id: 1, condominioId: 1, data: '2026-09-20', documentoId: 99 });
  DOCUMENTOS = [{ id: 99, condominio_id: 1, drive_file_id: 'drv-99', nome: 'certo.pdf' }];
  await enviarAvisosProgramados({ agora: HOJE });
  assert.ok(enfileirados.some((e) => /https:\/\/gescondu\.pt\/documentos\/ficheiro/.test(String(e.corpo_html || ''))),
    'com APP_URL o link absoluto é incluído');
  delete process.env.APP_URL;
  feito('links absolutos quando há base; omitidos quando não há');

  // ── 10. Destinatários sem email não bloqueiam ─────────────────────
  titulo('destinatários sem email');
  reiniciar();
  semearAviso({ id: 1, data: '2026-09-20', pessoas: [[10, 'Ana', 'ana@x.pt'], [11, 'Sem Email', null]] });
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.enfileirados, 1, 'só quem tem email é enfileirado');
  assert.strictEqual(enfileirados[0].destinatario_email, 'ana@x.pt', 'é a Ana que recebe');
  feito('destinatário sem email é ignorado sem bloquear o aviso');

  // ── 11. Um aviso mal formado não impede os restantes ──────────────
  titulo('resiliência a um aviso inválido');
  reiniciar();
  semearAviso({ id: 1, data: '2026-09-20' });
  AVISOS.push({ id: 2, condominio_id: 0, tipo: 'programado', assunto: 'Sem condomínio', mensagem: 'x', data_programada: '2026-09-20' });
  semearAviso({ id: 3, data: '2026-09-19' });
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.enfileirados, 4, 'os avisos válidos (1 e 3) saem; o sem condomínio é saltado');
  assert.ok(enfileirados.every((e) => e.condominioId > 0), 'nenhuma mensagem sai sem condomínio');
  feito('aviso sem condomínio é saltado sem derrubar a tarefa');

  // ── 12. Tipos que não são «programado» não são disparados ─────────
  titulo('só o tipo `programado` é despachado automaticamente');
  reiniciar();
  semearAviso({ id: 1, tipo: 'manual', data: '2026-09-20' });
  semearAviso({ id: 2, tipo: 'automatico', data: '2026-09-20' });
  r = await enviarAvisosProgramados({ agora: HOJE });
  assert.strictEqual(r.avisos, 0, 'avisos manuais/automáticos não são disparados por esta tarefa');
  assert.strictEqual(enfileirados.length, 0, 'nada é enfileirado');
  feito('apenas avisos do tipo `programado` são despachados');

  // ── Parte B — a rota MANUAL delega no motor (não tem motor próprio) ──
  await parteB();

  console.log(`\n✓ Avisos programados: ${n} verificações passaram (sem BD).`);
}

// ═══════════════════════════════════════════════════════════════════
// Parte B — `POST /avisos/:id/enviar` (rota REAL, em HTTP).
//
// A rota deixou de ter lógica própria: passou a chamar o MESMO motor que o job
// usa. Este bloco prova a LIGAÇÃO — que era exatamente o que o refactor mudou:
//
//   · o aviso é lido com o `condominio_id` da sessão (isolamento);
//   · o motor é chamado com o condomínio ativo, o utilizador e o critério de
//     deduplicação do MANUAL (`ESTADOS_EM_CURSO`, mais largo que o automático);
//   · o `baseUrl` é derivado do PEDIDO (nunca fixo);
//   · o resultado do motor é o que vai para o flash e para a auditoria.
// ═══════════════════════════════════════════════════════════════════
async function parteB() {
  titulo('Parte B — POST /avisos/:id/enviar delega no motor único');

  const http = require('http');
  const express = require('express');

  const chamadas = [];
  const auditorias = [];
  const flashes = [];
  // O router captura `enfileirarAviso` no CARREGAMENTO (desestruturação), pelo
  // que não basta trocar a propriedade do módulo depois: o comportamento do
  // espião tem de ser mutável por dentro.
  let resultadoMotor = { enfileirados: 2, total: 2, jaDespachados: 0, semEmail: 0, comAnexo: true, documento: 7 };

  // Duplos instalados ANTES de carregar o router: `routes/avisos.js`
  // desestrutura `enfileirarAviso` no carregamento, pelo que tem de encontrar
  // já o duplo em cache.
  const duplo = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, '..', rel));
    require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports };
  };
  duplo('helpers/avisos-envio', {
    enfileirarAviso: async (args) => {
      chamadas.push(args);
      return { ...resultadoMotor };
    },
    ESTADOS_EM_CURSO: ['pendente', 'a_enviar', 'enviado'],
    ESTADOS_DESPACHADOS: ['pendente', 'a_enviar', 'enviado', 'erro', 'cancelado'],
    linkAbsoluto: (u) => u,
  });
  duplo('helpers/tenant', {
    comCondominioAtivo: (req, res, next) => { req.condominioId = 1; next(); },
    comPapel: () => (req, res, next) => next(),
  });
  duplo('helpers/audit', { audit: async (d) => { auditorias.push(d); } });

  // O aviso é lido com o condomínio da sessão E com o id do caminho: o duplo
  // imita a BD nos DOIS filtros (senão responderia a qualquer id).
  const consultasAviso = [];
  models.Aviso.findOne = async (opcoes) => {
    consultasAviso.push(opcoes);
    if (Number(opcoes.where.condominio_id) !== 1) return null;
    if (Number(opcoes.where.id) !== 5) return null; // só existe o aviso 5
    return { id: 5, condominio_id: 1, assunto: 'Aviso de teste', mensagem: null, documento_id: null, documento: null };
  };

  const router = require('../routes/avisos');
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: 7 };
    req.flash = (tipo, msg) => { flashes.push([tipo, msg]); return req; };
    next();
  });
  app.use(express.urlencoded({ extended: true }));
  app.use('/admin', router);

  const postar = (caminho) => new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const pedido = http.request({
        host: '127.0.0.1', port: servidor.address().port, path: caminho, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 },
      }, (res) => {
        let corpo = '';
        res.on('data', (d) => { corpo += d; });
        res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, corpo, location: res.headers.location }); });
      });
      pedido.on('error', (e) => { servidor.close(); reject(e); });
      pedido.end();
    });
  });

  const r = await postar('/admin/avisos/5/enviar');
  assert.strictEqual(r.status, 302, 'o envio responde com redirecionamento');
  assert.strictEqual(r.location, '/admin/avisos/5', 'volta à ficha do aviso');

  assert.strictEqual(consultasAviso.length, 1, 'o aviso é lido uma vez');
  assert.strictEqual(Number(consultasAviso[0].where.condominio_id), 1,
    'o aviso é lido com o condomínio da SESSÃO (isolamento)');
  assert.strictEqual(Number(consultasAviso[0].where.id), 5, 'o aviso é o do caminho');

  assert.strictEqual(chamadas.length, 1, 'o motor é chamado uma só vez (não há segundo motor)');
  const c = chamadas[0];
  assert.strictEqual(c.condominioId, 1, 'o motor recebe o condomínio ativo');
  assert.strictEqual(c.userId, 7, 'o motor recebe o utilizador (rasto na fila)');
  assert.deepStrictEqual(c.estadosJaDespachados, ['pendente', 'a_enviar', 'enviado'],
    'o MANUAL usa o critério mais largo (reenvia após erro/cancelado)');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(c.baseUrl)),
    'o `baseUrl` é derivado do PEDIDO (protocolo + host), nunca fixo');
  assert.strictEqual(c.aviso.id, 5, 'o motor recebe o aviso lido');

  assert.deepStrictEqual(flashes, [['success_msg', 'Foram enfileirados 2 email(s). (com documento em anexo)']],
    'o flash reflete o resultado do motor');
  assert.strictEqual(auditorias.length, 1, 'o envio é auditado');
  assert.strictEqual(auditorias[0].acao, 'enviar_aviso', 'a auditoria regista a ação');
  assert.strictEqual(auditorias[0].detalhes.enfileirados, 2, 'a auditoria regista o número real');

  // Sem novos destinatários, a rota não audita nem mente no flash.
  chamadas.length = 0;
  flashes.length = 0;
  auditorias.length = 0;
  resultadoMotor = { enfileirados: 0, total: 2, jaDespachados: 2, semEmail: 0, comAnexo: false, documento: null };
  const r2 = await postar('/admin/avisos/5/enviar');
  assert.strictEqual(r2.location, '/admin/avisos/5', 'sem novos destinatários, volta na mesma à ficha');
  assert.ok(/Não há novos destinatários/.test(flashes[0][1]), 'o flash explica que não há novos destinatários');
  assert.strictEqual(auditorias.length, 0, 'sem envio não há auditoria de envio');

  // Aviso inexistente (ou de outro condomínio) não chega ao motor.
  chamadas.length = 0;
  flashes.length = 0;
  const r3 = await postar('/admin/avisos/999/enviar');
  assert.strictEqual(r3.location, '/admin/avisos', 'aviso inexistente volta à lista');
  assert.strictEqual(chamadas.length, 0, 'sem aviso não se chama o motor');
  feito('a rota manual delega no motor, com isolamento, baseUrl do pedido e critério correto');
}

main().catch((err) => {
  console.error('\n✗ ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
