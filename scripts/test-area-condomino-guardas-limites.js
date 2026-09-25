// Guardas de associação (D3) e limites das listas (C3) no portal do condómino.
// Sem base de dados. Utilização: node scripts/test-area-condomino-guardas-limites.js
//
// PORQUÊ ESTE TESTE EXISTE
//
// D3 — antes desta correção, `contextoFracoes` (routes/condomino.js) descartava
// o `motivo`/`origem` que `helpers/titularidades.fracoesDoUtilizador` JÁ calcula,
// colapsando quatro estados distintos num só par (`pessoa = null`,
// `fracoes = []`). Duas páginas — `/orcamento` e `/situacao-financeira` — nem
// tinham guarda nenhuma: mostravam «0,00 € / 0 %» e «Saldo das contas 0,00 €»
// como se fossem dados reais, indistinguíveis de um zero verdadeiro.
//
// C3 — sete listas do portal cresciam sem fim (`/quotas`, `/pagamentos`,
// `/recibos`, `/assembleias`, `/calendario` ×2, `/documentos`). Não existe
// paginação em nenhuma rota da aplicação; a convenção do projeto é um limite
// fixo por consulta (o próprio `/avisos` já usava `limit: 100`).
//
// MÉTODO (duas provas independentes, como manda a convenção do projeto):
//   A. VISTAS — renderizadas diretamente, provando o HTML de cada estado.
//   B. ROUTER — a rota REAL corre contra duplos que IMITAM a base de dados:
//      guardam linhas reais (de mais do que um condomínio) e aplicam-lhes o
//      `where`, o `order` e o `limit`. Um duplo que devolvesse só o pedido
//      passaria sempre; este tem de reproduzir a BD para ser credível.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

Object.entries(require('../helpers/handlebars-helpers')).forEach(([k, v]) => handlebars.registerHelper(k, v));
const partialsDir = path.join(RAIZ, 'views', 'partials');
for (const entry of fs.readdirSync(partialsDir)) {
  if (entry.endsWith('.handlebars')) {
    handlebars.registerPartial(entry.replace('.handlebars', ''), fs.readFileSync(path.join(partialsDir, entry), 'utf8'));
  }
}
const render = (rel, ctx) => handlebars.compile(ler(rel))(ctx);
const colapsar = (s) => s.replace(/\s+/g, ' ');

const resultados = [];
function titulo(t) { console.log(`\n── ${t}`); }
function ok(nome) { resultados.push(nome); console.log(`  ✓ ${nome}`); }

// ══════════════════════════════════════════════════════════════════
// A. VISTAS — estados de associação (D3) e aviso de lista limitada (C3)
// ══════════════════════════════════════════════════════════════════
const ACESSOS = {
  sem_condominio: {
    motivo: 'sem_condominio', origem: 'nenhuma',
    curto: 'Esta conta não está associada a nenhum condómino neste condomínio.',
    detalhe: 'Se acha que é um engano, contacte a administração do condomínio.',
  },
  conta_sem_condomino: {
    motivo: 'conta_sem_condomino', origem: 'nenhuma',
    curto: 'A sua conta ainda não está associada a um condómino neste condomínio.',
    detalhe: 'Contacte a administração do condomínio para associar a sua conta.',
  },
  sem_relacao: {
    motivo: 'sem_relacao', origem: 'nenhuma',
    curto: 'Não tem frações associadas neste condomínio.',
    detalhe: 'Se é proprietário, arrendatário ou usufrutuário de uma fração, peça à administração para registar a relação.',
  },
  sem_ligacao_a_conta: {
    motivo: 'sem_ligacao_a_conta', origem: 'titularidades',
    curto: 'Existem frações associadas a si, mas esta conta ainda não está ligada a elas.',
    detalhe: 'Contacte a administração do condomínio para ligar a sua conta às suas frações.',
  },
};

const PESSOA = { id: 10, nome: 'Ana Silva' };

