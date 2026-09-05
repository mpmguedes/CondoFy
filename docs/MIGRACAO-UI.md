# GesCondu — Plano de migração da UI (SaaS + Material Design)

Referência conceptual: Adm-Condominio.pt (sidebar esquerda + header compacto + dashboard de cards).
Identidade própria do GesCondu. Não copiar textos/logo.

## Auditoria do estado atual

- **Frontend**: Handlebars (server-rendered) + Bootstrap 5 + `public/css/styles.css` (skin Material sobre Bootstrap) + `public/js/app.js` (ripple).
- **Layout**: `views/layouts/main.handlebars` = navbar horizontal no topo (sem sidebar) + container + footer.
- **Ícones**: Bootstrap Icons (`bi-*`) em todas as vistas.
- **Vistas**: 37 `.handlebars` (dashboard admin, frações, condóminos, utilizadores, contas, categorias, despesas, quotas, pagamentos, orçamento, assembleias, documentos, avisos, configuração, auditoria, área do condómino, auth, erro).
- **Rotas**: 11 ficheiros (auth, index, admin, financeiro, orcamento, assembleias, documentos, avisos, configuracao, sistema, condomino).
- **Funcionalidades existentes**: Dashboard, Frações, Condóminos, Utilizadores, Orçamento (entidade+rubricas+distribuição+plano+emissão), Quotas, Pagamentos, Despesas, Contas bancárias, Categorias, Assembleias, Documentos, Avisos, Configuração, Auditoria, Área do condómino.
- **Problemas**: sem sidebar; sem design tokens centralizados (espaçamento/cores espalhados); formulários e tabelas apertados; ícones não-Material; sem componentes reutilizáveis (cada vista repete markup).

## Plano por módulos

| Módulo | Âmbito | Estado |
| --- | --- | --- |
| **M1** | AppLayout + Sidebar + Header + Dashboard (design tokens, spacing) | ✅ |
| M2 | Partials reutilizáveis (PageHeader, StatCard, StatusChip, EmptyState) + migrar listas | ✅ |
| M3 | Formulários (spacing, labels, money/date fields) + migrar forms | ✅ |
| M4 | Página de detalhe da fração com tabs | ✅ |
| M5 | Wizard Material para gerar quotas (multi-passo) | ✅ |
| M6 | Responsive (drawer mobile, cards, tabelas com scroll) | ✅ |
| M7 | Acessibilidade + polimento + empty states em todas as áreas | ✅ |

## Regras

1. Não quebrar funcionalidades, rotas, BD, cálculos ou permissões.
2. UI separada da lógica (reutilizar helpers/rotas existentes).
3. Componentes reutilizáveis (partials) em vez de duplicação.
4. Material Symbols (ícones) + Material Design (botões, campos, chips, snackbars).
5. Design tokens centralizados (cores, spacing 4/8/12/16/24/32/48, elevation).
6. Apenas funcionalidades existentes na sidebar (Votações/Tickets/Seguros/etc. são futuras, não aparecem).
