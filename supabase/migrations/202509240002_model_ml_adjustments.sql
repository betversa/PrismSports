create table if not exists public.model_ml_adjustments (
  sport_key text not null,
  event_id text not null,
  run_id text not null,
  model_version text,
  base_home_win_prob double precision,
  base_away_win_prob double precision,
  adj_home_win_prob double precision,
  adj_away_win_prob double precision,
  delta_home_win_prob double precision,
  delta_away_win_prob double precision,
  base_home_cover_prob double precision,
  base_away_cover_prob double precision,
  adj_home_cover_prob double precision,
  adj_away_cover_prob double precision,
  delta_home_cover_prob double precision,
  delta_away_cover_prob double precision,
  base_over_prob double precision,
  base_under_prob double precision,
  adj_over_prob double precision,
  adj_under_prob double precision,
  delta_over_prob double precision,
  delta_under_prob double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (sport_key, event_id, run_id)
);

create index if not exists model_ml_adjustments_run_idx
  on public.model_ml_adjustments (run_id);
