// Testes das vistas da Nova Convocatória (Handlebars) — sem base de dados.
// Utilização: node scripts/test-vistas.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('../helpers/handlebars-helpers');
const { construirDocumento } = require('../helpers/convocatoria');

const ROOT = path.join(__dirname, '..', 'views');

function ler(relativa) {
  return fs.readFileSync(path.join(ROOT, relativa), 'utf8');
}

Object.keys(helpers).forEach((k) => handlebars.registerHelper(k, helpers[k]));

const parciais = {
  '_flash': ler('partials/_flash.handlebars'),
  '_empty-state': ler('partials/_empty-state.handlebars'),
  '_convocatoria-documento': ler('partials/_convocatoria-documento.handlebars'),
  '_convocatoria-editor': ler('partials/_convocatoria-editor.handlebars'),
  '_condominio-seletor': ler('partials/_condominio-seletor.handlebars'),
  '_bottom-bar': ler('partials/_bottom-bar.handlebars'),
  '_quotas-tabs': ler('partials/_quotas-tabs.handlebars'),
  '_assembleias-tabs': ler('partials/_assembleias-tabs.handlebars'),
};
Object.keys(parciais).forEach((k) => handlebars.registerPartial(k, parciais[k]));

const layout = handlebars.compile(ler('layouts/main.handlebars'));
const nova = handlebars.compile(ler('admin/convocatorias/nova.handlebars'));
const editor = handlebars.compile(parciais['_convocatoria-editor']);
const documento = handlebars.compile(parciais['_convocatoria-documento']);

const valores = {
  edificio_nome: 'Condomínio do Edifício Residencial Vista Mar',
  morada: 'Rua Doutor António José de Almeida, 1234',
  codigo_postal: '1000-000',
  cidade: 'Lisboa',
  administracao_nome: 'Gestcondomínio, Unipessoal Lda.',
  reuniao_numero: '2026/1',
  tipo: 'ordinaria',
  data: '2026-09-04',
  hora: '19:47',
  local: 'Salão de festas do edifício, piso 0',
  data_emissao: '2026-08-28',
  email_autorizado: true,
  pontos: ['Aprovação do orçamento para 2027', 'Apresentação e aprovação das contas', 'Eleição da administração'],
};

const previa = construirDocumento({
  edificioNome: valores.edificio_nome,
  morada: valores.morada,
  codigoPostal: valores.codigo_postal,
  cidade: valores.cidade,
  administracaoNome: valores.administracao_nome,
  numero: valores.reuniao_numero,
  tipo: valores.tipo,
  data: valores.data,
  hora: valores.hora,
  local: valores.local,
  dataEmissao: valores.data_emissao,
  emailAutorizado: valores.email_autorizado,
  pontos: valores.pontos,
});

const contexto = {
  titulo: 'Nova Convocatória',
  valores,
  previa: null,
  user: { nome: 'Admin', email: 'admin@exemplo.pt' },
  isAdmin: true,
  condominio: { designacao: valores.edificio_nome },
  currentPath: '/admin/convocatorias/nova',
};

// 1. Modo edição
let html = nova(contexto);
assert.ok(html.includes('Nova Convocatória'), 'título presente');
assert.ok(html.includes('assembleias-tabs'), 'tab Convocatórias dentro do módulo Assembleias');
assert.ok(html.includes('name="edificio_nome"'), 'campo edifício');
assert.ok(html.includes('name="pontos[]"'), 'inputs de pontos');
assert.ok(html.includes('name="_acao" value="preview"'), 'botão pré-visualizar');
assert.ok(html.includes('name="_acao" value="pdf"'), 'botão gerar PDF');

// 2. Modo pré-visualização
html = nova({ ...contexto, previa });
assert.ok(html.includes('cv-preview-papel'), 'zona de pré-visualização');
assert.ok(html.includes('Convocatória para Assembleia Geral Ordinária'), 'título do documento');
assert.ok(html.includes('20:17'), '2.ª convocatória calculada visível');
assert.ok(html.includes('Reunião n.º 2026/1'), 'número da reunião');
assert.ok(html.includes('Gestcondomínio'), 'administração presente');
assert.ok(html.includes('Aprovação do orçamento para 2027'), 'ponto da ordem de trabalhos');
assert.ok(html.includes('500 permilagens'), 'quórum 500 permilagens');
assert.ok(html.includes('250 permilagens'), 'quórum 250 permilagens');
assert.ok(html.includes('Comunicação por email autorizada em assembleia anterior.'), 'rodapé email');

