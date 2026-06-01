# Agilify Design System
> Complete design token specification and UI rules for building the Agilify project management dashboard

---

## 1. Color Tokens

### Base Palette

```css
:root {
  /* Background layers */
  --color-bg-app:         #F2F2ED;   /* Warm off-white page background */
  --color-bg-surface:     #FFFFFF;   /* Card / panel surfaces */
  --color-bg-sidebar:     #FFFFFF;   /* Right activity sidebar */
  --color-bg-overlay:     #F7F7F4;   /* Subtle nested background */

  /* Primary / Brand */
  --color-brand:          #000000;   /* Logo mark, active nav pill, CTAs */
  --color-brand-fg:       #FFFFFF;   /* Text on brand black */

  /* Accent – Status Cards */
  --color-accent-green-bg:#D6F5D0;   /* Completed card fill (mint green) */
  --color-accent-green-text: #1A6B2E;/* Text on green card */

  /* Tag Date Pill Colors */
  --color-tag-pink-bg:    #FFD9D9;   /* Past / overdue date badge */
  --color-tag-pink-text:  #B03030;
  --color-tag-yellow-bg:  #FFF0C0;   /* Current / due-soon date badge */
  --color-tag-yellow-text:#7A5A00;
  --color-tag-green-bg:   #CFFAE0;   /* Upcoming / on-track date badge */
  --color-tag-green-text: #1A6B44;

  /* Department Tag (always dark) */
  --color-dept-bg:        #1A1A1A;   /* Design / Dev / Marketing / QA tag */
  --color-dept-fg:        #FFFFFF;

  /* Text */
  --color-text-primary:   #111111;   /* Headings, card titles, large numbers */
  --color-text-secondary: #888888;   /* Sub-labels like "In progress", "Review" */
  --color-text-muted:     #BBBBBB;   /* Placeholder text, disabled */
  --color-text-inverse:   #FFFFFF;   /* Text on dark surfaces */

  /* Borders & Dividers */
  --color-border:         #E8E8E3;   /* Card borders, dividers */
  --color-border-dashed:  #CCCCCC;   /* Add Task dashed card border */

  /* Premium CTA Card */
  --color-premium-bg:     #111111;   /* Black card background */
  --color-premium-fg:     #FFFFFF;
  --color-premium-btn-bg: #FFFFFF;
  --color-premium-btn-fg: #111111;

  /* Calendar / Activity */
  --color-cal-active-bg:  #111111;   /* Selected day circle */
  --color-cal-active-fg:  #FFFFFF;
  --color-cal-inactive-fg:#888888;

  /* Shadows */
  --shadow-card:          0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04);
  --shadow-card-hover:    0 4px 16px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.06);
  --shadow-nav:           0 1px 0 rgba(0,0,0,0.06);
}
```

---

## 2. Typography Tokens

```css
:root {
  /* Font Family */
  --font-sans: 'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif;
  /* Plus Jakarta Sans is the closest match — geometric, clean, slightly friendly */

  /* Font Sizes */
  --text-xs:   11px;   /* Tag labels, badge text */
  --text-sm:   12px;   /* Status sub-labels ("In progress", "Review") */
  --text-base: 14px;   /* Card titles, nav items, body copy */
  --text-md:   15px;   /* Section sub-headings */
  --text-lg:   18px;   /* Section headings ("LineUp", "Trending") */
  --text-xl:   20px;   /* Panel headings ("Activity") */
  --text-2xl:  28px;   /* Large stat numbers (84%, 99%) */
  --text-3xl:  38px;   /* Hero stat numbers */

  /* Font Weights */
  --weight-regular:  400;
  --weight-medium:   500;
  --weight-semibold: 600;
  --weight-bold:     700;
  --weight-extrabold:800;

  /* Line Heights */
  --leading-tight:  1.15;
  --leading-normal: 1.4;
  --leading-relaxed:1.6;

  /* Letter Spacing */
  --tracking-tight: -0.02em;   /* Large headings and stat numbers */
  --tracking-normal: 0em;
  --tracking-wide:   0.03em;   /* Small uppercase tags */
}
```

### Typography Usage Rules

