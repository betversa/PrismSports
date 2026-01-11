create extension if not exists "pgcrypto";

alter table public.game_model_results
  drop constraint if exists game_model_results_pkey;

alter table public.game_model_results
  add constraint game_model_results_pkey primary key (sport_key, event_id, run_id);

create table if not exists public.ai_model_versions (
  id uuid primary key default gen_random_uuid(),
  sport_key text,
  model_type text not null default 'platt',
  active boolean not null default false,
  trained_from date,
  trained_to date,
  params jsonb not null,
  sample_counts jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_model_versions_active_idx
  on public.ai_model_versions (sport_key, active, created_at desc);

create table if not exists public.ai_adjusted_results (
  sport_key text not null,
  event_id text not null,
  run_id text not null,
  model_version_id uuid references public.ai_model_versions(id) on delete set null,
  ai_home_win_prob double precision,
  ai_away_win_prob double precision,
  ai_home_cover_prob double precision,
  ai_away_cover_prob double precision,
  ai_over_prob double precision,
  ai_under_prob double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (sport_key, event_id, run_id)
);

create or replace function public.upsert_game_model_results_projection(rows jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.game_model_results (
    sport_key,
    event_id,
    run_id,
    game_date,
    commence_time,
    home_team,
    away_team,
    projected_total,
    projected_margin_home,
    projected_home_points,
    projected_away_points,
    home_win_prob,
    away_win_prob,
    home_cover_prob,
    away_cover_prob,
    over_prob,
    under_prob,
    spread_line_home,
    total_line,
    ev_pct,
    edge_pct,
    edge,
    ml_edge_pct,
    spread_edge_pct,
    total_edge_pct,
    picked_any,
    picked_ml,
    picked_spread,
    picked_total
  )
  select
    sport_key,
    event_id,
    run_id,
    game_date,
    commence_time,
    home_team,
    away_team,
    projected_total,
    projected_margin_home,
    projected_home_points,
    projected_away_points,
    home_win_prob,
    away_win_prob,
    home_cover_prob,
    away_cover_prob,
    over_prob,
    under_prob,
    spread_line_home,
    total_line,
    ev_pct,
    edge_pct,
    edge,
    ml_edge_pct,
    spread_edge_pct,
    total_edge_pct,
    picked_any,
    picked_ml,
    picked_spread,
    picked_total
  from jsonb_to_recordset(rows) as x(
    sport_key text,
    event_id text,
    run_id text,
    game_date date,
    commence_time timestamptz,
    home_team text,
    away_team text,
    projected_total double precision,
    projected_margin_home double precision,
    projected_home_points double precision,
    projected_away_points double precision,
    home_win_prob double precision,
    away_win_prob double precision,
    home_cover_prob double precision,
    away_cover_prob double precision,
    over_prob double precision,
    under_prob double precision,
    spread_line_home double precision,
    total_line double precision,
    ev_pct double precision,
    edge_pct double precision,
    edge double precision,
    ml_edge_pct double precision,
    spread_edge_pct double precision,
    total_edge_pct double precision,
    picked_any boolean,
    picked_ml boolean,
    picked_spread boolean,
    picked_total boolean
  )
  on conflict (sport_key, event_id, run_id) do update set
    game_date = excluded.game_date,
    commence_time = excluded.commence_time,
    home_team = excluded.home_team,
    away_team = excluded.away_team,
    projected_total = excluded.projected_total,
    projected_margin_home = excluded.projected_margin_home,
    projected_home_points = excluded.projected_home_points,
    projected_away_points = excluded.projected_away_points,
    home_win_prob = excluded.home_win_prob,
    away_win_prob = excluded.away_win_prob,
    home_cover_prob = excluded.home_cover_prob,
    away_cover_prob = excluded.away_cover_prob,
    over_prob = excluded.over_prob,
    under_prob = excluded.under_prob,
    spread_line_home = excluded.spread_line_home,
    total_line = excluded.total_line,
    ev_pct = excluded.ev_pct,
    edge_pct = excluded.edge_pct,
    edge = excluded.edge,
    ml_edge_pct = excluded.ml_edge_pct,
    spread_edge_pct = excluded.spread_edge_pct,
    total_edge_pct = excluded.total_edge_pct,
    picked_any = coalesce(game_model_results.picked_any, excluded.picked_any),
    picked_ml = coalesce(game_model_results.picked_ml, excluded.picked_ml),
    picked_spread = coalesce(game_model_results.picked_spread, excluded.picked_spread),
    picked_total = coalesce(game_model_results.picked_total, excluded.picked_total);
end;
$$;

create or replace function public.update_game_model_results_finals(rows jsonb)
returns void
language plpgsql
as $$
begin
  update public.game_model_results as g
  set
    status = coalesce(x.status, g.status),
    final_home_score = coalesce(x.final_home_score, g.final_home_score),
    final_away_score = coalesce(x.final_away_score, g.final_away_score),
    actual_total = coalesce(x.actual_total, g.actual_total),
    actual_margin_home = coalesce(x.actual_margin_home, g.actual_margin_home),
    model_ml_hit = coalesce(x.model_ml_hit, g.model_ml_hit),
    model_spread_hit = coalesce(x.model_spread_hit, g.model_spread_hit),
    model_total_hit = coalesce(x.model_total_hit, g.model_total_hit)
  from jsonb_to_recordset(rows) as x(
    sport_key text,
    event_id text,
    run_id text,
    status text,
    final_home_score double precision,
    final_away_score double precision,
    actual_total double precision,
    actual_margin_home double precision,
    model_ml_hit boolean,
    model_spread_hit text,
    model_total_hit text
  )
  where g.sport_key = x.sport_key
    and g.event_id = x.event_id
    and g.run_id = x.run_id;
end;
$$;