// 3. Extraordinária
const previaExtra = construirDocumento({ ...previa, tipo: 'extraordinaria', numero: '2026/2' });
html = documento({ doc: previaExtra });
assert.ok(html.includes('Convocatória para Assembleia Geral Extraordinária'), 'título extraordinária');

// 4. Editor isolado (render sem erros, mantém valores)
html = editor({ v: valores });
assert.ok(html.includes('value="19:47"'), 'hora preservada no editor');

// 5. Layout principal integra o item de navegação
html = layout({ body: 'ok', user: contexto.user, isAdmin: true, condominio: contexto.condominio, currentPath: '/admin/convocatorias/nova' });
assert.ok(!html.includes('title="Nova Convocatória"'), 'sidebar: Convocatórias já não é entrada independente (tab em Assembleias)');
assert.ok(html.includes('href="/admin/assembleias"'), 'sidebar: Assembleias presente');

// 6. Página de Configuração — estados do Google Drive
const config = handlebars.compile(ler('admin/configuracao/index.handlebars'));
const condConfig = {
  designacao: 'Condomínio Teste',
  administracao_nome: 'Gestão, Lda.',
  website: null,
  nif: '500000000',
  morada: 'Rua X',
  codigo_postal: '1000-000',
  localidade: 'Lisboa',
  email: null,
  telefone: null,
  iban_principal: null,
  outros_meios_pagamento: null,
  dados_bancarios_adicionais: null,
  identidade_visual: 'designacao',
  logotipo: null,
};
const ctxConfig = { titulo: 'Configuração do condomínio', condominio: condConfig };

html = config({ ...ctxConfig, driveLigado: false, driveEstado: { ativo: true, credenciais: true, ligado: false, viaEnv: false, conta: null, redirectUriDefinido: true }, driveOpcoes: { pastaRaiz: 'CondoFy', backupsDrive: true }, ultimoBackup: null });
assert.ok(html.includes('Ligar Google Drive'), 'config: botão ligar quando não ligado');
assert.ok(html.includes('Desligado'), 'config: estado desligado');

html = config({ ...ctxConfig, driveLigado: true, driveEstado: { ativo: true, credenciais: true, ligado: true, viaEnv: false, conta: 'admin@gmail.com', redirectUriDefinido: true }, driveOpcoes: { pastaRaiz: 'CondoFy', backupsDrive: true }, ultimoBackup: null });
assert.ok(html.includes('admin@gmail.com'), 'config: conta ligada visível');
assert.ok(html.includes('Desligar'), 'config: botão desligar');
assert.ok(html.includes('Abrir Google Drive'), 'config: abrir drive');
assert.ok(html.includes('Testar ligação'), 'config: testar ligação');
assert.ok(html.includes('Pasta de destino no Google Drive'), 'config: opções de armazenamento');

html = config({ ...ctxConfig, driveLigado: true, driveEstado: { ativo: true, credenciais: true, ligado: true, viaEnv: true, conta: null, redirectUriDefinido: true }, driveOpcoes: { pastaRaiz: 'CondoFy', backupsDrive: true }, ultimoBackup: { data: new Date(), tipo: 'diario', estado: 'concluido', erro: null } });
assert.ok(html.includes('via .env'), 'config: estado legado via .env');
assert.ok(html.includes('Último backup'), 'config: último backup visível');

html = config({ ...ctxConfig, driveLigado: false, driveEstado: { ativo: false, credenciais: false, ligado: false, viaEnv: false, conta: null, redirectUriDefinido: false }, driveOpcoes: { pastaRaiz: 'CondoFy', backupsDrive: true }, ultimoBackup: null });
assert.ok(html.includes('Desativado'), 'config: integração desativada');

