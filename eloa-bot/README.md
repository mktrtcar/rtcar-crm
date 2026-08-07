# Eloá — atendimento automático e humanizado a leads novos

Assim que um lead entra no CRM na coluna "I.A." (via webhook do Autoconf ou cadastro manual), a Eloá manda pelo WhatsApp uma saudação e uma foto real do veículo de interesse. A partir da primeira resposta do cliente, a conversa passa a ser conduzida por IA (Gemini) — ela conversa de verdade, não é mais um roteiro fixo de mensagens prontas. A IA decide quando encaminhar pra um consultor humano (preço, financiamento, ou pedido do cliente); até lá, ela continua a conversa sozinha.

## Personalidade e conhecimento (editáveis)

- `persona.md` — quem é a Eloá, como ela fala, e as regras do que ela pode/não pode fazer sozinha (hoje: nunca falar preço nem prometer financiamento).
- `base-conhecimento.md` — informações da RT Car que você quiser que ela saiba (diferenciais, políticas, FAQ). Edite livremente, é texto puro.

Os dois são lidos a cada conversa — edite e o próximo atendimento já usa a versão nova (não precisa reiniciar o processo pra isso).

## Chaves e configuração — arquivo .env

Todas as chaves ficam num arquivo `.env` dentro desta pasta (nunca é enviado pro GitHub — está no `.gitignore`):

1. Copie `.env.example` para um novo arquivo chamado `.env`, na mesma pasta.
2. Abra o `.env` e cole suas chaves reais.
3. Salve. Não precisa fazer mais nada — o `index.js` já lê esse arquivo automaticamente ao iniciar.

**GOOGLE_AI_API_KEY** — obrigatória pra Eloá conversar. Crie em [aistudio.google.com](https://aistudio.google.com/apikey) (conta/cobrança do próprio Rubens). Sem ela, a Eloá manda a saudação inicial normalmente, mas não consegue continuar a conversa depois.

## Trava de segurança sobre preço

Além da regra em `persona.md`, o código (`index.js`, `PADRAO_PRECO`) verifica toda resposta da IA antes de mandar pro cliente — se aparecer algo como "R$", "financiamento" ou "parcela", a mensagem é bloqueada e o lead é encaminhado direto pra um consultor humano, mesmo que a IA não tenha sinalizado isso sozinha.

## Voz — Cartesia ou Gemini, alternável (⚠️ não testado de ponta a ponta)

A Eloá pode responder por nota de voz em vez de texto, nas respostas da conversa (não na saudação inicial). Duas APIs possíveis, escolhidas por variável de ambiente:

```
ELOA_MODO_VOZ=true
ELOA_VOZ_PROVEDOR=cartesia   # ou "gemini"

# se usar Cartesia:
CARTESIA_API_KEY=sua_chave
CARTESIA_VOICE_ID=id_da_voz

# se usar Gemini (usa a mesma GOOGLE_AI_API_KEY já configurada, voz "Kore"):
```

**Aviso:** ninguém testou essa parte ainda com uma chave de verdade — nem a geração de áudio, nem a conversão pra ogg/opus (formato que o WhatsApp exige pra mostrar como nota de voz), nem o envio pelo Baileys. Teste com um número de teste antes de confiar em produção. Se a nota de voz falhar por qualquer motivo, o código cai automaticamente pra mandar a resposta em texto, pra não deixar o cliente sem resposta.

Lembrete de quando testamos a Cartesia antes (simulação de resgate por voz): o plano free deles não permite uso comercial — pra valer em produção precisaria do plano Pro (a partir de US$5/mês).

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

## ⚠️ Incidente real (07/08/2026) e a trava que existe hoje por causa dele

Na primeira conexão de teste com um número de WhatsApp válido, a Eloá cumprimentou **36 leads reais**, muitos deles antigos (parados em "I.A." há dias/semanas) — não só leads novos. Causa: `getLeadsNovos()` não tinha nenhum filtro de tempo, só checava "está em I.A. e nunca recebeu saudação".

**Corrigido com duas camadas:**
1. Um checkpoint persistido em `ultimo-check.json` (não vai pro GitHub) — só processa leads cujo documento no Firestore foi **criado** depois do checkpoint. Na primeira execução, o checkpoint começa em "agora", então nada do passado é varrido.
2. `MAX_SAUDACOES_POR_CICLO = 3` — mesmo que algo dê errado de novo, no máximo 3 saudações saem por ciclo de 20s, não uma centena de uma vez.

Também corrigido: cada reconexão do WhatsApp criava um novo ciclo de verificação por cima do anterior (sem cancelar), o que multiplicava tentativas repetidas. Agora o ciclo só é iniciado uma vez, não de novo a cada reconexão.

**Se algum dia apagar `ultimo-check.json` de propósito ou por acidente, ele reinicia em "agora" — nunca reprocessa o passado.** Isso é intencional.

## Limitação atual da mensagem

A foto e o texto usados vêm do `estoque.json` (marca, modelo, uma foto) — não tem preço, ano, km ou outras fotos, porque essa fonte de dados não tem esses campos. Pra enriquecer isso (como foi feito manualmente na demo, puxando do site rtcar.com.br para um único veículo), seria preciso uma integração nova com o Autoconf — não existe hoje de forma automática/genérica para qualquer veículo.
