# FrogShare no Grafana

Um painel com quem transmite, quem assiste, os erros e o consumo da Cloudflare, lido direto do banco do
Supabase (a tabela `error_logs`, para onde o app, a sala e a transmissão pelo navegador já mandam tudo).
Só números: as visões em `supabase.sql` deixam de fora ids de sala, de pessoas e nomes, e o login do
Grafana não enxerga mais nada do banco.

O Grafana nunca consulta o servidor do Render: cada consulta acordaria o servidor no plano grátis e
gastaria as horas do mês. O que está ao vivo chega pelo próprio banco: o servidor grava um retrato (só
contagens) a cada 5 minutos enquanto está acordado.

## 1. Supabase: as visões e o login de leitura

1. No Supabase, abra o projeto do FrogShare e vá em **SQL Editor > New query**.
2. Cole o conteúdo de [`supabase.sql`](supabase.sql).
3. Troque `TROQUE_ESTA_SENHA` por uma senha longa sua. Ela não fica em nenhum arquivo, só no banco e no Grafana.
4. Clique em **Run**. Pode rodar de novo quando o arquivo mudar.

## 2. Supabase: o endereço para o Grafana

Clique em **Connect** (no topo do projeto) e escolha **Session pooler**. O Grafana Cloud não alcança o
endereço direto do banco no plano grátis, que é só IPv6. Anote:

- **Host:** algo como `aws-0-sa-east-1.pooler.supabase.com`, com a porta **5432**
- **Database:** `postgres`
- **User:** o que aparece lá é `postgres.<id-do-projeto>`; use `grafana_reader.<id-do-projeto>` (troque só a parte antes do ponto)

## 3. Grafana Cloud: a conexão

1. Crie a conta grátis em grafana.com e abra o seu Grafana (`<nome>.grafana.net`).
2. **Connections > Add new connection > PostgreSQL > Add new data source**.
3. Preencha:
   - **Host URL:** `host:5432` do passo 2
   - **Database name:** `postgres`
   - **Username:** `grafana_reader.<id-do-projeto>`
   - **Password:** a senha do passo 1
   - **TLS/SSL Mode:** `require`
   - **Version:** 15
4. Clique em **Save & test**. Tem que aparecer "Database Connection OK".

## 4. O painel e os alertas, pelo script

Com um token do Grafana, [`grafana-sync.js`](grafana-sync.js) faz tudo sozinho:

- `node monitoring/grafana-sync.js check` roda a consulta de cada quadro e de cada alerta contra os dados de verdade (só lê).
- `node monitoring/grafana-sync.js apply` faz o mesmo e, se tudo der certo:
  - importa o painel e a vitrine pública na pasta FrogShare
  - cria o contato do Discord, a não ser que já exista um chamado "FrogShare Discord"
  - cria os alertas
- `node monitoring/grafana-sync.js publicar` liga o link público da vitrine, e `despublicar` desliga.

O token: **Administration > Users and access > Service accounts > Add service account**, papel **Editor** (basta
para o painel e os alertas; só `publicar` exige **Admin**), e **Add service account token**. No `.env.local` (fica
fora do GitHub):

```
GRAFANA_URL=https://<seu-stack>.grafana.net
GRAFANA_TOKEN=<o token>
DISCORD_WEBHOOK_URL=<o webhook do canal>   (opcional; sem ele os alertas vão para o e-mail da conta)
```

Sem token: **Dashboards > New > Import**, envie [`grafana-dashboard.json`](grafana-dashboard.json), escolha a
conexão do passo 3 e clique em **Import** (para atualizar: **Import (Overwrite)**).

**Como o painel é organizado:**
- **No topo, sempre abertos:**
  - os 6 números principais com a tendência: imagem fluida, fps, erros, transmissões e pessoas agora, Cloudflare
  - os dois gráficos principais: qualidade e movimento
  - o resumo de por que travou, como a imagem chega e a Cloudflare
- **Embaixo, em seções que abrem com um clique:** os detalhes de quem assiste, de quem transmite, dos erros e do servidor. Elas só consultam o banco quando abertas.
- **Filtro "Versão do app":** compara uma versão nova com a anterior nos quadros de quem transmite.
- **Marcas roxas:** aparecem nos gráficos quando uma versão do app transmite pela primeira vez.

O retrato do servidor (o que está ao vivo e a Cloudflare) começou a ser gravado em 18/11; o resto vem do histórico.

**A vitrine pública ("FrogShare ao vivo", [`grafana-public.json`](grafana-public.json)):** um segundo painel, para
mostrar fora (o portfólio), só com números somados: horas assistidas e transmitidas, imagem rodando, movimento,
por que travou, como a imagem chega e os limites do plano grátis. Não mostra erros, versões nem texto livre. O
link público se liga no próprio painel, em **Share > Share externally** (papel Admin), ou com `publicar` e um
token Admin. Quem tem o link vê os números sem login.

Na conexão do Grafana, em **Additional settings**:

- **Max open:** `5`
- **Auto max idle:** desligado, com **Max idle** em `2`
- **Max lifetime:** `600`

O login pode ter até 15 conexões, e o painel carrega vários quadros juntos. O Grafana Cloud pode consultar de
mais de um servidor, e conexões paradas ficam abertas. Sem esses limites, alguns quadros falham com
"too many connections for role grafana_reader".

Para mudar o painel: edite `dashboard.js` e rode `node monitoring/dashboard.js`, que gera o JSON de novo.

## 5. Alertas

Ficam no grupo "frogshare" da pasta FrogShare (**Alerting > Alert rules**), avaliados a cada 5 minutos, e
avisam no contato "FrogShare Discord":

| Alerta | Quando |
|---|---|
| Erro novo | um erro que não aparecia há 30 dias surge na última hora (a mensagem do erro vai no aviso) |
| Muitos erros | mais de 20 erros na última hora |
| Quem assiste está travando | nos últimos 30 minutos, com pelo menos 20 minutos assistidos, a imagem ficou parada mais de 8 s por minuto em média, por 10 minutos seguidos |
| Cloudflare passou de 70% do mês | o uso do mês passa de 630 GB |
| Cloudflare passou de 90% do mês | o uso do mês passa de 810 GB (urgente: perto de 900 GB o servidor deixa de usar relay e servidor de mídia) |
| Banco do Supabase passou de 400 MB | o banco chega a 400 MB dos 500 do plano grátis (cheio, pode ficar só para leitura; a limpeza opcional de `supabase.sql` resolve) |

Para mudar um limite: edite `alertRules` em `grafana-sync.js` e rode o `apply` (ele refaz o grupo inteiro), ou
mude no próprio Grafana.

Para o Discord: no canal, **Editar canal > Integrações > Webhooks > Novo webhook > Copiar URL**. Depois, ou põe em
`DISCORD_WEBHOOK_URL`, ou cria no Grafana em **Alerting > Contact points > Add contact point > Discord** com o
nome "FrogShare Discord". Um só: dois com o mesmo nome mandam cada aviso duas vezes.

## Espaço no banco

Hoje entram poucas dezenas de MB por mês, longe dos 500 MB do plano grátis. No fim de `supabase.sql` há
uma limpeza automática opcional (estatísticas com mais de 90 dias). Ela vem desligada, porque apagar é
permanente.