// Cada página do portal: vista + contexto mínimo com dados a mostrar.
const PAGINAS = [
  { nome: 'orcamento.handlebars', vista: 'views/condomino/orcamento.handlebars', ctx: { ano: 2026, anoAtual: 2026, orcamento: { ano: 2026 }, linhas: [], totais: { orcamentado: 0, executado: 0, saldo: 0, percentagem: 0 } } },
  { nome: 'situacao-financeira.handlebars', vista: 'views/condomino/situacao-financeira.handlebars', ctx: { ano: 2026, condominio: { designacao: 'C' }, resumo: { saldoContas: 0, receitasAno: 0, despesasAno: 0, totalQuotas: 0, pagoQuotas: 0, emDivida: 0, cobrancaPct: 0, nFracoes: 0, nFracoesEmAtraso: 0, contas: [], fundoReserva: 0 }, orcamento: { orcamentado: 0, executado: 0 }, saldoOrcamento: 0, movimentos: [], temMovimentos: false, mesesComMovimentos: 0, minhasFracoes: [], temDivida: false, temDadosFinanceiros: false } },
  { nome: 'recibos.handlebars', vista: 'views/condomino/recibos.handlebars', ctx: { linhas: [{ id: 1, codigo: 'X', valor: 10, estado: 'emitido', data_emissao: '2026-01-01' }], nRecibos: 1, temVariasFracoes: false } },
  { nome: 'pagamentos.handlebars', vista: 'views/condomino/pagamentos.handlebars', ctx: { linhas: [{ id: 1, valor: 10, data_pagamento: '2026-01-01' }] } },
  { nome: 'documentos.handlebars', vista: 'views/condomino/documentos.handlebars', ctx: { pastas: {}, anos: [], anoFiltro: null, nDocumentos: 1, documentos: [{ id: 1, nome: 'A.pdf', data: '2026-01-01' }], agrupados: [] } },
  { nome: 'avisos.handlebars', vista: 'views/condomino/avisos.handlebars', ctx: { avisos: [{ id: 1, assunto: 'Obras', createdAt: '2026-01-01', mensagem: 'x' }], nAvisos: 1, nPorPublicar: 0, filtroTipo: null } },
  { nome: 'assembleias.handlebars', vista: 'views/condomino/assembleias.handlebars', ctx: { proxima: { id: 1, data: '2026-12-01', estadoRotulo: 'Convocada', estadoClasse: 'text-bg-info', estadoVariante: 'estado-requer-config' }, outrasFuturas: [], passadas: [] } },
  { nome: 'calendario.handlebars', vista: 'views/condomino/calendario.handlebars', ctx: { eventos: [{ data: '2026-12-01', tipo: 'assembleia', tipoRotulo: 'Assembleia', titulo: 'A', link: '/x' }], proximo: { data: '2026-12-01', tipo: 'assembleia', tipoRotulo: 'Assembleia', titulo: 'A', link: '/x' }, proximos: [], passados: [] } },
  { nome: 'quotas.handlebars', vista: 'views/condomino/quotas.handlebars', ctx: { resumoAno: [], extras: [], anos: [], filtros: {}, hoje: '2026-09-20', currentMonth: 9 } },
];

console.log('\nGuardas de associação (D3) e limites das listas (C3) — portal do condómino');

titulo('A1. Toda a página do portal distingue «conta sem condómino» de «com frações»');
for (const p of PAGINAS) {
  // Sem estado de acesso mas COM pessoa e dados: a página segue o seu caminho
  // normal (nenhuma mensagem de associação).
  const normal = colapsar(render(p.vista, { ...p.ctx, pessoa: PESSOA, acesso: null, listaTruncada: false }));
  assert.ok(!/não está associada a um condómino|não está ligada a um condómino|Não tem frações associadas/i.test(normal),
    `${p.nome}: com frações não mostra mensagem de associação`);
  // Com estado de acesso: mostra a mensagem correspondente.
  const semConta = colapsar(render(p.vista, { ...p.ctx, pessoa: null, acesso: ACESSOS.conta_sem_condomino, listaTruncada: false }));
  assert.ok(semConta.includes(ACESSOS.conta_sem_condomino.curto),
    `${p.nome}: conta sem condómino mostra a mensagem própria`);
  ok(`${p.nome}: distingue os estados`);
}

titulo('A2. Os quatro estados são DIFERENTES entre si (não um texto genérico)');
{
  const vista = 'views/condomino/orcamento.handlebars';
  const ctx = PAGINAS[0].ctx;
  const textos = Object.values(ACESSOS).map((a) => colapsar(render(vista, { ...ctx, pessoa: null, acesso: a, listaTruncada: false })));
  for (let i = 0; i < textos.length; i += 1) {
    for (let j = i + 1; j < textos.length; j += 1) {
      assert.notStrictEqual(textos[i], textos[j], `o estado ${i} não é igual ao ${j}`);
    }
  }
  // Cada estado traz o SEU texto (não o de outro).
  for (const [chave, a] of Object.entries(ACESSOS)) {
    const html = colapsar(render(vista, { ...ctx, pessoa: null, acesso: a, listaTruncada: false }));
    assert.ok(html.includes(a.curto), `${chave}: traz o texto do próprio estado`);
    assert.ok(html.includes(a.detalhe), `${chave}: traz a orientação do próprio estado`);
  }
  ok('os quatro estados produzem quatro mensagens distintas');
}

