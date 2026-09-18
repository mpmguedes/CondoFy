#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Testes da ARQUITETURA DE AUTORIZAÇÃO — sem base de dados.
//
// Prova, nos cenários A–G, que:
//   · `users.role` (coluna LEGADO) deixou de decidir autorização, destino
//     pós-login e interface;
//   · quem decide é o papel no condomínio ativo (`utilizador_condominios.role`);
//   · o privilégio global (`users.role_global`) é um eixo separado;
//   · o namespace `/admin` é exclusivamente o backoffice do condomínio e
//     `/global` é a administração global, com shim de compatibilidade para
//     os antigos `/admin/global*`;
//   · já não existe o ciclo `/ → /admin → / → …`.
//
// Utilização: node scripts/test-autorizacao-arquitetura.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const Sequelize = require('sequelize');
const Handlebars = require('handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => require('fs').readFileSync(path.join(RAIZ, rel), 'utf8');

let nTestes = 0;
const feito = (nome) => {
  nTestes += 1;
  console.log(`  ✓ ${nome}`);
};
const titulo = (t) => console.log(`\n── ${t}`);

// ─────────────────────────────────────────────────────────────────────
// 1. DECISÃO PURA DO DESTINO — um bloco de testes por cenário.
//    `tenant.destinoInicial` é a única fonte do destino pós-login.
// ─────────────────────────────────────────────────────────────────────
titulo('Destino pós-login (tenant.destinoInicial)');

// Carregar o tenant sem BD: os modelos são substituídos por stubs. O
// `helpers/tenant.js` só usa `findOne`/`findAll`, pelo que os stubs chegam.
const modelsReais = require.resolve(path.join(RAIZ, 'models'));
require.cache[modelsReais] = {
  id: modelsReais,
  filename: modelsReais,
  loaded: true,
  exports: {
    UserCondominio: { findOne: async () => null, findAll: async () => [] },
    Condominio: { findOne: async () => null, findByPk: async () => null },
    User: { findByPk: async () => null },
  },
};
const tenant = require(path.join(RAIZ, 'helpers/tenant'));
const { destinoAposLogin } = require(path.join(RAIZ, 'routes', 'index'));

const COND = (id, role) => ({ id, role, designacao: `Condomínio ${id}` });
const USER = (over = {}) => ({ id: 1, role: 'condomino', role_global: null, ...over });

// ── A. Admin de condomínio (users.role='admin', uc.role='admin') ────
let d = destinoAposLogin({ meus: [COND(5, 'admin')], ativo: 5, user: USER({ role: 'admin' }) });
assert.strictEqual(d.redirecionar, '/admin', 'A: admin → /admin');
feito('A. admin de condomínio → /admin (sem ciclo)');

// O MESMO resultado quando o legado diz outra coisa: é esta a correção —
// `users.role` não participa na decisão.
d = destinoAposLogin({ meus: [COND(5, 'admin')], ativo: 5, user: USER({ role: 'condomino' }) });
assert.strictEqual(d.redirecionar, '/admin', 'A: uc.role admin decide, users.role é irrelevante');
feito('A. users.role=condomino + uc.role=admin → /admin (legado ignorado)');

// ── B. Gestor de condomínio (users.role='condomino', uc.role='gestor') ─
d = destinoAposLogin({ meus: [COND(5, 'gestor')], ativo: 5, user: USER({ role: 'condomino' }) });
assert.strictEqual(d.redirecionar, '/admin', 'B: gestor → /admin');
feito('B. gestor (users.role=condomino) → /admin');

// ── C. Condómino (só leitura, sem papel administrativo) ─────────────
d = destinoAposLogin({ meus: [COND(5, 'leitura')], ativo: 5, user: USER({ role: 'admin' }) });
assert.strictEqual(d.redirecionar, '/condomino', 'C: leitura → /condomino');
feito('C. condómino (leitura) → /condomino (mesmo com users.role=admin)');

// ── D. Super Admin sem condomínio ativo → painel global ─────────────
d = destinoAposLogin({ meus: [], ativo: null, user: USER({ role: 'condomino', role_global: 'super_admin' }) });
assert.strictEqual(d.redirecionar, '/admin/global', 'D: super admin sem ativo → /admin/global');
feito('D. super admin sem ativo → /admin/global');

// O privilégio global não depende de `users.role` (aqui contradiz de propósito).
d = destinoAposLogin({ meus: [], ativo: null, user: USER({ role: 'admin', role_global: 'super_admin' }) });
assert.strictEqual(d.redirecionar, '/admin/global', 'D: role_global decide, users.role é irrelevante');
feito('D. super admin com users.role=admin → /admin/global (mesmo destino)');

// ── D2. Super Admin com id de condomínio na sessão SEM associação ────
// INVARIANTE CENTRAL: SUPER-ADMIN ≠ ADMIN DE CONDOMÍNIO.
//
// Antes, ter um id de condomínio na sessão bastava para o super admin ser
// enviado para `/admin` em «modo suporte» — ou seja, a administração da
// PLATAFORMA convertia-se em administração do CONDOMÍNIO por via indireta.
// Isso está invertido: sem ASSOCIAÇÃO REAL, o destino é o painel global.
// Um id de sessão não é contexto nenhum — quem concede acesso a um condomínio é
// o acesso de suporte (`acessos_suporte`), resolvido em `comCondominioAtivo`
// via `req.suporte`, e que nunca produz `req.papelCondominio` de admin/gestor.
d = destinoAposLogin({ meus: [], ativo: 5, user: USER({ role: 'condomino', role_global: 'super_admin' }) });
assert.strictEqual(d.redirecionar, '/admin/global', 'D2: super admin sem associação → /admin/global (nunca /admin)');
assert.notStrictEqual(d.redirecionar, '/admin', 'D2: um id na sessão NÃO dá contexto de condomínio');
feito('D2. super admin sem associação (ativo na sessão) → /admin/global');

// Já não existe "modo suporte" derivado do eixo global: o contexto de suporte é
// uma concessão própria e vive em `req.suporte`, não no destino pós-login.
assert.strictEqual(d.modoSuporte, false, 'D2: não há modo suporte implícito');
feito('D2. modoSuporte é sempre false no destino');

// O id inválido é limpo — não fica um ativo «fantasma» a poluir pedidos futuros.
assert.strictEqual(d.limparAtivo, true, 'D2: ativo sem associação é limpo');
feito('D2. ativo sem associação é limpo do contexto');

// Super admin que TAMBÉM tem associação admin no condomínio ativo:
// a associação real é o que decide — e é o único caminho para /admin.
d = destinoAposLogin({ meus: [COND(5, 'admin')], ativo: 5, user: USER({ role: 'condomino', role_global: 'super_admin' }) });
assert.strictEqual(d.redirecionar, '/admin', 'D2: associação real → /admin');
assert.strictEqual(d.modoSuporte, false, 'D2b: com associação real não é modo suporte');
feito('D2b. super admin com associação real → /admin (associação tem precedência)');

// E o inverso: sem associação, mesmo com o id na sessão, NUNCA /admin.
d = destinoAposLogin({ meus: [COND(9, 'admin')], ativo: 5, user: USER({ role: 'condomino', role_global: 'super_admin' }) });
assert.strictEqual(d.redirecionar, '/admin/global', 'D2c: ativo que não é meu → /admin/global');
feito('D2c. super admin com ativo de OUTRO condomínio → /admin/global');

// ── E. Vários condomínios com papéis diferentes ─────────────────────
const VARIOS = [COND(3, 'leitura'), COND(5, 'admin'), COND(7, 'gestor')];
d = destinoAposLogin({ meus: VARIOS, ativo: 3, user: USER({ role: 'admin' }) });
assert.strictEqual(d.redirecionar, '/condomino', 'E: ativo=3 (leitura) → /condomino');
feito('E. vários condomínios, ativo=3 (leitura) → /condomino');

d = destinoAposLogin({ meus: VARIOS, ativo: 5, user: USER({ role: 'condomino' }) });
assert.strictEqual(d.redirecionar, '/admin', 'E: ativo=5 (admin) → /admin');
feito('E. vários condomínios, ativo=5 (admin) → /admin');

d = destinoAposLogin({ meus: VARIOS, ativo: 7, user: USER({ role: 'condomino' }) });
assert.strictEqual(d.redirecionar, '/admin', 'E: ativo=7 (gestor) → /admin');
feito('E. vários condomínios, ativo=7 (gestor) → /admin');

// Trocar de condomínio muda o destino MESMO com users.role fixo: prova que
// a decisão segue o condomínio ativo e não o utilizador.
const comAdmin = destinoAposLogin({ meus: VARIOS, ativo: 5, user: USER({ role: 'admin' }) });
const comLeitura = destinoAposLogin({ meus: VARIOS, ativo: 3, user: USER({ role: 'admin' }) });
assert.notStrictEqual(comAdmin.redirecionar, comLeitura.redirecionar, 'E: trocar de condomínio muda o destino');
feito('E. trocar de condomínio muda o destino (users.role fixo)');

// ── Sem condomínio escolhido → seleção, e o ativo inválido é limpo ──
d = destinoAposLogin({ meus: [COND(5, 'admin')], ativo: null, user: USER({ role: 'admin' }) });
assert.strictEqual(d.redirecionar, '/condominios', 'sem ativo → /condominios');
feito('Sem condomínio ativo → /condominios (escolha explícita)');

d = destinoAposLogin({ meus: [COND(5, 'admin')], ativo: 99, user: USER({ role: 'admin' }) });
assert.strictEqual(d.redirecionar, '/condominios', 'ativo inválido → /condominios');
assert.strictEqual(d.limparAtivo, true, 'ativo inválido é limpo');
feito('Condomínio ativo inválido → /condominios e limpa a sessão');

// ─────────────────────────────────────────────────────────────────────
// 2. NENHUM DESTINO PODE PRODUZIR O CICLO
//    Invariante global: para qualquer combinação (papel, ativo, users.role),
//    o destino nunca é um caminho que devolva de volta à raiz.
// ─────────────────────────────────────────────────────────────────────
titulo('Invariante anti-ciclo');

const PAPEIS_UC = ['admin', 'gestor', 'leitura'];
const LEGADOS = ['admin', 'condomino'];
const GLOBAIS = [null, 'super_admin'];
let combinacoes = 0;
const destinos = new Set();
for (const papel of PAPEIS_UC) {
  for (const legado of LEGADOS) {
    for (const global of GLOBAIS) {
      for (const ativo of [null, 5]) {
        for (const meus of [[], [COND(5, papel)]]) {
          const r = destinoAposLogin({
            meus,
            ativo,
            user: { id: 1, role: legado, role_global: global },
          });
          combinacoes += 1;
          destinos.add(r.redirecionar);
          // Só destinos terminais: o painel, o portal, a escolha ou a raiz
          // (que é quem toma a decisão). Nunca um destino que reentre no
          // próprio painel por outra via.
          assert.ok(
            ['/admin', '/condomino', '/condominios', '/admin/global'].includes(r.redirecionar),
            `destino inesperado: ${r.redirecionar}`
          );
        }
      }
    }
  }
}
feito(`Invariante anti-ciclo verificado em ${combinacoes} combinações (destinos: ${[...destinos].sort().join(', ')})`);

// Um destino só pode ser `/admin/global` quando NÃO há condomínio ativo —
// é a condição que impede `/admin → / → /admin/global` com ativo definido.
for (const legado of LEGADOS) {
  for (const papel of PAPEIS_UC) {
    const comAtivo = destinoAposLogin({
      meus: [COND(5, papel)],
      ativo: 5,
      user: { id: 1, role: legado, role_global: 'super_admin' },
    });
    assert.notStrictEqual(
      comAtivo.redirecionar,
      '/admin/global',
      'com condomínio ativo, um super admin nunca vai para o painel global (ciclo)'
    );
  }
}
feito('Com condomínio ativo, o destino global nunca é /admin/global');

// ─────────────────────────────────────────────────────────────────────
// 3. `users.role` JÁ NÃO APARECE COMO FONTE DE DECISÃO
// ─────────────────────────────────────────────────────────────────────
titulo('Fonte de verdade: `users.role` fora da decisão');

const indexSrc = ler('routes/index.js');
assert.ok(!/user\.role\b/.test(indexSrc.replace(/\/\/.*$/gm, '')), 'routes/index.js não lê user.role');
feito('routes/index.js: sem leitura de user.role');

const appSrc = ler('app.js');
assert.ok(!/req\.user\.role\b(?!_global)/.test(appSrc), 'app.js não compara users.role para decidir a UI');
feito('app.js: isAdmin não usa users.role');

const tenantSrc = ler('helpers/tenant.js');
assert.ok(!/\.role\s*===\s*'(admin|condomino)'/.test(tenantSrc), 'tenant.js não decide por users.role');
feito('helpers/tenant.js: sem comparação com users.role');

// ─────────────────────────────────────────────────────────────────────
// 4. `eAdmin` REMOVIDO
// ─────────────────────────────────────────────────────────────────────
titulo('Remoção de `eAdmin`');

const guardsSrc = ler('helpers/eAdmin.js');
assert.ok(!/\beAdmin\s*\(/.test(guardsSrc.replace(/\/\/.*$/gm, '')), 'helpers/eAdmin.js já não exporta eAdmin');
assert.ok(/eAutenticado/.test(guardsSrc), 'helpers/eAdmin.js mantém eAutenticado');
feito('helpers/eAdmin.js: eAdmin removido, eAutenticado mantido');

const guards = require(path.join(RAIZ, 'helpers', 'eAdmin'));
assert.strictEqual(typeof guards.eAdmin, 'undefined', 'eAdmin já não existe');
assert.strictEqual(typeof guards.eAutenticado, 'function', 'eAutenticado disponível');
feito('eAdmin ausente do módulo; eAutenticado presente');

// Nenhum router importa ou aplica eAdmin. O `require('../helpers/eAdmin')` é o
// caminho do FICHEIRO (que continua a existir, por causa de `eAutenticado`);
// o que não pode voltar é o SÍMBOLO `eAdmin`.
const ficheirosRotas = require('fs')
  .readdirSync(path.join(RAIZ, 'routes'))
  .filter((f) => f.endsWith('.js'));
const consumidores = [];
for (const f of ficheirosRotas) {
  const semComentarios = ler(path.join('routes', f))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/helpers\/eAdmin/g, ''); // o caminho do módulo não é o símbolo
  if (/\beAdmin\b(?!Condominio)/.test(semComentarios)) consumidores.push(f);
}
assert.deepStrictEqual(consumidores, [], `rotas que ainda usam o símbolo eAdmin: ${consumidores.join(', ')}`);
feito(`Nenhuma das ${ficheirosRotas.length} rotas usa o símbolo eAdmin`);

// E o módulo já não o exporta.
assert.ok(!/^\s*eAdmin\b/m.test(guardsSrc.replace(/\/\/.*$/gm, '')), 'helpers/eAdmin.js não define eAdmin');
feito('helpers/eAdmin.js não define nem exporta eAdmin');

// ─────────────────────────────────────────────────────────────────────
// 5. RELATÓRIO FINANCEIRO ACESSÍVEL AO GESTOR (bloqueio corrigido)
// ─────────────────────────────────────────────────────────────────────
titulo('Relatório Financeiro acessível ao gestor');

const relatoriosSrc = ler('routes/relatorios.js');
assert.ok(!/\beAdmin\b(?!Condominio)/.test(relatoriosSrc.replace(/^\s*\/\/.*$/gm, '')), 'relatorios.js sem eAdmin');
assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(relatoriosSrc), 'relatorios mantém o guard de condomínio');
assert.ok(/router\.use\(tenant\.comPapel\('gestor'\)\)/.test(relatoriosSrc), 'relatorios mantém comPapel gestor');
feito('routes/relatorios.js: só condomínio ativo + comPapel(gestor)');

