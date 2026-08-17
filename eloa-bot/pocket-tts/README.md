# Pocket TTS (Kyutai) — serviço local de voz em português

Único provedor de voz 100% grátis e sem chave de API entre os quatro que `voz.js` suporta. Roda inteiramente local, em Python — precisa desse serviço rodando à parte antes de usar `ELOA_VOZ_PROVEDOR=pocket`.

## Por que Python separado

O projeto principal (`eloa-bot`) é Node.js; o Pocket TTS é um pacote Python (`pip install pocket-tts`), não existe versão Node/JS real com suporte a português (o pacote `kokoro-js`, de um projeto diferente, testado antes, só tem vozes em inglês). Por isso ele roda como um processo Python separado e persistente, e o `voz.js` só chama a API HTTP dele.

## Instalação (feita em 2026-08-14, já rodando nesta máquina)

```bash
python -m pip install --no-cache-dir "pocket-tts[audio]>=2.1.0,<3"
```

Não precisou de `HF_TOKEN` nem de aceitar termos de licença no Hugging Face — o modelo `kyutai/pocket-tts` baixou direto, sem exigir conta/token (só um aviso de rate-limit por download anônimo, não um erro 401/403).

## Como subir o serviço

```bash
pocket-tts serve --host 0.0.0.0 --port 8000 --language portuguese
```

**Importante: use `--language portuguese`, não `--language english` (padrão) nem `--language portuguese_24l`.**

- `portuguese_24l` é uma variante maior "preview", ainda não otimizada — testamos e é **mais lenta** (~61-95s por frase, contra ~37-58s do `portuguese`), sem ganho de qualidade comprovado até agora.
- O `--help` do comando `serve` desta versão (2.1.0) não lista `portuguese_24l` — mas ele existe de verdade e funciona (confirmado pela mensagem de erro do próprio pacote ao testar um idioma inválido, que lista todos os idiomas reais disponíveis). Não confie só no `--help`; a lista real é gerada dinamicamente a partir dos arquivos de config do pacote.

O modelo carrega uma vez na inicialização (~25s nesta máquina) e fica em memória — não recarrega a cada requisição. `GET /health` só responde depois que o modelo termina de carregar (o servidor nem aceita conexões antes disso).

## API

- `GET http://localhost:8000/health` → `{"status": "healthy"}` quando pronto.
- `POST http://localhost:8000/tts` — `multipart/form-data` com `text` (obrigatório) e `voice_url` (nome de voz embutida, ex: `rafael`, ou uma URL/arquivo pra clonagem). Resposta: áudio WAV bruto (mono, 24kHz, PCM 16-bit), `Content-Type: audio/wav`.

Confirmado via `/openapi.json` do próprio servidor rodando — não foi inventado nem copiado só da documentação.

## Vozes embutidas por idioma

`rafael` (português), `alba` (padrão/outros), `giovanni` (italiano), `lola` (espanhol), `juergen` (alemão), `estelle` (francês). `rafael` foi testada e aprovada por ouvir (Rubens, 2026-08-14).

## Desempenho medido nesta máquina (CPU, sem GPU — `torch.cuda.is_available()` retorna `False`)

| Cenário | Tempo |
|---|---|
| `generate` via CLI, frio (carrega modelo + gera), `portuguese`, 3 execuções | 57.65s / 45.70s / 36.59s |
| `generate` via CLI, frio, `portuguese_24l`, 3 execuções | 95.39s / 64.71s / 60.85s |
| Servidor já quente (modelo carregado 1x), `portuguese`, 3 requisições sequenciais | 16.85s / 16.86s / 12.04s |
| RAM do processo do servidor, em uso | ~783 MB |

**Limitação real, não contornada:** mesmo com o servidor já quente, uma frase curta (~15-20 palavras) leva **12-17 segundos** pra gerar nesta máquina, sem GPU. Isso está longe de "baixa latência" pra uma conversa ao vivo — dá pra usar (é melhor que os 12/dia do Gemini free e não depende de crédito como o Fish), mas o cliente vai perceber uma espera real antes de cada resposta em voz. Se um dia rodarmos isso num servidor com GPU, a velocidade deve melhorar bastante (o "~200ms" divulgado pelo Kyutai provavelmente é medido em GPU, não CPU).

## Não implementado (fora do escopo desta primeira integração)

- **Streaming frase-a-frase com cancelamento**: dado que cada frase já demora 12-17s sozinha, um pipeline de streaming/interrupção não resolveria a limitação de fundo (velocidade de geração) — só complicaria a arquitetura sem ganho real até a geração em si ficar mais rápida (ex: com GPU).
- **Clonagem de voz feminina brasileira personalizada**: precisa de uma gravação de referência real (10-20s, uma pessoa falando, ambiente silencioso, autorizada) — ninguém forneceu esse áudio ainda. Quando houver, usar `pocket-tts export-voice` pra gerar o `.safetensors` uma única vez e cachear.
- **Normalização de números/datas/unidades por extenso**: não implementado — o dicionário de pronúncias (`../pronuncias.json`) cobre siglas/marcas fixas, mas não converte "120" em "cento e vinte" dinamicamente.
- **Autenticação/token na API local**: como o serviço só escuta em localhost e é chamado pelo próprio backend na mesma máquina, não adicionamos autenticação — seria necessário só se isso for exposto além do localhost.
