# Passo a passo pro Claude da Aline — colocar a Eva no ar

Execute nessa ordem, um bloco de cada vez.

## 1. Clonar o repositório (se ainda não tiver na máquina)

```bash
git clone https://github.com/mktrtcar/rtcar-crm.git
cd rtcar-crm/eloa-bot
```

Se já tiver clonado antes, só atualizar:

```bash
git pull origin master
```

## 2. Instalar as dependências

```bash
npm install
```

## 3. Criar o arquivo de configuração

```bash
cp .env.example .env
```

Depois abrir o `.env` (dentro de `eloa-bot/`) e preencher só estas duas linhas:

```
GOOGLE_AI_API_KEY=<pedir pro Rubens colar o valor dele — está no eloa-bot\.env do Rubens, linha 5>
ELOA_TEL=5547992812847
```

Deixar `ANTHROPIC_API_KEY` em branco por enquanto — ainda não está em uso.

## 4. Colocar a sessão do WhatsApp

O Rubens vai te mandar uma pasta chamada `auth` (com a sessão do número
+55 47 99281-2847 já vinculada). Pedir pra ele mandar por um canal seguro
(não postar publicamente — tem credenciais de sessão dentro).

Colocar essa pasta exatamente aqui, do lado do `index.js`:

```
eloa-bot/auth/
```

(ou seja: `rtcar-crm/eloa-bot/auth/creds.json` e os outros arquivos dentro dela)

## 5. Rodar

```bash
node index.js
```

Se aparecer `✅` no terminal e nenhum erro, está no ar. **Importante:** esse
processo precisa ficar rodando o tempo todo — se fechar o terminal, a Eva
para de responder. Se quiser que sobreviva a reinícios/quedas, perguntar
pro Claude de vocês sobre usar `pm2` (opcional, não obrigatório pra
funcionar).