titulo('A3. «sem_ligacao_a_conta» e «sem_relacao» não podem ser confundidos');
{
  const semRel = colapsar(render('views/condomino/orcamento.handlebars', { ...PAGINAS[0].ctx, acesso: ACESSOS.sem_relacao }));
  const semLig = colapsar(render('views/condomino/orcamento.handlebars', { ...PAGINAS[0].ctx, acesso: ACESSOS.sem_ligacao_a_conta }));
  assert.ok(semRel.includes('Não tem frações associadas'), 'sem_relacao: a pessoa não tem frações');
  assert.ok(semLig.includes('Existem frações associadas a si'), 'sem_ligacao_a_conta: as frações existem, falta a ligação');
  assert.ok(!semLig.includes('Não tem frações associadas'), 'sem_ligacao_a_conta NÃO diz que não há frações (elas existem)');
  ok('«sem relação» e «sem ligação à conta» não se confundem');
}

titulo('A4. D3 — nunca se apresentam falsos zeros como dados reais');
{
  // Sem orçamento e sem acesso: NENHUM «0,00 €» nem «0 %» na página.
  const semOrcamento = colapsar(render('views/condomino/orcamento.handlebars', {
    ...PAGINAS[0].ctx, orcamento: null, acesso: ACESSOS.conta_sem_condomino,
  }));
  assert.ok(!/0,00 €/.test(semOrcamento), 'orcamento (sem conta): nenhum «0,00 €» inventado');
  assert.ok(!/>0%</.test(semOrcamento) && !/>0 %</.test(semOrcamento), 'orcamento (sem conta): nenhum «0 %» inventado');

  // Com orçamento publicado mas sem rubricas: a execução é «—», não «0 %».
  const orcSemRubricas = colapsar(render('views/condomino/orcamento.handlebars', {
    ...PAGINAS[0].ctx, pessoa: PESSOA, acesso: null,
    orcamento: { ano: 2026 }, linhas: [], totais: { orcamentado: 0, executado: 0, saldo: 0, percentagem: 0 },
  }));
  // Asserção DIRETA: o cartão «Execução» tem de mostrar «—». Se mostrasse «0 %»,
  // seria um falso zero apresentado como dado real (o defeito que se corrige).
  assert.ok(/Execução<\/div>\s*<div[^>]*>—<\/div>/.test(orcSemRubricas),
    'orcamento (orçamento sem rubricas): o cartão Execução mostra «—»');
  assert.ok(!/Execução<\/div>\s*<div[^>]*>0\s*%<\/div>/.test(orcSemRubricas),
    'orcamento (orçamento sem rubricas): o cartão Execução NÃO mostra «0 %»');
  assert.ok(/ainda não tem rubricas com valor previsto/.test(orcSemRubricas),
    'orcamento (orçamento sem rubricas): explica porque não há totais');

  // Situação financeira sem contas: «—», não «0,00 €».
  const semContas = colapsar(render('views/condomino/situacao-financeira.handlebars', {
    ...PAGINAS[1].ctx, pessoa: PESSOA, acesso: null,
    resumo: { ...PAGINAS[1].ctx.resumo, temContas: false }, temDadosFinanceiros: false,
  }));
  // Asserção DIRETA no cartão «Saldo das contas»: tem de ser «—».
  assert.ok(/Saldo das contas<\/div>\s*<div[^>]*>—<\/div>/.test(semContas),
    'situacao (sem contas): o cartão Saldo das contas mostra «—»');
  assert.ok(!/Saldo das contas<\/div>\s*<div[^>]*>0,00 €<\/div>/.test(semContas),
    'situacao (sem contas): o cartão Saldo das contas NÃO mostra «0,00 €»');
  assert.ok(/Ainda não existem contas registadas/.test(semContas),
    'situacao (sem contas): a nota explica que não há contas registadas');
  assert.ok(/Ainda não existem dados financeiros registados/.test(semContas),
    'situacao (sem dados): avisa que não há dados financeiros');

  // E com uma conta real com saldo 0 o número É mostrado (não é «—»).
  const contaZero = colapsar(render('views/condomino/situacao-financeira.handlebars', {
    ...PAGINAS[1].ctx, pessoa: PESSOA, acesso: null,
    resumo: { ...PAGINAS[1].ctx.resumo, temContas: true, saldoContas: 0 }, temDadosFinanceiros: true,
  }));
  assert.ok(/Saldo das contas<\/div>\s*<div[^>]*>0,00 €<\/div>/.test(contaZero),
    'situacao (conta real com saldo 0): o zero É mostrado — é um dado, não uma ausência');
  ok('D3: ausência de dados ≠ zero real (a distinção é visível na página)');
}

