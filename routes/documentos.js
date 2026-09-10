const express = require('express');
const multer = require('multer');
const { Op } = require('sequelize');
const { Documento, Pessoa, Categoria, DocumentoCategoria, Recibo, Fracao, Quota } = require('../models');
const { eAdmin } = require('../helpers/eAdmin');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
// StorageProvider: os documentos falam com a fachada helpers/storage
// (provedor atual: google_drive), não diretamente com o drive.
const drive = require('../helpers/storage');
const documentActions = require('../helpers/document-actions');
const { enfileirarEmail: enfileirarEmailFila } = require('../helpers/email-fila');
const { compor: comporEmail, nomeFicheiro: nomeFicheiroEmail } = require('../helpers/email-templates');
const { getCondominio, clearCondominioCache } = require('../helpers/condominio');
const { PASTAS_BASE: PASTAS, mapaPastas, pastasPersonalizadas, novaKey, resolverPastaDocumento } = require('../helpers/documento-pastas');
// Acesso autorizado a documentos (Utilizador → Condomínio → Documento).
const { autorizarAcessoDocumento, servirDocumento, responderRecusa, urlParaEmail, urlInterna } = require('../helpers/documentos-acesso');

const router = express.Router();
// Isolamento: todas as operações usam o condomínio ativo (sessão validada).
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('gestor'));

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// Referência externa introduzida pelo administrador (documento sem ficheiro
// guardado no armazenamento do condomínio). Só http/https: evita
// javascript:/data: no href das vistas e no corpo dos emails.
function urlExternaSegura(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return null;
  let u;
  try {
    u = new URL(texto);
  } catch (err) {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// Tipos permitidos por pasta (para limitar o upload).
const TIPOS_POR_PASTA = {
  atas: ['ata', 'outro'],
  convocatorias: ['convocatoria', 'outro'],
  contratos: ['contrato', 'outro'],
  regulamentos: ['outro'],
  recibos: ['recibo', 'outro'],
  assembleias: ['ata', 'convocatoria', 'outro'],
  apolices: ['outro'],
  comprovativos: ['outro'],
  faturas: ['fatura', 'outro'],
  outros: ['outro', 'ata', 'convocatoria', 'fatura', 'contrato', 'relatorio', 'orcamento'],
};

// Categorias pré-definidas da BIBLIOTECA visual (cada uma agrega pastas).
const CATEGORIAS_BIBLIOTECA = [
  { chave: 'biblioteca', titulo: 'Biblioteca de Condomínio', icone: 'menu_book', descricao: 'Atas, contratos, regulamentos, convocatórias e faturas', pastas: ['atas', 'contratos', 'regulamentos', 'convocatorias', 'faturas'] },
  { chave: 'recibos', titulo: 'Recibos de Pagamento', icone: 'receipt_long', descricao: 'Recibos arquivados por fração e ano', pastas: ['recibos'] },
  { chave: 'assembleias', titulo: 'Assembleias', icone: 'forum', descricao: 'Convocatórias, atas e anexos das assembleias', pastas: ['assembleias'] },
  { chave: 'seguros', titulo: 'Seguros', icone: 'shield', descricao: 'Apólices e comprovativos de seguros', pastas: ['apolices', 'comprovativos'] },
  // "Outros" é obrigatória e nunca pode ser eliminada.
  { chave: 'outros', titulo: 'Outros', icone: 'folder', descricao: 'Documentos diversos sem outra classificação', pastas: ['outros'] },
];

router.get('/documentos', async (req, res) => {
  const cond = await getCondominio({ id: req.condominioId });
  const mapa = mapaPastas(cond);
  const pasta = typeof req.query.pasta === 'string' ? req.query.pasta : null;
  const pastasMulti = typeof req.query.pastas === 'string' ? req.query.pastas.split(',').map((s) => s.trim()).filter((s) => mapa[s]) : null;

  const emBiblioteca = !pasta && !pastasMulti;
  const where = { condominio_id: req.condominioId };
  if (pasta && mapa[pasta]) where.pasta = pasta;
  if (pastasMulti && pastasMulti.length) where.pasta = { [Op.in]: pastasMulti };

  // Contagens por pasta (para os cartões e para o cabeçalho da lista).
  const chaves = Object.keys(mapa);
  const contagensRaw = await Promise.all(
    chaves.map(async (key) => [key, await Documento.count({ where: { condominio_id: req.condominioId, pasta: key } })])
  );
  const contagem = new Map(contagensRaw);

  if (emBiblioteca) {
    // Cartões das 5 categorias + pastas personalizadas.
    const categorias = CATEGORIAS_BIBLIOTECA.map((c) => ({
      ...c,
      contagem: c.pastas.reduce((s, k) => s + (contagem.get(k) || 0), 0),
      href: `/admin/documentos?pastas=${encodeURIComponent(c.pastas.join(','))}`,
    }));
    const personalizadas = pastasPersonalizadas(cond).map((p) => ({
      chave: p.key,
      titulo: p.nome,
      icone: 'create_new_folder',
      descricao: 'Pasta personalizada da biblioteca',
      pastas: [p.key],
      contagem: contagem.get(p.key) || 0,
      href: `/admin/documentos?pastas=${encodeURIComponent(p.key)}`,
    }));
    return res.render('admin/documentos/biblioteca', {
      titulo: 'Documentos',
      categorias,
      personalizadas,
      total: [...contagem.values()].reduce((s, n) => s + n, 0),
      driveLigado: drive.isConfigured(req.condominioId),
    });
  }

  // Listagem interna de uma pasta/categoria (tabela existente).
  const rotulo = pastasMulti
    ? (CATEGORIAS_BIBLIOTECA.find((c) => c.pastas.length === pastasMulti.length && c.pastas.every((k) => pastasMulti.includes(k)))
      || { titulo: pastasMulti.map((k) => mapa[k]).filter(Boolean).join(' + ') }).titulo
    : pasta
      ? mapa[pasta]
      : null;

  // ── Recibos de Pagamento: navegação UX por anos (sem tabela técnica) ──
  if (rotulo === 'Recibos de Pagamento') {
    const anoRecibos = parseInt(req.query.ano, 10) || null;
    if (!anoRecibos) {
      const dados = await Documento.findAll({
        where: { condominio_id: req.condominioId, pasta: 'recibos', data: { [Op.ne]: null } },
        attributes: ['data'],
        raw: true,
      });
      const porAno = new Map();
      for (const d of dados) {
        const ano = d.data ? new Date(d.data).getFullYear() : null;
        if (!ano) continue;
        porAno.set(ano, (porAno.get(ano) || 0) + 1);
      }
      const anos = [...porAno.entries()].map(([value, n]) => ({ ano: value, n })).sort((a, b) => b.ano - a.ano);
      return res.render('admin/documentos/recibos-anos', {
        titulo: 'Recibos de Pagamento',
        anos,
        driveLigado: drive.isConfigured(req.condominioId),
      });
    }

    const inicio = `${anoRecibos}-01-01`;
    const fim = `${anoRecibos}-12-31`;
    const docs = await Documento.findAll({
      where: { condominio_id: req.condominioId, pasta: 'recibos', data: { [Op.between]: [inicio, fim] } },
      order: [['data', 'DESC'], ['id', 'DESC']],
    });
    const codigos = docs.map((d) => d.numero_documento).filter(Boolean);
    const recibos = codigos.length
      ? await Recibo.findAll({
          where: { condominio_id: req.condominioId, codigo: { [Op.in]: codigos } },
          include: [
            { model: Fracao, as: 'fracao' },
            { model: Quota, as: 'quotas', through: { attributes: [] }, attributes: ['mes', 'ano'] },
          ],
        })
      : [];
    const reciboPorCodigo = new Map(recibos.map((r) => [r.codigo, r]));
    const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const linhas = docs.map((doc) => {
      const rec = doc.numero_documento ? reciboPorCodigo.get(doc.numero_documento) : null;
      const periodos = rec
        ? [...new Set((rec.quotas || []).map((q) => `${MESES_CURTO[q.mes - 1]} ${q.ano}`))]
        : [];
      return {
        id: doc.id,
        url: doc.url,
        // O ficheiro é sempre servido pelo GesCondu (ver documentos-acesso).
        // `url` fica apenas como referência externa de documentos sem ficheiro
        // guardado no armazenamento do condomínio.
        ficheiroInterno: urlInterna(doc, { area: 'gestao' }),
        urlExterna: doc.drive_file_id ? null : doc.url || null,
        drive_status: doc.drive_status,
        codigo: rec ? rec.codigo : doc.numero_documento || doc.nome,
        fracao: rec && rec.fracao ? rec.fracao.designacao : null,
        periodos: periodos.join(', '),
        valor: rec ? rec.valor : null,
        uid: rec ? rec.codigo_verificacao : null,
        enviado: rec ? Boolean(rec.enviado_at) : false,
        reciboPdf: rec && rec.id ? `/admin/quotas/recibos/${rec.id}/pdf` : null,
      };
    });
    return res.render('admin/documentos/recibos', {
      titulo: 'Recibos de Pagamento',
      ano: anoRecibos,
      linhas,
      driveLigado: drive.isConfigured(req.condominioId),
    });
  }

  const documentos = await Documento.findAll({
    where,
    include: [{ model: Categoria, as: 'categorias', through: { attributes: [] }, required: false }],
    order: [['data', 'DESC'], ['id', 'DESC']],
  });
  res.render('admin/documentos/listar', {
    titulo: rotulo ? `Documentos · ${rotulo}` : 'Documentos',
    documentos,
    pasta,
    pastasMulti: pastasMulti || null,
    rotulo,
    nDocumentos: documentos.length,
    pastas: mapa,
    pastaCustom: pasta && pasta.startsWith('c-') ? pasta : null,
    driveLigado: drive.isConfigured(req.condominioId),
  });
});

// Abrir a pasta do condomínio no painel do serviço de armazenamento ativo. O
// folderId é SEMPRE resolvido no servidor a partir de req.condominioId →
// condominios.drive_folder_id (nunca aceite do browser). Cria/regista a pasta
// quando ainda não existe. Só os serviços que expõem link de pasta (Google
// Drive) disponibilizam este atalho.
router.get('/documentos/drive/pasta', async (req, res) => {
  try {
    if (!drive.isConfigured(req.condominioId)) {
      req.flash('error_msg', 'Não há serviço de armazenamento ligado neste condomínio (Configurações → Armazenamento e Backups).');
      return res.redirect('/admin/documentos');
    }
    const folderId = await drive.obterPastaCondominioId(req.condominioId);
    const link = await drive.linkPasta(folderId, req.condominioId);
    if (!link) {
      req.flash('error_msg', 'O serviço de armazenamento deste condomínio não disponibiliza link para a pasta.');
      return res.redirect('/admin/documentos');
    }
    return res.redirect(link);
  } catch (err) {
    console.error('[documentos-pasta-armazenamento]', err.message);
    req.flash('error_msg', `Não foi possível abrir a pasta do condomínio: ${err.message}`);
    return res.redirect('/admin/documentos');
  }
});

// ── Pastas personalizadas (biblioteca) ──────────────────────────────
router.post('/documentos/pastas', async (req, res) => {
  const cond = await getCondominio({ id: req.condominioId });
  if (!cond) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect('/admin/documentos');
  }
  const nome = String(req.body.nome || '').trim();
  if (!nome || nome.length > 40) {
    req.flash('error_msg', 'Indique um nome para a pasta (máx. 40 caracteres).');
    return res.redirect('/admin/documentos');
  }
  const lista = pastasPersonalizadas(cond);
  const mapa = mapaPastas(cond);
  const duplicada = Object.values(mapa).some((n) => String(n).toLowerCase() === nome.toLowerCase());
  if (duplicada) {
    req.flash('error_msg', 'Já existe uma pasta com esse nome.');
    return res.redirect('/admin/documentos');
  }
  const usadas = new Set(Object.keys(mapa));
  const key = novaKey(nome, usadas);
  lista.push({ key, nome });
  await cond.update({ documento_pastas: JSON.stringify(lista) });
  clearCondominioCache();
  await audit({ userId: req.user.id, acao: 'criar_pasta_documentos', entidade: 'Condominio', entidadeId: cond.id, detalhes: { key, nome } }).catch(() => {});
  req.flash('success_msg', `Pasta "${nome}" criada.`);
  res.redirect(`/admin/documentos?pasta=${encodeURIComponent(key)}`);
});

router.post('/documentos/pastas/:key/eliminar', async (req, res) => {
  const cond = await getCondominio({ id: req.condominioId });
  if (!cond) {
    req.flash('error_msg', 'Condomínio não encontrado.');
    return res.redirect('/admin/documentos');
  }
  const key = req.params.key;
  const lista = pastasPersonalizadas(cond);
  const alvo = lista.find((p) => p.key === key);
  if (!alvo) {
    req.flash('error_msg', 'Pasta personalizada não encontrada.');
    return res.redirect('/admin/documentos');
  }
  const nDocs = await Documento.count({ where: { condominio_id: req.condominioId, pasta: key } });
  if (nDocs > 0) {
    req.flash('error_msg', `A pasta "${alvo.nome}" tem ${nDocs} documento(s). Mova-os primeiro (a pasta "Outros" é obrigatória).`);
    return res.redirect(`/admin/documentos?pasta=${encodeURIComponent(key)}`);
  }
  await cond.update({ documento_pastas: JSON.stringify(lista.filter((p) => p.key !== key)) });
  clearCondominioCache();
  await audit({ userId: req.user.id, acao: 'eliminar_pasta_documentos', entidade: 'Condominio', entidadeId: cond.id, detalhes: { key, nome: alvo.nome } }).catch(() => {});
  req.flash('success_msg', `Pasta "${alvo.nome}" removida.`);
  res.redirect('/admin/documentos');
});

router.get('/documentos/nova', async (req, res) => {
  const cond = await getCondominio({ id: req.condominioId });
  const categoriasDoc = await Categoria.findAll({ where: { tipo: 'documento', ativa: true }, order: [['nome', 'ASC']] });
  res.render('admin/documentos/form', {
    titulo: 'Novo documento',
    pastas: mapaPastas(cond),
    categoriasDoc,
    driveLigado: drive.isConfigured(req.condominioId),
  });
});

router.post('/documentos', upload.single('ficheiro'), async (req, res) => {
  try {
    const { nome, tipo, data, url, pasta } = req.body;
    // Referência externa validada (só http/https) — nunca é aceite tal e qual.
    const urlExterna = urlExternaSegura(url);
    const cond = await getCondominio({ id: req.condominioId });
    const mapa = mapaPastas(cond);
    // Classificação central: respeita uma escolha válida/compatível; corrige
    // automaticamente (com aviso) quando a escolha é incompatível com o tipo.
    const decisao = resolverPastaDocumento({
      tipo: tipo || 'outro',
      pastaEscolhida: pasta,
      pastasValidas: Object.keys(mapa),
    });
    const pastaEscolhida = decisao.pasta;
    const ano = data ? new Date(data).getFullYear() : new Date().getFullYear();

    let driveFileId = null;
    let driveUrl = urlExterna;
    let drivePastaId = null;
    let mimeType = null;
    let tamanho = null;
    let driveUploadedAt = null;

    if (req.file) {
      if (!drive.isConfigured(req.condominioId)) {
        req.flash('error_msg', 'O armazenamento do condomínio não está ligado — ligue o serviço em Configuração → Armazenamento e Backups ou indique apenas um URL externo.');
        return res.redirect('/admin/documentos/nova');
      }
      const pastaId = await drive.pastaParaDocumento(tipo, ano, req.condominioId);
      const up = await drive.uploadArquivo({
        nome: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        parentFolderId: pastaId,
        condominioId: req.condominioId,
      });
      // Identificador do ficheiro no provedor de armazenamento principal do
      // condomínio (pode ter prefixo dbx:/od:; sem prefixo = Google Drive).
      driveFileId = up.localizador || up.driveFileId || null;
      driveUrl = driveFileId ? null : up.url;
      drivePastaId = pastaId;
      mimeType = req.file.mimetype;
      tamanho = up.tamanho;
      driveUploadedAt = new Date();
    }

    const documento = await Documento.create({
      condominio_id: req.condominioId,
      tipo: tipo || 'outro',
      nome: nome || (req.file ? req.file.originalname : 'Documento'),
      pasta: pastaEscolhida,
      // "Disponível aos condóminos": default NÃO para manuais; convocatórias e
      // atas (documentos que o sistema sabe serem destinados aos condóminos)
      // ficam automaticamente disponíveis.
      disponivel_condominos: (req.body.disponivel_condominos === 'on' || req.body.disponivel_condominos === '1') || ['convocatoria', 'ata'].includes(tipo || ''),
      drive_file_id: driveFileId,
      drive_folder_id: drivePastaId,
      mime_type: mimeType,
      tamanho,
      data: data || new Date(),
      url: driveUrl,
      drive_status: driveFileId ? 'guardado' : 'nao_guardado',
      drive_uploaded_at: driveUploadedAt,
      created_by: req.user.id,
    });

    // Categorias de documento (many-to-many) — validadas como tipo 'documento'.
    const catIds = toArray(req.body.categorias).map(Number).filter(Boolean);
    if (catIds.length) {
      const validas = await Categoria.findAll({ where: { id: { [Op.in]: catIds }, tipo: 'documento', ativa: true }, attributes: ['id'] });
      for (const cat of validas) {
        await DocumentoCategoria.findOrCreate({
          where: { documento_id: documento.id, categoria_id: cat.id },
          defaults: { documento_id: documento.id, categoria_id: cat.id },
        });
      }
    }

    await audit({ userId: req.user.id, acao: 'criar_documento', entidade: 'Documento', entidadeId: documento.id });
    req.flash('success_msg', decisao.corrigida ? `Documento guardado. ${decisao.motivo}.` : 'Documento guardado.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', `Erro ao guardar o documento: ${err.message}`);
  }
  res.redirect(`/admin/documentos?pasta=${req.body.pasta || ''}`);
});

router.post('/documentos/:id/eliminar', async (req, res) => {
  const documento = await Documento.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
  if (documento) {
    await documento.destroy();
    await audit({ userId: req.user.id, acao: 'eliminar_documento', entidade: 'Documento', entidadeId: req.params.id });
  }
  req.flash('success_msg', 'Documento eliminado.');
  res.redirect('/admin/documentos');
});

// Visibilidade na área do Condómino ("Disponível aos condóminos").
router.post('/documentos/:id/disponivel', async (req, res) => {
  const documento = await Documento.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
  if (documento) {
    await documento.update({ disponivel_condominos: !documento.disponivel_condominos });
    await audit({
      userId: req.user.id,
      acao: documento.disponivel_condominos ? 'disponibilizar_documento_condominos' : 'ocultar_documento_condominos',
      entidade: 'Documento',
      entidadeId: documento.id,
    }).catch(() => {});
  }
  res.redirect(req.get('Referer') || '/admin/documentos');
});

// ── Ações sobre documentos ──────────────────────────────────────────
// Enviar documento por email (fila normal). Pré-preenche destinatários
// manualmente e/ou por seleção de condóminos.
router.get('/documentos/:id/email', async (req, res) => {
  const documento = await Documento.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
  if (!documento) return res.redirect('/admin/documentos');
  const pessoas = await Pessoa.findAll({
    where: { ativo: true, email: { [Op.ne]: null }, condominio_id: req.condominioId },
    order: [['nome', 'ASC']],
  });
  const cond = await getCondominio({ id: req.condominioId });
  const emissorNome = String((cond && (cond.administracao_nome || cond.designacao)) || '').trim() || 'GesCondu';
  res.render('admin/documentos/email', {
    titulo: 'Enviar documento por email',
    documento,
    pessoas,
    driveLigado: drive.isConfigured(req.condominioId),
    emissorNome,
    temAnexo: Boolean(documento.drive_file_id),
  });
});

router.post('/documentos/:id/email', async (req, res) => {
  const documento = await Documento.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
  if (!documento) return res.redirect('/admin/documentos');

  const destinatarios = [];
  // emails escritos manualmente (separados por vírgula, ponto e vírgula ou linha)
  const manual = String(req.body.emails || '')
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const email of manual) destinatarios.push({ email, nome: null });
  // condóminos selecionados (apenas do condomínio ativo)
  const ids = toArray(req.body.pessoas).map(Number);
  // Emails de condóminos do condomínio ativo: servem para decidir que link
  // segue no email (rota autenticada para quem tem conta; link temporário,
  // assinado e com validade limitada, para os restantes).
  const emailsCondominos = new Set();
  if (ids.length) {
    const pessoas = await Pessoa.findAll({ where: { id: { [Op.in]: ids }, email: { [Op.ne]: null }, condominio_id: req.condominioId } });
    for (const p of pessoas) {
      destinatarios.push({ email: p.email, nome: p.nome });
      emailsCondominos.add(String(p.email).trim().toLowerCase());
    }
  }

  // Anexo (cópia independente): descarrega o ficheiro do Drive quando disponível.
  let anexoBuffer = null;
  let anexoNome = null;
  if (documento.drive_file_id && drive.isConfigured(documento.condominio_id)) {
    try {
      anexoBuffer = await drive.descargarArquivo(documento.drive_file_id, documento.condominio_id);
      anexoNome = String(documento.nome || '').trim() || 'documento.pdf';
    } catch (err) {
      console.error('[documento-email] sem anexo:', err.message);
      anexoBuffer = null; // segue com link
    }
  }
  const comAnexo = Boolean(anexoBuffer);

  const cond = await getCondominio({ id: req.condominioId });
  const condNome = (cond && String(cond.designacao || '').trim()) || '';
  const adminNome = (cond && String(cond.administracao_nome || '').trim()) || '';
  const tipoDoc = ['convocatoria', 'recibo'].includes(documento.tipo) ? documento.tipo : 'documento';
  // Link do documento no email: NUNCA o link do fornecedor de armazenamento.
  // O acesso passa sempre pelo GesCondu (rota autenticada ou link temporário
  // emitido aqui, depois de o administrador autenticado pedir o envio).
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const notaManual = String(req.body.mensagem || '').trim();
  let enfileirados = 0;
  for (const dest of destinatarios) {
    const urlOnline = urlParaEmail({
      documento,
      baseUrl,
      destinatarioInterno: emailsCondominos.has(String(dest.email).trim().toLowerCase()),
    });
    const tpl = notaManual
      ? comporEmail('generico', {
          destinatarioNome: dest.nome || undefined,
          condominio: condNome,
          administracao: adminNome,
          titulo: documento.nome,
          mensagem: notaManual,
          urlOnline,
          urlTexto: 'Consultar documento',
        })
      : comporEmail(tipoDoc, {
          destinatarioNome: dest.nome || undefined,
          condominio: condNome,
          administracao: adminNome,
          nomeDocumento: documento.nome,
          urlOnline,
          anexo: comAnexo,
        });
    await enfileirarEmailFila({
      destinatario_email: dest.email,
      destinatario_nome: dest.nome || null,
      assunto: tpl.assunto,
      corpo: tpl.text,
      corpo_html: tpl.html,
      documento_id: documento.id,
      entidade_tipo: 'Documento',
      entidade_id: documento.id,
      condominioId: req.condominioId,
      userId: req.user.id,
      anexoNome: comAnexo ? anexoNome : null,
      anexoBuffer: comAnexo ? anexoBuffer : null,
    });
    enfileirados++;
  }
  await audit({
    userId: req.user.id,
    acao: 'enviar_documento_email',
    entidade: 'Documento',
    entidadeId: documento.id,
    detalhes: { destinatarios: destinatarios.length, comAnexo },
  }).catch(() => {});
  req.flash('success_msg', `Documento enfileirado para envio a ${enfileirados} destinatário(s).${comAnexo ? ' (com PDF em anexo)' : ' (link online; sem anexo — configure o Drive para anexar)'}`);
  res.redirect('/admin/documentos');
});

// ── Ficheiro do documento (acesso autorizado) ───────────────────────
// ÚNICO caminho para ver/descarregar o ficheiro de um documento. A verificação
// (sessão → utilizador → condomínio ativo → permissão sobre ESTE documento) é
// feita em helpers/documentos-acesso.js e o ficheiro é servido em streaming
// pelo backend, a partir do provedor de armazenamento do condomínio. Nenhum
// link do fornecedor (Drive/Dropbox/OneDrive) chega ao browser.
router.get('/documentos/:id/ficheiro', async (req, res) => {
  const autorizacao = await autorizarAcessoDocumento({ documentoId: req.params.id, req, area: 'gestao' });
  if (!autorizacao.ok) {
    // 401 sem sessão / 403 de outro condomínio ou sem permissão / 404 inexistente.
    return responderRecusa(res, autorizacao);
  }
  const disposicao = req.query.descarregar === '1' ? 'attachment' : 'inline';
  const servido = await servirDocumento({ documento: autorizacao.documento, req, res, disposicao, via: 'sessao' });
  if (!servido.ok && !res.headersSent) {
    return responderRecusa(res, servido);
  }
  return undefined;
});

module.exports = router;
