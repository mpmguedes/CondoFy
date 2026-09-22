// ═══════════════════════════════════════════════════════════════════
// A6 — Ata da assembleia: via de escrita do texto (`Assembleia.ata_texto`)
//
// O campo `ata_texto` é o CORPO da ata: é o que `helpers/pdf.js`
// (`gerarAtaPDF`) imprime em «Deliberações». Antes desta rota o campo era
// apenas LIDO — nenhuma rota o escrevia — e a ata saía sempre com
// «(sem conteúdo registado)».
//
// Este teste monta o ROUTER REAL (`routes/assembleias.js`) num servidor
// Express e faz pedidos HTTP a sério. As guardas são as REAIS
// (`helpers/tenant`, `helpers/suporte-allowlist`) — não são substituídas por
// duplos, senão estaríamos a testar os duplos. Só o que toca na BD/IO é
// substituído. Prova:
//   · isolamento  — um id de OUTRO condomínio não é encontrado e NÃO escreve;
//   · escrita     — o texto é gravado tal e qual + auditoria;
//   · vazio       — texto em branco volta ao estado «sem ata» (NULL);
//   · PDF         — a ata contém o texto guardado; sem texto, o marcador;
//   · autorização — papel `leitura` é recusado e NADA é escrito;
//   · suporte     — a rota de ESCRITA não é admissível ao suporte (allow-list).
//
// Utilização: node scripts/test-assembleias-ata.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const express = require('express');

const RAIZ = path.join(__dirname, '..');

// ── Estado mutável dos duplos ──────────────────────────────────────
// `PAPEL` é o papel do utilizador na associação ativa (o que `comPapel` lê).
let PAPEL = 'admin';

const auditorias = [];

// Assembleias: a 1 é do condomínio 1 (o ativo da sessão); a 2 é de OUTRO
// condomínio — existe na «BD», mas nunca pode ser alcançada por este pedido.
const ASSEMBLEIAS = {
  1: {
    id: 1,
    condominio_id: 1,
    numero: '2026/1',
    tipo: 'ordinaria',
    estado: 'realizada',
    data: '2026-09-04',
    hora: '21:00',
    local: 'Hall de entrada',
    ordem_trabalhos: null,
    ata_texto: null,
    agenda_itens: [],
    convocatoria_documento_id: null,
    ata_documento_id: null,
    update(patch) {
      Object.assign(this, patch);
      return Promise.resolve(this);
    },
  },
  2: {
    id: 2,
    condominio_id: 7, // ⛔ outro condomínio
    numero: '2026/9',
    tipo: 'ordinaria',
    estado: 'realizada',
    data: '2026-09-04',
    hora: '21:00',
    local: 'Sede de outro condomínio',
    ordem_trabalhos: null,
    ata_texto: null,
    agenda_itens: [],
    update(patch) {
      Object.assign(this, patch);
      return Promise.resolve(this);
    },
  },
};

const CONDOMINIO = {
  id: 1,
  designacao: 'Condomínio de Teste',
  morada: 'Rua do Teste, 1',
  codigo_postal: '1000-000',
  localidade: 'Lisboa',
  administracao_nome: 'Administração de Teste',
  logotipo: null,
  toJSON() {
    const { toJSON, ...resto } = this;
    return resto;
  },
};

// ── Duplos (só o que precisa de BD/IO) ─────────────────────────────
const stubs = {
  '../models': {
    // `comCondominioAtivo` → associação ATIVA com o papel de `PAPEL`.
    UserCondominio: {
      findOne: async () => ({ role: PAPEL, condominio_id: 1 }),
    },
    Condominio: { findByPk: async () => ({ id: 1, estado: 'ativo' }), findAll: async () => [] },
    // O stub HONRA o `where` — e só o que o `where` pede, como a BD faria.
    // ⛔ Se filtrasse por `condominio_id` mesmo quando a consulta o omite,
    // estaríamos a testar o STUB e não o isolamento da rota.
    Assembleia: {
      findOne: async ({ where }) => {
        const a = ASSEMBLEIAS[where.id];
        if (!a) return null;
        if (where.condominio_id != null && Number(a.condominio_id) !== Number(where.condominio_id)) {
          return null;
        }
        return a;
      },
    },
    AssembleiaParticipante: { findAll: async () => [], destroy: async () => 0, create: async () => ({}) },
    AgendaItem: { findAll: async () => [], findOne: async () => null },
    Fracao: { findAll: async () => [] },
    Pessoa: { findAll: async () => [] },
    Documento: { findAll: async () => [], findOne: async () => null },
  },
  '../helpers/audit': {
    audit: async (evento) => {
      auditorias.push(evento);
      return {};
    },
  },
  '../helpers/condominio': {
    getCondominio: async () => CONDOMINIO,
    clearCondominioCache: () => {},
  },
  '../helpers/storage': {
    isConfigured: () => false,
    pastaParaDocumento: async () => 'pasta',
    uploadArquivo: async () => ({ localizador: 'gd:x', tamanho: 1 }),
    enviarParaDrive: async () => ({ localizador: 'gd:x', tamanho: 1 }),
  },
  '../helpers/cabecalhos-ficheiro': {
    disposicao: (nome) => `inline; filename="${nome}"`,
  },
  // A deliberação por ponto não é o alvo deste teste; o módulo real precisa da
  // BD. As rotas exercitadas não as chamam.
  '../helpers/fcr-deliberacoes': {
    validarDeliberacao: () => ({ ok: true }),
    utilizacaoPorItemC: async () => ({}),
    temMovimentosAssociados: async () => false,
    valorDespesasDeliberacaoC: async () => 0,
    ESTADOS_ASSEMBLEIA_SEM_DELIBERACAO: [],
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// ── Módulos REAIS ──────────────────────────────────────────────────
const tenant = require('../helpers/tenant');
const allowlist = require('../helpers/suporte-allowlist');
const router = require('../routes/assembleias');

// ── App de teste ───────────────────────────────────────────────────
const UTILIZADOR = { id: 1, nome: 'Gestor', email: 'gestor@exemplo.pt', role_global: null };

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = UTILIZADOR;
  req.session = { condominio_ativo_id: 1 };
  req.flash = () => req;
  res.locals.user = UTILIZADOR;
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  next();
});
app.use('/admin', router);
app.use((err, req, res, next) => res.status(500).send(`ERRO_NO_HANDLER: ${err.message}`));