| Element | Size | Weight | Color | Notes |
|---|---|---|---|---|
| Logo "Agilify" | `--text-lg` | `--weight-extrabold` | `--color-text-primary` | Next to logo mark |
| Nav items | `--text-base` | `--weight-medium` | `--color-text-secondary` | Inactive state |
| Nav active item | `--text-base` | `--weight-semibold` | `--color-brand-fg` | Inside black pill |
| Section heading + count | `--text-lg` | `--weight-bold` | `--color-text-primary` | e.g. "LineUp **14**" |
| Card title | `--text-base` | `--weight-semibold` | `--color-text-primary` | 2-line max |
| Stat number (%) | `--text-3xl` | `--weight-extrabold` | `--color-text-primary` | Letter-spacing `-0.03em` |
| Status label | `--text-sm` | `--weight-regular` | `--color-text-secondary` | "In progress", "Completed" |
| Department tag | `--text-xs` | `--weight-semibold` | `--color-dept-fg` | All caps optional |
| Date badge | `--text-xs` | `--weight-medium` | contextual | Pink / yellow / green |
| Activity item title | `--text-sm` | `--weight-medium` | `--color-text-primary` | Truncated with ellipsis |
| Premium headline | `--text-lg` | `--weight-bold` | `--color-premium-fg` | |
| Price button | `--text-base` | `--weight-semibold` | `--color-premium-btn-fg` | |

---

## 3. Spacing Tokens

```css
:root {
  --space-1:   4px;
  --space-2:   8px;
  --space-3:   12px;
  --space-4:   16px;
  --space-5:   20px;
  --space-6:   24px;
  --space-7:   28px;
  --space-8:   32px;
  --space-10:  40px;
  --space-12:  48px;
}
```

### Spacing Rules

| Context | Value |
|---|---|
| App-level horizontal padding | `--space-6` (24px) |
| App-level vertical padding | `--space-6` (24px) |
| Gap between cards in grid | `--space-3` (12px) |
| Gap between section rows | `--space-6` (24px) |
| Card internal padding | `--space-4` (16px) all sides |
| Section heading margin-bottom | `--space-3` (12px) |
| Tag gap (dept + date inside card) | `--space-2` (8px) |
| Nav item gap | `--space-1` (4px) between pills |
| Activity sidebar padding | `--space-5` (20px) |
| Sidebar row gap | `--space-3` (12px) |

---

## 4. Border Radius Tokens

```css
:root {
  --radius-xs:   6px;    /* Inner small chips, icon badges */
  --radius-sm:   10px;   /* Small buttons, icon containers */
  --radius-md:   16px;   /* Cards (standard) */
  --radius-lg:   20px;   /* Activity sidebar panel */
  --radius-pill: 999px;  /* Nav active pill, tags, date badges, avatars */
}
```

| Element | Radius |
|---|---|
| Task cards | `--radius-md` (16px) |
| Activity sidebar | `--radius-lg` (20px) |
| Nav active pill | `--radius-pill` |
| Department tag | `--radius-pill` |
| Date badge | `--radius-pill` |
| Avatar circles | `--radius-pill` (50%) |
| Add Task card | `--radius-md` |
| Search bar | `--radius-pill` |
| Premium CTA card | `--radius-lg` |
| Premium price button | `--radius-pill` |
| Logo mark | `--radius-pill` |

---

## 5. Layout & Grid System

### Overall App Shell

```
┌──────────────────────────────────────────────────────┬──────────────┐
│  TOP NAV (full width, sticky)                        │              │
├──────────────────────────────────────────────────────│              │
│                                                      │  ACTIVITY    │
│  MAIN CONTENT AREA  (~72% width)                     │  SIDEBAR     │
│                                                      │  (~28% width)│
│  [Section: LineUp]                                   │              │
│  [Section: Trending]                                 │              │
│  [Section: My Work]                                  │              │
└──────────────────────────────────────────────────────┴──────────────┘
```

```css
.app-layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  grid-template-rows: auto 1fr;
  height: 100vh;
  background: var(--color-bg-app);
}

.main-nav {
  grid-column: 1 / -1;
  background: var(--color-bg-surface);
  box-shadow: var(--shadow-nav);
}

.main-content {
  padding: var(--space-6);
  overflow-y: auto;
}

.activity-sidebar {
  padding: var(--space-5);
  background: var(--color-bg-surface);
  border-left: 1px solid var(--color-border);
  overflow-y: auto;
}
```

### Card Grid

```css
.card-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);     /* 12px between cards */
}

/* Add Task card is always the last slot (narrower) */
.card-add-task {
  grid-column: span 1;
  min-width: 80px;
  max-width: 100px;
}
```

---

## 6. Component Specifications

### 6.1 Top Navigation Bar

```
[Logo Mark] [Agilify]     [Search]  [Home] [Notes] [Goals] [Activity]     [Bell] [Avatar] [Name]
```