// Prova comportamental: com a cadeia real, um gestor passa e um leitor não.
const { eAutenticado } = require(path.join(RAIZ, 'helpers', 'eAdmin'));
const mockReq = (papel, autenticado = true) => ({
  isAuthenticated: () => autenticado,
  user: { id: 1, role: 'condomino', role_global: null },
  session: { condominio_ativo_id: 5 },
  condominioId: 5,
  papelCondominio: papel,
  flash: () => {},
});
const correr = (guards, req) => {
  let resultado = 'BLOQUEADO_SEM_RESPOSTA';
  const res = { redirect: (u) => { resultado = `redirect:${u}`; } };
  const passo = (i) => {
    if (i >= guards.length) { resultado = 'next()'; return; }
    let avancou = false;
    const r = guards[i](req, res, () => { avancou = true; passo(i + 1); });
    void r;
    return avancou;
  };
  passo(0);
  return resultado;
};
const cadeiaRelatorios = [
  (req, res, next) => (req.papelCondominio ? next() : res.redirect('/condominios')),
  tenant.comPapel('gestor'),
];
assert.strictEqual(correr(cadeiaRelatorios, mockReq('gestor')), 'next()', 'gestor passa');
feito('Cadeia real: gestor (users.role=condomino) passa no guard');

assert.strictEqual(correr(cadeiaRelatorios, mockReq('admin')), 'next()', 'admin passa');
feito('Cadeia real: admin passa no guard');

