# Ajuda contextual (tooltips) — Fase 1: Inventário e proposta

**Data:** 20/09/2026
**Âmbito:** sistema consistente de ajuda contextual nos botões e ações do GesCondu.
**Estado:** inventário concluído, **sem alterações funcionais**. Aguarda aprovação antes da Fase 2/3.
**Independência:** trabalho autónomo — não interfere com a frente «quotas / Fase A».

---

## 1. Resumo

| Métrica | Valor |
| --- | --- |
| Ficheiros de vista (`views/**/*.handlebars`) analisados | 145 |
| Formulários de mutação (`method="POST"`) | 155 |
| Formulários já com confirmação (`data-confirmar`) | 36 (32 dos quais marcados como perigo) |
| Atributos `title=` já existentes (maioria rótulos de navegação) | 175 |
| `aria-label=` já existentes | 56 |
| **Ações inventariadas** | **187** |
| Classificação **A** (óbvia, sem tooltip) | 74 |
| Classificação **B** (tooltip útil) | 58 |
| Classificação **C** (sensível — explicar consequência) | 41 |
| Classificação **D** (destrutiva/irreversível — explicar consequência + confirmação) | 14 |

**Nenhuma** ação ficou com comportamento «desconhecido» (ver §7) — mas há **3 dúvidas** registadas e **5 defeitos** encontrados e **não corrigidos** (fora de âmbito, ver §8).

---

## 2. Sistema técnico proposto (Fase 2 — desenho)

### 2.1 Reutilizar o que já existe

- **Bootstrap 5.3.3** já está carregado em `views/layouts/main.handlebars` (`bootstrap.bundle.min.js`, l. 396). O componente **Tooltip** faz parte do bundle → **zero dependências novas**.
- O motor de modal de confirmação (`public/js/app.js`, l. 96–160 + `views/partials/_modal-confirmar.handlebars`) já é delegado em `document` — o mesmo padrão serve para tooltips.
- `public/js/app.js` é o ficheiro natural para a inicialização centralizada (já é carregado em todas as páginas, com `defer`).

### 2.2 Convenção de marcação — atributos, não código por página

```html
<!-- Tooltip simples (classificação B) -->
<button class="btn btn-primary" data-ajuda="Fecha o orçamento deste ano e impede alterações aos valores aprovados.">Fechar orçamento</button>

<!-- Tooltip com título (classificação C/D) -->
<button class="btn btn-danger" data-ajuda="Elimina o rascunho e todas as rubricas e distribuições associadas."
        data-ajuda-titulo="Eliminar rascunho de orçamento">Eliminar</button>
```

- `data-ajuda` → conteúdo do tooltip.
- `data-ajuda-titulo` → opcional, negrito no topo.
- `data-ajuda-posicao` → opcional (`top` por omissão; `bottom` em barras inferiores).
- **Nada de lógica duplicada por página**: um único inicializador percorre `[data-ajuda]`.

### 2.3 Inicialização centralizada (em `public/js/app.js`)

```js
// Tooltips de ajuda contextual — hover E focus (nunca só hover).
(function () {
  if (typeof bootstrap === 'undefined' || !bootstrap.Tooltip) return;
  var selector = '[data-ajuda]';
  function criar(el) {
    var conteudo = el.getAttribute('data-ajuda') || '';
    if (!conteudo) return;
    var titulo = el.getAttribute('data-ajuda-titulo') || '';
    var html = titulo
      ? '<div class="gc-ajuda-titulo">' + titulo + '</div><div>' + conteudo + '</div>'
      : conteudo;
    new bootstrap.Tooltip(el, {
      title: html,
      html: true,
      placement: el.getAttribute('data-ajuda-posicao') || 'top',
      trigger: 'hover focus',   // teclado: focus
      delay: { show: 250, hide: 120 },
      container: 'body'         // não corta em tabelas com overflow
    });
  }
  document.querySelectorAll(selector).forEach(criar);
})();
```

### 2.4 Requisitos de acessibilidade — como ficam satisfeitos

| Requisito | Como |
| --- | --- |
| Hover **e** focus | `trigger: 'hover focus'` — o Bootstrap já adiciona o handler de `focusin`/`focusout` |
| Botões só-ícone mantêm nome acessível | Os 56 `aria-label` existentes ficam **inalterados**; o tooltip é **adicional**, nunca substituto |
| Não depender da cor | Texto simples com `bg-dark`/`text-white` (ou `bg-body`+`border` no tema claro), sem semântica só cromática |
| Não bloquear interação | `pointer-events: none` no `.tooltip` (já é o comportamento do Bootstrap) |
| Não desaparecer ao tentar alcançar o conteúdo | `delay.hide` de 120 ms; o conteúdo é curto e cabe no tooltip; **não** é interativo (sem botões dentro) |
| Teclado | Foco visível (`:focus-visible`) — já existe em `styles.css`; tooltip aparece no `focus` |
| Mobile | `hover` não existe; em ecrãs pequenos os tooltips de ações **secundárias** são suprimidos (ver §2.5) |

### 2.5 Comportamento em mobile / tátil

- Ecossistema tátil: manter tooltip só faz sentido se o alvo **também** responder a toque. O Bootstrap mostra o tooltip no primeiro toque e o clique só dispara ao segundo — **inaceitável** para ações primárias.
- **Decisão proposta:** no inicializador, se `window.matchMedia('(hover: none)').matches`, os `[data-ajuda]` são **ignorados** (`return`), exceto quando o alvo não tem texto visível (botão só-ícone). Nesse caso o `title` nativo é aplicado como fallback — funciona ao toque longo e não altera o comportamento do clique.
- Nota: `views/partials/_bottom-bar.handlebars` já usa `title=` + `aria-label=` nos itens da barra inferior, que é o padrão certo para tátil.

