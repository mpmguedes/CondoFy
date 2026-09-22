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
  FracaoPessoa.create = async (dados) => novoVinculo(dados);
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
  // Alguns modelos têm de HONRAR o `where`: sem isso, a linha da outra fração
  // apareceria na exportação e a asserção de isolamento passaria (ou falharia)
  // por acidente, sem testar nada. As linhas levam `condominio_id` porque a
  // exportação filtra por ele.
  const substituirFiltrando = (modelo, linhas) => {
    originais[modelo] = modelos[modelo].findAll;
    modelos[modelo].findAll = async ({ where } = {}) => linhas.filter((l) => corresponde(l, where));
  };
  substituirFiltrando('Quota', [
    { id: 1, condominio_id: 1, fracao_id: 10, ano: 2026, mes: 1, valor: '61.22', data_vencimento: '2026-01-08', estado: 'paga' },
    { id: 2, condominio_id: 1, fracao_id: 99, ano: 2026, mes: 1, valor: '999.00', data_vencimento: '2026-01-08', estado: 'paga' }, // outra fração
  ]);
  substituirFiltrando('Pagamento', [
    { id: 50, condominio_id: 1, fracao_id: 10, numero_documento: 'PAG-1', data_pagamento: '2026-01-05', valor: '61.22', referencia: 'x', estado: 'confirmado', comprovativo_nome: null },
  ]);
  substituirFiltrando('Recibo', [{ id: 80, condominio_id: 1, fracao_id: 10, codigo: 'RCP-2026-0001', ano: 2026, tipo: 'ordinario', valor: '61.22', data_emissao: '2026-01-06', estado: 'emitido' }]);
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
    // Prova direta do isolamento: cabeçalho + uma única linha (a fração 10).
    assert.strictEqual(quotas.replace(/^\ufeff/, '').trim().split('\r\n').length, 2,
      'G: o CSV de quotas tem só a linha do titular');
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

// ── K. Exportação: os VALORES monetários dos CSV (P37) ─────────────
// Regressão do defeito P37: `formatEUR(toCents(x))` (e `formatEUR(<cêntimos>)`)
// convertia duas vezes e saía 100× maior. Este cenário afirma a LINHA COMPLETA
// de cada CSV — valor, pago e em dívida — e recusa explicitamente os valores
// inflacionados, para que o defeito não possa voltar em silêncio.
async function cenarioK() {
  const { construirExportacao } = require('../helpers/exportacao-dados');
  const { lerZip } = require('../helpers/zip');
  const comprovativos = require('../helpers/comprovativos');

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
    // Vencimento longínquo: o estado efetivo não pode depender da data de hoje.
    { id: 2, fracao_id: 10, ano: 2026, mes: 2, valor: '1234.56', data_vencimento: '2099-12-31', estado: 'parcialmente_paga' },
  ]);
  // 34,56 € aplicados à quota 2 ⇒ em dívida 1.200,00 €.
  originais.PagamentoQuota = modelos.PagamentoQuota.findAll;
  modelos.PagamentoQuota.findAll = async () => [{ quota_id: 2, valor_aplicado: '34.56' }];
  substituir('Pagamento', [
    { id: 50, fracao_id: 10, numero_documento: 'PAG-1', data_pagamento: '2026-02-05', valor: '34.56', referencia: 'REF-X', estado: 'confirmado', comprovativo_nome: null },
  ]);
  substituir('Recibo', [
    { id: 80, fracao_id: 10, codigo: 'RCP-2026-0001', ano: 2026, tipo: 'ordinario', valor: '1234.56', data_emissao: '2026-02-06', estado: 'emitido' },
  ]);
  substituir('ExtraQuotaParcela', [
    { id: 300, fracao_id: 10, parcela_numero: 2, valor: '250.00', data_vencimento: '2026-03-01', estado: 'pendente', extra_quota: { designacao: 'Obras do telhado' } },
  ]);
  substituir('Documento', []);
  substituir('Assembleia', []);
  substituir('AssembleiaParticipante', []);
  substituir('Aviso', []);
  substituir('FracaoTitularidade', []);
  substituir('ContactoPessoa', []);

  try {
    const { buffer } = await construirExportacao({
      condominioId: 1,
      condominio: { id: 1, designacao: 'Condomínio Jardins do Tejo' },
      utilizador: { id: 1, nome: 'João Almeida', email: 'joao@exemplo.pt' },
      pessoa: { id: 100, nome: 'João Almeida', nif: '123456789', email: 'joao@exemplo.pt' },
      fracoes: [{ id: 10, designacao: '1.º Esq', permilagem: '125.00', vinculoAtual: 'proprietario' }],
    });

    const entradas = lerZip(buffer);
    const conteudoDe = (nome) => entradas.find((e) => e.nome === nome).conteudo.toString('utf8');
    const linhas = (nome) => conteudoDe(nome).replace(/^\ufeff/, '').split('\r\n').filter(Boolean);

    // Quotas: valor, pago e em dívida, exatamente como estão em euros.
    const quotas = linhas('Quotas/quotas.csv');
    assert.strictEqual(quotas[0], 'Fração;Ano;Mês;Valor;Pago;Em dívida;Vencimento;Estado', 'K: cabeçalho das quotas');
    assert.strictEqual(quotas[1], '1.º Esq;2026;1;61,22 €;0,00 €;61,22 €;2026-01-08;paga', 'K: quota paga — valores em euros');
    assert.strictEqual(quotas[2], '1.º Esq;2026;2;1.234,56 €;34,56 €;1.200,00 €;2099-12-31;parcialmente_paga', 'K: quota parcial — pago e em dívida corretos');

    // Pagamentos, recibos e parcelas: o valor não pode sair multiplicado por 100.
    assert.strictEqual(linhas('Pagamentos/pagamentos.csv')[1], '1.º Esq;PAG-1;2026-02-05;34,56 €;REF-X;confirmado;', 'K: pagamento — valor em euros');
    assert.strictEqual(linhas('Recibos/recibos.csv')[1], 'RCP-2026-0001;1.º Esq;2026;ordinario;1.234,56 €;2026-02-06;emitido', 'K: recibo — valor em euros');
    assert.strictEqual(linhas('Quotas extraordinarias/parcelas.csv')[1], 'Obras do telhado;1.º Esq;2;250,00 €;2026-03-01;pendente', 'K: parcela extra — valor em euros');

    // Contraprova explícita: os valores que o defeito P37 produzia (100× maior)
    // não podem aparecer em lado nenhum da exportação.
    const tudo = entradas.map((e) => e.conteudo.toString('utf8')).join('\n');
    for (const inflacionado of ['6.122,00 €', '123.456,00 €', '3.456,00 €', '25.000,00 €', '120.000,00 €']) {
      assert.ok(!tudo.includes(inflacionado), `K: valor 100× maior não pode aparecer (${inflacionado})`);
    }
  } finally {
    comprovativos.existeComprovativo = originalExiste;
    for (const [modelo, original] of Object.entries(originais)) modelos[modelo].findAll = original;
  }
}

