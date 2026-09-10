// ═══════════════════════════════════════════════════════════════════
// Migração dos tokens OAuth de armazenamento para formato CIFRADO.
//
// Converte de uma só vez os valores que ainda estejam em texto simples na
// tabela `configuracoes` (chaves `google_drive_tokens` e
// `storage:tokens:<provedor>:<condominio|plataforma>`) para o formato
// `enc:v1:…` (AES-256-GCM), usando ENCRYPTION_KEY.
//
// As ligações OAuth existentes NÃO são afetadas: os tokens são os mesmos,
// apenas passam a estar cifrados em repouso. Não é preciso autorizar
// novamente nenhuma conta.
//
// Utilização:
//   node scripts/migrar-tokens-cifrados.js             (migra)
//   node scripts/migrar-tokens-cifrados.js --verificar  (só relata; não altera)
//
// A migração também acontece automaticamente ao ler/gravar credenciais
// (helpers/armazenamento/ligacoes.js); este script serve para converter tudo
// de uma vez e confirmar que não resta nenhum valor em texto simples.
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();
const { Configuracao } = require('../models');
const cifra = require('../helpers/armazenamento/cifra');
const ligacoes = require('../helpers/armazenamento/ligacoes');

const SO_VERIFICAR = process.argv.includes('--verificar');

async function main() {
  const estado = cifra.estado();
  if (!estado.configurada) {
    console.error('✗ ENCRYPTION_KEY não está configurada nesta instalação.');
    console.error('');
    console.error('  Gere uma chave aleatória de 32 bytes com:');
    console.error('    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    console.error('');
    console.error('  Guarde-a no .env desta instalação (nunca no Git; nunca reutilize');
    console.error('  uma chave que tenha aparecido em terminais, logs ou conversas):');
    console.error('    ENCRYPTION_KEY=<chave gerada>');
    console.error('');
    if (estado.erro) console.error('  Detalhe: ' + estado.erro);
    process.exit(1);
  }

  const linhas = await Configuracao.findAll({ order: [['chave', 'ASC']] });
  const credenciais = linhas.filter((l) => ligacoes.ehChaveDeCredenciais(l.chave));

  let jaCifrados = 0;
  let migrados = 0;
  let vazios = 0;
  const problemas = [];

  for (const linha of credenciais) {
    const bruto = linha.valor;
    if (bruto == null || bruto === '') {
      vazios++;
      continue;
    }
    if (cifra.estaCifrado(bruto)) {
      // Verifica se decifra com a chave atual (ou com ENCRYPTION_KEY_OLD).
      try {
        cifra.decifrar(bruto, { contexto: linha.chave });
        if (cifra.precisaRecifrar(bruto)) {
          if (SO_VERIFICAR) {
            problemas.push(`${linha.chave}: cifrado com chave anterior (rotação pendente)`);
          } else {
            const r = cifra.garantirCifrado(bruto, { contexto: linha.chave });
            await linha.update({ valor: r.valor });
            migrados++;
          }
        } else {
          jaCifrados++;
        }
      } catch (err) {
        problemas.push(`${linha.chave}: ${err.message}`);
      }
      continue;
    }

    // Texto simples (formato antigo).
    if (SO_VERIFICAR) {
      problemas.push(`${linha.chave}: ainda em texto simples`);
      continue;
    }
    try {
      const r = cifra.garantirCifrado(bruto, { contexto: linha.chave });
      if (r.alterado) {
        await linha.update({ valor: r.valor });
        migrados++;
      } else {
        vazios++;
      }
    } catch (err) {
      problemas.push(`${linha.chave}: ${err.message}`);
    }
  }

  // Confirmação: nenhum valor de credenciais pode continuar em texto simples.
  const depois = credenciais.length
    ? await Configuracao.findAll({ where: { chave: credenciais.map((l) => l.chave) } })
    : [];
  const restantesTextoSimples = depois.filter((l) => l.valor && !cifra.estaCifrado(l.valor));

  console.log('');
  console.log(`Chaves de credenciais encontradas: ${credenciais.length}`);
  console.log(`  já cifradas:      ${jaCifrados}`);
  console.log(`  migradas agora:   ${migrados}`);
  console.log(`  vazias/ignoradas: ${vazios}`);
  if (problemas.length) {
    console.log('');
    console.log('Atenção:');
    for (const p of problemas) console.log(`  · ${p}`);
  }
  console.log('');
  if (restantesTextoSimples.length) {
    console.error(`✗ Ainda existem ${restantesTextoSimples.length} valor(es) de credenciais em texto simples.`);
    process.exit(1);
  }
  if (SO_VERIFICAR && problemas.length) {
    console.error('✗ Verificação: há credenciais a migrar (corra sem --verificar para as converter).');
    process.exit(1);
  }
  console.log(SO_VERIFICAR ? '✓ Verificação: todas as credenciais estão cifradas.' : '✓ Migração concluída: nenhuma credencial em texto simples.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Falha na migração: ' + err.message);
  process.exit(1);
});