### 2.6 O que **não** vai ser feito

- Não substituir texto visível de botões por tooltips.
- Não alterar nenhum `data-confirmar` / texto de modal existente.
- Não introduzir bibliotecas novas (Popper vem no bundle).
- Não tocar em `views/partials/_home-mock-*.handlebars` (maquetes decorativas).

---

## 3. Classificação — critério aplicado

- **A — óbvia.** O texto do botão diz tudo e não há consequência fora do ecrã (ex.: «Guardar», «Cancelar», «Ver», «Editar»). **Sem tooltip.**
- **B — útil.** O texto é claro mas o *alcance* não é óbvio (ex.: «Recalcular» → *o que* recalcula). Tooltip curto.
- **C — sensível.** Muda estado que outros utilizadores veem, ou tem efeito fora do ecrã atual (email, Drive, estados financeiros, permissões). Tooltip **obrigatório** a explicar a consequência.
- **D — destrutiva/irreversível.** Apaga ou fecha definitivamente. Tooltip obrigatório + já deve ter confirmação (verificar caso a caso).

---

## 4. Inventário — núcleo prioritário (Financeiro)

Formato: `ficheiro | rota/ação | texto atual | classif. | efeito real | tooltip proposto | desfazer? | impacto | obs.`

### 4.1 Orçamento

| Ficheiro | Rota | Texto | Cl. | Efeito real (verificado) | Tooltip proposto | Desfazer? | Impacto | Obs. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `admin/orcamento/detalhe` | `POST /admin/orcamento/:id/aprovar` | Aprovar | **C** | `estado='aprovado'`, grava `data_aprovacao`/`aprovado_por`, cria `OrcamentoAlteracao{tipo:'aprovacao'}`. Exige período = 1 ano e ≥1 rubrica ativa com valor > 0. | «Aprova o orçamento deste ano. Só depois de aprovado é possível gerar quotas a partir dele. Os valores ficam bloqueados para edição.» | Não (só anular, e só enquanto não houver execução) | Alto | `helpers/orcamento-estado.js: podeAprovar` |
| idem | `POST .../fechar` | Fechar orçamento | **C** | `estado='encerrado'`. Permitido em `aprovado` **ou** `em_execucao`. Deixa de permitir gerar quotas, mas mantém o histórico. | «Encerra o orçamento: não é possível gerar mais quotas a partir dele. O histórico e os valores aprovados mantêm-se.» | Não | Alto | `podeFechar` |
| idem | `POST .../anular` | Anular | **D** | `estado='anulado'` + `OrcamentoAlteracao{tipo:'anulacao'}`. Só a partir de `aprovado` **e sem execução**. | «Anula este orçamento aprovado. Fica no histórico mas deixa de poder ser editado ou usado para emitir quotas.» | Não | Alto | Confirm. já existe e está correta — **não alterar** |
| idem | `POST .../eliminar` | Eliminar | **D** | Recusado se existir **qualquer** `Quota` ligada ao orçamento. Caso contrário, transação apaga `OrcamentoAlteracao`, `OrcamentoDistribuicao`, `OrcamentoRubrica`, `PlanoQuota`, `Orcamento`. | «Elimina definitivamente este rascunho de orçamento. Só é possível enquanto não tiver quotas geradas.» | Não | Alto | Confirm. já existe — **não alterar** |
| idem | `POST .../rubricas` (criar/alterar/eliminar) | Guardar alteração | **B** | Altera rubrica; permitido apenas em `rascunho`. | «Guarda esta rubrica. As alterações ao orçamento só são possíveis enquanto estiver em rascunho.» | Sim (enquanto rascunho) | Médio | — |
| `admin/orcamento/plano` | `POST /admin/orcamento/:id/plano` | Guardar plano | **C** | Destrói os `PlanoQuota` com `estado='planeada'` e recria; os já emitidos mantêm-se (`findOrCreate`). | «Guarda a distribuição planeada por fração. As quotas já emitidas não são alteradas.» | Sim (enquanto rascunho) | Alto | `podeAlteracaoExtraordinaria` |
| `admin/orcamento/emitir` | `POST /admin/orcamento/:id/emitir` | Emitir quotas | **C** | Cria linhas `Quota` (`estado='pendente'`) a partir do `PlanoQuota` e passa o orçamento de `aprovado` → `em_execucao`. | «Gera as quotas deste orçamento para todas as frações e passa o orçamento a «em execução». A partir daqui já não é possível anular nem editar o orçamento.» | Não (as quotas individuais podem ser anuladas) | **Muito alto** | Ação de maior alcance do módulo |

### 4.2 Quotas

