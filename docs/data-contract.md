# PrismSports Data Contract (UI + Logic Lock)

This document enumerates the Supabase tables/columns and the locked calculation behavior used by the UI.

## Supabase tables + columns (read-only usage)

### Core settings
- `app_settings`: `id`, `bankroll`, `kelly_factor`, `updated_at`

### Models & versions
- `model_versions`: `version`, `status`, `simulations`, `updated_at`, `release_date`
- `model_changelog`: `version`, `date`, `changes`

### Monte Carlo projections
- `monte_carlo_runs`: `id`, `created_at`, `sport_key`
- `monte_carlo_results`: `run_id`, `sport_key`, `event_id`, `commence_time`, `home_team`, `away_team`, `projected_margin_home`, `projected_total`, `projected_home_points`, `projected_away_points`, `home_cover_prob`, `away_cover_prob`, `over_prob`, `under_prob`, `home_win_prob`, `away_win_prob`

### EV plays & props
- `ev_plays`: `id`, `run_id`, `sport_key`, `event_id`, `commence_time`, `matchup`, `market`, `side`, `team`, `line`, `bookmaker`, `book_odds`, `odds`, `quantum_fair_odds`, `fair_odds`, `quantum_odds`, `ev_pct`, `ev`, `confidence_score`, `score`, `created_at`
- `player_prop_ev_latest`: `id`, `sport_key`, `event_id`, `commence_time`, `team`, `opponent`, `player_name`, `position`, `picture_url`, `market`, `side`, `line`, `book`, `odds`, `mu`, `quantum_fair_odds`, `ev_pct`, `kelly_fraction`, `score`
- `player_props_history`: `player_name`, `market`, `side`, `book`, `odds`, `ts`
- `player_props_snapshot`: `ts`, `snapshot_ts`, `inserted_at`, `player_name`, `team`, `book`, `side`, `line`, `odds`

### Odds & history
- `odds_wide_latest`: `event_id`, `sport_key`, `commence_time`, plus sportsbook columns for moneyline/spread/total (e.g. `dk_ml_odds`, `fd_spread_line`, `mgm_total_over_odds`, etc.)
- `odds_snapshot`: `ts`, `event_id`, `market`, `side`, `line`, `odds`, `bookmaker`
- `odds_snapshot_history`: `sport_key`, `event_id`, `market`, `side`, `line`, `book`, `odds`, `ts`
- Odds history candidates (unchanged selection semantics): `odds_history`, `odds_log`, `odds_snapshots`

### Team metadata
- `team_map`: `canonical`, `abbreviation`, `Abbreviation`, `Abbreviation2`, `Logo URL`
- `team_ratings`: `canonical`, `sport_key`, `power_rank`, `engine_power`, `engine_adj_off`, `engine_adj_def`, `pace`, `true_hca`, `sigma_margin_100`, `sigma_total_100`
- `ncaab_stats`: `stat_key`, `home_score`, `away_score`, `canonical_home`, `canonical_away`, `home_team`, `away_team`
- `events`: `event_id`, `sport_key`, `commence_time`, `home_team`, `away_team`

### Results
- `game_model_results`: columns selected via `baseSelect` / `fallbackSelect` in `ResultsScreen.tsx` (kept unchanged)

### AI calibration (additive layer)
- `ai_model_versions`: `id`, `sport_key`, `model_type`, `active`, `trained_from`, `trained_to`, `params`, `sample_counts`, `created_at`
- `ai_adjusted_results`: `sport_key`, `event_id`, `run_id`, `model_version_id`, `ai_home_win_prob`, `ai_away_win_prob`, `ai_home_cover_prob`, `ai_away_cover_prob`, `ai_over_prob`, `ai_under_prob`, `created_at`, `updated_at`

## Locked calculations (behavior must remain identical)

### Odds conversions
- American → Decimal: `dec = 1 + odds/100` for positive odds, `dec = 1 + 100/abs(odds)` for negative odds.
- Decimal → American: `profit = dec - 1`; if `profit >= 1` then `+profit*100`, else `-100/profit`.
- Implied probability: from American or Decimal, with the same clamping and NaN handling as before.

### EV and Kelly
- EV% per $1 stake: `EV = p*(dec-1) - (1-p)` and `EV% = EV * 100`.
- Kelly fraction: `f* = (b*p - q) / b`, where `b = dec - 1`, `q = 1 - p`.

### Odds consensus & medians
- Consensus lines/odds computed via median of available sportsbook values, ignoring non-finite entries.

### Win/cover/total probabilities
- Probabilities accept 0–1 or 0–100 inputs and are normalized to a 0–1 range, then clamped to `[0,1]`.

### EV% normalization
- If `ev_pct` is `<= 1` by absolute value, it is treated as a fraction and multiplied by 100.

## Notes
- Query semantics, filters, and ordering are preserved as-is.
- Column names and table names are unchanged.
- Game model writes use split procedures: projection upserts protect `picked_*` columns while finals/grading updates only touch status + final fields.
