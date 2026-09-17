#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Seed de DEMONSTRAÇÃO — cria um condomínio fictício completo.
//
// Ao contrário dos seeders de arranque (`seeders/`, via sequelize-cli), este
// script NÃO faz parte do `db:setup` nem do `db:seed`: é uma ferramenta de
// desenvolvimento/demonstração, executada explicitamente e nunca em produção.
//
// Cria um condomínio com 14 meses de vida financeira (2 meses do ano anterior
// + 12 do ano corrente) para que o Dashboard, o Extrato e o Relatório
// Financeiro tenham conteúdo realista:
//
//   condomínio → gestor + condóminos → frações (1000‰) → titularidades
//     → 3 contas (corrente, fundo_reserva, poupanca)
//     → orçamento + rubricas
//     → quotas (pagas, parcialmente pagas, pendentes, vencidas)
//     → pagamentos → movimentos de entrada
//     → despesas (pagas e por pagar) → movimentos de saída
//     → quota extra → parcelas → pagamento
//     → assembleia → deliberação aprovada → FCR (entrada e utilização)
//     → transferências entre contas (uma anulada) → ajustes manuais (um anulado)
//     → documentos (sem Drive) e avisos
//
// ── Regras que este script respeita ─────────────────────────────────
//  · USA OS WRITERS EXISTENTES para tudo o que tem fluxo próprio:
//    `registarPagamento`, `registarPagamentoExtraParcela`,
//    `registarTransferencia`, `sincronizarMovimentoDespesa`,
//    `transferirFcr` / `transferirFcrAprovado`. Nunca se escreve à mão um
//    movimento que tenha writer — é o que garante que os estados derivados
//    (quota paga, FCR recebido, saldo) ficam coerentes por construção.
//  · `condominio_id` é preenchido em TODAS as escritas novas.
//  · As permilagens somam exatamente 1000‰.
//  · Nenhum dado é real: os emails usam o domínio reservado `example.test`,
//    os NIF são de teste e os IBAN são fictícios (PT50 + zeros).
//  · Nunca envia emails, nunca toca em Drive/Dropbox. Os documentos ficam com
//    `drive_status = 'nao_guardado'`.
//  · Idempotente: se o condomínio de demonstração já existir, não duplica.
//
// ── Utilização ──────────────────────────────────────────────────────
//   node scripts/seed-demo.js              # cria (ou confirma que já existe)
//   node scripts/seed-demo.js --dry-run    # mostra o plano, não escreve nada
//   node scripts/seed-demo.js --reset      # apaga APENAS o condomínio demo
//   node scripts/seed-demo.js --reparar    # corrige só a conta do gestor demo
//                                          # (não apaga nem recria o resto)
// `--reparar` aceita `--dry-run` (simula) e serve para atualizar um demo criado
// por uma versão anterior: liga o gestor a uma `Pessoa` (`users.pessoa_id`),
// repõe `users.role = 'admin'` e a associação `admin` ao condomínio.
//
// ── Sobre as transações ─────────────────────────────────────────────
// Os writers (`registarPagamento`, `registarPagamentoExtraParcela`,
// `registarTransferencia`, `transferirFcr*`) abrem e fecham a SUA PRÓPRIA
// transação. Por isso este script NÃO envolve tudo numa transação única:
// faria transações aninhadas que o Sequelize não suporta. O que garante a
// integridade é a IDEMPOTÊNCIA (o condomínio de demonstração é identificado
// pela sua designação própria e, em segunda linha, pela conta do gestor demo —
// e o script sai sem duplicar) e, em caso de falha a meio, o `--reset`, que
// remove exatamente o que o script criou.
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  User,
  UserCondominio,
  Condominio,
  Pessoa,
  Fracao,
  FracaoPessoa,
  FracaoTitularidade,
  ContaBancaria,
  Categoria,
  MetodoPagamento,
  Orcamento,
  OrcamentoRubrica,
  OrcamentoDistribuicao,
  Quota,
  Pagamento,
  PagamentoQuota,
  ExtraQuota,
  ExtraQuotaParcela,
  PagamentoExtraParcela,
  Despesa,
  Fornecedor,
  MovimentoBancario,
  Documento,
  Assembleia,
  AgendaItem,
  AssembleiaParticipante,
  Aviso,
  AvisoDestinatario,
  Recibo,
  ReciboQuota,
  AuditLog,
  Numeracao,
  EmailFila,
} = require('../models');

const { toCents, fromCents } = require('../helpers/money');
const { getQuotaConfig } = require('../helpers/quotas-config');
const { registarPagamento, registarPagamentoExtraParcela } = require('../helpers/pagamentos');
const {
  criarMovimento,
  registarTransferencia,
  sincronizarMovimentoDespesa,
  saldoContaMovimentos,
} = require('../helpers/movimentos');
const { transferirFcr, transferirFcrAprovado, resumoFcr } = require('../helpers/fcr');
const { setConfig } = require('../helpers/config');

// ── Constantes do cenário ────────────────────────────────────────────
const DESIGNACAO = 'Condomínio Demonstração — Jardins do Tejo';
const PREFIXO_EMAIL = 'demo.';

const EMAIL_GESTOR = 'demo.gestor@example.test';
const PASSWORD_GESTOR = 'DemoGestor123!';
const PASSWORD_CONDOMINO = 'DemoCondomino123!';

// 6 frações cujas permilagens somam EXATAMENTE 1000‰.
const FRACOES_DEF = [
  { designacao: 'Fração A — R/C Esquerdo', permilagem: 180, andar: 'R/C', porta: 'A' },
  { designacao: 'Fração B — R/C Direito', permilagem: 170, andar: 'R/C', porta: 'B' },
  { designacao: 'Fração C — 1.º Esquerdo', permilagem: 165, andar: '1.º', porta: 'C' },
  { designacao: 'Fração D — 1.º Direito', permilagem: 160, andar: '1.º', porta: 'D' },
  { designacao: 'Fração E — 2.º Esquerdo', permilagem: 165, andar: '2.º', porta: 'E' },
  { designacao: 'Fração F — 2.º Direito', permilagem: 160, andar: '2.º', porta: 'F' },
];

// Condóminos: nome, fração (índice), vínculo e se tem conta de acesso ao portal.
// As frações C e D ficam sem conta de portal (proprietário sem acesso) — é um
// caso real que o administrador tem de conseguir ver e resolver.
const PESSOAS_DEF = [
  { nome: 'Ana Ribeiro', fracao: 0, vinculo: 'proprietario', conta: true },
  { nome: 'Bruno Salgado', fracao: 1, vinculo: 'proprietario', conta: true },
  { nome: 'Carla Nunes', fracao: 2, vinculo: 'proprietario', conta: false },
  { nome: 'Diogo Amaral', fracao: 3, vinculo: 'arrendatario', conta: false },
  { nome: 'Eva Marques', fracao: 4, vinculo: 'proprietario', conta: true },
  { nome: 'Filipe Costa', fracao: 5, vinculo: 'proprietario', conta: true },
];

const FORNECEDORES_DEF = [
  { nome: 'Limpezas Demo, Lda.', categoria: 'Limpeza' },
  { nome: 'Manutenção Demo, Lda.', categoria: 'Manutenção' },
  { nome: 'Elevadores Demo, Lda.', categoria: 'Elevador' },
  { nome: 'Seguros Demo, S.A.', categoria: 'Seguros' },
];

const OPCOES = {
  dryRun: process.argv.includes('--dry-run'),
  reset: process.argv.includes('--reset'),
  reparar: process.argv.includes('--reparar'),
};