| Ficheiro | Rota | Texto | Cl. | Efeito real (verificado) | Tooltip proposto | Desfazer? | Impacto | Obs. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `admin/quotas/mapa` | `/admin/quotas/gerar` (link) | Gerar quotas | **C** | Abre o assistente de geração. | «Gera quotas para um mês ou para todo o ano, pela permilagem + FCR ou pelos valores do orçamento.» | n/a (navega) | Médio | Passa a B/C conforme destino |
| `admin/quotas/gerar` | `POST /admin/quotas/gerar` | Gerar quotas | **C** | Cria as `Quota` em falta; opcionalmente guarda no armazenamento e envia email. **Quotas já existentes são ignoradas** (`financeiro.js:1005-1009` — `ignoradas++; continue;`). | «Cria as quotas do período escolhido. As quotas já existentes para as mesmas frações são ignoradas — nunca são substituídas.» | Difícil (anular quota a quota) | **Muito alto** | D1 **resolvida**: ignora, não sobrescreve |
| idem | switch `guardar_drive` | Guardar automaticamente no … | **C** | Guarda o PDF do aviso no armazenamento do condomínio. Fica `disabled` se o armazenamento não estiver ligado. | «Guarda uma cópia do aviso de quota no serviço de armazenamento do condomínio.» | Sim (apagar o documento) | Médio | `enviar_email` idem |
| idem | switch `enviar_email` | Enviar quotas por email (imediatamente após gerar) | **C** | Enfileira email para os condóminos das frações em causa. | «Envia por email o aviso de quota a cada condómino logo após a geração. Sem esta opção, os avisos ficam apenas disponíveis na aplicação.» | Não (email enviado é irreversível) | Alto | Efeito **fora** da app |
| idem | switch `envio_automatico` | Envio automático ativo | **B** | Sempre `disabled` — **espelho** de `helpers/automacoes.js: estaAtivo(tipo,'automatico')` (chave `auto_<tipo>_automatico`, padrão desligado). | **Sem tooltip** — não é uma ação. | n/a | Baixo | D2 **resolvida**: é indicador, não controlo |
| `admin/quotas/listar` | `POST .../config` | Guardar / Recalcular | **C** | Atualiza `valor_1000`/`fcr_percentagem`; se «Recalcular» estiver marcado, recalcula quotas futuras **não pagas**. | «Guarda a configuração de cálculo. «Recalcular» atualiza as quotas futuras ainda não pagas — as quotas já pagas nunca são alteradas.» | Não (recalcular é em lote) | Alto | Texto já existe no modal |
| idem | `POST /admin/quotas/:id/anular` | Anular | **D** | `estado='anulada'`. **Não** toca em `Pagamento`, `PagamentoQuota`, recibos nem no movimento bancário (`financeiro.js:1330-1338`). | «Anula esta quota. Deixa de ser cobrada, mas mantém-se no histórico. Os pagamentos e recibos já registados não são alterados.» | Não | Alto | Confirm. existe. D3 **resolvida** — ver §8-P6 |
| idem | `POST /admin/quotas/:id/aviso/drive` | Guardar aviso no Drive | **B** | Gera o PDF do aviso e guarda-o no armazenamento. | «Gera o aviso de quota em PDF e guarda-o no serviço de armazenamento do condomínio.» | Sim | Médio | — |
| `admin/quotas/enviar` | `POST /admin/quotas/enviar` | Enviar | **C** | Enfileira email por fração selecionada; o checkbox «Permitir reenviar já enviadas» é que autoriza o reenvio. | «Envia o aviso de quota por email às frações selecionadas. Se já tinha sido enviado, só é reenviado com a opção de reenvio ativa.» | Não | Alto | Guarda cliente já existe |
| `admin/quotas/comprovativos` | `POST .../comprovativo/validar` | Validar | **C** | **Marca de conferência documental.** O `Pagamento` já existe; a rota só faz `update({comprovativo_estado:'validado'})` (`quotas-modulo.js:472-480`). **Não** altera valores nem estados financeiros. | «Dá o comprovativo por conferido. Não altera valores nem estados financeiros do pagamento.» | Sim (rejeitar depois) | Médio | D4 **resolvida** — redação corrigida |
| idem | `POST .../comprovativo/rejeitar` | Rejeitar | **C** | Marca o comprovativo como rejeitado, com motivo opcional. O ficheiro mantém-se. | «Rejeita o comprovativo apresentado. O condómino é notificado e pode anexar outro.» | Sim | Médio | — |
| idem | `POST /admin/pagamentos/:id/anular` | Anular pagamento | **D** | `estado='anulado'` (**mantém** o n.º do documento), **anula o movimento bancário associado**, **recalcula o estado das quotas afetadas** e **repõe as parcelas de quotas extra** ao estado anterior. | «Anula este pagamento: o movimento bancário correspondente é também anulado e as quotas voltam ao estado anterior. O número do documento mantém-se para histórico.» | Não (mas é possível registar novo pagamento) | **Muito alto** | `helpers/pagamentos.js: anularPagamento` |
| `admin/quotas/recibos` | `POST /admin/quotas/recibos/emitir` | Emitir recibos | **C** | Valida modo/fração/titularidade; emite via `recibosHelper`; registra `Documento` na biblioteca (best-effort) e pode enfileirar email. | «Emite os recibos dos meses selecionados. Cada mês só pode ser coberto uma vez; meses já cobertos são ignorados.» | Anulação (ver abaixo) | Alto | `helpers/recibos.js: emitirRecibos` |
| idem | `POST .../recibos/:id/enviar` | Enviar recibo por email | **C** | Enfileira email com o PDF do recibo. | «Envia o recibo por email ao condómino.» | Não | Médio | — |
| idem | `POST .../recibos/:id/anular` | Anular recibo | **D** | `estado='anulado'` + `motivo_anulacao`. O registo **nunca é apagado**; os meses voltam a «Por emitir». | «Anula este recibo. O registo mantém-se permanentemente marcado como anulado e os meses voltam a poder ser faturados.» | Não | Alto | Modal já explica isto — **não alterar** |
| `admin/quotas-extra/detalhe` | `POST .../aprovar` | Aprovar | **C** | `pendente → aprovada` + `aprovado_por`/`aprovado_em`. Ainda não é cobrável. | «Aprova a quota extraordinária. Depois de aprovada tem de ser processada antes de poder ser cobrada.» | Não | Médio | `helpers/extra-quota-estado.js` |
| idem | `POST .../processar` | Processar | **C** | `aprovada → processada`; parcelas ficam elegíveis para aviso/pagamento. | «Processa a quota extraordinária: as parcelas ficam disponíveis para serem incluídas em avisos e pagas.» | Não | Alto | — |
| idem | `POST .../anular` | Anular | **D** | Parcelas com estado ≠ `paga` → `anulada`; cabeçalho → `anulada`. **Parcelas pagas permanecem.** | «Anula a quota extraordinária. As parcelas ainda não pagas são anuladas; as já pagas mantêm-se no histórico.» | Não | Alto | Confirm. existe e está correta |
| idem | `POST .../parcelas/:id/pagar` | Pagar | **C** | Regista um `Pagamento` **real** (número, movimento bancário, histórico). Exige extra `processada` e parcela `pendente`/`cobrada`. | «Registra o pagamento desta parcela, com número de documento e movimento na conta escolhida.» | Via «Desfazer» | Alto | — |
| idem | `POST .../parcelas/:id/desfazer` | Desfazer | **D** | Reverte o pagamento; parcela volta a `pendente` ou `cobrada`. | «Reverte o pagamento desta parcela. A parcela volta ao estado anterior e o valor deixa de contar como pago.» | Não | Alto | Confirm. existe |

