# Eloá — atendimento automático e humanizado a leads novos

Assim que um lead entra no CRM na coluna "I.A." (via webhook do Autoconf ou cadastro manual), a Eloá manda pelo WhatsApp uma saudação e uma foto real do veículo de interesse. A partir da primeira resposta do cliente, a conversa passa a ser conduzida por IA (Gemini) — ela conversa de verdade, não é mais um roteiro fixo de mensagens prontas. A IA decide quando encaminhar pra um consultor humano (preço, financiamento, ou pedido do cliente); até lá, ela continua a conversa sozinha.

## Personalidade e conhecimento (editáveis)

- `persona.md` — quem é a Eloá, como ela fala, e as regras do que ela pode/não pode fazer sozinha (hoje: nunca falar preço nem prometer financiamento).
- `base-conhecimento.md` — informações da RT Car que você quiser que ela saiba (diferenciais, políticas, FAQ). Edite livremente, é texto puro.

Os dois são lidos a cada conversa — edite e o próximo atendimento já usa a versão nova (não precisa reiniciar o processo pra isso).

## Chave de IA (Google AI / Gemini)

Precisa da variável de ambiente `GOOGLE_AI_API_KEY`, criada em [aistudio.google.com](https://aistudio.google.com/apikey) (conta/cobrança do próprio Rubens). Sem ela, a Eloá manda a saudação inicial normalmente, mas não consegue continuar a conversa depois — nenhuma chave fica salva neste repositório.

```
set GOOGLE_AI_API_KEY=sua_chave_aqui
node index.js
```

## Trava de segurança sobre preço

Além da regra em `persona.md`, o código (`index.js`, `PADRAO_PRECO`) verifica toda resposta da IA antes de mandar pro cliente — se aparecer algo como "R$", "financiamento" ou "parcela", a mensagem é bloqueada e o lead é encaminhado direto pra um consultor humano, mesmo que a IA não tenha sinalizado isso sozinha.

## Voz (ainda não implementada)

A ideia de usar a voz nativa do Gemini (voz "Kore") pra mensagens de áudio ainda não foi construída — hoje a Eloá só manda texto e uma foto.

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

## Decisão ainda pendente (reunião 07/08/2026 com Aline/Rafa)

Marcada como `TODO` no topo do `index.js`:

- **Lead não responde nada** — hoje: fica esperando pra sempre, sem timeout nem segunda tentativa automática.

(O ponto "cliente continua a conversa depois do consentimento" foi resolvido pela conversa por IA — agora ela continua respondendo de verdade, em vez de ficar em silêncio.)

## Limitação atual da mensagem

A foto e o texto usados vêm do `estoque.json` (marca, modelo, uma foto) — não tem preço, ano, km ou outras fotos, porque essa fonte de dados não tem esses campos. Pra enriquecer isso (como foi feito manualmente na demo, puxando do site rtcar.com.br para um único veículo), seria preciso uma integração nova com o Autoconf — não existe hoje de forma automática/genérica para qualquer veículo.
