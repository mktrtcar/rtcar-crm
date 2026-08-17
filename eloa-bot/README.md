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

## Voz — Cartesia, Gemini ou Fish Audio, alternável (⚠️ não testado de ponta a ponta)

A Eloá pode responder por nota de voz em vez de texto, nas respostas da conversa (não na saudação inicial). Três APIs possíveis, escolhidas por variável de ambiente:

```
ELOA_MODO_VOZ=true
ELOA_VOZ_PROVEDOR=cartesia   # ou "gemini" ou "fish"

# se usar Cartesia:
CARTESIA_API_KEY=sua_chave
CARTESIA_VOICE_ID=id_da_voz

# se usar Gemini (usa a mesma GOOGLE_AI_API_KEY já configurada, voz "Kore"):

# se usar Fish Audio (https://fish.audio):
FISH_API_KEY=sua_chave
FISH_VOICE_ID=id_da_voz   # opcional — sem isso usa a voz padrão do modelo
```

**Aviso:** ninguém testou essa parte ainda com uma chave de verdade — nem a geração de áudio, nem a conversão pra ogg/opus (formato que o WhatsApp exige pra mostrar como nota de voz), nem o envio pelo Baileys. Teste com um número de teste antes de confiar em produção. Se a nota de voz falhar por qualquer motivo, o código cai automaticamente pra mandar a resposta em texto, pra não deixar o cliente sem resposta. Fish Audio foi adicionado em 2026-08-13 e está no mesmo estado — código escrito a partir da documentação oficial deles, nunca chamado com uma chave real.

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

Na primeira vez, vai aparecer um QR code em `./qr.png` para conectar o número de WhatsApp da Eloá — ou, se preferir conectar por código de pareamento (não expira em segundos como o QR), defina `ELOA_TEL` no `.env` com o número (DDI+DDD+número, só dígitos) antes de rodar.

## Testar a conversa sem WhatsApp

`node simular.js "mensagem do cliente"` — conversa com a Eloá direto pelo terminal, sem precisar de celular nenhum. O histórico fica salvo em `simulacao.json` (fora do git) entre chamadas, então cada execução continua a mesma conversa. `node simular.js --reset` começa uma conversa nova. `node simular.js --veiculo "Nome do carro" "mensagem"` define o veículo simulado.

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

**Bug relacionado, mesmo dia:** o mapa telefone→lead comparava o número de formas inconsistentes (às vezes com DDI, às vezes sem), e como o WhatsApp brasileiro é inconsistente sobre incluir ou não o "9" extra do celular, uma resposta real de teste ficou sem resposta silenciosamente. Corrigido usando só os últimos 8 dígitos do número como chave (`chaveTel()`) — mesmo método já usado no agente de resgate (Cora) pra esse problema exato.

## Dados reais do veículo (fotos + specs)

`dadosVeiculo.js` busca ao vivo a página do veículo em rtcar.com.br (usando o link `pagina` que já vem no `estoque.json`) e extrai até 5 fotos reais + specs confirmadas (ano, km, cor, câmbio, potência, opcionais) — sem preço, que não aparece nem no HTML da página. Isso funciona para qualquer veículo do estoque, não só um caso específico como na demo manual original. Resultado fica em cache por 4h por veículo, pra não buscar a página de novo a cada mensagem.

**Se a busca falhar** (site fora do ar, mudou de estrutura, sem `pagina` cadastrada), cai de volta pro que já tinha: 1 foto + marca/modelo do `estoque.json`, sem travar a conversa — a Eloá é instruída a admitir quando não tem um dado específico, em vez de inventar.
