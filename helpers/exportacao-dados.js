// ─────────────────────────────────────────────────────────────────────
// Exportação controlada dos dados de um condómino — "Descarregar a minha
// informação".
//
// Princípio (RGPD e bom senso): isto NÃO é "todos os documentos onde o meu nome
// aparece", nem "apagar os meus dados". É a exportação dos dados e documentos a
// que a pessoa tem legitimamente acesso enquanto titular de uma fração:
//
//   · os seus próprios dados de identificação e contacto;
//   · as frações de que é (ou foi) titular, com os períodos;
//   · quotas, quotas extraordinárias, pagamentos e recibos das SUAS frações;
//   · os comprovativos que acompanham esses pagamentos;
//   · os documentos que o condomínio disponibilizou aos condóminos;
//   · assembleias (e as suas presenças) e comunicações gerais do condomínio.
//
// Não inclui: dados pessoais de terceiros, comprovativos de outras frações,
// comunicações internas da administração, nem qualquer documento não
// disponibilizado. O histórico contabilístico do condomínio permanece no
// GesCondu — esta exportação não apaga nada.
//
// Os módulos incluídos são apenas os que existem: não há pastas para
// funcionalidades inexistentes (por exemplo, "Votações").
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const fs = require('fs');
const {
  Quota,
  Pagamento,
  Recibo,
  ExtraQuota,
  ExtraQuotaParcela,
  Documento,
  Assembleia,
  AssembleiaParticipante,
  Aviso,
  FracaoTitularidade,
  Fracao,
  ContactoPessoa,
} = require('../models');
const { toCents, formatEUR, formatEURCents } = require('./money');
const { pagoPorQuota } = require('./recibos');
const { estadoEfetivo } = require('./saldos');
const comprovativos = require('./comprovativos');
const storage = require('./storage');
const { zipar } = require('./zip');
const { formatDate } = require('./dates');
const { VINCULO_LABEL } = require('./titularidades');

// Limites da exportação (evitam ficheiros gigantes e chamadas infinitas ao
// armazenamento externo). O que ficar de fora é listado no manifesto.
const MAX_FICHEIROS_DOCUMENTOS = 40;
const MAX_BYTES_DOCUMENTO = 8 * 1024 * 1024;

// Data LOCAL, não UTC. `toISOString()` é UTC: às 00h30 em Lisboa (UTC+1 no
// verão) devolveria o dia ANTERIOR, e o MANIFEST — um documento de RGPD —
// diria que a exportação foi gerada no dia errado (mesma armadilha que
// `helpers/dates.js` documenta em `asDateLocal`). Aritmética local.
function hojeISO() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function slug(texto, max = 40) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max) || 'GesCondu';
}

