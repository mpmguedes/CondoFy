// ═══════════════════════════════════════════════════════════════════
// Diagnóstico de documentos que não abrem (SOMENTE LEITURA).
//
// Um documento que existe na base de dados mas cujo ficheiro o serviço de
// armazenamento já não entrega aparece na interface como
// HTTP 502 («Não foi possível obter o documento no serviço de armazenamento»).
// Este script reproduz, documento a documento, EXACTAMENTE o que a aplicação
// faz ao abrir o ficheiro — sem escrever nada, sem apagar nada e sem mostrar
// tokens ou credenciais — e diz qual é a causa:
//
//   · ficheiro APAGADO no serviço (ou id inválido)      → File not found
//   · ficheiro criado por OUTRA conta                   → notFound/forbidden
//     (a autorização do GesCondu só acede aos ficheiros que criou)
//   · ficheiro é um documento NATIVO do Google          → não é descarregável
//     (Docs/Sheets/Slides: tem de ser exportado)
//   · ligação morta/revogada                            → invalid_grant
//
// Utilização (no ambiente da aplicação, a partir da pasta do projeto):
//   node scripts/diagnostico-documentos.js
//   node scripts/diagnostico-documentos.js --condominio 2
//   node scripts/diagnostico-documentos.js --tipo convocatoria --limite 20
//   node scripts/diagnostico-documentos.js --todos --limite 200
//
// Opções:
//   --condominio <id>   só os documentos deste condomínio
//   --tipo <tipo>       só documentos de um tipo (convocatoria, ata, recibo, ...)
//   --limite <n>        máximo de documentos verificados (por omissão 40)
//   --todos             verifica todos os documentos (sem limite de tipo)
//   --so-metadados      não abre o ficheiro; só lê os metadados no serviço
//
// NUNCA imprime tokens, chaves, ciphertexts nem segredos. Os endereços das
// contas aparecem mascarados (ma***@exemplo.pt).
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();

const storage = require('../helpers/storage');
const ligacoes = require('../helpers/armazenamento/ligacoes');
const locator = require('../helpers/armazenamento/locator');
const drive = require('../helpers/drive');
// Explicação da falha: a MESMA que a interface mostra a quem gere o condomínio
// (helpers/documentos-acesso.js) — uma única fonte de verdade.
const acesso = require('../helpers/documentos-acesso');

const TIPOS_SUGERIDOS = 'convocatoria, ata, recibo, aviso_quota, fatura, contrato, orcamento, outro';

