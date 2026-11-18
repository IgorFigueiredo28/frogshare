-- FrogShare no Grafana: visões só de leitura sobre a tabela error_logs (para onde vão todos os relatórios:
-- erros, qualidade de quem assiste e de quem transmite, e o retrato do servidor), sem ids de sala nem de
-- pessoas, e um login que só enxerga essas visões.
--
-- Rodar no Supabase: SQL Editor > New query > colar tudo > trocar a senha marcada lá embaixo > Run.
-- Pode rodar de novo quando este arquivo mudar: ele recria as visões e mantém o login.

-- O Grafana sempre filtra por tipo de relatório e data: este índice deixa isso rápido
create index if not exists error_logs_source_created_at on public.error_logs (source, created_at desc);

create schema if not exists monitoring;

-- Números e sim/não guardados no JSON; qualquer outra coisa vira vazio em vez de quebrar a consulta
create or replace function monitoring.num(v text) returns numeric
language sql immutable as $$
  select case when v ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' then v::numeric end
$$;

create or replace function monitoring.flag(v text) returns boolean
language sql immutable as $$
  select case lower(v) when 'true' then true when 'false' then false end
$$;

-- Navegador e sistema a partir do user agent (o user agent em si não aparece nas visões)
create or replace function monitoring.browser(ua text) returns text
language sql immutable as $$
  select case
    when ua is null or ua = '' then 'desconhecido'
    when ua ~* 'Electron/' then 'app FrogShare'
    when ua ~* 'Edg/' then 'Edge'
    when ua ~* 'OPR/|Opera' then 'Opera'
    when ua ~* 'Firefox/|FxiOS/' then 'Firefox'
    when ua ~* 'Chrome/|CriOS/' then 'Chrome'
    when ua ~* 'Safari/' then 'Safari'
    else 'outro'
  end
$$;

create or replace function monitoring.platform(ua text) returns text
language sql immutable as $$
  select case
    when ua is null or ua = '' then 'desconhecido'
    when ua ~* 'Android' then 'Android'
    when ua ~* 'iPhone|iPad|iPod' then 'iPhone/iPad'
    when ua ~* 'Windows' then 'Windows'
    when ua ~* 'Macintosh|Mac OS X' then 'Mac'
    when ua ~* 'CrOS' then 'Chromebook'
    when ua ~* 'Linux' then 'Linux'
    else 'outro'
  end
$$;

-- Quem assiste: uma linha por pessoa por minuto (página da sala)
create or replace view monitoring.viewer_quality as
select
  l.created_at as time,
  l.app_version,
  monitoring.browser(l.user_agent) as browser,
  monitoring.platform(l.user_agent) as platform,
  monitoring.num(j.c->>'avgFps') as avg_fps,
  monitoring.num(j.c->>'minFps') as min_fps,
  coalesce(monitoring.num(j.c->>'freezes'), 0) as freezes,
  coalesce(monitoring.num(j.c->>'freezeMs'), 0) / 1000.0 as frozen_s,
  monitoring.num(j.c->>'lossPct') as loss_pct,
  monitoring.num(j.c->>'rttMs') as rtt_ms,
  monitoring.num(j.c->>'avgJbMs') as buffer_ms,
  monitoring.num(j.c->>'avgKbps') as kbps,
  coalesce(monitoring.flag(j.c->>'sfu'), false) as via_sfu,
  coalesce(monitoring.flag(j.c->>'relay'), false) as via_relay,
  coalesce(monitoring.flag(j.c->>'dataSaver'), false) as data_saver,
  nullif(j.c->>'codec', '') as codec,
  nullif(j.c->>'res', '') as resolution,
  case coalesce(j.c->>'diag', '')
    when '' then 'sem problema'
    when 'network-loss' then 'perda na internet de quem assiste'
    when 'network-delay' then 'atraso na internet de quem assiste'
    when 'device' then 'aparelho de quem assiste'
    when 'host-capture' then 'captura de quem transmite'
    when 'host-upload' then 'upload de quem transmite'
    when 'host-cpu' then 'processador de quem transmite'
    when 'host-slow' then 'lentidão de quem transmite'
    else j.c->>'diag'
  end as diagnosis
from public.error_logs l
cross join lateral (select l.context::jsonb as c) j
where l.source = 'viewer-stats';

