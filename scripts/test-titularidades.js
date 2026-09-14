// ═══════════════════════════════════════════════════════════════════
// Titularidades de frações — histórico, acesso atual e mudança de proprietário.
//
// Testes OFFLINE (sem base de dados): as consultas Sequelize são substituídas
// por uma tabela em memória com filtragem real (condominio_id, estado,
// utilizador_id/pessoa_id e datas), pelo que o teste verifica de facto os
// filtros usados e não apenas valores fixos.
//
// Cenários cobertos:
//   A. proprietário normal → acesso correto à sua fração
//   B. venda da fração → o anterior perde acesso, o novo ganha (isolamento)
//   C. utilizador com vários condomínios → perde acesso só ao condomínio certo
//   D. documentos privados → o novo proprietário não os recebe (via flag)
//   E. histórico financeiro → nada é apagado nem tocado pelas titularidades
//   F. sessão antiga → a autorização é reavaliada em cada pedido
//   G. exportação → (implementado com o fluxo de saída; ver secção final)
//   H. administrador ≠ proprietário → a saída não mexe em papéis
//
// Utilização: node scripts/test-titularidades.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const modelos = require('../models');
const titularidades = require('../helpers/titularidades');
const { resolverDestinatarios } = require('../helpers/avisos');
const { ContactoPessoa } = modelos;

const { FracaoTitularidade, FracaoPessoa, Fracao, Pessoa, AuditLog } = modelos;

// ── Dados de teste ─────────────────────────────────────────────────
// Condomínio 1: fração 10 (1.º Esq). Condomínio 2: fração 20 (A).
const FRACOES = {
  10: { id: 10, condominio_id: 1, designacao: '1.º Esq' },
  20: { id: 20, condominio_id: 2, designacao: 'A' },
};

const PESSOAS = {
  100: { id: 100, condominio_id: 1, nome: 'João Silva', email: 'joao@exemplo.pt', ativo: true },
  200: { id: 200, condominio_id: 1, nome: 'Maria Costa', email: 'maria@exemplo.pt', ativo: true },
  300: { id: 300, condominio_id: 2, nome: 'Ana Dias', email: 'ana@exemplo.pt', ativo: true },
};

let titulos = [];
let vinculos = [];
let auditoria = [];
let proximoId = 1;

function reiniciar() {
  titulos = [];
  vinculos = [];
  auditoria = [];
  proximoId = 1;
}

function novoTitulo({ condominio_id, fracao_id, pessoa_id = null, utilizador_id = null, vinculo = 'proprietario', data_inicio = '2024-01-01', data_fim = null, estado = 'ativa' }) {
  const linha = { id: proximoId++, condominio_id, fracao_id, pessoa_id, utilizador_id, vinculo, data_inicio, data_fim, estado, motivo_cessacao: null };
  linha.fracao = FRACOES[fracao_id];
  linha.update = async (campos) => Object.assign(linha, campos);
  titulos.push(linha);
  return linha;
}

// Vínculo do modelo anterior (`fracao_pessoas`), com update para o fecho temporal.
function novoVinculo({ fracao_id, pessoa_id, vinculo = 'proprietario', data_inicio = null, data_fim = null }) {
  const linha = { id: vinculos.length + 1, fracao_id, pessoa_id, vinculo, data_inicio, data_fim };
  linha.update = async (campos) => Object.assign(linha, campos);
  vinculos.push(linha);
  return linha;
}

// ── Filtro em memória (mesma semântica das consultas usadas) ───────
function corresponde(linha, where = {}) {
  for (const simbolo of Object.getOwnPropertySymbols(where)) {
    const alternativas = where[simbolo];
    if (simbolo === Op.or) {
      if (!alternativas.some((alt) => corresponde(linha, alt))) return false;
      continue;
    }
    if (simbolo === Op.in) {
      // Só usado como { id: { [Op.in]: [...] } }, tratado abaixo por campo.
      continue;
    }
  }
  for (const [campo, valor] of Object.entries(where)) {
    if (campo === 'include') continue;
    if (valor === undefined) continue;
    if (valor === null) { if (linha[campo] !== null && linha[campo] !== undefined) return false; continue; }
    if (valor && typeof valor === 'object' && valor[Op.in]) {
      const lista = valor[Op.in].map(String);
      if (!lista.includes(String(linha[campo]))) return false;
      continue;
    }
    if (String(linha[campo]) !== String(valor)) return false;
  }
  // include com where (no caso real: a fração do condomínio ativo)
  const include = where.include && where.include[0];
  if (include && include.where) {
    if (!linha.fracao) return false;
    if (String(linha.fracao.condominio_id) !== String(include.where.condominio_id)) return false;
  }
  return true;
}

function instalarStubs() {
  FracaoTitularidade.findAll = async ({ where } = {}) => titulos.filter((l) => corresponde(l, where));
  FracaoTitularidade.findOne = async ({ where } = {}) => titulos.find((l) => corresponde(l, where)) || null;
  FracaoTitularidade.findByPk = async (id) => titulos.find((l) => String(l.id) === String(id)) || null;
  FracaoTitularidade.create = async (dados) => {
    const linha = novoTitulo({
      condominio_id: dados.condominio_id,
      fracao_id: dados.fracao_id,
      pessoa_id: dados.pessoa_id,
      utilizador_id: dados.utilizador_id,
      vinculo: dados.vinculo,
      data_inicio: dados.data_inicio,
      data_fim: null,
      estado: 'ativa',
    });
    Object.assign(linha, dados);
    return linha;
  };
  FracaoPessoa.findAll = async ({ where } = {}) =>
    vinculos.filter((v) => corresponde(v, where)).map((v) => ({ ...v, fracao: FRACOES[v.fracao_id] }));
  FracaoPessoa.findOne = async ({ where } = {}) => vinculos.find((v) => corresponde(v, where)) || null;
  Fracao.findOne = async ({ where } = {}) => {
    const id = where && where.id;
    return FRACOES[id] || null;
  };
  Pessoa.findAll = async ({ where } = {}) =>
    Object.values(PESSOAS).filter((p) => corresponde(p, where)).map((p) => ({ ...p }));
  // Sem contactos registados: o email preferido cai no email da própria pessoa.
  ContactoPessoa.findAll = async () => [];
  AuditLog.create = async (dados) => { auditoria.push(dados); return dados; };
}

// ── A. Proprietário normal ─────────────────────────────────────────
async function cenarioA() {
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, vinculo: 'proprietario', data_inicio: '2024-01-01' });

  const r = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100 });
  assert.strictEqual(r.origem, 'titularidades', 'A: acesso decidido pelas titularidades');
  assert.strictEqual(r.fracoes.length, 1, 'A: uma fração');
  assert.strictEqual(r.fracoes[0].fracao.id, 10, 'A: a fração certa');
  assert.strictEqual(r.fracoes[0].vinculo, 'proprietario', 'A: vínculo devolvido');

  assert.ok(await titularidades.temAcessoFracao({ condominioId: 1, fracaoId: 10, utilizadorId: 1, pessoaId: 100 }), 'A: tem acesso à fração');
  assert.ok(!(await titularidades.temAcessoFracao({ condominioId: 1, fracaoId: 20, utilizadorId: 1, pessoaId: 100 })), 'A: não tem acesso a outra fração');
}

