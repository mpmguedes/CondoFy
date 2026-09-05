# Email / SMTP no GesCondu

Documentação da integração de email: configuração SMTP (com Gmail),
fila de emails, retry, envio de teste e preferências de notificação.

## Como funciona

* A aplicação envia emails através de um servidor **SMTP** configurável.
* A configuração pode estar no `.env` (fallback) ou ser guardada na base de
  dados através da interface (**Emails → Configurar SMTP**). As definições da
  base de dados têm prioridade quando existem.
* Emails **normais/agendados** passam pela fila (`email_fila`), processada pelo
  agendador (`node-cron`, a cada 5 minutos).
* O **email de teste** é enviado imediatamente, fora da fila — se o botão
  mostrar sucesso, o SMTP está funcional.

## Configuração no `.env` (fallback)

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=condominio@gmail.com
SMTP_PASS=abcdefghijklmnop
SMTP_TLS=true
SMTP_FROM=condominio@gmail.com
SMTP_FROM_NAME=Administração do Condomínio
```

> Depois de guardar a configuração na interface (base de dados), esta passa a
> ter prioridade sobre o `.env`.

## Gmail SMTP (passo a passo)

O Gmail **não aceita a palavra-passe normal** em SMTP. Use uma **App Password**:

1. Ative a **Verificação em 2 passos** na conta Google:
   https://myaccount.google.com/security
2. Em **Segurança → Palavras-passe de aplicações** (App passwords), crie uma
   para “Correio”/“Mail”.
3. Copie a palavra-passe de 16 caracteres gerada.
4. Configure no GesCondu:
   * Servidor: `smtp.gmail.com`
   * Porta: `587`
   * Segurança: TLS ativo
   * Utilizador: o email Gmail completo
   * Password: a App Password (16 caracteres, sem espaços)
5. Clique em **Testar ligação** e depois **Enviar email de teste**.

> Portas: `587` (STARTTLS) e `465` (SSL/TLS direto). Para outros fornecedores
> use as credenciais e a porta indicadas pelo mesmo.

## Fila de emails (`EmailFila`)

Estados:

| Estado | Descrição |
|---|---|
| `pendente` | Aguarda processamento |
| `a_enviar` | Envio em curso (transitório) |
| `enviado` | Enviado (com `message_id`) |
| `erro` | Falhou; será repetido até 3 tentativas |
| `cancelado` | Cancelado manualmente |

* O agendador processa pendentes/erros (com tentativas disponíveis) a cada
  5 minutos, até 20 por lote.
* Se o processo for interrompido com um email em `a_enviar`, este é reposto a
  `pendente` após 5 minutos (sem duplicar envios reais).
* **Não envia duplicados**: só estados `pendente`/`erro` são lidos.
* Na central **Emails** (`/admin/emails`) é possível filtrar (Todas,
  Pendentes, Enviados, Erros, Cancelados), **Reenviar** e **Cancelar**.

## Enviar documentos por email

Na lista **Documentos**, cada documento tem a ação **Enviar por email**:
escolha condóminos e/ou emails manuais, assunto e mensagem. O envio é
enfileirado e o link do documento (Google Drive) é incluído quando disponível.

**Envios em lote**: em **Quotas → Enviar por email** e **Pagamentos → Enviar
recibos** é possível enviar vários documentos de uma vez (selecionados ou todos
os pendentes), com estatísticas, prevenção de duplicados e reenvio controlado —
cada envio fica no histórico da entidade e na central **Emails**.

Em **Avisos**, o envio aos destinatários é enfileirado sem duplicar mensagens
já pendentes/enviadas para o mesmo aviso.

## Preferências de notificação

**Emails → Notificações automáticas** permite ativar/desativar por evento o
envio por email e/ou a gravação no Drive.

Aplicação atual das preferências:

* **Recibos → email**: envia o recibo automaticamente ao registar um pagamento.
* **Quotas em atraso → email**: controla os avisos automáticos de atraso.
* Canal **Drive**: reservado para fluxos automáticos futuros (as ações manuais
  “Guardar no Drive” existem nos módulos).

Por omissão mantém-se o comportamento atual (recibos e lembretes em atraso
ativos); os restantes eventos ficam desligados para não alterar a aplicação.

## Segurança

* A password SMTP nunca é mostrada na interface (indicador “Definida”).
* A password só é alterada quando o administrador introduz uma nova.
* Mensagens de erro amigáveis nunca revelam credenciais nem detalhes técnicos.
* A fila guarda `message_id` e estado, mas nunca passwords/tokens.

## Troubleshooting

| Sintoma | Causa provável / solução |
|---|---|
| “Não foi possível ligar ao servidor SMTP” | Host/porta errados ou porta bloqueada (587/465) |
| “Falha de autenticação” | Utilizador/password incorretos (Gmail: usar App Password) |
| “O servidor recusou o envio” | Remetente não autorizado ou política anti-spam |
| “Problema de segurança TLS” | Servidor sem TLS válido; ajuste a opção Segurança |
| Email fica em `erro` na fila | Ver a central Emails → Erros; use **Reenviar** após corrigir |
| O email de teste não chega | Confirmar spam; verificar remetente `SMTP_FROM` |
