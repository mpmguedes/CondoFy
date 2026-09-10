// ═══════════════════════════════════════════════════════════════════
// Acesso autorizado a documentos (sem rede/BD)
//
// Fixa o invariante de segurança:
//   Utilizador → Condomínio → Documento, com sessão válida, e o ficheiro
//   servido SEMPRE pelo backend (nunca por link do provedor de armazenamento).
//
// Verifica:
//  · a matriz de autorização (sem sessão, sem condomínio, outro condomínio,
//    condómino com e sem disponibilização, gestor/admin);
//  · as cabeçalhos da resposta (privado, sem cache, sem sniffer, sandbox);
//  · que nenhum URL do fornecedor é exposto nas vistas de documentos;
//  · os links temporários (assinatura, validade, adulteração, desativação).
// Utilização: node scripts/test-documentos-acesso.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

// ── Duplos de teste ─────────────────────────────────────────────────
const documentos = new Map(); // id → documento
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    Documento: {
      findOne: async ({ where }) => {
        const d = documentos.get(Number(where.id));
        if (!d) return null;
        // Reproduz o filtro por condomínio da query real — apenas quando a
        // consulta o pede (a sonda de existência não filtra).
        if (where.condominio_id !== undefined && Number(where.condominio_id) !== Number(d.condominio_id)) return null;
        return d;
      },
    },
  },
};
const auditPath = require.resolve('../helpers/audit');
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true, children: [], paths: [],
  exports: { audit: async () => ({}), auditSafe: async () => ({}) },
};

const acesso = require('../helpers/documentos-acesso');
const storage = require('../helpers/storage');

// Ficheiro servido pelo provedor (duplo): devolve bytes e regista o acesso.
const servidos = [];
storage.abrirFluxo = async (localizador, condominioId) => {
  servidos.push({ localizador, condominioId });
  const fluxo = new PassThrough();
  fluxo.end(Buffer.from('%PDF-1.4 documento de teste'));
  return { fluxo, tamanho: 27, nome: 'doc.pdf' };
};
storage.isConfiguredPara = async () => true;

// Duplo de resposta HTTP, com as mesmas capacidades usadas por servirDocumento.
function respostaDuplo() {
  const res = new PassThrough();
  res.headers = {};
  res.headersSent = false;
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  const originalEnd = res.end.bind(res);
  res.end = (...args) => { res.headersSent = true; return originalEnd(...args); };
  res.status = () => res;
  res.type = () => res;
  res.send = (b) => { res.corpo = b; res.headersSent = true; originalEnd(); return res; };
  return res;
}

async function servirCom(documento, ctx) {
  const res = respostaDuplo();
  const pedacos = [];
  res.on('data', (d) => pedacos.push(d));
  const terminado = new Promise((resolve) => res.on('end', resolve));
  const r = await acesso.servirDocumento({ documento, res, req: ctx, disposicao: 'inline', via: 'teste' });
  if (r.ok) await terminado;
  return { resultado: r, res, corpo: Buffer.concat(pedacos).toString() };
}

