// ─────────────────────────────────────────────────────────────────────
// Relatórios do condomínio.
//
// Primeiro relatório: Relatório Financeiro (balancete do condomínio) —
// receitas, despesas, síntese, contas bancárias, observações e detalhe
// opcional, com exportação em PDF no mesmo sistema visual dos recibos.
//
// Isolamento multi-condomínio: o router usa o condomínio ativo da sessão
// (tenant.comCondominioAtivo) e TODAS as leituras do motor de cálculo filtram
// por condominio_id. O acesso segue o mesmo papel das restantes áreas
// financeiras (gestor).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const tenant = require('../helpers/tenant');
const { getCondominio } = require('../helpers/condominio');
const { balanceteFinanceiro } = require('../helpers/relatorio-financeiro');
const { gerarRelatorioFinanceiroPDF } = require('../helpers/pdf');
const { toDateInput, currentYear, monthName } = require('../helpers/dates');
const { fromCents, formatEUR } = require('../helpers/money');
const cabecalhos = require('../helpers/cabecalhos-ficheiro');

const router = express.Router();

// Acesso: condomínio ativo (associação real ou modo suporte) + papel ≥ gestor.
// Sem `eAdmin`: essa guarda decidia por `users.role` (legado) e expulsava para
// `/` gestores de condomínio legítimos cujo `users.role` é 'condomino'.
router.use(tenant.comCondominioAtivo);

// ── Suporte diagnóstico: admissão explícita DESTE módulo ───────────
// A allow-list é partilhada (`helpers/suporte-allowlist.js`). Só as rotas
// declaradas para o módulo `relatorios` são admitidas ao suporte; as
// restantes caem na guarda de papel abaixo.
const allowlistSuporte = require('../helpers/suporte-allowlist');
router.use(allowlistSuporte.soDiagnostico('relatorios'));