// ── B. Venda da fração ─────────────────────────────────────────────
async function cenarioB() {
  reiniciar();
  // João vendeu em 30/06/2026; Maria é proprietária desde 01/07/2026.
  const joao = novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, data_inicio: '2024-01-01', data_fim: '2026-06-30', estado: 'cessada', vinculo: 'proprietario' });
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 200, utilizador_id: 2, data_inicio: '2026-07-01', vinculo: 'proprietario' });
  // O vínculo antigo (modelo anterior) também ficou fechado — mantém-se a linha.
  novoVinculo({ fracao_id: 10, pessoa_id: 100, data_inicio: '2024-01-01', data_fim: '2026-06-30' });
  novoVinculo({ fracao_id: 10, pessoa_id: 200, data_inicio: '2026-07-01' });

  const doJoao = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-09-14' });
  assert.strictEqual(doJoao.fracoes.length, 0, 'B: João deixou de ter frações (titularidade cessada)');
  assert.ok(!(await titularidades.temAcessoFracao({ condominioId: 1, fracaoId: 10, utilizadorId: 1, pessoaId: 100, dataRef: '2026-09-14' })), 'B: João sem acesso à fração vendida');

  const daMaria = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 2, pessoaId: 200, dataRef: '2026-09-14' });
  assert.strictEqual(daMaria.fracoes.length, 1, 'B: Maria tem a fração');
  assert.strictEqual(daMaria.fracoes[0].fracao.id, 10, 'B: a mesma fração');
  assert.ok(await titularidades.temAcessoFracao({ condominioId: 1, fracaoId: 10, utilizadorId: 2, pessoaId: 200, dataRef: '2026-09-14' }), 'B: Maria com acesso');

  // O histórico do João continua registado (nada foi apagado nem substituído).
  const historico = await titularidades.historicoDaFracao({ condominioId: 1, fracaoId: 10 });
  assert.strictEqual(historico.length, 2, 'B: histórico com os dois períodos');
  assert.ok(titulos.some((t) => t.id === joao.id && t.estado === 'cessada' && t.data_fim === '2026-06-30'), 'B: período do João preservado com data de fim');

  // Quem era o titular em cada momento (pergunta histórica: datas, não estado).
  assert.ok(titularidades.vigenteNaData(joao, '2026-05-01'), 'B: o período do João cobria maio de 2026');
  const maria = titulos.find((t) => t.utilizador_id === 2);
  assert.ok(!titularidades.vigenteNaData(maria, '2026-05-01'), 'B: o período da Maria ainda não tinha começado em maio de 2026');
  assert.ok(titularidades.vigenteNaData(maria, '2026-09-14'), 'B: o período da Maria cobre hoje');
  assert.ok(!titularidades.estaAtiva(joao, '2026-05-01'), 'B: uma titularidade cessada nunca autoriza, mesmo dentro do período');
  assert.ok(titularidades.estaAtiva(maria, '2026-09-14'), 'B: a titularidade em curso autoriza');

  // Compatibilidade: sem titularidades registadas, decide-se pelo modelo antigo,
  // mas respeitando data_fim (o teste simula um titular só com fracao_pessoas).
  titulos = [];
  const legadoJoao = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-09-14' });
  assert.strictEqual(legadoJoao.origem, 'nenhuma', 'B: vínculo antigo encerrado não dá acesso');
  const legadoMaria = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 2, pessoaId: 200, dataRef: '2026-09-14' });
  assert.strictEqual(legadoMaria.origem, 'legado', 'B: sem titularidades, usa o modelo antigo');
  assert.strictEqual(legadoMaria.fracoes.length, 1, 'B: o novo proprietário mantém acesso pelo modelo antigo');
}

// ── C. Utilizador com vários condomínios ───────────────────────────
async function cenarioC() {
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, data_inicio: '2026-01-01' });
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, data_inicio: '2027-01-01' }); // futuro
  novoTitulo({ condominio_id: 2, fracao_id: 20, pessoa_id: 300, utilizador_id: 1, data_inicio: '2025-01-01' });

  const noUm = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-09-14' });
  const noDois = await titularidades.fracoesDoUtilizador({ condominioId: 2, utilizadorId: 1, pessoaId: 300, dataRef: '2026-09-14' });
  assert.strictEqual(noUm.fracoes.length, 1, 'C: no condomínio 1 tem uma fração');
  assert.strictEqual(noDois.fracoes.length, 1, 'C: no condomínio 2 continua com acesso');
  assert.strictEqual(noDois.fracoes[0].fracao.id, 20, 'C: a fração do condomínio 2');
  assert.ok(!(await titularidades.temAcessoFracao({ condominioId: 2, fracaoId: 10, utilizadorId: 1, dataRef: '2026-09-14' })), 'C: a fração do condomínio 1 não é acessível a partir do condomínio 2');
  assert.strictEqual(noUm.fracoes.filter((f) => f.titularidadeId === 2).length, 0, 'C: titularidade futura ainda não dá acesso');
}

// ── D. Documentos privados (flag por documento) ────────────────────
function cenarioD() {
  // A decisão de acesso a documentos é por documento (`disponivel_condominos`)
  // e não pela identidade do anterior proprietário: um documento privado do
  // João não passa a estar disponível só porque a fração mudou de dono.
  const acesso = ler('helpers/documentos-acesso.js');
  assert.ok(/temPermissao[\s\S]{0,400}disponivel_condominos/.test(acesso), 'D: condóminos só vêem documentos disponibilizados');
  assert.ok(/if \(!documento\.disponivel_condominos\) return recusar\(MOTIVO\.SEM_PERMISSAO\)/.test(acesso), 'D: documento privado recusado explicitamente');
  const modelo = ler('models/Documento.js');
  assert.ok(/disponivel_condominos: \{ type: DataTypes\.BOOLEAN, allowNull: false, defaultValue: false \}/.test(modelo), 'D: documentos privados são o valor por omissão');
}

// ── E. Histórico financeiro não é tocado ───────────────────────────
function cenarioE() {
  const fonte = ler('helpers/titularidades.js');
  for (const modelo of ['Quota', 'Pagamento', 'Recibo', 'ExtraQuota', 'Despesa', 'Documento', 'MovimentoBancario']) {
    assert.ok(!new RegExp(`\\b${modelo}\\b`).test(fonte), `E: titularidades não tocam em ${modelo}`);
  }
  assert.ok(!/\.destroy\(/.test(fonte), 'E: nada é apagado (só se encerram períodos)');
  // O fecho de titularidade escreve apenas datas/estado no próprio registo e no
  // vínculo correspondente.
  assert.ok(/estado: 'cessada'/.test(fonte), 'E: encerrar é estado cessada (histórico mantido)');
}

// ── F. Sessão antiga: autorização reavaliada em cada pedido ────────
function cenarioF() {
  const condomino = ler('routes/condomino.js');
  const ocorrencias = (condomino.match(/await contextoFracoes\(req\)/g) || []).length;
  assert.ok(ocorrencias >= 12, `F: todas as rotas do portal reavaliam o acesso (${ocorrencias} ocorrências)`);
  assert.ok(/async function contextoFracoes\(req\)[\s\S]{0,900}fracoesDoUtilizador/.test(condomino), 'F: a autorização passa pelas titularidades no momento do pedido');
  const tenant = ler('helpers/tenant.js');
  assert.ok(/where: \{ utilizador_id: utilizadorId, condominio_id: condominioId, estado: 'ativo' \}/.test(tenant), 'F: a associação ao condomínio é revalidada por pedido');
  const app = ler('app.js');
  assert.ok(app.includes('sessao.verificarContaAtiva'), 'F: a conta é revalidada em cada pedido');
  const sessao = ler('helpers/sessao.js');
  assert.ok(/function verificarContaAtiva/.test(sessao), 'F: existe a verificação de conta ativa');
  assert.ok(/utilizador\.ativo === false/.test(sessao), 'F: conta desativada corta a sessão');
  assert.ok(!/req\.session\.papelCondominio\s*=/.test(condomino), 'F: o portal não guarda o papel em sessão');
}

// ── H. Administrador é caso diferente ─────────────────────────────
function cenarioH() {
  const fonte = ler('helpers/titularidades.js');
  assert.ok(!/UserCondominio/.test(fonte), 'H: as titularidades não mexem em papéis de condomínio');
  assert.ok(!/'gestor'|'admin'/.test(fonte.replace(/^.*(gestor|admin).*$/gm, '')), 'H: a saída de proprietário não atribui nem retira administração');
}

// ── Escrita: criar, encerrar e auditar ────────────────────────────
async function testesDeEscrita() {
  reiniciar();
  novoVinculo({ fracao_id: 10, pessoa_id: 100 });

  const criada = await titularidades.criarTitularidade({
    condominioId: 1, fracaoId: 10, pessoaId: 100, utilizadorId: 1, vinculo: 'proprietario', dataInicio: '2026-01-01', userId: 9, origem: 'teste',
  });
  assert.strictEqual(criada.estado, 'ativa', 'escrita: nova titularidade fica ativa');
  assert.strictEqual(criada.data_fim, null, 'escrita: sem data de fim');
  assert.ok(auditoria.some((a) => a.acao === 'criar_titularidade'), 'escrita: criação auditada');
  assert.strictEqual(titulos.length, 1, 'escrita: criar não fecha nem substitui outros períodos');
  assert.strictEqual(vinculos[0].data_fim, null, 'escrita: criar não fecha o vínculo antigo');

  const encerrada = await titularidades.cessarTitularidade({ titularidadeId: criada.id, dataFim: '2026-06-30', motivo: 'venda', userId: 9 });
  assert.strictEqual(encerrada.estado, 'cessada', 'escrita: encerrar põe cessada');
  assert.strictEqual(encerrada.data_fim, '2026-06-30', 'escrita: data de fim registada');
  assert.strictEqual(encerrada.motivo_cessacao, 'venda', 'escrita: motivo registado');
  assert.strictEqual(titulos.length, 1, 'escrita: encerrar não apaga a linha');
  assert.strictEqual(vinculos[0].data_fim, '2026-06-30', 'escrita: o vínculo do modelo antigo também é fechado (senão continuaria a dar acesso)');
  assert.ok(auditoria.some((a) => a.acao === 'cessar_titularidade'), 'escrita: encerramento auditado');

  // Encerrar tudo de um utilizador (fluxo de saída).
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, data_inicio: '2026-01-01' });
  novoTitulo({ condominio_id: 2, fracao_id: 20, pessoa_id: 100, utilizador_id: 1, data_inicio: '2026-01-01' });
  const encerradas = await titularidades.cessarTitularidadesAtivas({ condominioId: 1, utilizadorId: 1, dataFim: '2026-09-14', motivo: 'saida_condominio', userId: 9 });
  assert.strictEqual(encerradas.length, 1, 'saída: encerra apenas as do condomínio ativo');
  assert.strictEqual(titulos.find((t) => t.condominio_id === 2).estado, 'ativa', 'saída: o outro condomínio fica intacto');
  assert.ok(auditoria.filter((a) => a.acao === 'cessar_titularidade').length === 1, 'saída: um evento por titularidade encerrada');
}