titulo('A5. C3 — o aviso de lista limitada aparece só quando há truncagem');
{
  const semTruncar = colapsar(render('views/condomino/recibos.handlebars', {
    pessoa: PESSOA, acesso: null, listaTruncada: false,
    linhas: [{ id: 1, codigo: 'X', valor: 10, estado: 'emitido' }], nRecibos: 1, temVariasFracoes: false,
  }));
  assert.ok(!/A mostrar os registos mais recentes/.test(semTruncar),
    'recibos: sem truncagem não mostra o aviso');
  const truncado = colapsar(render('views/condomino/recibos.handlebars', {
    pessoa: PESSOA, acesso: null, listaTruncada: true,
    linhas: [{ id: 1, codigo: 'X', valor: 10, estado: 'emitido' }], nRecibos: 1, temVariasFracoes: false,
  }));
  assert.ok(/A mostrar os registos mais recentes/.test(truncado),
    'recibos: com truncagem avisa que só se mostram os mais recentes');
  ok('C3: o aviso de truncagem aparece exatamente quando a lista é limitada');
}

titulo('A6. C3 — o aviso existe em todas as listas limitadas');
// Só as páginas cuja consulta leva `limit:` (ver LIMITE_LISTA em
// routes/condomino.js) podem ser truncadas. `/orcamento` (rubricas finitas) e
// `/situacao-financeira` (12 meses fixos) não são listas ilimitadas.
const PAGINAS_LIMITADAS = PAGINAS.filter((p) => ['recibos.handlebars', 'pagamentos.handlebars', 'documentos.handlebars', 'avisos.handlebars', 'assembleias.handlebars', 'calendario.handlebars', 'quotas.handlebars'].includes(p.nome));
for (const p of PAGINAS_LIMITADAS) {
  const html = colapsar(render(p.vista, { ...p.ctx, pessoa: PESSOA, acesso: null, listaTruncada: true }));
  assert.ok(/A mostrar os registos mais recentes/.test(html),
    `${p.nome}: a lista limitada avisa o condómino`);
}
ok(`${PAGINAS_LIMITADAS.length} listas limitadas avisam quando são truncadas`);

// ══════════════════════════════════════════════════════════════════
// B. ROUTER — limites aplicados e estado de acesso discriminado
// ══════════════════════════════════════════════════════════════════
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { Op } = require('sequelize');

// Linhas reais de DOIS condomínios: o duplo imita a BD e aplica-lhes o `where`.
const COND_ATIVO = 1;
const COND_OUTRO = 2;

// N quotas por fração no condomínio 1 (mais do que qualquer limite usado).
const N_QUOTAS = 150;
const QUOTAS = [];
for (let i = 1; i <= N_QUOTAS; i += 1) {
  QUOTAS.push({ id: i, condominio_id: COND_ATIVO, fracao_id: 100, ano: 2026, mes: ((i - 1) % 12) + 1, valor: 10, data_vencimento: '2026-06-10', estado: 'pendente' });
}
// Quotas do OUTRO condomínio: se vazarem, o total sobe.
for (let i = 1000; i < 1000 + N_QUOTAS; i += 1) {
  QUOTAS.push({ id: i, condominio_id: COND_OUTRO, fracao_id: 200, ano: 2026, mes: 1, valor: 999, data_vencimento: '2026-06-10', estado: 'pendente' });
}

const FRACAO_ATIVA = { id: 100, condominio_id: COND_ATIVO, designacao: '1.º Esq', permilagem: '125.00' };

// Os modelos reais são instâncias Sequelize (têm `toJSON()`); o duplo devolve
// linhas simples, por isso cada linha ganha um `toJSON()` que se devolve a si
// mesma — é o que permite à rota serializar como faria com a BD.
const comToJSON = (linhas) => linhas.map((l) => ({ ...l, toJSON() { return { ...this, toJSON: undefined }; } }));