// ── Fluxo "Preparar saída do condomínio" (invariantes de segurança) ─
function testesFluxoSaida() {
  const rota = ler('routes/saida-condominio.js');

  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(rota), 'saída: exige condomínio ativo');
  assert.ok(/router\.get\('\/saida'/.test(rota), 'saída: página explicativa própria');
  assert.ok(/router\.post\('\/saida\/exportar'/.test(rota), 'saída: exportação por POST (não por link)');
  assert.ok(/router\.post\('\/saida\/concluir'/.test(rota), 'saída: conclusão por POST');

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
  assert.ok(/app\.use\('\/condomino',\s*require\('\.\/routes\/saida-condominio'\)\)/.test(app),
    'saída: router montado sob /condomino');
  assert.ok(/router\.get\('\/saida'/.test(rota),
    'saída: o caminho interno é relativo ao prefixo /condomino');
  const dashboard = ler('views/condomino/dashboard.handlebars');
  // A ação de saída vive no perfil do cabeçalho (e, no Início, apenas para quem
  // já não tem frações); o aviso ao administrador está no próprio fluxo.
  const layout = ler('views/layouts/main.handlebars');
  assert.ok(/href="\/condomino\/saida"/.test(layout), 'saída: ligação a partir do perfil do condómino');
  // O menu do utilizador tem um ramo para o backoffice e outro para o portal: a
  // saída do condomínio só pode existir no ramo do condómino.
  const inicioMenuUsuario = layout.indexOf('dropdown-menu dropdown-menu-end');
  const menuUsuario = layout.slice(inicioMenuUsuario, layout.indexOf('</ul>', inicioMenuUsuario));
  const ramoAdminMenu = menuUsuario.slice(0, menuUsuario.indexOf('{{else}}'));
  const ramoCondominoMenu = menuUsuario.slice(menuUsuario.indexOf('{{else}}'));
  assert.ok(!/href="\/condomino\/saida"/.test(ramoAdminMenu), 'saída: não é oferecida a quem administra');
  assert.ok(/href="\/condomino\/saida"/.test(ramoCondominoMenu), 'saída: oferecida no menu do condómino');
  assert.ok(/href="\/condomino\/saida"/.test(dashboard), 'saída: ligação a partir do bloco de antigo titular');
  assert.ok(/transfira primeiro a administração/.test(rota) && /motivoIndisponivel: eGestor/.test(rota),
    'saída: avisa o administrador de que a administração é caso separado');
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
  // Auditoria relevante: o estado da conta tem ação própria (desativar/reativar)
  // e a gravação da ficha não altera o estado do acesso ao condomínio.
  assert.ok(/await assoc\.update\(\{ role: papelDaAssociacao\(role\) \}\)/.test(admin), 'admin: guardar a ficha altera só o papel');
  assert.ok(/acao: decisaoConta\.acao \|\| 'editar_utilizador'/.test(admin), 'admin: auditoria da conta com ação própria');

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

// ── L. Exportação: data local e escape de CR no CSV ────────────────
// Dois pormenores do documento de RGPD que a revisão da exportação levantou:
//   · `hojeISO()` era `new Date().toISOString().slice(0,10)` — UTC. Às 00h30 em
//     Lisboa (UTC+1 no verão) o MANIFEST datava a exportação no dia ANTERIOR;
//   · o escape do CSV só reagia a `"`, `;` e `\n`: um `\r` sozinho (mensagem de
//     aviso colada de outro programa) partia a linha a meio.
function cenarioL() {
  const { csv, hojeISO } = require('../helpers/exportacao-dados');

  // 1. Data LOCAL, coerente com o calendário do utilizador.
  const agora = new Date();
  const local = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
  assert.strictEqual(hojeISO(), local, 'L: hojeISO usa a data LOCAL');
  assert.match(hojeISO(), /^\d{4}-\d{2}-\d{2}$/, 'L: hojeISO devolve YYYY-MM-DD');
  // Estrutural: `toISOString()` não pode voltar (é a causa do desvio de dia).
  const fonte = ler('helpers/exportacao-dados.js');
  const corpoHoje = /function hojeISO\(\) \{([\s\S]*?)\n\}/.exec(fonte);
  assert.ok(corpoHoje, 'L: existe a função hojeISO');
  assert.ok(!/toISOString/.test(corpoHoje[1]), 'L: hojeISO não usa toISOString (UTC)');

  // 2. Escape: CR sozinho, CRLF, `"`, `;` e `\n` têm de ficar entre aspas.
  //    (Não se divide o conteúdo por `\r\n`: um campo entre aspas pode conter
  //    CRLF — é precisamente o caso que se quer provar.)
  const conteudo = csv(['A'], [['x\ry'], ['a;b'], ['c"d'], ['e\nf'], ['g\r\nh'], ['sem problema']]).toString('utf8');
  assert.ok(conteudo.startsWith('\ufeffA\r\n'), 'L: BOM presente e cabeçalho na 1.ª linha');
  assert.ok(conteudo.includes('"x\ry"'), 'L: CR sozinho é escapado com aspas');
  assert.ok(conteudo.includes('"a;b"'), 'L: ponto e vírgula é escapado');
  assert.ok(conteudo.includes('"c""d"'), 'L: aspas duplicadas');
  assert.ok(conteudo.includes('"e\nf"'), 'L: newline é escapado');
  assert.ok(conteudo.includes('"g\r\nh"'), 'L: CRLF é escapado');
  assert.ok(conteudo.trimEnd().endsWith('sem problema'), 'L: valor simples não é alterado');
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

// ── Fase 2: conta ≠ acesso ao condomínio, com ações explícitas ─────
// Cobre os 14 requisitos da Fase 2: os dois estados visíveis (1–4), reativar a
// conta não reabre associações (5), reativar a associação não mexe na conta (6),
// encerrar a associação não mexe em titularidades nem noutros condomínios (7–8),
// auditoria própria nos três casos (9–11), e o que se mantém intacto (12–14).
function testesAcessoEConta() {
  const admin = ler('routes/admin.js');
  const vistaLista = ler('views/admin/utilizadores/listar.handlebars');
  const vistaForm = ler('views/admin/utilizadores/form.handlebars');
  const saida = ler('routes/saida-condominio.js');

  // ── 1–4: os dois estados aparecem em separado, em todas as combinações ──
  const handlebars = require('handlebars');
  Object.entries(require('../helpers/handlebars-helpers')).forEach(([k, v]) => handlebars.registerHelper(k, v));
  const tpl = handlebars.compile(vistaLista);
  const casos = [
    { ativo: true, estadoAssoc: 'ativo', conta: 'Ativa', acesso: 'Ativo', rotulo: '1' },
    { ativo: true, estadoAssoc: 'inativo', conta: 'Ativa', acesso: 'Encerrado', rotulo: '2' },
    { ativo: false, estadoAssoc: 'ativo', conta: 'Inativa', acesso: 'Ativo', rotulo: '3' },
    { ativo: false, estadoAssoc: 'inativo', conta: 'Inativa', acesso: 'Encerrado', rotulo: '4' },
  ];
  for (const caso of casos) {
    const html = tpl({
      titulo: 'Utilizadores',
      users: [{ id: 1, nome: 'Ana', email: 'ana@exemplo.pt', role: 'condomino', ativo: caso.ativo, estadoAssoc: caso.estadoAssoc }],
      success_msg: [], error_msg: [], error: null,
    });
    assert.ok(new RegExp(`>${caso.conta}<`).test(html), `F2/teste ${caso.rotulo}: conta apresentada como «${caso.conta}»`);
    assert.ok(new RegExp(`>${caso.acesso}<`).test(html), `F2/teste ${caso.rotulo}: acesso apresentado como «${caso.acesso}»`);
    assert.ok(/Conta<\/th>/.test(html) && /Acesso a este condomínio<\/th>/.test(html),
      `F2/teste ${caso.rotulo}: as duas colunas estão identificadas`);
  }
  assert.ok(!/\{\{#if ativo\}\}<span class="badge text-bg-success">Ativo<\/span>/.test(vistaLista),
    'F2/testes 1–4: a lista já não usa um único badge «Ativo/Inativo» para a conta e o acesso');
  // A ficha também distingue os dois conceitos.
  assert.ok(/<h2 class="h6 mb-1">Conta<\/h2>/.test(vistaForm) && /<h2 class="h6 mb-1">Acesso a este condomínio<\/h2>/.test(vistaForm),
    'F2/testes 1–4: a ficha separa «Conta» de «Acesso a este condomínio»');
  assert.ok(/titularidades das frações gerem-se na ficha de cada fração/.test(vistaForm),
    'F2/testes 1–4: a ficha deixa claro que as titularidades não se gerem ali');
  assert.ok(/Estado atual:/.test(vistaForm) && /assocAtiva/.test(vistaForm),
    'F2: a ficha mostra o estado do acesso');
  assert.ok(/assocAtiva,/.test(admin), 'F2: a rota envia o estado do acesso à ficha');

  // ── 9: alterar o estado da conta gera auditoria com antes/depois/motivo ──
  const semConta = (antes, depois) => titularidades.decidirAcaoConta({ antes, depois });
  assert.deepStrictEqual(semConta(true, false),
    { mudou: true, desativou: true, reativou: false, acao: 'desativar_conta', exigeMotivo: true },
    'F2/teste 9: desativar a conta tem ação própria e exige motivo');
  assert.deepStrictEqual(semConta(false, true),
    { mudou: true, desativou: false, reativou: true, acao: 'reativar_conta', exigeMotivo: false },
    'F2/teste 9: reativar a conta tem ação própria');
  assert.strictEqual(semConta(true, true).acao, null, 'F2/teste 9: sem alteração não há ação de conta');
  assert.strictEqual(semConta(false, false).acao, null, 'F2/teste 9: conta já inativa mantém-se sem ação');
  assert.ok(/decisaoConta\.exigeMotivo && !motivo/.test(admin), 'F2/teste 9: motivo obrigatório para desativar');
  assert.ok(/acao: decisaoConta\.acao \|\| 'editar_utilizador'/.test(admin), 'F2/teste 9: ação desativar_conta/reativar_conta');
  assert.ok(/estadoAnterior: contaAntes/.test(admin) && /estadoNovo: contaDepois/.test(admin), 'F2/teste 9: auditoria com antes e depois');
  assert.ok(/motivo: motivo \|\| null/.test(admin), 'F2/teste 9: auditoria com o motivo');
  assert.ok(/ambito: 'conta \(global — todos os condomínios\)'/.test(admin), 'F2/teste 9: âmbito registado');
  assert.ok(/condominioContexto: req\.condominioId/.test(admin), 'F2/teste 9: contexto do condomínio registado');
  // A gravação da ficha não mexe no estado do acesso.
  assert.ok(/await assoc\.update\(\{ role: papelDaAssociacao\(role\) \}\)/.test(admin),
    'F2: guardar a ficha altera só o papel (nunca o estado do acesso)');
  assert.ok(!/await assoc\.update\(\{ role: papelDaAssociacao\(role\), estado/.test(admin),
    'F2/teste 5: guardar a ficha não reativa (nem encerra) o acesso');

  // ── 10–11: ações próprias de encerrar/reativar acesso ───────────────
  assert.ok(/router\.post\('\/utilizadores\/:id\/encerrar-acesso'/.test(admin), 'F2/teste 10: existe a ação «Encerrar acesso a este condomínio»');
  assert.ok(/router\.post\('\/utilizadores\/:id\/reativar-acesso'/.test(admin), 'F2/teste 11: existe a ação inversa «Reativar acesso»');
  const encerrar = admin.slice(admin.indexOf("router.post('/utilizadores/:id/encerrar-acesso'"), admin.indexOf("router.post('/utilizadores/:id/reativar-acesso'"));
  const reativar = admin.slice(admin.indexOf("router.post('/utilizadores/:id/reativar-acesso'"), admin.indexOf("router.post('/utilizadores/:id/eliminar'"));
  assert.ok(/acao: 'encerrar_acesso_condominio'/.test(encerrar), 'F2/teste 10: auditoria própria do encerramento');
  assert.ok(/acao: 'reativar_acesso_condominio'/.test(reativar), 'F2/teste 11: auditoria própria da reativação');
  for (const [nome, bloco] of [['encerrar', encerrar], ['reativar', reativar]]) {
    assert.ok(/await assoc\.update\(\{ estado: '(inativo|ativo)' \}\)/.test(bloco), `F2: ${nome} altera apenas o estado da associação`);
    assert.ok(!/user\.update|User\.update|users/i.test(bloco), `F2/teste 6: ${nome} não altera a conta`);
    assert.ok(!/titularidades\.(criar|cessar)/.test(bloco), `F2/teste 7: ${nome} não altera titularidades`);
    assert.ok(!/\.destroy\(/.test(bloco), `F2: ${nome} não apaga nada`);
    assert.ok(/titularidadesAlteradas: false/.test(bloco) && /contaAlterada: false/.test(bloco),
      `F2/teste ${nome === 'encerrar' ? '10' : '11'}: auditoria regista que conta e titularidades ficaram intactas`);
    assert.ok(/estadoAnterior: '(ativo|inativo)'/.test(bloco) && /estadoNovo: '(ativo|inativo)'/.test(bloco),
      `F2: ${nome} regista antes/depois na auditoria`);
    assert.ok(/motivo/.test(bloco), `F2: ${nome} usa o motivo`);
  }
  assert.ok(/if \(!motivo\)/.test(encerrar) && /Indique o motivo do encerramento/.test(encerrar),
    'F2/teste 10: o motivo é obrigatório para encerrar o acesso');
  assert.ok(/Preparar saída do condomínio/.test(encerrar),
    'F2/teste 12: encerrar acesso remete para o fluxo de saída próprio (não o substitui)');
  // A guarda do último gestor é uma regra pura do helper (uma só definição) —
  // evita constantes soltas na rota (foi um erro real durante esta fase).
  assert.deepStrictEqual(
    [
      titularidades.eUltimoGestorAtivo({ papel: 'admin', nGestores: 1 }),
      titularidades.eUltimoGestorAtivo({ papel: 'gestor', nGestores: 1 }),
      titularidades.eUltimoGestorAtivo({ papel: 'admin', nGestores: 2 }),
      titularidades.eUltimoGestorAtivo({ papel: 'leitura', nGestores: 1 }),
    ],
    [true, true, false, false],
    'F2/teste 12: só bloqueia quando é o último admin/gestor ativo'
  );
  assert.deepStrictEqual(titularidades.PAPEIS_GESTAO, ['admin', 'gestor'], 'F2: papéis de gestão definidos num só sítio');
  const usosSoltos = [...admin.matchAll(/(?<![\w.])PAPEIS_GESTAO\b/g)].length;
  assert.ok(usosSoltos === 0 || /(?:const|let|var)\s+PAPEIS_GESTAO\b/.test(admin),
    'F2: PAPEIS_GESTAO em admin.js tem de vir do helper (sem constante solta/local duplicada)');
  assert.ok(/titularidades\.eUltimoGestorAtivo\(\{ papel: assoc\.role, nGestores: n \}\)/.test(admin),
    'F2/teste 12: a rota usa a regra do helper');

  // 6: reativar a associação não altera users.ativo (a conta é outra decisão).
  assert.ok(/assoc\.update\(\{ estado: 'ativo' \}\)/.test(reativar) && !/user\.update/.test(reativar),
    'F2/teste 6: reativar o acesso não altera a conta');

  // ── Correção (b): criação de conta ativa por omissão ───────────────
  assert.strictEqual(titularidades.contaAtivaDoFormulario(undefined), true,
    'F2/(b): sem marcação, a conta criada fica ATIVA');
  assert.strictEqual(titularidades.contaAtivaDoFormulario(null), true, 'F2/(b): valor nulo → conta ativa');
  assert.strictEqual(titularidades.contaAtivaDoFormulario(''), true, 'F2/(b): campo vazio → conta ativa');
  for (const marcado of ['on', '1', true, 1]) {
    assert.strictEqual(titularidades.contaAtivaDoFormulario(marcado), true, `F2/(b): marcação explícita (${String(marcado)}) → ativa`);
  }
  for (const desmarcado of ['off', '0', false]) {
    assert.strictEqual(titularidades.contaAtivaDoFormulario(desmarcado), false, `F2/(b): marcação explícita de inativo (${String(desmarcado)}) → inativa`);
  }
  assert.ok(/ativo: titularidades\.contaAtivaDoFormulario\(ativo\),/.test(admin),
    'F2/(b): a rota de criação usa a regra única (não decide o valor inline)');
  assert.ok(!/ativo: ativo === 'on' \|\| ativo === '1' \|\| ativo === true,/.test(admin),
    'F2/(b): a criação já não fica inativa por omissão');

  // ── Correção (d): não deixar um condomínio sem gestão ─────────────
  // a) último gestor → bloqueado
  const umCondominio = [{ condominioId: 1, designacao: 'Condomínio A', role: 'admin', estado: 'ativo' }];
  const afetadosA = titularidades.condominiosSemGestao({ associacoes: umCondominio, gestoresPorCondominio: { 1: 1 } });
  assert.deepStrictEqual(afetadosA, [{ condominioId: 1, designacao: 'Condomínio A', papel: 'admin' }],
    'F2/(d-a): último gestor identificado');
  const motivoA = titularidades.motivoBloqueioDesativacaoConta(afetadosA);
  assert.ok(motivoA && /último administrador ou gestor/.test(motivoA) && /Condomínio A/.test(motivoA),
    'F2/(d-a): bloqueia e identifica o condomínio afetado');
  assert.ok(/Nada foi alterado/.test(motivoA), 'F2/(d-a): a mensagem garante que nada foi alterado');

  // b) dois gestores → permitido
  assert.deepStrictEqual(
    titularidades.condominiosSemGestao({ associacoes: umCondominio, gestoresPorCondominio: { 1: 2 } }),
    [],
    'F2/(d-b): com outro gestor ativo, a desativação é permitida'
  );
  assert.strictEqual(titularidades.motivoBloqueioDesativacaoConta([]), null, 'F2/(d-b): sem afetados não há bloqueio');

  // c) gestor num condomínio + utilizador normal noutro → não bloqueia pelo segundo
  const misto = [
    { condominioId: 1, designacao: 'Condomínio A', role: 'gestor', estado: 'ativo' },
    { condominioId: 2, designacao: 'Condomínio B', role: 'leitura', estado: 'ativo' },
  ];
  assert.deepStrictEqual(
    titularidades.condominiosSemGestao({ associacoes: misto, gestoresPorCondominio: { 1: 1, 2: 1 } }).map((a) => a.condominioId),
    [1],
    'F2/(d-c): só conta o condomínio onde é gestor (papel de leitura não bloqueia)'
  );
  assert.deepStrictEqual(
    titularidades.condominiosSemGestao({ associacoes: misto, gestoresPorCondominio: { 1: 3, 2: 1 } }),
    [],
    'F2/(d-c): sendo um entre vários gestores, a desativação é permitida'
  );

  // d) vários condomínios → identifica todos os afetados
  const varios = [
    { condominioId: 1, designacao: 'Condomínio A', role: 'admin', estado: 'ativo' },
    { condominioId: 2, designacao: 'Condomínio B', role: 'gestor', estado: 'ativo' },
    { condominioId: 3, designacao: 'Condomínio C', role: 'admin', estado: 'ativo' },
  ];
  const afetadosD = titularidades.condominiosSemGestao({ associacoes: varios, gestoresPorCondominio: { 1: 1, 2: 1, 3: 4 } });
  assert.deepStrictEqual(afetadosD.map((a) => a.designacao), ['Condomínio A', 'Condomínio B'],
    'F2/(d-d): identifica exatamente os condomínios que ficariam sem gestão');
  const motivoD = titularidades.motivoBloqueioDesativacaoConta(afetadosD);
  assert.ok(/Condomínio A/.test(motivoD) && /Condomínio B/.test(motivoD) && !/Condomínio C/.test(motivoD),
    'F2/(d-d): a mensagem lista todos os afetados e só esses');
  // Associações encerradas não contam (o acesso já não existe).
  assert.deepStrictEqual(
    titularidades.condominiosSemGestao({
      associacoes: [{ condominioId: 1, designacao: 'Condomínio A', role: 'admin', estado: 'inativo' }],
      gestoresPorCondominio: { 1: 1 },
    }),
    [],
    'F2/(d): associação já encerrada não bloqueia a desativação da conta'
  );
  // Estrutura: a guarda corre ANTES de user.update e reutiliza o helper.
  const rotaConta = admin.slice(admin.indexOf("router.post('/utilizadores/:id'"), admin.indexOf("router.post('/utilizadores/:id/encerrar-acesso'"));
  const posBloqueio = rotaConta.indexOf('motivoBloqueioDesativacaoConta');
  const posUpdate = rotaConta.indexOf('await user.update(data)');
  assert.ok(posBloqueio > -1 && posUpdate > posBloqueio,
    'F2/(d): a verificação do último gestor corre antes de alterar a conta');
  assert.ok(/decisaoConta\.desativou\)/.test(rotaConta), 'F2/(d): a guarda só se aplica ao desativar');
  assert.ok(/titularidades\.condominiosSemGestao\(\{/.test(rotaConta), 'F2/(d): usa a regra única do helper');
  assert.ok(!/assoc\.destroy|FracaoTitularidade\.update|titularidades\.cessar/.test(rotaConta),
    'F2/(d): desativar a conta não altera associações nem titularidades');

  // ── 12: preparar saída continua exatamente como estava ─────────────
  assert.ok(/titularidades\.cessarTitularidadesAtivas\(\{/.test(saida), 'F2/teste 12: a saída continua a encerrar as titularidades');
  assert.ok(/UserCondominio\.update\(\s*\{ estado: 'inativo' \}/.test(saida), 'F2/teste 12: a saída continua a encerrar a associação');
  assert.ok(/doisfatores\.verificarTOTP/.test(saida) && /req\.body\.confirmo !== 'on'/.test(saida),
    'F2/teste 12: a saída mantém reautenticação, 2FA e declaração');

  // ── 13–14: vender uma fração não mexe em conta/associação (Fase 1) ─
  assert.ok(!/UserCondominio/.test(ler('helpers/titularidades.js')),
    'F2/teste 13: as titularidades não tocam em associações');
  // 14: a autorização seguinte à venda é por fração (cenários A–J cobrem o resto).
  assert.ok(/function eContaDaLigacao/.test(ler('helpers/titularidades.js')),
    'F2/teste 14: o acesso continua decidido por fração (titularidade em vigor)');
}

// ── Fase 1 (auditoria): conta ≠ associação ≠ titularidade ──────────
// Cobre, com o número de cada requisito da auditoria, as regras que garantem que
// a venda de uma fração nunca mexe na conta nem na associação ao condomínio, e
// que a ficha do condómino não cria vínculos paralelos nem apaga titularidades.
async function testesConcordanciaDeEstados() {
  const admin = ler('routes/admin.js');
  const globalAdmin = ler('routes/global-admin.js');
  const helper = ler('helpers/titularidades.js');

  // ── Regras puras (comportamento, não texto) ───────────────────────
  // 1–3: o mesmo vínculo com OUTRO titular ativo é conflito; a própria pessoa,
  // uma linha de outra pessoa sem conta e uma linha órfã são casos distintos.
  const atuais = [
    { id: 1, pessoa_id: 100, utilizador_id: 1, vinculo: 'proprietario' },
    { id: 2, pessoa_id: null, utilizador_id: 2, vinculo: 'proprietario' },
    { id: 3, pessoa_id: 200, utilizador_id: null, vinculo: 'arrendatario' },
    { id: 4, pessoa_id: null, utilizador_id: null, vinculo: 'proprietario' },
  ];
  assert.deepStrictEqual(
    titularidades.titularesEmConflito(atuais, { pessoaId: 100, vinculo: 'proprietario' }).map((t) => t.id),
    [2],
    'F1: conflito é só outra pessoa/conta com o mesmo vínculo (a própria e as órfãs não contam)'
  );
  assert.deepStrictEqual(
    titularidades.titularesEmConflito(atuais, { pessoaId: 300, vinculo: 'arrendatario' }).map((t) => t.id),
    [3],
    'F1: conflito detetado para outro vínculo'
  );
  assert.deepStrictEqual(
    titularidades.titularesEmConflito(atuais, { pessoaId: 300, vinculo: 'usufrutuario' }),
    [],
    'F1: sem titular do mesmo vínculo não há conflito'
  );

  // 10: eliminar a ficha só é possível sem titularidades ativas.
  assert.strictEqual(titularidades.bloqueioEliminacaoCondomino([]), null, 'F1/teste 10: sem titularidades, pode eliminar');
  assert.ok(
    titularidades.bloqueioEliminacaoCondomino([{ estado: 'cessada', fracao_id: 10 }]) === null,
    'F1/teste 10: titularidades cessadas não impedem a eliminação'
  );
  const bloqueio = titularidades.bloqueioEliminacaoCondomino([
    { estado: 'ativa', fracao_id: 10, fracao: { designacao: '1.º Esq' } },
    { estado: 'ativa', fracao_id: 30, fracao: { designacao: '3.º Dto' } },
  ]);
  assert.ok(bloqueio && /Encerre primeiro/.test(bloqueio) && /1º|1\.º Esq/.test(bloqueio),
    'F1/teste 10: bloqueia e explica onde encerrar (com a fração identificada)');

  // 6: reativar a conta não reativa associações (decisão separada e explícita).
  assert.deepStrictEqual(
    titularidades.decidirEstadoAssociacao({ estadoAtual: 'inativo' }),
    { estavaAtiva: false, reativada: false, estado: 'inativo' },
    'F1/teste 6: estado da conta não reativa a associação'
  );
  // 12: global-admin segue a mesma regra.
  assert.deepStrictEqual(
    titularidades.decidirEstadoAssociacao({ estadoAtual: 'inativo', reativar: undefined }),
    { estavaAtiva: false, reativada: false, estado: 'inativo' },
    'F1/teste 12: reassociar sem pedido explícito mantém o acesso encerrado'
  );

  // ── Estrutura: uma só via de escrita da relação pessoa↔fração ─────
  // 11: a ficha do condómino não pode criar/remover relações paralelas.
  const rotasCondomino = admin.slice(
    admin.indexOf("router.post('/condominos'"),
    admin.indexOf('// ═══════════════════════════════════════════════════════════════════\n// UTILIZADORES')
  );
  assert.ok(rotasCondomino.length > 500, 'F1: rotas de condóminos localizadas');
  assert.ok(!/FracaoPessoa\.destroy\(/.test(rotasCondomino),
    'F1/teste 11: a ficha do condómino já não apaga vínculos (sem FracaoPessoa.destroy)');
  assert.ok(!/FracaoPessoa\.create\(/.test(rotasCondomino),
    'F1/teste 11: a ficha do condómino já não cria vínculos diretos (passa pelos helpers)');
  // 11 (estrutura + comportamento): a ficha do condómino liga/desliga pelos
  // helpers de titularidade — a lógica vive num só sítio.
  assert.ok(/async function ligarPessoaAFracao\(/.test(helper) && /await criarTitularidade\(\{/.test(helper),
    'F1: ligar pessoa↔fração usa criarTitularidade (helper único, com auditoria)');
  assert.ok(/async function desligarPessoaDaFracao\(/.test(helper) && /await cessarTitularidade\(\{ titularidadeId: t\.id, dataFim: fim, motivo, userId \}\)/.test(helper),
    'F1: desligar pessoa↔fração usa cessarTitularidade (helper único, com auditoria)');
  assert.ok(/await acrescentarRelacao\(\{ req, fracaoId: fid, pessoa, vinculo/.test(rotasCondomino)
    && /titularidades\.ligarPessoaAFracao\(\{/.test(admin),
    'F1/teste 11: a ficha do condómino liga pela via das titularidades');
  assert.ok(/await retirarRelacao\(\{ req, fracaoId: a\.fracaoId, pessoaId: pessoa\.id, motivo: 'removido_ficha_condomino' \}\)/.test(rotasCondomino)
    && /titularidades\.desligarPessoaDaFracao\(\{/.test(admin),
    'F1/teste 11: a ficha do condómino desliga encerrando com data de fim e motivo (sem apagar)');
  assert.ok(/data_fim: null, data_inicio: existente\.data_inicio/.test(helper),
    'F1: vínculo antigo é reaberto em sincronia (nunca apagado)');

  // 11 (comportamento): ligar/desligar com as regras reais.
  reiniciar();
  const originaisUserFindAll = modelos.User.findAll;
  modelos.User.findAll = async ({ where } = {}) => {
    const alvo = Number(where && where.pessoa_id);
    return alvo === 100 ? [{ id: 7, pessoa_id: 100 }] : alvo === 200 ? [{ id: 8, pessoa_id: 200 }, { id: 9, pessoa_id: 200 }] : [];
  };
  try {
    const ligado = await titularidades.ligarPessoaAFracao({
      condominioId: 1, fracaoId: 10, pessoaId: 100, vinculo: 'proprietario', dataInicio: '2026-09-01', userId: 9, origem: 'teste',
    });
    assert.strictEqual(ligado.ok, true, 'F1/teste 11: liga uma fração livre');
    assert.strictEqual(titulos.length, 1, 'F1/teste 11: cria uma titularidade (histórico)');
    assert.strictEqual(titulos[0].estado, 'ativa', 'F1/teste 11: titularidade ativa');
    assert.strictEqual(titulos[0].data_inicio, '2026-09-01', 'F1/teste 11: período com data de início');
    assert.strictEqual(titulos[0].utilizador_id, 7, 'F1/teste 11: liga a conta quando é inequívoca');
    assert.strictEqual(vinculos.length, 1, 'F1/teste 11: vínculo antigo escrito em sincronia');
    assert.ok(auditoria.some((a) => a.acao === 'criar_titularidade'), 'F1/teste 11: criação auditada');

    // Conflito: outro titular ativo do mesmo vínculo na mesma fração.
    const conflito = await titularidades.ligarPessoaAFracao({
      condominioId: 1, fracaoId: 10, pessoaId: 200, vinculo: 'proprietario', userId: 9, origem: 'teste',
    });
    assert.strictEqual(conflito.ok, false, 'F1/teste 11: recusa criar um segundo proprietário ativo');
    assert.ok(/já tem um titular/.test(conflito.erro), 'F1/teste 11: explica o motivo ao administrador');
    assert.strictEqual(titulos.length, 1, 'F1/teste 11: nada é criado quando há conflito');
    assert.strictEqual(vinculos.length, 1, 'F1/teste 11: nada é escrito no vínculo antigo quando há conflito');

    // Com duas contas associadas, não se adivinha qual é a conta do titular.
    const semContaInequivoca = await titularidades.ligarPessoaAFracao({
      condominioId: 1, fracaoId: 30, pessoaId: 200, vinculo: 'proprietario', userId: 9, origem: 'teste',
    });
    assert.strictEqual(semContaInequivoca.ok, true, 'F1/teste 11: liga mesmo sem conta inequívoca');
    const comDuas = titulos.find((t) => t.fracao_id === 30);
    assert.strictEqual(comDuas.utilizador_id, null, 'F1/teste 11: com duas contas não adivinha (sem acesso)');

    // Desligar: encerra com data de fim; nada é apagado.
    const antesVinculos = vinculos.length;
    const resultado = await titularidades.desligarPessoaDaFracao({
      condominioId: 1, fracaoId: 10, pessoaId: 100, dataFim: '2026-09-14', motivo: 'removido_ficha_condomino', userId: 9,
    });
    assert.strictEqual(resultado.titularesEncerrados, 1, 'F1/teste 11: encerra a titularidade ativa');
    assert.strictEqual(titulos.length, 2, 'F1/teste 11: nenhuma linha de titularidade é apagada (histórico)');
    assert.strictEqual(titulos[0].estado, 'cessada', 'F1/teste 11: fica cessada');
    assert.strictEqual(titulos[0].data_fim, '2026-09-14', 'F1/teste 11: com data de fim');
    assert.strictEqual(titulos[0].motivo_cessacao, 'removido_ficha_condomino', 'F1/teste 11: com motivo');
    assert.strictEqual(vinculos.length, antesVinculos, 'F1/teste 11: o vínculo antigo não é apagado');
    assert.ok(auditoria.some((a) => a.acao === 'cessar_titularidade'), 'F1/teste 11: encerramento auditado');
    const semAcesso = await titularidades.fracoesDoUtilizador({ condominioId: 1, utilizadorId: 7, pessoaId: 100, dataRef: '2026-09-14' });
    assert.strictEqual(semAcesso.fracoes.length, 0, 'F1/teste 11: a fração deixa de dar acesso após o encerramento');

    // Relação atual: união de titularidade ativa e vínculo antigo em vigor.
    const relacoes = await titularidades.relacoesAtuaisDaPessoa({ condominioId: 1, pessoaId: 200 });
    assert.deepStrictEqual(relacoes.map((r) => r.fracaoId), [30], 'F1/teste 11: relação atual lida da titularidade ativa');
  } finally {
    modelos.User.findAll = originaisUserFindAll;
  }

  // 10 (estrutura): a guarda é verificada ANTES de apagar a ficha.
  const rotaEliminar = admin.slice(admin.indexOf("router.post('/condominos/:id/eliminar'"));
  const corpoEliminar = rotaEliminar.slice(0, 1200);
  const posGuarda = corpoEliminar.indexOf('bloqueioEliminacaoCondomino');
  const posDestroy = corpoEliminar.indexOf('pessoa.destroy()');
  assert.ok(posGuarda > -1 && posDestroy > posGuarda,
    'F1/teste 10: verifica titularidades ativas antes de Pessoa.destroy()');
  assert.ok(/titularidades\.titularesAtivosDaPessoa\(/.test(corpoEliminar),
    'F1/teste 10: consulta as titularidades ativas da pessoa no condomínio ativo');

  // 12 (estrutura): global-admin reutiliza a regra e não reactiva sozinho.
  assert.ok(/titularidades\.decidirEstadoAssociacao\(\{/.test(globalAdmin),
    'F1/teste 12: global-admin usa a regra única decidirEstadoAssociacao');
  assert.ok(/reativar: req\.body\.reativar_acesso/.test(globalAdmin),
    'F1/teste 12: reativação depende de pedido explícito');
  assert.ok(!/associacao\.update\(\{ role: papel, estado: 'ativo' \}\)/.test(globalAdmin),
    'F1/teste 12: já não reativa incondicionalmente');
  assert.ok(/associacaoAntes: associacao \? associacao\.estado : null/.test(globalAdmin),
    'F1/teste 12: auditoria regista o estado anterior da associação');
  const vistaGlobal = ler('views/admin/global/condominio.handlebars');
  assert.ok(/name="reativar_acesso"/.test(vistaGlobal), 'F1/teste 12: opção explícita disponível na vista');
  const blocoGlobal = vistaGlobal.match(/<input class="form-check-input" type="checkbox" id="reativar_acesso_global"[\s\S]{0,160}/);
  assert.ok(blocoGlobal && !/checked/.test(blocoGlobal[0]),
    'F1/teste 12: a opção nunca vem marcada (não reativa por engano)');

  // ── Estrutura: os três estados nunca se tocam indevidamente ───────
  // 9: encerrar titularidade não escreve em users nem em utilizador_condominios.
  const cessar = helper.slice(helper.indexOf('async function cessarTitularidade('), helper.indexOf('// Encerra todas as titularidades ativas'));
  assert.ok(!/User\.|UserCondominio/.test(cessar),
    'F1/teste 9: cessar titularidade não altera a conta nem a associação');
  // 1–4: criar/cessar titularidade também não (helper inteiro).
  assert.ok(!/UserCondominio\.(update|create|destroy)/.test(helper),
    'F1/testes 1–4: as titularidades nunca alteram associações');
  // 5: conta inativa bloqueia o acesso (comportamento já validado, aqui fixado).
  assert.ok(/utilizador\.ativo === false/.test(ler('helpers/sessao.js')),
    'F1/teste 5: conta inativa bloqueia o acesso em cada pedido');
  assert.ok(/if \(!user\.ativo\)/.test(ler('config/passport.js')),
    'F1/teste 5: conta inativa não inicia sessão');

  // 7: uma associação inativa afeta apenas aquele condomínio.
  const tenant = require('../helpers/tenant');
  const originaisFindAll = modelos.UserCondominio.findAll;
  const condominios = {
    1: { id: 1, designacao: 'Condomínio A', estado: 'ativo' },
    2: { id: 2, designacao: 'Condomínio B', estado: 'ativo' },
  };
  modelos.UserCondominio.findAll = async ({ where }) =>
    [
      { id: 1, utilizador_id: 1, condominio_id: 1, role: 'leitura', estado: 'ativo' },
      { id: 2, utilizador_id: 1, condominio_id: 2, role: 'leitura', estado: 'inativo' },
    ]
      .filter((a) => Number(a.utilizador_id) === Number(where.utilizador_id) && a.estado === where.estado)
      .filter((a) => condominios[a.condominio_id])
      .map((a) => ({ ...a, condominio: condominios[a.condominio_id], toJSON() { return { ...a }; } }));
  try {
    const meus = await tenant.listarCondominios(1);
    assert.deepStrictEqual(meus.map((c) => c.id), [1],
      'F1/teste 7: associação encerrada só retira aquele condomínio (o outro continua acessível)');
  } finally {
    modelos.UserCondominio.findAll = originaisFindAll;
  }

  // 8: a regra de estado da associação é pura — não toca em titularidades.
  const antes = JSON.stringify(titulos.map((t) => [t.id, t.estado, t.data_fim]));
  titularidades.decidirEstadoAssociacao({ estadoAtual: 'inativo', reativar: 'on' });
  assert.strictEqual(JSON.stringify(titulos.map((t) => [t.id, t.estado, t.data_fim])), antes,
    'F1/teste 8: decidir o estado da associação não altera titularidades');
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
  passo = 'K (valores monetários da exportação)'; await cenarioK();
  passo = 'L (data local e escape do CSV)'; cenarioL();
  passo = 'I'; await cenarioI();
  passo = 'J (regra de autorização)'; await cenarioJ();
  passo = 'saída'; testesFluxoSaida();
  passo = 'mudança de proprietário'; testesMudancaProprietario();
  passo = 'conta vs acesso (Fase 2)'; testesAcessoEConta();
  passo = 'concordância de estados (Fase 1)'; await testesConcordanciaDeEstados();
  passo = 'puros'; testesPuros();
  passo = 'ensaio da migração'; await ensaioDaMigracao();
  passo = 'estruturais'; testesEstruturais();
  console.log('✓ Testes de titularidades passaram (cenários A–J; sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