function pedir(metodo, caminho, corpo = null) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const dados = corpo ? new URLSearchParams(corpo).toString() : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: servidor.address().port,
          path: caminho,
          method: metodo,
          headers: dados
            ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) }
            : {},
        },
        (res) => {
          const partes = [];
          res.on('data', (c) => partes.push(c));
          res.on('end', () => {
            servidor.close();
            resolve({
              status: res.statusCode,
              location: res.headers.location || null,
              buffer: Buffer.concat(partes),
            });
          });
        }
      );
      req.on('error', (e) => {
        servidor.close();
        reject(e);
      });
      if (dados) req.write(dados);
      req.end();
    });
  });
}

// ── Texto extraído de um PDF (fluxos comprimidos + strings hex) ────
// O PDFKit escreve o texto como strings HEX dentro de arrays `TJ`, com
// ajustes de kerning pelo meio: `[<486f6c61> -25 <21> 0] TJ`. Concatenar
// todos os hex por ordem de fluxo reconstrói o texto como ele sai na página.
function textoDoPdf(buffer) {
  const bruto = buffer.toString('latin1');
  let texto = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(bruto))) {
    const dados = Buffer.from(m[1], 'latin1');
    let fluxo;
    try {
      fluxo = zlib.inflateSync(dados).toString('latin1');
    } catch {
      fluxo = dados.toString('latin1');
    }
    for (const hex of fluxo.match(/<([0-9A-Fa-f]{2,})>/g) || []) {
      texto += Buffer.from(hex.slice(1, -1), 'hex').toString('latin1');
    }
    for (const lit of fluxo.match(/\((?:\\.|[^\\()])*\)/g) || []) {
      texto += lit.slice(1, -1);
    }
  }
  return texto;
}

const MARCADOR = 'MARCADOR-DE-ATA-1234';