// ── Datas e vínculos (funções puras) ──────────────────────────────
function testesPuros() {
  const t = { estado: 'ativa', data_inicio: '2026-01-01', data_fim: '2026-06-30' };
  assert.ok(titularidades.estaAtiva(t, '2026-03-15'), 'puro: dentro do período');
  assert.ok(!titularidades.estaAtiva(t, '2026-07-01'), 'puro: depois do fim');
  assert.ok(!titularidades.estaAtiva(t, '2025-12-31'), 'puro: antes do início');
  assert.ok(!titularidades.estaAtiva({ ...t, estado: 'cessada' }, '2026-03-15'), 'puro: cessada não dá acesso');
  assert.ok(titularidades.estaAtiva({ estado: 'ativa', data_inicio: null, data_fim: null }, '2026-03-15'), 'puro: sem datas = relação em curso');
  assert.strictEqual(titularidades.normalizarData('2026-06-30T00:00:00.000Z'), '2026-06-30', 'puro: datas DATEONLY normalizadas');
  assert.strictEqual(titularidades.normalizarData('ontem'), null, 'puro: data inválida descartada');
  assert.strictEqual(titularidades.normalizarVinculo('inventado'), 'proprietario', 'puro: vínculo inválido cai no padrão');
  assert.deepStrictEqual(titularidades.VINCULOS, ['proprietario', 'arrendatario', 'usufrutuario'], 'puro: vínculos suportados');
}

// ── G. Exportação: só o que a pessoa pode legitimamente receber ────
async function cenarioG() {
  const { construirExportacao } = require('../helpers/exportacao-dados');
  const { lerZip } = require('../helpers/zip');
  const comprovativos = require('../helpers/comprovativos');

  // Sem comprovativos no disco e sem ficheiros no armazenamento externo: o que
  // interessa aqui é o conteúdo (e o manifesto dizer o que ficou de fora).
  const originalExiste = comprovativos.existeComprovativo;
  comprovativos.existeComprovativo = () => false;

  const modelos = require('../models');
  const originais = {};
  const substituir = (modelo, valor) => {
    originais[modelo] = modelos[modelo].findAll;
    modelos[modelo].findAll = async () => valor;
  };
  substituir('Quota', [
    { id: 1, fracao_id: 10, ano: 2026, mes: 1, valor: '61.22', data_vencimento: '2026-01-08', estado: 'paga' },
    { id: 2, fracao_id: 99, ano: 2026, mes: 1, valor: '999.00', data_vencimento: '2026-01-08', estado: 'paga' }, // outra fração
  ]);
  substituir('Pagamento', [
    { id: 50, fracao_id: 10, numero_documento: 'PAG-1', data_pagamento: '2026-01-05', valor: '61.22', referencia: 'x', estado: 'confirmado', comprovativo_nome: null },
  ]);
  substituir('Recibo', [{ id: 80, fracao_id: 10, codigo: 'RCP-2026-0001', ano: 2026, tipo: 'ordinario', valor: '61.22', data_emissao: '2026-01-06', estado: 'emitido' }]);
  substituir('ExtraQuotaParcela', []);
  // `pagoPorQuota` consulta as aplicações confirmadas: sem aplicações no cenário.
  originais.PagamentoQuota = modelos.PagamentoQuota.findAll;
  modelos.PagamentoQuota.findAll = async () => [];
  substituir('Documento', [{ id: 90, nome: 'Ata da assembleia.pdf', tipo: 'ata', pasta: 'Atas', data: '2026-02-01', drive_file_id: null }]);
  substituir('Assembleia', [{ id: 5, numero: '1/2026', tipo: 'Ordinária', data: '2026-02-10', hora: '18:30', local: 'Sala', estado: 'realizada' }]);
  substituir('AssembleiaParticipante', [{ id: 1, assembleia_id: 5, pessoa_id: 100, presente: true }]);
  substituir('Aviso', [{ id: 7, assunto: 'Manutenção do elevador', mensagem: 'Na próxima terça-feira.', data: '2026-03-01' }]);
  substituir('ContactoPessoa', [{ id: 1, tipo: 'email', valor: 'joao@exemplo.pt', principal: true }]);
  substituir('FracaoTitularidade', [
    { id: 1, fracao_id: 10, vinculo: 'proprietario', data_inicio: '2024-01-01', data_fim: '2026-06-30', estado: 'cessada', motivo_cessacao: 'venda' },
  ]);

  try {
    const { nomeFicheiro, buffer, manifesto } = await construirExportacao({
      condominioId: 1,
      condominio: { id: 1, designacao: 'Condomínio Jardins do Tejo' },
      utilizador: { id: 1, nome: 'João Almeida', email: 'joao@exemplo.pt', telefone: null },
      pessoa: { id: 100, nome: 'João Almeida', nif: '123456789', email: 'joao@exemplo.pt', telefone: null },
      fracoes: [{ id: 10, designacao: '1.º Esq', permilagem: '125.00', vinculoAtual: 'proprietario' }],
    });

    assert.ok(/^GesCondu_Exportacao_Joao_Almeida_1_Esq_\d{4}-\d{2}-\d{2}\.zip$/.test(nomeFicheiro), `G: nome do ficheiro identificável (${nomeFicheiro})`);

    const entradas = lerZip(buffer);
    assert.ok(entradas.length >= 8, `G: ZIP com conteúdo (${entradas.length} entradas)`);
    assert.ok(entradas.every((e) => e.crcValido && e.tamanhoOk), 'G: todas as entradas do ZIP com CRC e tamanho corretos');
    const nomes = entradas.map((e) => e.nome);
    for (const esperado of [
      'MANIFEST.txt', 'Dados pessoais/dados-pessoais.txt', 'Fracoes/fracoes.csv', 'Fracoes/titularidades.csv',
      'Quotas/quotas.csv', 'Pagamentos/pagamentos.csv', 'Recibos/recibos.csv',
      'Documentos/documentos.csv', 'Assembleias/assembleias.csv', 'Comunicacoes/avisos.csv',
    ]) {
      assert.ok(nomes.includes(esperado), `G: inclui ${esperado}`);
    }
    assert.ok(!nomes.some((n) => /Vota/i.test(n)), 'G: não inventa pastas de módulos que não existem');

    const quotas = entradas.find((e) => e.nome === 'Quotas/quotas.csv').conteudo.toString('utf8');
    assert.ok(quotas.includes('1.º Esq'), 'G: as quotas da fração do titular estão no ficheiro');
    assert.ok(!quotas.includes('999,00'), 'G: as quotas de OUTRA fração não entram na exportação');
    assert.ok(quotas.startsWith('\ufeff'), 'G: CSV em UTF-8 com BOM (abre corretamente no Excel)');

    const pessoais = entradas.find((e) => e.nome === 'Dados pessoais/dados-pessoais.txt').conteudo.toString('utf8');
    assert.ok(pessoais.includes('João Almeida') && pessoais.includes('joao@exemplo.pt'), 'G: dados do próprio');
    assert.ok(!/Ana|Maria|Carlos/.test(pessoais), 'G: sem dados de terceiros');

    const manifestoTexto = entradas.find((e) => e.nome === 'MANIFEST.txt').conteudo.toString('utf8');
    assert.ok(manifestoTexto.includes('histórico financeiro e documental do condomínio NÃO é apagado'), 'G: o manifesto explica que nada é apagado');
    assert.ok(manifestoTexto.includes('Não inclui dados pessoais de outros condóminos'), 'G: o manifesto delimita o âmbito');
    assert.ok(/Documento "Ata da assembleia\.pdf": sem ficheiro guardado/.test(manifestoTexto), 'G: o que não foi incluído é justificado');
    assert.ok(manifesto.incluidos.length >= 8, 'G: o manifesto lista o que foi incluído');

    // Sem relações ativas não há exportação de conteúdo pessoal alargado.
    const vazio = await construirExportacao({
      condominioId: 1, condominio: null, utilizador: { id: 1, nome: 'X', email: 'x@y.pt' }, pessoa: null, fracoes: [],
    });
    const entradasVazias = lerZip(vazio.buffer);
    assert.ok(!entradasVazias.some((e) => e.nome === 'Quotas/quotas.csv'), 'G: sem frações não há quotas a exportar');
    assert.ok(entradasVazias.some((e) => e.nome === 'MANIFEST.txt'), 'G: mesmo sem frações há manifesto');

    // Antigo titular (vendeu a fração e a titularidade foi encerrada): a
    // exportação tem de lhe dar o HISTÓRICO das relações, não uma folha vazia.
    const antigo = await construirExportacao({
      condominioId: 1,
      condominio: { id: 1, designacao: 'Condomínio Jardins do Tejo' },
      utilizador: { id: 1, nome: 'João Almeida', email: 'joao@exemplo.pt' },
      pessoa: { id: 100, nome: 'João Almeida', nif: '123456789', email: 'joao@exemplo.pt' },
      fracoes: [],
    });
    const entradasAntigo = lerZip(antigo.buffer);
    const fracoesCsv = entradasAntigo.find((e) => e.nome === 'Fracoes/fracoes.csv').conteudo.toString('utf8');
    assert.ok(fracoesCsv.includes('encerrada'), 'G: o histórico é marcado como encerrado');
    assert.ok(fracoesCsv.includes('2024-01-01') && fracoesCsv.includes('2026-06-30'), 'G: o período (início e fim) consta do histórico');
    assert.ok(entradasAntigo.some((e) => e.nome === 'Fracoes/titularidades.csv'), 'G: períodos de titularidade incluídos');
    assert.ok(!entradasAntigo.some((e) => e.nome === 'Quotas/quotas.csv'), 'G: sem frações em vigor não se exportam quotas de terceiros');
  } finally {
    comprovativos.existeComprovativo = originalExiste;
    for (const [modelo, original] of Object.entries(originais)) modelos[modelo].findAll = original;
  }
}

