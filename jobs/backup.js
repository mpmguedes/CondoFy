const { execFile } = require('child_process');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { BackupLog } = require('../models');
// Backups são da INSTALAÇÃO (o dump contém dados de todos os condomínios):
// a cópia na cloud usa o destino configurado em Configurações → Armazenamento e
// Backups, com a ligação de PLATAFORMA do serviço escolhido — nunca a conta
// principal de documentos de um condomínio.
const storage = require('../helpers/storage');
// Inventário do DISCO (nome, tamanho, validade) — a verdade sobre a cópia local.
const inventario = require('../helpers/backup-inventario');
// Retenção: decisão pura (idade + proteção do último) e configuração persistida.
const retencao = require('../helpers/backup-retencao');

// Pasta da cópia LOCAL dos backups. É o backup a sério e existe SEMPRE, mesmo
// sem nenhum serviço de cloud ligado. Configurável apenas para os testes
// poderem escrever num diretório temporário (em produção é a pasta
// `backups/local` do projeto, ignorada pelo git).
//
// ⛔ Aqui só entram DUMPS da base de dados da instalação. Documentos, PDFs,
// imagens e anexos têm armazenamento próprio (Google Drive/Dropbox/OneDrive,
// por condomínio) e NUNCA são copiados para esta pasta.
function pastaLocal() {
  const configurada = String(process.env.BACKUP_LOCAL_DIR || '').trim();
  return configurada || path.join(__dirname, '..', 'backups', 'local');
}

function executarMysqldump() {
  return new Promise((resolve, reject) => {
    const args = [
      '-h', process.env.DB_HOST || '127.0.0.1',
      '-P', process.env.DB_PORT || '3306',
      '-u', process.env.DB_USER || 'condofy',
      '--single-transaction',
      '--quick',
      '--skip-lock-tables',
      process.env.DB_NAME || 'condofy',
    ];
    execFile(
      'mysqldump',
      args,
      { env: { ...process.env, MYSQL_PWD: process.env.DB_PASS || 'condofy' }, maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      }
    );
  });
}

// Destino cloud dos backups: a configuração GLOBAL da instalação + uma ligação
// que este job consiga MESMO usar (de plataforma quando existe, senão a do
// condomínio que tem esse serviço ligado). O fornecedor dos backups nunca é
// deduzido do fornecedor principal dos documentos de um condomínio — são dois
// conceitos independentes.
async function destinoCloud() {
  try {
    const destino = await storage.destinoDeBackup();
    if (!destino) return { destino: null, provedor: null, ligacao: null };
    const provedor = storage.obterProvedor(destino);
    if (!provedor) return { destino, provedor: null, ligacao: null };
    const ligacao = storage.ligacaoDeBackup(destino);
    if (!ligacao || !ligacao.origem) return { destino, provedor, ligacao: null };
    return { destino, provedor, ligacao };
  } catch (err) {
    console.error('[backup] não foi possível ler o destino dos backups:', err.message);
    return { destino: null, provedor: null, ligacao: null };
  }
}

// ── Retenção LOCAL ──────────────────────────────────────────────────
// Apaga cópias locais por IDADE. Devolve sempre um resumo — nunca lança por
// causa de um ficheiro que não se conseguiu remover.
//
// ⛔ A proteção do último backup local VÁLIDO é aplicada aqui (é a única regra
// que impede a instalação de ficar sem nenhum backup). Nenhuma combinação de
// retenção pode remover todas as cópias válidas.
async function limparBackupsLocais({ dias = null, limite = null, agora = new Date() } = {}) {
  const dir = pastaLocal();
  const { itens } = inventario.listar(dir);
  const decisao = retencao.selecionarPorIdade({ itens, dias, limite, agora, protegerUltimo: true });
  if (decisao.erro) {
    return { apagados: [], erros: [{ nome: null, erro: decisao.erro }], protegido: null, limite: null, erro: decisao.erro };
  }

  const apagados = [];
  const erros = [];
  for (const item of decisao.apagar) {
    // Só se apaga o que passa pelo `caminhoSeguro`: um nome fora do formato ou
    // fora do diretório é RECUSADO (nunca se segue um caminho arbitrário).
    const caminho = inventario.caminhoSeguro(dir, item.nome);
    if (!caminho) {
      erros.push({ nome: item.nome, erro: 'caminho_recusado' });
      continue;
    }
    try {
      fs.unlinkSync(caminho);
      apagados.push({ nome: item.nome, tamanho: item.tamanho, criadoEm: item.criadoEm, valido: item.valido });
    } catch (err) {
      erros.push({ nome: item.nome, erro: err.message });
      console.error('[backup] não foi possível remover a cópia local antiga:', item.nome, err.message);
    }
  }

  if (decisao.protegido) {
    console.log(
      `[backup] retenção local: ${decisao.protegido.nome} preservado — é o último backup local válido.`
    );
  }
  return {
    apagados,
    erros,
    protegido: decisao.protegido ? { nome: decisao.protegido.nome, criadoEm: decisao.protegido.criadoEm } : null,
    limite: decisao.limite,
    erro: null,
  };
}