- Height: `56px`
- Background: `var(--color-bg-surface)`
- Padding: `0 var(--space-6)`
- Layout: `display: flex; align-items: center; justify-content: space-between`
- Logo mark: `28px × 28px` black circle with inner icon, `--radius-pill`
- Nav center group: `gap: 4px`, each item is `padding: 6px 16px`
- **Active nav item**: `background: var(--color-brand); color: var(--color-brand-fg); border-radius: var(--radius-pill)`
- **Inactive nav item**: `color: var(--color-text-secondary)` — no background
- Search icon button: `32px × 32px` circle, `background: var(--color-bg-overlay)`
- Bell icon: `24px`, `color: var(--color-text-secondary)`
- Avatar: `32px × 32px` circle image + username text beside it

---

### 6.2 Section Heading Row

```
LineUp  14        [filter icon] [more icon]
```

```css
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.section-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  color: var(--color-text-primary);
  letter-spacing: var(--tracking-tight);
}

/* Count number next to section title */
.section-count {
  font-size: var(--text-lg);
  font-weight: var(--weight-regular);
  color: var(--color-text-secondary);
  margin-left: var(--space-2);
}
```

---

### 6.3 Task Card (Standard White)

**Anatomy:**
```
┌─────────────────────────────────────┐
│ [Dept Tag]          [Date Badge]    │
│                                     │
│  Card Title Line One                │
│  Card Title Line Two                │
│                                     │
│  84%                    [Avatar(s)] │
│  In progress                        │
└─────────────────────────────────────┘
```

```css
.task-card {
  background: var(--color-bg-surface);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 160px;
  cursor: pointer;
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}

.task-card:hover {
  box-shadow: var(--shadow-card-hover);
  transform: translateY(-1px);
}

/* Completed / highlighted variant */
.task-card--completed {
  background: var(--color-accent-green-bg);
}

/* Card header row */
.task-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Department tag */
.dept-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  background: var(--color-dept-bg);
  color: var(--color-dept-fg);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
}

.dept-tag .dept-icon {
  width: 12px;
  height: 12px;
  border-radius: 3px;
}

/* Date badge */
.date-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
}

.date-badge--pink   { background: var(--color-tag-pink-bg);   color: var(--color-tag-pink-text); }
.date-badge--yellow { background: var(--color-tag-yellow-bg);  color: var(--color-tag-yellow-text); }
.date-badge--green  { background: var(--color-tag-green-bg);   color: var(--color-tag-green-text); }

/* Card title */
.task-card__title {
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
  line-height: var(--leading-normal);
  flex: 1;
}

/* Card footer row */
.task-card__footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: auto;
}

/* Stat number */
.task-card__stat {
  font-size: var(--text-3xl);
  font-weight: var(--weight-extrabold);
  color: var(--color-text-primary);
  letter-spacing: -0.03em;
  line-height: 1;
}

.task-card__status {
  font-size: var(--text-sm);
  font-weight: var(--weight-regular);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
```

---

### 6.4 Add Task Card

```css
.card-add-task {
  background: transparent;
  border: 1.5px dashed var(--color-border-dashed);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 160px;
  cursor: pointer;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  transition: border-color 0.15s, color 0.15s;
}

.card-add-task:hover {
  border-color: var(--color-text-secondary);
  color: var(--color-text-secondary);
}

.card-add-task .add-icon {
  font-size: 24px;
  font-weight: 300;
}
```

---

### 6.5 Avatar Cluster

```css
.avatar-cluster {
  display: flex;
  align-items: center;
}

.avatar-cluster .avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  border: 2px solid var(--color-bg-surface);
  object-fit: cover;
  margin-left: -8px;      /* Overlap */
}

.avatar-cluster .avatar:first-child {
  margin-left: 0;
}

/* Single avatar (larger, shown alone) */
.avatar--single {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
}
```

---

### 6.6 Activity Sidebar

**Structure:**
```
Activity                < Nov 12–28 >
─────────────────────────────────────
[Sun Mon Tue WED Thu Fri Sat]
 9   10  11  12  13  14  15

[Avatar] Comprehensive Redesign...     84%
         16 Nov, Wed
[Avatar] Awareness Gro...
         Today
[Avatar] 24% Full Update of Visual Id...
         16 Nov, Sun
[Avatar] 63% Full Update of Visual Id...
         11 Nov, Tue
[Avatars]    ion Cycle f...

─────────────────────────────────────
┌─────────────────────────────────────┐
│ ◆ Agilify Premium                   │
│ Unlock powerful tools...            │
│      [ $9.99/month → ]              │
└─────────────────────────────────────┘
```