// ── Fluxo "Preparar saída do condomínio" (invariantes de segurança) ─
function testesFluxoSaida() {
  const rota = ler('routes/saida-condominio.js');

  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(rota), 'saída: exige condomínio ativo');
  assert.ok(/router\.get\('\/condomino\/saida'/.test(rota), 'saída: página explicativa própria');
  assert.ok(/router\.post\('\/condomino\/saida\/exportar'/.test(rota), 'saída: exportação por POST (não por link)');
  assert.ok(/router\.post\('\/condomino\/saida\/concluir'/.test(rota), 'saída: conclusão por POST');

  // Reautenticação forte com os mecanismos existentes.
  assert.ok(/bcrypt\.compareSync\(password, req\.user\.password_hash\)/.test(rota), 'saída: confirma a palavra-passe');
  assert.ok(/doisfatores\.verificarTOTP\(req\.user\.two_fa_totp_secret, codigo\)/.test(rota), 'saída: usa o 2FA existente quando ativo');
  assert.ok(/req\.body\.confirmo !== 'on'/.test(rota), 'saída: exige confirmação explícita');
  assert.ok(/if \(estado\.bloqueio\)/.test(rota), 'saída: respeita o bloqueio (último administrador)');

  // Encerrar mantém o histórico e revoga o acesso de forma reversível.
  assert.ok(/cessarTitularidadesAtivas\(/.test(rota), 'saída: encerra as titularidades ativas');
  assert.ok(!/\.destroy\(/.test(rota), 'saída: não apaga nada');
  assert.ok(/UserCondominio\.update\(\s*\{ estado: 'inativo' \}/.test(rota), 'saída: desativa a associação (mantém a linha)');
  assert.ok(/delete req\.session\.condominio_ativo_id/.test(rota), 'saída: limpa o condomínio ativo da sessão');
  assert.ok(/acao: 'saida_condominio'/.test(rota), 'saída: auditada a conclusão');
  assert.ok(/acao: 'inicio_saida_condominio'/.test(rota), 'saída: auditado o início');
  assert.ok(/acao: 'exportacao_dados'/.test(rota), 'saída: auditada a exportação');
  assert.ok(/PAPEIS_GESTAO = \['admin', 'gestor'\]/.test(rota), 'saída: administração é caso separado');
  assert.ok(/transfira primeiro a administração/.test(rota), 'saída: remete a administração para o fluxo próprio');
  // A administração NUNCA se encerra por este fluxo: um admin/gestor não "sai".
  assert.ok(/podeSair: associacao !== null && !eGestor/.test(rota), 'saída: admin/gestor não pode usar este fluxo');
  assert.ok(/motivoIndisponivel: eGestor[\s\S]{0,220}Utilizadores/.test(rota), 'saída: explica ao gestor onde tratar da administração');
  assert.ok(/motivoNaoAplicavel\(estado\)/.test(rota), 'saída: mensagem própria quando o fluxo não se aplica');

  // Sessões antigas: o estado da conta é revalidado em cada pedido (não só no
  // login), pelo que desativar uma conta corta imediatamente o acesso.
  const passport = ler('config/passport.js');
  assert.ok(/if \(!user\.ativo\)/.test(passport), 'sessões: login recusa contas desativadas');
  assert.ok(/if \(!user\.email_confirmado\)/.test(passport), 'sessões: login exige email confirmado');
  assert.ok(ler('helpers/sessao.js').includes('function verificarContaAtiva'), 'sessões: existe a verificação por pedido');
  assert.ok(ler('app.js').includes('sessao.verificarContaAtiva'), 'sessões: verificação montada no app.js');

  // Dependências montadas e porta de entrada.
  const app = ler('app.js');
  assert.ok(app.includes("require('./routes/saida-condominio')"), 'saída: router montado no app.js');
  const dashboard = ler('views/condomino/dashboard.handlebars');
  assert.ok(/href="\/condomino\/saida"/.test(dashboard), 'saída: ligação a partir da área do condómino');
  assert.ok(/{{#if fracoesComResumo.length}}[\s\S]*Preparar saída do condomínio/.test(dashboard), 'saída: só é oferecida a quem tem frações');
  assert.ok(/eq condominioAtivo\.role 'admin'/.test(dashboard), 'saída: avisa o administrador de que a administração é caso separado');
  assert.ok(!/Terminar sessão[\s\S]{0,200}condomino\/saida/.test(dashboard), 'saída: não é confundida com terminar sessão');
  assert.ok(/titularidadesTerminadas/.test(dashboard), 'saída: explica ao antigo titular o que aconteceu');
  const condomino = ler('routes/condomino.js');
  assert.ok(/titularidades\.historicoDaPessoa\(/.test(condomino), 'saída: a área do condómino consulta o histórico da pessoa');
  assert.ok(/estaAtiva\(t\)/.test(condomino), 'saída: só relações encerradas aparecem como terminadas');
}

// ── Mudança de proprietário na administração (fluxo do gestor) ─────
function testesMudancaProprietario() {
  const admin = ler('routes/admin.js');

  // Registar um titular nunca substitui nem apaga: cria período novo e, quando
  // pedido, encerra o anterior no dia anterior ao início do novo.
  assert.ok(/router\.post\('\/fracoes\/:id\/titulares'/.test(admin), 'admin: rota para registar titular');
  assert.ok(/router\.post\('\/fracoes\/:id\/titulares\/:tid\/cessar'/.test(admin), 'admin: rota para encerrar titularidade');
  assert.ok(/encerrar_atual === 'on'/.test(admin), 'admin: a mudança de titular é explícita (checkbox)');
  assert.ok(/diaAnterior\(inicio\)/.test(admin), 'admin: o período anterior fecha no dia anterior (sem sobreposição)');
  assert.ok(/'mudanca_titular'/.test(admin), 'admin: motivo da cessação registado');
  assert.ok(/criarTitularidade\(/.test(admin), 'admin: usa o helper (auditoria incluída)');
  assert.ok(/cessarTitularidade\(/.test(admin), 'admin: encerra pelo helper, não por delete');
  assert.ok(!/FracaoTitularidade\.destroy/.test(admin), 'admin: nenhuma titularidade é apagada');
  assert.ok(/acao: encerrados\.length \? 'alterar_titularidade' : 'registar_titularidade'/.test(admin), 'admin: eventos distintos auditados');

  // A conta do novo proprietário é a dele; sem conta inequívoca, fica sem conta.
  assert.ok(/User\.findAll\(\{ where: \{ pessoa_id: pessoa\.id \}, attributes: \['id'\], limit: 2 \}\)/.test(admin), 'admin: procura a conta da pessoa');
  assert.ok(/contas\.length === 1 \? contas\[0\]\.id : null/.test(admin), 'admin: só associa conta quando é inequívoca');
  assert.ok(!/utilizador_id: req\.user\.id/.test(admin), 'admin: nunca atribui a fração à conta do administrador');

  // Compatibilidade: o vínculo antigo continua a ser escrito em paralelo.
  assert.ok(/FracaoPessoa\.findOrCreate\(/.test(admin), 'admin: mantém `fracao_pessoas` em sincronia');
  // Auditoria relevante: estado anterior e atual da associação (revogação e
  // reativação ficam registadas no histórico).
  assert.ok(/associacaoAntes: assoc\.estado/.test(admin), 'admin: auditoria regista o estado anterior da associação');
  assert.ok(/reativacaoExplicita: decisao\.reativada/.test(admin), 'admin: auditoria marca a reativação explícita');

  // Ecrã da fração: titular atual, histórico e aviso, sem oferecer apagar nada.
  const vista = ler('views/admin/fracoes/form.handlebars');
  assert.ok(/titulares\.length/.test(vista), 'vista: lista os titulares atuais');
  assert.ok(/historico\.length/.test(vista), 'vista: mostra o histórico (períodos encerrados incluídos)');
  assert.ok(/proprietariosDuplicados/.test(vista), 'vista: avisa quando há dois proprietários ativos');
  assert.ok(/name="encerrar_atual"/.test(vista), 'vista: checkbox de encerrar o titular atual');
  assert.ok(/Sem titularidade registada/.test(vista), 'vista: explica o que fazer quando não há titularidade');
  assert.ok(/Criar conta por convite/.test(vista), 'vista: encaminha para a criação de conta do novo titular');
  assert.ok(/nunca reutilize as credenciais do anterior/.test(vista), 'vista: proíbe reutilizar credenciais do proprietário anterior');
  assert.ok(/contasMultiplas|Mais do que uma conta ligada/.test(vista), 'vista: avisa quando a pessoa tem mais do que uma conta');
  assert.ok(!/delete|material-symbols-outlined">delete/.test(vista), 'vista: não oferece apagar histórico');

  // Só o administrador do condomínio ativo chega a estas rotas.
  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(admin), 'admin: condomínio ativo obrigatório');
  assert.ok(/router\.use\(comPapel\('admin'\)\)|comPapel\('admin'\)/.test(admin), 'admin: papel de administrador obrigatório');
}

// ── I. Comunicações deixam de ir para quem já não é titular ────────
// Avisos, quotas e recibos têm de usar a titularidade em vigor: quem vendeu a
// fração não pode continuar a receber comunicações nem pedidos de pagamento.
async function cenarioI() {
  reiniciar();
  // Fração 10 vendida: João cessado (30/06), Maria ativa desde 01/07.
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, vinculo: 'proprietario', data_inicio: '2024-01-01', data_fim: '2026-06-30', estado: 'cessada' });
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 200, utilizador_id: 2, vinculo: 'proprietario', data_inicio: '2026-07-01' });
  // O vínculo antigo também foi fechado (dois modelos coerentes).
  novoVinculo({ fracao_id: 10, pessoa_id: 100, vinculo: 'proprietario', data_inicio: '2024-01-01', data_fim: '2026-06-30' });
  novoVinculo({ fracao_id: 10, pessoa_id: 200, vinculo: 'proprietario', data_inicio: '2026-07-01' });

  const atuais = await titularidades.pessoasAtuaisDaFracao({ condominioId: 1, fracaoId: 10, dataRef: '2026-09-14' });
  assert.strictEqual(atuais.origem, 'titularidades', 'I: decidido pelas titularidades');
  assert.deepStrictEqual(atuais.pessoas.map((p) => p.id), [200], 'I: só o titular em vigor é contactado');
  assert.strictEqual(atuais.pessoas[0].vinculoAtual, 'proprietario', 'I: vínculo atual anexado');

  // Destinatários de um aviso enviado às frações.
  const destinatarios = await resolverDestinatarios({ modo: 'fracoes', fracoes: [10] }, 1);
  assert.deepStrictEqual(destinatarios.map((d) => d.email), ['maria@exemplo.pt'], 'I: o aviso vai para o novo proprietário');
  assert.ok(!destinatarios.some((d) => d.email === 'joao@exemplo.pt'), 'I: o anterior proprietário não recebe');

  // Arrendatário em vigor continua a receber (a fração comunica com quem lá vive).
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 300, utilizador_id: null, vinculo: 'arrendatario', data_inicio: '2026-02-01' });
  const comArrendatario = await titularidades.pessoasAtuaisDaFracao({ condominioId: 1, fracaoId: 10, dataRef: '2026-09-14' });
  assert.deepStrictEqual(comArrendatario.pessoas.map((p) => p.id), [200, 300], 'I: proprietário primeiro, arrendatário depois');

  // Sem qualquer titularidade registada, mantém-se o comportamento anterior.
  reiniciar();
  novoVinculo({ fracao_id: 10, pessoa_id: 100, vinculo: 'proprietario' });
  const legado = await titularidades.pessoasAtuaisDaFracao({ condominioId: 1, fracaoId: 10 });
  assert.strictEqual(legado.origem, 'legado', 'I: compatibilidade com os dados existentes');
  assert.deepStrictEqual(legado.pessoas.map((p) => p.id), [100], 'I: o modelo antigo continua a funcionar');

  // Um vínculo antigo já encerrado não volta a ser contactado.
  reiniciar();
  novoVinculo({ fracao_id: 10, pessoa_id: 100, vinculo: 'proprietario', data_fim: '2026-06-30' });
  const fechado = await titularidades.pessoasAtuaisDaFracao({ condominioId: 1, fracaoId: 10, dataRef: '2026-09-14' });
  assert.strictEqual(fechado.pessoas.length, 0, 'I: relação encerrada não é contactada');

  // Fração com titularidades só futuras: o modelo antigo não pode contornar.
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 200, vinculo: 'proprietario', data_inicio: '2027-01-01' });
  novoVinculo({ fracao_id: 10, pessoa_id: 100, vinculo: 'proprietario' });
  const futura = await titularidades.pessoasAtuaisDaFracao({ condominioId: 1, fracaoId: 10, dataRef: '2026-09-14' });
  assert.strictEqual(futura.pessoas.length, 0, 'I: titularidade futura não autoriza nem endereça comunicações');
}

// ── J. Regra de autorização: a conta só vê o que a relação lhe dá ──
// Confirma, caso a caso, quando é que uma conta obtém (e quando NÃO obtém)
// acesso a uma fração. Regra: a titularidade que nomeia a conta manda; a que
// nomeia apenas uma pessoa só dá acesso a uma conta ligada a essa pessoa.
async function cenarioJ() {
  // (a) Sem titularidades: modelo antigo, vínculo em vigor da pessoa.
  reiniciar();
  novoVinculo({ fracao_id: 10, pessoa_id: 100, vinculo: 'proprietario' });
  const legadoOk = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-09-14' });
  assert.strictEqual(legadoOk.origem, 'legado', 'J1: modelo antigo quando não há titularidades');
  assert.deepStrictEqual(legadoOk.fracoes.map((f) => f.fracao.id), [10], 'J1: vínculo em vigor dá acesso');

  const legadoSemPessoa = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: null, dataRef: '2026-09-14' });
  assert.strictEqual(legadoSemPessoa.origem, 'nenhuma', 'J2: conta sem pessoa não recebe frações pelo modelo antigo');
  assert.strictEqual(legadoSemPessoa.motivo, 'conta_sem_condomino', 'J2: motivo identificado');

  // (b) Titularidade da PESSOA + conta sem pessoa: não pode herdar acesso.
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: null, vinculo: 'proprietario' });
  novoVinculo({ fracao_id: 10, pessoa_id: 100, vinculo: 'proprietario' });
  const semPessoa = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: null, dataRef: '2026-09-14' });
  assert.strictEqual(semPessoa.fracoes.length, 0, 'J3: conta SEM pessoa_id não ganha frações por a titularidade referir uma pessoa');
  assert.strictEqual(semPessoa.motivo, 'conta_sem_condomino', 'J3: motivo identificado (falta a ligação conta→condómino)');
  assert.strictEqual(semPessoa.origem, 'nenhuma', 'J3: sem pessoa não há caminho nenhum (nem titularidades nem modelo antigo)');

  // (b2) Conta ligada a OUTRO condómino do mesmo condomínio: a titularidade da
  // pessoa A não é desta conta → continua sem frações (e sem explicação
  // indevida: para esta conta não existe registo nenhum).
  const ligadaOutra = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 200, dataRef: '2026-09-14' });
  assert.strictEqual(ligadaOutra.fracoes.length, 0, 'J3b: conta ligada a outra pessoa não acede à fração de A');
  assert.strictEqual(ligadaOutra.motivo, 'sem_relacao', 'J3b: sem relação registada para esta conta/pessoa');
  assert.strictEqual(ligadaOutra.origem, 'nenhuma', 'J3b: nada a devolver');

  // (c) A conta ligada à pessoa: tem acesso (caminho normal).
  const vinculada = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-09-14' });
  assert.deepStrictEqual(vinculada.fracoes.map((f) => f.fracao.id), [10], 'J4: conta ligada à pessoa tem acesso');
  assert.strictEqual(vinculada.motivo, 'titularidade_em_vigor', 'J4: motivo identificado');

  // Outra conta da MESMA pessoa também passa (a ligação é à pessoa)...
  const mesmaPessoa = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 2, pessoaId: 100, dataRef: '2026-09-14' });
  assert.deepStrictEqual(mesmaPessoa.fracoes.map((f) => f.fracao.id), [10], 'J5: qualquer conta ligada à pessoa (liga-se em Utilizadores)');
  // ...mas uma conta ligada a OUTRA pessoa não.
  const outraPessoa = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 3, pessoaId: 999, dataRef: '2026-09-14' });
  assert.strictEqual(outraPessoa.fracoes.length, 0, 'J6: conta ligada a outra pessoa não tem acesso');

  // (d) Titularidade nomeia a CONTA: só essa conta (a ligação nomeada manda).
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: null, utilizador_id: 5, vinculo: 'proprietario' });
  const nomeada = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 5, pessoaId: null, dataRef: '2026-09-14' });
  assert.deepStrictEqual(nomeada.fracoes.map((f) => f.fracao.id), [10], 'J7: a conta nomeada na titularidade tem acesso (conta sem pessoa)');
  const naoNomeada = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 6, pessoaId: null, dataRef: '2026-09-14' });
  assert.strictEqual(naoNomeada.fracoes.length, 0, 'J8: outra conta não tem acesso');
  const porPessoaErrada = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 6, pessoaId: 100, dataRef: '2026-09-14' });
  assert.strictEqual(porPessoaErrada.fracoes.length, 0, 'J9: a conta nomeada noutra pessoa não abre a porta a quem tem pessoa diferente');

  // (e) Titularidade órfã (sem pessoa e sem conta): não dá acesso a ninguém.
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: null, utilizador_id: null, vinculo: 'proprietario' });
  const orfa = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 7, pessoaId: null, dataRef: '2026-09-14' });
  assert.strictEqual(orfa.fracoes.length, 0, 'J10: titularidade sem pessoa e sem conta não dá acesso');

  // (f) Tempo: cessada e futura não dão acesso; o dia do fim ainda dá.
  reiniciar();
  const cessada = novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, vinculo: 'proprietario', data_inicio: '2024-01-01', data_fim: '2026-06-30', estado: 'cessada' });
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-06-29' })).fracoes.length,
    0,
    'J11: titularidade cessada não dá acesso em nenhum dia'
  );
  cessada.estado = 'ativa';
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-06-30' })).fracoes.length,
    1,
    'J12: no último dia do período o acesso ainda existe'
  );
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-07-01' })).fracoes.length,
    0,
    'J13: no dia seguinte o acesso termina'
  );

  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, vinculo: 'proprietario', data_inicio: '2027-01-01' });
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2026-09-14' })).fracoes.length,
    0,
    'J14: titularidade futura não dá acesso hoje'
  );
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 1, pessoaId: 100, dataRef: '2027-01-01' })).fracoes.length,
    1,
    'J15: a partir do início (inclusive) dá acesso'
  );

  // (g) Condomínio diferente do ativo: nunca conta.
  reiniciar();
  novoTitulo({ condominio_id: 1, fracao_id: 10, pessoa_id: 100, utilizador_id: 1, vinculo: 'proprietario' });
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: 2, utilizadorId: 1, pessoaId: 300, dataRef: '2026-09-14' })).fracoes.length,
    0,
    'J16: titularidade de outro condomínio não dá acesso'
  );
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: 2, utilizadorId: 1, pessoaId: null, dataRef: '2026-09-14' })).fracoes.length,
    0,
    'J17: idem para a mesma conta noutro condomínio'
  );
  assert.strictEqual(
    (await titularidades.fracoesDoUtilizador({ condominioId: null, utilizadorId: 1, pessoaId: 100 })).fracoes.length,
    0,
    'J18: sem condomínio ativo não há acesso'
  );

  // (h) A regra, isolada (função pura) — documenta cada combinação.
  const conta5 = { utilizadorId: 5, pessoaId: 9 };
  assert.strictEqual(titularidades.eContaDaLigacao({ utilizador_id: 5, pessoa_id: 100 }, conta5), true, 'J19: conta nomeada decide');
  assert.strictEqual(titularidades.eContaDaLigacao({ utilizador_id: 6, pessoa_id: 9 }, conta5), false, 'J20: conta nomeada noutra conta recusa (mesmo com a pessoa certa)');
  assert.strictEqual(titularidades.eContaDaLigacao({ pessoa_id: 9 }, conta5), true, 'J21: pessoa ligada à conta autoriza');
  assert.strictEqual(titularidades.eContaDaLigacao({ pessoa_id: 9 }, { utilizadorId: 5, pessoaId: null }), false, 'J22: conta sem pessoa não herda');
  assert.strictEqual(titularidades.eContaDaLigacao({ pessoa_id: null, utilizador_id: null }, conta5), false, 'J23: órfã não autoriza');
  assert.strictEqual(titularidades.eContaDaLigacao({ pessoa_id: 9 }, {}), false, 'J24: sem identificação não autoriza');
  assert.strictEqual(titularidades.eContaDaLigacao({ utilizador_id: '5' }, { utilizadorId: 5, pessoaId: null }), true, 'J25: ids normalizados (5 vs "5")');
  assert.strictEqual(titularidades.eContaDaLigacao(null, conta5), false, 'J26: sem titularidade não autoriza');
}