// 7. Central de Emails (vista)
const emailsView = handlebars.compile(ler('admin/emails/index.handlebars'));
const estadoSmtp = { configurado: true, servidor: 'smtp.gmail.com', porta: '587', utilizador: 'condominio@gmail.com', remetente: 'condominio@gmail.com', nomeRemetente: 'Administração', seguranca: 'STARTTLS (587)', temPassword: true };
const preferencias = [{ evento: 'recibos', rotulo: 'Recibos', email: true, drive: false }, { evento: 'quotas_atraso', rotulo: 'Quotas em atraso', email: true, drive: false }];
html = emailsView({
  titulo: 'Emails',
  emails: [{
    id: 1,
    destinatario_email: 'joao@exemplo.pt',
    destinatario_nome: 'João',
    assunto: 'Recibo 2026/1',
    estado: 'pendente',
    tentativas: 0,
    message_id: null,
    erro: null,
    createdAt: new Date(),
    documento: null,
    aviso: null,
  }],
  filtro: 'pendentes',
  contagens: { total: 1, pendentes: 1, enviados: 0, erros: 0, cancelados: 0 },
  estadoSmtp,
  preferencias,
  estadosLabel: { pendente: 'Pendente', a_enviar: 'A enviar', enviado: 'Enviado', erro: 'Erro', cancelado: 'Cancelado' },
});
assert.ok(html.includes('joao@exemplo.pt'), 'emails: destinatário na lista');
assert.ok(html.includes('smtp.gmail.com'), 'emails: SMTP visível');
assert.ok(html.includes('Enviar email de teste'), 'emails: botão de teste');
assert.ok(html.includes('reenviar'), 'emails: ação reenviar');
assert.ok(html.includes('Notificações automáticas'), 'emails: secção notificações');
assert.ok(html.includes('notif_recibos_email'), 'emails: preferência recibo');

html = emailsView({ titulo: 'Emails', emails: [], filtro: 'todas', contagens: { total: 0, pendentes: 0, enviados: 0, erros: 0, cancelados: 0 }, estadoSmtp: { configurado: false, servidor: null, porta: null, utilizador: null, remetente: null, nomeRemetente: null, seguranca: 'Sem TLS', temPassword: false }, preferencias: [], estadosLabel: {} });
assert.ok(html.includes('Sem emails neste filtro'), 'emails: estado vazio');
assert.ok(html.includes('Não configurado'), 'emails: SMTP vazio');

// 8. Navegação — novo item Emails
html = layout({ body: 'ok', user: contexto.user, isAdmin: true, condominio: contexto.condominio, currentPath: '/admin/emails' });
assert.ok(html.includes('/admin/emails'), 'link de navegação Emails');

// 9. Documentos — lista com estado Drive + ações
const docsListar = handlebars.compile(ler('admin/documentos/listar.handlebars'));
html = docsListar({
  titulo: 'Documentos',
  documentos: [{ id: 5, nome: 'Ata 10/01', pasta: 'atas', tipo: 'ata', data: new Date('2026-01-10'), url: 'https://drive.google.com/x', drive_status: 'guardado', drive_erro: null }],
  pasta: null,
  pastas: { atas: 'Atas', convocatorias: 'Convocatórias', contratos: 'Contratos', regulamentos: 'Regulamentos', recibos: 'Recibos de Pagamento', assembleias: 'Assembleias', apolices: 'Seguros — Apólices', comprovativos: 'Seguros — Comprovativos', faturas: 'Faturas', outros: 'Outros' },
  driveLigado: true,
});
assert.ok(html.includes('☁ Guardado'), 'documentos: estado guardado visível');
assert.ok(html.includes('/admin/documentos/5/email'), 'documentos: ação enviar email');

// 10. Documentos — página de envio por email
const docsEmail = handlebars.compile(ler('admin/documentos/email.handlebars'));
html = docsEmail({
  titulo: 'Enviar documento por email',
  documento: { id: 5, nome: 'Ata 10/01', pasta: 'atas', data: new Date('2026-01-10'), url: 'https://drive.google.com/x', drive_status: 'guardado' },
  pessoas: [{ id: 1, nome: 'João Silva', email: 'joao@exemplo.pt' }],
  driveLigado: true,
});
assert.ok(html.includes('joao@exemplo.pt'), 'email doc: destinatários');
assert.ok(html.includes('Abrir no Google Drive'), 'email doc: link do documento');