// CSV em UTF-8 com BOM e ponto e vírgula (abre corretamente no Excel em PT).
function csv(cabecalho, linhas) {
  const escapar = (valor) => {
    const texto = valor === null || valor === undefined ? '' : String(valor);
    // `\r` incluído: uma mensagem de aviso colada de outro programa pode trazer
    // CR sozinho e, sem aspas, partiria a linha do CSV a meio.
    return /[";\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  };
  const corpo = [cabecalho, ...linhas].map((linha) => linha.map(escapar).join(';')).join('\r\n');
  return Buffer.from(`\ufeff${corpo}\r\n`, 'utf8');
}

function texto(titulo, pares) {
  const linhas = [titulo, '='.repeat(titulo.length), ''];
  for (const [rotulo, valor] of pares) linhas.push(`${rotulo}: ${valor === null || valor === undefined || valor === '' ? '—' : valor}`);
  return Buffer.from(`${linhas.join('\r\n')}\r\n`, 'utf8');
}

async function nomeDocumentoParaFicheiro(documento) {
  const nomeBase = slug(String(documento.nome || `documento_${documento.id}`).replace(/\.[a-z0-9]+$/i, ''), 60);
  const extensao = (String(documento.nome || '').match(/\.([a-z0-9]+)$/i) || [null, 'pdf'])[1];
  const pasta = String(documento.pasta || 'Outros').replace(/[/\\]/g, '-');
  return `Documentos/${pasta}/${nomeBase}.${extensao}`;
}

// Recolhe tudo o que o utilizador pode receber e devolve
// { nomeFicheiro, buffer, manifesto }.
async function construirExportacao({ condominioId, condominio = null, utilizador, pessoa = null, fracoes = [] } = {}) {
  if (!condominioId || !utilizador) throw new Error('Exportação sem condomínio ou utilizador.');
  const dataRef = hojeISO();
  const ids = (fracoes || []).map((f) => Number(f.id)).filter(Boolean);

  const entradas = [];
  const incluidos = [];
  const ignorados = [];

  // ── 1. Dados pessoais (só os do próprio) ──────────────────────────
  const contactos = pessoa
    ? await ContactoPessoa.findAll({ where: { pessoa_id: pessoa.id, ativo: true }, order: [['principal', 'DESC'], ['id', 'ASC']] })
    : [];
  entradas.push({
    nome: 'Dados pessoais/dados-pessoais.txt',
    conteudo: texto('Dados pessoais (conta GesCondu e ficha de condómino)', [
      ['Nome da conta', utilizador.nome],
      ['Email da conta', utilizador.email],
      ['Telefone da conta', utilizador.telefone || ''],
      ['Ficha de condómino', pessoa ? pessoa.nome : ''],
      ['NIF', pessoa ? pessoa.nif || '' : ''],
      ['Email de contacto (condomínio)', pessoa ? pessoa.email || '' : ''],
      ['Telefone', pessoa ? pessoa.telefone || '' : ''],
      ['Contactos adicionais', contactos.map((c) => `${c.tipo}: ${c.valor}${c.principal ? ' (principal)' : ''}`).join(' | ')],
      ['Condomínio', condominio ? condominio.designacao : `#${condominioId}`],
      ['Exportado em', formatDate(dataRef)],
    ]),
  });
  incluidos.push('Dados pessoais/dados-pessoais.txt');

  // ── 2. Frações e períodos de titularidade ─────────────────────────
  // Quem já não é titular tem direito ao histórico das relações que teve, por
  // isso os períodos (todos, não só os ativos) são recolhidos pela pessoa
  // quando não há frações em vigor.
  const titulos = await FracaoTitularidade.findAll({
    where: ids.length
      ? { condominio_id: condominioId, fracao_id: { [Op.in]: ids }, ...(pessoa ? { pessoa_id: pessoa.id } : {}) }
      : { condominio_id: condominioId, ...(pessoa ? { pessoa_id: pessoa.id } : { utilizador_id: utilizador.id }) },
    include: [{ model: Fracao, as: 'fracao', attributes: ['id', 'designacao'], required: false }],
    order: [['data_inicio', 'ASC'], ['id', 'ASC']],
  });
  // Identifica as frações referidas pelos períodos (para o histórico poder ser
  // descrito mesmo quando a fração já não está em vigor).
  const designacao = (t) => {
    const f = (fracoes || []).find((x) => Number(x.id) === Number(t.fracao_id));
    return (f && f.designacao) || (t.fracao && t.fracao.designacao) || String(t.fracao_id);
  };

  entradas.push({
    nome: 'Fracoes/fracoes.csv',
    conteudo: csv(
      ['Fração', 'Andar', 'Porta', 'Permilagem', 'Vínculo', 'Início', 'Fim', 'Estado'],
      [
        ...(fracoes || []).map((f) => [
          f.designacao, f.andar || '', f.porta || '', f.permilagem || '',
          (f.vinculoAtual && VINCULO_LABEL[f.vinculoAtual]) || '',
          '', '', 'relação em vigor',
        ]),
        ...titulos
          .filter((t) => !ids.includes(Number(t.fracao_id)))
          .map((t) => [
            designacao(t), '', '', '', VINCULO_LABEL[t.vinculo] || t.vinculo,
            t.data_inicio || '', t.data_fim || '', t.estado === 'ativa' ? 'ativa' : 'encerrada',
          ]),
      ]
    ),
  });
  incluidos.push('Fracoes/fracoes.csv');

  if (titulos.length) {
    entradas.push({
      nome: 'Fracoes/titularidades.csv',
      conteudo: csv(
        ['Fração', 'Vínculo', 'Início', 'Fim', 'Estado', 'Motivo'],
        titulos.map((t) => [designacao(t), VINCULO_LABEL[t.vinculo] || t.vinculo, t.data_inicio || '', t.data_fim || '', t.estado, t.motivo_cessacao || ''])
      ),
    });
    incluidos.push('Fracoes/titularidades.csv');
  }

  // ── 3. Quotas, quotas extraordinárias, pagamentos e recibos ───────
  if (ids.length) {
    const quotas = await Quota.findAll({
      where: { condominio_id: condominioId, fracao_id: { [Op.in]: ids } },
      order: [['ano', 'ASC'], ['mes', 'ASC'], ['id', 'ASC']],
    });
    const pagoQ = await pagoPorQuota(quotas.map((q) => q.id));
    const nomeFracao = (id) => {
      const f = (fracoes || []).find((x) => Number(x.id) === Number(id));
      return f ? f.designacao : String(id);
    };
    if (quotas.length) {
      entradas.push({
        nome: 'Quotas/quotas.csv',
        conteudo: csv(
          ['Fração', 'Ano', 'Mês', 'Valor', 'Pago', 'Em dívida', 'Vencimento', 'Estado'],
          quotas.map((q) => {
            const valorC = toCents(q.valor);
            const pagoC = pagoQ.get(q.id) || 0;
            return [
              nomeFracao(q.fracao_id), q.ano, q.mes, formatEURCents(valorC), formatEURCents(pagoC),
              formatEURCents(Math.max(0, valorC - pagoC)), q.data_vencimento || '', estadoEfetivo(q) || q.estado,
            ];
          })
        ),
      });
      incluidos.push('Quotas/quotas.csv');
    }

    const parcelas = await ExtraQuotaParcela.findAll({
      where: { fracao_id: { [Op.in]: ids }, estado: { [Op.ne]: 'anulada' } },
      include: [{ model: ExtraQuota, as: 'extra_quota', where: { condominio_id: condominioId, estado: 'processada' }, required: true }],
      order: [['data_vencimento', 'ASC'], ['id', 'ASC']],
    });
    if (parcelas.length) {
      entradas.push({
        nome: 'Quotas extraordinarias/parcelas.csv',
        conteudo: csv(
          ['Quota extraordinária', 'Fração', 'Parcela', 'Valor', 'Vencimento', 'Estado'],
          parcelas.map((p) => [
            p.extra_quota ? p.extra_quota.designacao : '', nomeFracao(p.fracao_id), p.parcela_numero,
            formatEUR(p.valor), p.data_vencimento || '', p.estado,
          ])
        ),
      });
      incluidos.push('Quotas extraordinarias/parcelas.csv');
    }

    const pagamentos = await Pagamento.findAll({
      where: { condominio_id: condominioId, fracao_id: { [Op.in]: ids } },
      order: [['data_pagamento', 'ASC'], ['id', 'ASC']],
    });
    if (pagamentos.length) {
      entradas.push({
        nome: 'Pagamentos/pagamentos.csv',
        conteudo: csv(
          ['Fração', 'Documento', 'Data', 'Valor', 'Referência', 'Estado', 'Comprovativo'],
          pagamentos.map((p) => [
            nomeFracao(p.fracao_id), p.numero_documento || '', p.data_pagamento || '', formatEUR(p.valor),
            p.referencia || '', p.estado, p.comprovativo_nome || (comprovativos.existeComprovativo(p) ? 'anexado' : ''),
          ])
        ),
      });
      incluidos.push('Pagamentos/pagamentos.csv');

      // Comprovativos: ficheiros locais, incluídos apenas quando existem.
      for (const p of pagamentos) {
        if (!comprovativos.existeComprovativo(p)) continue;
        try {
          const caminho = comprovativos.caminhoComprovativo(p);
          if (!caminho || !fs.existsSync(caminho)) { ignorados.push(`Comprovativo do pagamento ${p.id}: ficheiro não encontrado`); continue; }
          const conteudo = fs.readFileSync(caminho);
          const nome = `Pagamentos/Comprovativos/${slug(p.numero_documento || `pagamento_${p.id}`, 50)}${(String(p.comprovativo_nome || '').match(/\.[a-z0-9]+$/i) || [''])[0]}`;
          entradas.push({ nome, conteudo });
          incluidos.push(nome);
        } catch (erro) {
          ignorados.push(`Comprovativo do pagamento ${p.id}: ${erro.message}`);
        }
      }
    }

    const recibos = await Recibo.findAll({
      where: { condominio_id: condominioId, fracao_id: { [Op.in]: ids } },
      order: [['ano', 'ASC'], ['id', 'ASC']],
    });
    if (recibos.length) {
      entradas.push({
        nome: 'Recibos/recibos.csv',
        conteudo: csv(
          ['Código', 'Fração', 'Ano', 'Tipo', 'Valor', 'Emitido em', 'Estado'],
          recibos.map((r) => [
            r.codigo, nomeFracao(r.fracao_id), r.ano, r.tipo, formatEUR(r.valor), r.data_emissao || '', r.estado,
          ])
        ),
      });
      incluidos.push('Recibos/recibos.csv');
    }
  }

  // ── 4. Documentos disponibilizados aos condóminos ─────────────────
  const documentos = await Documento.findAll({
    where: { condominio_id: condominioId, disponivel_condominos: true },
    order: [['data', 'ASC'], ['id', 'ASC']],
  });
  if (documentos.length) {
    entradas.push({
      nome: 'Documentos/documentos.csv',
      conteudo: csv(
        ['Nome', 'Tipo', 'Pasta', 'Data', 'Ficheiro incluído'],
        documentos.map((d) => [d.nome, d.tipo, d.pasta || '', d.data || '', ''])
      ),
    });
    incluidos.push('Documentos/documentos.csv');

    let incluidosFicheiros = 0;
    for (const d of documentos) {
      if (incluidosFicheiros >= MAX_FICHEIROS_DOCUMENTOS) {
        ignorados.push(`Documento "${d.nome}": limite de ${MAX_FICHEIROS_DOCUMENTOS} ficheiros por exportação`);
        continue;
      }
      if (!d.drive_file_id) { ignorados.push(`Documento "${d.nome}": sem ficheiro guardado na plataforma`); continue; }
      try {
        const { fluxo, tamanho } = await storage.abrirFluxo(d.drive_file_id, condominioId);
        if (tamanho && tamanho > MAX_BYTES_DOCUMENTO) { ignorados.push(`Documento "${d.nome}": maior do que 8 MB`); continue; }
        const pedacos = [];
        let total = 0;
        await new Promise((resolve, reject) => {
          fluxo.on('data', (c) => {
            total += c.length;
            if (total > MAX_BYTES_DOCUMENTO) { reject(new Error('maior do que 8 MB')); return; }
            pedacos.push(c);
          });
          fluxo.on('end', resolve);
          fluxo.on('error', reject);
        });
        const nome = await nomeDocumentoParaFicheiro(d);
        entradas.push({ nome, conteudo: Buffer.concat(pedacos) });
        incluidos.push(nome);
        incluidosFicheiros += 1;
      } catch (erro) {
        ignorados.push(`Documento "${d.nome}": ${erro.message}`);
      }
    }
  }

  // ── 5. Assembleias (do condomínio) e presenças do próprio ─────────
  const assembleias = await Assembleia.findAll({
    where: { condominio_id: condominioId },
    order: [['data', 'ASC'], ['id', 'ASC']],
  });
  if (assembleias.length) {
    const presencas = pessoa
      ? await AssembleiaParticipante.findAll({ where: { pessoa_id: pessoa.id } })
      : [];
    const porAssembleia = new Map(presencas.map((p) => [Number(p.assembleia_id), p]));
    entradas.push({
      nome: 'Assembleias/assembleias.csv',
      conteudo: csv(
        ['Número', 'Tipo', 'Data', 'Hora', 'Local', 'Estado', 'A minha presença'],
        assembleias.map((a) => [
          a.numero || '', a.tipo || '', a.data || '', a.hora || '', a.local || '', a.estado || '',
          porAssembleia.has(Number(a.id)) ? (porAssembleia.get(Number(a.id)).presente ? 'Presente' : 'Representado/ausente') : '',
        ])
      ),
    });
    incluidos.push('Assembleias/assembleias.csv');
  }

  // ── 6. Comunicações gerais do condomínio ──────────────────────────
  const avisos = await Aviso.findAll({
    where: { condominio_id: condominioId },
    order: [['id', 'ASC']],
  });
  if (avisos.length) {
    entradas.push({
      nome: 'Comunicacoes/avisos.csv',
      conteudo: csv(
        ['Assunto', 'Mensagem', 'Data'],
        avisos.map((a) => [a.assunto || '', String(a.mensagem || a.conteudo || '').slice(0, 2000), a.data || a.created_at || ''])
      ),
    });
    incluidos.push('Comunicacoes/avisos.csv');
  }

  // ── 7. Manifesto (transparência do que entra e do que não entra) ──
  const nomeFracaoPrincipal = fracoes && fracoes.length ? slug(fracoes[0].designacao, 24) : 'Condominio';
  const nomeFicheiro = `GesCondu_Exportacao_${slug(utilizador.nome, 30)}_${nomeFracaoPrincipal}_${dataRef}.zip`;

  const manifesto = [
    'GesCondu — exportação da minha informação',
    '=======================================',
    '',
    `Condomínio: ${condominio ? condominio.designacao : `#${condominioId}`}`,
    `Titular: ${utilizador.nome} <${utilizador.email}>`,
    `Frações: ${(fracoes || []).map((f) => f.designacao).join(', ') || '—'}`,
    `Gerado em: ${formatDate(dataRef)}`,
    '',
    'O que está incluído',
    '-------------------',
    ...incluidos.map((n) => ` · ${n}`),
    '',
  ];
  if (ignorados.length) {
    manifesto.push('O que não foi incluído (e porquê)', '--------------------------------');
    manifesto.push(...ignorados.map((n) => ` · ${n}`));
    manifesto.push('');
  }
  manifesto.push(
    'Notas importantes',
    '-----------------',
    '· Esta exportação contém apenas os dados e documentos a que tinha direito enquanto titular:',
    '  os seus dados de identificação, as suas frações, quotas, pagamentos, comprovativos, recibos,',
    '  documentos disponibilizados aos condóminos, assembleias e comunicações gerais.',
    '· Não inclui dados pessoais de outros condóminos, comprovativos de outras frações nem',
    '  documentos internos da administração.',
    '· O histórico financeiro e documental do condomínio NÃO é apagado por esta exportação nem pela',
    '  saída do condomínio: os registos necessários à gestão e à prestação de contas permanecem.',
    '· Os recibos podem ser novamente descarregados em PDF enquanto mantiver acesso ao condomínio.'
  );

  entradas.unshift({ nome: 'MANIFEST.txt', conteudo: Buffer.from(`${manifesto.join('\r\n')}\r\n`, 'utf8'), comprimir: true });
  incluidos.unshift('MANIFEST.txt');

  return {
    nomeFicheiro,
    buffer: zipar(entradas),
    manifesto: { incluidos, ignorados, nEntradas: entradas.length, fracoes: (fracoes || []).map((f) => f.designacao) },
  };
}

module.exports = { construirExportacao, hojeISO, slug, csv };