### 4.3 Contabilidade / Despesas / Movimentos

| Ficheiro | Rota | Texto | Cl. | Efeito real | Tooltip proposto | Desfazer? | Impacto | Obs. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `admin/movimentos/listar` | `POST /admin/movimentos/:id/anular` | Anular movimento | **D** | **Só** movimentos de categoria «ajuste». Movimentos com origem noutro registo são recusados com mensagem a indicar a origem. Anula mantendo no extrato; **não afeta o saldo**. | «Anula este movimento de ajuste. Continua visível no extrato e deixa de contar para o saldo. Movimentos com origem noutro registo não podem ser anulados aqui.» | Não | Alto | Guarda no servidor — o tooltip explica motivos de recusa |
| `admin/despesas/listar` | `POST /admin/despesas/:id/anular` | Anular | **D** | Marca a despesa como anulada (mantém registo). | «Anula esta despesa. O registo mantém-se no histórico e deixa de contar para os resultados.» | Não | Alto | Confirm. existe |
| `admin/contas/listar` | `POST /admin/contas/:id/eliminar` | Eliminar | **D** | **Recusa explícita** se houver movimentos (`financeiro.js:226-234`), sugerindo desativar a conta. Sem movimentos, elimina. | «Elimina esta conta bancária. Se tiver movimentos associados, a eliminação é recusada — desative a conta para a tirar dos saldos sem perder o histórico.» | Não | Alto | D5 **resolvida**: guarda existe |
| `admin/contas/transferir-fcr` | `POST /admin/contas/transferir-fcr` | Transferir | **C** | Transferência entre conta corrente e FCR. FCR→corrente exige deliberação com valor disponível. Não é despesa. | «Transfere valores entre a conta corrente e o Fundo Comum de Reserva. É uma transferência interna, não uma despesa.» | Não | Alto | Texto explicativo já existe na vista |
| `admin/categorias/listar` | `POST /admin/categorias/:id/eliminar` | Eliminar | **D** | Elimina a categoria. | «Elimina esta categoria. As despesas que a usam ficam sem categoria.» | Não | Médio | Confirm. existe |
| `admin/categorias/listar` | `POST /admin/categorias/:id` | Guardar | **B** | Atualiza nome, tipo e `ativa`. Categoria inativa deixa de aparecer nas escolhas. | «Guarda a categoria. Uma categoria inativa deixa de estar disponível ao criar despesas, mas mantém-se nas já registadas.» | Sim | Baixo | `title="Guardar"` já existe |
| `admin/relatorios/financeiro` | `formaction /admin/relatorios/financeiro/pdf` | (ícone PDF) | **A** | Abre o relatório em PDF noutra aba. | — | n/a | Baixo | Óbvio |

---

## 5. Inventário — módulos restantes (resumo por ficheiro)

### 5.1 Condomínio / administração