// 11. Administração global (Super Admin) — vistas + navegação
const globalIndex = handlebars.compile(ler('admin/global/index.handlebars'));
html = globalIndex({ titulo: 'Administração global', resumo: { condominios: 3, ativos: 2, inativos: 1, utilizadores: 9, superAdmins: 1, auditoria: 42 } });
assert.ok(html.includes('Administração global'), 'global: título do painel');
assert.ok(html.includes('/admin/global/condominios'), 'global: link condomínios');
assert.ok(html.includes('/admin/global/utilizadores'), 'global: link utilizadores');
assert.ok(html.includes('/admin/global/auditoria'), 'global: link auditoria');

const globalCondominios = handlebars.compile(ler('admin/global/condominios.handlebars'));
html = globalCondominios({ titulo: 'Condomínios · Global', lista: [{ id: 1, designacao: 'Condomínio Jardim', morada: 'Rua A', estado: 'ativo', fracoes: 4, membros: 2 }, { id: 2, designacao: 'Condomínio Mar', morada: null, estado: 'inativo', fracoes: 0, membros: 0 }] });
assert.ok(html.includes('Condomínio Jardim'), 'global cond: nome na lista');
assert.ok(html.includes('Desativado'), 'global cond: badge desativado');
assert.ok(html.includes('name="designacao"'), 'global cond: formulário de criação');

const globalDetalhe = handlebars.compile(ler('admin/global/condominio.handlebars'));
html = globalDetalhe({
  titulo: 'Condomínio Jardim',
  condominio: { id: 1, designacao: 'Condomínio Jardim', estado: 'ativo' },
  nFracoes: 4,
  associacoes: [{ id: 9, role: 'admin', estado: 'ativo', utilizador: { nome: 'Ana', email: 'ana@exemplo.pt' } }, { id: 10, role: 'leitura', estado: 'inativo', utilizador: { nome: 'Bruno', email: 'bruno@exemplo.pt' } }],
});
assert.ok(html.includes('ana@exemplo.pt'), 'global detalhe: membro visível');
assert.ok(!html.includes('name="confirmo"'), 'global detalhe: sem zona eliminar quando ativo');
assert.ok(html.includes('/associacoes/9/estado'), 'global detalhe: alterar papel/estado de associação');
html = globalDetalhe({ titulo: 'Condomínio Mar', condominio: { id: 2, designacao: 'Condomínio Mar', estado: 'inativo' }, nFracoes: 0, associacoes: [] });
assert.ok(html.includes('name="confirmo"'), 'global detalhe: eliminar exige confirmação quando inativo');
assert.ok(html.includes('Reativar condomínio'), 'global detalhe: botão reativar quando inativo');

const globalUtilizadores = handlebars.compile(ler('admin/global/utilizadores.handlebars'));
html = globalUtilizadores({ titulo: 'Utilizadores · Global', utilizadores: [{ id: 1, nome: 'Ana', email: 'ana@exemplo.pt', ativo: true, email_confirmado: true, role_global: 'super_admin', associacoes: 3 }, { id: 2, nome: 'Bruno', email: 'bruno@exemplo.pt', ativo: true, email_confirmado: false, role_global: null, associacoes: 1 }] });
assert.ok(html.includes('Super Admin'), 'global users: badge super admin');
assert.ok(html.includes('Email por confirmar'), 'global users: badge email por confirmar');
assert.ok(html.includes('/admin/global/utilizadores/1/global'), 'global users: ação papel global');

const globalAuditoria = handlebars.compile(ler('admin/global/auditoria.handlebars'));
html = globalAuditoria({
  titulo: 'Auditoria · Global',
  registos: [{ id: 1, acao: 'condominio_criado', entidade: 'Condominio', entidade_id: 3, data_hora: new Date('2026-02-01T10:00:00'), detalhes: null, user: { nome: 'Ana', email: 'ana@exemplo.pt' } }],
  acoes: ['condominio_criado', 'entrar_condominio'],
  filtros: { acao: '', entidade: '' },
});
assert.ok(html.includes('condominio_criado'), 'global auditoria: ação listada');
assert.ok(html.includes('ana@exemplo.pt'), 'global auditoria: utilizador do registo');
assert.ok(html.includes('name="acao"'), 'global auditoria: filtro por ação');

