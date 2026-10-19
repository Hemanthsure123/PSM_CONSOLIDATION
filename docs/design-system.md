# Design system

This is how every screen in the app looks and behaves. The app is a placement-operations console:
people load a sheet of candidates, set up a screening, run it, read the results and export them for a
company. The UI's job is to make that path obvious and to keep everything else out of the way.

## Principles

1. **One primary action per screen.** It is the only solid blue button, and it sits bottom-right in
   the `ActionBar` (Fitts's law, Von Restorff effect). Every other button is `outline`, `secondary`,
   `ghost` or `link`.
2. **Show what is needed, explain on demand.** A control gets a label and at most one short line. The
   "how it works / why" text goes in an `InfoHint`. Rarely changed options go in a closed `Disclosure`.
   This is progressive disclosure, and it also keeps choices few (Hick's law).
3. **Group by job.** Related controls share one `Panel`, unrelated ones get separate Panels
   (proximity, common region). Keep about seven items or fewer per group (Miller's law).
4. **Numbers first.** A results screen opens with a `StatGrid` of the few numbers that matter, then
   the table, then the downloads.
5. **Always show status.** While work runs, show a `Progress` bar plus counts and a way to stop it
   (Doherty threshold). When it finishes, show a clear end state with the next action (peak-end rule).
6. **Familiar patterns.** Sidebar navigation, page header, panels, data tables and a sticky action
   bar (Jakob's law). There are no novel controls.
7. **Accessible by default.** Text meets WCAG AA contrast, focus is visible on every control, keyboard
   operation works throughout, and reduced motion is respected.

## Tokens

| Token | Value | Use |
|---|---|---|
| Canvas | `#F3F5F9` (`bg-background`) | App background |
| Surface | `#FFFFFF` (`bg-card`) | Panels, tables, inputs |
| Ink | `#152238` (`text-foreground`) | Text |
| Muted ink | `#5B6779` (`text-muted-foreground`) | Secondary text (5.6:1) |
| NxtWave blue | `#1F57E0` (`primary`) | The primary action, links, focus, active navigation |
| Blue tint | `accent` | Selected and active backgrounds, info notices |
| Success / warning / danger | `success`, `warning`, `destructive` (each has a `-soft` fill) | Status only |
| Highlighter | `#E3F46B` (`highlight`) | **Only** "shortlisted / selected" marks: `Badge variant="highlight"`, `Stat tone="highlight"` |
| Lines | `border` (`#E1E6EE`), `input` (`#D2D9E3`) | Hairlines, control borders |

### Type

- **IBM Plex Sans** (`font-sans`) is used for everything. The body is 14px, and tables and help text
  are 13px.
- **Bricolage Grotesque** (`font-display`) is used for page titles (28px), panel titles (16px) and
  stat values (26px) only.
- Use sentence case everywhere. Never use all-caps labels.
- Numbers use `tabular` / `tabular-nums`. Don't use `font-mono` for numbers.

### Shape and elevation

- **Radius:** 10px (`rounded-lg`) for controls, 14px (`rounded-xl`) for surfaces.
- **Resting surfaces:** a hairline border plus `shadow-surface`.
- **Shadows:** only floating things get one. Sticky bars use `shadow-raised`; dialogs and popovers
  use `shadow-overlay`.
- **Spacing:** use the 4px grid. Use `gap-6` between Panels and `gap-4` inside them.

## Layout

The app shell (`app-shell.tsx`) draws the sidebar, which groups tools as Company sheets, Screening,
Evaluation and Reference. It also draws the page title and description for each screen. **Screens
never render their own page title.**

Every configure → run → results tool follows this shape:

```
Panel  Source          (sheet URL / paste / upload)
Panel  Requirements    (what to screen for)
Panel  Options         (SettingRows; dependent inputs appear only when a row is on)
Disclosure  Advanced   (rarely changed, closed)
ActionBar              status / progress ......... [secondary] [Primary action]
── after a run ──
StatGrid               the numbers that matter
Panel (flush)          results table with its own toolbar (filters, downloads)
```

Width: forms sit in `max-w-3xl`, and results use the full width.

## Components (`src/components/ui`)

| Component | Use |
|---|---|
| `Panel` | A titled section (`title`, `description`, `actions`, `icon`, `footer`, `flush`) |
| `Field` | Label + control + hint/error (`info` puts long help behind an (i)) |
| `SettingRow` / `SettingList` | Yes/no options; `children` show only while the option is on |
| `InfoHint` | The (i) with on-demand explanation |
| `Disclosure` | Collapsible "Advanced options" |
| `Notice` | Inline state message: info / success / warning / danger |
| `Stat` / `StatGrid` | Headline numbers |
| `Progress` | Determinate or indeterminate progress bar |
| `Segmented` | 2–6 exclusive choices shown at once |
| `NativeSelect`, `Textarea`, `Input`, `Checkbox`, `Switch` | Form controls |
| `ActionBar` | The sticky bottom bar holding the primary action |
| `EmptyState` | An empty list, with the action that fills it |
| `ConfirmDialog` | A confirmation before losing work |
| `Badge` | `default`, `secondary`, `outline`, `success`, `warning`, `destructive`, `highlight` |
| `Button` | `default` (primary, one per view), `outline`, `secondary`, `soft`, `ghost`, `link`, `destructive` |
| `Stepper` | Real multi-step wizards only |
| `Table` | Data tables; the header is sticky — pass `containerClassName="max-h-[560px]"` for long lists |

## Writing

- Name things by what users do: "Load sheet", "Start screening", "Download shortlist (CSV)".
- An action keeps its name throughout a flow.
- Errors say what happened and how to fix it. Empty states say what to do.
- Use plain verbs and sentence case. Arrows, slogans and marketing copy are out.

## A screen that is running

Call `useReportBusy(running)` (from `@/components/busy-context`) in the screen. Leaving it from the
sidebar then asks before the run's progress is lost.