// ── 1. Matriz de autorização ────────────────────────────────────────
async function testarAutorizacao() {
  documentos.set(10, { id: 10, condominio_id: 1, nome: 'Ata 2026.pdf', drive_file_id: 'gd-id-10', mime_type: 'application/pdf', disponivel_condominos: false });
  documentos.set(11, { id: 11, condominio_id: 1, nome: 'Regulamento.pdf', drive_file_id: 'dbx:id:11', mime_type: 'application/pdf', disponivel_condominos: true });
  documentos.set(20, { id: 20, condominio_id: 2, nome: 'Documento do outro condomínio.pdf', drive_file_id: 'gd-id-20', mime_type: 'application/pdf', disponivel_condominos: true });

  const reqAdmin = { user: { id: 1 }, isAuthenticated: () => true, condominioId: 1, papelCondominio: 'admin' };
  const reqGestor = { user: { id: 2 }, isAuthenticated: () => true, condominioId: 1, papelCondominio: 'gestor' };
  const reqCondomino = { user: { id: 3 }, isAuthenticated: () => true, condominioId: 1, papelCondominio: 'leitura' };

  // 1.1 Sem sessão
  for (const req of [null, {}, { user: null }, { user: { id: 9 }, isAuthenticated: () => false }]) {
    const r = await acesso.autorizarAcessoDocumento({ documentoId: 10, req, area: 'gestao' });
    assert.strictEqual(r.ok, false, 'sem sessão → recusado');
    assert.strictEqual(r.motivo, acesso.MOTIVO.SEM_SESSAO, 'motivo: sem sessão');
  }

  // 1.2 Sessão sem condomínio ativo
  const rSemCond = await acesso.autorizarAcessoDocumento({ documentoId: 10, req: { user: { id: 9 }, isAuthenticated: () => true }, area: 'gestao' });
  assert.strictEqual(rSemCond.motivo, acesso.MOTIVO.SEM_CONDOMINIO, 'sem condomínio ativo → recusado');

  // 1.3 Gestor/admin veem todos os documentos do SEU condomínio
  for (const req of [reqAdmin, reqGestor]) {
    const ok = await acesso.autorizarAcessoDocumento({ documentoId: 10, req, area: 'gestao' });
    assert.strictEqual(ok.ok, true, `${req.papelCondominio}: pode ver documento não disponibilizado`);
    assert.strictEqual(ok.documento.id, 10, 'documento devolvido');
    assert.strictEqual(ok.condominioId, 1, 'condomínio da autorização vem da sessão');
  }

  // 1.4 Documento de OUTRO condomínio: nunca, mesmo com admin e mesmo com
  // disponivel_condominos = true (isolamento multi-tenant) — 403 Forbidden.
  for (const req of [reqAdmin, reqGestor, reqCondomino]) {
    const r = await acesso.autorizarAcessoDocumento({ documentoId: 20, req, area: 'gestao' });
    assert.strictEqual(r.ok, false, `${req.papelCondominio}: documento de outro condomínio recusado`);
    assert.strictEqual(r.motivo, acesso.MOTIVO.OUTRO_CONDOMINIO, 'motivo: outro condomínio');
    assert.strictEqual(acesso.HTTP[r.motivo], 403, 'outro condomínio → 403 Forbidden');
    assert.ok(!/outro condomínio/i.test(r.mensagem), 'mensagem não revela o condomínio alheio');
    assert.strictEqual(r.mensagem, acesso.MENSAGENS[acesso.MOTIVO.NAO_ENCONTRADO], 'mensagem igual à de documento inexistente');
  }

  // 1.4.1 Documento que não existe mesmo → 404 (não se confunde com 403).
  const rInexistente = await acesso.autorizarAcessoDocumento({ documentoId: 9999, req: reqAdmin, area: 'gestao' });
  assert.strictEqual(rInexistente.motivo, acesso.MOTIVO.NAO_ENCONTRADO, 'documento inexistente');
  assert.strictEqual(acesso.HTTP[rInexistente.motivo], 404, 'inexistente → 404');

  // 1.4.2 Adulteração de id pelo utilizador autorizado: 123 (seu) → 124 (de
  // outro condomínio) tem de resultar em 403 e nunca entregar o documento.
  documentos.set(123, { id: 123, condominio_id: 1, nome: 'Do meu condomínio.pdf', drive_file_id: 'gd-123', mime_type: 'application/pdf', disponivel_condominos: false });
  documentos.set(124, { id: 124, condominio_id: 2, nome: 'De outro condomínio.pdf', drive_file_id: 'gd-124', mime_type: 'application/pdf', disponivel_condominos: false });
  const meu = await acesso.autorizarAcessoDocumento({ documentoId: 123, req: reqAdmin, area: 'gestao' });
  assert.strictEqual(meu.ok, true, 'documento do próprio condomínio autorizado');
  const adulterado = await acesso.autorizarAcessoDocumento({ documentoId: 124, req: reqAdmin, area: 'gestao' });
  assert.strictEqual(adulterado.ok, false, 'id adulterado para outro condomínio é recusado');
  assert.strictEqual(acesso.HTTP[adulterado.motivo], 403, 'id adulterado → 403');

  // 1.5 Condómino: só documentos disponibilizados
  const rCondNaoDisp = await acesso.autorizarAcessoDocumento({ documentoId: 10, req: reqCondomino, area: 'condomino' });
  assert.strictEqual(rCondNaoDisp.motivo, acesso.MOTIVO.SEM_PERMISSAO, 'condómino sem disponibilização → recusado');
  const rCondDisp = await acesso.autorizarAcessoDocumento({ documentoId: 11, req: reqCondomino, area: 'condomino' });
  assert.strictEqual(rCondDisp.ok, true, 'condómino pode ver documento disponibilizado');

  // 1.6 Ids inválidos
  for (const id of ['abc', '', null, 0, -1, undefined]) {
    const r = await acesso.autorizarAcessoDocumento({ documentoId: id, req: reqAdmin, area: 'gestao' });
    assert.strictEqual(r.ok, false, `id inválido (${String(id)}) recusado`);
  }
}