-- Quem transmite pelo app: uma linha por minuto, com os links (uma por pessoa ou o servidor de mídia)
-- resumidos; os ids que vêm dentro de cada link nunca saem do resumo
create or replace view monitoring.host_quality as
select
  l.created_at as time,
  l.app_version,
  monitoring.platform(l.user_agent) as platform,
  j.c->>'mode' as mode,
  j.c->>'capture' as capture,
  j.c->>'preset' as preset,
  coalesce(monitoring.flag(j.c->>'autoFps'), false) as auto_fps,
  monitoring.num(j.c->>'roomViewers') as room_viewers,
  monitoring.num(j.c->'pipeline'->>'srcFps') as capture_fps,
  monitoring.num(j.c->'pipeline'->>'outFps') as pipeline_fps,
  monitoring.num(j.c->'pipeline'->>'drawMs') as draw_ms,
  monitoring.num(j.c->'pipeline'->>'pacerDropped') as pacer_dropped,
  monitoring.num(j.c->'pipeline'->>'longGaps') as long_gaps,
  (select sum(monitoring.num(e.value))
     from jsonb_each_text(case when jsonb_typeof(j.c->'appCpu') = 'object' then j.c->'appCpu' else '{}'::jsonb end) e) as app_cpu,
  nullif(j.c->'gpu'->>'model', '') as gpu_model,
  v.links, v.links_gpu, v.links_cpu, v.sent_fps, v.upload_kbps, v.encode_ms, v.cpu_limited, v.bandwidth_limited
from public.error_logs l
cross join lateral (select l.context::jsonb as c) j
cross join lateral (
  select
    count(*) as links,
    count(*) filter (where coalesce(monitoring.flag(x->>'gpu'), false)) as links_gpu,
    count(*) filter (where not coalesce(monitoring.flag(x->>'gpu'), false)) as links_cpu,
    max(monitoring.num(x->>'fps')) as sent_fps,
    sum(monitoring.num(x->>'kbps')) as upload_kbps,
    avg(monitoring.num(x->>'encMs')) as encode_ms,
    coalesce(bool_or(x->>'limit' = 'cpu'), false) as cpu_limited,
    coalesce(bool_or(x->>'limit' = 'bandwidth'), false) as bandwidth_limited
  from jsonb_array_elements(case when jsonb_typeof(j.c->'viewers') = 'array' then j.c->'viewers' else '[]'::jsonb end) x
  where not coalesce(monitoring.flag(x->>'idle'), false)
) v
where l.source = 'host-stats';

-- Quem transmite pelo navegador (transmitir.html): uma linha por minuto
create or replace view monitoring.web_host_quality as
select
  l.created_at as time,
  monitoring.browser(l.user_agent) as browser,
  monitoring.platform(l.user_agent) as platform,
  j.c->>'mode' as mode,
  monitoring.flag(j.c->>'main') as main_profile,
  j.c->>'preset' as preset,
  coalesce(monitoring.flag(j.c->>'autoFps'), false) as auto_fps,
  coalesce(monitoring.flag(j.c->>'piped'), false) as piped,
  monitoring.num(j.c->>'roomViewers') as room_viewers,
  monitoring.num(j.c->'pipeline'->>'srcFps') as capture_fps,
  monitoring.num(j.c->'pipeline'->>'outFps') as pipeline_fps,
  monitoring.num(j.c->'pipeline'->>'drawMs') as draw_ms,
  v.links, v.links_gpu, v.links_cpu, v.sent_fps, v.upload_kbps, v.codec, v.cpu_limited, v.bandwidth_limited
from public.error_logs l
cross join lateral (select l.context::jsonb as c) j
cross join lateral (
  select
    count(*) as links,
    count(*) filter (where coalesce(monitoring.flag(x->>'gpu'), false)) as links_gpu,
    count(*) filter (where not coalesce(monitoring.flag(x->>'gpu'), false)) as links_cpu,
    max(monitoring.num(x->>'fps')) as sent_fps,
    sum(monitoring.num(x->>'kbps')) as upload_kbps,
    max(nullif(x->>'codec', '')) as codec,
    coalesce(bool_or(x->>'limit' = 'cpu'), false) as cpu_limited,
    coalesce(bool_or(x->>'limit' = 'bandwidth'), false) as bandwidth_limited
  from jsonb_array_elements(case when jsonb_typeof(j.c->'viewers') = 'array' then j.c->'viewers' else '[]'::jsonb end) x
  where not coalesce(monitoring.flag(x->>'idle'), false)
) v
where l.source = 'web-host-stats';

