import os
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
from supabase import Client, create_client
from xgboost import XGBClassifier

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
SPORT_KEY = os.environ.get("SPORT_KEY", "basketball_nba")
RUN_ID = os.environ.get("RUN_ID")
MODEL_VERSION = os.environ.get("MODEL_VERSION") or datetime.utcnow().strftime("mladj-%Y%m%d%H%M%S")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

MAX_ADJ = 0.05


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def norm_team(name: Any) -> str:
    return str(name or "").strip().lower()


def parse_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return None


def parse_ts(value: Any) -> Optional[pd.Timestamp]:
    if value is None:
        return None
    try:
        return pd.to_datetime(value, utc=True)
    except Exception:
        return None


def pick_any(row: Dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return None


def fetch_table_rows(table: str, columns: str = "*") -> List[Dict[str, Any]]:
    page_size = 1000
    offset = 0
    all_rows: List[Dict[str, Any]] = []
    while True:
        resp = supabase.table(table).select(columns).range(offset, offset + page_size - 1).execute()
        rows = resp.data or []
        all_rows.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size
    return all_rows


def build_label_rows() -> List[Dict[str, Any]]:
    label_rows: List[Dict[str, Any]] = []

    if SPORT_KEY == "basketball_nba":
        rows = fetch_table_rows("basketballref_games_nba")
        for r in rows:
            date = parse_date(pick_any(r, ["date", "game_date", "Date"]))
            away = pick_any(r, ["away_team", "away", "team1", "team1_away", "Team1 (Away)"])
            home = pick_any(r, ["home_team", "home", "team2", "team2_home", "Team2 (Home)"])
            away_pts = pick_any(r, ["away_pts", "away_points", "score1", "Score1", "pts_away", "points_away"])
            home_pts = pick_any(r, ["home_pts", "home_points", "score2", "Score2", "pts_home", "points_home"])
            if date and away is not None and home is not None and away_pts is not None and home_pts is not None:
                label_rows.append(
                    {
                        "date": date,
                        "away_team": away,
                        "home_team": home,
                        "away_pts": float(away_pts),
                        "home_pts": float(home_pts),
                    }
                )
    else:
        rows = fetch_table_rows("kenpom_games")
        for r in rows:
            date = parse_date(pick_any(r, ["date", "game_date", "Date", "dt"]))
            away = pick_any(r, ["team1", "team1_away", "Team1 (Away)"])
            home = pick_any(r, ["team2", "team2_home", "Team2 (Home)"])
            away_pts = pick_any(r, ["score1", "away_pts", "away_points", "Team1 (Away) Score", "team1_score"])
            home_pts = pick_any(r, ["score2", "home_pts", "home_points", "Team2 (Home) Score", "team2_score"])
            if date and away is not None and home is not None and away_pts is not None and home_pts is not None:
                label_rows.append(
                    {
                        "date": date,
                        "away_team": away,
                        "home_team": home,
                        "away_pts": float(away_pts),
                        "home_pts": float(home_pts),
                    }
                )

    return label_rows


def fetch_mc_rows() -> pd.DataFrame:
    cols = (
        "sport_key,event_id,run_id,commence_time,home_team,away_team,projected_margin_home,projected_total,"
        "home_win_prob,away_win_prob,home_cover_prob,away_cover_prob,over_prob,under_prob,spread_line_home,total_line,"
        "sigma_margin_game,sigma_total_game,pace,home_power,away_power,power_diff"
    )
    resp = supabase.table("monte_carlo_results").select(cols).eq("sport_key", SPORT_KEY).execute()
    rows = resp.data or []
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["game_date"] = df["commence_time"].apply(parse_date)
    df["commence_ts"] = df["commence_time"].apply(parse_ts)
    df["home_team_norm"] = df["home_team"].apply(norm_team)
    df["away_team_norm"] = df["away_team"].apply(norm_team)
    return df


def fetch_odds_snapshot(event_ids: List[str]) -> pd.DataFrame:
    if not event_ids:
        return pd.DataFrame()
    chunk_size = 800
    rows: List[Dict[str, Any]] = []
    for i in range(0, len(event_ids), chunk_size):
        chunk = event_ids[i : i + chunk_size]
        resp = (
            supabase.table("odds_snapshot")
            .select("event_id,market,side,line,ts,bookmaker")
            .in_("event_id", chunk)
            .in_("market", ["spreads", "totals"])
            .in_("side", ["home", "away", "over", "under"])
            .execute()
        )
        rows.extend(resp.data or [])
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["ts"] = df["ts"].apply(parse_ts)
    df["market"] = df["market"].str.lower()
    df["side"] = df["side"].str.lower()
    df["bookmaker"] = df["bookmaker"].astype(str).str.lower()
    df["line"] = pd.to_numeric(df["line"], errors="coerce")
    return df


def build_latest_line_map(mc_df: pd.DataFrame, odds_df: pd.DataFrame) -> Dict[Tuple[str, str, str], float]:
    if mc_df.empty or odds_df.empty:
        return {}

    line_map: Dict[Tuple[str, str, str], float] = {}
    odds_df = odds_df.dropna(subset=["line", "ts"])

    for event_id, group in odds_df.groupby("event_id"):
        commence_ts = mc_df.loc[mc_df["event_id"] == event_id, "commence_ts"].iloc[0]
        if pd.isna(commence_ts):
            continue
        pregame = group[group["ts"] <= commence_ts]
        if pregame.empty:
            pregame = group

        pregame = pregame.sort_values("ts", ascending=False)
        latest_rows = (
            pregame.drop_duplicates(subset=["market", "side", "bookmaker"])  # latest per book
        )

        for (market, side), subset in latest_rows.groupby(["market", "side"]):
            lines = subset["line"].dropna().tolist()
            if not lines:
                continue
            line_map[(event_id, market, side)] = float(np.median(lines))

    for event_id in mc_df["event_id"].dropna().unique():
        home_key = (event_id, "spreads", "home")
        away_key = (event_id, "spreads", "away")
        over_key = (event_id, "totals", "over")
        under_key = (event_id, "totals", "under")

        if home_key not in line_map and away_key in line_map:
            line_map[home_key] = -line_map[away_key]
        if away_key not in line_map and home_key in line_map:
            line_map[away_key] = -line_map[home_key]
        if over_key not in line_map and under_key in line_map:
            line_map[over_key] = line_map[under_key]
        if under_key not in line_map and over_key in line_map:
            line_map[under_key] = line_map[over_key]

    return line_map


def apply_odds_lines(mc_df: pd.DataFrame, line_map: Dict[Tuple[str, str, str], float]) -> pd.DataFrame:
    if mc_df.empty:
        return mc_df

    def lookup(row: pd.Series, market: str, side: str) -> Optional[float]:
        return line_map.get((row["event_id"], market, side))

    mc_df = mc_df.copy()
    mc_df["odds_spread_home"] = mc_df.apply(lambda r: lookup(r, "spreads", "home"), axis=1)
    mc_df["odds_total"] = mc_df.apply(lambda r: lookup(r, "totals", "over"), axis=1)

    mc_df["spread_line_home"] = mc_df["odds_spread_home"].combine_first(mc_df.get("spread_line_home"))
    mc_df["total_line"] = mc_df["odds_total"].combine_first(mc_df.get("total_line"))

    return mc_df


def join_labels(mc_df: pd.DataFrame, labels: List[Dict[str, Any]]) -> pd.DataFrame:
    label_df = pd.DataFrame(labels)
    if label_df.empty or mc_df.empty:
        return pd.DataFrame()
    label_df["home_team_norm"] = label_df["home_team"].apply(norm_team)
    label_df["away_team_norm"] = label_df["away_team"].apply(norm_team)
    merged = mc_df.merge(
        label_df,
        on=["game_date", "home_team_norm", "away_team_norm"],
        how="inner",
        suffixes=("", "_label"),
    )
    return merged


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    feats = pd.DataFrame()
    feats["home_win_prob"] = df["home_win_prob"].astype(float)
    feats["home_cover_prob"] = df["home_cover_prob"].astype(float)
    feats["over_prob"] = df["over_prob"].astype(float)
    feats["projected_margin_home"] = df["projected_margin_home"].astype(float)
    feats["projected_total"] = df["projected_total"].astype(float)
    feats["spread_line_home"] = df["spread_line_home"].astype(float)
    feats["total_line"] = df["total_line"].astype(float)

    for col in ["sigma_margin_game", "sigma_total_game", "pace", "home_power", "away_power", "power_diff"]:
        if col in df.columns:
            feats[col] = df[col].astype(float)
        else:
            feats[col] = 0.0

    feats = feats.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return feats


def train_model(X: pd.DataFrame, y: pd.Series) -> Optional[XGBClassifier]:
    if X.empty or y.empty:
        return None
    model = XGBClassifier(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        objective="binary:logistic",
        eval_metric="logloss",
        random_state=42,
    )
    model.fit(X, y)
    return model


def compute_adjustments(base_probs: np.ndarray, pred_probs: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    deltas = np.clip(pred_probs - base_probs, -MAX_ADJ, MAX_ADJ)
    adjusted = np.clip(base_probs + deltas, 0.0, 1.0)
    return adjusted, deltas


def fetch_latest_run_id() -> Optional[str]:
    resp = (
        supabase.table("monte_carlo_runs")
        .select("id,created_at,sport_key")
        .eq("sport_key", SPORT_KEY)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0]["id"] if rows else None


def apply_models(target_df: pd.DataFrame, models: Dict[str, XGBClassifier]) -> pd.DataFrame:
    if target_df.empty:
        return target_df
    features = build_features(target_df)

    base_home_win = target_df["home_win_prob"].astype(float).values
    base_home_cover = target_df["home_cover_prob"].astype(float).values
    base_over = target_df["over_prob"].astype(float).values

    home_win_pred = models["home_win"].predict_proba(features)[:, 1]
    home_cover_pred = models["home_cover"].predict_proba(features)[:, 1]
    over_pred = models["over"].predict_proba(features)[:, 1]

    adj_home_win, delta_home_win = compute_adjustments(base_home_win, home_win_pred)
    adj_home_cover, delta_home_cover = compute_adjustments(base_home_cover, home_cover_pred)
    adj_over, delta_over = compute_adjustments(base_over, over_pred)

    adj_away_win = np.clip(1.0 - adj_home_win, 0.0, 1.0)
    delta_away_win = adj_away_win - target_df["away_win_prob"].astype(float).values

    adj_away_cover = np.clip(target_df["away_cover_prob"].astype(float).values - delta_home_cover, 0.0, 1.0)
    delta_away_cover = adj_away_cover - target_df["away_cover_prob"].astype(float).values

    adj_under = np.clip(target_df["under_prob"].astype(float).values - delta_over, 0.0, 1.0)
    delta_under = adj_under - target_df["under_prob"].astype(float).values

    target_df = target_df.copy()
    target_df["adj_home_win_prob"] = adj_home_win
    target_df["adj_away_win_prob"] = adj_away_win
    target_df["delta_home_win_prob"] = delta_home_win
    target_df["delta_away_win_prob"] = delta_away_win

    target_df["adj_home_cover_prob"] = adj_home_cover
    target_df["adj_away_cover_prob"] = adj_away_cover
    target_df["delta_home_cover_prob"] = delta_home_cover
    target_df["delta_away_cover_prob"] = delta_away_cover

    target_df["adj_over_prob"] = adj_over
    target_df["adj_under_prob"] = adj_under
    target_df["delta_over_prob"] = delta_over
    target_df["delta_under_prob"] = delta_under

    return target_df


def main() -> None:
    labels = build_label_rows()
    mc_df = fetch_mc_rows()
    if mc_df.empty:
        raise RuntimeError("No monte_carlo_results rows found for training.")

    odds_df = fetch_odds_snapshot(mc_df["event_id"].dropna().astype(str).unique().tolist())
    line_map = build_latest_line_map(mc_df, odds_df)
    mc_df = apply_odds_lines(mc_df, line_map)

    merged = join_labels(mc_df, labels)
    if merged.empty:
        raise RuntimeError("No matching labeled data to train on.")

    merged = merged.dropna(subset=["spread_line_home", "total_line"])
    if merged.empty:
        raise RuntimeError("No labeled rows with spread/total lines.")

    merged["home_win_label"] = (merged["home_pts"] > merged["away_pts"]).astype(int)

    margin = merged["home_pts"] - merged["away_pts"]
    merged["home_cover_label"] = np.where(
        margin == merged["spread_line_home"],
        np.nan,
        (margin > merged["spread_line_home"]).astype(int),
    )

    total = merged["home_pts"] + merged["away_pts"]
    merged["over_label"] = np.where(
        total == merged["total_line"],
        np.nan,
        (total > merged["total_line"]).astype(int),
    )

    features = build_features(merged)

    win_mask = merged["home_win_prob"].notna()
    cover_mask = merged["home_cover_prob"].notna() & merged["home_cover_label"].notna()
    over_mask = merged["over_prob"].notna() & merged["over_label"].notna()

    home_win_model = train_model(features[win_mask], merged.loc[win_mask, "home_win_label"])
    home_cover_model = train_model(features[cover_mask], merged.loc[cover_mask, "home_cover_label"])
    over_model = train_model(features[over_mask], merged.loc[over_mask, "over_label"])

    if not home_win_model or not home_cover_model or not over_model:
        raise RuntimeError("Insufficient data to train one or more models.")

    target_run_id = RUN_ID or fetch_latest_run_id()
    if not target_run_id:
        raise RuntimeError("Missing RUN_ID and unable to resolve latest run.")

    target_resp = (
        supabase.table("monte_carlo_results")
        .select(
            "sport_key,event_id,run_id,commence_time,home_team,away_team,projected_margin_home,projected_total,"
            "home_win_prob,away_win_prob,home_cover_prob,away_cover_prob,over_prob,under_prob,spread_line_home,total_line,"
            "sigma_margin_game,sigma_total_game,pace,home_power,away_power,power_diff"
        )
        .eq("sport_key", SPORT_KEY)
        .eq("run_id", target_run_id)
        .execute()
    )
    target_rows = target_resp.data or []
    if not target_rows:
        raise RuntimeError("No monte_carlo_results rows found for target run.")

    target_df = pd.DataFrame(target_rows)
    target_df["commence_ts"] = target_df["commence_time"].apply(parse_ts)

    if not odds_df.empty:
        target_line_map = build_latest_line_map(target_df, odds_df)
        target_df = apply_odds_lines(target_df, target_line_map)

    adjusted_df = apply_models(
        target_df,
        {
            "home_win": home_win_model,
            "home_cover": home_cover_model,
            "over": over_model,
        },
    )

    payload = []
    for _, row in adjusted_df.iterrows():
        payload.append(
            {
                "sport_key": row["sport_key"],
                "event_id": row["event_id"],
                "run_id": row["run_id"],
                "model_version": MODEL_VERSION,
                "base_home_win_prob": float(row["home_win_prob"]),
                "base_away_win_prob": float(row["away_win_prob"]),
                "adj_home_win_prob": float(row["adj_home_win_prob"]),
                "adj_away_win_prob": float(row["adj_away_win_prob"]),
                "delta_home_win_prob": float(row["delta_home_win_prob"]),
                "delta_away_win_prob": float(row["delta_away_win_prob"]),
                "base_home_cover_prob": float(row["home_cover_prob"]),
                "base_away_cover_prob": float(row["away_cover_prob"]),
                "adj_home_cover_prob": float(row["adj_home_cover_prob"]),
                "adj_away_cover_prob": float(row["adj_away_cover_prob"]),
                "delta_home_cover_prob": float(row["delta_home_cover_prob"]),
                "delta_away_cover_prob": float(row["delta_away_cover_prob"]),
                "base_over_prob": float(row["over_prob"]),
                "base_under_prob": float(row["under_prob"]),
                "adj_over_prob": float(row["adj_over_prob"]),
                "adj_under_prob": float(row["adj_under_prob"]),
                "delta_over_prob": float(row["delta_over_prob"]),
                "delta_under_prob": float(row["delta_under_prob"]),
                "updated_at": datetime.utcnow().isoformat(),
            }
        )

    if not payload:
        raise RuntimeError("No adjustment payload generated.")

    resp = supabase.table("model_ml_adjustments").upsert(payload, on_conflict="sport_key,event_id,model_version").execute()
    if resp.data is None:
        raise RuntimeError(f"Failed to upsert model_ml_adjustments: {resp}")

    print(f"Stored {len(payload)} ML adjustments for run {target_run_id}.")


if __name__ == "__main__":
    main()