// ── 2. Serviço do ficheiro ──────────────────────────────────────────
async function testarServicoDeFicheiro() {
  const req = { user: { id: 1 }, isAuthenticated: () => true, condominioId: 1, papelCondominio: 'admin' };
  const doc = documentos.get(10);

  const { resultado, res, corpo } = await servirCom(doc, req);
  assert.strictEqual(resultado.ok, true, 'documento servido');
  assert.strictEqual(servidos.length, 1, 'provedor consultado uma vez');
  assert.strictEqual(servidos[0].localizador, 'gd-id-10', 'localizador entregue ao provedor');
  assert.strictEqual(servidos[0].condominioId, 1, 'condomínio do documento entregue ao provedor');
  assert.ok(corpo.startsWith('%PDF'), 'conteúdo do ficheiro servido ao cliente');

  // Cabeçalhos: privado, sem cache, sem adivinhação de tipo, sem execução.
  assert.strictEqual(res.headers['content-type'], 'application/pdf', 'content-type do documento');
  assert.ok(String(res.headers['content-disposition']).startsWith('inline;'), 'disposição inline');
  assert.ok(/no-store/.test(res.headers['cache-control']) && /private/.test(res.headers['cache-control']), 'sem cache partilhada');
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', 'nosniff');
  assert.ok(/sandbox/.test(res.headers['content-security-policy']), 'documento em sandbox');

  // Nenhum URL/ID do provedor é exposto ao cliente.
  const cabecalhos = JSON.stringify(res.headers);
  assert.ok(!/drive\.google|dropbox|onedrive|1drv|dbx:/.test(cabecalhos), 'cabeçalhos sem referências ao fornecedor');

  // Documento sem ficheiro guardado
  const semFicheiro = { id: 30, condominio_id: 1, nome: 'Só referência externa', drive_file_id: null };
  const r2 = await servirCom(semFicheiro, req);
  assert.strictEqual(r2.resultado.ok, false, 'documento sem ficheiro não é servido');
  assert.strictEqual(r2.resultado.motivo, acesso.MOTIVO.SEM_FICHEIRO, 'motivo: sem ficheiro');

  // Nome de ficheiro saneado (sem aspas/CRLF que quebrariam o cabeçalho)
  const comNomeMau = { id: 31, condominio_id: 1, nome: 'a"\r\nInjected: 1.pdf', drive_file_id: 'gd-31', mime_type: 'application/pdf' };
  const r3 = await servirCom(comNomeMau, req);
  const disp = String(r3.res.headers['content-disposition']);
  assert.ok(!/[\r\n]/.test(disp), 'sem CRLF no Content-Disposition');
  assert.ok(!/a"Injected/.test(disp), 'nome do ficheiro saneado');
}

// ── 3. URLs internas e links em email ───────────────────────────────
function testarLinks() {
  const interno = documentos.get(11);
  assert.strictEqual(acesso.urlInterna(interno, { area: 'condomino' }), '/condomino/documentos/11/ficheiro', 'rota do condómino');
  assert.strictEqual(acesso.urlInterna(interno, { area: 'gestao' }), '/admin/documentos/11/ficheiro', 'rota da gestão');
  assert.strictEqual(acesso.urlInterna({ id: 1, drive_file_id: null }), null, 'sem ficheiro → sem link interno');

  process.env.DOC_LINK_SECRET = 'segredo-de-teste';
  delete process.env.DOC_LINK_TEMPORARIO;

  // Destinatário com conta: rota autenticada (exige sessão).
  const paraCondomino = acesso.urlParaEmail({ documento: interno, baseUrl: 'https://gescondu.xyz', destinatarioInterno: true });
  assert.strictEqual(paraCondomino, 'https://gescondu.xyz/condomino/documentos/11/ficheiro', 'condómino recebe rota autenticada');
  assert.ok(!/drive\.google|dropbox|onedrive/.test(paraCondomino), 'sem link do fornecedor');

  // Destinatário externo: link temporário assinado, do próprio GesCondu.
  const paraExterno = acesso.urlParaEmail({ documento: interno, baseUrl: 'https://gescondu.xyz', destinatarioInterno: false });
  assert.ok(paraExterno.startsWith('https://gescondu.xyz/documentos/ficheiro/'), 'externo recebe link temporário do GesCondu');
  const verificado = acesso.verificarLinkTemporario(paraExterno.split('/documentos/ficheiro/')[1]);
  assert.strictEqual(verificado.ok, true, 'token válido');
  assert.strictEqual(verificado.documentoId, 11, 'token ligado ao documento');
  assert.strictEqual(verificado.condominioId, 1, 'token ligado ao condomínio');

  // Documento apenas com referência externa: mantém o URL indicado pelo administrador.
  const externo = acesso.urlParaEmail({ documento: { id: 40, condominio_id: 1, drive_file_id: null, url: 'https://exemplo.pt/ficha.pdf' } });
  assert.strictEqual(externo, 'https://exemplo.pt/ficha.pdf', 'referência externa preservada');
}

// ── 4. Links temporários: validade, adulteração, desativação ────────
function testarLinksTemporarios() {
  process.env.DOC_LINK_SECRET = 'segredo-de-teste';
  process.env.DOC_LINK_TEMPORARIO = '1';

  const curto = acesso.criarLinkTemporario({ documentoId: 11, condominioId: 1, validadeSegundos: 60, baseUrl: 'https://gescondu.xyz' });
  assert.ok(curto && curto.url, 'link temporário emitido');
  assert.strictEqual(acesso.verificarLinkTemporario(curto.token).ok, true, 'link válido dentro da validade');

  // Expirado
  const expirado = acesso.criarLinkTemporario({ documentoId: 11, condominioId: 1, validadeSegundos: 60 });
  const partes = expirado.token.split('.');
  partes[2] = String(Math.floor(Date.now() / 1000) - 10);
  const adulteradoExp = `${partes[0]}.${partes[1]}.${partes[2]}.${partes[3]}`;
  assert.strictEqual(acesso.verificarLinkTemporario(adulteradoExp).ok, false, 'link expirado recusado');
  assert.strictEqual(acesso.verificarLinkTemporario(adulteradoExp).motivo, 'invalido', 'alterar a validade invalida a assinatura');

  // Adulteração do documento/condomínio (sem reassinar) é detetada.
  const base = acesso.criarLinkTemporario({ documentoId: 11, condominioId: 1 });
  const p = base.token.split('.');
  const outroDoc = `${10}.${p[1]}.${p[2]}.${p[3]}`;
  assert.strictEqual(acesso.verificarLinkTemporario(outroDoc).ok, false, 'documento trocado sem assinatura válida é recusado');
  const outroCond = `${p[0]}.${2}.${p[2]}.${p[3]}`;
  assert.strictEqual(acesso.verificarLinkTemporario(outroCond).ok, false, 'condomínio trocado sem assinatura válida é recusado');
  assert.strictEqual(acesso.verificarLinkTemporario('lixo').ok, false, 'token inválido recusado');
  assert.strictEqual(acesso.verificarLinkTemporario('').ok, false, 'token vazio recusado');

  // Sem segredo configurado os links temporários ficam desativados (fail-safe).
  delete process.env.DOC_LINK_SECRET;
  delete process.env.SESSION_SECRET;
  assert.strictEqual(acesso.linksTemporariosAtivos(), false, 'sem segredo → desativados');
  assert.strictEqual(acesso.criarLinkTemporario({ documentoId: 11, condominioId: 1 }), null, 'sem segredo não se emite link');
  const semLink = acesso.urlParaEmail({ documento: documentos.get(11), baseUrl: 'https://x.pt', destinatarioInterno: false });
  assert.strictEqual(semLink, null, 'externo sem link temporário → email sem link');

  // Desativação explícita por variável de ambiente.
  process.env.DOC_LINK_SECRET = 'segredo-de-teste';
  process.env.DOC_LINK_TEMPORARIO = '0';
  assert.strictEqual(acesso.criarLinkTemporario({ documentoId: 11, condominioId: 1 }), null, 'DOC_LINK_TEMPORARIO=0 desativa');
  delete process.env.DOC_LINK_TEMPORARIO;
}

// ── 5. Vistas: nenhum link direto do fornecedor ─────────────────────
function testarVistas() {
  const alvos = [
    'views/condomino/documentos.handlebars',
    'views/condomino/dashboard.handlebars',
    'views/condomino/assembleia.handlebars',
    'views/admin/documentos/listar.handlebars',
  ];
  for (const f of alvos) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/href="\{\{url\}\}"/.test(src), `${f}: já não liga diretamente a {{url}}`);
    assert.ok(!/href="\{\{[a-zA-Z]+\.url\}\}"/.test(src), `${f}: já não liga a URLs do fornecedor`);
    assert.ok(/urlDocumento/.test(src), `${f}: usa a rota interna de documentos`);
  }
  // As rotas internas existem em ambos os módulos.
  const rotasDocumentos = fs.readFileSync(path.join(__dirname, '..', 'routes/documentos.js'), 'utf8');
  const rotasCondomino = fs.readFileSync(path.join(__dirname, '..', 'routes/condomino.js'), 'utf8');
  assert.ok(rotasDocumentos.includes("'/documentos/:id/ficheiro'"), 'rota da gestão registada');
  assert.ok(rotasCondomino.includes("'/documentos/:id/ficheiro'"), 'rota do condómino registada');
  assert.ok(rotasDocumentos.includes('autorizarAcessoDocumento') && rotasCondomino.includes('autorizarAcessoDocumento'), 'rotas usam a camada de autorização');
}