// ── Saída legível (pt-PT, sem depender de cores) ─────────────────────
function titulo(t) {
  console.log('');
  console.log('── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length)));
}
function passo(msg) {
  console.log('  · ' + msg);
}
function aviso(msg) {
  console.log('  ! ' + msg);
}
function eur(centimos) {
  return (Math.round(Number(centimos) || 0) / 100).toFixed(2).replace('.', ',') + ' €';
}
function diaISO(data) {
  return new Date(data.getTime() - data.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function somaMeses(ano, mes, delta) {
  const total = (ano * 12) + (mes - 1) + delta;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}

// ── Guardas de ambiente ──────────────────────────────────────────────
function verificarAmbiente() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.error('');
    console.error('  ✗ RECUSADO: NODE_ENV=production.');
    console.error('    Este script cria dados FICTÍCIOS e nunca deve correr em produção.');
    console.error('');
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════
// RESET — apaga APENAS o condomínio de demonstração
// ═══════════════════════════════════════════════════════════════════
// O condomínio de demonstração é identificado pela sua `designacao` única
// (o modelo `condominios` não tem campo livre para um marcador). Em segunda
// linha — se a designação tiver sido alterada — procura-se pelo gestor demo.
async function encontrarCondominioDemo() {
  const porDesignacao = await Condominio.findOne({ where: { designacao: DESIGNACAO } });
  if (porDesignacao) return porDesignacao;
  // Rede de segurança: se a designação foi alterada, encontrar pelo gestor demo.
  const gestor = await User.findOne({ where: { email: EMAIL_GESTOR } });
  if (!gestor) return null;
  const ligacao = await UserCondominio.findOne({ where: { utilizador_id: gestor.id } });
  if (!ligacao) return null;
  return Condominio.findByPk(ligacao.condominio_id);
}

// ── Reparação do gestor demo (dados já existentes) ──────────────────
// Corrige, SEM apagar nada, a conta do gestor de um condomínio demo criado por
// uma versão anterior do seed (antes da ligação a `Pessoa` e do `role` 'admin').
// É idempotente: correr duas vezes não muda nada depois da 1.ª.
// Não toca em mais nada do condomínio — nem quotas, nem pagamentos, nem
// movimentos, nem utilizadores que não sejam o gestor demo.
async function repararGestorDemo(condominio, { dryRun }) {
  const cid = condominio.id;
  titulo('REPARAR — associar o gestor demo ao condómino');
  passo(`Condomínio: #${cid} ${condominio.designacao}`);

  const gestor = await User.findOne({ where: { email: EMAIL_GESTOR } });
  if (!gestor) {
    passo(`Não existe o utilizador ${EMAIL_GESTOR}. Nada a reparar.`);
    return { alteracoes: 0 };
  }
  passo(`Utilizador #${gestor.id} ${gestor.email}`);

  // 1. A Pessoa do gestor: reutiliza a ligada por `pessoa_id`; senão procura
  //    pelo nome/email dentro do condomínio; senão cria.
  let pessoa = gestor.pessoa_id
    ? await Pessoa.findOne({ where: { id: gestor.pessoa_id, condominio_id: cid } })
    : null;
  if (!pessoa) {
    pessoa = await Pessoa.findOne({ where: { condominio_id: cid, nome: 'Gestor Demo' } });
  }
  if (!pessoa && !dryRun) {
    pessoa = await Pessoa.create({
      condominio_id: cid,
      nome: 'Gestor Demo',
      email: EMAIL_GESTOR,
      telefone: '910000000',
      nif: '999999999',
      tipo: 'proprietario',
      ativo: true,
    });
    passo(`Pessoa do gestor criada (#${pessoa.id}).`);
  }

  let alteracoes = 0;
  const descricao = [];

  // 2. `users.pessoa_id` — é isto que remove o aviso «A sua conta ainda não
  //    está associada a um condómino neste condomínio» em todas as vistas.
  if (pessoa && Number(gestor.pessoa_id) !== Number(pessoa.id)) {
    if (!dryRun) await gestor.update({ pessoa_id: pessoa.id });
    alteracoes += 1;
    descricao.push(`users.pessoa_id → ${pessoa.id}`);
  }

  // 3. `users.role = 'admin'` — decide o destino após o login
  //    (`routes/index.js: destinoAposLogin` → `/admin`).
  if (gestor.role !== 'admin') {
    if (!dryRun) await gestor.update({ role: 'admin' });
    alteracoes += 1;
    descricao.push("users.role → 'admin'");
  }

  // 4. O papel POR CONDOMÍNIO (fonte de verdade das permissões).
  //    `comPapel('admin')` (helpers/tenant.js:121) exige `role = 'admin'` E a
  //    associação ATIVA (`associacaoAtiva` filtra por `estado = 'ativo'`,
  //    helpers/tenant.js:21). Sem as duas coisas, `/` → `/admin` → `/` produz
  //    ERR_TOO_MANY_REDIRECTS: `destinoAposLogin` (routes/index.js:16) manda
  //    para `/admin` por `users.role`, e `comPapel` devolve a `/` por este
  //    papel. Aqui garantem-se as duas.
  const associacao = await UserCondominio.findOne({
    where: { utilizador_id: gestor.id, condominio_id: cid },
  });
  if (!associacao) {
    if (!dryRun) {
      await UserCondominio.create({
        utilizador_id: gestor.id, condominio_id: cid, role: 'admin', estado: 'ativo',
      });
    }
    alteracoes += 1;
    descricao.push("UserCondominio criada com role 'admin' e estado 'ativo'");
  } else {
    const corrigir = {};
    if (associacao.role !== 'admin') {
      corrigir.role = 'admin';
      descricao.push(`UserCondominio.role → 'admin' (era '${associacao.role}')`);
    }
    if (associacao.estado !== 'ativo') {
      corrigir.estado = 'ativo';
      descricao.push(`UserCondominio.estado → 'ativo' (era '${associacao.estado}')`);
    }
    // Um só UPDATE com o que falta (0 campos ⇒ nenhuma escrita).
    if (!dryRun && Object.keys(corrigir).length) await associacao.update(corrigir);
    alteracoes += Object.keys(corrigir).length;
  }

  // 5. Titularidade do gestor — NÃO é requisito de autenticação nem de
  //    administração (essas dependem só de `users.role` e da associação).
  //    Serve as invariantes do seed e o conteúdo do portal, pelo que só se
  //    cria quando NÃO existe nenhuma ativa. Idempotência pelas DUAS vias de
  //    acesso que `fracoesDoUtilizador` (helpers/titularidades.js:154)
  //    reconhece: `utilizador_id` (tem precedência) ou `pessoa_id`. Nunca
  //    sobrepõe uma titularidade existente de outra pessoa/conta — se todas as
  //    frações já tiverem titular ativa, não se cria nada.
  if (pessoa) {
    const porConta = await FracaoTitularidade.findOne({
      where: { condominio_id: cid, utilizador_id: gestor.id, estado: 'ativa' },
    });
    const porPessoa = porConta
      ? null
      : await FracaoTitularidade.findOne({
          where: { condominio_id: cid, pessoa_id: pessoa.id, estado: 'ativa' },
        });
    if (!porConta && !porPessoa) {
      // Fração de um proprietário SEM conta de portal (o caso que o
      // administrador tem de ver e resolver). Nunca sobrepõe o acesso de
      // outra conta, porque nessas o `utilizador_id` decide.
      const ocupadas = new Set(
        (await FracaoTitularidade.findAll({
          where: { condominio_id: cid, estado: 'ativa' },
          attributes: ['fracao_id'],
        })).map((t) => Number(t.fracao_id))
      );
      const candidata = (await Fracao.findAll({ where: { condominio_id: cid }, order: [['id', 'ASC']] }))
        .find((f) => !ocupadas.has(Number(f.id)));
      if (candidata) {
        if (!dryRun) {
          await FracaoTitularidade.create({
            condominio_id: cid,
            fracao_id: candidata.id,
            pessoa_id: pessoa.id,
            utilizador_id: gestor.id,
            vinculo: 'proprietario',
            data_inicio: `${new Date().getFullYear() - 1}-01-01`,
            data_fim: null,
            estado: 'ativa',
            created_by: gestor.id,
          });
        }
        alteracoes += 1;
        descricao.push(`FracaoTitularidade criada na fração #${candidata.id}`);
      } else {
        passo('Todas as frações já têm titular ativa — nenhuma titularidade criada.');
      }
    }
  }

  if (!alteracoes) {
    passo('Já estava tudo correto — nada a alterar.');
  } else {
    for (const d of descricao) passo(`· ${d}`);
    passo(`${alteracoes} alteração(ões)${dryRun ? ' (simuladas — --dry-run não escreveu nada)' : ''}.`);
  }
  return { alteracoes };
}

async function apagarCondominioDemo(condominio, { dryRun }) {
  const cid = condominio.id;
  titulo('RESET — remover o condomínio de demonstração');
  passo(`Condomínio: #${cid} ${condominio.designacao}`);

  // Contagens para o utilizador ver o que vai (ou foi) removido.
  const contagens = {
    fracoes: await Fracao.count({ where: { condominio_id: cid } }),
    pessoas: await Pessoa.count({ where: { condominio_id: cid } }),
    quotas: await Quota.count({ where: { condominio_id: cid } }),
    pagamentos: await Pagamento.count({ where: { condominio_id: cid } }),
    despesas: await Despesa.count({ where: { condominio_id: cid } }),
    movimentos: await MovimentoBancario.count({ where: { condominio_id: cid } }),
  };
  for (const [k, v] of Object.entries(contagens)) passo(`  ${k}: ${v}`);

  if (dryRun) {
    passo('--dry-run: nada foi apagado.');
    return;
  }

  // A ordem é a inversa das dependências. As tabelas-filho sem
  // `condominio_id` (pagamento_quotas, etc.) são removidas pelos seus pais.
  const t = await sequelize.transaction();
  try {
    const fracoes = await Fracao.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsFracoes = fracoes.map((f) => f.id);
    const quotas = await Quota.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsQuotas = quotas.map((q) => q.id);
    const pagamentos = await Pagamento.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsPagamentos = pagamentos.map((p) => p.id);
    const extras = await ExtraQuota.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsExtras = extras.map((e) => e.id);
    const parcelas = idsExtras.length
      ? await ExtraQuotaParcela.findAll({ where: { extra_quota_id: { [Op.in]: idsExtras } }, attributes: ['id'], transaction: t })
      : [];
    const idsParcelas = parcelas.map((p) => p.id);
    const recibos = await Recibo.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsRecibos = recibos.map((r) => r.id);
    const assembleias = await Assembleia.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsAssembleias = assembleias.map((a) => a.id);
    const avisos = await Aviso.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsAvisos = avisos.map((a) => a.id);
    const orcamentos = await Orcamento.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsOrcamentos = orcamentos.map((o) => o.id);

    // Filhos sem condominio_id próprio
    if (idsPagamentos.length) {
      await PagamentoQuota.destroy({ where: { pagamento_id: { [Op.in]: idsPagamentos } }, transaction: t });
      await PagamentoExtraParcela.destroy({ where: { pagamento_id: { [Op.in]: idsPagamentos } }, transaction: t });
    }
    if (idsQuotas.length) await ReciboQuota.destroy({ where: { quota_id: { [Op.in]: idsQuotas } }, transaction: t });
    if (idsRecibos.length) {
      await ReciboQuota.destroy({ where: { recibo_id: { [Op.in]: idsRecibos } }, transaction: t });
      const { ReciboExtraParcela } = require('../models');
      await ReciboExtraParcela.destroy({ where: { recibo_id: { [Op.in]: idsRecibos } }, transaction: t });
    }
    if (idsAssembleias.length) {
      const itens = await AgendaItem.findAll({ where: { assembleia_id: { [Op.in]: idsAssembleias } }, attributes: ['id'], transaction: t });
      const idsItens = itens.map((i) => i.id);
      if (idsItens.length) {
        await MovimentoBancario.update({ deliberacao_id: null }, { where: { deliberacao_id: { [Op.in]: idsItens } }, transaction: t });
        await Despesa.update({ deliberacao_id: null }, { where: { deliberacao_id: { [Op.in]: idsItens } }, transaction: t });
        await AgendaItem.destroy({ where: { id: { [Op.in]: idsItens } }, transaction: t });
      }
      await AssembleiaParticipante.destroy({ where: { assembleia_id: { [Op.in]: idsAssembleias } }, transaction: t });
    }
    if (idsAvisos.length) await AvisoDestinatario.destroy({ where: { aviso_id: { [Op.in]: idsAvisos } }, transaction: t });
    if (idsExtras.length) await ExtraQuotaParcela.destroy({ where: { extra_quota_id: { [Op.in]: idsExtras } }, transaction: t });
    if (idsOrcamentos.length) {
      await OrcamentoDistribuicao.destroy({ where: { orcamento_id: { [Op.in]: idsOrcamentos } }, transaction: t });
      await OrcamentoRubrica.destroy({ where: { orcamento_id: { [Op.in]: idsOrcamentos } }, transaction: t });
      const { PlanoQuota, OrcamentoAlteracao } = require('../models');
      await PlanoQuota.destroy({ where: { orcamento_id: { [Op.in]: idsOrcamentos } }, transaction: t });
      await OrcamentoAlteracao.destroy({ where: { orcamento_id: { [Op.in]: idsOrcamentos } }, transaction: t });
    }

    // Movimentos antes das contas (a FK é RESTRICT).
    await MovimentoBancario.destroy({ where: { condominio_id: cid }, transaction: t });
    await Pagamento.destroy({ where: { condominio_id: cid }, transaction: t });
    await Quota.destroy({ where: { condominio_id: cid }, transaction: t });
    await Despesa.destroy({ where: { condominio_id: cid }, transaction: t });
    await Recibo.destroy({ where: { condominio_id: cid }, transaction: t });
    await ExtraQuota.destroy({ where: { condominio_id: cid }, transaction: t });
    await Aviso.destroy({ where: { condominio_id: cid }, transaction: t });
    await Assembleia.destroy({ where: { condominio_id: cid }, transaction: t });
    await Orcamento.destroy({ where: { condominio_id: cid }, transaction: t });
    await Documento.destroy({ where: { condominio_id: cid }, transaction: t });
    await ContaBancaria.destroy({ where: { condominio_id: cid }, transaction: t });
    await Fornecedor.destroy({ where: { condominio_id: cid }, transaction: t });

    // Filhos de fração/pessoa (antes dos pais, por causa das FKs).
    const pessoasDoDemo = await Pessoa.findAll({ where: { condominio_id: cid }, attributes: ['id'], transaction: t });
    const idsPessoas = pessoasDoDemo.map((p) => p.id);
    if (idsPessoas.length) {
      const { ContactoPessoa } = require('../models');
      await ContactoPessoa.destroy({ where: { pessoa_id: { [Op.in]: idsPessoas } }, transaction: t });
    }
    if (idsFracoes.length) {
      await FracaoPessoa.destroy({ where: { fracao_id: { [Op.in]: idsFracoes } }, transaction: t });
      await FracaoTitularidade.destroy({ where: { fracao_id: { [Op.in]: idsFracoes } }, transaction: t });
    }
    await Fracao.destroy({ where: { condominio_id: cid }, transaction: t });
    await Pessoa.destroy({ where: { condominio_id: cid }, transaction: t });

    // Utilizadores demo e as suas ligações
    const ligacoes = await UserCondominio.findAll({ where: { condominio_id: cid }, attributes: ['utilizador_id'], transaction: t });
    const idsUsers = ligacoes.map((l) => l.utilizador_id);
    await UserCondominio.destroy({ where: { condominio_id: cid }, transaction: t });
    if (idsUsers.length) {
      const { RecomendacaoEstado } = require('../models');
      await RecomendacaoEstado.destroy({ where: { user_id: { [Op.in]: idsUsers } }, transaction: t });
      // Só apaga utilizadores que NÃO estejam noutro condomínio — nunca se
      // remove uma conta real usada por outro condomínio.
      const aindaLigados = await UserCondominio.findAll({
        where: { utilizador_id: { [Op.in]: idsUsers } },
        attributes: ['utilizador_id'],
        transaction: t,
      });
      const usadosNoutro = new Set(aindaLigados.map((l) => l.utilizador_id));
      const apagaveis = idsUsers.filter((id) => !usadosNoutro.has(id));
      if (apagaveis.length) await User.destroy({ where: { id: { [Op.in]: apagaveis } }, transaction: t });
    }

    // Configuração de quotas do condomínio (chaves com o id do condomínio).
    await sequelize.query('DELETE FROM configuracoes WHERE chave IN (?, ?)', {
      replacements: [`quota_valor_1000:c${cid}`, `quota_fcr_percentagem:c${cid}`],
      transaction: t,
    });
    // Numeração: só a que o seed criou/reservou para o demo. Nunca apagar toda
    // a tabela — isso destruiria a sequência de documentos de outros
    // condomínios. Como não existe `condominio_id` em `numeracoes`, recua-se a
    // sequência dos recibos demo em vez de apagar registos.
    const recibosDemo = await Recibo.count({ where: { condominio_id: cid }, transaction: t });
    if (recibosDemo > 0) {
      await Numeracao.update(
        { sequencia: 0 },
        { where: { tipo_documento: 'recibo', sequencia: { [Op.lte]: recibosDemo } }, transaction: t }
      );
    }

    await Condominio.destroy({ where: { id: cid }, transaction: t });
    await t.commit();
    passo('Condomínio de demonstração removido.');
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// CRIAÇÃO
// ═══════════════════════════════════════════════════════════════════
async function criarDemo() {
  const agora = new Date();
  const anoAtual = agora.getFullYear();
  const mesAtual = agora.getMonth() + 1;
  // 14 meses: 2 do ANO ANTERIOR (Nov–Dez) + 12 do ANO CORRENTE (Jan–Dez).
  // As quotas são emitidas para o ANO CIVIL COMPLETO (Jan–Dez do ano corrente),
  // como um condomínio real faz; os futuros ficam 'pendente' (ainda não
  // vencidos) e os passados acumulam atrasos. Acrescentam-se 2 meses do ano
  // anterior para o Extrato ter "Saldo anterior" com movimento real.
  const meses = [];
  for (let i = 13; i >= 0; i -= 1) {
    meses.push(somaMeses(anoAtual, 12, -i)); // Dez do ano corrente − 13 … Dez do ano corrente
  }
  const primeiroMes = meses[0];
  const anoAnterior = meses[0].ano;

  // ── FASE 1: condomínio ─────────────────────────────────────────────
  titulo('1. Condomínio');
  const condominio = await Condominio.create({
    designacao: DESIGNACAO,
    administracao_nome: 'Gestão Demo, Lda. (fictícia)',
    website: null,
    nif: '999999990', // NIF de teste (não corresponde a entidade real)
    morada: 'Rua da Demonstração, 100',
    codigo_postal: '1000-001',
    localidade: 'Lisboa (fictícia)',
    email: 'demo.condominio@example.test',
    telefone: '210000000',
    iban_principal: 'PT50000000000000000000000',
    identidade_visual: 'designacao',
    estado: 'ativo',
  });
  const cid = condominio.id;
  passo(`#${cid} ${DESIGNACAO}`);
  passo(`Período: ${primeiroMes.ano}-${String(primeiroMes.mes).padStart(2, '0')} → ${meses[13].ano}-${String(meses[13].mes).padStart(2, '0')}`);

  // Configuração de quotas NO ÂMBITO do condomínio (não global).
  await setConfig(`quota_valor_1000:c${cid}`, '120.0000');
  await setConfig(`quota_fcr_percentagem:c${cid}`, '10');
  const quotaCfg = await getQuotaConfig(cid);
  passo(`Quota: ${quotaCfg.valorPor1000} €/1000‰ · FCR ${quotaCfg.fcrPercentagem}%`);

  // ── FASE 2: gestor + condóminos ────────────────────────────────────
  titulo('2. Gestor e condóminos');
  const hashGestor = await bcrypt.hash(PASSWORD_GESTOR, 10);
  const hashCondomino = await bcrypt.hash(PASSWORD_CONDOMINO, 10);

  // O gestor é TAMBÉM um condómino: o modelo do GesCondu liga a conta a uma
  // `Pessoa` do condomínio por `users.pessoa_id` (é o que o fluxo real faz em
  // `routes/admin.js` — `Pessoa.create` e depois `User.create({ pessoa_id })`).
  // Sem essa ligação, `routes/condomino.js` (`contextoFracoes`) devolve
  // `pessoa = null` e qualquer vista do portal mostra «A sua conta ainda não
  // está associada a um condómino neste condomínio».
  // Não se cria aqui nenhuma `FracaoPessoa`/`FracaoTitularidade` para o gestor:
  // a fração do gestor é ligada a seguir, na fase 3, junto com as restantes
  // (uma pessoa não pode ter duas titularidades ativas para a mesma fração).
  const pessoaGestor = await Pessoa.create({
    condominio_id: cid,
    nome: 'Gestor Demo',
    email: EMAIL_GESTOR,
    telefone: '910000000',
    nif: '999999999',
    tipo: 'proprietario',
    ativo: true,
  });

  const gestor = await User.create({
    email: EMAIL_GESTOR,
    password_hash: hashGestor,
    nome: 'Gestor Demo',
    // `users.role` é o papel LEGADO que decide o destino após o login
    // (`routes/index.js: destinoAposLogin` manda para `/admin` só quando
    // `user.role === 'admin'`). Com 'condomino' o login caía em `/condomino`.
    role: 'admin',
    provider: 'local',
    pessoa_id: pessoaGestor.id, // liga a conta ao condómino (obrigatório no portal)
    email_confirmado: true,
    ativo: true,
  });
  // O papel POR CONDOMÍNIO (fonte de verdade das permissões) tem de ser 'admin':
  // `routes/admin.js` exige `comPapel('admin')` e `gestor` (20) não satisfaz
  // `admin` (30) (helpers/tenant.js: PAPEIS).
  await UserCondominio.create({ utilizador_id: gestor.id, condominio_id: cid, role: 'admin', estado: 'ativo' });
  passo(`Gestor: ${EMAIL_GESTOR} / ${PASSWORD_GESTOR} (role admin + pessoa #${pessoaGestor.id})`);

  // ── FASE 3: frações, pessoas, titularidades ────────────────────────
  titulo('3. Frações, pessoas e titularidades');
  const fracoes = [];
  for (const def of FRACOES_DEF) {
    fracoes.push(await Fracao.create({
      condominio_id: cid,
      designacao: def.designacao,
      permilagem: def.permilagem,
      andar: def.andar,
      porta: def.porta,
      transitado: 0,
      estado: 'ativo',
    }));
  }
  const somaPermilagens = fracoes.reduce((s, f) => s + Number(f.permilagem), 0);
  passo(`6 frações · Σ permilagens = ${somaPermilagens}‰`);
  if (somaPermilagens !== 1000) {
    throw new Error(`Σ permilagens = ${somaPermilagens}‰ (tem de ser exatamente 1000‰).`);
  }

  const pessoas = [];
  const usersCondominos = [];
  for (let i = 0; i < PESSOAS_DEF.length; i += 1) {
    const def = PESSOAS_DEF[i];
    const fracao = fracoes[def.fracao];
    const pessoa = await Pessoa.create({
      condominio_id: cid,
      nome: def.nome,
      email: `${PREFIXO_EMAIL}${def.nome.split(' ')[0].toLowerCase()}@example.test`,
      telefone: `91000000${i}`,
      nif: `99999999${i}`,
      tipo: def.vinculo === 'arrendatario' ? 'arrendatario' : 'proprietario',
      ativo: true,
    });
    pessoas.push(pessoa);

    // Ligação pessoa↔fração (o fluxo do administrador escreve esta tabela).
    await FracaoPessoa.create({
      fracao_id: fracao.id,
      pessoa_id: pessoa.id,
      vinculo: def.vinculo,
      data_inicio: `${anoAnterior}-01-01`,
      data_fim: null,
    });

    // Conta de acesso ao portal (quando aplicável).
    let user = null;
    if (def.conta) {
      user = await User.create({
        email: pessoa.email,
        password_hash: hashCondomino,
        nome: pessoa.nome,
        role: 'condomino',
        provider: 'local',
        pessoa_id: pessoa.id,
        email_confirmado: true,
        ativo: true,
      });
      await UserCondominio.create({ utilizador_id: user.id, condominio_id: cid, role: 'leitura', estado: 'ativo' });
      usersCondominos.push(user);
    }

    // 🔴 Titularidade: é ISTO que dá acesso às frações no portal
    // (`fracoesDoUtilizador` exige estado='ativa' e ligação por
    // utilizador_id ou pessoa_id). Sem esta linha o portal fica vazio.
    await FracaoTitularidade.create({
      condominio_id: cid,
      fracao_id: fracao.id,
      pessoa_id: pessoa.id,
      utilizador_id: user ? user.id : null,
      vinculo: def.vinculo,
      data_inicio: `${anoAnterior}-01-01`,
      data_fim: null,
      estado: 'ativa',
      created_by: gestor.id,
    });
  }
  passo(`${pessoas.length} pessoas · ${usersCondominos.length} contas de portal (${PESSOAS_DEF.filter((p) => !p.conta).length} sem conta)`);
  passo(`Palavra-passe dos condóminos: ${PASSWORD_CONDOMINO}`);

  // O gestor tem a sua própria `Pessoa` (criada na fase 2, ligada por
  // `users.pessoa_id`) e é também titular de uma fração — o caso mais comum num
  // condomínio real: quem administra é muitas vezes proprietário.
  // Escolhe-se a fração do proprietário SEM conta de portal (a 1.ª de
  // `PESSOAS_DEF` com `conta: false`): é o cenário que o administrador tem de
  // conseguir ver e resolver, e evita sobrepor-se a uma titularidade já
  // associada a uma conta de portal (nessas o `utilizador_id` decide e o gestor
  // não teria acesso). Fica exatamente UMA titularidade ativa por fração.
  const indiceFracoSemConta = PESSOAS_DEF.findIndex((p) => !p.conta);
  if (indiceFracoSemConta >= 0) {
    await FracaoTitularidade.create({
      condominio_id: cid,
      fracao_id: fracoes[indiceFracoSemConta].id,
      pessoa_id: pessoaGestor.id,
      utilizador_id: gestor.id,
      vinculo: 'proprietario',
      data_inicio: `${anoAnterior}-01-01`,
      data_fim: null,
      estado: 'ativa',
      created_by: gestor.id,
    });
    passo(`Titularidade do gestor na fração ${fracoes[indiceFracoSemConta].designacao} (proprietário sem conta)`);
  }

  // ── FASE 4: contas bancárias ───────────────────────────────────────
  titulo('4. Contas bancárias');
  const contaCorrente = await ContaBancaria.create({
    condominio_id: cid,
    nome: 'CA — Conta Corrente',
    banco: 'Banco Demo (fictício)',
    iban: 'PT50000000000000000000001',
    tipo: 'corrente',
    saldo_inicial: 2500.0,
    data_inicio: `${anoAnterior}-01-01`,
    data_saldo_inicial: `${anoAnterior}-01-01`,
    ativa: true,
  });
  const contaFcr = await ContaBancaria.create({
    condominio_id: cid,
    nome: 'CA — Fundo de Reserva',
    banco: 'Banco Demo (fictício)',
    iban: 'PT50000000000000000000002',
    tipo: 'fundo_reserva',
    saldo_inicial: 0,
    data_inicio: `${anoAnterior}-01-01`,
    data_saldo_inicial: `${anoAnterior}-01-01`,
    ativa: true,
  });
  const contaPoupanca = await ContaBancaria.create({
    condominio_id: cid,
    nome: 'CA — Poupança',
    banco: 'Banco Demo (fictício)',
    iban: 'PT50000000000000000000003',
    tipo: 'poupanca',
    saldo_inicial: 1800.0,
    data_inicio: `${anoAnterior}-01-01`,
    data_saldo_inicial: `${anoAnterior}-01-01`,
    ativa: true,
  });
  passo('3 contas: corrente (2 500,00 €) · fundo_reserva (0,00 €) · poupanca (1 800,00 €)');

  // ── FASE 5: categorias, métodos e fornecedores ─────────────────────
  titulo('5. Categorias, métodos e fornecedores');
  const cat = async (nome) => Categoria.findOne({ where: { nome } });
  const categoriaQuotas = await cat('Quotas');
  const metodoTransferencia = await MetodoPagamento.findOne({ where: { nome: 'Transferência bancária' } });
  const metodoMultibanco = await MetodoPagamento.findOne({ where: { nome: 'Multibanco' } });
  if (!categoriaQuotas || !metodoTransferencia) {
    throw new Error('Faltam categorias/métodos base — corra primeiro `npm run db:seed`.');
  }

  const fornecedores = [];
  for (const def of FORNECEDORES_DEF) {
    fornecedores.push(await Fornecedor.create({
      condominio_id: cid,
      nome: def.nome,
      nif: '999999900',
      morada: 'Rua da Demonstração, 200',
      codigo_postal: '1000-002',
      localidade: 'Lisboa (fictícia)',
      email: `demo.fornecedor@example.test`,
      telefone: '210000001',
      iban: 'PT50000000000000000000009',
      ativo: true,
    }));
  }
  passo(`${fornecedores.length} fornecedores fictícios`);

  // ── FASE 6: orçamento ──────────────────────────────────────────────
  titulo('6. Orçamento');
  const orcamento = await Orcamento.create({
    condominio_id: cid,
    designacao: `Orçamento ${anoAtual}`,
    ano: anoAtual,
    saldo_transitado: 0,
    data_inicio: `${anoAtual}-01-01`,
    data_fim: `${anoAtual}-12-31`,
    metodo_calculo: 'modo_a',
    estado: 'em_execucao',
    data_aprovacao: `${anoAtual}-01-15`,
    aprovado_por: gestor.id,
    observacoes: 'Orçamento de demonstração (fictício).',
  });

  const RUBRICAS = [
    { descricao: 'Limpeza das zonas comuns', categoria: 'Limpeza', valor: 3600 },
    { descricao: 'Manutenção geral', categoria: 'Manutenção', valor: 2400 },
    { descricao: 'Contrato de elevadores', categoria: 'Elevador', valor: 1200 },
    { descricao: 'Seguro do edifício', categoria: 'Seguros', valor: 900 },
    { descricao: 'Eletricidade das zonas comuns', categoria: 'Eletricidade', valor: 1500 },
  ];
  const rubricas = [];
  for (const r of RUBRICAS) {
    const categoria = await cat(r.categoria);
    rubricas.push(await OrcamentoRubrica.create({
      orcamento_id: orcamento.id,
      categoria_id: categoria ? categoria.id : null,
      descricao: r.descricao,
      valor_anual: r.valor,
      metodo_distribuicao: 'permilagem',
      periodicidade: 'mensal',
      ativo: true,
    }));
  }
  // Distribuição por fração, proporcional à permilagem (é o que o
  // Relatório Financeiro usa para comparar orçamentado vs. real).
  for (const rubrica of rubricas) {
    for (const fracao of fracoes) {
      const valorAnualC = Math.round(toCents(rubrica.valor_anual) * Number(fracao.permilagem) / 1000);
      await OrcamentoDistribuicao.create({
        orcamento_id: orcamento.id,
        rubrica_id: rubrica.id,
        fracao_id: fracao.id,
        valor_anual: fromCents(valorAnualC),
      });
    }
  }
  const totalOrcamentadoC = rubricas.reduce((s, r) => s + toCents(r.valor_anual), 0);
  passo(`${rubricas.length} rubricas · ${eur(totalOrcamentadoC)} orçamentados`);

  // ── FASE 7: quotas ─────────────────────────────────────────────────
  titulo('7. Quotas (14 meses × 6 frações)');
  const valorPor1000C = Math.round(toCents(quotaCfg.valorPor1000));
  const fcrPercentagem = Number(String(quotaCfg.fcrPercentagem).replace(',', '.'));
  const quotas = [];
  for (const fracao of fracoes) {
    const permilagem = Number(fracao.permilagem);
    // valor_base = permilagem/1000 × valor por 1000‰
    // valor_fcr  = valor_base × fcr%      valor = valor_base + valor_fcr
    const baseC = Math.round((valorPor1000C * permilagem) / 1000);
    const fcrC = Math.round((baseC * fcrPercentagem) / 100);
    const totalC = baseC + fcrC;
    for (const m of meses) {
      const vencimento = `${m.ano}-${String(m.mes).padStart(2, '0')}-10`;
      quotas.push(await Quota.create({
        condominio_id: cid,
        fracao_id: fracao.id,
        orcamento_id: orcamento.id,
        ano: m.ano,
        mes: m.mes,
        periodo: `${m.ano}-${String(m.mes).padStart(2, '0')}-01`,
        valor: fromCents(totalC),
        valor_base: fromCents(baseC),
        valor_fcr: fromCents(fcrC),
        valor_por_1000: fromCents(valorPor1000C),
        permilagem_aplicada: permilagem,
        fcr_percentagem: fcrPercentagem,
        data_emissao: `${m.ano}-${String(m.mes).padStart(2, '0')}-01`,
        data_vencimento: vencimento,
        // O estado é DERIVADO dos pagamentos (`recalcularEstadoQuota`).
        // Fica 'pendente' aqui; os pagamentos da fase 8 é que o alteram.
        estado: 'pendente',
      }));
    }
  }
  passo(`${quotas.length} quotas criadas (estado inicial 'pendente' — derivado a seguir)`);

  // ── FASE 8: pagamentos (estados derivados pelos writers) ───────────
  titulo('8. Pagamentos de quotas');
  // Plano de pagamento por fração. `mesesPagos` conta meses A PARTIR DO
  // PRIMEIRO (Nov do ano anterior). As quotas pagas têm sempre data de
  // pagamento coerente (dia 8 do próprio mês) e nunca se paga o futuro.
  //   0 = em dia: paga tudo o que já venceu (11 meses), deixa o futuro pendente
  //   1 = 10 pagos + 1 PARCIAL → fica 'parcialmente_paga' e vencida
  //   2 = só 6 pagos → dívida antiga (proprietário sem conta de portal)
  //   3 = 8 pagos (arrendatário, atraso moderado)
  //   4 = em dia: paga tudo o que já venceu
  //   5 = só 5 pagos → dívida significativa
  // O número de meses pagos nunca excede os meses já vencidos (calculado a
  // partir de `hoje`), para não haver "pago no futuro".
  const piso = new Date();
  piso.setHours(0, 0, 0, 0);
  const indiceUltimoVencido = meses.reduce((acc, m, idx) => {
    const venc = new Date(m.ano, m.mes - 1, 10);
    return venc < piso ? idx : acc;
  }, -1);
  const vencidos = indiceUltimoVencido + 1; // quantos meses já venceram
  const plano = [
    { mesesPagos: vencidos, parcial: null }, // em dia
    { mesesPagos: Math.max(0, vencidos - 1), parcial: vencidos - 1 }, // 1 parcial
    { mesesPagos: Math.min(6, vencidos), parcial: null }, // dívida antiga
    { mesesPagos: Math.min(8, vencidos), parcial: null }, // atraso moderado
    { mesesPagos: vencidos, parcial: null }, // em dia
    { mesesPagos: Math.min(5, vencidos), parcial: null }, // dívida significativa
  ];
  let nPagamentos = 0;
  for (let fi = 0; fi < fracoes.length; fi += 1) {
    const fracao = fracoes[fi];
    const quotasDaFracao = quotas.filter((q) => q.fracao_id === fracao.id);
    const p = plano[fi % plano.length];
    for (let mi = 0; mi < p.mesesPagos && mi < quotasDaFracao.length; mi += 1) {
      const quota = quotasDaFracao[mi];
      const dia = `${quota.ano}-${String(quota.mes).padStart(2, '0')}-08`;
      await registarPagamento({
        fracaoId: fracao.id,
        valor: quota.valor,
        dataPagamento: dia,
        metodoPagamentoId: metodoTransferencia.id,
        contaBancariaId: contaCorrente.id,
        referencia: `DEMO-${quota.ano}${String(quota.mes).padStart(2, '0')}`,
        observacoes: 'Pagamento de demonstração',
        userId: gestor.id,
        condominioId: cid,
      });
      nPagamentos += 1;
    }
    // Pagamento PARCIAL: metade da quota, para o estado ficar
    // 'parcialmente_paga' pelo próprio writer (nunca forçado).
    if (p.parcial !== null && p.parcial >= 0 && quotasDaFracao[p.parcial]) {
      const quota = quotasDaFracao[p.parcial];
      await registarPagamento({
        fracaoId: fracao.id,
        valor: fromCents(Math.round(toCents(quota.valor) / 2)),
        dataPagamento: `${quota.ano}-${String(quota.mes).padStart(2, '0')}-12`,
        metodoPagamentoId: metodoMultibanco.id,
        contaBancariaId: contaCorrente.id,
        referencia: `DEMO-PARCIAL-${quota.ano}${String(quota.mes).padStart(2, '0')}`,
        observacoes: 'Pagamento parcial de demonstração',
        userId: gestor.id,
        condominioId: cid,
      });
      nPagamentos += 1;
    }
  }
  passo(`${nPagamentos} pagamentos registados via registarPagamento() · ${vencidos}/14 meses já vencidos`);

  // Contagens por estado (DERIVADAS — é o writer que as escreve).
  const porEstado = {};
  for (const q of await Quota.findAll({ where: { condominio_id: cid }, attributes: ['estado'] })) {
    porEstado[q.estado] = (porEstado[q.estado] || 0) + 1;
  }
  passo(`Estados das quotas: ${Object.entries(porEstado).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

  // ── FASE 9: despesas ───────────────────────────────────────────────
  titulo('9. Despesas');
  // `mes` é o MÊS CIVIL do ano corrente (1 = Janeiro). A competência é o que
  // decide o ano no Relatório Financeiro, por isso é ela que se acerta.
  // Os valores são DIMENSIONADOS à receita do condomínio (~132 €/mês de quotas,
  // 1 848 € em 14 meses) para que a tesouraria seja positiva e sustentável —
  // um cenário com despesas maiores do que a receita não seria uma demonstração
  // credível e deixaria as contas a descoberto.
  const DESPESAS_DEF = [
    { descricao: 'Limpeza — 1.º trimestre', categoria: 'Limpeza', valor: 180, fornecedor: 0, paga: true, mes: 5 },
    { descricao: 'Manutenção do portão', categoria: 'Manutenção', valor: 90, fornecedor: 1, paga: true, mes: 6 },
    { descricao: 'Contrato de elevadores — trimestral', categoria: 'Elevador', valor: 120, fornecedor: 2, paga: true, mes: 7 },
    { descricao: 'Seguro do edifício — anual', categoria: 'Seguros', valor: 150, fornecedor: 3, paga: true, mes: 8 },
    { descricao: 'Eletricidade — 1.º semestre', categoria: 'Eletricidade', valor: 130, fornecedor: null, paga: true, mes: 9 },
    { descricao: 'Limpeza — 3.º trimestre', categoria: 'Limpeza', valor: 180, fornecedor: 0, paga: false, mes: 10 },
    { descricao: 'Reparação de telhado (orçamento)', categoria: 'Manutenção', valor: 280, fornecedor: 1, paga: false, mes: 11 },
  ];
  // Resolve o mês civil pedido para o mês de calendário mais próximo que esteja
  // DENTRO da janela de 14 meses (nunca no futuro; a competência tem de existir
  // no período, senão o Relatório Financeiro não a mostra).
  const mesDoAno = (civil) => {
    const exato = meses.find((m) => m.ano === anoAtual && m.mes === civil);
    if (exato) return exato;
    // Se o mês civil ainda não entrou na janela, usa o último mês disponível
    // do ano corrente (o mais próximo possível, sem inventar o futuro).
    const doAnoAtual = meses.filter((m) => m.ano === anoAtual);
    return doAnoAtual.length ? doAnoAtual[doAnoAtual.length - 1] : meses[meses.length - 1];
  };
  let nDespesasPagas = 0;
  for (const d of DESPESAS_DEF) {
    const categoria = await cat(d.categoria);
    const mes = mesDoAno(d.mes);
    const dia = `${mes.ano}-${String(mes.mes).padStart(2, '0')}-15`;
    const despesa = await Despesa.create({
      condominio_id: cid,
      descricao: d.descricao,
      categoria_id: categoria ? categoria.id : null,
      valor: d.valor,
      data: dia,
      // 🔴 A competência (não a `data`) decide o ano no Relatório Financeiro.
      competencia_ano: mes.ano,
      competencia_mes: mes.mes,
      fornecedor: d.fornecedor !== null ? fornecedores[d.fornecedor].nome : 'Fornecedor diverso',
      fornecedor_id: d.fornecedor !== null ? fornecedores[d.fornecedor].id : null,
      conta_bancaria_id: d.paga ? contaCorrente.id : null,
      metodo_pagamento_id: d.paga ? metodoTransferencia.id : null,
      estado: d.paga ? 'paga' : 'registada',
      observacoes: 'Despesa de demonstração',
    });
    // O writer decide se cria o movimento (despesa paga + conta) ou anula o
    // existente. Nunca se escreve o movimento à mão.
    await sincronizarMovimentoDespesa(despesa, gestor.id, undefined, cid);
    if (d.paga) nDespesasPagas += 1;
  }
  passo(`${DESPESAS_DEF.length} despesas (${nDespesasPagas} pagas, ${DESPESAS_DEF.length - nDespesasPagas} por pagar)`);

  // ── FASE 10: quota extra ───────────────────────────────────────────
  titulo('10. Quota extraordinária');
  const totalExtraC = 240000; // 2 400,00 €
  const extra = await ExtraQuota.create({
    condominio_id: cid,
    designacao: 'Obras de impermeabilização da cobertura',
    valor_total: fromCents(totalExtraC),
    metodo_divisao: 'permilagem',
    mes_inicio: mesAtual,
    ano_inicio: anoAtual,
    numero_parcelas: 4,
    periodicidade: 'trimestral',
    estado: 'pendente',
  });
  // Ciclo de vida real: pendente → aprovada → processada. Só 'processada' é
  // cobrável — não se salta nenhuma etapa.
  await extra.update({ estado: 'aprovada', aprovado_por: gestor.id, aprovado_em: diaISO(agora) });
  const parcelas = [];
  for (const fracao of fracoes) {
    const totalFracaoC = Math.round((totalExtraC * Number(fracao.permilagem)) / 1000);
    const porParcelaC = Math.round(totalFracaoC / 4);
    for (let n = 1; n <= 4; n += 1) {
      // Ajuste de arredondamento na última parcela, para a soma bater certo.
      const valorC = n === 4 ? totalFracaoC - (porParcelaC * 3) : porParcelaC;
      // As parcelas começam 3 meses ANTES do mês corrente, para que as duas
      // primeiras (as que se pagam) já estejam vencidas e as restantes fiquem
      // por cobrar — nunca se paga uma parcela no futuro.
      const { ano, mes } = somaMeses(anoAtual, mesAtual, n - 4);
      parcelas.push(await ExtraQuotaParcela.create({
        extra_quota_id: extra.id,
        fracao_id: fracao.id,
        parcela_numero: n,
        valor: fromCents(valorC),
        data_vencimento: `${ano}-${String(mes).padStart(2, '0')}-15`,
        estado: 'pendente',
        valor_pago: 0,
      }));
    }
  }
  await extra.update({ estado: 'processada', processado_por: gestor.id, processado_em: diaISO(agora) });
  // O início da quota extra acompanha a 1.ª parcela (é o mês em que é criada).
  await extra.update({ mes_inicio: somaMeses(anoAtual, mesAtual, -3).mes, ano_inicio: somaMeses(anoAtual, mesAtual, -3).ano });
  passo(`"${extra.designacao}" — ${eur(totalExtraC)} · 4 parcelas × 6 frações = ${parcelas.length} parcelas`);

  // Pagar as primeiras parcelas de 3 frações (writer real).
  let nExtrasPagas = 0;
  for (let fi = 0; fi < 3; fi += 1) {
    const daFracao = parcelas.filter((p) => p.fracao_id === fracoes[fi].id).sort((a, b) => a.parcela_numero - b.parcela_numero);
    for (const parcela of daFracao.slice(0, 2)) {
      await registarPagamentoExtraParcela({
        parcelaId: parcela.id,
        dataPagamento: parcela.data_vencimento,
        metodoPagamentoId: metodoTransferencia.id,
        contaBancariaId: contaCorrente.id,
        referencia: `DEMO-EXTRA-${parcela.parcela_numero}`,
        observacoes: 'Pagamento de quota extra (demonstração)',
        userId: gestor.id,
        condominioId: cid,
      });
      nExtrasPagas += 1;
    }
  }
  passo(`${nExtrasPagas} parcelas pagas via registarPagamentoExtraParcela()`);

  // ── FASE 11: assembleia + deliberação aprovada ─────────────────────
  titulo('11. Assembleia, deliberação e FCR');
  const assembleia = await Assembleia.create({
    condominio_id: cid,
    numero: `ATA-${anoAtual}-01`,
    tipo: 'ordinaria',
    data: `${anoAtual}-03-20`,
    hora: '18:30',
    local: 'Sala comum do edifício (fictícia)',
    ordem_trabalhos: '1. Aprovação do orçamento\n2. Obras de impermeabilização\n3. Utilização do Fundo de Reserva\n4. Outros assuntos',
    // 'realizada' — uma assembleia em rascunho/agendada/cancelada não pode
    // deliberar (`ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO`).
    estado: 'realizada',
    ata_texto: 'Ata de demonstração (fictícia). Deliberações registadas pelo gestor.',
  });
  await AgendaItem.create({
    assembleia_id: assembleia.id,
    ordem: 1,
    descricao: 'Aprovação do orçamento anual',
    sujeito_votacao: true,
    deliberacao_estado: 'aprovada',
    valor_aprovado: null,
    deliberacao_nota: 'Orçamento aprovado por unanimidade (demonstração).',
  });
  // O FCR RECEBIDO só conta a parte de FCR das quotas efetivamente pagas —
  // por isso o valor deliberado tem de ser dimensionado a partir do que existe
  // de facto, senão `transferirFcrAprovado` recusa a operação (e bem).
  const fcrDisponivelC = await resumoFcr(cid);
  const fcrRecebidoC = fcrDisponivelC.recebidoC;
  // Valor deliberado = teto autorizado, arredondado para euros cheios e nunca
  // acima do que foi recebido (é o máximo que faz sentido autorizar).
  const valorDeliberadoC = Math.max(0, Math.floor(fcrRecebidoC / 100) * 100);
  const itemFcr = await AgendaItem.create({
    assembleia_id: assembleia.id,
    ordem: 2,
    descricao: 'Utilização do Fundo de Reserva para obras de impermeabilização',
    sujeito_votacao: true,
    deliberacao_estado: 'aprovada',
    valor_aprovado: fromCents(valorDeliberadoC), // valor MÁXIMO autorizado
    deliberacao_nota: `Autorizada a utilização de até ${eur(valorDeliberadoC)} do FCR (demonstração).`,
  });
  await AgendaItem.create({
    assembleia_id: assembleia.id,
    ordem: 3,
    descricao: 'Informações sobre a quota extraordinária',
    sujeito_votacao: false,
    deliberacao_estado: 'pendente',
  });
  for (const [i, fracao] of fracoes.entries()) {
    await AssembleiaParticipante.create({
      assembleia_id: assembleia.id,
      fracao_id: fracao.id,
      pessoa_id: pessoas[i].id,
      presente: i < 5, // uma falta, para o quórum não ser 100%
      permilagem: fracao.permilagem,
    });
  }
  passo(`Assembleia "${assembleia.numero}" + 3 pontos · deliberação FCR de até ${eur(valorDeliberadoC)}`);

  // ── FASE 12: FCR (corrente → fundo, e utilização fundo → corrente) ──
  const fcrAntes = await resumoFcr(cid);
  passo(`FCR recebido: ${eur(fcrAntes.recebidoC)} · disponível: ${eur(fcrAntes.disponivelC)}`);

  // (a) Entrada no fundo: corrente → fundo_reserva, limitada ao FCR recebido.
  //     Primeiro transfere-se para o fundo, DEPOIS é que se pode utilizar: a
  //     utilização sai da conta do fundo, que tem de ter saldo.
  let transferidoFundoC = 0;
  if (fcrAntes.disponivelC > 0) {
    // Quase todo o FCR recebido vai para o fundo (fica um resto por transferir,
    // para o ecrã do FCR mostrar trabalho por fazer).
    const aTransferirC = Math.floor(fcrAntes.disponivelC / 100) * 100;
    if (aTransferirC > 0) {
      const r1 = await transferirFcr({
        condominioId: cid,
        contaOrigemId: contaCorrente.id,
        contaDestinoId: contaFcr.id,
        valorC: aTransferirC,
        data: `${anoAtual}-04-05`,
        descricao: 'Transferência de FCR para a conta do Fundo de Reserva',
        userId: gestor.id,
      });
      if (r1.ok) {
        transferidoFundoC = aTransferirC;
        passo(`FCR: corrente → fundo, ${eur(aTransferirC)}`);
      } else {
        aviso(`Transferência para o FCR não efetuada: ${r1.mensagem}`);
      }
    }
  }

  // (b) Utilização do FCR: fundo_reserva → corrente, com deliberação aprovada.
  //     O valor tem de caber no que está na conta do fundo E no autorizado.
  //     Usa-se METADE do que está no fundo (parte do FCR fica sempre aplicado,
  //     como manda a lei) e nunca acima do valor deliberado.
  const saldoFundoC = toCents(await saldoContaMovimentos(contaFcr));
  const utilizacaoC = Math.min(
    Math.floor(saldoFundoC / 200) * 100, // metade, arredondada a euros
    valorDeliberadoC
  );
  if (utilizacaoC > 0) {
    const r2 = await transferirFcrAprovado({
      condominioId: cid,
      deliberacaoId: itemFcr.id,
      contaOrigemId: contaFcr.id,
      contaDestinoId: contaCorrente.id,
      valorC: utilizacaoC,
      data: `${anoAtual}-05-10`,
      descricao: 'Utilização do FCR — 1.ª tranche das obras de impermeabilização',
      userId: gestor.id,
    });
    if (r2.ok) {
      passo(`FCR: fundo → corrente, ${eur(utilizacaoC)} (deliberação #${itemFcr.id})`);
    } else {
      aviso(`Utilização do FCR não efetuada: ${r2.mensagem}`);
    }
  } else {
    aviso('Sem FCR disponível no fundo para demonstrar a utilização.');
  }

  // ── FASE 13: transferências entre contas + movimentos manuais ──────
  titulo('13. Transferências entre contas e ajustes manuais');
  // Transferência corrente → poupança (par TRANSF, «De → Para» determinável).
  await registarTransferencia({
    contaOrigemId: contaCorrente.id,
    contaDestinoId: contaPoupanca.id,
    valor: 500.0,
    data: `${anoAtual}-06-01`,
    descricao: 'Transferência para a conta poupança',
    userId: gestor.id,
    condominioId: cid,
  });
  passo('Transferência corrente → poupança (500,00 €)');

  // Transferência corrente → poupança ANULADA (as duas pontas, para o saldo
  // não ser afetado e o Extrato provar que um anulado não mexe no saldo).
  const idaAnulada = await registarTransferencia({
    contaOrigemId: contaCorrente.id,
    contaDestinoId: contaPoupanca.id,
    valor: 150.0,
    data: `${anoAtual}-06-02`,
    descricao: 'Transferência anulada (demonstração)',
    userId: gestor.id,
    condominioId: cid,
  });
  await MovimentoBancario.update(
    { estado: 'anulado' },
    { where: { id: { [Op.in]: [idaAnulada.saidaId, idaAnulada.entradaId] } } }
  );
  passo('Transferência ANULADA (150,00 €) — não afeta saldos');

  // Ajuste manual: sem origem operacional → categoria 'Ajuste manual' e
  // anulável no Extrato (é o único tipo que a rota permite anular).
  const categoriaAjuste = await cat('Outras receitas');
  const ajuste = await criarMovimento({
    contaBancariaId: contaCorrente.id,
    condominioId: cid,
    data: `${anoAtual}-02-20`,
    tipo: 'entrada',
    valor: 45.5,
    descricao: 'Ajuste manual — acerto de caixa (demonstração)',
    categoriaId: categoriaAjuste ? categoriaAjuste.id : null,
    userId: gestor.id,
  });
  passo(`Ajuste manual de entrada (45,50 €) — anulável no Extrato (#${ajuste.id})`);

  const ajusteAnulado = await criarMovimento({
    contaBancariaId: contaCorrente.id,
    condominioId: cid,
    data: `${anoAtual}-02-21`,
    tipo: 'saida',
    valor: 30.0,
    descricao: 'Ajuste manual anulado (demonstração)',
    categoriaId: categoriaAjuste ? categoriaAjuste.id : null,
    userId: gestor.id,
  });
  await MovimentoBancario.update({ estado: 'anulado' }, { where: { id: ajusteAnulado.id } });
  passo('Ajuste manual de saída ANULADO (30,00 €)');

  // ── FASE 14: documentos e avisos ───────────────────────────────────
  titulo('14. Documentos e avisos');
  const documentos = [];
  const DOCS = [
    { tipo: 'ata', nome: `Ata da assembleia ${assembleia.numero}`, pasta: 'Assembleias', data: `${anoAtual}-03-21` },
    { tipo: 'convocatoria', nome: `Convocatória da assembleia ${assembleia.numero}`, pasta: 'Assembleias', data: `${anoAtual}-03-05` },
    { tipo: 'orcamento', nome: `Orçamento ${anoAtual}`, pasta: 'Orçamentos', data: `${anoAtual}-01-20` },
    { tipo: 'relatorio', nome: 'Relatório de contas do 1.º trimestre', pasta: 'Relatórios', data: `${anoAtual}-04-10` },
  ];
  for (const d of DOCS) {
    documentos.push(await Documento.create({
      condominio_id: cid,
      tipo: d.tipo,
      nome: d.nome,
      pasta: d.pasta,
      numero_documento: null,
      // Sem integração externa: nunca 'guardado'.
      drive_status: 'nao_guardado',
      data: d.data,
      entidade_tipo: 'Assembleia',
      entidade_id: assembleia.id,
      created_by: gestor.id,
      disponivel_condominos: d.tipo === 'ata' || d.tipo === 'relatorio',
    }));
  }
  passo(`${documentos.length} documentos (drive_status='nao_guardado')`);

  const aviso = await Aviso.create({
    condominio_id: cid,
    tipo: 'manual',
    assunto: 'Obras de impermeabilização — início em breve',
    mensagem: 'Aviso de demonstração: as obras aprovadas em assembleia começam no próximo mês.',
    documento_id: documentos[0].id,
    created_by: gestor.id,
  });
  for (const [i, pessoa] of pessoas.entries()) {
    await AvisoDestinatario.create({
      aviso_id: aviso.id,
      fracao_id: fracoes[i].id,
      pessoa_id: pessoa.id,
      user_id: usersCondominos.find((u) => u.pessoa_id === pessoa.id)?.id || null,
    });
  }
  passo('1 aviso + 6 destinatários (não enviado)');

  // ── FASE 15: recibos (a partir de quotas efetivamente pagas) ───────
  titulo('15. Recibos');
  let nRecibos = 0;
  for (let fi = 0; fi < 3; fi += 1) {
    const fracao = fracoes[fi];
    const quotasPagas = await Quota.findAll({
      where: { condominio_id: cid, fracao_id: fracao.id, estado: 'paga' },
      order: [['ano', 'ASC'], ['mes', 'ASC']],
      limit: 4,
    });
    if (!quotasPagas.length) continue;
    const ano = quotasPagas[0].ano;
    const seq = nRecibos + 1;
    const valorC = quotasPagas.reduce((s, q) => s + toCents(q.valor), 0);
    const recibo = await Recibo.create({
      condominio_id: cid,
      fracao_id: fracao.id,
      codigo: `RCP-${ano}-${String(seq).padStart(4, '0')}`,
      codigo_verificacao: `${ano}-DEMO${String(seq).padStart(4, '0')}`,
      numero: String(seq).padStart(4, '0'),
      ano,
      tipo: 'ordinario',
      valor: fromCents(valorC),
      data_emissao: `${ano}-06-30`,
      estado: 'emitido',
      created_by: gestor.id,
    });
    for (const quota of quotasPagas) {
      await ReciboQuota.create({
        recibo_id: recibo.id,
        quota_id: quota.id,
        valor: quota.valor,
        valor_base: quota.valor_base,
        valor_fcr: quota.valor_fcr,
      });
    }
    nRecibos += 1;
  }
  passo(`${nRecibos} recibos emitidos (ligados a quotas efetivamente pagas)`);

  // Numeração coerente com os documentos já criados: sem isto, o primeiro
  // recibo criado pela aplicação colidiria com os códigos de demonstração.
  await Numeracao.findOrCreate({
    where: { tipo_documento: 'recibo', ano: anoAtual },
    defaults: { tipo_documento: 'recibo', ano: anoAtual, sequencia: nRecibos, formato: '{ano}/{sequencia}' },
  });
  await Numeracao.update({ sequencia: nRecibos }, { where: { tipo_documento: 'recibo', ano: anoAtual } });
  passo(`Numeração de recibo ${anoAtual} alinhada em ${nRecibos}`);

  // ── Resumo final ───────────────────────────────────────────────────
  // Devolve o CONTEXTO (não imprime o resumo: quem chama é que o faz, depois
  // de verificar os invariantes — assim o resumo aparece por último).
  return {
    condominio,
    gestor,
    fracoes,
    pessoas,
    usersCondominos,
    contas: [contaCorrente, contaFcr, contaPoupanca],
  };
}

// ═══════════════════════════════════════════════════════════════════
// VERIFICAÇÃO DE INVARIANTES + RESUMO
// ═══════════════════════════════════════════════════════════════════
async function verificarInvariantes(cid) {
  // Fonte de verdade da categoria de um movimento (a MESMA que a rota de
  // anulação usa) — carregada uma vez, no topo, para toda a função.
  const extrato = require('../helpers/extrato');

  const falhas = [];
  const verificar = (nome, ok, detalhe) => {
    if (!ok) falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
    console.log(`  ${ok ? '✓' : '✗'} ${nome}${detalhe ? `  (${detalhe})` : ''}`);
  };

  // 1. Σ permilagens = 1000‰
  const fracoes = await Fracao.findAll({ where: { condominio_id: cid }, attributes: ['permilagem'] });
  const somaPermilagens = fracoes.reduce((s, f) => s + Number(f.permilagem || 0), 0);
  verificar('Σ permilagens = 1000‰', somaPermilagens === 1000, `${somaPermilagens}‰`);

  // 2. Pagamentos aplicados ≤ valor das quotas
  const quotas = await Quota.findAll({ where: { condominio_id: cid }, attributes: ['id', 'valor', 'estado'] });
  const aplicacoes = await PagamentoQuota.findAll({
    where: { quota_id: { [Op.in]: quotas.map((q) => q.id) } },
    include: [{ model: Pagamento, as: 'pagamento', attributes: ['estado'], where: { estado: 'confirmado' }, required: true }],
  });
  const aplicadoPorQuota = new Map();
  for (const a of aplicacoes) {
    aplicadoPorQuota.set(a.quota_id, (aplicadoPorQuota.get(a.quota_id) || 0) + toCents(a.valor_aplicado));
  }
  const excessos = quotas.filter((q) => (aplicadoPorQuota.get(q.id) || 0) > toCents(q.valor));
  verificar('Pagamentos aplicados ≤ valor da quota', excessos.length === 0, `${excessos.length} excessos`);

  // 3. Estado da quota coerente com o aplicado (não forçado)
  //    Nota: 'vencida' nunca é GRAVADO pelos writers — é um estado efetivo
  //    calculado a partir de `data_vencimento` (`helpers/saldos.js`). No banco
  //    só podem estar 'pendente' / 'parcialmente_paga' / 'paga' / 'anulada'.
  const incoerentes = quotas.filter((q) => {
    const aplicado = aplicadoPorQuota.get(q.id) || 0;
    const total = toCents(q.valor);
    if (q.estado === 'anulada') return true;
    if (aplicado >= total && total > 0) return q.estado !== 'paga';
    if (aplicado > 0) return q.estado !== 'parcialmente_paga';
    return q.estado !== 'pendente';
  });
  verificar('Estado das quotas derivado do pago', incoerentes.length === 0, `${incoerentes.length} incoerentes`);

  // 3b. Existem quotas em atraso (estado efetivo 'vencida'): pendentes ou
  //     parcialmente pagas cujo vencimento já passou. É o que o Dashboard,
  //     o portal e os avisos de cobrança mostram como dívida.
  const { estadoEfetivo } = require('../helpers/saldos');
  const todasQuotas = await Quota.findAll({ where: { condominio_id: cid } });
  const vencidas = todasQuotas.filter((q) => estadoEfetivo(q) === 'vencida');
  verificar('Existem quotas vencidas (em atraso)', vencidas.length > 0, `${vencidas.length} vencidas`);

  // 3c. Existem quotas parcialmente pagas
  const parciais = todasQuotas.filter((q) => q.estado === 'parcialmente_paga');
  verificar('Existem quotas parcialmente pagas', parciais.length > 0, `${parciais.length} parciais`);

  // 4. Transferências com duas pontas (par saida+entrada TRANSF)
  const transferencias = await MovimentoBancario.findAll({
    where: { condominio_id: cid, referencia: 'TRANSF' },
    attributes: ['id', 'conta_bancaria_id', 'tipo', 'valor', 'data', 'estado'],
  });
  const pares = new Map();
  for (const m of transferencias) {
    const chave = `${m.data}|${m.valor}`;
    if (!pares.has(chave)) pares.set(chave, { saidas: 0, entradas: 0 });
    const p = pares.get(chave);
    if (m.tipo === 'saida') p.saidas += 1;
    if (m.tipo === 'entrada') p.entradas += 1;
  }
  const paresIncompletos = [...pares.entries()].filter(([, p]) => p.saidas !== 1 || p.entradas !== 1);
  verificar('Transferências com duas pontas (1 saída + 1 entrada)', paresIncompletos.length === 0, `${pares.size} pares`);

  // 5. Nenhum movimento novo sem condominio_id
  const semCondominio = await MovimentoBancario.count({ where: { condominio_id: null } });
  verificar('Nenhum movimento novo sem condominio_id', semCondominio === 0, `${semCondominio} sem condomínio`);

  // 6. Saldos por conta coerentes (saldo_inicial + entradas − saídas)
  const contas = await ContaBancaria.findAll({ where: { condominio_id: cid } });
  let somaSaldosC = 0;
  for (const conta of contas) {
    const movs = await MovimentoBancario.findAll({
      where: { conta_bancaria_id: conta.id, estado: 'confirmado' },
      attributes: ['tipo', 'valor'],
    });
    let entradasC = 0;
    let saidasC = 0;
    for (const m of movs) {
      if (m.tipo === 'entrada') entradasC += toCents(m.valor);
      else if (m.tipo === 'saida') saidasC += toCents(m.valor);
    }
    const saldoC = toCents(conta.saldo_inicial) + entradasC - saidasC;
    somaSaldosC += saldoC;
    const viaHelper = toCents(await saldoContaMovimentos(conta));
    verificar(`Saldo da conta "${conta.nome}" coerente`, saldoC === viaHelper, `${eur(saldoC)}`);
  }

  // 7. Saldo agregado do Extrato coerente com as contas
  const dados = await extrato.extrato({ condominioId: cid, filtros: {} });
  verificar(
    'Saldo agregado do Extrato = somatório das contas',
    dados.resumo.saldoFinalC === somaSaldosC,
    `extrato ${eur(dados.resumo.saldoFinalC)} vs contas ${eur(somaSaldosC)}`
  );
  verificar('Extrato tem movimentos', dados.linhas.length > 0, `${dados.linhas.length} linhas`);

  // 8. Isolamento: nenhuma entidade do demo aponta para outro condomínio.
  //    A fração é a chave que liga quotas/pagamentos/despesas — se todas as
  //    quotas com estas frações pertencem ao demo, não há fuga de âmbito.
  const idsFracoes = (await Fracao.findAll({ where: { condominio_id: cid }, attributes: ['id'] })).map((f) => f.id);
  const fugasQuota = idsFracoes.length
    ? await Quota.count({ where: { fracao_id: { [Op.in]: idsFracoes }, condominio_id: { [Op.ne]: cid } } })
    : 0;
  const fugasPessoa = await Pessoa.count({ where: { condominio_id: { [Op.ne]: cid }, nome: { [Op.in]: PESSOAS_DEF.map((p) => p.nome) } } });
  const fugasMov = await MovimentoBancario.count({
    where: { conta_bancaria_id: { [Op.in]: contas.map((c) => c.id) }, condominio_id: { [Op.ne]: cid } },
  });
  const fugas = fugasQuota + fugasPessoa + fugasMov;
  verificar('Isolamento do condomínio demo', fugas === 0, `${fugas} fugas (quotas/pessoas/movimentos)`);

  // 9. Movimentos anteriores ao período atual (para o "Saldo anterior")
  const anoAtual = new Date().getFullYear();
  const anteriores = await MovimentoBancario.count({ where: { condominio_id: cid, data: { [Op.lt]: `${anoAtual}-01-01` } } });
  verificar('Existem movimentos anteriores ao ano corrente', anteriores > 0, `${anteriores} movimentos`);

  // 10. Movimentos anulados presentes
  const anulados = await MovimentoBancario.count({ where: { condominio_id: cid, estado: 'anulado' } });
  verificar('Existem movimentos anulados', anulados > 0, `${anulados} anulados`);

  // 11. Ajustes manuais sem origem (anuláveis no Extrato)
  //     A categoria NÃO se decide por SQL: `referencia <> 'TRANSF'` descartava
  //     todos os ajustes, porque `criarMovimento` grava `referencia = NULL`
  //     quando não é dada, e `NULL <> 'TRANSF'` é NULL (não TRUE) — a linha não
  //     entra no COUNT. Usa-se a MESMA função que a rota de anulação usa
  //     (`extrato.categoriaDe`), que é a fonte de verdade da categoria.
  const movimentosDoDemo = await MovimentoBancario.findAll({
    where: { condominio_id: cid },
    attributes: ['id', 'estado', 'referencia', 'tipo', 'pagamento_id', 'despesa_id', 'extra_quota_parcela_id'],
  });
  const ajustes = movimentosDoDemo.filter(
    (m) => extrato.categoriaDe(m) === extrato.CATEGORIAS.ajuste
  );
  const ajustesAtivos = ajustes.filter((m) => m.estado === 'confirmado');
  verificar(
    'Existem ajustes manuais (sem origem operacional)',
    ajustesAtivos.length > 0,
    `${ajustesAtivos.length} ativos (${ajustes.length} no total, ${ajustes.length - ajustesAtivos.length} anulados)`
  );

  // 12. Documentos nunca com integração externa
  const comDrive = await Documento.count({ where: { condominio_id: cid, drive_status: { [Op.ne]: 'nao_guardado' } } });
  verificar("Documentos com drive_status='nao_guardado'", comDrive === 0, `${comDrive} com Drive`);

  // 13. Nenhum email enviado
  const enviados = await EmailFila.count({ where: { condominio_id: cid, estado: 'enviado' } });
  verificar('Nenhum email enviado pelo seed', enviados === 0, `${enviados} enviados`);

  // 14. FCR: as transferências usam a referência 'TRANSF' (como todas as
  //     transferências entre contas; a utilização leva ainda `deliberacao_id`).
  const resumo = await resumoFcr(cid);
  const contaFcrDoDemo = contas.find((c) => c.tipo === 'fundo_reserva');
  const transfFcr = contaFcrDoDemo
    ? await MovimentoBancario.count({
      where: { condominio_id: cid, conta_bancaria_id: contaFcrDoDemo.id, referencia: 'TRANSF' },
    })
    : 0;
  // `transferidoC` conta as saídas do fundo (utilizações). O que tem de ser
  // verdade é que o total transferido nunca excede o recebido.
  verificar(
    'FCR transferido ≤ FCR recebido',
    resumo.transferidoC <= resumo.recebidoC,
    `transferido ${eur(resumo.transferidoC)} vs recebido ${eur(resumo.recebidoC)}`
  );
  verificar('O FCR teve movimento real', resumo.recebidoC > 0, `${eur(resumo.recebidoC)} recebidos`);
  verificar('Existem movimentos na conta do FCR', transfFcr > 0, `${transfFcr} movimentos`);

  // 14b. Nenhuma conta bancária do demo com saldo negativo
  const contasNeg = [];
  for (const conta of contas) {
    const s = toCents(await saldoContaMovimentos(conta));
    if (s < 0) contasNeg.push(`${conta.nome} ${eur(s)}`);
  }
  verificar('Nenhuma conta com saldo negativo', contasNeg.length === 0, contasNeg.join(', ') || 'todas positivas');

  // 15. Quota extra processada + parcelas pagas
  const extrasProcessadas = await ExtraQuota.count({ where: { condominio_id: cid, estado: 'processada' } });
  verificar('Existe quota extra processada', extrasProcessadas > 0, `${extrasProcessadas} processadas`);
  const parcelasDoDemo = await ExtraQuotaParcela.count({
    where: { extra_quota_id: { [Op.in]: (await ExtraQuota.findAll({ where: { condominio_id: cid }, attributes: ['id'] })).map((e) => e.id) } },
  });
  const parcelasPagas = await ExtraQuotaParcela.count({
    where: {
      estado: 'paga',
      extra_quota_id: { [Op.in]: (await ExtraQuota.findAll({ where: { condominio_id: cid }, attributes: ['id'] })).map((e) => e.id) },
    },
  });
  verificar('Existem parcelas de quota extra pagas', parcelasPagas > 0, `${parcelasPagas}/${parcelasDoDemo} pagas`);

  // 16. Despesas pagas e por pagar coexistem
  const despPagas = await Despesa.count({ where: { condominio_id: cid, estado: 'paga' } });
  const despRegistadas = await Despesa.count({ where: { condominio_id: cid, estado: 'registada' } });
  verificar('Existem despesas pagas E por pagar', despPagas > 0 && despRegistadas > 0, `${despPagas} pagas · ${despRegistadas} registadas`);
  // Despesa paga só gera movimento com conta bancária (regra do writer).
  const despPagasSemConta = await Despesa.count({ where: { condominio_id: cid, estado: 'paga', conta_bancaria_id: null } });
  verificar('Despesas pagas têm conta bancária', despPagasSemConta === 0, `${despPagasSemConta} sem conta`);

  // 17. Portal: há titularidades ativas para todas as frações
  const titularidades = await FracaoTitularidade.count({ where: { condominio_id: cid, estado: 'ativa' } });
  verificar('Titularidades ativas ≥ frações', titularidades >= fracoes.length, `${titularidades} titularidades vs ${fracoes.length} frações`);

  return { falhas, dados };
}

async function resumir(cid, ctx) {
  titulo('RESUMO');
  const contas = ctx.contas;
  for (const conta of contas) {
    passo(`${conta.nome}: ${eur(toCents(await saldoContaMovimentos(conta)))}`);
  }
  const resumo = await resumoFcr(cid);
  passo(`FCR — emitido ${eur(resumo.emitidoC)} · recebido ${eur(resumo.recebidoC)} · transferido ${eur(resumo.transferidoC)} · disponível ${eur(resumo.disponivelC)}`);
  const nMov = await MovimentoBancario.count({ where: { condominio_id: cid } });
  const nQuotas = await Quota.count({ where: { condominio_id: cid } });
  const nPag = await Pagamento.count({ where: { condominio_id: cid } });
  passo(`Movimentos: ${nMov} · Quotas: ${nQuotas} · Pagamentos: ${nPag}`);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  verificarAmbiente();

  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error('');
    console.error('  ✗ Sem ligação à base de dados.');
    console.error(`    ${err.message}`);
    console.error('    Este script exige uma BD acessível (ver .env).');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  GesCondu — seed de DEMONSTRAÇÃO');
  console.log('  Dados 100% fictícios · nunca usar em produção');
  if (OPCOES.dryRun) console.log('  MODO: --dry-run (não escreve nada)');
  if (OPCOES.reset) console.log('  MODO: --reset (apaga o condomínio de demonstração)');
  if (OPCOES.reparar) console.log('  MODO: --reparar (corrige a conta do gestor demo, sem apagar nada)');
  console.log('═══════════════════════════════════════════════════════════════');

  const existente = await encontrarCondominioDemo();

  // `--reparar` primeiro: é a via não destrutiva para corrigir um demo criado
  // por uma versão anterior do seed (gestor sem `pessoa_id` / sem 'admin').
  if (OPCOES.reparar) {
    if (!existente) {
      titulo('REPARAR');
      passo('Não existe condomínio de demonstração. Nada a reparar.');
      await sequelize.close();
      process.exit(0);
    }
    await repararGestorDemo(existente, { dryRun: OPCOES.dryRun });
    titulo('VERIFICAÇÃO DE INVARIANTES');
    const { falhas } = await verificarInvariantes(existente.id);
    await sequelize.close();
    process.exit(falhas.length ? 1 : 0);
  }

  if (OPCOES.reset) {
    if (!existente) {
      titulo('RESET');
      passo('Não existe condomínio de demonstração. Nada a fazer.');
      await sequelize.close();
      process.exit(0);
    }
    await apagarCondominioDemo(existente, { dryRun: OPCOES.dryRun });
    await sequelize.close();
    process.exit(0);
  }

  if (OPCOES.dryRun) {
    if (existente) {
      titulo('--dry-run');
      passo(`O condomínio de demonstração já existe (#${existente.id} ${existente.designacao}).`);
      passo('Não seria criado nada (idempotência). Use --reset para o remover.');
    } else {
      mostrarPlano();
    }
    await sequelize.close();
    process.exit(0);
  }

  if (existente) {
    titulo('IDEMPOTÊNCIA');
    passo(`O condomínio de demonstração já existe (#${existente.id} ${existente.designacao}).`);
    passo('Nada foi criado. Use --reset para o remover primeiro.');
    const { falhas } = await verificarInvariantes(existente.id);
    await sequelize.close();
    process.exit(falhas.length ? 1 : 0);
  }

  const ctx = await criarDemo();

  titulo('VERIFICAÇÃO DE INVARIANTES');
  const { falhas } = await verificarInvariantes(ctx.condominio.id);

  await resumir(ctx.condominio.id, ctx);

  console.log('');
  if (falhas.length) {
    console.log('  ✗ FALHAS:');
    for (const f of falhas) console.log(`      · ${f}`);
    console.log('');
    await sequelize.close();
    process.exit(1);
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ✓ Demo criada. Todos os invariantes verificados.');
  console.log(`  Acesso: ${EMAIL_GESTOR} / ${PASSWORD_GESTOR}`);
  console.log('  Remover: node scripts/seed-demo.js --reset');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  await sequelize.close();
  process.exit(0);
}

// Apresenta o PLANO sem escrever nada (--dry-run sem condomínio existente).
function mostrarPlano() {
  titulo('PLANO (--dry-run: nada foi escrito)');
  passo(`Condomínio: ${DESIGNACAO}`);
  passo(`Frações: ${FRACOES_DEF.length} (${FRACOES_DEF.map((f) => f.permilagem).join('/')}‰ = 1000‰)`);
  passo('Contas: 3 (corrente, fundo_reserva, poupanca)');
  passo('Período: 2 meses do ano anterior + 12 do ano corrente');
  passo(`Pessoas: ${PESSOAS_DEF.length} (${PESSOAS_DEF.filter((p) => p.conta).length} com conta de portal)`);
  passo('Quotas, pagamentos, despesas, quota extra, assembleia+deliberação FCR,');
  passo('transferências (uma anulada), ajustes manuais, documentos e avisos.');
  console.log('');
  passo('Para criar: node scripts/seed-demo.js');
}

// ── Exportações (apenas para o smoke test sem BD) ───────────────────
// Quando `SEED_DEMO_EXPORTAR=1`, o script NÃO arranca e expõe as funções
// internas para serem testadas com modelos falsos. Em utilização normal nada
// disto é usado — o script corre e termina como sempre.
if (process.env.SEED_DEMO_EXPORTAR === '1') {
  module.exports = { verificarInvariantes, resumir, encontrarCondominioDemo, apagarCondominioDemo, repararGestorDemo, mostrarPlano, criarDemo };
} else {
  main().catch(async (err) => {
    console.error('');
    console.error('  ✗ FALHA no seed de demonstração:');
    console.error(`    ${err.message}`);
    if (err.stack) console.error(String(err.stack).split('\n').slice(1, 4).join('\n'));
    console.error('');
    console.error('  A base de dados pode ter ficado parcialmente preenchida.');
    console.error('  Para limpar: node scripts/seed-demo.js --reset');
    console.error('');
    try { await sequelize.close(); } catch (e) { /* ignora o erro de fecho */ }
    process.exit(1);
  });
}
