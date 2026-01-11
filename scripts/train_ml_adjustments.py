import os
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
from supabase import Client, create_client
from xgboost import XGBClassifier

# --------------------------------------------------------------------------------------
# ENV / CLIENT
# --------------------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
SPORT_KEY = os.environ.get("SPORT_KEY", "basketball_nba")
RUN_ID = os.environ.get("RUN_ID")
MODEL_VERSION = os.environ.get("MODEL_VERSION") or datetime.utcnow().strftime("mladj-%Y%m%d%H%M%S")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

MAX_ADJ = 0.05

# --------------------------------------------------------------------------------------
# HELPERS
# --------------------------------------------------------------------------------------

def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def norm_team(v: Any) -> str:
    return str(v or "").strip().lower()


def parse_date(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).strftime("%Y-%m-%d")
    except Exception:
        return None


def parse_ts(v: Any) -> Optional[pd.Timestamp]:
    try:
        return pd.to_datetime(v, utc=True)
    except Exception:
        return None


def pick_any(row: Dict[str, Any], keys: Iterable[str]) -> Any:
    for k in keys:
        if k in row and row[k] is not None:
            return row[k]
    return None


def fetch_all(table: str, cols: str = "*") -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        resp = supabase.table(table).select(cols).range(offset, offset + 999).execute()
        rows = resp.data or []
        out.extend(rows)
        if len(rows) < 1000:
            break
        offset += 1000
    return out

# --------------------------------------------------------------------------------------
# LABELS (RESULTS)
# --------------------------------------------------------------------------------------

def build_label_rows() -> List[Dict[str, Any]]:
    rows = []
    if SPORT_KEY == "basketball_nba":
        src = fetch_all("basketballref_games_nba")
    else:
        src = fetch_all("kenpom_games")

    for r in src:
        date = parse_date(pick_any(r, ["date", "game_date", "dt"]))
        away = pick_any(r, ["away_team", "team1"])
        home = pick_any(r, ["home_team", "team2"])
        away_pts = pick_any(r, ["away_pts", "score1"])
        home_pts = pick_any(r, ["home_pts", "score2"])
        if date and away and home and away_pts is not None and home_pts is not None:
            rows.append(
                dict(
                    date=date,
                    away_team=away,
                    home_team=home,
                    away_pts=float(away_pts),
                    home_pts=float(home_pts),
                )
            )
    return rows

# --------------------------------------------------------------------------------------
# MONTE CARLO RESULTS (NO PACE HERE)
# --------------------------------------------------------------------------------------

def fetch_mc_rows() -> pd.DataFrame:
    cols = (
        "sport_key,event_id,run_id,commence_time,"
        "home_team,away_team,"
        "projected_margin_home,projected_total,"
        "home_win_prob,away_win_prob,"
        "home_cover_prob,away_cover_prob,"
        "over_prob,under_prob,"
        "spread_line_home,total_line,"
        "sigma_margin_game,sigma_total_game,"
        "home_power,away_power,power_diff"
    )

    resp = (
        supabase.table("monte_carlo_results")
        .select(cols)
        .eq("sport_key", SPORT_KEY)
        .execute()
    )
    df = pd.DataFrame(resp.data or [])
    if df.empty:
        return df

    df["game_date"] = df["commence_time"].apply(parse_date)
    df["commence_ts"] = df["commence_time"].apply(parse_ts)
    df["home_team_norm"] = df["home_team"].apply(norm_team)
    df["away_team_norm"] = df["away_team"].apply(norm_team)
    return df

# --------------------------------------------------------------------------------------
# PACE FROM team_possessions (canonical + "2025")
# --------------------------------------------------------------------------------------

def fetch_pace_map_2025() -> Dict[str, float]:
    resp = supabase.table("team_possessions").select('canonical,"2025"').execute()
    rows = resp.data or []
    out: Dict[str, float] = {}
    for r in rows:
        c = r.get("canonical")
        v = r.get("2025")
        if c and v is not None:
            try:
                out[str(c).strip().lower()] = float(v)
            except Exception:
                pass
    return out