// 12. Sidebar — ligação à administração global só para Super Admin
html = layout({ body: 'ok', user: { nome: 'Ana', role: 'condomino', role_global: 'super_admin' }, isAdmin: true, condominio: contexto.condominio, currentPath: '/admin/global' });
assert.ok(html.includes('href="/admin/global"'), 'sidebar: link Global visível para super_admin');
html = layout({ body: 'ok', user: { nome: 'Bruno', role: 'admin' }, isAdmin: true, condominio: contexto.condominio, currentPath: '/admin/quotas' });
assert.ok(!html.includes('Administração global'), 'sidebar: grupo Global oculto sem super_admin');

// 13. Navegação — Amenidades removida da sidebar; barra inferior móvel
html = layout({ body: 'ok', user: { nome: 'Ana', role: 'admin' }, isAdmin: true, condominio: contexto.condominio, currentPath: '/admin/quotas/recibos' });
assert.ok(!html.includes('/admin/amenidades'), 'nav: Amenidades removida da sidebar');
assert.ok(html.includes('mobile-bottom-bar'), 'nav: barra inferior móvel presente');
assert.ok(html.includes('href="/admin/quotas/recibos"'), 'nav: atalho Recibos na barra inferior');
assert.ok(html.includes('href="/admin/quotas"'), 'nav: atalho Quotas na barra inferior');
assert.ok(html.includes('href="/admin/avisos"'), 'nav: atalho Avisos na barra inferior');
assert.ok(html.includes('mb-item-ativo'), 'nav: item ativo assinalado na barra inferior (recibos)');
html = layout({ body: 'ok', user: { nome: 'Bruno', role: 'condomino' }, isAdmin: false, condominio: contexto.condominio, currentPath: '/condomino' });
assert.ok(html.includes('href="/condominios"'), 'nav condómino: atalho Os meus condomínios na barra inferior');
assert.ok(html.includes('href="/condomino"'), 'nav condómino: atalho A minha área na barra inferior');

// 14. Sidebar — reorganização: apenas "Quotas" (Extra/Recibos/Comprovativos são tabs)
html = layout({ body: 'ok', user: { nome: 'Ana', role: 'admin' }, isAdmin: true, condominio: contexto.condominio, currentPath: '/admin/quotas/recibos' });
assert.ok(!html.includes('sidebar-item-sub'), 'nav: sem subitens Quotas Extra/Recibos/Comprovativos na sidebar');
assert.ok(!/title="Quotas Extraordinárias"/.test(html), 'nav: Quotas Extra não é entrada da sidebar');
assert.ok(html.includes('sidebar-group-title">Assembleias'), 'nav: grupo Assembleias presente');
assert.ok(html.includes('sidebar-group-title">Documentos'), 'nav: grupo Documentos separado');

// 15. Placeholder inteligente com sugestão contextual
const placeholder = handlebars.compile(ler('admin/placeholder.handlebars'));
html = placeholder({ modulo: 'Votações', icono: 'how_to_vote', sugestao: 'As votações são preparadas nas Assembleias.', linkTexto: 'Ir para Assembleias', link: '/admin/assembleias' });
assert.ok(html.includes('Em desenvolvimento'), 'placeholder: título de desenvolvimento');
assert.ok(html.includes('/admin/assembleias'), 'placeholder: sugestão com link contextual');
assert.ok(html.includes('Entretanto, pode:'), 'placeholder: caixa de sugestão presente');

// 16. Sidebar papel-aware: gestor não vê itens de plataforma/admin
const ctxGestor = {
  body: 'ok',
  user: { nome: 'Gestor', role: 'condomino' },
  isAdmin: true,
  condominio: contexto.condominio,
  condominioAtivo: { role: 'gestor' },
  currentPath: '/admin/quotas',
};
html = layout(ctxGestor);
assert.ok(!html.includes('href="/admin/emails"'), 'gestor: sem link Emails');
assert.ok(!html.includes('sidebar-group-title">Sistema'), 'gestor: sem grupo Sistema');
assert.ok(!html.includes('href="/admin/tickets"'), 'gestor: sem link Tickets');
assert.ok(html.includes('href="/admin/avisos"'), 'gestor: mantém Comunicações');
assert.ok(html.includes('href="/admin/fornecedores"'), 'gestor: mantém Fornecedores');
html = layout({ ...ctxGestor, condominioAtivo: { role: 'admin' } });
assert.ok(html.includes('href="/admin/emails"'), 'admin: link Emails presente');
assert.ok(html.includes('sidebar-group-title">Sistema'), 'admin: grupo Sistema presente');