// A pessoa e a «ligação» da conta: é isto que decide o `motivo` do acesso.
// `ligacao` = 'titular' (há frações), 'sem_relacao', 'sem_ligacao', 'sem_conta'.
// `opcoes.calendarioCheio` faz a rota do calendário receber 101 assembleias.
function montarModelos(ligacao, opcoes = {}) {
  const calendarioCheio = Boolean(opcoes.calendarioCheio);
  const filtrar = (linhas, w = {}) => linhas.filter((l) => {
    if (w.condominio_id !== undefined && Number(l.condominio_id) !== Number(w.condominio_id)) return false;
    if (w.fracao_id !== undefined) {
      const alvo = w.fracao_id;
      if (alvo && typeof alvo === 'object' && alvo[Op.in] !== undefined) {
        if (!alvo[Op.in].map(Number).includes(Number(l.fracao_id))) return false;
      } else if (Number(l.fracao_id) !== Number(alvo)) return false;
    }
    if (w.ano !== undefined && Number(l.ano) !== Number(w.ano)) return false;
    return true;
  });
  // Aplica `order` e — sobretudo — o `limit`. Se a rota não limitar, o duplo não
  // limita; se limitar, o duplo devolve exatamente o mesmo que a BD devolveria.
  const ordenarELimitar = (linhas, opts = {}) => {
    let out = linhas.slice();
    const order = opts.order || [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const [campo, dir] = order[i];
      const sinal = String(dir).toUpperCase() === 'DESC' ? -1 : 1;
      out.sort((a, b) => {
        const va = a[campo]; const vb = b[campo];
        if (va === vb) return 0;
        return (va > vb ? 1 : -1) * sinal;
      });
    }
    if (typeof opts.limit === 'number') out = out.slice(0, opts.limit);
    return out;
  };
  const findAllDe = (linhas) => async (opts = {}) => comToJSON(ordenarELimitar(filtrar(linhas, opts.where || {}), opts));
  const conta = (linhas) => async (opts = {}) => filtrar(linhas, (opts && opts.where) || {}).length;

  return {
    Pessoa: {
      findOne: async (o = {}) => {
        const w = o.where || {};
        if (ligacao === 'sem_conta') return null;
        if (w.id !== undefined && Number(w.id) !== 10) return null;
        if (w.condominio_id !== undefined && Number(w.condominio_id) !== COND_ATIVO) return null;
        return { id: 10, nome: 'Ana', condominio_id: COND_ATIVO };
      },
    },
    Fracao: {
      findAll: async () => (ligacao === 'titular' ? [FRACAO_ATIVA] : []),
      findOne: async () => (ligacao === 'titular' ? FRACAO_ATIVA : null),
      count: conta(ligacao === 'titular' ? [FRACAO_ATIVA] : []),
    },
    Quota: { findAll: findAllDe(QUOTAS), count: conta(QUOTAS), findOne: async () => null },
    Pagamento: { findAll: async () => [], count: async () => 0, sum: async () => 0 },
    PagamentoQuota: { findAll: async () => [], count: async () => 0 },
    Recibo: { findAll: async () => [], count: async () => 0, findOne: async () => null },
    ReciboQuota: { findAll: async () => [] },
    Documento: { findAll: async () => [], count: async () => 0, findOne: async () => null },
    Aviso: { findAll: async () => [], count: async () => 0, findOne: async () => null },
    Assembleia: calendarioCheio
      // 100 assembleias (o limite): datas de 2017-01-01 a 2027-12-31, uma por ano.
      // A mais recente é 2027-12-31; a mais antiga, 2017-01-01.
      ? (() => {
        const linhas = [];
        for (let i = 0; i < 100; i += 1) {
          const ano = 2017 + (i % 11);
          linhas.push({ id: i + 1, condominio_id: COND_ATIVO, numero: i + 1, data: `${ano}-12-31`, estado: 'realizada' });
        }
        linhas.push({ id: 999, condominio_id: COND_ATIVO, numero: 999, data: '2017-01-01', estado: 'realizada' });
        return { findAll: findAllDe(linhas), count: conta(linhas), findOne: async () => null };
      })()
      : { findAll: async () => [], count: async () => 0, findOne: async () => null },
    ExtraQuota: { findAll: async () => [], findOne: async () => null },
    ExtraQuotaParcela: { findAll: async () => [], count: async () => 0 },
    Despesa: { findAll: async () => [], sum: async () => 0 },
    Orcamento: { findAll: async () => [], findOne: async () => null, count: async () => 0 },
    OrcamentoRubrica: { findAll: async () => [], findOne: async () => null, count: async () => 0 },
    Categoria: { findAll: async () => [], findByPk: async () => null },
    MetodoPagamento: { findAll: async () => [], findOne: async () => null },
    AgendaItem: { findAll: async () => [] },
    ContaBancaria: { findAll: async () => [], count: async () => 0 },
    MovimentoBancario: { findAll: async () => [], sum: async () => 0, count: async () => 0 },
    RecomendacaoEstado: { findAll: async () => [], findOne: async () => null, create: async () => ({}), destroy: async () => 0 },
  };
}

// `fracoesDoUtilizador` reproduz o vocabulário real de helpers/titularidades.js:
// devolve `{ fracoes, origem, motivo }` — é daqui que sai o estado discriminado.
function stubsTitularidades(ligacao) {
  const mapa = {
    titular: { fracoes: [{ fracao: { ...FRACAO_ATIVA }, vinculo: { vinculo: 'proprietario' } }], origem: 'titularidades', motivo: 'titularidade_em_vigor' },
    sem_relacao: { fracoes: [], origem: 'nenhuma', motivo: 'sem_relacao' },
    // ⭐ `sem_ligacao_a_conta`: as titularidades EXISTEM na BD, mas nenhuma está
    // ligada a esta CONTA — por isso `fracoes` vem VAZIO (só as ativas entram).
    // Ver helpers/titularidades.js:184-190.
    sem_ligacao: { fracoes: [], origem: 'titularidades', motivo: 'sem_ligacao_a_conta' },
    sem_conta: { fracoes: [], origem: 'nenhuma', motivo: 'conta_sem_condomino' },
  };
  return mapa[ligacao] || mapa.titular;
}

