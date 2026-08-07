# Eloá — atendimento automático a leads novos

Assim que um lead entra no CRM na coluna "I.A." (via webhook do Autoconf ou cadastro manual), a Eloá manda pelo WhatsApp: saudação, uma foto real do veículo de interesse e a pergunta se pode passar o contato para um consultor. Quando o cliente responde qualquer coisa, o lead é movido automaticamente para "Atendimento".

## Isto NÃO é uma Cloud Function

Diferente do `webhook-autoconf`, este código precisa de uma conexão de WhatsApp permanente (biblioteca Baileys) — não dá pra publicar com `firebase deploy`. Precisa de um processo `node index.js` rodando continuamente em algum lugar (um servidor, uma VM pequena, ou um computador que fique sempre ligado). Enquanto isso não for decidido, ele só funciona rodando manualmente, do mesmo jeito que o agente de resgate (Cora) roda hoje no computador do Rubens.

## Número de WhatsApp

Use um número próprio para a Eloá, diferente do número já usado pela Cora (agente de resgate). As duas usam a mesma biblioteca e não podem compartilhar a mesma pasta `./auth` — foi exatamente esse conflito de sessão que causou bugs recorrentes durante os testes da demo.

## Como rodar

```
npm install
node index.js
```

Na primeira vez, vai aparecer um QR code em `./qr.png` para conectar o número de WhatsApp da Eloá.

## Decisões ainda pendentes (reunião 07/08/2026 com Aline/Rafa)

Marcadas como `TODO` no topo do `index.js`:

1. **Lead não responde** — hoje: nada, fica esperando pra sempre, sem timeout nem segunda tentativa.
2. **Cliente continua a conversa depois do "posso passar seu contato?"** — hoje: a Eloá fica em silêncio, sem responder mais nada.

## Limitação atual da mensagem

A foto e o texto usados vêm do `estoque.json` (marca, modelo, uma foto) — não tem preço, ano, km ou outras fotos, porque essa fonte de dados não tem esses campos. Pra enriquecer isso (como foi feito manualmente na demo, puxando do site rtcar.com.br para um único veículo), seria preciso uma integração nova com o Autoconf — não existe hoje de forma automática/genérica para qualquer veículo.