```css
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.sidebar-title {
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  color: var(--color-text-primary);
}

/* Week nav arrows */
.week-nav {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

/* Calendar row */
.calendar-week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  margin-bottom: var(--space-4);
}

.cal-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.cal-day__label {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-cal-inactive-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.cal-day__num {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.cal-day--active .cal-day__num {
  background: var(--color-cal-active-bg);
  color: var(--color-cal-active-fg);
  font-weight: var(--weight-bold);
}

/* Activity list item */
.activity-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
}

.activity-item__avatar {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
  object-fit: cover;
}

.activity-item__body {
  flex: 1;
  min-width: 0;
}

.activity-item__title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-item__date {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 2px;
}

.activity-item__percent {
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--color-text-primary);
  flex-shrink: 0;
}
```

---

### 6.7 Premium CTA Card

```css
.premium-card {
  background: var(--color-premium-bg);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  margin-top: var(--space-4);
}

.premium-card__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.premium-card__logo {
  width: 24px;
  height: 24px;
  background: var(--color-premium-fg);
  border-radius: var(--radius-pill);
  display: flex;
  align-items: center;
  justify-content: center;
}

.premium-card__title {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  color: var(--color-premium-fg);
}

.premium-card__desc {
  font-size: var(--text-sm);
  color: rgba(255,255,255,0.65);
  margin-bottom: var(--space-4);
  line-height: var(--leading-relaxed);
}

.premium-card__btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--color-premium-btn-bg);
  color: var(--color-premium-btn-fg);
  border-radius: var(--radius-pill);
  padding: 10px var(--space-4);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  cursor: pointer;
  border: none;
  width: 100%;
  transition: opacity 0.15s;
}

.premium-card__btn:hover {
  opacity: 0.90;
}
```

---

## 7. Icon System

| Location | Icon | Size | Style |
|---|---|---|---|
| Logo mark | Custom geometric diamond/asterisk | 14px inside 28px circle | White on black |
| Department tags | Small category icon (grid, code, chart) | 12×12px | White |
| Date badge | Clock icon `🕐` | 11px | Contextual color |
| Nav search | Magnifier | 18px | Gray |
| Nav bell | Bell outline | 20px | Gray |
| Week nav arrows | Left/right chevrons | 14px | Gray |
| Section action | Filter funnel | 16px | Gray |
| Section overflow | Three dots `···` | 16px | Gray |
| Add Task | Plus `+` | 22px | Gray |
| Premium CTA arrow | Right arrow `→` | 16px | Black |

---

## 8. Interactive States

### Card States
```css
/* Default */
.task-card { box-shadow: var(--shadow-card); }

/* Hover */
.task-card:hover {
  box-shadow: var(--shadow-card-hover);
  transform: translateY(-1px);
}

/* Active / pressed */
.task-card:active {
  transform: translateY(0px);
  box-shadow: var(--shadow-card);
}
```

### Nav Item States
```css
.nav-item             { color: var(--color-text-secondary); background: transparent; }
.nav-item:hover       { color: var(--color-text-primary); }
.nav-item--active     { background: var(--color-brand); color: var(--color-brand-fg); }
```

### Button States
```css
.btn:hover   { opacity: 0.85; }
.btn:active  { opacity: 0.70; transform: scale(0.98); }
.btn:focus   { outline: 2px solid var(--color-brand); outline-offset: 2px; }
```

---

## 9. Motion & Animation

```css
/* Global transition defaults */
* { transition-timing-function: cubic-bezier(0.25, 0.1, 0.25, 1); }

/* Card hover lift */
.task-card {
  transition: box-shadow 0.18s ease,
              transform 0.18s ease;
}

/* Nav pill active transition */
.nav-item {
  transition: background 0.15s ease,
              color 0.15s ease;
}

/* Button press feedback */
.btn {
  transition: opacity 0.12s ease,
              transform 0.10s ease;
}

/* Page section entry (stagger on load) */
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

.section {
  animation: fadeSlideUp 0.3s ease forwards;
}
.section:nth-child(1) { animation-delay: 0.00s; }
.section:nth-child(2) { animation-delay: 0.06s; }
.section:nth-child(3) { animation-delay: 0.12s; }
```

---

## 10. Responsive Breakpoints