// ── 6. Códigos HTTP das recusas (401/403/404/502/503) ───────────────
function testarCodigosHttp() {
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.SEM_SESSAO], 401, 'sem sessão → 401');
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.SEM_CONDOMINIO], 401, 'sem condomínio ativo → 401');
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.SEM_PERMISSAO], 403, 'sem permissão → 403');
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.OUTRO_CONDOMINIO], 403, 'outro condomínio → 403');
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.NAO_ENCONTRADO], 404, 'inexistente → 404');
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.SEM_FICHEIRO], 404, 'sem ficheiro → 404');
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.LIGACAO_INVALIDA], 502, 'falha do fornecedor → 502');
  assert.strictEqual(acesso.HTTP[acesso.MOTIVO.PROVEDOR_INDISPONIVEL], 503, 'armazenamento em baixo → 503');

  // A resposta de recusa nunca entrega conteúdo e é privada.
  const cabecalhos = {};
  const res = {
    headersSent: false,
    setHeader: (k, v) => { cabecalhos[k] = v; },
    status(c) { this.codigo = c; return this; },
    type() { return this; },
    send(b) { this.corpo = b; return this; },
  };
  const codigo = acesso.responderRecusa(res, { motivo: acesso.MOTIVO.OUTRO_CONDOMINIO, mensagem: acesso.MENSAGENS[acesso.MOTIVO.OUTRO_CONDOMINIO] });
  assert.strictEqual(codigo, 403, 'resposta de recusa devolve 403');
  assert.strictEqual(res.codigo, 403, 'estado definido na resposta');
  assert.strictEqual(res.corpo, 'Documento não encontrado.', 'mensagem de recusa apresentada');
  assert.strictEqual(cabecalhos['Cache-Control'], 'private, no-store', 'recusa sem cache partilhada');
  assert.ok(!/drive\.google|dropbox|onedrive/.test(String(res.corpo)), 'recusa sem referências ao fornecedor');
}

