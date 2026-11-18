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

## 4. O painel

**Dashboards > New > Import**, envie [`grafana-dashboard.json`](grafana-dashboard.json), escolha a conexão do
passo 3 e clique em **Import**.

As partes "Agora", "Ao vivo ao longo do tempo" e "Cloudflare" se enchem com o retrato do servidor, que
começa a ser gravado depois que esta versão do servidor está no Render. O resto já vem do histórico.

- **Filtro "Versão do app":** fica no topo e serve para comparar uma versão nova com a anterior nos quadros de quem transmite.
- **Marcas roxas:** aparecem nos gráficos quando uma versão do app transmite pela primeira vez.
- **Atualizar o painel:** importe o JSON de novo e escolha **Import (Overwrite)**.

Na conexão do Grafana, deixe **Max open** em 5: o login só pode abrir 5 conexões ao mesmo tempo, e o painel
carrega vários quadros juntos. Com mais, alguns quadros falham com "too many connections".

Para mudar o painel: edite `dashboard.js` e rode `node monitoring/dashboard.js`, que gera o JSON de novo.

## 5. Alertas (próximo passo)

Os alertas ficam no próprio Grafana (**Alerting > Alert rules**), com aviso num canal do Discord:

- **Erros:** erro novo depois de uma versão, ou muitos erros em uma hora
- **Travadas:** subindo para quem assiste
- **Cloudflare:** passando de 70% e de 90% do limite

Para o Discord: no canal, **Editar canal > Integrações > Webhooks > Novo webhook > Copiar URL**, e no Grafana
**Alerting > Contact points > Add contact point > Discord**. A URL fica só no Grafana.

## Espaço no banco

Hoje entram poucas dezenas de MB por mês, longe dos 500 MB do plano grátis. No fim de `supabase.sql` há
uma limpeza automática opcional (estatísticas com mais de 90 dias). Ela vem desligada, porque apagar é
permanente.