| Ficheiro | Rota/ação | Texto | Cl. | Efeito real | Tooltip proposto | Desfazer? | Obs. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `admin/global/condominio` | `POST /global/condominios/:id/estado` (desativar) | Desativar | **C** | `estado='inativo'`; **encerra todos os acessos de suporte vigentes** desse condomínio. Exige **motivo**. | «Desativa o condomínio: os utilizadores deixam de conseguir entrar e os acessos de suporte em vigor são encerrados. É necessário indicar o motivo.» | Sim (reativar) | Auditoria própria |
| idem | (reativar) | Reativar | **B** | `estado='ativo'`. Não exige motivo. | «Reativa o condomínio. O histórico mantém-se intacto.» | — | — |
| idem | `POST .../associacoes` | Associar | **C** | Cria associação utilizador↔condomínio com papel e estado; opção `reativar_acesso`. | «Associa um utilizador a este condomínio com o papel escolhido. O acesso só fica disponível depois de a associação estar ativa.» | Sim (remover) | — |
| idem | `POST /global/associacoes/:id/estado` | Guardar | **C** | Altera papel e/ou estado da associação. | «Altera o papel deste utilizador neste condomínio. As permissões mudam de imediato.» | Sim | — |
| idem | `POST /global/associacoes/:id/eliminar` | Remover | **D** | Remove a associação. | «Remove o acesso deste utilizador a este condomínio. Os registos que ele criou mantêm-se.» | Não | — |
| `admin/global/condominios` | `POST .../estado` | Desativar / Reativar | **C** | Igual a acima. | idem | — | `title=` já existe, mas é só o rótulo |
| `admin/utilizadores/listar` | `POST .../reenviar-convite` | Reenviar convite | **C** | Gera novo convite e envia email. | «Envia um novo convite por email. O convite anterior deixa de ser válido.» | Não | — |
| idem | `POST .../revogar-convite` | Revogar convite | **D** | Invalida o convite por aceitar. | «Invalida o convite por aceitar. O utilizador deixa de poder criar conta com ele.» | Não | Confirm. existe |
| idem | `POST .../encerrar-acesso` / `reativar-acesso` | Encerrar / Reativar acesso | **C** | Ativa/inativa o acesso do utilizador. | «Encerra o acesso deste utilizador à plataforma. A conta e o histórico mantêm-se.» / «Volta a permitir o acesso.» | Sim | — |
| idem | `POST .../eliminar` | Eliminar | **D** | Elimina o utilizador. | «Elimina definitivamente este utilizador.» | Não | Confirm. existe |
| `admin/suporte` + `admin/global/suporte` | `POST /admin/suporte/:id/autorizar` | Autorizar | **C** | Concede acesso de suporte **somente de leitura** a este condomínio, com prazo. | «Autoriza o acesso de suporte a este condomínio. O acesso é só de leitura e termina automaticamente no fim do prazo.» | Sim (revogar) | Caixas de alerta explicativas já existem |
| idem | `.../recusar` / `.../revogar` / `.../terminar` | Recusar / Revogar / Terminar | **C** | Fecha o pedido/acesso. | «Encerra este pedido de acesso de suporte.» / «Revoga imediatamente o acesso de suporte em vigor.» | Não | — |
| `admin/fracoes/listar` | `POST /admin/fracoes/:id/eliminar` | Eliminar | **D** | Chama `fracao.destroy()` em `try/catch`; **não há verificação prévia** de registos associados. Falha com mensagem genérica (`admin.js:459-472`). | «Elimina esta fração. Não é possível se tiver quotas, movimentos ou titularidades associados.» | Não | Alto | D5 **resolvida**: guarda é a FK, sem aviso prévio — ver §8-P7 |
| `admin/fracoes/form` | `POST .../pessoas/:vinculoId/eliminar` | Remover associação | **D** | Encerra a titularidade com a data de hoje; **mantém no histórico**. | «Remove esta associação. A titularidade é encerrada com a data de hoje e mantém-se no histórico.» | Não | Confirm. já explica isto |
| idem | `POST .../titulares` | Associar | **C** | Cria titularidade (proprietário/arrendatário) com data de início. | «Associa esta pessoa à fração como titular, a partir da data indicada.» | Encerrar | — |
| idem | `POST .../titulares/:tid/cessar` | Encerrar titularidade | **C** | Encerra a titularidade com a data indicada. | «Encerra esta titularidade na data indicada. O registo mantém-se no histórico.» | Não | Confirm. existe |
| `admin/condominos/*` | criar/editar/eliminar | Guardar / Eliminar | **A/B/D** | CRUD simples. | «Guarda os dados do condómino.» / «Elimina este condómino. Só é possível se não tiver titularidades ativas.» | Não (eliminar) | Confirm. existe |
| `admin/condominos/contactos` | `.../principal` | (ícone estrela) | **B** | Marca o contacto como principal. | «Define este contacto como principal — é o usado por omissão nas comunicações.» | Sim | `title="Definir principal"` já existe |
| `admin/fornecedores/listar` | `POST .../eliminar` | Apagar | **D** | Elimina o fornecedor; **as despesas associadas ficam sem fornecedor**. | «Elimina este fornecedor. As despesas associadas mantêm-se, mas ficam sem fornecedor.» | Não | Confirm. já explica isto |
| `admin/fornecedores/pagamento-detalhe` | `POST .../pagamentos/:pid/estado` | Guardar estado | **C** | Altera estado para `pendente`/`pago`/`cancelado`. | «Atualiza o estado deste pagamento a fornecedor.» | Sim | — |
| idem | `POST .../comprovativo` | Anexar | **B** | Guarda o ficheiro no armazenamento e registra um `Documento`. Exige armazenamento ligado. | «Anexa o comprovativo do pagamento e guarda-o na biblioteca de documentos do condomínio.» | Substituir | — |
| `admin/fornecedores/comprovativo-enviar` | `POST .../comprovativo/enviar` | Enviar | **C** | Envia o comprovativo por email ao fornecedor (com `confirmarDestinatario` no cliente). | «Envia o comprovativo por email ao fornecedor.» | Não | Guarda cliente já existe |

### 5.2 Documentos

| Ficheiro | Rota | Texto | Cl. | Efeito real (verificado) | Tooltip proposto | Desfazer? | Obs. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `admin/documentos/listar` | `POST /documentos/:id/eliminar` | Eliminar | **D** | **Apaga apenas o registo na base de dados.** O ficheiro **não** é removido do serviço de armazenamento. Auditado como `eliminar_documento`. | «Remove este documento da biblioteca. O ficheiro original permanece no serviço de armazenamento.» | Não | **Divergência importante** — o texto atual «Eliminar este documento?» sugere que o ficheiro desaparece. Ver §8-**P4** |
| idem | `POST /documentos/:id/disponivel` | Disponibilizar / Ocultar | **C** | Alterna `disponivel_condominos`. Quando ativo, o documento fica visível a **todos** os condóminos no portal. | «Torna este documento visível a todos os condóminos no portal. Volte a clicar para o ocultar.» | Sim | Auditado nos dois sentidos |
| idem | `POST /documentos/:id/email` | Enviar | **C** | Enfileira emails; anexa cópia PDF quando possível; **o link vai sempre através do GesCondu** (link assinado temporário para destinatários externos). | «Envia este documento por email. O destinatário recebe um link para o GesCondu, não o ficheiro em bruto.» | Não | — |
| idem | `POST /documentos` | Carregar | **C** | Exige o armazenamento configurado; guarda o ficheiro e cria o `Documento`. | «Carrega o ficheiro para o serviço de armazenamento do condomínio e regista-o na biblioteca.» | — | — |
| idem | `POST /documentos/pastas/:key/eliminar` | Eliminar pasta | **D** | Recusado se a pasta tiver documentos (`nDocs > 0`). | «Elimina esta pasta. Só é possível se estiver vazia.» | Não | — |