assert.strictEqual(correr(cadeiaRelatorios, mockReq('leitura')), 'redirect:/', 'leitura é recusado');
feito('Cadeia real: leitura é recusado (redirect /)');

// ─────────────────────────────────────────────────────────────────────
// 6. PLACEHOLDERS — guarda coerente com a visibilidade na navegação
// ─────────────────────────────────────────────────────────────────────
titulo('Placeholders (guarda por módulo)');

const placeholdersSrc = ler('routes/placeholders.js');
assert.ok(!/\beAdmin\b(?!Condominio)/.test(placeholdersSrc.replace(/^\s*\/\/.*$/gm, '')), 'placeholders.js sem eAdmin');
feito('routes/placeholders.js: sem eAdmin');

// A visibilidade na navegação é decidida pelo MESMO critério que a guarda:
// na sidebar, os itens escondidos ao gestor estão dentro de
// `{{#if (ne condominioAtivo.role 'gestor')}}`. A guarda tem de espelhar isso.
// A análise percorre o troço anterior ao link e empilha as condições `{{#if}}`
// ainda ABERTAS (ignorando as já fechadas por `{{/if}}`), em vez de procurar o
// `{{/if}}` textualmente mais próximo — que pode pertencer a um bloco interno.
const layoutSrc = ler('views/layouts/main.handlebars');
const condicoesAbertasAntesDe = (pos) => {
  const re = /\{\{#if\s+([^}]*)\}\}|\{\{\/if\}\}/g;
  const pilha = [];
  let m;
  while ((m = re.exec(layoutSrc)) !== null && m.index < pos) {
    if (m[0] === '{{/if}}') pilha.pop();
    else pilha.push(m[1]);
  }
  return pilha;
};
const escondidoAoGestor = (rota) => {
  const pos = layoutSrc.indexOf(`href="${rota}"`);
  if (pos === -1) return null;
  return condicoesAbertasAntesDe(pos).some((c) => /ne\s+condominioAtivo\.role\s+'gestor'/.test(c));
};
assert.strictEqual(escondidoAoGestor('/admin/calendario'), true, 'Calendário escondido ao gestor');
assert.strictEqual(escondidoAoGestor('/admin/tickets'), true, 'Tickets escondido ao gestor');
assert.strictEqual(escondidoAoGestor('/admin/seguros'), true, 'Seguros escondido ao gestor');
assert.strictEqual(escondidoAoGestor('/admin/assembleias'), false, 'Assembleias visível ao gestor');
feito('Navegação: Calendário/Tickets/Seguros escondidos ao gestor; Assembleias visível');

// A guarda guarda a mesma regra: esses módulos exigem admin; os outros gestor.
const phPlaceholders = require(path.join(RAIZ, 'routes', 'placeholders.js'));
const MODULOS = phPlaceholders.MODULOS;
assert.ok(MODULOS, 'placeholders exporta MODULOS (para teste)');
assert.strictEqual(MODULOS.calendario.minimo, 'admin', 'Calendário exige admin');
assert.strictEqual(MODULOS.tickets.minimo, 'admin', 'Tickets exige admin');
assert.strictEqual(MODULOS.seguros.minimo, 'admin', 'Seguros exige admin');
assert.strictEqual(MODULOS.votacoes.minimo, 'gestor', 'Votações segue as Assembleias (gestor)');
assert.strictEqual(MODULOS.amenidades.minimo, 'gestor', 'Amenidades segue as Comunicações (gestor)');
feito('Guarda dos placeholders espelha a visibilidade na navegação');

// Comportamento: a guarda de um módulo 'admin' recusa o gestor e aceita o admin.
const guardaDe = (minimo) =>
  minimo === 'admin' ? [tenant.comPapel('admin')] : [tenant.comPapel('gestor')];
assert.strictEqual(correr(guardaDe(MODULOS.calendario.minimo), mockReq('admin')), 'next()', 'admin vê o Calendário');
assert.strictEqual(correr(guardaDe(MODULOS.calendario.minimo), mockReq('gestor')), 'redirect:/', 'gestor não vê o Calendário');
assert.strictEqual(correr(guardaDe(MODULOS.votacoes.minimo), mockReq('gestor')), 'next()', 'gestor vê as Votações');
feito('Guarda dos placeholders: admin vs gestor comportam-se como na navegação');

// ─────────────────────────────────────────────────────────────────────
// 7. LIMPEZA DE UI — nenhum link leva o gestor a um módulo só de admin
//
// As guards dos routers ficaram intocadas; o que se corrigiu foi a camada de
// apresentação, para que a interface não ofereça a um gestor links que o
// expulsariam para `/`. O critério é o MESMO da navegação lateral:
// `{{#if (ne condominioAtivo.role 'gestor')}}` — isto é, o papel do condomínio
// ATIVO, nunca `users.role`.
// ─────────────────────────────────────────────────────────────────────
titulo('UI: links admin-only escondidos ao gestor');

// ─ Vagas de `/admin` que exigem `comPapel('admin')` ─
// (routes/emails.js, routes/configuracao.js e os placeholders Calendário/
//  Tickets/Seguros; a gestão de utilizadores é o `apenasAdmin` de admin.js.)
//
// Só interessam os links que vivem em vistas ALCANÇÁVEIS AO GESTOR: as vistas
// de `views/admin/emails/` e `views/admin/configuracao/` nunca lhe são servidas
// (os seus routers exigem `admin`), pelo que os links que lá estão dentro não
// precisam de condição. As duas vistas abaixo são as únicas alcançáveis ao
// gestor que continham links admin-only.
const VISTAS_DO_GESTOR_COM_LINKS_ADMIN = {
  'views/admin/dashboard.handlebars': [
    '/admin/emails',
    '/admin/config/auditoria',
    '/admin/config/automacoes',
  ],
  'views/admin/avisos/detalhe.handlebars': ['/admin/emails?estado=pendentes'],
  // O link «Criar conta por convite» aponta para `/admin/utilizadores/nova`,
  // que exige `admin` (guard `apenasAdmin` em routes/admin.js) — por isso tem
  // de estar escondido ao gestor. O texto informativo que o acompanha
  // («sem conta, o titular fica registado…») mantém-se visível: não é um link.
  'views/admin/fracoes/form.handlebars': ['/admin/utilizadores/nova'],
};

// Analisa um ficheiro Handlebars: para cada ocorrência de `href="…"`, devolve
// as condições `{{#if}}` ainda ABERTAS nesse ponto (pilha, não `lastIndexOf`).
function condicoesAbertasEm(src, pos) {
  const re = /\{\{#if\s+([^}]*)\}\}|\{\{\/if\}\}|\{\{#unless\s+([^}]*)\}\}|\{\{\/unless\}\}/g;
  const pilha = [];
  let m;
  while ((m = re.exec(src)) !== null && m.index < pos) {
    if (m[0] === '{{/if}}' || m[0] === '{{/unless}}') pilha.pop();
    else pilha.push(m[1] || m[2]);
  }
  return pilha;
}
// O papel do condomínio ativo pode ser referido como `condominioAtivo.role`
// (contexto raiz direto) ou com prefixo explícito: `@root.` (convenção do
// projeto dentro de blocos aninhados) ou `../` (só quando o bloco pai é o
// contexto raiz). `../` dentro de um `{{#each}}` NÃO chega à raiz.
const ESCOLTA_GESTOR = /ne\s+(?:@root\.|\.\.\/)?condominioAtivo\.role\s+'gestor'/;
function rotaEscondidaAoGestor(src, rota) {
  let pos = src.indexOf(`href="${rota}"`);
  if (pos === -1) pos = src.indexOf(`href='${rota}'`);
  if (pos === -1) pos = src.indexOf(`'${rota}'`);
  if (pos === -1) pos = src.indexOf(`"${rota}"`);
  if (pos === -1) return null;
  return condicoesAbertasEm(src, pos).some((c) => ESCOLTA_GESTOR.test(c));
}

// ─ Vistas alcançáveis ao gestor: nenhum link admin-only fica à vista ─
for (const [vista, rotas] of Object.entries(VISTAS_DO_GESTOR_COM_LINKS_ADMIN)) {
  const src = ler(vista);
  for (const rota of rotas) {
    assert.strictEqual(
      rotaEscondidaAoGestor(src, rota),
      true,
      `${vista}: ${rota} tem de estar dentro de {{#if (ne condominioAtivo.role 'gestor')}}`
    );
  }
}
const totalLinksCondicionados = Object.values(VISTAS_DO_GESTOR_COM_LINKS_ADMIN).reduce(
  (n, r) => n + r.length,
  0
);
feito(`Vistas do gestor: ${totalLinksCondicionados} links admin-only escondidos ao gestor`);

// Não pode SOBRAR nenhum link admin-only visível numa vista do gestor.
// Percorre todas as vistas de /admin exceto as de pastas que só o admin vê.
const PASTAS_SO_ADMIN = ['emails', 'configuracao'];
const vistasAdmin = [];
(function varrer(dir) {
  for (const e of require('fs').readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p.includes(path.join('views', 'admin')) && PASTAS_SO_ADMIN.includes(e.name)) continue;
      varrer(p);
    } else if (e.name.endsWith('.handlebars')) {
      vistasAdmin.push(path.relative(RAIZ, p).split(path.sep).join('/'));
    }
  }
})(path.join(RAIZ, 'views', 'admin'));

const ADMIN_ONLY_NO_DASH = [
  '/admin/emails',
  '/admin/config/auditoria',
  '/admin/config/automacoes',
  '/admin/config/armazenamento',
];
const fuga = [];
for (const vista of vistasAdmin) {
  const src = ler(vista);
  for (const rota of ADMIN_ONLY_NO_DASH) {
    if (rotaEscondidaAoGestor(src, rota) === false) fuga.push(`${vista} → ${rota}`);
  }
}
assert.deepStrictEqual(fuga, [], `links admin-only visíveis ao gestor:\n${fuga.join('\n')}`);
feito(`Nenhuma das ${vistasAdmin.length} vistas do gestor expõe links admin-only`);

// ─ dashboard.handlebars ─
const dashSrc = ler('views/admin/dashboard.handlebars');

// O que o gestor PODE usar continua visível (sem regressão de funcionalidade).
for (const rota of ['/admin/documentos', '/admin/fornecedores']) {
  assert.strictEqual(
    rotaEscondidaAoGestor(dashSrc, rota),
    false,
    `dashboard.handlebars: ${rota} tem de continuar visível ao gestor`
  );
}
feito('dashboard.handlebars: Documentos e Fornecedores continuam visíveis ao gestor');

// O conteúdo informativo (contagem da fila) mantém-se ao gestor; só o link sai.
assert.ok(
  /Fila de emails:/.test(dashSrc),
  'o gestor continua a ver o estado da fila de emails (sem link)'
);
assert.ok(
  /{{#if \(ne condominioAtivo\.role 'gestor'\)}}[\s\S]{0,400}href="\/admin\/emails"/.test(dashSrc),
  'o link da fila está dentro do bloco condicionado'
);
feito('dashboard.handlebars: gestor mantém a contagem da fila, perde o link');

// O critério é `condominioAtivo.role` — nunca `users.role`.
for (const vista of Object.keys(VISTAS_DO_GESTOR_COM_LINKS_ADMIN)) {
  const src = ler(vista).replace(/\{\{!--[\s\S]*?--\}\}/g, '');
  assert.ok(
    !/\buser\.role\b|users\.role\b/.test(src),
    `${vista} não decide visibilidade por users.role`
  );
}
feito('Vistas: visibilidade decidida por condominioAtivo.role (sem users.role)');

// ─ helpers/dashboard.js: sinais cujo destino exige admin ─
const dashHelper = require(path.join(RAIZ, 'helpers', 'dashboard.js'));
const DADOS_SINAIS = {
  podeAdmin: true,
  nVencidas: 2,
  comprovativosPendentes: 1,
  quotasMesEmitidas: 0,
  documentosPorDisponibilizar: 1,
  pagamentosFornecedorPendentes: 1,
  ano: 2026,
  orcamentoEstadoAberto: 'rascunho',
  orcamentoId: 12,
  proximasAssembleias: [{ id: 30, numero: '2/2026', data: '12/11/2026' }],
  filaErros: 3,
  driveLigado: false,
  smtp: false,
};
const idsDe = (extra) => dashHelper.sinaisDeAtencao({ ...DADOS_SINAIS, ...extra }).map((s) => s.id);
const idsAdmin = idsDe({ podeAdmin: true });
const idsGestor = idsDe({ podeAdmin: false });
const SO_ADMIN = ['email_erros', 'drive', 'smtp'];

// gestor: nenhum sinal admin-only.
for (const id of SO_ADMIN) {
  assert.ok(!idsGestor.includes(id), `gestor não recebe o sinal '${id}'`);
}
feito(`helpers/dashboard.js: gestor não recebe sinais admin-only (${SO_ADMIN.join(', ')})`);

// admin: recebe-os todos.
for (const id of SO_ADMIN) {
  assert.ok(idsAdmin.includes(id), `admin recebe o sinal '${id}'`);
}
feito(`helpers/dashboard.js: admin recebe os sinais admin-only (${SO_ADMIN.join(', ')})`);

// Sem `podeAdmin` explícito mantém-se o comportamento anterior (compatibilidade).
assert.deepStrictEqual(
  dashHelper.sinaisDeAtencao({ ...DADOS_SINAIS, podeAdmin: undefined }).map((s) => s.id),
  idsAdmin,
  'sem podeAdmin: comportamento anterior preservado'
);
feito('helpers/dashboard.js: sem podeAdmin o comportamento anterior mantém-se');

// Um gestor não perde NENHUM sinal que consiga abrir.
const soGestor = idsAdmin.filter((i) => !SO_ADMIN.includes(i));
assert.deepStrictEqual(
  soGestor.filter((i) => !idsGestor.includes(i)),
  [],
  'gestor mantém todos os sinais não-admin'
);
feito(`helpers/dashboard.js: gestor mantém os ${soGestor.length} sinais não-admin`);

// Os sinais filtrados têm destino que exige admin — a razão do filtro.
for (const id of SO_ADMIN) {
  const s = dashHelper.sinaisDeAtencao(DADOS_SINAIS).find((x) => x.id === id);
  assert.ok(s, `sinal '${id}' existe para o admin`);
  assert.ok(
    /^\/admin\/(emails|config)/.test(s.destino.url),
    `sinal '${id}' aponta para ${s.destino.url} (exige admin)`
  );
}
feito('helpers/dashboard.js: os sinais filtrados apontam mesmo para módulos de admin');

// ─ routes/admin.js passa o papel do condomínio ativo ─
const adminSrcUI = ler('routes/admin.js');
assert.ok(
  /podeAdmin/.test(adminSrcUI),
  'routes/admin.js passa podeAdmin aos sinais'
);
assert.ok(
  /papelMaiorOuIgual\(\s*req\.papelCondominio\s*,\s*'admin'\s*\)/.test(adminSrcUI),
  "podeAdmin vem de req.papelCondominio (associação ativa), não de users.role"
);
feito('routes/admin.js: podeAdmin derivado de req.papelCondominio (fonte correta)');

// ─ Link partido em fracoes/form.handlebars ─
const fracoesSrc = ler('views/admin/fracoes/form.handlebars');
assert.ok(
  fracoesSrc.includes('href="/admin/utilizadores/nova"'),
  'fracoes/form.handlebars aponta para /admin/utilizadores/nova'
);
feito('fracoes/form.handlebars: link corrigido para /admin/utilizadores/nova');

// ─ «Criar conta por convite»: visível ao admin, escondido ao gestor ─
// A rota `/admin/utilizadores/nova` exige `admin`; como a vista de frações é
// servida também ao gestor, o link tem de estar dentro de um bloco que o
// exclui. O critério é o papel do condomínio ATIVO — nunca `users.role`.
const ESCOLTA_ADMIN_NA_FRACAO = /ne\s+(?:@root\.|\.\.\/)?condominioAtivo\.role\s+'gestor'|eq\s+(?:@root\.|\.\.\/)?condominioAtivo\.role\s+'admin'/;
const posLinkNova = fracoesSrc.indexOf('href="/admin/utilizadores/nova"');
assert.ok(posLinkNova > -1, 'o link existe em fracoes/form.handlebars');
assert.ok(
  condicoesAbertasEm(fracoesSrc, posLinkNova).some((c) => ESCOLTA_ADMIN_NA_FRACAO.test(c)),
  "o link «Criar conta por convite» tem de estar sob condição de papel admin (ne 'gestor' ou eq 'admin')"
);
assert.ok(
  rotaEscondidaAoGestor(fracoesSrc, '/admin/utilizadores/nova') === true,
  'o gestor NÃO vê o link «Criar conta por convite»'
);
// Para o admin a condição é verdadeira ⇒ o link continua visível.
assert.ok(
  condicoesAbertasEm(fracoesSrc, posLinkNova).length > 0,
  'o link está sob condição (visível ao admin, escondido ao gestor)'
);
// O texto informativo mantém-se ao gestor: só o link sai, não a explicação.
assert.ok(
  /A criação de contas por convite é feita por um administrador/.test(fracoesSrc),
  'o gestor mantém a explicação (só perde o link)'
);
assert.ok(
  !/\buser\.role\b|users\.role\b/.test(fracoesSrc.replace(/\{\{!--[\s\S]*?--\}\}/g, '')),
  'a visibilidade do link não depende de users.role'
);
feito('fracoes/form.handlebars: link visível ao admin, escondido ao gestor (por condominioAtivo.role)');

// A rota continua protegida por `admin` — o que sai da UI não sai da guarda.
const rotaNovaSrc = adminSrcUI.slice(
  adminSrcUI.indexOf("router.get('/utilizadores/nova'"),
  adminSrcUI.indexOf("router.get('/utilizadores/nova'") + 120
);
assert.ok(
  /router\.get\('\/utilizadores\/nova',\s*apenasAdmin/.test(rotaNovaSrc),
  'GET /utilizadores/nova continua protegida por apenasAdmin (admin)'
);
assert.ok(
  /const apenasAdmin = tenant\.comPapel\('admin'\)/.test(adminSrcUI),
  'apenasAdmin é comPapel(admin) — o gestor continua sem poder criar utilizadores'
);
feito('GET /admin/utilizadores/nova continua protegida por admin (guard intacta)');

// ─ Prova por RENDER: o link sai mesmo para uns e não para outros ─
// A análise estática acima verifica a CONDIÇÃO; esta verifica o EFEITO. Sem
// isto, uma condição sintaticamente correta mas com o contexto errado (p.ex.
// `../condominioAtivo` dentro de um `{{#each}}`, que Handlebars resolve contra
// o item e não contra a raiz) passaria despercebida — foi exatamente o que
// aconteceu na primeira tentativa: compilava, mas o gestor continuava a ver o
// link. O projeto usa `@root.` para chegar ao contexto raiz.
Handlebars.registerHelper('ne', (a, b) => a !== b);
Handlebars.registerHelper('formatDate', (d) => String(d || ''));
Handlebars.registerHelper('dateInput', (d) => String(d || ''));
const fragmentoSemConta = fracoesSrc.slice(
  fracoesSrc.indexOf('{{#unless this.temConta}}'),
  fracoesSrc.indexOf('{{/unless}}', posLinkNova) + '{{/unless}}'.length
);
const tplSemConta = Handlebars.compile(fragmentoSemConta);
const titularSemConta = {
  pessoa: { nome: 'Titular de teste' },
  vinculo: 'proprietario',
  temConta: false,
  data_inicio: null,
};
const htmlPorPapel = (role) =>
  tplSemConta({ ...titularSemConta, condominioAtivo: { role } });
const htmlAdmin = htmlPorPapel('admin');
const htmlGestor = htmlPorPapel('gestor');
assert.ok(
  htmlAdmin.includes('href="/admin/utilizadores/nova"'),
  'render (admin): o link «Criar conta por convite» tem de aparecer'
);
assert.ok(
  !htmlGestor.includes('/admin/utilizadores/nova'),
  'render (gestor): o link «Criar conta por convite» NÃO pode aparecer'
);
assert.ok(
  !/href="\/admin\/utilizadores/.test(htmlGestor),
  'render (gestor): nenhum link para a gestão de utilizadores'
);
assert.ok(
  htmlGestor.trim().length > 0,
  'render (gestor): o bloco continua a mostrar o texto informativo (não fica vazio)'
);
feito('Render real: admin vê «Criar conta por convite», gestor não (e não perde o texto)');

// O contexto raiz tem de ser alcançado por `@root.` (convenção do projeto),
// nunca por `../` dentro de um `{{#each}}` — que aponta para o item.
assert.ok(
  !/\.\.\/condominioAtivo\.role/.test(fracoesSrc),
  'não usar ../condominioAtivo.role dentro do {{#each}} (resolveria contra o item)'
);
assert.ok(
  /@root\.condominioAtivo\.role/.test(fracoesSrc),
  'o papel do condomínio ativo é lido como @root.condominioAtivo.role'
);
feito('fracoes/form.handlebars: papel lido por @root.condominioAtivo.role');

// Nenhum link `/admin/utilizadores/novo` permanece em NENHUMA vista.
const vistasComLinkPartido = require('fs')
  .readdirSync(path.join(RAIZ, 'views'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    const dir = path.join(RAIZ, 'views', d.name);
    return require('fs')
      .readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.handlebars'))
      .map((f) => path.join('views', d.name, f.name));
  })
  .concat(
    require('fs')
      .readdirSync(path.join(RAIZ, 'views'))
      .filter((f) => f.endsWith('.handlebars'))
      .map((f) => path.join('views', f))
  )
  .filter((rel) => ler(rel).includes('/admin/utilizadores/novo'));
assert.deepStrictEqual(vistasComLinkPartido, [], `vistas com /admin/utilizadores/novo: ${vistasComLinkPartido.join(', ')}`);
feito('Nenhuma vista usa /admin/utilizadores/novo (rota inexistente)');

// A rota real é `/nova` — confirma-se no router.
assert.ok(
  /router\.get\('\/utilizadores\/nova'/.test(adminSrcUI),
  "a rota real é GET /utilizadores/nova"
);
assert.ok(
  !/router\.get\('\/utilizadores\/novo'/.test(adminSrcUI),
  'não existe rota /utilizadores/novo'
);
feito('A rota real é /admin/utilizadores/nova (o link passou a coincidir)');

// ─────────────────────────────────────────────────────────────────────
// 8. GUARDA DO BACKOFFICE COM OS ROUTERS REAIS — prova por perfil
//
// Monta `routes/admin.js`, `routes/relatorios.js` e `routes/placeholders.js`
// REAIS e prova que o mínimo do router (`gestor`) coincide com o destino que
// `destinoInicial` dá ao gestor. A associação é injetada pelo modelo
// (`UserCondominio.findOne`), que é o que `associacaoAtiva` consulta — sem BD
// e sem mexer no código de produção.
// ─────────────────────────────────────────────────────────────────────
titulo('Guarda do backoffice com routers reais (por perfil)');

async function provarGuardaReal() {
  const raiz = RAIZ;
  // Os routers reais importam `/models` no topo: substitui-se por stubs
  // funcionais (os handlers chegam ao fim em vez de rebentar).
  // O `helpers/tenant` da secção 7 é uma instância PRÓPRIA: recarrega-se com o
  // mesmo stub, senão usaria o `UserCondominio` do stub anterior (o módulo já
  // está em cache com os modelos antigos).
  const caminhoModels = require.resolve(path.join(raiz, 'models'));
  const caminhoTenant = require.resolve(path.join(raiz, 'helpers', 'tenant'));
  const cacheModelsAnterior = require.cache[caminhoModels];
  const cacheTenantAnterior = require.cache[caminhoTenant];
  const modeloGenerico = new Proxy({}, {
    get: (_, k) => {
      if (k === 'count') return async () => 0;
      if (k === 'findAll') return async () => [];
      return async () => null;
    },
  });
  let papelInjetado = 'admin';
  const UserCondominio = {
    findOne: async () => (papelInjetado ? { role: papelInjetado, estado: 'ativo' } : null),
    findAll: async () => [],
    count: async () => 0,
  };
  require.cache[caminhoModels] = {
    id: caminhoModels,
    filename: caminhoModels,
    loaded: true,
    exports: new Proxy({ UserCondominio, Condominio: modeloGenerico }, {
      get: (alvo, k) => (k === 'Op' ? Sequelize.Op : alvo[k] || modeloGenerico),
    }),
  };
  // Recarrega o tenant para que `associacaoAtiva` use o novo stub de modelos.
  // O mesmo problema existe no resto da cadeia: qualquer helper que faça
  // `require('../models')` no topo (saldos.js, dashboard.js, movimentos.js,
  // recibos.js, …) guarda a referência aos modelos ANTIGOS no destructuring.
  // Limpa-se todo o cache de `helpers/` e `routes/` para que a cadeia seja
  // reconstruída contra o stub — é a única forma fiável de testar routers reais.
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(raiz)) delete require.cache[k];
  }
  const tenantReal = require(caminhoTenant);
  assert.ok(tenantReal.comCondominioAtivo, 'tenant recarregado tem comCondominioAtivo');

  // Os routers são carregados DEPOIS do stub. O cache de helpers/routes já foi
  // limpo acima, pelo que estas require reconstroem toda a cadeia contra o stub.
  const caminhosRouters = ['admin', 'relatorios', 'placeholders'].map((r) =>
    require.resolve(path.join(raiz, 'routes', r))
  );
  const cacheRouters = caminhosRouters.map((c) => require.cache[c]);
  const routers = caminhosRouters.map((c) => {
    delete require.cache[c];
    return require(c);
  });

  const appReal = express();
  appReal.set('view engine', 'handlebars');
  appReal.engine('handlebars', (f, o, cb) => cb(null, 'OK'));
  appReal.set('views', path.join(raiz, 'views'));
  appReal.use((req, res, next) => {
    papelInjetado = req.headers['x-papel'] === 'null' ? null : req.headers['x-papel'];
    req.user = { id: 1, role: req.headers['x-legado'] || 'condomino', role_global: null };
    req.session = { condominio_ativo_id: 5 };
    req.isAuthenticated = () => true;
    req.flash = () => {};
    next();
  });
  for (const r of routers) appReal.use('/admin', r);
  appReal.use('/admin', (req, res) => res.status(404).send('404'));

  const servidorReal = http.createServer(appReal);
  await new Promise((r) => servidorReal.listen(0, '127.0.0.1', r));
  const baseReal = `http://127.0.0.1:${servidorReal.address().port}`;
  const pedirReal = (caminho, papel, legado = 'condomino') =>
    new Promise((resolve) => {
      const req = http.request(`${baseReal}${caminho}`, {
        headers: { 'x-papel': String(papel), 'x-legado': legado },
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, local: res.headers.location });
      });
      req.on('error', () => resolve({ status: 0 }));
      req.end();
    });

  try {
    // A. admin → /admin sem redirect.
    let rr = await pedirReal('/admin', 'admin');
    assert.strictEqual(rr.status, 200, 'real: admin GET /admin → 200');
    assert.notStrictEqual(rr.local, '/', 'real: admin não é redirecionado para /');
    feito('A (routers reais). Admin: GET /admin → 200, sem redirect');

    // B. gestor → /admin sem redirect (a inconsistência corrigida).
    rr = await pedirReal('/admin', 'gestor');
    assert.strictEqual(rr.status, 200, 'real: gestor GET /admin → 200 (não 302 /)');
    assert.notStrictEqual(rr.local, '/', 'real: gestor não é expulso para /');
    feito('B (routers reais). Gestor: GET /admin → 200, sem redirect');

    // C. gestor não acede ao que exige admin.
    rr = await pedirReal('/admin/utilizadores', 'gestor');
    assert.strictEqual(rr.status, 302, 'real: gestor /admin/utilizadores → 302');
    assert.strictEqual(rr.local, '/', 'real: gestor /admin/utilizadores → /');
    feito('C (routers reais). Gestor bloqueado em /admin/utilizadores');

    rr = await pedirReal('/admin/calendario', 'gestor');
    assert.strictEqual(rr.local, '/', 'real: gestor /admin/calendario → /');
    feito('C (routers reais). Gestor bloqueado no Calendário (placeholder admin)');

    // C-bis. admin continua a ter tudo.
    for (const rota of ['/admin/utilizadores', '/admin/calendario']) {
      rr = await pedirReal(rota, 'admin');
      assert.strictEqual(rr.status, 200, `real: admin ${rota} → 200`);
    }
    feito('C-bis (routers reais). Admin mantém utilizadores e Calendário');

    // D. leitura → recusado no backoffice.
    rr = await pedirReal('/admin', 'leitura');
    assert.strictEqual(rr.status, 302, 'real: leitura GET /admin → 302');
    assert.strictEqual(rr.local, '/', 'real: leitura GET /admin → /');
    feito('D (routers reais). Leitura recusada no backoffice (302 /)');

    // E. users.role não altera NADA.
    for (const legado of ['admin', 'condomino']) {
      rr = await pedirReal('/admin', 'gestor', legado);
      assert.strictEqual(rr.status, 200, `real: gestor com users.role='${legado}' → 200`);
      rr = await pedirReal('/admin/utilizadores', 'gestor', legado);
      assert.strictEqual(rr.local, '/', `real: gestor users.role='${legado}' continua bloqueado`);
    }
    feito("E (routers reais). users.role ('admin'/'condomino') não altera nenhuma decisão");

    // Um perfil que só serve o portal (sem associação) não entra no backoffice.
    rr = await pedirReal('/admin', 'null');
    assert.strictEqual(rr.local, '/condominios', 'real: sem associação → /condominios');
    feito('Sem associação ativa: /admin → /condominios (nunca 200)');
  } finally {
    servidorReal.close();
    if (cacheModelsAnterior) require.cache[caminhoModels] = cacheModelsAnterior;
    else delete require.cache[caminhoModels];
    if (cacheTenantAnterior) require.cache[caminhoTenant] = cacheTenantAnterior;
    else delete require.cache[caminhoTenant];
    caminhosRouters.forEach((c, i) => {
      if (cacheRouters[i]) require.cache[c] = cacheRouters[i];
      else delete require.cache[c];
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7. NAMESPACE E SHIM — validados contra um servidor a correr
// ─────────────────────────────────────────────────────────────────────
titulo('Namespace /admin vs /global e shim de compatibilidade');

// O app.js real não arranca sem BD. Reconstrói-se aqui o encadeamento de
// montagem EXATO do app.js (prefixos e ordem), com o shim real e routers
// mínimos que imitam o contrato de cada um:
//   · `/global`       → router global (guarda eSuperAdmin -> 302 /);
//   · `/admin/global` → shim 302 para `/global*` (antes dos routers de /admin);
//   · `/admin`        → backoffice do condomínio (comCondominioAtivo +
//                        comPapel('gestor') no router, `apenasAdmin` por rota),
//                        como em routes/admin.js.
const ROTAS_ADMIN_MIN = ['/admin/dashboard', '/admin/relatorios/financeiro'];

const app = express();
// Injeta o contexto a partir dos cabeçalhos, para simular perfis distintos.
// Tem de vir ANTES das montagens: o Express resolve pela ordem de registo.
app.use((req, res, next) => {
  req.user = { id: 1, role: 'condomino', role_global: req.headers['x-global'] === '1' ? 'super_admin' : null };
  req.session = { condominio_ativo_id: 5 };
  req.isAuthenticated = () => true;
  req.flash = () => {};
  const papel = req.headers['x-papel'];
  if (papel && papel !== 'null') req.papelCondominio = papel;
  next();
});

// Router global: eAutenticado + guarda exclusiva de Super Admin (global-admin.js).
app.use('/global', (req, res, next) => {
  res.setHeader('X-Router', 'global');
  if (!tenant.eSuperAdmin(req.user)) return res.redirect(302, '/');
  return next();
});
app.use('/global', (req, res) => res.status(200).json({ painel: 'global', caminho: req.path }));

// Shim: idêntico ao do app.js.
app.use('/admin/global', (req, res) => {
  const resto = req.originalUrl.slice('/admin/global'.length);
  res.setHeader('X-Router', 'shim');
  return res.redirect(302, '/global' + resto);
});

// Backoffice do condomínio: comCondominioAtivo + comPapel('gestor') — o MESMO
// mínimo que `destinoInicial` dá a admin e gestor. `apenasAdmin` reproduz as
// rotas restritas (gestão de utilizadores) tal como em routes/admin.js.
app.use('/admin', (req, res, next) => { res.setHeader('X-Router', 'admin'); next(); });
app.use(
  '/admin',
  (req, res, next) => {
    // comCondominioAtivo, com o contexto já resolvido.
    if (req.papelCondominio) return next();
    req.flash('error_msg', 'Selecione um condomínio para continuar.');
    return res.redirect(302, '/condominios');
  },
  tenant.comPapel('gestor'),
  (req, res, next) => {
    const apenasAdmin = tenant.comPapel('admin');
    if (req.path.startsWith('/utilizadores')) return apenasAdmin(req, res, next);
    return next();
  },
  (req, res) => res.status(200).json({ painel: 'condominio', caminho: req.path, papel: req.papelCondominio })
);
app.use((req, res) => res.status(404).json({ erro: 'sem rota', caminho: req.path }));

const servidor = http.createServer(app);
let base = '';

// `papel`: papel do condomínio ativo (null = sem contexto -> /condominios).
// `global`: se é Super Admin (rota global).
const pedir = (caminho, { papel = 'admin', global = false } = {}) =>
  new Promise((resolve) => {
    const req = http.request(
      `${base}${caminho}`,
      { method: 'GET', headers: { 'x-papel': String(papel), 'x-global': global ? '1' : '0' } },
      (res) => {
        let corpo = '';
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => resolve({ status: res.statusCode, local: res.headers.location, headers: res.headers, corpo }));
      }
    );
    req.on('error', () => resolve({ status: 0, local: null, headers: {}, corpo: '' }));
    req.end();
  });

// ── Guardas de `/admin` no código real ──────────────────────────────

(async () => {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  // ── O shim responde e preserva caminho + query string ────────────────
  let r = await pedir('/admin/global');
  assert.strictEqual(r.status, 302, '/admin/global → 302 (não 301)');
  assert.strictEqual(r.local, '/global', '/admin/global → /global');
  feito('/admin/global → 302 /global (não 301)');

  r = await pedir('/admin/global/condominios?estado=ativo&ordem=nome');
  assert.strictEqual(r.status, 302, '/admin/global/… → 302');
  assert.strictEqual(r.local, '/global/condominios?estado=ativo&ordem=nome', 'preserva o resto do caminho e a query string');
  feito('/admin/global/condominios?estado=ativo&ordem=nome → /global/condominios?… (caminho e query preservados)');

  r = await pedir('/admin/global/utilizadores');
  assert.strictEqual(r.local, '/global/utilizadores', 'shim preserva sub-caminho');
  feito('/admin/global/utilizadores → /global/utilizadores');

  r = await pedir('/admin/global/condominios/7');
  assert.strictEqual(r.local, '/global/condominios/7', 'shim preserva parâmetro de rota');
  feito('/admin/global/condominios/7 → /global/condominios/7');

  // ── `/admin` NÃO é capturado pelo shim nem pelo router global ───────
  r = await pedir('/admin/dashboard', { papel: 'admin' });
  assert.notStrictEqual(r.headers['x-router'], 'global', '/admin não entra no router global');
  assert.notStrictEqual(r.headers['x-router'], 'shim', '/admin não entra no shim');
  feito('/admin não é interceptado pelo namespace global nem pelo shim');

  // ── O CICLO: admin de condomínio em /admin responde 200, não 302 / ──
  r = await pedir('/admin/dashboard', { papel: 'admin' });
  assert.strictEqual(r.status, 200, 'admin de condomínio: /admin responde 200');
  assert.notStrictEqual(r.local, '/', 'admin de condomínio: /admin nunca redireciona para /');
  feito('Admin de condomínio: GET /admin → 200 (sem 302 /) — CICLO RESOLVIDO');

  // ── O GESTOR entra no backoffice (mínimo `gestor`, não `admin`) ──────
  // Antes: `routes/admin.js` exigia `comPapel('admin')`, pelo que o gestor era
  // enviado para `/admin` por `destinoInicial` e imediatamente expulso para `/`.
  // Agora o mínimo do router coincide com o destino, e as permissões restritas
  // vivem nos sítios próprios (`apenasAdmin` por rota, `configuracao.js`,
  // `sistema.js`, `emails.js`, `placeholders.js`).
  r = await pedir('/admin', { papel: 'gestor' });
  assert.strictEqual(r.status, 200, 'gestor: GET /admin responde 200 (sem redirect)');
  assert.notStrictEqual(r.local, '/', 'gestor: /admin nunca redireciona para /');
  feito('B. Gestor: GET /admin → 200 (sem redirect) — inconsistência resolvida');

  r = await pedir('/admin', { papel: 'admin' });
  assert.strictEqual(r.status, 200, 'admin: GET /admin responde 200 (sem redirect)');
  feito('A. Admin: GET /admin → 200 (sem redirect)');

  // O gestor NÃO acede ao que exige `admin` (gestão de utilizadores).
  r = await pedir('/admin/utilizadores', { papel: 'gestor' });
  assert.strictEqual(r.status, 302, 'gestor: /admin/utilizadores recusado (302)');
  assert.strictEqual(r.local, '/', 'gestor: /admin/utilizadores → /');
  feito('C. Gestor bloqueado em /admin/utilizadores (exige admin)');

  // O admin continua a ter tudo.
  r = await pedir('/admin/utilizadores', { papel: 'admin' });
  assert.strictEqual(r.status, 200, 'admin: /admin/utilizadores responde 200');
  feito('C-bis. Admin mantém /admin/utilizadores (sem regressão)');

  // Um leitor não entra no backoffice — recusa pelo guard do CONDOMÍNIO.
  r = await pedir('/admin', { papel: 'leitura' });
  assert.strictEqual(r.status, 302, 'leitura: /admin recusado (302)');
  assert.strictEqual(r.local, '/', 'leitura: /admin → /');
  feito('Leitor: /admin recusado pelo guard do condomínio (302 /)');

  // ── D. `uc.role='leitura'` → /condomino (destino) ────────────────────
  assert.strictEqual(
    destinoAposLogin({ meus: [COND(5, 'leitura')], ativo: 5, user: USER({ role: 'admin' }) }).redirecionar,
    '/condomino',
    'leitura → /condomino (users.role=admin é irrelevante)'
  );
  feito('D. Leitor → /condomino (não /admin), mesmo com users.role=admin');

  // ── E. `users.role` não altera NENHUMA destas decisões ───────────────
  // O mesmo par (papel do condomínio, ativo) tem de dar o mesmo destino
  // independentemente de `users.role` ser 'admin' ou 'condomino'.
  for (const ucRole of ['admin', 'gestor', 'leitura']) {
    const comAdmin = destinoAposLogin({ meus: [COND(5, ucRole)], ativo: 5, user: USER({ role: 'admin' }) });
    const comCondomino = destinoAposLogin({ meus: [COND(5, ucRole)], ativo: 5, user: USER({ role: 'condomino' }) });
    assert.deepStrictEqual(
      comAdmin,
      comCondomino,
      `E: users.role não altera o destino de uc.role='${ucRole}'`
    );
  }
  feito("E. Trocar users.role ('admin' ↔ 'condomino') não altera o destino (admin/gestor/leitura)");

  // E, do lado do GUARD: o mesmo pedido HTTP com papéis de condomínio iguais
  // não muda de resposta por causa de `users.role` (o harness não lê users.role;
  // esta asserção garante que o guard real também não o passa a ler).
  const adminSrcUsersRole = ler('routes/admin.js').replace(/\/\/.*$/gm, '');
  assert.ok(
    !/user\.role\b|req\.user\.role\b|users\.role\b/.test(adminSrcUsersRole),
    'routes/admin.js não decide por users.role'
  );
  feito('E-bis. routes/admin.js não usa users.role na decisão de acesso');

  // ── F. Demo atual → /admin sem ciclo ────────────────────────────────
  // O gestor demo: uc.role='admin' (associação ativa) e users.role='admin'.
  const demoAdmin = destinoAposLogin({ meus: [COND(5, 'admin')], ativo: 5, user: USER({ role: 'admin', role_global: null }) });
  assert.strictEqual(demoAdmin.redirecionar, '/admin', 'demo: destino é /admin');
  assert.notStrictEqual(demoAdmin.redirecionar, '/', 'demo: o destino nunca é / (fim do ciclo)');
  r = await pedir('/admin', { papel: 'admin' });
  assert.strictEqual(r.status, 200, 'demo: GET /admin responde 200');
  assert.notStrictEqual(r.local, '/', 'demo: /admin não redireciona para /');
  feito('F. Demo atual: destino /admin e GET /admin → 200 (sem ciclo /admin → / → /admin)');

  // O ciclo é impossível por construção: o destino é sempre uma rota que o
  // próprio perfil consegue servir — nunca `/`, que devolveria a `/admin`.
  for (const ucRole of ['admin', 'gestor', 'leitura']) {
    for (const legado of ['admin', 'condomino']) {
      const dest = destinoAposLogin({ meus: [COND(5, ucRole)], ativo: 5, user: USER({ role: legado }) }).redirecionar;
      assert.notStrictEqual(dest, '/', `sem ciclo: uc.role='${ucRole}' / users.role='${legado}'`);
    }
  }
  feito('Sem ciclo: nenhum perfil volta ao destino / (origem do /admin → / → /admin)');

  // O Relatório Financeiro (comPapel gestor) aceita o gestor: monta-se o
  // router real de relatórios, que é o caminho usado pelo cenário B.
  const routerRelatorios = require(path.join(RAIZ, 'routes', 'relatorios'));
  const appRel = express();
  appRel.use((req, res, next) => {
    req.user = { id: 1, role: 'condomino', role_global: null };
    req.session = { condominio_ativo_id: 5 };
    req.isAuthenticated = () => true;
    req.flash = () => {};
    next();
  });
  appRel.use('/admin', routerRelatorios);
  const servidorRel = http.createServer(appRel);
  await new Promise((r2) => servidorRel.listen(0, '127.0.0.1', r2));
  const baseRel = `http://127.0.0.1:${servidorRel.address().port}`;
  const respRel = await new Promise((resolve) => {
    http.get(`${baseRel}/admin/relatorios/financeiro`, (res) => {
      res.resume();
      resolve({ status: res.statusCode, local: res.headers.location });
    }).on('error', () => resolve({ status: 0 }));
  });
  servidorRel.close();
  // Sem BD, `comCondominioAtivo` resolve a associação: os modelos reais usam a
  // ligação inexistente, pelo que a resposta é um erro de BD — o que importa é
  // que NÃO é o `302 /` do antigo `eAdmin` (o gestor passou o guard).
  assert.notStrictEqual(
    respRel.local,
    '/',
    'gestor não é expulso para / pelo guard do Relatório Financeiro'
  );
  feito('Gestor: Relatório Financeiro não o expulsa para / (bloqueio do eAdmin removido)');

  // ── A PROVA DEFINITIVA: routers reais, por perfil (secção 7) ─────────
  await provarGuardaReal();

  // Um leitor é recusado pelo comPapel('admin') do backoffice — e a recusa
  // vai para `/`, mas é o guard do CONDOMÍNIO que decide, não o router global.
  r = await pedir('/admin/dashboard', { papel: 'leitura' });
  assert.strictEqual(r.headers['x-router'], 'admin', 'leitura é decidido pelo backoffice, não pelo global');
  feito('Leitor: /admin é tratado pelo backoffice (não pelo namespace global)');

  // ── `/global` é servido a Super Admin e recusa os restantes ─────────
  r = await pedir('/global', { global: true });
  assert.strictEqual(r.headers['x-router'], 'global', '/global entra no router global');
  assert.strictEqual(r.status, 200, '/global responde ao Super Admin');
  feito('/global: servido ao Super Admin (200)');

  r = await pedir('/global', { global: false });
  assert.strictEqual(r.status, 302, '/global recusa quem não é Super Admin');
  assert.strictEqual(r.local, '/', '/global redireciona o não-Super-Admin para /');
  feito('/global: recusa quem não é Super Admin (302 /)');

  r = await pedir('/global/condominios', { global: true });
  assert.strictEqual(r.status, 200, '/global/condominios responde ao Super Admin');
  assert.strictEqual(r.corpo && JSON.parse(r.corpo).caminho, '/condominios', 'prefixo removido corretamente');
  feito('/global/condominios: prefixo removido, caminho /condominios');

  // ── Super Admin NÃO perde o acesso global por não ser admin de condomínio ─
  r = await pedir('/global', { global: true, papel: 'null' });
  assert.strictEqual(r.status, 200, 'super admin sem papel de condomínio acede ao global');
  feito('Super Admin sem papel de condomínio mantém o acesso global');

  // ── Guardas de `/admin` no código real ──────────────────────────────
  // A guarda do router tem de ter o MESMO mínimo que o destino: `/admin` é o
  // backoffice comum de `admin` e `gestor` (`destinoInicial` manda ambos para
  // lá), pelo que o mínimo é `gestor` — não `admin`. Com `admin` aqui, o gestor
  // era enviado para `/admin` e imediatamente expulso para `/`.
  // As permissões restritas continuam garantidas: `configuracao.js`,
  // `sistema.js` e `emails.js` mantêm `comPapel('admin')` no próprio router, os
  // módulos Calendário/Tickets/Seguros mantêm-no em `placeholders.js`, e a
  // gestão de utilizadores é protegida rota a rota em `admin.js`.
  const adminSrc = ler('routes/admin.js');
  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(adminSrc), 'admin.js tem comCondominioAtivo');
  assert.ok(
    /router\.use\(tenant\.comPapel\('gestor'\)\)/.test(adminSrc) ||
    /return tenant\.comPapel\('gestor'\)\(req, res, next\);/.test(adminSrc),
    'admin.js tem comPapel(gestor) no router (mesmo mínimo que o destino)'
  );
  assert.ok(
    !/router\.use\(tenant\.comPapel\('admin'\)\)/.test(adminSrc),
    'admin.js NÃO tem comPapel(admin) no router'
  );
  assert.ok(
    /const apenasAdmin = tenant\.comPapel\('admin'\)/.test(adminSrc),
    'admin.js define apenasAdmin para as rotas restritas'
  );
  feito('routes/admin.js: condomínio ativo + comPapel(gestor) no router, apenasAdmin por rota');

  // ── C (código): o gestor não ganha acesso aos módulos que exigem `admin` ─
  // Os módulos restritos mantêm `comPapel('admin')` nos PRÓPRIOS routers: baixar
  // o mínimo do router de `/admin` não os pode ter aberto.
  const ROTAS_MODULOS_ADMIN = {
    'routes/configuracao.js': "router.use(tenant.comPapel('admin'))",
    'routes/sistema.js': "router.use(tenant.comPapel('admin'))",
    'routes/emails.js': "router.use(tenant.comPapel('admin'))",
  };
  for (const [rel, guarda] of Object.entries(ROTAS_MODULOS_ADMIN)) {
    const src = ler(rel);
    assert.ok(src.includes(guarda), `${rel} mantém comPapel('admin') no router`);
  }
  feito(`C. Módulos restritos mantêm comPapel('admin'): ${Object.keys(ROTAS_MODULOS_ADMIN).join(', ')}`);

  // Os módulos de placeholder reservados ao admin (Calendário/Tickets/Seguros)
  // continuam a exigir `admin` — provado na secção dos placeholders.
  const placeholdersSrc = ler('routes/placeholders.js');
  for (const modulo of ['calendario', 'tickets', 'seguros']) {
    const bloco = placeholdersSrc.slice(placeholdersSrc.indexOf(`${modulo}: {`));
    assert.ok(
      /minimo: 'admin'/.test(bloco.slice(0, 400)),
      `placeholder '${modulo}' continua reservado ao admin`
    );
  }
  feito('C. Placeholders Calendário/Tickets/Seguros continuam só para admin');

  // As rotas de gestão de utilizadores estão TODAS marcadas com `apenasAdmin`.
  const adminSrcSemComentarios = adminSrc.replace(/\/\/.*$/gm, '');
  const rotasUtilizadores = adminSrcSemComentarios
    .split('\n')
    .filter((l) => /^router\.(get|post|put|patch|delete)\('\/utilizadores/.test(l));
  assert.ok(rotasUtilizadores.length >= 10, `há ${rotasUtilizadores.length} rotas de utilizadores`);
  const semGuarda = rotasUtilizadores.filter((l) => !l.includes('apenasAdmin'));
  assert.deepStrictEqual(semGuarda, [], `rotas de utilizadores sem apenasAdmin:\n${semGuarda.join('\n')}`);
  feito(`C. As ${rotasUtilizadores.length} rotas de /admin/utilizadores exigem apenasAdmin (admin)`);

  // Um gestor NÃO é `admin`: `papelMaiorOuIgual` tem de recusar os dois sentidos.
  assert.ok(!tenant.papelMaiorOuIgual('gestor', 'admin'), 'gestor não satisfaz "admin"');
  assert.ok(tenant.papelMaiorOuIgual('admin', 'admin'), 'admin satisfaz "admin"');
  assert.ok(tenant.papelMaiorOuIgual('gestor', 'gestor'), 'gestor satisfaz "gestor"');
  assert.ok(tenant.papelMaiorOuIgual('admin', 'gestor'), 'admin satisfaz "gestor" (admin tem tudo)');
  feito('C. Hierarquia preservada: admin ⊇ gestor, gestor ⊉ admin');

  // O mínimo do router de `/admin` tem de coincidir com o destino que
  // `destinoInicial` dá a um `uc.role='gestor'` — é o invariante desta correção.
  assert.strictEqual(
    destinoAposLogin({ meus: [COND(5, 'gestor')], ativo: 5, user: USER({}) }).redirecionar,
    '/admin',
    'invariante: gestor → /admin'
  );
  feito('Invariante: o mínimo do guard de /admin coincide com o destino do gestor');

  // ── app.js monta /global e o shim, e /admin sem o router global ─────
  const appSrc2 = ler('app.js');
  assert.ok(appSrc2.includes("app.use('/global', require('./routes/global-admin'));"), 'app.js monta o router global em /global');
  assert.ok(appSrc2.includes("app.use('/admin/global', (req, res)"), 'app.js define o shim /admin/global');
  assert.ok(!appSrc2.includes("app.use('/admin', require('./routes/global-admin'));"), 'app.js já não monta o router global em /admin');
  assert.ok(appSrc2.includes("app.use('/admin', require('./routes/admin'));"), 'app.js monta o backoffice em /admin');
  // O shim tem de vir ANTES do backoffice, senão /admin/global cairia no 404 dele.
  assert.ok(
    appSrc2.indexOf("app.use('/admin/global'") < appSrc2.indexOf("app.use('/admin', require('./routes/admin'))"),
    'o shim é montado antes do backoffice de /admin'
  );
  feito('app.js: /global para o router global, shim antes do backoffice de /admin');

  servidor.close();
  console.log(`\n✓ Testes da arquitetura de autorização passaram (${nTestes} verificações, sem BD).`);
})().catch((err) => {
  servidor.close();
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
