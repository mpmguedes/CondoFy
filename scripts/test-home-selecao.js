// Testes do fluxo "LOGIN → Os meus condomínios" — sem base de dados.
// Utilização: node scripts/test-home-selecao.js
//
// Nota (arquitetura): o destino pós-login passou a ser decidido pelo papel no
// CONDOMÍNIO ATIVO (`utilizador_condominios.role`), via `tenant.destinoInicial`.
// `users.role` é legado e já não participa — é por isso que os casos abaixo
// usam o papel do condomínio (`meus[].role`) e não `user.role`.
const assert = require('assert');
const { destinoAposLogin } = require('../routes/index');

// Papel do condomínio ativo (fonte de verdade), como o devolve `listarCondominios`.
const meu = (id, role) => ({ id, role });

function testar() {
  // 1. Um único condomínio e SEM ativo → NUNCA entra direto.
  let d = destinoAposLogin({ meus: [meu(3, 'admin')], ativo: null, user: { role: 'admin' } });
  assert.strictEqual(d.redirecionar, '/condominios', 'sem ativo → seleção (mesmo com 1 condomínio)');

  // 2. Ativo válido → dashboard conforme o papel DO CONDOMÍNIO.
  d = destinoAposLogin({ meus: [meu(3, 'admin')], ativo: 3, user: { role: 'admin' } });
  assert.strictEqual(d.redirecionar, '/admin', 'com ativo escolhido (uc.role=admin) → painel');
  d = destinoAposLogin({ meus: [meu(5, 'gestor')], ativo: 5, user: { role: 'condomino' } });
  assert.strictEqual(d.redirecionar, '/admin', 'uc.role=gestor → painel (users.role é irrelevante)');
  d = destinoAposLogin({ meus: [meu(3, 'leitura'), meu(5, 'leitura')], ativo: 5, user: { role: 'condomino' } });
  assert.strictEqual(d.redirecionar, '/condomino', 'vários com ativo de leitura → área do condómino');

  // 3. Ativo inválido (não associado) → limpa e pede seleção.
  d = destinoAposLogin({ meus: [meu(3, 'admin')], ativo: 99, user: { role: 'admin' } });
  assert.strictEqual(d.redirecionar, '/condominios', 'ativo inválido → seleção');
  assert.strictEqual(d.limparAtivo, true, 'ativo inválido é limpo');

  // 4. Super Admin sem condomínio ativo → painel de administração global.
  //    (Antes ia para /condominios; com o namespace global separado, a área
  //    natural de quem tem privilégio global é o painel global.)
  d = destinoAposLogin({ meus: [], ativo: null, user: { role: 'condomino', role_global: 'super_admin' } });
  assert.strictEqual(d.redirecionar, '/global', 'super admin sem ativo → painel global');

  // 5. INVARIANTE CENTRAL — SUPER-ADMIN ≠ ADMIN DE CONDOMÍNIO.
  //    Um super admin com um id de condomínio na sessão mas SEM associação NÃO
  //    ganha contexto de condomínio: vai para o painel global. Antes isto era
  //    «modo suporte» e mandava-o para `/admin` — ou seja, a administração da
  //    plataforma convertia-se em administração do condomínio. O acesso de
  //    suporte é agora uma concessão própria (`acessos_suporte`), com motivo e
  //    prazo, resolvida em `comCondominioAtivo` e nunca pelo destino pós-login.
  d = destinoAposLogin({ meus: [], ativo: 7, user: { role: 'condomino', role_global: 'super_admin' } });
  assert.strictEqual(d.redirecionar, '/global', 'super admin sem associação → painel global (nunca /admin)');
  assert.notStrictEqual(d.redirecionar, '/admin', 'um id na sessão NÃO dá contexto de condomínio');
  assert.strictEqual(d.modoSuporte, false, 'não existe modo suporte implícito');
  assert.strictEqual(d.limparAtivo, true, 'o ativo órfão é limpo');

  // 6. O único caminho para `/admin` é a ASSOCIAÇÃO REAL — em todos os papéis
  //    de gestão e com o eixo global ligado ou desligado.
  for (const role_global of [null, 'super_admin']) {
    for (const papel of ['admin', 'gestor']) {
      d = destinoAposLogin({ meus: [meu(7, papel)], ativo: 7, user: { role: 'condomino', role_global } });
      assert.strictEqual(d.redirecionar, '/admin', `${papel} associado → /admin (role_global=${role_global})`);
    }
  }
}

testar();
console.log('✓ Testes do fluxo de seleção de condomínio passaram (sem BD).');