// Guarda de papel CONDICIONAL (única): contornada só pelo suporte ADMITIDO.
// Um `router.use(tenant.comPapel('gestor'))` incondicional a seguir anularia a
// admissão — o Express corre os dois e o segundo recusaria o pedido admitido.
router.use(allowlistSuporte.comPapelOuSuporteAdmitido('gestor'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const eur = (c) => formatEUR(fromCents(c || 0));

function periodoPorOmissao() {
  const ano = currentYear();
  return { inicio: `${ano}-01-01`, fim: `${ano}-12-31` };
}

// Períodos rápidos: ligações simples que preenchem o período (sem JavaScript).
function periodosRapidos() {
  const hoje = new Date();
  const ano = currentYear();
  const mesInicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const mesFim = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  return [
    { chave: 'atual', etiqueta: `Ano ${ano}`, inicio: `${ano}-01-01`, fim: `${ano}-12-31` },
    { chave: 'anterior', etiqueta: `Ano ${ano - 1}`, inicio: `${ano - 1}-01-01`, fim: `${ano - 1}-12-31` },
    { chave: 's1', etiqueta: `1.º semestre ${ano}`, inicio: `${ano}-01-01`, fim: `${ano}-06-30` },
    { chave: 's2', etiqueta: `2.º semestre ${ano}`, inicio: `${ano}-07-01`, fim: `${ano}-12-31` },
    { chave: 't1', etiqueta: `1.º trimestre ${ano}`, inicio: `${ano}-01-01`, fim: `${ano}-03-31` },
    { chave: 'mes', etiqueta: `${monthName(hoje.getMonth() + 1)} ${hoje.getFullYear()}`, inicio: toDateInput(mesInicio), fim: toDateInput(mesFim) },
  ];
}

function lerParametros(query) {
  const omissao = periodoPorOmissao();
  let inicio = ISO.test(String(query.inicio || '')) ? String(query.inicio) : omissao.inicio;
  let fim = ISO.test(String(query.fim || '')) ? String(query.fim) : omissao.fim;
  if (inicio > fim) { const t = inicio; inicio = fim; fim = t; }
  const ligado = (v) => v === '1' || v === 'on';
  return {
    inicio,
    fim,
    opcoes: {
      notas: ligado(query.d_notas),
      dividas_condominos: ligado(query.d_dividas_condominos),
      dividas_fornecedores: ligado(query.d_dividas_fornecedores),
      despesas_por_fornecedor: ligado(query.d_despesas_fornecedor),
      receitas_por_fracao: ligado(query.d_receitas_fracao),
      observacoes: typeof query.observacoes === 'string' ? query.observacoes.slice(0, 4000) : '',
    },
  };
}

function rubricasParaEcra(lista) {
  return (lista || []).map((r) => ({
    designacao: r.designacao,
    orcamentado: eur(r.orcamentadoC),
    lancado: eur(r.lancadoC),
    recebido: eur(r.recebidoC),
    emDivida: eur(r.emDividaC),
    emDividaNegativa: (r.emDividaC || 0) < 0,
    faturado: eur(r.faturadoC),
    pago: eur(r.pagoC),
    porPagar: eur(r.porPagarC),
    nDocumentos: r.nDocumentos,
    nFaturas: r.nFaturas,
  }));
}

function resumoParaEcra(dados) {
  const s = dados.sintese || {};
  return {
    resultado: eur(s.resultadoC),
    resultadoNegativo: (s.resultadoC || 0) < 0,
    receitasLancadas: eur(s.totalReceitasLancadasC),
    receitasRecebidas: eur(s.totalReceitasRecebidasC),
    despesasFaturadas: eur(s.totalDespesasFaturadasC),
    despesasPagas: eur(s.totalDespesasPagasC),
    dividaCondominos: eur(s.dividaCondominosC),
    dividaFornecedores: eur((s.dividaFornecedoresC || 0) + (s.dividaFornecedoresSemFornecedorC || 0)),
    saldoContas: eur(s.saldoContasC),
    saldoContasNegativo: (s.saldoContasC || 0) < 0,
    fundoReserva: eur(s.fundoReservaC),
    saldoTransitado: eur(s.saldoTransitadoC),
    nFracoesEmDivida: (dados.dividasCondominos && dados.dividasCondominos.nFracoesEmDivida) || 0,
    nFornecedoresComDivida: (dados.dividasFornecedores && dados.dividasFornecedores.fornecedores)
      ? dados.dividasFornecedores.fornecedores.filter((f) => f.dividaC > 0).length
      : 0,
  };
}

// ── Índice do módulo de relatórios ──────────────────────────────────
router.get('/relatorios', (req, res) => res.redirect('/admin/relatorios/financeiro'));

// ── Relatório Financeiro: formulário + pré-visualização ─────────────
router.get('/relatorios/financeiro', async (req, res) => {
  const { inicio, fim, opcoes } = lerParametros(req.query);
  try {
    const dados = await balanceteFinanceiro({
      condominioId: req.condominioId,
      dataInicio: inicio,
      dataFim: fim,
      opcoes,
    });
    return res.render('admin/relatorios/financeiro', {
      titulo: 'Relatório financeiro',
      inicio,
      fim,
      opcoes,
      periodosRapidos: periodosRapidos(),
      resumo: resumoParaEcra(dados),
      receitas: rubricasParaEcra(dados.receitas.rubricas),
      despesas: rubricasParaEcra(dados.despesas.rubricas),
      totaisReceitas: rubricasParaEcra([dados.receitas.totais])[0],
      totaisDespesas: rubricasParaEcra([dados.despesas.totais])[0],
      contas: dados.contas.contas.map((c) => ({
        nome: c.nome,
        banco: c.banco,
        tipo: c.tipo,
        ativa: c.ativa,
        saldo: eur(c.saldoC),
      })),
      totalContas: eur(dados.contas.totalC),
      transferencias: dados.contas.transferencias,
      orcamento: dados.orcamento,
      movimentos: dados.dados,
      avisos: dados.avisos,
    });
  } catch (err) {
    console.error('[relatorios] erro ao calcular o relatório financeiro:', err);
    req.flash('error_msg', err.message || 'Não foi possível calcular o relatório.');
    return res.redirect('/admin');
  }
});

// ── Relatório Financeiro: PDF ───────────────────────────────────────
router.get('/relatorios/financeiro/pdf', async (req, res) => {
  const { inicio, fim, opcoes } = lerParametros(req.query);
  try {
    const [condominio, dados] = await Promise.all([
      getCondominio({ id: req.condominioId }),
      balanceteFinanceiro({ condominioId: req.condominioId, dataInicio: inicio, dataFim: fim, opcoes }),
    ]);
    const buffer = await gerarRelatorioFinanceiroPDF(condominio, {
      ...dados,
      emitidoEm: new Date(),
      observacoes: opcoes.observacoes,
    });
    const nome = `relatorio_financeiro_${inicio}_${fim}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', cabecalhos.disposicao(nome, 'inline', 'relatorio_financeiro.pdf'));
    return res.send(buffer);
  } catch (err) {
    console.error('[relatorios] erro ao gerar o PDF do relatório financeiro:', err);
    req.flash('error_msg', err.message || 'Não foi possível gerar o relatório.');
    return res.redirect(`/admin/relatorios/financeiro?inicio=${inicio}&fim=${fim}`);
  }
});

module.exports = router;