async function main() {
  // ── 1. Estrutura: a rota nova está ATRÁS das guardas do router ────
  assert.strictEqual(router.stack[0].handle, tenant.comCondominioAtivo, 'o router começa pelo condomínio ativo');
  const guards = router.stack.filter((l) => !l.route);
  assert.strictEqual(guards.length, 3, 'o router mantém as 3 guardas de `use` (ativo + suporte + papel)');
  assert.strictEqual(guards[2].handle.name, 'guardPapel', 'a última guarda é a de papel');
  const rota = router.stack.find((l) => l.route && l.route.path === '/assembleias/:id/ata/texto');
  assert.ok(rota, 'a rota de escrita do texto da ata existe');
  assert.strictEqual(rota.route.methods.post, true, 'é POST (nunca um GET que escreve)');
  assert.strictEqual(rota.route.stack.length, 1, 'a rota tem apenas o handler (as guardas vêm do router)');
  console.log('  ✓ a rota de escrita herda as guardas do router (não há caminho paralelo)');

  // ── 2. Isolamento: um id de OUTRO condomínio não é encontrado ─────
  // (o `condominio_id` do `where` vem da SESSÃO, nunca do URL)
  PAPEL = 'admin';
  auditorias.length = 0;
  let r = await pedir('POST', '/admin/assembleias/2/ata/texto', { ata_texto: MARCADOR });
  assert.strictEqual(r.status, 302, 'assembleia de outro condomínio: redireciona');
  assert.strictEqual(r.location, '/admin/assembleias', 'assembleia de outro condomínio: tratada como inexistente');
  assert.strictEqual(ASSEMBLEIAS[2].ata_texto, null, '⛔ NADA foi escrito na assembleia de outro condomínio');
  assert.strictEqual(auditorias.length, 0, 'nem sequer há auditoria de uma escrita que não aconteceu');
  console.log('  ✓ isolamento: a assembleia de outro condomínio não é alcançável nem escrita');

  // ── 3. Escrita: o texto é gravado tal e qual + auditoria ──────────
  const TEXTO = `${MARCADOR}\nAprovada a substituição do elevador por 12.345,00 EUR.`;
  auditorias.length = 0;
  r = await pedir('POST', '/admin/assembleias/1/ata/texto', { ata_texto: TEXTO });
  assert.strictEqual(r.status, 302, 'escrita: redireciona');
  assert.strictEqual(r.location, '/admin/assembleias/1', 'escrita: volta ao detalhe da assembleia');
  assert.strictEqual(ASSEMBLEIAS[1].ata_texto, TEXTO, 'o texto é gravado exatamente como foi escrito');
  const evento = auditorias.find((a) => a.acao === 'registar_ata_texto');
  assert.ok(evento, 'a escrita é auditada');
  assert.strictEqual(evento.entidade, 'Assembleia', 'auditoria: entidade');
  assert.strictEqual(evento.entidadeId, 1, 'auditoria: id da assembleia');
  assert.strictEqual(evento.detalhes.condominioId, 1, 'auditoria: condomínio ativo');
  console.log('  ✓ escrita: texto gravado e auditado');

  // ── 4. PDF com texto: a ata IMPRIME o texto guardado ──────────────
  r = await pedir('GET', '/admin/assembleias/1/ata');
  assert.strictEqual(r.status, 200, 'PDF da ata: 200');
  assert.strictEqual(r.buffer.slice(0, 5).toString(), '%PDF-', 'PDF da ata: ficheiro PDF válido');
  const textoPdf = textoDoPdf(r.buffer);
  assert.ok(textoPdf.includes(MARCADOR), '⛔ o PDF da ata contém o texto guardado (não sai vazio)');
  assert.ok(!textoPdf.includes('sem conte'), 'com ata escrita, o PDF não mostra o marcador de vazio');
  console.log('  ✓ PDF da ata contém o texto guardado');

  // ── 5. Vazio: texto em branco volta ao estado «sem ata» (NULL) ────
  auditorias.length = 0;
  r = await pedir('POST', '/admin/assembleias/1/ata/texto', { ata_texto: '   \n  ' });
  assert.strictEqual(r.status, 302, 'vazio: redireciona');
  assert.strictEqual(ASSEMBLEIAS[1].ata_texto, null, 'texto em branco fica NULL (um só estado para «sem ata»)');
  assert.strictEqual(auditorias[0].detalhes.caracteres, 0, 'auditoria regista 0 caracteres');
  console.log('  ✓ vazio: um único estado «sem ata» (NULL)');

  // ── 6. Comportamento definido quando NÃO há ata ───────────────────
  r = await pedir('GET', '/admin/assembleias/1/ata');
  assert.strictEqual(r.status, 200, 'sem ata: o PDF continua a gerar-se');
  const semAta = textoDoPdf(r.buffer);
  assert.ok(semAta.includes('sem conte'), 'sem ata, o PDF mostra o marcador definido («sem conteúdo registado»)');
  assert.ok(!semAta.includes(MARCADOR), 'sem ata, o texto anterior já não aparece');
  console.log('  ✓ sem ata: comportamento definido (marcador, PDF não vazio)');

  // ── 7. Autorização: o papel `leitura` não escreve ─────────────────
  PAPEL = 'leitura';
  auditorias.length = 0;
  ASSEMBLEIAS[1].ata_texto = null;
  r = await pedir('POST', '/admin/assembleias/1/ata/texto', { ata_texto: MARCADOR });
  assert.strictEqual(r.status, 302, 'leitura: recusado');
  assert.strictEqual(r.location, '/', 'leitura: recusado pela guarda de papel (destino do painel)');
  assert.strictEqual(ASSEMBLEIAS[1].ata_texto, null, '⛔ leitura: NADA foi escrito');
  assert.strictEqual(auditorias.length, 0, 'leitura: nenhuma auditoria de escrita');
  console.log('  ✓ autorização: o papel leitura é recusado sem efeito secundário');

  // ── 8. Suporte: a rota de ESCRITA não é admissível ────────────────
  // A allow-list do suporte é de LEITURA e por caminho EXPLÍCITO.
  assert.strictEqual(
    allowlist.caminhoAdmitido('assembleias', '/assembleias/1/ata/texto'),
    false,
    '⛔ a rota de escrita do texto da ata NÃO está na allow-list do suporte'
  );
  assert.strictEqual(
    allowlist.caminhoAdmitido('assembleias', '/assembleias/1'),
    true,
    'o detalhe (leitura) continua admitido ao suporte'
  );
  console.log('  ✓ suporte: a escrita da ata não é admitida (allow-list é de leitura)');

  PAPEL = 'admin';
  console.log('✓ Todos os testes da ata da assembleia passaram.');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