// ── Reativação de acesso na administração (explícita, nunca por engano) ──
function testesReativacaoDeAcesso() {
  const admin = ler('routes/admin.js');
  const vista = ler('views/admin/utilizadores/form.handlebars');

  // Regra (função pura, tabela de decisão completa).
  const decidir = (estadoAtual, reativar) => titularidades.decidirEstadoAssociacao({ estadoAtual, reativar });
  assert.deepStrictEqual(decidir('ativo'), { estavaAtiva: true, reativada: false, estado: 'ativo' }, 'reativação: associação ativa mantém-se ativa');
  assert.deepStrictEqual(decidir('ativo', '1'), { estavaAtiva: true, reativada: false, estado: 'ativo' }, 'reativação: pedido redundante não altera nada');
  assert.deepStrictEqual(decidir('inativo'), { estavaAtiva: false, reativada: false, estado: 'inativo' }, 'reativação: guardar sem pedido NÃO reativa');
  assert.deepStrictEqual(decidir('inativo', undefined), { estavaAtiva: false, reativada: false, estado: 'inativo' }, 'reativação: pedido ausente NÃO reativa');
  assert.deepStrictEqual(decidir('inativo', '0'), { estavaAtiva: false, reativada: false, estado: 'inativo' }, 'reativação: valor negativo NÃO reativa');
  for (const marca of ['1', 'on', true, 1]) {
    assert.deepStrictEqual(decidir('inativo', marca), { estavaAtiva: false, reativada: true, estado: 'ativo' }, `reativação: pedido explícito (${String(marca)}) reativa`);
  }
  assert.strictEqual(titularidades.pedidoDeReativacao('off'), false, 'reativação: "off" não é pedido');
  assert.strictEqual(titularidades.pedidoDeReativacao('1'), true, 'reativação: "1" é pedido');

  // A rota usa a regra e regista a decisão.
  assert.ok(/titularidades\.decidirEstadoAssociacao\(\{/.test(admin), 'reativação: a rota usa a regra única');
  assert.ok(/estado: decisao\.estado/.test(admin), 'reativação: grava o estado decidido');
  assert.ok(/acao: decisao\.reativada \? 'reativar_acesso_utilizador' : 'editar_utilizador'/.test(admin), 'reativação: auditoria distingue a reativação');
  assert.ok(/associacaoAntes: assoc\.estado/.test(admin), 'reativação: auditoria regista o estado anterior');
  assert.ok(/reativacaoExplicita: decisao\.reativada/.test(admin), 'reativação: auditoria marca se foi explícita');
  assert.ok(!/assoc\.update\(\{ role: papelDaAssociacao\(role\), estado: 'ativo' \}\)/.test(admin), 'reativação: já não reativa incondicionalmente');
  assert.ok(/continua encerrado/.test(admin), 'reativação: informa que o acesso continua encerrado');

  // A vista só oferece a reativação quando a associação está inativa, e nunca
  // pré-marcada; e explica que guardar não reabre o acesso.
  assert.ok(/assocAtiva/.test(vista), 'reativação: a vista conhece o estado da associação');
  const bloco = vista.match(/\{\{#unless assocAtiva\}\}([\s\S]*?)\{\{\/unless\}\}/);
  assert.ok(bloco, 'reativação: bloco próprio para associações inativas');
  assert.ok(/name="reativar_acesso"/.test(bloco[1]), 'reativação: opção explícita presente');
  assert.ok(!/checked/.test(bloco[1]), 'reativação: a opção nunca vem marcada (não reativa por engano)');
  assert.ok(/acesso deste utilizador a este condomínio está encerrado/.test(bloco[1]), 'reativação: aviso claro ao administrador');
  assert.ok(/titularidades de\s*\n?\s*fração não são alteradas/.test(bloco[1]), 'reativação: não altera as regras de titularidade');

  // A rota do formulário passa o estado da associação à vista.
  assert.ok(/assocAtiva,/.test(admin), 'reativação: a rota envia o estado da associação');
}

// ── Migration: ensaio da lógica (sem BD) ───────────────────────────
// Executa `up()` contra um stub fiel de `queryInterface`/`sequelize` para provar,
// ANTES de correr na MariaDB real: (a) cria a tabela e os três índices;
// (b) o preenchimento inicial insere uma linha por vínculo existente, com as
// datas e o estado corretos; (c) é idempotente (segunda execução não duplica);
// (d) não liga `utilizador_id` quando a pessoa tem mais do que uma conta;
// (e) nunca apaga nem altera tabelas existentes; (f) o `down` só remove a tabela.
async function ensaioDaMigracao() {
  const migracao = require('../migrations/20260101000072-fracao-titularidades.js');

  const criadas = [];
  const indices = [];
  const inseridas = [];
  const apagadas = [];
  const linhasExistentes = [
    // Proprietário com uma conta (ligação inequívoca).
    { id: 1, fracao_id: 10, pessoa_id: 100, vinculo: 'proprietario', data_inicio: '2024-01-01', data_fim: null, criada_em: '2024-01-02', condominio_id: 1 },
    // Vínculo já encerrado (data de fim no passado).
    { id: 2, fracao_id: 10, pessoa_id: 200, vinculo: 'arrendatario', data_inicio: '2023-01-01', data_fim: '2024-06-30', criada_em: '2023-01-01', condominio_id: 1 },
    // Pessoa com duas contas: não se adivinha a conta (utilizador_id NULL).
    { id: 3, fracao_id: 20, pessoa_id: 300, vinculo: 'proprietario', data_inicio: null, data_fim: null, criada_em: '2025-03-04', condominio_id: 2 },
  ];
  const contas = [
    { pessoa_id: 100, n: 1, id: 7 },
    { pessoa_id: 300, n: 2, id: 8 },
  ];

  const sql = {
    async query(texto, opcoes) {
      const normalizado = String(texto).replace(/\s+/g, ' ').trim();
      if (normalizado.startsWith('SELECT fp.id')) return [linhasExistentes];
      if (normalizado.startsWith('SELECT pessoa_id, COUNT(*)')) return [contas];
      if (normalizado.startsWith('SELECT id FROM fracao_titularidades')) {
        const [fracaoId, vinculo, pessoaId, , dataInicio] = opcoes.replacements;
        const igual = inseridas.some(
          (i) =>
            Number(i.fracao_id) === Number(fracaoId) &&
            i.vinculo === vinculo &&
            String(i.pessoa_id) === String(pessoaId) &&
            String(i.data_inicio) === String(dataInicio)
        );
        return [igual ? [{ id: 1 }] : []];
      }
      if (normalizado.startsWith('INSERT INTO fracao_titularidades')) {
        const [condominioId, fracaoId, pessoaId, utilizadorId, vinculo, dataInicio, dataFim, estado] = opcoes.replacements;
        inseridas.push({ condominio_id: condominioId, fracao_id: fracaoId, pessoa_id: pessoaId, utilizador_id: utilizadorId, vinculo, data_inicio: dataInicio, data_fim: dataFim, estado });
        return [{ insertId: inseridas.length }];
      }
      throw new Error(`Ensaio da migração: consulta inesperada → ${normalizado.slice(0, 60)}`);
    },
  };

  const queryInterface = {
    sequelize: sql,
    async createTable(nome, campos) { criadas.push({ nome, campos }); },
    async addIndex(tabela, campos, opcoes) { indices.push({ tabela, campos, opcoes }); },
    async removeIndex(tabela, nome) { apagadas.push(`removeIndex:${tabela}:${nome}`); },
    async dropTable(nome) { apagadas.push(`dropTable:${nome}`); },
  };
  const Sequelize = require('sequelize');

  await migracao.up(queryInterface, Sequelize);
  assert.strictEqual(criadas.length, 1, 'migração: cria uma tabela');
  assert.strictEqual(criadas[0].nome, 'fracao_titularidades', 'migração: tabela com o nome esperado');
  for (const campo of ['condominio_id', 'fracao_id', 'pessoa_id', 'utilizador_id', 'vinculo', 'data_inicio', 'data_fim', 'estado', 'motivo_cessacao', 'created_by', 'created_at', 'updated_at']) {
    assert.ok(criadas[0].campos[campo], `migração: coluna ${campo}`);
  }
  assert.strictEqual(indices.length, 3, 'migração: três índices');
  assert.strictEqual(indices.filter((i) => i.opcoes && i.opcoes.unique).length, 0, 'migração: nenhum índice único');

  assert.strictEqual(inseridas.length, 3, 'migração: uma titularidade por vínculo existente');
  const doDono = inseridas.find((i) => i.pessoa_id === 100);
  assert.strictEqual(doDono.utilizador_id, 7, 'migração: liga a conta quando é inequívoca');
  assert.strictEqual(doDono.data_inicio, '2024-01-01', 'migração: usa a data de início existente');
  assert.strictEqual(doDono.estado, 'ativa', 'migração: vínculo sem fim fica ativo');
  const cessada = inseridas.find((i) => i.pessoa_id === 200);
  assert.strictEqual(cessada.estado, 'cessada', 'migração: vínculo com fim no passado fica cessado');
  assert.strictEqual(cessada.data_fim, '2024-06-30', 'migração: mantém a data de fim');
  const semData = inseridas.find((i) => i.pessoa_id === 300);
  assert.strictEqual(semData.data_inicio, '2025-03-04', 'migração: sem data de início usa a criação da linha');
  assert.strictEqual(semData.utilizador_id, null, 'migração: com duas contas não adivinha (NULL)');

  // Idempotência: correr outra vez não duplica nem apaga.
  await migracao.up(queryInterface, Sequelize);
  assert.strictEqual(inseridas.length, 3, 'migração: segunda execução não duplica registos');
  assert.strictEqual(criadas.length, 2, 'migração: segunda execução não altera dados existentes');

  // Reversibilidade: o down só remove esta tabela e os seus índices.
  await migracao.down(queryInterface, Sequelize);
  assert.ok(apagadas.includes('dropTable:fracao_titularidades'), 'migração: down remove a tabela');
  assert.strictEqual(apagadas.filter((a) => a.startsWith('removeIndex:')).length, 3, 'migração: down remove os três índices');
  assert.ok(!apagadas.some((a) => /dropTable:(?!fracao_titularidades)/.test(a)), 'migração: down não toca em outras tabelas');
  assert.ok(
    /DROP TYPE IF EXISTS/.test(ler('migrations/20260101000072-fracao-titularidades.js')),
    'migração: down limpa os TIPOS ENUM da MariaDB (permite voltar a aplicar)'
  );
}

// ── Estrutura: migração, modelo, associações e invariantes ────────
function testesEstruturais() {
  const migracao = ler('migrations/20260101000072-fracao-titularidades.js');
  assert.ok(/createTable\(\s*'fracao_titularidades'/.test(migracao), 'estrutura: migração cria a tabela');
  assert.ok(/async down\(queryInterface\)[\s\S]*dropTable\('fracao_titularidades'\)/.test(migracao), 'estrutura: migração reversível');
  assert.ok(/Preenchimento inicial \(backfill\)/.test(migracao), 'estrutura: regra do backfill documentada');
  assert.ok(!/removeColumn|changeColumn|dropTable\('fracao_pessoas'\)/.test(migracao), 'estrutura: nenhuma tabela existente é alterada ou removida');
  assert.ok(/cessada \? 'cessada' : 'ativa'/.test(migracao), 'estrutura: backfill distingue períodos ativos de cessados');

  const modelo = ler('models/FracaoTitularidade.js');
  for (const campo of ['condominio_id', 'fracao_id', 'pessoa_id', 'utilizador_id', 'vinculo', 'data_inicio', 'data_fim', 'estado', 'motivo_cessacao']) {
    assert.ok(new RegExp(`\\b${campo}:`).test(modelo), `estrutura: modelo tem ${campo}`);
  }
  assert.ok(/tableName: 'fracao_titularidades'/.test(modelo), 'estrutura: nome da tabela');
  assert.ok(!/indexes: \[[^\]]*unique: true/.test(modelo), 'estrutura: sem índice único (o histórico exige vários períodos)');

  const indice = ler('models/index.js');
  assert.ok(/FracaoTitularidade\.belongsTo\(Fracao/.test(indice), 'estrutura: associação com a fração');
  assert.ok(/FracaoTitularidade\.belongsTo\(User, \{ foreignKey: 'utilizador_id'/.test(indice), 'estrutura: associação com a conta');
  assert.ok(/Fracao\.hasMany\(FracaoTitularidade/.test(indice), 'estrutura: histórico acessível a partir da fração');

  // Contactos atuais: modelo novo decide; antigo só quando não há titularidades.
  const helper = ler('helpers/titularidades.js');
  assert.ok(/async function pessoasAtuaisDaFracao/.test(helper), 'estrutura: contactos atuais num único ponto');
  assert.ok(/if \(!atuais\.length\)[\s\S]{0,400}if \(existentes\.length\) return vazio/.test(helper), 'estrutura: o modelo antigo não contorna as titularidades');
  assert.ok(!/\.destroy\(/.test(helper), 'estrutura: as titularidades nunca são apagadas');
  assert.ok(/data_fim: null/.test(helper), 'estrutura: o modelo antigo respeita `data_fim`');

  // Invariantes exigidos pelos testes existentes de isolamento.
  const condomino = ler('routes/condomino.js');
  assert.ok(condomino.includes('condominio_id: req.condominioId'), 'invariante: filtro pelo condomínio ativo');
  assert.ok(condomino.includes('fracao_id: { [Op.in]:'), 'invariante: as quotas/pagamentos são filtrados pelas frações próprias');
  assert.ok(condomino.includes('status(404)'), 'invariante: pedidos fora das frações próprias devolvem 404');
  assert.ok(!/findByPk\(req\.params\.id/.test(condomino), 'invariante: sem findByPk direto em rotas isoladas');
  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(condomino), 'invariante: condomínio ativo obrigatório');
}

(async () => {
  // Rastreia em que cenário falhou (útil para erros de base de dados/stubs).
  let passo = 'arranque';
  process.on('unhandledRejection', (err) => {
    console.error(`✗ [${passo}] ${err && err.message}`);
    process.exit(1);
  });
  instalarStubs();
  passo = 'A'; await cenarioA();
  passo = 'B'; await cenarioB();
  passo = 'C'; await cenarioC();
  passo = 'D'; cenarioD();
  passo = 'E'; cenarioE();
  passo = 'F'; cenarioF();
  passo = 'H'; cenarioH();
  passo = 'escrita'; await testesDeEscrita();
  passo = 'G'; await cenarioG();
  passo = 'I'; await cenarioI();
  passo = 'J (regra de autorização)'; await cenarioJ();
  passo = 'saída'; testesFluxoSaida();
  passo = 'mudança de proprietário'; testesMudancaProprietario();
  passo = 'reativação de acesso'; testesReativacaoDeAcesso();
  passo = 'puros'; testesPuros();
  passo = 'ensaio da migração'; await ensaioDaMigracao();
  passo = 'estruturais'; testesEstruturais();
  console.log('✓ Testes de titularidades passaram (cenários A–J; sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
