import os
from datetime import datetime, timedelta
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
    raise RuntimeError("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

MAX_ADJ = 0.05

# Change if your league's “game day” should be computed in another timezone.
GAME_TZ = os.environ.get("GAME_TZ", "America/Chicago")


# --------------------------------------------------------------------------------------
# HELPERS
# --------------------------------------------------------------------------------------

def norm_team(v: Any) -> str:
    return str(v or "").strip().lower()


def parse_date(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
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


def safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return default
        return float(v)
    except Exception:
        return default


def date_shift(date_str: str, days: int) -> str:
    dt = datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=days)
    return dt.strftime("%Y-%m-%d")


# --------------------------------------------------------------------------------------
# TEAM MAP (alias -> canonical)
# --------------------------------------------------------------------------------------

def fetch_team_alias_map() -> Dict[str, str]:
    """
    Builds alias -> canonical map using whatever columns exist in team_map.
    We don't assume exact schema beyond having a canonical column.
    """
    rows = fetch_table_rows("team_map")

    alias_to_canon: Dict[str, str] = {}

    # candidate keys we might find in your team_map rows
    alias_keys = [
        "abbreviation", "abbr", "abbrev",
        "team", "team_name", "name", "display_name",
        "school", "short_name",
        "alias", "aliases",
    ]

    for r in rows:
        canon = r.get("canonical") or r.get("Canonical") or r.get("CANONICAL")
        if not canon:
            continue
        canon_norm = norm_team(canon)
        # map canonical->canonical too
        alias_to_canon[canon_norm] = canon_norm

        for k in alias_keys:
            if k not in r or r[k] is None:
                continue
            val = r[k]

            # aliases could be a string or list-like
            if isinstance(val, list):
                for a in val:
                    a_norm = norm_team(a)
                    if a_norm:
                        alias_to_canon[a_norm] = canon_norm
            else:
                a_norm = norm_team(val)
                if a_norm:
                    alias_to_canon[a_norm] = canon_norm

    return alias_to_canon


def canonize_team(raw: Any, alias_map: Dict[str, str]) -> str:
    n = norm_team(raw)
    return alias_map.get(n, n)


# --------------------------------------------------------------------------------------
# LABELS (RESULTS)
# --------------------------------------------------------------------------------------

def build_label_rows(alias_map: Dict[str, str]) -> List[Dict[str, Any]]:
    label_rows: List[Dict[str, Any]] = []

    if SPORT_KEY == "basketball_nba":
        rows = fetch_table_rows("basketballref_games_nba")
        for r in rows:
            date = parse_date(pick_any(r, ["date", "game_date", "Date"]))
            away = pick_any(r, ["away_team", "away", "team1", "team1_away", "Team1 (Away)"])
            home = pick_any(r, ["home_team", "home", "team2", "team2_home", "Team2 (Home)"])
            away_pts = pick_any(r, ["away_pts", "away_points", "score1", "Score1", "pts_away", "points_away"])
            home_pts = pick_any(r, ["home_pts", "home_points", "score2", "Score2", "pts_home", "points_home"])

            if not (date and away and home and away_pts is not None and home_pts is not None):
                continue

            label_rows.append(
                {
                    "date": date,
                    "away_team_raw": away,
                    "home_team_raw": home,
                    "away_team_canon": canonize_team(away, alias_map),
                    "home_team_canon": canonize_team(home, alias_map),
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

            if not (date and away and home and away_pts is not None and home_pts is not None):
                continue

            label_rows.append(
                {
                    "date": date,
                    "away_team_raw": away,
                    "home_team_raw": home,
                    "away_team_canon": canonize_team(away, alias_map),
                    "home_team_canon": canonize_team(home, alias_map),
                    "away_pts": float(away_pts),
                    "home_pts": float(home_pts),
                }
            )

    return label_rows


# --------------------------------------------------------------------------------------
# MONTE CARLO ROWS (only safe columns)
# --------------------------------------------------------------------------------------

def fetch_mc_rows(alias_map: Dict[str, str]) -> pd.DataFrame:
    cols = (
        "sport_key,event_id,run_id,commence_time,home_team,away_team,"
        "projected_margin_home,projected_total,"
        "home_win_prob,away_win_prob,home_cover_prob,away_cover_prob,over_prob,under_prob,"
        "spread_line_home,total_line,"
        "sigma_margin_game,sigma_total_game"
    )
    resp = supabase.table("monte_carlo_results").select(cols).eq("sport_key", SPORT_KEY).execute()
    df = pd.DataFrame(resp.data or [])
    if df.empty:
        return df

    df["commence_ts"] = df["commence_time"].apply(parse_ts)

    # game_date_utc = simple ISO date (UTC)
    df["game_date_utc"] = df["commence_time"].apply(parse_date)

    # game_date_local = date in GAME_TZ (America/Chicago by default)
    # this is the big fix for midnight UTC slippage
    def to_local_date(ts: Any) -> Optional[str]:
        t = ts if isinstance(ts, pd.Timestamp) else parse_ts(ts)
        if t is None or pd.isna(t):
            return None
        try:
            return t.tz_convert(GAME_TZ).strftime("%Y-%m-%d")
        except Exception:
            return t.strftime("%Y-%m-%d")

    df["game_date_local"] = df["commence_ts"].apply(to_local_date)

    # canonicalize team names
    df["home_team_canon"] = df["home_team"].apply(lambda x: canonize_team(x, alias_map))
    df["away_team_canon"] = df["away_team"].apply(lambda x: canonize_team(x, alias_map))

    return df


# --------------------------------------------------------------------------------------
# PACE + POWER (authoritative tables)
# --------------------------------------------------------------------------------------

def fetch_pace_map_2025() -> Dict[str, float]:
    resp = supabase.table("team_possessions").select('canonical,"2025"').execute()
    rows = resp.data or []
    out: Dict[str, float] = {}
    for r in rows:
        canon = r.get("canonical")
        val = r.get("2025")
        if canon and val is not None:
            out[norm_team(canon)] = safe_float(val)
    return out


def fetch_power_map() -> Dict[str, float]:
    resp = supabase.table("team_ratings").select("canonical,engine_power").execute()
    rows = resp.data or []
    out: Dict[str, float] = {}
    for r in rows:
        canon = r.get("canonical")
        val = r.get("engine_power")
        if canon and val is not None:
            out[norm_team(canon)] = safe_float(val)
    return out


def apply_team_context(df: pd.DataFrame, pace_map: Dict[str, float], power_map: Dict[str, float]) -> pd.DataFrame:
    if df.empty:
        return df
    df = df.copy()

    df["home_pace"] = df["home_team_canon"].map(pace_map)
    df["away_pace"] = df["away_team_canon"].map(pace_map)
    df["pace_avg"] = (df["home_pace"] + df["away_pace"]) / 2.0

    df["home_power"] = df["home_team_canon"].map(power_map)
    df["away_power"] = df["away_team_canon"].map(power_map)
    df["power_diff"] = df["home_power"] - df["away_power"]

    # fill missing with column mean or 0
    for col in ["home_pace", "away_pace", "pace_avg", "home_power", "away_power", "power_diff"]:
        if df[col].notna().any():
            df[col] = df[col].fillna(df[col].dropna().mean())
        else:
            df[col] = df[col].fillna(0.0)

    return df


# --------------------------------------------------------------------------------------
# ODDS SNAPSHOT (consensus line map)
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
            .in_("market", ["spreads", "totals"])
            .in_("side", ["home", "away", "over", "under"])
            .execute()
        )
        rows.extend(resp.data or [])

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    df["ts"] = df["ts"].apply(parse_ts)
    df["market"] = df["market"].astype(str).str.lower()
    df["side"] = df["side"].astype(str).str.lower()
    df["bookmaker"] = df["bookmaker"].astype(str).str.lower()
    df["line"] = pd.to_numeric(df["line"], errors="coerce")
    return df


def build_latest_line_map(mc_df: pd.DataFrame, odds_df: pd.DataFrame) -> Dict[Tuple[str, str, str], float]:
    if mc_df.empty or odds_df.empty:
        return {}

    line_map: Dict[Tuple[str, str, str], float] = {}
    odds_df = odds_df.dropna(subset=["line", "ts"])

    commence_map = mc_df.set_index("event_id")["commence_ts"].to_dict()

    for event_id, group in odds_df.groupby("event_id"):
        commence_ts = commence_map.get(event_id)
        if commence_ts is not None and pd.notna(commence_ts):
            pregame = group[group["ts"] <= commence_ts]
            if pregame.empty:
                pregame = group
        else:
            pregame = group

        pregame = pregame.sort_values("ts", ascending=False)
        latest_per_book = pregame.drop_duplicates(subset=["market", "side", "bookmaker"])

        for (market, side), subset in latest_per_book.groupby(["market", "side"]):
            lines = subset["line"].dropna().tolist()
            if lines:
                line_map[(event_id, market, side)] = float(np.median(lines))

    # symmetric fills
    for event_id in mc_df["event_id"].dropna().unique():
        hk = (event_id, "spreads", "home")
        ak = (event_id, "spreads", "away")
        ok = (event_id, "totals", "over")
        uk = (event_id, "totals", "under")

        if hk not in line_map and ak in line_map:
            line_map[hk] = -line_map[ak]
        if ak not in line_map and hk in line_map:
            line_map[ak] = -line_map[hk]
        if ok not in line_map and uk in line_map:
            line_map[ok] = line_map[uk]
        if uk not in line_map and ok in line_map:
            line_map[uk] = line_map[ok]

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


# --------------------------------------------------------------------------------------
# TRAINING JOIN (robust on date + teams)
# --------------------------------------------------------------------------------------

def join_labels(mc_df: pd.DataFrame, label_rows: List[Dict[str, Any]]) -> pd.DataFrame:
    if mc_df.empty:
        return pd.DataFrame()
    lab = pd.DataFrame(label_rows)
    if lab.empty:
        return pd.DataFrame()

    # We'll try multiple join strategies:
    # 1) local date exact
    # 2) utc date exact
    # 3) local date +/- 1 day
    # 4) utc date +/- 1 day
    # (team matching always via canonicalized names)

    def do_merge(date_col: str, lab_date_col: str, shift_days: int = 0) -> pd.DataFrame:
        m = mc_df.copy()
        l = lab.copy()

        if shift_days != 0:
            m["__join_date"] = m[date_col].apply(lambda d: date_shift(d, shift_days) if isinstance(d, str) and d else d)
        else:
            m["__join_date"] = m[date_col]

        l["__join_date"] = l[lab_date_col]

        merged = m.merge(
            l,
            left_on=["__join_date", "home_team_canon", "away_team_canon"],
            right_on=["__join_date", "home_team_canon", "away_team_canon"],
            how="inner",
            suffixes=("", "_label"),
        )
        return merged

    # Ensure label canonical columns exist (they do in build_label_rows)
    if "home_team_canon" not in lab.columns or "away_team_canon" not in lab.columns:
        return pd.DataFrame()

    attempts: List[Tuple[str, int]] = [
        ("game_date_local", 0),
        ("game_date_utc", 0),
        ("game_date_local", -1),
        ("game_date_local", 1),
        ("game_date_utc", -1),
        ("game_date_utc", 1),
    ]

    best = pd.DataFrame()
    for col, shift in attempts:
        if col not in mc_df.columns:
            continue
        merged = do_merge(col, "date", shift)
        if not merged.empty:
            best = merged
            break

    return best


# --------------------------------------------------------------------------------------
# FEATURES / MODEL
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
        "pace_avg",
        "home_power",
        "away_power",
        "power_diff",
    ]
    for c in base_cols:
        feats[c] = pd.to_numeric(df.get(c), errors="coerce")

    return feats.replace([np.inf, -np.inf], np.nan).fillna(0.0)


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

    base_home_win = pd.to_numeric(target_df["home_win_prob"], errors="coerce").fillna(0.0).values
    base_home_cover = pd.to_numeric(target_df["home_cover_prob"], errors="coerce").fillna(0.0).values
    base_over = pd.to_numeric(target_df["over_prob"], errors="coerce").fillna(0.0).values

    home_win_pred = models["home_win"].predict_proba(features)[:, 1]
    home_cover_pred = models["home_cover"].predict_proba(features)[:, 1]
    over_pred = models["over"].predict_proba(features)[:, 1]

    adj_home_win, delta_home_win = compute_adjustments(base_home_win, home_win_pred)
    adj_home_cover, delta_home_cover = compute_adjustments(base_home_cover, home_cover_pred)
    adj_over, delta_over = compute_adjustments(base_over, over_pred)

    adj_away_win = np.clip(1.0 - adj_home_win, 0.0, 1.0)
    delta_away_win = adj_away_win - pd.to_numeric(target_df["away_win_prob"], errors="coerce").fillna(0.0).values

    adj_away_cover = np.clip(
        pd.to_numeric(target_df["away_cover_prob"], errors="coerce").fillna(0.0).values - delta_home_cover, 0.0, 1.0
    )
    delta_away_cover = adj_away_cover - pd.to_numeric(target_df["away_cover_prob"], errors="coerce").fillna(0.0).values

    adj_under = np.clip(
        pd.to_numeric(target_df["under_prob"], errors="coerce").fillna(0.0).values - delta_over, 0.0, 1.0
    )
    delta_under = adj_under - pd.to_numeric(target_df["under_prob"], errors="coerce").fillna(0.0).values

    out = target_df.copy()

    out["adj_home_win_prob"] = adj_home_win
    out["adj_away_win_prob"] = adj_away_win
    out["delta_home_win_prob"] = delta_home_win
    out["delta_away_win_prob"] = delta_away_win

    out["adj_home_cover_prob"] = adj_home_cover
    out["adj_away_cover_prob"] = adj_away_cover
    out["delta_home_cover_prob"] = delta_home_cover
    out["delta_away_cover_prob"] = delta_away_cover

    out["adj_over_prob"] = adj_over
    out["adj_under_prob"] = adj_under
    out["delta_over_prob"] = delta_over
    out["delta_under_prob"] = delta_under

    return out


# --------------------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------------------

def main() -> None:
    alias_map = fetch_team_alias_map()

    label_rows = build_label_rows(alias_map)
    mc_df = fetch_mc_rows(alias_map)
    if mc_df.empty:
        raise RuntimeError("No monte_carlo_results rows found for training.")

    pace_map = fetch_pace_map_2025()
    power_map = fetch_power_map()
    mc_df = apply_team_context(mc_df, pace_map, power_map)

    # consensus lines
    event_ids = mc_df["event_id"].dropna().astype(str).unique().tolist()
    odds_df = fetch_odds_snapshot(event_ids)
    mc_df = apply_odds_lines(mc_df, build_latest_line_map(mc_df, odds_df))

    merged = join_labels(mc_df, label_rows)
    if merged.empty:
        # provide actionable debug info in logs
        sample_mc = mc_df[["game_date_local", "game_date_utc", "home_team", "away_team", "home_team_canon", "away_team_canon"]].head(5).to_dict("records")
        sample_lab = pd.DataFrame(label_rows)[["date", "home_team_raw", "away_team_raw", "home_team_canon", "away_team_canon"]].head(5).to_dict("records")
        print("DEBUG: sample MC rows:", sample_mc)
        print("DEBUG: sample label rows:", sample_lab)
        raise RuntimeError("No matching labeled data to train on (team/date mismatch). See DEBUG samples above.")

    merged = merged.dropna(subset=["spread_line_home", "total_line"])
    if merged.empty:
        raise RuntimeError("No labeled rows with spread/total lines.")

    # labels
    merged["home_win_label"] = (merged["home_pts"] > merged["away_pts"]).astype(int)

    margin = merged["home_pts"] - merged["away_pts"]
    merged["home_cover_label"] = np.where(
        margin == merged["spread_line_home"],
        np.nan,
        (margin > merged["spread_line_home"]).astype(int),
    )

    total_pts = merged["home_pts"] + merged["away_pts"]
    merged["over_label"] = np.where(
        total_pts == merged["total_line"],
        np.nan,
        (total_pts > merged["total_line"]).astype(int),
    )

    feats = build_features(merged)

    win_mask = merged["home_win_label"].notna()
    cover_mask = merged["home_cover_label"].notna()
    over_mask = merged["over_label"].notna()

    home_win_model = train_model(feats.loc[win_mask], merged.loc[win_mask, "home_win_label"])
    home_cover_model = train_model(feats.loc[cover_mask], merged.loc[cover_mask, "home_cover_label"])
    over_model = train_model(feats.loc[over_mask], merged.loc[over_mask, "over_label"])

    if home_win_model is None or home_cover_model is None or over_model is None:
        raise RuntimeError("Insufficient data to train one or more models.")

    target_run_id = RUN_ID or fetch_latest_run_id()
    if not target_run_id:
        raise RuntimeError("Missing RUN_ID and unable to resolve latest run.")

    target_cols = (
        "sport_key,event_id,run_id,commence_time,home_team,away_team,"
        "projected_margin_home,projected_total,"
        "home_win_prob,away_win_prob,home_cover_prob,away_cover_prob,over_prob,under_prob,"
        "spread_line_home,total_line,"
        "sigma_margin_game,sigma_total_game"
    )
    target_rows = (
        supabase.table("monte_carlo_results")
        .select(target_cols)
        .eq("sport_key", SPORT_KEY)
        .eq("run_id", target_run_id)
        .execute()
        .data
        or []
    )
    if not target_rows:
        raise RuntimeError("No monte_carlo_results rows found for target run.")

    target_df = pd.DataFrame(target_rows)
    target_df["commence_ts"] = target_df["commence_time"].apply(parse_ts)
    target_df["home_team_canon"] = target_df["home_team"].apply(lambda x: canonize_team(x, alias_map))
    target_df["away_team_canon"] = target_df["away_team"].apply(lambda x: canonize_team(x, alias_map))

    target_df = apply_team_context(target_df, pace_map, power_map)

    # apply consensus lines if possible (reuse odds_df; OK)
    if not odds_df.empty:
        target_df = apply_odds_lines(target_df, build_latest_line_map(target_df, odds_df))

    adjusted_df = apply_models(
        target_df,
        {"home_win": home_win_model, "home_cover": home_cover_model, "over": over_model},
    )

    payload: List[Dict[str, Any]] = []
    now_iso = datetime.utcnow().isoformat()

    for _, row in adjusted_df.iterrows():
        payload.append(
            {
                "sport_key": row["sport_key"],
                "event_id": row["event_id"],
                "run_id": row["run_id"],
                "model_version": MODEL_VERSION,

                "base_home_win_prob": safe_float(row.get("home_win_prob")),
                "base_away_win_prob": safe_float(row.get("away_win_prob")),
                "adj_home_win_prob": safe_float(row.get("adj_home_win_prob")),
                "adj_away_win_prob": safe_float(row.get("adj_away_win_prob")),
                "delta_home_win_prob": safe_float(row.get("delta_home_win_prob")),
                "delta_away_win_prob": safe_float(row.get("delta_away_win_prob")),

                "base_home_cover_prob": safe_float(row.get("home_cover_prob")),
                "base_away_cover_prob": safe_float(row.get("away_cover_prob")),
                "adj_home_cover_prob": safe_float(row.get("adj_home_cover_prob")),
                "adj_away_cover_prob": safe_float(row.get("adj_away_cover_prob")),
                "delta_home_cover_prob": safe_float(row.get("delta_home_cover_prob")),
                "delta_away_cover_prob": safe_float(row.get("delta_away_cover_prob")),

                "base_over_prob": safe_float(row.get("over_prob")),
                "base_under_prob": safe_float(row.get("under_prob")),
                "adj_over_prob": safe_float(row.get("adj_over_prob")),
                "adj_under_prob": safe_float(row.get("adj_under_prob")),
                "delta_over_prob": safe_float(row.get("delta_over_prob")),
                "delta_under_prob": safe_float(row.get("delta_under_prob")),

                "updated_at": now_iso,
            }
        )

    if not payload:
        raise RuntimeError("No adjustment payload generated.")

    resp = supabase.table("model_ml_adjustments").upsert(
        payload, on_conflict="sport_key,event_id,model_version"
    ).execute()

    if resp.data is None:
        raise RuntimeError(f"Failed to upsert model_ml_adjustments: {resp}")

    print(f"Stored {len(payload)} ML adjustments for run {target_run_id} ({MODEL_VERSION}).")


if __name__ == "__main__":
    main()