# --------------------------------------------------------------------------------------
# ODDS SNAPSHOT (CONSENSUS LINES)
# --------------------------------------------------------------------------------------

def fetch_odds_snapshot(event_ids: List[str]) -> pd.DataFrame:
    if not event_ids:
        return pd.DataFrame()

    rows: List[Dict[str, Any]] = []
    for i in range(0, len(event_ids), 800):
        chunk = event_ids[i : i + 800]
        resp = (
            supabase.table("odds_snapshot")
            .select("event_id,market,side,line,ts,bookmaker")
            .in_("event_id", chunk)
            .execute()
        )
        rows.extend(resp.data or [])

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    df["ts"] = df["ts"].apply(parse_ts)
    df["line"] = pd.to_numeric(df["line"], errors="coerce")
    df["market"] = df["market"].str.lower()
    df["side"] = df["side"].str.lower()
    return df


def build_latest_line_map(mc_df: pd.DataFrame, odds_df: pd.DataFrame) -> Dict[Tuple[str, str, str], float]:
    out = {}
    if mc_df.empty or odds_df.empty:
        return out

    odds_df = odds_df.dropna(subset=["ts", "line"])

    for event_id, g in odds_df.groupby("event_id"):
        ts = mc_df.loc[mc_df["event_id"] == event_id, "commence_ts"].iloc[0]
        g = g[g["ts"] <= ts] if pd.notna(ts) else g
        g = g.sort_values("ts", ascending=False).drop_duplicates(["market", "side", "bookmaker"])
        for (m, s), sub in g.groupby(["market", "side"]):
            out[(event_id, m, s)] = float(np.median(sub["line"]))

    return out


def apply_odds_lines(df: pd.DataFrame, lm: Dict[Tuple[str, str, str], float]) -> pd.DataFrame:
    if df.empty:
        return df

    def lk(r, m, s):
        return lm.get((r["event_id"], m, s))

    df = df.copy()
    df["spread_line_home"] = df.apply(lambda r: lk(r, "spreads", "home"), axis=1).combine_first(df["spread_line_home"])
    df["total_line"] = df.apply(lambda r: lk(r, "totals", "over"), axis=1).combine_first(df["total_line"])
    return df

# --------------------------------------------------------------------------------------
# FEATURE ENGINEERING
# --------------------------------------------------------------------------------------

def build_features(df: pd.DataFrame) -> pd.DataFrame:
    feats = pd.DataFrame()

    base_cols = [
        "home_win_prob",
        "home_cover_prob",
        "over_prob",
        "projected_margin_home",
        "projected_total",
        "spread_line_home",
        "total_line",
        "sigma_margin_game",
        "sigma_total_game",
        "home_power",
        "away_power",
        "power_diff",
        "pace_avg",
    ]

    for c in base_cols:
        feats[c] = pd.to_numeric(df.get(c), errors="coerce")

    return feats.replace([np.inf, -np.inf], np.nan).fillna(0.0)

# --------------------------------------------------------------------------------------
# MODEL
# --------------------------------------------------------------------------------------

def train_model(X: pd.DataFrame, y: pd.Series) -> Optional[XGBClassifier]:
    if X.empty or y.empty:
        return None
    m = XGBClassifier(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        objective="binary:logistic",
        eval_metric="logloss",
        random_state=42,
    )
    m.fit(X, y)
    return m


def compute_adjustments(base: np.ndarray, pred: np.ndarray):
    delta = np.clip(pred - base, -MAX_ADJ, MAX_ADJ)
    return np.clip(base + delta, 0.0, 1.0), delta

# --------------------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------------------