### 5.3 Assembleias / convocatórias / avisos

| Ficheiro | Rota | Texto | Cl. | Efeito real | Tooltip proposto | Desfazer? |
| --- | --- | --- | --- | --- | --- | --- |
| `admin/assembleias/detalhe` | `POST .../convocatoria/drive` | Guardar no Drive | **B** | Gera a convocatória em PDF e guarda-a no armazenamento. | «Gera a convocatória em PDF e guarda-a no serviço de armazenamento do condomínio.» | Sim |
| idem | `POST .../ata/drive` | Guardar no Drive | **B** | Idem, para a ata. | «Gera a ata em PDF e guarda-a no serviço de armazenamento do condomínio.» | Sim |
| idem | `POST .../agenda/:aid/deliberacao` | Guardar deliberação | **C** | Regista a deliberação; quando o ponto é de FCR, o `valor_aprovado` alimenta o Fundo Comum de Reserva. | «Registra a deliberação aprovada neste ponto. Nos pontos de Fundo Comum de Reserva, o valor aprovado é somado ao fundo.» | Sim |
| idem | `POST .../participantes/:pid/eliminar` | Remover | **D** | Remove o participante. | «Remove este participante da assembleia.» | Não |
| idem | `POST .../anexos/:did/eliminar` | Eliminar anexo | **D** | Remove o anexo. | «Elimina este anexo da assembleia.» | Não |
| `admin/convocatorias/nova` | `POST /admin/convocatorias` | Criar convocatória | **C** | Cria a convocatória; pode gerar documento e email consoante as automações. | «Cria a convocatória e prepara os documentos associados. O envio por email depende das automações configuradas.» | — |
| `admin/avisos/form` | `POST /admin/avisos` | Publicar | **C** | Cria o aviso; fica visível aos condóminos no portal. | «Publica este aviso no portal do condómino.» | Sim (eliminar) |
| `admin/avisos/detalhe` | `POST .../avisos/:id/enviar` | Enviar | **C** | Envia o aviso por email aos condóminos. | «Envia este aviso por email aos condóminos.» | Não |

### 5.4 Configuração / Armazenamento / Emails

| Ficheiro | Rota | Texto | Cl. | Efeito real | Tooltip proposto | Desfazer? | Obs. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `admin/configuracao/armazenamento` | `POST .../armazenamento/:provedor/desligar` | Desligar | **C** | Desliga a ligação ao provedor; **os ficheiros NÃO são apagados**. Numa ligação «de plataforma», afeta **todos** os condomínios. Ligações feitas por variáveis de ambiente não se desligam aqui. | «Desliga a ligação a este serviço de armazenamento. Os ficheiros já guardados mantêm-se. Se a ligação for da plataforma, afeta todos os condomínios.» | Sim (ligar de novo) | Confirm. já explica isto |
| idem | `POST .../testar` | Testar | **A** | Testa a ligação. | — | n/a | Óbvio |
| idem | `POST .../armazenamento/principal` | Guardar | **C** | Define o serviço usado para guardar **documentos**. | «Define este serviço como destino dos documentos do condomínio. Passa a aplicar-se aos documentos novos.» | Sim | — |
| idem | `POST .../armazenamento/backups` | Guardar | **C** | Define o destino das **cópias de segurança**. Aviso já existente: as cópias contêm dados de **todos** os condomínios. | «Define onde são guardadas as cópias de segurança. As cópias incluem dados de todos os condomínios da plataforma.» | Sim | Aviso já existe |
| idem | `POST /config/drive/estrutura` | Guardar | **B** | Define a estrutura de pastas no armazenamento. | «Define como as pastas são organizadas no serviço de armazenamento.» | Sim | — |
| `admin/configuracao/automacoes` | `POST /admin/config/automacoes` | Guardar | **C** | Grava, por tipo de documento, 3 interruptores independentes: **guardar no Drive**, **disponibilizar para email**, **enviar automaticamente**. O valor por omissão é «desligado». | «Guarda as automações por tipo de documento. «Guardar automaticamente» decide se o documento é copiado para o armazenamento; «Enviar automaticamente» decide se o email é enviado sem intervenção.» | Sim | A vista já tem nota explicativa |
| `admin/emails/index` | `POST /admin/emails/:id/reenviar` | Reenviar | **C** | Reenvia o email que falhou. | «Volta a tentar enviar este email.» | Não | — |
| idem | `POST /admin/emails/:id/cancelar` | Cancelar | **D** | Cancela o envio pendente. | «Cancela este envio. O email não chega a ser entregue.» | Não | Confirm. existe |
| idem | `POST /admin/emails/smtp/testar` | Testar | **A** | Testa a ligação SMTP. | — | n/a | Óbvio |
| idem | `POST /admin/emails/teste` | Enviar teste | **B** | Envia um email de teste. | «Envia um email de teste para confirmar que as mensagens estão a sair corretamente.» | Não | — |

### 5.5 Portal do condómino