// ── Retenção CLOUD ──────────────────────────────────────────────────
// Apaga as cópias cloud por IDADE, a partir do REGISTO (`backup_logs`): os
// fornecedores não expõem listagem de pasta na fachada do GesCondu, pelo que o
// registo é o único índice que existe.
//
// Independente da retenção local: nunca toca em ficheiros de `backups/local`.
// Corre mesmo que a cópia cloud do ciclo atual tenha falhado — a retenção de
// uma cópia antiga não depende de a nova ter corrido bem.
async function limparBackupsCloud({ dias = null, ligacao = null, agora = new Date() } = {}) {
  const validacao = retencao.normalizarDias(dias);
  if (!validacao.ok) {
    return { apagados: [], erros: [], suportado: null, limite: null, erro: validacao.erro };
  }
  const limite = new Date((agora instanceof Date ? agora.getTime() : new Date(agora).getTime()) - validacao.dias * retencao.MS_POR_DIA);

  let antigos = [];
  try {
    antigos = await BackupLog.findAll({
      where: { estado: 'concluido', data: { [Op.lt]: limite }, ficheiro_drive_id: { [Op.ne]: null } },
      order: [['data', 'ASC']],
    });
  } catch (err) {
    return { apagados: [], erros: [{ id: null, erro: err.message }], suportado: null, limite, erro: err.message };
  }

  // Âmbito da remoção: a ligação ATUAL do destino de backups. Antes de 2026-09-21
  // este valor não era passado (`storage.apagarArquivo(id)`), pelo que a remoção
  // resolvia os tokens do âmbito PLATAFORMA mesmo quando a cópia tinha sido
  // enviada pela ligação de um condomínio — o `DELETE` caía noutra conta, o
  // fornecedor respondia 404 e o OneDrive devolvia `true` («apagado») sem apagar.
  const condominioId = ligacao ? ligacao.condominioId : null;

  const apagados = [];
  const erros = [];
  let suportado = null;
  for (const b of antigos) {
    try {
      const r = await storage.apagarArquivo(b.ficheiro_drive_id, condominioId);
      if (r === false) {
        // O provedor não suporta remoção (Dropbox): registar em vez de fingir
        // que a retenção aconteceu. A cópia cloud fica onde está.
        suportado = false;
        erros.push({ id: b.id, erro: 'provedor_sem_remocao' });
        continue;
      }
      suportado = suportado === false ? false : true;
      // A referência é limpa para o registo não continuar a anunciar uma cópia
      // cloud que já não existe. Se a remoção falhar, NADA é limpo.
      const referencia = b.ficheiro_drive_id;
      await b.update({ ficheiro_drive_id: null }).catch(() => {});
      apagados.push({ id: b.id, referencia, data: b.data, tamanho: b.tamanho });
    } catch (err) {
      erros.push({ id: b.id, erro: err.message });
      console.error('[backup] erro ao remover a cópia cloud antiga:', err.message);
    }
  }
  return { apagados, erros, suportado, limite, erro: null };
}

// Resumo textual da limpeza — é o que fica guardado em `configuracoes` e o que
// a área do Super Admin apresenta como «resultado da última limpeza».
function descreverLimpeza({ local, cloud, config }) {
  const partes = [];
  if (local) {
    partes.push(
      `local: ${local.apagados.length} removido(s)${local.protegido ? `, último válido preservado (${local.protegido.nome})` : ''}`
    );
  }
  if (cloud) {
    if (cloud.erro) partes.push(`cloud: não executada (${cloud.erro})`);
    else if (cloud.suportado === false) partes.push('cloud: o serviço de destino não suporta remoção');
    else partes.push(`cloud: ${cloud.apagados.length} removido(s)`);
  }
  if (config) partes.push(`retenção local ${config.retencaoLocal} d · cloud ${config.retencaoCloud} d`);
  return partes.join(' · ');
}