def main() -> None:
    labels = build_label_rows()
    mc_df = fetch_mc_rows()
    if mc_df.empty:
        raise RuntimeError("No MC rows found")

    # ---- PACE JOIN
    pace = fetch_pace_map_2025()
    mc_df["home_pace"] = mc_df["home_team_norm"].map(pace)
    mc_df["away_pace"] = mc_df["away_team_norm"].map(pace)
    mc_df["pace_avg"] = (mc_df["home_pace"] + mc_df["away_pace"]) / 2
    mc_df["pace_avg"] = mc_df["pace_avg"].fillna(mc_df["pace_avg"].mean())

    odds_df = fetch_odds_snapshot(mc_df["event_id"].tolist())
    mc_df = apply_odds_lines(mc_df, build_latest_line_map(mc_df, odds_df))

    lab = pd.DataFrame(labels)
    lab["home_team_norm"] = lab["home_team"].apply(norm_team)
    lab["away_team_norm"] = lab["away_team"].apply(norm_team)

    merged = mc_df.merge(
        lab,
        on=["game_date", "home_team_norm", "away_team_norm"],
        how="inner",
    )

    merged["home_win_label"] = (merged["home_pts"] > merged["away_pts"]).astype(int)
    margin = merged["home_pts"] - merged["away_pts"]
    total = merged["home_pts"] + merged["away_pts"]

    merged["home_cover_label"] = np.where(
        margin == merged["spread_line_home"], np.nan, (margin > merged["spread_line_home"]).astype(int)
    )
    merged["over_label"] = np.where(
        total == merged["total_line"], np.nan, (total > merged["total_line"]).astype(int)
    )

    feats = build_features(merged)

    win_m = merged["home_win_label"].notna()
    cov_m = merged["home_cover_label"].notna()
    over_m = merged["over_label"].notna()

    models = {
        "home_win": train_model(feats[win_m], merged.loc[win_m, "home_win_label"]),
        "home_cover": train_model(feats[cov_m], merged.loc[cov_m, "home_cover_label"]),
        "over": train_model(feats[over_m], merged.loc[over_m, "over_label"]),
    }

    if any(v is None for v in models.values()):
        raise RuntimeError("Model training failed")

    run_id = RUN_ID
    if not run_id:
        r = (
            supabase.table("monte_carlo_runs")
            .select("id")
            .eq("sport_key", SPORT_KEY)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
            .data
        )
        run_id = r[0]["id"]

    target = (
        supabase.table("monte_carlo_results")
        .select("*")
        .eq("sport_key", SPORT_KEY)
        .eq("run_id", run_id)
        .execute()
        .data
    )
    target_df = pd.DataFrame(target)
    target_df["home_team_norm"] = target_df["home_team"].apply(norm_team)
    target_df["away_team_norm"] = target_df["away_team"].apply(norm_team)
    target_df["pace_avg"] = (
        target_df["home_team_norm"].map(pace) + target_df["away_team_norm"].map(pace)
    ) / 2

    adj = apply_models(target_df, models)

    payload = []
    for _, r in adj.iterrows():
        payload.append(
            dict(
                sport_key=r["sport_key"],
                event_id=r["event_id"],
                run_id=r["run_id"],
                model_version=MODEL_VERSION,
                adj_home_win_prob=float(r["adj_home_win_prob"]),
                adj_away_win_prob=float(r["adj_away_win_prob"]),
                adj_home_cover_prob=float(r["adj_home_cover_prob"]),
                adj_away_cover_prob=float(r["adj_away_cover_prob"]),
                adj_over_prob=float(r["adj_over_prob"]),
                adj_under_prob=float(r["adj_under_prob"]),
                updated_at=datetime.utcnow().isoformat(),
            )
        )

    supabase.table("model_ml_adjustments").upsert(
        payload, on_conflict="sport_key,event_id,model_version"
    ).execute()

    print(f"Stored {len(payload)} ML adjustments ({MODEL_VERSION})")


if __name__ == "__main__":
    main()

