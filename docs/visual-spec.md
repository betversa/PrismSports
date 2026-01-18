# PrismSports Visual Spec (Black-Glass + Gold)

## Phase 0 — Audit + Plan
**Primary routes:** Odds, Predictions (Monte Carlo), Picks (Model), Props, Parlay, Calculator, Results, Settings.  
**Shared layout/components:** App shell (background + header + sidebar), ScreenShell/PageFrame, Header/Sidebar navigation, SectionCard/SectionHeader, tables/cards, controls (buttons, chips, toggles).  
**UI objective:** premium, dashboard-like, black-glass with Pittsburgh gold accents; no marketing hero blocks.

## Design Tokens
### Color
| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#070707` | App background |
| `--surface-1` | `rgba(12, 12, 12, 0.88)` | Primary panels |
| `--surface-2` | `rgba(18, 18, 18, 0.72)` | Secondary cards |
| `--surface-3` | `rgba(24, 24, 24, 0.6)` | Subtle sections |
| `--border-subtle` | `rgba(255, 255, 255, 0.08)` | Panel borders |
| `--text` | `#f6f4ef` | Primary text |
| `--muted` | `#101010` | Muted surface (legacy Tailwind token) |
| `--text-muted` | `rgba(246, 244, 239, 0.62)` | Secondary text |
| `--gold` | `#d4af37` | Primary accent |
| `--gold-2` | `#f2cd73` | Secondary accent |
| `--danger` | `#ef4444` | Error |
| `--success` | `#34d399` | Success |
| `--shadow-soft` | `0 18px 60px rgba(0, 0, 0, 0.45)` | Depth |

### Typography Scale
* **Title:** 20–24px, semibold
* **Section:** 16–18px, semibold
* **Body:** 13–14px, regular
* **Meta:** 11–12px, medium/uppercase

### Spacing Scale
* **xs:** 6px  
* **sm:** 10px  
* **md:** 16px  
* **lg:** 24px  
* **xl:** 32px  

### Radii
* **Chip:** 999px (pill)
* **Card:** 16–20px
* **Panel/Table:** 24–28px

## Surfaces
* **Background:** `--bg` with gradient overlay
* **Panels:** `--surface-1` with `--border-subtle`
* **Cards:** `--surface-2` or `--surface-3`
* **Tables:** panel wrapper + sticky header

## Interaction States
* **Hover:** subtle lift + brighter border
* **Focus:** gold ring `rgba(212,175,55,0.35)`
* **Active:** gold glow/underline for navigation

## Do / Don’t
**Do**
* Compact header bar with title + subtitle + chips
* Clear single control bar per page
* Consistent panel/card spacing

**Don’t**
* Marketing hero blocks
* Huge stat tiles at top of every page
* White backgrounds or default browser chrome

## Theme QA Checklist
* [ ] No white flashes during loading or error
* [ ] Single toolbar/control bar per page
* [ ] All panels use tokenized surfaces/borders
* [ ] Hover/focus states are consistent
* [ ] Error/loading UI uses dark theme