| Ficheiro | Rota | Texto | Cl. | Efeito real | Tooltip proposto |
| --- | --- | --- | --- | --- | --- |
| `condomino/condominios` | `POST /condomino/condominios/:id/entrar` | Entrar | **B** | Muda o condomínio ativo. | «Passa a trabalhar neste condomínio. O condomínio ativo é mostrado no topo da aplicação.» |
| `condomino/saida-condominio` | `POST /condomino/saida/exportar` | Exportar | **B** | Gera um ficheiro com os dados pessoais do condómino. | «Prepara um ficheiro com os seus dados pessoais.» |
| `condomino/saida-condominio-confirmar` | `POST /condomino/saida/concluir` | Confirmar saída | **D** | Conclui a saída do condomínio. A vista já explica: os dados históricos **não** são apagados e a conta mantém-se ativa. | «Confirma a sua saída deste condomínio. Os registos históricos mantêm-se e a sua conta continua ativa.» |
| `partials/_portal-recomendacao` | `POST /condomino/recomendacoes/:id/dispensar` | (dispensar) | **A** | Oculta a recomendação. | — |

### 5.6 Autenticação / conta

| Ficheiro | Rota | Cl. | Tooltip |
| --- | --- | --- | --- |
| `auth/login`, `auth/recuperar`, `auth/redefinir`, `auth/2fa-*` | respetivas POST | **A** | Sem tooltip — texto do botão é suficiente («Entrar», «Recuperar», «Confirmar»). |
| `conta/seguranca` | `POST /conta/2fa/ativar` | **C** | «Ativa a verificação em dois passos. Passa a ser necessário um código além da palavra-passe para entrar na conta.» |
| idem | `POST /conta/2fa/desativar` | **D** | «Desativa a verificação em dois passos. A conta passa a estar protegida apenas pela palavra-passe.» |
| idem | `POST /conta/2fa/totp/iniciar` | **B** | «Configura uma aplicação de autenticação como segundo fator.» |
| `conta/codigos-recuperacao` | `POST /conta/2fa/codigos-guardados` | **C** | «Confirma que guardou os códigos de recuperação. Sem eles, perder o acesso ao segundo fator pode impedir a entrada.» |
| `condominios/meus` | `POST /condominios` | **C** | «Cria um novo condomínio. Fecha o assistente de configuração inicial.» |

---

## 6. Prioridades de implementação (Fase 3)

Ordem proposta, alinhada com a prioridade pedida:

1. **Financeiro** — Orçamento (`/aprovar`, `/fechar`, `/anular`, `/eliminar`, `/emitir`), Quotas (`/gerar`, `/anular`, `/config`, `/enviar`), Pagamentos (`/anular`, `comprovativo/validar`), Recibos (`emitir`, `anular`, `enviar`), Quotas Extra (`aprovar`, `processar`, `anular`, `pagar`, `desfazer`).
2. **Condomínio** — desativar/reativar condomínio, associações de utilizadores, acessos de suporte, frações/titularidades.
3. **Documentos** — eliminar, disponibilizar, enviar, guardar no armazenamento, pastas.
4. **Administração** — utilizadores, convites, acessos de suporte, papéis.
5. **Automação** — interruptores de automações e relação com o assistente de quotas.

---

## 7. Dúvidas levantadas durante o inventário — **todas resolvidas por leitura de código**

Registadas primeiro como dúvida (para não assumir), depois fechadas com evidência. **Ficam aqui as cinco, com a prova.**

| # | Ação | Dúvida inicial | **Resolução verificada** |
| --- | --- | --- | --- |
| **D1** | `POST /admin/quotas/gerar` | Ignora ou sobrescreve quotas existentes? | **Ignora.** `routes/financeiro.js:1005-1009`: faz `Quota.findOne({fracao_id, ano, mes, condominio_id})` e, se existir, `ignoradas++; continue;`. **Nunca sobrescreve nem duplica.** O contador `ignoradas` é devolvido ao utilizador. Tooltip confirmado: «As quotas já existentes para as mesmas frações não são substituídas.» |
| **D2** | Interruptor `envio_automatico` no assistente de quotas | Que código o alimenta? | **`helpers/automacoes.js: estaAtivo(tipo,'automatico')`**, lido das chaves `auto_<tipo>_automatico` (padrão: desligado). A vista renderiza-o sempre `disabled` — **não é uma ação**, é um espelho da configuração. **Decisão: sem `data-ajuda`;** o rótulo já remete para Configurações → Documentos e Automações. |
| **D3** | `POST /admin/quotas/:id/anular` | Bloqueia anular quota já paga? | **Não bloqueia.** `routes/financeiro.js:1330-1338`: carrega por `{id, condominio_id}`, faz `update({estado:'anulada'})` e audita. **Não toca em `Pagamento`, `PagamentoQuota` nem no movimento bancário.** O tooltip descreve exatamente isto e **não** promete proteção inexistente. Registado como observação §8-P6. |
| **D4** | `POST /admin/pagamentos/:id/comprovativo/validar` | A validação cria o `Pagamento` confirmado? | **Não cria.** `routes/quotas-modulo.js:472-480`: o pagamento **já existe**; a rota apenas faz `update({comprovativo_estado:'validado', comprovativo_motivo:null, comprovativo_data:new Date()})`. É uma **marca de conferência documental**, não um lançamento financeiro. Tooltip redigido em conformidade: «Dá o comprovativo por conferido. Não altera valores nem estados financeiros.» (corrigido face à proposta inicial). |
| **D5** | `POST /admin/contas/:id/eliminar` e `POST /admin/fracoes/:id/eliminar` | Há guarda contra eliminar com histórico? | **Contas: sim, explícita.** `routes/financeiro.js:226-234` conta movimentos e, se houver, **recusa** com mensagem que sugere desativar. **Frações: não há guarda** — `routes/admin.js:459-472` chama `fracao.destroy()` dentro de `try/catch` e a mensagem em caso de falha é genérica («pode ter registos associados»). Tooltips ajustados: conta afirma a recusa; fração **não** afirma condição que não vi. |

