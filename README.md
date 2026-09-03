# RT Car — CRM (Marketing & Relacionamento)

Sistema interno da RT Car — CRM de leads, Relacionamento pós-venda, Workshop (eventos) e Anúncios.

Arquivo único (HTML + CSS + JS vanilla), Firebase Firestore via REST API.

## Como trabalhar neste repositório

- **Não editem ao mesmo tempo.** Antes de começar, sempre rode `git pull` pra puxar a versão mais recente.
- Depois de terminar suas alterações, `git add`, `git commit` e `git push` antes de avisar a próxima pessoa que pode começar.
- Se der conflito ao fazer `git pull`, pare e peça ajuda antes de forçar qualquer coisa.

## Estrutura

- `rtcar-modulos.html` — o sistema completo (login, CRM, Relacionamento, Workshop, Anúncios).

## Embutir no sistema principal de vendas (window.RTCarCRM)

O `index.html`/`rtcar-modulos.html` já vem preparado pra ser embutido dentro
de outra página (o sistema principal de vendas da RT Car), sem colidir com
o JS/CSS de lá — pedido feito pelo Claude do lado da Marcela, 03/09/2026.

- Todo o JavaScript do arquivo fica dentro de uma única IIFE. Nada vaza pro
  escopo global (`window`) além de `window.RTCarCRM`, com dois métodos:
  - `RTCarCRM.montar(containerEl)` — injeta o CRM dentro do elemento
    passado, e reaproveita login do Firebase Auth já feito (se o e-mail
    logado também estiver em `USUARIOS`, entra direto sem pedir senha de
    novo; se não, mostra a tela de login normal do CRM, sem deslogar a
    sessão compartilhada).
  - `RTCarCRM.desmontar()` — para os 3 `setInterval` internos (timer do
    Funil, auto-refresh do Marketing, auto-refresh da IA/Eva), remove o
    listener de teclado (Esc/N) e esconde o CRM de novo.
- Todo o CSS do arquivo fica escopado dentro de `#rtcar-crm-root` (inclusive
  as variáveis de cor/tema, que viviam em `:root` e agora vivem ali) — não
  tem mais nenhuma regra solta afetando `body`/`*` fora desse container.
- **Modo standalone** (abrir o arquivo direto, como sempre foi): continua
  funcionando igual — ele mesmo chama `RTCarCRM.montar(document.body)`
  automaticamente ao carregar. Pra impedir isso (e chamar `montar()` você
  mesmo, no momento certo, com o container que quiser), defina
  `window.RTCARCRM_EMBED = true` **antes** desse script rodar.
- Os dois sistemas usam o mesmo Firebase (`rtcarprograma`) — o código já
  verifica `firebase.apps.length` antes de inicializar, então não quebra se
  o Firebase SDK/app já tiver sido inicializado pela página que o embutir.

## Próximos passos conhecidos

- Integração com Autoconf (webhook de leads).
- Integração de I.A. na triagem de leads (coluna "I.A." do kanban).
- Unificação com o sistema principal de vendas: isolamento de JS/CSS já
  feito (ver seção acima) — falta o lado do sistema principal chamar
  `RTCarCRM.montar(...)` no menu dele (em planejamento, com a Marcela).