const stubsBase = {
  '../helpers/audit': { audit: async () => ({}), auditSafe: async () => ({}) },
  '../helpers/mailer': { sendMail: async () => ({ ok: true }) },
  '../helpers/conta-corrente': { contaCorrenteFracao: async () => ({ saldo: 0, emDivida: false, temCredito: false }), anosContaCorrente: async () => [2026] },
};

function construirApp(ligacao, captura, opcoes = {}) {
  const modelsPath = require.resolve('../models');
  require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [], exports: montarModelos(ligacao, opcoes) };

  const stubs = {
    ...stubsBase,
    '../helpers/titularidades': {
      fracoesDoUtilizador: async () => stubsTitularidades(ligacao),
      historicoDaPessoa: async () => [],
      estaAtiva: () => true,
    },
    '../helpers/saldos': {
      resumoFinanceiro: async () => ({ ano: 2026, saldoContas: 0, receitasAno: 0, despesasAno: 0, saldoAno: 0, totalQuotas: 0, pagoQuotas: 0, emDivida: 0, cobrancaPct: 0, nFracoesEmAtraso: 0, nFracoes: 0, contas: [], fundoReserva: 0, contasPorMes: Array(12).fill(0), despesasPorMes: Array(12).fill(0) }),
      evolucaoMensal: () => ({ meses: Array.from({ length: 12 }, (_, i) => ({ mes: i + 1, contas: 0, despesas: 0, saldo: 0, temMovimentos: false })), temMovimentos: false, mesesComMovimentos: 0, totalContas: 0, totalDespesas: 0 }),
      resumoOrcamento: async () => ({ ano: 2026, orcamentado: 0, executado: 0, percentagem: 0 }),
      resumoFracao: async () => ({ totalQuotas: 0, totalPago: 0, emDivida: 0, quotasPagas: 0, quotasPendentes: 0, quotasVencidas: 0, ultimoPagamento: null }),
      resumoCondominio: async () => ({ saldoContas: 0, fundoReserva: 0, receitas: 0, despesas: 0, emDividaGlobal: 0, contas: [] }),
      estadoEfetivo: (q) => (q && q.estado) || null,
      saldoConta: async () => 0,
      ESTADOS_PENDENTES: ['pendente', 'parcialmente_paga', 'vencida'],
    },
    '../helpers/condominio': { getCondominio: async () => ({ id: COND_ATIVO, designacao: 'Condomínio Exemplo' }) },
    '../helpers/pdf': { gerarReciboPDF: async () => Buffer.from('pdf') },
    '../helpers/cabecalhos-ficheiro': { periodoLabel: () => 'Setembro 2026' },
    '../helpers/recibos': { gerarReciboPDF: async () => Buffer.from('pdf') },
    '../helpers/documento-pastas': { mapaPastas: () => ({ atas: 'Atas' }) },
    '../helpers/recomendacoes': {
      escolher: () => ({ recomendacao: null, dispensas: [] }),
      carregarDispensas: async () => [],
      recomendacoesDoPortal: async () => [],
    },
    '../helpers/documentos-acesso': {
      autorizarAcessoDocumento: async () => ({ ok: false, estado: 404 }),
      servirDocumento: async ({ res }) => { res.status(200).send('f'); return { ok: true }; },
      verificarDocumento: async () => ({ ok: true }),
      responderRecusa: (res, r) => res.status((r && r.estado) || 404).send('recusado'),
    },
    '../helpers/storage': { rotuloPrincipal: () => 'Google Drive', abrePastaNoFornecedor: () => true, iconePrincipal: () => 'cloud' },
    '../helpers/seguranca': { createLimiter: () => (req, res, next) => next() },
    '../helpers/eAdmin': { eAutenticado: (req, res, next) => next() },
    '../helpers/tenant': {
      comCondominioAtivo: (req, res, next) => { req.condominioId = COND_ATIVO; next(); },
      semSuporte: (req, res, next) => next(),
      pertenceAoAtivo: () => true,
      entrarCondominio: async () => ({ ok: true }),
    },
  };
  for (const [rel, valor] of Object.entries(stubs)) {
    const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
    require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
  }
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('routes\\condomino.js') || k.endsWith('routes/condomino.js')) delete require.cache[k];
  }

  const app = express();
  const { engine } = require('express-handlebars');
  app.engine('handlebars', engine({
    defaultLayout: false,
    helpers: require('../helpers/handlebars-helpers'),
    layoutsDir: path.join(RAIZ, 'views', 'layouts'),
    partialsDir: path.join(RAIZ, 'views', 'partials'),
    runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
  }));
  app.set('view engine', 'handlebars');
  app.set('views', path.join(RAIZ, 'views'));
  app.use(session({ secret: 'teste', resave: false, saveUninitialized: false }));
  app.use(express.urlencoded({ extended: true }));
  app.use(flash());
  app.use((req, res, next) => {
    // `sem_conta` = a conta não tem pessoa ligada; nos restantes há pessoa.
    req.user = { id: 42, pessoa_id: ligacao === 'sem_conta' ? null : 10, nome: 'Ana' };
    req.isAuthenticated = () => true;
    req.session.condominio_ativo_id = COND_ATIVO;
    next();
  });
  app.use((req, res, next) => {
    res.locals.success_msg = []; res.locals.error_msg = []; res.locals.error = [];
    res.locals.user = { id: 42, nome: 'Ana' }; res.locals.isAdmin = false;
    res.locals.meusCondominios = [];
    res.locals.condominioAtivo = { id: COND_ATIVO, designacao: 'Condomínio Exemplo', role: 'leitura' };
    res.locals.condominio = { id: COND_ATIVO, designacao: 'Condomínio Exemplo' };
    res.locals.appName = 'GesCondu'; res.locals.currentYear = 2026; res.locals.currentPath = req.path || '';
    res.locals.tarefas = { ativas: 0, emErro: 0 }; res.locals.avisosRecentes = 0;
    next();
  });
  app.use((req, res, next) => {
    const original = res.render.bind(res);
    res.render = (vista, ctx) => {
      if (captura) { captura.vista = vista; captura.ctx = ctx; }
      return original(vista, ctx);
    };
    next();
  });
  app.use('/condomino', require('../routes/condomino'));
  return app;
}