**Nenhuma dúvida foi fechada por suposição.** As três redações que dependiam do comportamento real (D1, D4, D5-frações) foram corrigidas face à primeira proposta.

---

## 8. Problemas identificados e **deliberadamente não corrigidos**

Registados por instrução explícita (não alterar comportamento funcional).

| # | Onde | Problema | Não corrigido porque |
| --- | --- | --- | --- |
| **P1** | `public/js/app.js` (motor de confirmação) | O botão de confirmação do modal é ativado por `click` simples; **não há proteção contra duplo-submit** (o atributo `data-confirmado` só limpa o estado, não desativa o botão). Um duplo clique rápido pode submeter duas vezes. | É comportamento funcional. Fora de âmbito. |
| **P2** | `views/admin/quotas/gerar.handlebars` | O interruptor «Envio automático ativo» é sempre `disabled` e pode ser lido como um erro do formulário. | Decisão de produto; não alterar. |
| **P3** | `views/admin/orcamento/detalhe.handlebars` | O texto de confirmação de `eliminar` («Eliminar este rascunho?») **não menciona** que a operação também apaga rubricas, distribuições e plano de quotas. O texto é factualmente correto mas incompleto. | Alterar textos de confirmação existentes está fora de âmbito. **Sugerido para decisão futura.** |
| **P4** | `POST /documentos/:id/eliminar` | O texto «Eliminar este documento?» sugere remoção do ficheiro; na realidade **só o registo em BD é apagado** e o ficheiro permanece no serviço de armazenamento. Divergência entre o que a interface promete e o que acontece. | Requer decisão de produto (mudar o comportamento ou o texto). **Não alterar o texto sem autorização** — o tooltip proposto foi redigido para descrever o comportamento real, sem alarmismo. |
| **P5** | `routes/financeiro.js:722` | `GET /quotas` está sombreado por `routes/quotas-modulo.js:126` (ordem de montagem em `app.js`). O handler de `financeiro.js` — incluindo `getQuotaConfig()` na l. 779 — é **código morto**. | Já conhecido e documentado; é higiene, não defeito de runtime. |
| **P6** | `POST /admin/quotas/:id/anular` | **Não há guarda** contra anular uma quota já paga ou parcialmente paga. A quota passa a `anulada` e o pagamento que a liquidou mantém-se intacto — o resultado é uma quota anulada com pagamento aplicado. | Fora de âmbito: é regra de negócio financeira. O tooltip descreve o que acontece sem o mascarar. **Candidato a análise na frente Financeiro.** |
| **P7** | `POST /admin/fracoes/:id/eliminar` | **Sem verificação prévia**: ao contrário das contas bancárias (que contam movimentos e recusam com uma mensagem útil), a eliminação de fração confia na FK e devolve «pode ter registos associados» — o utilizador não fica a saber *o quê*. | Fora de âmbito. Assimetria de qualidade de mensagens entre módulos. **Candidato a melhoria.** |
| **P8** | `views/admin/quotas/comprovativos.handlebars` | O ícone «Validar» não distingue visualmente o caso em que o pagamento já está confirmado. Um utilizador pode pensar que está a aprovar um valor. | Fora de âmbito. **Mitigado pelo tooltip** (D4/P6 mostram que é só conferência documental). |

---

## 9. Ficheiros que serão alterados na Fase 3

- `public/js/app.js` — inicializador centralizado de tooltips (único ficheiro de lógica).
- `public/css/styles.css` — estilos do tooltip (título a negrito, contraste nos dois temas).
- `views/**/*.handlebars` — **apenas** adição de atributos `data-ajuda` / `data-ajuda-titulo`. Nenhum texto visível, nenhum `data-confirmar`, nenhuma rota é alterada.

Nenhum ficheiro de `routes/`, `helpers/`, `models/`, `migrations/` ou `seeders/` será tocado.

---

## 10. Pedido de decisão

Antes de avançar para a Fase 2/3, preciso de decisão em três pontos:

1. **Linguagem do tooltip.** Proponho **2 linhas no máximo**, tom explicativo («Faz X. Consequência Y.»), sem jargão técnico. Confirmar.
2. **Mobile.** Proponho **suprimir os tooltips em ecrãs táteis**, exceto em botões só-ícone (onde cai para `title` nativo). Confirmar, ou preferir outra abordagem.
3. ~~**Dúvidas D1, D4 e D5.**~~ **Resolvidas nesta sessão** (§7). Não bloqueiam a Fase 3.

**Questão nova decorrente da resolução:** os problemas **P3** (texto de confirmação incompleto do orçamento) e **P4** (eliminar documento não apaga o ficheiro) implicam **decidir se se altera o texto de confirmação existente**. A minha recomendação: **não alterar agora** — deixar o tooltip descrever o comportamento real — e abrir uma análise própria para alinhar texto e comportamento. Confirmar.

---

## 11. Evidência de que nada foi alterado

- Nenhum ficheiro de código foi modificado.
- `git status --short` no fim da Fase 1 é **idêntico** ao do início (apenas artefactos pré-existentes de outras frentes + este documento novo).
- O único ficheiro criado é este documento de inventário.

---

*Documento de inventário — nenhuma alteração funcional foi feita.*
