// ═══════════════════════════════════════════════════════════════════
// Diagnóstico das credenciais de armazenamento (SOMENTE LEITURA).
//
// Responde, sem alterar nada e sem mostrar segredos:
//   1. o processo Node vê as variáveis técnicas necessárias?
//   2. a chave de cifragem está disponível e é a mesma que cifrou os tokens?
//   3. os tokens existentes continuam na base de dados e em que formato?
//   4. o que é preciso fazer (e o que NÃO é preciso: nada é apagado).
//
// Utilização (no ambiente da aplicação):
//   node scripts/diagnostico-credenciais.js
//   docker compose exec app node scripts/diagnostico-credenciais.js
//
// Este script NÃO escreve na base de dados, NÃO desliga nem religa serviços e
// NUNCA imprime tokens, chaves ou ciphertexts.
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const cifra = require('../helpers/armazenamento/cifra');
const ligacoes = require('../helpers/armazenamento/ligacoes');
const locator = require('../helpers/armazenamento/locator');

function linha(titulo) {
  console.log('');
  console.log('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 58 - titulo.length)));
}

// Presença de uma variável (nunca o valor; para chaves, só a impressão curta).
function presente(nome) {
  const valor = String(process.env[nome] || '').trim();
  return valor ? 'definida' : 'AUSENTE';
}

function impressaoDaChave(nome) {
  const valor = String(process.env[nome] || '').trim();
  if (!valor) return 'AUSENTE';
  try {
    const chave = cifra.interpretarChave(valor);
    return `definida (kid ${cifra.identificador(chave)})`;
  } catch (err) {
    return 'definida mas INVÁLIDA (não tem 32 bytes)';
  }
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Diagnóstico das credenciais de armazenamento (somente leitura)');
  console.log('══════════════════════════════════════════════════════════════');

  // ── 1. Ambiente do processo ───────────────────────────────────────
  linha('1. Ambiente do processo Node');
  const cwd = process.cwd();
  const envPath = path.join(cwd, '.env');
  console.log(`  NODE_ENV:              ${process.env.NODE_ENV || '(não definido)'}`);
  console.log(`  Diretório de trabalho: ${cwd}`);
  console.log(`  .env nesse diretório:  ${fs.existsSync(envPath) ? 'existe' : 'NÃO existe (o dotenv não carrega nada daqui)'}`);
  console.log(`  Cifragem (chave):      ENCRYPTION_KEY ${impressaoDaChave('ENCRYPTION_KEY')}`);
  console.log(`  Rotação:               ENCRYPTION_KEY_OLD ${presente('ENCRYPTION_KEY_OLD')}`);
  console.log(`  Serviço por omissão:   STORAGE_PROVIDER ${process.env.STORAGE_PROVIDER || '(não definido → google_drive)'}`);
  console.log('  Google Drive:');
  console.log(`    GOOGLE_DRIVE_ENABLED ${presente('GOOGLE_DRIVE_ENABLED')} · GOOGLE_CLIENT_ID ${presente('GOOGLE_CLIENT_ID')} · GOOGLE_CLIENT_SECRET ${presente('GOOGLE_CLIENT_SECRET')} · GOOGLE_REDIRECT_URI ${presente('GOOGLE_REDIRECT_URI')} · GOOGLE_REFRESH_TOKEN ${presente('GOOGLE_REFRESH_TOKEN')}`);
  console.log('  Dropbox:');
  console.log(`    DROPBOX_ENABLED ${presente('DROPBOX_ENABLED')} · DROPBOX_APP_KEY ${presente('DROPBOX_APP_KEY')} · DROPBOX_APP_SECRET ${presente('DROPBOX_APP_SECRET')} · DROPBOX_REDIRECT_URI ${presente('DROPBOX_REDIRECT_URI')}`);
  console.log('  Microsoft OneDrive:');
  console.log(`    ONEDRIVE_ENABLED ${presente('ONEDRIVE_ENABLED')} · ONEDRIVE_CLIENT_ID ${presente('ONEDRIVE_CLIENT_ID')} · ONEDRIVE_CLIENT_SECRET ${presente('ONEDRIVE_CLIENT_SECRET')} · ONEDRIVE_REDIRECT_URI ${presente('ONEDRIVE_REDIRECT_URI')}`);
  console.log(`  Links de email:        DOC_LINK_SECRET ${presente('DOC_LINK_SECRET')} · SESSION_SECRET ${presente('SESSION_SECRET')}`);

  // ── 2. Estado da cifragem ─────────────────────────────────────────
  linha('2. Estado da cifragem');
  const estadoCifra = cifra.estado();
  console.log(`  Chave configurada:   ${estadoCifra.configurada ? 'SIM' : 'NÃO'}`);
  console.log(`  Formato da cifra:    ${estadoCifra.formato} (${estadoCifra.algoritmo})`);
  if (estadoCifra.kid) console.log(`  Impressão da chave:  kid ${estadoCifra.kid}`);
  if (estadoCifra.anteriores) console.log(`  Chaves anteriores:   ${estadoCifra.anteriores} (para decifrar valores antigos)`);
  if (estadoCifra.erro) console.log(`  Problema na chave:   ${estadoCifra.erro}`);
  console.log(`  Mensagem mostrada na interface: ${estadoCifra.configurada ? '(nenhuma)' : estadoCifra.mensagem}`);

  // ── 3. Credenciais na base de dados ───────────────────────────────
  linha('3. Credenciais guardadas (nunca são mostrados valores)');
  let linhas = [];
  let bdLida = false;
  let erroBd = null;
  try {
    const { Configuracao } = require('../models');
    linhas = await Configuracao.findAll({ order: [['chave', 'ASC']] });
    bdLida = true;
  } catch (err) {
    erroBd = err.message;
    console.log(`  Não foi possível ler a base de dados: ${err.message}`);
    console.log('  (execute este diagnóstico no ambiente onde a aplicação corre)');
  }

  const credenciais = linhas.filter((l) => ligacoes.ehChaveDeCredenciais(l.chave));
  let emTextoSimples = 0;
  let cifradosChaveAtual = 0;
  let cifradosOutraChave = 0;
  let ilegiveis = 0;
  let vazios = 0;

  if (!credenciais.length) {
    console.log('  Nenhuma credencial de armazenamento guardada na base de dados.');
  }
  for (const l of credenciais) {
    const bruto = l.valor;
    if (!bruto) {
      vazios++;
      console.log(`  · ${l.chave}: vazio`);
      continue;
    }
    if (!cifra.estaCifrado(bruto)) {
      emTextoSimples++;
      console.log(`  · ${l.chave}: TEXTO SIMPLES (formato antigo, ainda não cifrado)`);
      continue;
    }
    const kid = String(bruto).split(':')[2];
    try {
      cifra.decifrar(bruto, { contexto: l.chave });
      const rotacao = cifra.precisaRecifrar(bruto);
      if (rotacao) {
        cifradosOutraChave++;
        console.log(`  · ${l.chave}: cifrado (kid ${kid}) — chave ANTERIOR; precisa recifragem com a chave atual`);
      } else {
        cifradosChaveAtual++;
        console.log(`  · ${l.chave}: cifrado (kid ${kid}) — decifra com a chave atual`);
      }
    } catch (err) {
      ilegiveis++;
      console.log(`  · ${l.chave}: cifrado (kid ${kid}) — NÃO decifra com a chave disponível (${err.codigo || 'erro'})`);
    }
  }
  console.log('');
  console.log(`  Resumo: ${credenciais.length} chave(s) → ${emTextoSimples} em texto simples, ${cifradosChaveAtual} cifradas com a chave atual, ${cifradosOutraChave} com chave anterior, ${ilegiveis} ilegíveis, ${vazios} vazias.`);

  // ── 4. Configuração não secreta ───────────────────────────────────
  linha('4. Configuração de armazenamento (não secreta)');
  const naoSecretas = linhas.filter((l) => !ligacoes.ehChaveDeCredenciais(l.chave) && String(l.chave).startsWith('storage:'));
  for (const l of naoSecretas) console.log(`  · ${l.chave} = ${String(l.valor || '').slice(0, 80)}`);
  const raizLegado = linhas.find((l) => l.chave === 'google_drive_root_folder');
  const backupsAntigo = linhas.find((l) => l.chave === 'drive_auto_backups');
  console.log(`  · google_drive_root_folder = ${raizLegado ? String(raizLegado.valor).slice(0, 60) : '(não definido)'}`);
  console.log(`  · drive_auto_backups = ${backupsAntigo ? String(backupsAntigo.valor) : '(não definido)'}`);
  try {
    const { Condominio, BackupLog } = require('../models');
    const condominios = await Condominio.findAll();
    const comPasta = condominios.filter((c) => c.drive_folder_id);
    console.log(`  · condomínios: ${condominios.length} (com pasta de Drive registada: ${comPasta.length})`);
    const ultimo = await BackupLog.findOne({ order: [['id', 'DESC']] });
    console.log(`  · último backup: ${ultimo ? `${new Date(ultimo.data).toISOString().slice(0, 16).replace('T', ' ')} (${ultimo.estado})` : 'nenhum'}`);
  } catch (err) {
    console.log(`  · não foi possível ler condomínios/backups: ${err.message}`);
  }

  // ── 5. Veredicto ──────────────────────────────────────────────────
  linha('5. O que fazer');
  const veredicto = [];
  let acaoNecessaria = false;

  if (!estadoCifra.configurada) {
    acaoNecessaria = true;
    veredicto.push('A chave de cifragem (ENCRYPTION_KEY) não está disponível para este processo Node.');
    if (!bdLida) {
      // Sem confirmar o formato dos tokens NÃO se pode dizer que gerar uma
      // chave nova é seguro — se já estiverem cifrados, isso inutilizava-os.
      veredicto.push('NÃO foi possível ler a base de dados, por isso não é possível confirmar em que formato estão os tokens.');
      veredicto.push('NÃO gere uma chave nova antes de confirmar. Corra o diagnóstico no ambiente da aplicação');
      veredicto.push('(por exemplo: docker compose exec app node scripts/diagnostico-credenciais.js) para ver,');
      veredicto.push('por chave, se está em texto simples ou cifrada (enc:v1 com o kid da chave usada).');
      veredicto.push('Motivo: ' + (erroBd || 'base de dados inacessível'));
    } else if (emTextoSimples > 0) {
      veredicto.push('Os tokens guardados estão em TEXTO SIMPLES: definir agora uma chave é seguro — ela serve');
      veredicto.push('apenas para os cifrar. NENHUMA ligação é apagada e NÃO é preciso voltar a autorizar contas.');
    } else if (credenciais.length === 0) {
      veredicto.push('Não existem credenciais guardadas na base de dados; defina a chave e ligue os serviços pela');
      veredicto.push('interface (Configurações → Armazenamento e Backups).');
    } else {
      veredicto.push('Os tokens JÁ ESTÃO CIFRADOS: é obrigatório usar a MESMA chave que os cifrou.');
      veredicto.push('NÃO gere uma chave nova. Recupere o valor original (do .env do deploy anterior, gestor de');
      veredicto.push('segredos ou cópia de segurança) e coloque-o em ENCRYPTION_KEY. Se tiver a antiga e a nova,');
      veredicto.push('coloque a antiga em ENCRYPTION_KEY_OLD e corra: node scripts/migrar-tokens-cifrados.js');
    }
    veredicto.push('Onde colocar a variável: no ambiente do serviço (systemd EnvironmentFile / docker-compose');
    veredicto.push('environment:), não apenas no .env — ver docs/ARMAZENAMENTO.md, secção de recuperação.');
  } else if (cifradosOutraChave > 0 || ilegiveis > 0) {
    acaoNecessaria = true;
    veredicto.push('A chave disponível não corresponde à que cifrou alguns tokens.');
    veredicto.push('Disponibilize a chave antiga (ENCRYPTION_KEY_OLD) e corra node scripts/migrar-tokens-cifrados.js');
    veredicto.push('para recifrar tudo com a chave atual. Não é preciso voltar a autorizar contas.');
  } else if (emTextoSimples > 0) {
    acaoNecessaria = true;
    veredicto.push('Existem tokens em texto simples que serão cifrados automaticamente no arranque da aplicação');
    veredicto.push('(ou já agora, com node scripts/migrar-tokens-cifrados.js). Nada é perdido.');
  } else {
    veredicto.push('Tudo coerente: a chave está disponível e os tokens decifram com ela.');
    veredicto.push('Se a interface continuar a mostrar os serviços como não ligados, reinicie o serviço Node');
    veredicto.push('(o estado das ligações é carregado no arranque) e volte a abrir Configurações → Armazenamento e Backups.');
  }

  veredicto.push('');
  veredicto.push('Nada foi apagado: este diagnóstico não escreve na base de dados e o aviso da interface é');
  veredicto.push('apenas a proteção que impede usar credenciais não cifradas.');

  for (const v of veredicto) console.log(v ? '  ' + v : '');

  console.log('');
  console.log(acaoNecessaria ? '→ Ação necessária (ver acima).' : '→ Nenhuma ação necessária.');
  console.log('');
  process.exit(acaoNecessaria ? 1 : 0);
}

main().catch((err) => {
  console.error('');
  console.error('✗ Diagnóstico interrompido: ' + err.message);
  console.error('');
  process.exit(2);
});