// 17. Documentos — biblioteca visual e listagem interna por categoria/pasta
const docBiblio = handlebars.compile(ler('admin/documentos/biblioteca.handlebars'));
html = docBiblio({
  categorias: [
    { chave: 'outros', titulo: 'Outros', icone: 'folder', descricao: 'Diversos', pastas: ['outros'], contagem: 0, href: '/admin/documentos?pastas=outros' },
    { chave: 'recibos', titulo: 'Recibos de Pagamento', icone: 'receipt_long', descricao: 'Recibos', pastas: ['recibos'], contagem: 7, href: '/admin/documentos?pastas=recibos' },
  ],
  personalizadas: [{ chave: 'c-obras', titulo: 'Obras', icone: 'create_new_folder', descricao: 'Pasta personalizada', pastas: ['c-obras'], contagem: 0, href: '/admin/documentos?pastas=c-obras' }],
  total: 7,
});
assert.ok(html.includes('doc-card'), 'biblioteca: cartões presentes');
assert.ok(html.includes('href="/admin/documentos?pastas=outros"'), 'biblioteca: Outros clicável');
assert.ok(html.includes('Sem documentos'), 'biblioteca: pasta vazia mostra "Sem documentos"');
assert.ok(html.includes('7 documentos'), 'biblioteca: contagem visível');
const docLista = handlebars.compile(ler('admin/documentos/listar.handlebars'));
html = docLista({ documentos: [], pasta: null, pastasMulti: ['recibos'], rotulo: 'Recibos de Pagamento', nDocumentos: 0, pastas: { recibos: 'Recibos de Pagamento', outros: 'Outros' }, pastaCustom: null, driveLigado: true });
assert.ok(html.includes('Voltar à biblioteca'), 'listagem: botão voltar à biblioteca');
assert.ok(html.includes('Biblioteca'), 'listagem: breadcrumb da biblioteca');

// 18. Área do Condómino — páginas de consulta (Fase 1)
const baseCond = { pessoa: {}, linhas: [], extras: [], anos: [], filtros: { ano: '', estado: '' }, avisos: [], assembleiasProximas: [], documentosRecentes: [], resumo: { saldoContas: 0, fundoReserva: 0, receitas: 0, despesas: 0, contas: [] }, orcamento: { ano: 2026, orcamentado: 0, executado: 0, percentagem: 0 }, pastas: {}, documentos: null, agrupados: [] };
const comp = (f) => handlebars.compile(ler(f));
html = comp('condomino/dashboard.handlebars')({ ...baseCond, user: { nome: 'Ana' }, condominio: { designacao: 'X' } });
assert.ok(html.includes('A minha situação') || html.includes('Situação do condomínio'), 'condómino dashboard renderiza');
html = comp('condomino/quotas.handlebars')(baseCond);
assert.ok(html.includes('As minhas quotas'), 'condómino quotas');
html = comp('condomino/pagamentos.handlebars')(baseCond);
assert.ok(html.includes('Os meus pagamentos'), 'condómino pagamentos');
html = comp('condomino/recibos.handlebars')(baseCond);
assert.ok(html.includes('Os meus recibos'), 'condómino recibos');
html = comp('condomino/documentos.handlebars')(baseCond);
assert.ok(html.includes('Documentos do condomínio'), 'condómino documentos públicos');
// Sidebar do condómino (sem admin)
html = layout({ body: 'ok', user: { nome: 'Ana', role: 'condomino' }, isAdmin: false, condominio: contexto.condominio, currentPath: '/condomino/quotas' });
assert.ok(html.includes('href="/condomino/quotas"'), 'sidebar condómino: Quotas');
assert.ok(html.includes('href="/condomino/recibos"'), 'sidebar condómino: Recibos');

console.log('✓ Todas as vistas da convocatória renderizam corretamente.');