// ── 6.1 Falha do fornecedor (502): explicação para quem gere o condomínio e
// mensagem genérica para o condómino. Nenhuma mensagem expõe ids, tokens,
// credenciais nem o nome do fornecedor.
async function testarFalhaDoFornecedor() {
  const reqAdminCtx = { user: { id: 1 }, isAuthenticated: () => true, condominioId: 1, papelCondominio: 'admin' };
  const reqCondominoCtx = { user: { id: 3 }, isAuthenticated: () => true, condominioId: 1, papelCondominio: 'condomino' };
  const abrirReal = storage.abrirFluxo;
  try {
    const falhas = [
      { erro: 'invalid_grant: Token has been expired or revoked.', esperado: /autorização da conta foi revogada/i },
      { erro: 'File not found: 1AbC-xyz.', esperado: /já não existe na conta ligada/i },
      { erro: 'The user does not have sufficient permissions for this file.', esperado: /não tem acesso a este ficheiro/i },
      { erro: 'User Rate Limit Exceeded', esperado: /limite de pedidos/i },
    ];
    for (const f of falhas) {
      storage.abrirFluxo = async () => { throw new Error(f.erro); };
      const doc = documentos.get(10);
      const admin = await servirCom(doc, reqAdminCtx);
      assert.strictEqual(admin.resultado.ok, false, `${f.erro}: documento não é servido`);
      assert.strictEqual(admin.resultado.motivo, acesso.MOTIVO.LIGACAO_INVALIDA, `${f.erro}: motivo ligação inválida`);
      assert.strictEqual(acesso.HTTP[admin.resultado.motivo], 502, `${f.erro}: código 502`);
      assert.ok(f.esperado.test(admin.resultado.mensagem), `${f.erro}: explicação útil para o admin (${admin.resultado.mensagem})`);
      assert.ok(!/1AbC-xyz|invalid_grant|Rate Limit/i.test(admin.resultado.mensagem), `${f.erro}: sem detalhes técnicos crus`);
      assert.ok(!/drive\.google|dropbox|onedrive|access_token/i.test(admin.resultado.mensagem), `${f.erro}: sem fornecedor nem credenciais na mensagem`);

      // Condómino (área do condómino): mensagem genérica, sem diagnóstico.
      const cond = await servirCom(doc, reqCondominoCtx);
      assert.strictEqual(cond.resultado.mensagem, acesso.MENSAGENS[acesso.MOTIVO.LIGACAO_INVALIDA], `${f.erro}: condómino recebe a mensagem genérica`);
    }

    // Serviço desligado → 503 (e não 502), como antes.
    storage.abrirFluxo = async () => { throw new Error('File not found: 1AbC-xyz.'); };
    const ligadoAntes = storage.isConfiguredPara;
    storage.isConfiguredPara = async () => false;
    const r503 = await servirCom(documentos.get(10), reqAdminCtx);
    assert.strictEqual(r503.resultado.motivo, acesso.MOTIVO.PROVEDOR_INDISPONIVEL, 'serviço desligado → armazenamento indisponível');
    assert.strictEqual(acesso.HTTP[r503.resultado.motivo], 503, 'serviço desligado → 503');
    storage.isConfiguredPara = ligadoAntes;

    // A explicação é reutilizável pelo diagnóstico por linha de comando.
    assert.match(acesso.explicarFalhaDoFornecedor('invalid_grant'), /revogada/i, 'explicação reutilizável');
    assert.strictEqual(acesso.explicarFalhaDoFornecedor('erro estranho'), null, 'sem explicação quando não se reconhece a causa');
  } finally {
    storage.abrirFluxo = abrirReal;
  }
}

(async () => {
  await testarAutorizacao();
  await testarServicoDeFicheiro();
  testarLinks();
  testarLinksTemporarios();
  testarCodigosHttp();
  await testarFalhaDoFornecedor();
  testarVistas();
  console.log('✓ Testes do acesso autorizado a documentos passaram (sem rede/BD).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