// Executa a limpeza (local + cloud) conforme a configuração. Usada pelo ciclo
// automático e pela ação manual da área do Super Admin (uma só verdade).
// `ligacao` indefinida = resolver agora o destino configurado (é o caso da
// limpeza manual, que não vem de um ciclo de backup).
async function executarLimpeza({ ligacao, agora = new Date(), forcar = false } = {}) {
  const config = await retencao.lerConfiguracao();
  if (!forcar && !config.limpezaAutomatica) {
    return { executada: false, motivo: 'limpeza_desativada', local: null, cloud: null, resultado: null };
  }
  const alvoLigacao = ligacao === undefined ? (await destinoCloud()).ligacao : ligacao;
  const local = await limparBackupsLocais({ dias: config.retencaoLocal, agora });
  const cloud = await limparBackupsCloud({ dias: config.retencaoCloud, ligacao: alvoLigacao, agora });
  const resultado = descreverLimpeza({ local, cloud, config });
  await retencao.registarLimpeza({ quando: agora, resultado });
  return { executada: true, motivo: null, local, cloud, resultado, config };
}

// ── Leitura para a área do Super Admin ──────────────────────────────
// Lista as cópias LOCAIS a partir do disco e junta-as ao registo. Devolve a
// medição real (nº, espaço, mais antigo, mais recente) — nunca uma estimativa.
async function listarBackupsLocais() {
  const dir = pastaLocal();
  let logs = [];
  try {
    logs = await BackupLog.findAll({ where: { estado: 'concluido' }, order: [['data', 'ASC']] });
  } catch (err) {
    console.error('[backup] não foi possível ler o registo de backups:', err.message);
  }
  const rotulos = {};
  try {
    for (const nome of storage.provedores()) {
      const p = storage.obterProvedor(nome);
      if (p) rotulos[nome] = p.rotulo();
    }
  } catch (err) {
    // Sem registo de provedores a lista continua a ser a verdade do disco; só
    // não se acrescenta o nome legível do serviço da cópia cloud.
  }
  return inventario.apresentarLista({
    diretorio: dir,
    logs: (logs || []).map((l) => (l && l.toJSON ? l.toJSON() : l)),
    rotulos,
  });
}

// ── Eliminação MANUAL ───────────────────────────────────────────────
// Uma cópia individual. Recusada quando deixaria a instalação sem o último
// backup local válido (a mesma proteção das limpezas automáticas).
function apagarBackupLocal({ nome, itens = null } = {}) {
  const dir = pastaLocal();
  const caminho = inventario.caminhoSeguro(dir, nome);
  if (!caminho) return { ok: false, motivo: 'nome_invalido' };
  const lista = Array.isArray(itens) ? itens : inventario.listar(dir).itens;
  const alvo = lista.find((i) => i.nome === nome) || null;
  if (!alvo) return { ok: false, motivo: 'nao_encontrado' };
  const decisao = retencao.podeApagarIndividual(alvo, lista);
  if (!decisao.ok) return { ok: false, motivo: decisao.motivo };
  try {
    fs.unlinkSync(caminho);
  } catch (err) {
    return { ok: false, motivo: 'erro_remocao', erro: err.message };
  }
  return { ok: true, item: { nome: alvo.nome, tamanho: alvo.tamanho, criadoEm: alvo.criadoEm, valido: alvo.valido } };
}

// Todas as cópias anteriores a uma data. Reutiliza a MESMA seleção por idade
// (logo, a mesma proteção do último backup válido).
async function apagarBackupsAntesDe({ dataLimite, itens = null, agora = new Date() } = {}) {
  const limite = new Date(dataLimite);
  if (Number.isNaN(limite.getTime())) return { ok: false, motivo: 'data_invalida' };
  const dir = pastaLocal();
  const lista = Array.isArray(itens) ? itens : inventario.listar(dir).itens;
  const decisao = retencao.selecionarPorIdade({ itens: lista, limite, agora, protegerUltimo: true });
  if (decisao.erro) return { ok: false, motivo: decisao.erro };

  const apagados = [];
  const erros = [];
  for (const item of decisao.apagar) {
    const caminho = inventario.caminhoSeguro(dir, item.nome);
    if (!caminho) {
      erros.push({ nome: item.nome, erro: 'caminho_recusado' });
      continue;
    }
    try {
      fs.unlinkSync(caminho);
      apagados.push({ nome: item.nome, tamanho: item.tamanho, criadoEm: item.criadoEm });
    } catch (err) {
      erros.push({ nome: item.nome, erro: err.message });
    }
  }
  return {
    ok: true,
    apagados,
    erros,
    protegido: decisao.protegido ? { nome: decisao.protegido.nome, criadoEm: decisao.protegido.criadoEm } : null,
  };
}