-- Erros do app, da sala e da transmissão pelo navegador; números e códigos (ids de sala, sessões) viram
-- N e # na mensagem, para erros iguais se juntarem e nenhum id aparecer
create or replace view monitoring.errors as
select
  l.created_at as time,
  case l.source
    when 'host' then 'app (tela)'
    when 'main' then 'app (processo)'
    when 'viewer' then 'sala'
    when 'web-host' then 'transmitir pelo navegador'
    else l.source
  end as origin,
  l.app_version,
  monitoring.browser(l.user_agent) as browser,
  monitoring.platform(l.user_agent) as platform,
  left(regexp_replace(regexp_replace(coalesce(l.message, ''), '[0-9a-f]{8,}', '#', 'gi'), '[0-9]+', 'N', 'g'), 200) as message
from public.error_logs l
where l.source in ('host', 'main', 'viewer', 'web-host');

-- O servidor a cada 5 minutos enquanto está acordado: o que está ao vivo (só contagens) e a Cloudflare
create or replace view monitoring.server_stats as
select
  l.created_at as time,
  coalesce(monitoring.num(j.c->>'rooms'), 0) as rooms_live,
  coalesce(monitoring.num(j.c->>'streams'), 0) as streams,
  coalesce(monitoring.num(j.c->>'viewers'), 0) as viewers,
  coalesce(monitoring.num(j.c->>'sfu'), 0) as sfu_streams,
  coalesce(monitoring.num(j.c->>'web'), 0) as web_streams,
  coalesce(monitoring.num(j.c->>'groups'), 0) as group_rooms,
  monitoring.num(j.c->'cloudflare'->>'usedGb') as cloudflare_gb,
  monitoring.num(j.c->'cloudflare'->>'capGb') as cloudflare_cap_gb,
  monitoring.num(j.c->'cloudflare'->>'turnGb') as cloudflare_relay_gb,
  monitoring.num(j.c->'cloudflare'->>'sfuGb') as cloudflare_sfu_gb,
  case when jsonb_typeof(j.c->'versions') = 'object' then j.c->'versions' else '{}'::jsonb end as versions
from public.error_logs l
cross join lateral (select l.context::jsonb as c) j
where l.source = 'server-stats';

-- Login do Grafana: só lê as visões acima. Não enxerga a tabela error_logs nem mais nada do banco, e
-- cada consulta tem no máximo 20 s.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'grafana_reader') then
    create role grafana_reader with login;
  end if;
end
$$;
-- >>> TROQUE a senha abaixo por uma sua, longa, antes de clicar em Run (e não salve ela em arquivo) <<<
alter role grafana_reader with password 'TROQUE_ESTA_SENHA';
alter role grafana_reader set statement_timeout = '20s';
alter role grafana_reader connection limit 5;
grant usage on schema monitoring to grafana_reader;
grant select on all tables in schema monitoring to grafana_reader;
grant execute on all functions in schema monitoring to grafana_reader;

-- (Opcional) Limpeza automática: estatísticas com mais de 90 dias e erros com mais de 1 ano somem toda
-- madrugada. Nunca toca nos registros que o servidor usa (nomes de sala, expulsões, bloqueios, uso).
-- Hoje entram poucas dezenas de MB por mês, longe dos 500 MB do plano grátis, então só ligue se quiser.
-- Para ligar: Database > Extensions > pg_cron (ligar), depois rode as duas linhas abaixo sem os "--".
-- Apagar é permanente.
-- select cron.schedule('frogshare-limpa-estatisticas', '30 6 * * *', $$delete from public.error_logs where source in ('viewer-stats', 'host-stats', 'web-host-stats', 'server-stats') and created_at < now() - interval '90 days'$$);
-- select cron.schedule('frogshare-limpa-erros', '40 6 * * *', $$delete from public.error_logs where source in ('host', 'main', 'viewer', 'web-host') and created_at < now() - interval '365 days'$$);