```css
/* Full desktop layout (default) */
@media (min-width: 1200px) {
  .app-layout { grid-template-columns: 1fr 320px; }
  .card-grid  { grid-template-columns: repeat(3, 1fr); }
}

/* Medium: hide sidebar, 2-col cards */
@media (max-width: 1199px) {
  .app-layout { grid-template-columns: 1fr; }
  .activity-sidebar { display: none; }
  .card-grid  { grid-template-columns: repeat(2, 1fr); }
}

/* Mobile: single column */
@media (max-width: 640px) {
  .card-grid  { grid-template-columns: 1fr; }
  .main-content { padding: var(--space-4); }
}
```

---

## 11. Full CSS Variable Reference

```css
:root {
  /* === COLORS === */
  --color-bg-app:           #F2F2ED;
  --color-bg-surface:       #FFFFFF;
  --color-bg-overlay:       #F7F7F4;
  --color-brand:            #000000;
  --color-brand-fg:         #FFFFFF;
  --color-accent-green-bg:  #D6F5D0;
  --color-tag-pink-bg:      #FFD9D9;
  --color-tag-pink-text:    #B03030;
  --color-tag-yellow-bg:    #FFF0C0;
  --color-tag-yellow-text:  #7A5A00;
  --color-tag-green-bg:     #CFFAE0;
  --color-tag-green-text:   #1A6B44;
  --color-dept-bg:          #1A1A1A;
  --color-dept-fg:          #FFFFFF;
  --color-text-primary:     #111111;
  --color-text-secondary:   #888888;
  --color-text-muted:       #BBBBBB;
  --color-text-inverse:     #FFFFFF;
  --color-border:           #E8E8E3;
  --color-border-dashed:    #CCCCCC;
  --color-premium-bg:       #111111;
  --color-cal-active-bg:    #111111;
  --color-cal-active-fg:    #FFFFFF;

  /* === TYPOGRAPHY === */
  --font-sans:        'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif;
  --text-xs:          11px;
  --text-sm:          12px;
  --text-base:        14px;
  --text-md:          15px;
  --text-lg:          18px;
  --text-xl:          20px;
  --text-2xl:         28px;
  --text-3xl:         38px;
  --weight-regular:   400;
  --weight-medium:    500;
  --weight-semibold:  600;
  --weight-bold:      700;
  --weight-extrabold: 800;
  --leading-tight:    1.15;
  --leading-normal:   1.4;
  --leading-relaxed:  1.6;
  --tracking-tight:   -0.02em;
  --tracking-wide:    0.03em;

  /* === SPACING === */
  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-7:  28px;
  --space-8:  32px;
  --space-10: 40px;
  --space-12: 48px;

  /* === RADIUS === */
  --radius-xs:   6px;
  --radius-sm:   10px;
  --radius-md:   16px;
  --radius-lg:   20px;
  --radius-pill: 999px;

  /* === SHADOWS === */
  --shadow-card:       0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04);
  --shadow-card-hover: 0 4px 16px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.06);
  --shadow-nav:        0 1px 0 rgba(0,0,0,0.06);
}
```

---

## 12. Design Principles

1. **Warm Neutral Base** — The background is a warm off-white (`#F2F2ED`), not pure white or gray. This creates a softer, more premium feel vs. cold UI whites.

2. **Black as the Only Brand Color** — No blue, no purple. The only "brand" color is pure black, used for the logo, active states, and the premium card. Accents are functional (green = done, pink = late, yellow = pending).

3. **Card-First Hierarchy** — All task content lives in cards. Cards are the primary unit of information and must never feel cluttered. Generous internal padding.

4. **Semantic Color Coding** — The date badge color encodes urgency at a glance: pink = overdue, yellow = soon, green = future-safe.

5. **Stat Numbers Dominate** — The percentage completion number is the largest element in every card. It communicates progress instantly without reading.

6. **Dark Department Tags** — All department tags (Design, Dev, QA, Marketing) use the same dark-on-dark treatment. They signal category without competing with the card's content.

7. **Completed = Green Card** — A 100% completion state changes the entire card background to mint green. Status is visible at the section level, not just per-card.

8. **Right Sidebar = Live Feed** — The activity sidebar is always visible on desktop. It anchors the user's sense of real-time team activity without requiring navigation.

9. **Premium Upsell is Contextual** — The premium card lives at the bottom of the sidebar, dark and contained. It never interrupts the workflow.

10. **Micro-Motion is Subtle** — Hover lifts are `1px`, transitions are `≤200ms`. Nothing bounces or scales dramatically. The UI feels responsive, not playful.