function pedir(app, caminho) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, () => {
      const porta = servidor.address().port;
      require('http').get({ host: '127.0.0.1', port: porta, path: caminho }, (res) => {
        let corpo = '';
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => { servidor.close(); resolve({ status: res.statusCode, html: corpo }); });
      }).on('error', (e) => { servidor.close(); reject(e); });
    });
  });
}

(async () => {
  // ── B1. O limite é aplicado e o total real é preservado ─────────
  titulo('B1. C3 — /quotas limita mas não mente sobre o conjunto');
  {
    const cap = {};
    const app = construirApp('titular', cap);
    const r = await pedir(app, '/condomino/quotas');
    assert.strictEqual(r.status, 200, '/quotas responde 200');
    assert.ok(cap.ctx, '/quotas renderizou a vista');
    // 150 quotas no condomínio ativo: o limite de 100 tem de cortar.
    assert.strictEqual(cap.ctx.linhas.length, 100,
      `a lista é limitada a 100 (recebeu ${cap.ctx.linhas.length} de ${N_QUOTAS})`);
    assert.strictEqual(cap.ctx.listaTruncada, true, 'a vista é avisada de que a lista foi truncada');
    // As 999 do OUTRO condomínio nunca entram (isolamento).
    assert.ok(!cap.ctx.linhas.some((q) => q.condominio_id === COND_OUTRO),
      'nenhuma quota do outro condomínio entra na lista');
    ok(`/quotas: ${cap.ctx.linhas.length} linhas (limite 100) de ${N_QUOTAS}, aviso de truncagem ligado`);
  }

  titulo('B2. C3 — com poucas linhas não trunca nem avisa');
  {
    // Sem frações não há quotas: lista vazia, sem aviso.
    const cap = {};
    const app = construirApp('sem_relacao', cap);
    await pedir(app, '/condomino/quotas');
    assert.strictEqual(cap.ctx.linhas.length, 0, 'sem frações: a lista fica vazia');
    assert.notStrictEqual(cap.ctx.listaTruncada, true, 'sem frações: não há truncagem a assinalar');
    ok('sem frações: lista vazia e sem aviso');
  }

  titulo('B2b. C3 — o calendário (duas consultas) limita e avisa');
  {
    // O calendário é a única rota com DOIS findAll limitados; a truncagem tem
    // de ser assinalada quando QUALQUER um deles atinge o limite. Estes duplos
    // devolvem 100 assembleias — exatamente o limite.
    const cap = {};
    const app = construirApp('titular', cap, { calendarioCheio: true });
    const r = await pedir(app, '/condomino/calendario');
    assert.strictEqual(r.status, 200, '/calendario responde 200');
    assert.ok(cap.ctx, '/calendario renderizou a vista');
    assert.strictEqual((cap.ctx.eventos || []).length, 100,
      `as assembleias são limitadas a 100 (recebeu ${(cap.ctx.eventos || []).length})`);
    assert.strictEqual(cap.ctx.listaTruncada, true,
      'calendário: atingir o limite numa das consultas liga o aviso');
    // E o limitado é o MAIS RECENTE (ordem DESC antes do corte): o evento mais
    // antigo do conjunto não pode aparecer, o mais recente tem de aparecer.
    const datas = cap.ctx.eventos.map((e) => String(e.data));
    assert.ok(datas.includes('2027-12-31'), 'calendário: o evento mais recente está presente');
    assert.ok(!datas.includes('2017-01-01'), 'calendário: o evento mais antigo foi cortado');
    ok('calendário: 100 eventos (limite), aviso ligado, corte pelo mais antigo');
  }

  // ── B3. O estado de acesso chega discriminado às vistas ─────────
  titulo('B3. D3 — o estado de acesso chega distinto à vista');
  {
    const casos = [
      { ligacao: 'titular', esperado: null },
      { ligacao: 'sem_relacao', motivo: 'sem_relacao' },
      { ligacao: 'sem_ligacao', motivo: 'sem_ligacao_a_conta' },
      { ligacao: 'sem_conta', motivo: 'conta_sem_condomino' },
    ];
    const vistas = ['condomino/orcamento', 'condomino/situacao-financeira', 'condomino/quotas', 'condomino/documentos'];
    for (const c of casos) {
      for (const vista of vistas) {
        const cap = {};
        const app = construirApp(c.ligacao, cap);
        const rota = vista === 'condomino/orcamento' ? '/condomino/orcamento'
          : vista === 'condomino/situacao-financeira' ? '/condomino/situacao-financeira'
            : vista === 'condomino/quotas' ? '/condomino/quotas' : '/condomino/documentos';
        await pedir(app, rota);
        assert.strictEqual(cap.vista, vista, `${rota} renderiza ${vista}`);
        assert.ok('acesso' in cap.ctx, `${vista}: a vista recebe o estado de acesso`);
        if (c.esperado === null) {
          assert.strictEqual(cap.ctx.acesso, null,
            `${vista}: com titularidade em vigor não há estado de associação (recebeu ${JSON.stringify(cap.ctx.acesso)})`);
        } else {
          assert.ok(cap.ctx.acesso, `${vista}: sem acesso há estado de associação`);
          assert.strictEqual(cap.ctx.acesso.motivo, c.motivo,
            `${vista}: motivo = ${c.motivo} (recebeu ${cap.ctx.acesso.motivo})`);
          // ⭐ O que interessa não é o campo `motivo` (que é eco do que entrou):
          // é a MENSAGEM que o condómino lê. Sem esta asserção, uma mutação que
          // colapsasse os textos passaria despercebida.
          assert.strictEqual(cap.ctx.acesso.curto, ACESSOS[c.motivo].curto,
            `${vista}: a mensagem apresentada é a do estado ${c.motivo} (recebeu «${cap.ctx.acesso.curto}»)`);
          assert.notStrictEqual(cap.ctx.acesso.curto, ACESSOS.sem_condominio.curto,
            `${vista}: o estado ${c.motivo} NÃO reutiliza a mensagem genérica`);
        }
      }
      ok(`ligação «${c.ligacao}» ⇒ estado ${c.esperado === null ? 'ausente (tem frações)' : `«${c.motivo}»`} em 4 páginas`);
    }
  }

  // ── B4. Caso negativo: trocar a ligação troca o resultado ───────
  titulo('B4. Caso negativo — trocar a ligação troca MESMO o resultado');
  {
    const capTitular = {};
    await pedir(construirApp('titular', capTitular), '/condomino/orcamento');
    const capSem = {};
    await pedir(construirApp('sem_relacao', capSem), '/condomino/orcamento');
    assert.strictEqual(capTitular.ctx.acesso, null, 'titular: sem aviso');
    assert.ok(capSem.ctx.acesso, 'sem_relacao: com aviso');
    assert.notDeepStrictEqual(capTitular.ctx.acesso, capSem.ctx.acesso,
      'as duas ligações NÃO produzem o mesmo acesso');
    ok('a mesma rota, com ligações diferentes, produz estados diferentes');
  }

  // ── B5. As sete páginas entregam sempre um estado coerente ──────
  titulo('B5. D3 — todas as páginas do portal entregam o estado');
  {
    const rotas = [
      '/condomino', '/condomino/quotas', '/condomino/pagamentos', '/condomino/recibos',
      '/condomino/assembleias', '/condomino/avisos', '/condomino/calendario',
      '/condomino/documentos', '/condomino/orcamento', '/condomino/situacao-financeira',
    ];
    for (const rota of rotas) {
      const cap = {};
      const app = construirApp('sem_relacao', cap);
      const r = await pedir(app, rota);
      assert.strictEqual(r.status, 200, `${rota} responde 200`);
      assert.ok(cap.ctx && 'acesso' in cap.ctx, `${rota}: a vista recebe o estado de acesso`);
      assert.ok(cap.ctx.acesso && cap.ctx.acesso.motivo, `${rota}: o estado traz um motivo`);
    }
    ok(`${rotas.length} rotas do portal entregam o estado discriminado`);
  }

  console.log(`\n✓ Guardas de associação e limites do portal: ${resultados.length} verificações passaram (sem BD).`);
})().catch((e) => {
  console.error(`\n✗ FALHA: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