function argumentos() {
  const argv = process.argv.slice(2);
  const obter = (nome) => {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const limite = Number(obter('limite'));
  return {
    condominio: Number(obter('condominio')) || null,
    tipo: obter('tipo') || null,
    limite: Number.isFinite(limite) && limite > 0 ? limite : 40,
    todos: argv.includes('--todos'),
    soMetadados: argv.includes('--so-metadados'),
  };
}

function linha(titulo) {
  console.log('');
  console.log('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 58 - titulo.length)));
}

// Nunca mostrar o endereço completo de uma conta.
function mascarar(email) {
  const texto = String(email || '').trim();
  if (!texto) return '(conta não identificada)';
  const [utilizador, dominio] = texto.split('@');
  if (!dominio) return texto.slice(0, 3) + '***';
  return `${utilizador.slice(0, 2)}***@${dominio}`;
}

function idCurto(valor) {
  const texto = String(valor || '');
  return texto.length > 22 ? `${texto.slice(0, 12)}…${texto.slice(-6)}` : texto;
}

// Mensagem e código do erro do fornecedor (Drive/Graph/Dropbox), sem stack.
function detalheDoErro(err) {
  const resposta = (err && err.response) || {};
  const dados = resposta.data || {};
  const erro = dados.error || {};
  const mensagem =
    erro.message ||
    (Array.isArray(erro.errors) && erro.errors[0] && erro.errors[0].message) ||
    (err && err.message) ||
    'erro desconhecido';
  const status = resposta.status || (err && err.code) || 0;
  return { status, mensagem: String(mensagem), bruto: err };
}

// Classificação da causa, em linguagem de quem administra o GesCondu.
// O texto da explicação vem de helpers/documentos-acesso.js (a mesma mensagem
// que a interface mostra a admin/gestor), para não haver duas versões.
function classificar(status, mensagem, metadados) {
  const texto = String(mensagem || '').toLowerCase();
  const nativo = Boolean(metadados && /^application\/vnd\.google-apps\./.test(String(metadados.mimeType || '')));
  const explicacao = acesso.explicarFalhaDoFornecedor(mensagem);

  if (nativo && !explicacao) {
    return {
      causa: 'documento_nativo',
      explicacao:
        'O ficheiro é um documento nativo do Google (Docs/Sheets/Slides): não pode ser entregue como ficheiro e tem de ser carregado em PDF/imagem.',
    };
  }
  if (!explicacao) {
    if (status === 404 || /not found/.test(texto)) {
      return {
        causa: 'ficheiro_inexistente',
        explicacao: 'O ficheiro já não existe na conta ligada (apagado no serviço ou criado por outra conta).',
      };
    }
    if (status === 403 || /forbidden|insufficient|permission/.test(texto)) {
      return {
        causa: 'sem_permissao_no_ficheiro',
        explicacao: 'A conta ligada não tem acesso a este ficheiro: foi criado por OUTRA conta Google.',
      };
    }
    return { causa: 'outro', explicacao: 'Erro do fornecedor ao entregar o ficheiro (ver a mensagem acima).' };
  }

  const causa = /revogada/.test(explicacao)
    ? 'ligacao_invalida'
    : /já não existe/.test(explicacao)
      ? 'ficheiro_inexistente'
      : /não tem acesso/.test(explicacao)
        ? 'sem_permissao_no_ficheiro'
        : /limite de pedidos/.test(explicacao)
          ? 'limite_do_fornecedor'
          : /documento nativo/.test(explicacao)
            ? 'documento_nativo'
            : 'outro';
  return { causa, explicacao };
}

async function metadadosDrive(fileId, condominioId) {
  try {
    const res = await drive.getDrive(condominioId).files.get({
      fileId,
      fields: 'id,name,mimeType,size,trashed,owners(emailAddress),parents',
      supportsAllDrives: true,
    });
    return { ok: true, dados: res.data };
  } catch (err) {
    return { ok: false, ...detalheDoErro(err) };
  }
}

// Reproduz o acesso da aplicação (helpers/documentos-acesso.js → storage.abrirFluxo)
// e fecha o fluxo imediatamente — só interessa se abre, não o conteúdo.
async function testarAbertura(localizador, condominioId) {
  try {
    const abertura = await storage.abrirFluxo(localizador, condominioId);
    const tamanho = abertura && abertura.tamanho != null ? Number(abertura.tamanho) : null;
    const fluxo = abertura && abertura.fluxo;
    if (fluxo && typeof fluxo.destroy === 'function') fluxo.destroy();
    return { ok: true, tamanho };
  } catch (err) {
    return { ok: false, ...detalheDoErro(err) };
  }
}

async function main() {
  const opcoes = argumentos();
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Diagnóstico de documentos que não abrem (somente leitura)');
  console.log('══════════════════════════════════════════════════════════════');
  if (!ligacoes.cifraDisponivel()) {
    console.log('');
    console.log('  AVISO: a chave de cifragem (ENCRYPTION_KEY) não está disponível neste processo.')
    console.log('  Sem ela as credenciais não são usadas — corra o script no ambiente da aplicação.');
  }

  const { Documento, Condominio } = require('../models');
  const { Op } = require('sequelize');

  // ── 1. Condomínios, serviço principal e conta em uso ───────────────
  linha('1. Condomínios e conta de armazenamento em uso');
  const condominios = await Condominio.findAll({ order: [['id', 'ASC']] }).catch(() => []);
  const porCondominio = new Map();
  for (const c of condominios) {
    let principal = '?';
    let conta = null;
    let origem = null;
    try {
      principal = await storage.nomePrincipalDoCondominio(c.id);
      const t = await ligacoes.lerTokens(principal, c.id);
      conta = t.tokens && t.tokens.conta ? t.tokens.conta : null;
      origem = t.origem;
    } catch (err) {
      principal = `erro: ${err.message}`;
    }
    porCondominio.set(c.id, { designacao: c.designacao, principal, conta, origem, pasta: c.drive_folder_id || null });
    console.log(
      `  · #${c.id} ${String(c.designacao || '').slice(0, 34)} — serviço: ${principal}` +
        ` · conta: ${mascarar(conta)}${origem ? ` (${origem})` : ''}` +
        ` · pasta registada: ${c.drive_folder_id ? 'sim' : 'não'}`
    );
  }
  if (!condominios.length) console.log('  (não foi possível ler os condomínios)');

  // ── 2. Documentos com ficheiro guardado ────────────────────────────
  linha('2. Documentos com ficheiro guardado');
  const where = { drive_file_id: { [Op.ne]: null } };
  if (opcoes.condominio) where.condominio_id = opcoes.condominio;
  if (opcoes.tipo && !opcoes.todos) where.tipo = opcoes.tipo;

  let total = 0;
  try {
    total = await Documento.count({ where });
  } catch (err) {
    console.log(`  Não foi possível ler a tabela de documentos: ${err.message}`);
    console.log('  Execute este diagnóstico no ambiente onde a aplicação corre (node scripts/diagnostico-documentos.js).');
    process.exit(2);
  }
  const limite = opcoes.todos ? Math.max(total, 1) : opcoes.limite;
  const documentos = await Documento.findAll({
    where,
    order: [['id', 'DESC']],
    limit: limite,
  });
  console.log(`  Documentos com ficheiro: ${total} · a verificar: ${documentos.length}${opcoes.tipo && !opcoes.todos ? ` · tipo: ${opcoes.tipo}` : ''}`);
  console.log(`  (tipos possíveis: ${TIPOS_SUGERIDOS})`);

  // ── 3. Verificação documento a documento ───────────────────────────
  linha('3. Resultado por documento');
  const resultados = { ok: [], falhas: [] };
  for (const doc of documentos) {
    const info = porCondominio.get(Number(doc.condominio_id)) || {};
    const lido = locator.ler(doc.drive_file_id);
    const etiqueta = `#${doc.id} ${String(doc.tipo || '?')} [c${doc.condominio_id}] ${String(doc.nome || '').slice(0, 40)}`;

    // Metadados no fornecedor (só Google Drive): dono, tipo e se está na lixeira.
    let meta = null;
    if (lido.provedor === 'google_drive') {
      const m = await metadadosDrive(lido.id, doc.condominio_id);
      if (m.ok) {
        meta = m.dados;
      } else {
        const c = classificar(m.status, m.mensagem, null);
        console.log(`  ✗ ${etiqueta}`);
        console.log(`      localizador: ${idCurto(doc.drive_file_id)} · metadados: ${m.status || ''} ${m.mensagem} · causa: ${c.causa}`);
        if (c.causa !== 'ligacao_invalida') {
          console.log(`      → ${c.explicacao}`);
        }
        resultados.falhas.push({ doc, lido, causa: c.causa, explicacao: c.explicacao, status: m.status, mensagem: m.mensagem, fase: 'metadados' });
        continue;
      }
    }

    const abertura = opcoes.soMetadados ? { ok: null } : await testarAbertura(doc.drive_file_id, doc.condominio_id);
    const dono = meta && Array.isArray(meta.owners) && meta.owners[0] ? meta.owners[0].emailAddress : null;
    const detalhe = [
      `serviço: ${lido.provedor || '?'}`,
      `conta em uso: ${mascarar(info.conta)}`,
      meta ? `dono: ${mascarar(dono)}` : null,
      meta ? `tipo: ${meta.mimeType}${meta.trashed ? ' (NA LIXEIRA)' : ''}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    if (abertura.ok === false) {
      const c = classificar(abertura.status, abertura.mensagem, meta);
      console.log(`  ✗ ${etiqueta}`);
      console.log(`      localizador: ${idCurto(doc.drive_file_id)} · ${detalhe}`);
      console.log(`      erro: ${abertura.status || ''} ${abertura.mensagem} · causa: ${c.causa}`);
      console.log(`      → ${c.explicacao}`);
      resultados.falhas.push({ doc, lido, causa: c.causa, explicacao: c.explicacao, status: abertura.status, mensagem: abertura.mensagem, dono, fase: 'abertura' });
    } else {
      const avisoDono = dono && info.conta && String(dono).toLowerCase() !== String(info.conta).toLowerCase()
        ? ' · ATENÇÃO: o dono do ficheiro é diferente da conta ligada'
        : '';
      console.log(`  ✓ ${etiqueta}`);
      console.log(`      localizador: ${idCurto(doc.drive_file_id)} · ${detalhe}${avisoDono}${abertura.tamanho ? ` · ${abertura.tamanho} bytes` : ''}`);
      resultados.ok.push({ doc, avisoDono });
    }
  }

  // ── 4. Resumo e o que fazer ────────────────────────────────────────
  linha('4. Resumo');
  const porCausa = new Map();
  for (const f of resultados.falhas) porCausa.set(f.causa, (porCausa.get(f.causa) || 0) + 1);
  const porServico = new Map();
  for (const d of documentos) {
    const p = locator.ler(d.drive_file_id).provedor || '?';
    porServico.set(p, (porServico.get(p) || 0) + 1);
  }
  console.log(`  Abrem sem problema: ${resultados.ok.length}`);
  console.log(`  Falham:             ${resultados.falhas.length}`);
  for (const [causa, n] of [...porCausa.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    · ${causa}: ${n}`);
  }
  console.log('  Documentos verificados, por serviço de armazenamento:');
  for (const [servico, n] of [...porServico.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    · ${servico}: ${n}`);
  }

  linha('5. O que fazer');
  if (!resultados.falhas.length) {
    console.log('  Nenhuma falha encontrada nos documentos verificados.');
    console.log('  Se a interface continuar a mostrar 502, verifique se o documento em causa está');
    console.log(`  entre os verificados (use --limite 200 --todos) e veja o registo do serviço:`);
    console.log('  a aplicação escreve a linha «[documentos-acesso] falha ao abrir o documento: …».');
  } else {
    const tem = (c) => porCausa.has(c);
    if (tem('ficheiro_inexistente') || tem('sem_permissao_no_ficheiro')) {
      console.log('  · Ficheiros que já não existem na conta ligada: acontece quando a conta Google do');
      console.log('    GesCondu foi trocada (nova autorização com outra conta) ou quando os ficheiros foram');
      console.log('    apagados/movidos no serviço. A autorização usada só acede aos ficheiros que criou.');
      console.log('    Solução: ligar de novo a conta ORIGINAL (Configurações → Armazenamento e Backups) ou');
      console.log('    voltar a carregar os documentos em falta — os registos na base de dados mantêm-se.');
    }
    if (tem('documento_nativo')) {
      console.log('  · Documentos nativos do Google (Docs/Sheets/Slides) não podem ser entregues como');
      console.log('    ficheiro. Devem ser carregados como PDF/JPG/PNG.');
    }
    if (tem('ligacao_invalida')) {
      console.log('  · A ligação ao serviço está revogada: use «Testar» ou «Desligar/Ligar» no cartão do');
      console.log('    serviço em Configurações → Armazenamento e Backups.');
    }
    if (tem('limite_do_fornecedor')) {
      console.log('  · Limite da API do fornecedor: repetir o diagnóstico dentro de alguns minutos.');
    }
    if (tem('outro')) {
      console.log('  · Outros erros: a mensagem do fornecedor está indicada em cada documento acima.');
    }
  }
  console.log('');
  console.log('  Nada foi alterado: este diagnóstico só lê a base de dados e os ficheiros.');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('✗ Diagnóstico interrompido: ' + err.message);
  console.error('');
  process.exit(2);
});