// ── Ciclo de backup ─────────────────────────────────────────────────
// Executa um backup:
//   1. cópia LOCAL — SEMPRE, e validada (é o backup a sério);
//   2. cópia CLOUD — só quando existe um destino configurado E uma ligação
//      utilizável para esse destino;
//   3. retenção — local e cloud, independentes.
// Uma falha na cópia cloud NUNCA remove nem invalida a cópia local. Uma falha
// na cópia LOCAL falha o ciclo: a cloud não é substituto do backup local.
async function executarBackup(tipo = 'diario') {
  const log = await BackupLog.create({ tipo, estado: 'em_curso' });
  let localEscrito = false;
  let localValido = false;
  try {
    const dump = await executarMysqldump();
    const gz = zlib.gzipSync(dump);
    const nome = `backup_${tipo}_${new Date().toISOString().slice(0, 10)}_${Date.now()}.sql.gz`;

    // 1) Cópia local: OBRIGATÓRIA. Escrita antes de qualquer tentativa de
    //    upload — se a cloud falhar, o backup já existe no servidor.
    const dir = pastaLocal();
    fs.mkdirSync(dir, { recursive: true });
    const destino = path.join(dir, nome);
    fs.writeFileSync(destino, gz);
    localEscrito = true;

    // 2) Validação da cópia local: existe, não está vazia e é mesmo gzip.
    //    `tamanho` só é registado DEPOIS de validar — é esta coluna que prova
    //    que existe um backup (ver helpers/backup-estado.js). Sem validação, um
    //    ficheiro truncado passaria por backup.
    const verificacao = inventario.validarFicheiro(destino);
    if (!verificacao.valido) {
      throw new Error(`a cópia local não passou a validação (${verificacao.motivo || 'motivo desconhecido'})`);
    }
    localValido = true;
    await log.update({ tamanho: verificacao.tamanho });

    // 3) Cópia cloud: opcional e independente do serviço dos documentos.
    const { destino: alvo, provedor, ligacao } = await destinoCloud();
    let referencia = null;
    let erroCloud = null;
    if (provedor && ligacao) {
      try {
        const pastaId = await storage.pastaDeBackups(alvo, ligacao.condominioId);
        const up = await storage.uploadComProvedor(alvo, {
          nome,
          mimeType: 'application/gzip',
          buffer: gz,
          parentFolderId: pastaId,
          condominioId: ligacao.condominioId,
        });
        referencia = up.localizador || up.provedorFileId || up.driveFileId || null;
        if (!referencia) erroCloud = 'o serviço não devolveu a referência do ficheiro';
      } catch (err) {
        erroCloud = err.message;
      }
    }

    if (referencia) {
      await log.update({ estado: 'concluido', ficheiro_drive_id: referencia, erro: null });
      console.log(`[backup] ${nome} concluído: cópia local + ${provedor.rotulo()}${ligacao.conta ? ` (${ligacao.conta})` : ''} (${gz.length} bytes).`);
    } else if (erroCloud) {
      // A cópia local está feita, validada e fica onde está: só a cópia cloud
      // falhou. `estado='concluido'` significa sempre «o BACKUP concluiu».
      await log.update({ estado: 'concluido', erro: `Cópia cloud não criada: ${erroCloud}` });
      console.error(`[backup] ${nome} guardado localmente; cópia cloud (${alvo}) falhou: ${erroCloud}`);
    } else {
      await log.update({ estado: 'concluido', erro: null });
      console.log(`[backup] ${nome} guardado localmente (sem destino de backups configurado ou utilizável).`);
    }

    // 4) Retenção — só depois de o backup local estar garantido e validado, e
    //    INDEPENDENTE do resultado da cópia cloud.
    const limpeza = await executarLimpeza({ ligacao });
    if (limpeza.executada) console.log(`[backup] retenção: ${limpeza.resultado}`);

    return log;
  } catch (err) {
    // Falhou ANTES de haver uma cópia local VÁLIDA: não há backup nenhum e o
    // ciclo é FALHADO (a cloud nunca é tratada como substituto do local).
    // Falhou DEPOIS: a cópia local existe e é preservada — regista-se a falha
    // sem transformar um backup válido em «erro».
    if (localValido) {
      await log.update({ estado: 'concluido', erro: err.message }).catch(() => {});
      console.error('[backup] cópia local preservada; falha a seguir:', err.message);
    } else {
      await log.update({ estado: 'erro', erro: err.message }).catch(() => {});
      console.error('[backup] erro:', err.message);
    }
    if (localEscrito && !localValido) {
      // O ficheiro ficou em disco mas é inválido: fica visível no inventário
      // como «Inválido» (é evidência) e será removido pela retenção por idade.
      console.error('[backup] a cópia local escrita é inválida e não conta como backup.');
    }
    return log;
  }
}

module.exports = {
  executarBackup,
  // Configuração de retenção (lida pela área do Super Admin e pelo ciclo)
  configuracaoRetencao: retencao.lerConfiguracao,
  // Inventário e retenção, reutilizados pela área do Super Admin
  pastaLocal,
  listarBackupsLocais,
  limparBackupsLocais,
  limparBackupsCloud,
  executarLimpeza,
  apagarBackupLocal,
  apagarBackupsAntesDe,
};
