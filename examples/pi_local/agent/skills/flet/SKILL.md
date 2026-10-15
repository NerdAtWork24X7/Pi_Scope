---
name: flet
description: "Use this skill for every Flet UI task.Inspired by BMW M's design philosophy: precision, contrast, purposeful restraint.Adapted for macOS Human Interface Guidelines in Flet 0.25+"
---

## 1 · Design Philosophy

| Principle | macOS HIG | BMW M Influence |
|-----------|-----------|-----------------|
| **Canvas** | Layered surfaces (background → window → card) | Near-black base canvas in dark, near-white in light |
| **Contrast** | High text-to-background ratio | Bold display weight vs. light body weight |
| **Accent** | Single system accent colour | M tricolor stripe: only for status/highlight, never decorative noise |
| **Space** | Generous whitespace, tight internal density | Precision margins — nothing is arbitrary |
| **Motion** | Subtle, purposeful animation | State transitions only; no gratuitous effects |
| **Shape** | Rounded corners (8–12 px on cards, 6 px on inputs) | Sport radii — rounder than corporate, sharper than bubbly |

---

## 2 · Color Tokens

### 2.1 Primitive Palette

```python
# ── Neutrals ────────────────────────────────────────────────────────
GRAY_50  = "#F9F9F9"   # page background (light)
GRAY_100 = "#F2F2F2"   # sidebar background (light)
GRAY_150 = "#E8E8E8"   # dividers / hairlines (light)
GRAY_200 = "#D0D0D0"   # borders (light)
GRAY_400 = "#9A9A9A"   # placeholder / muted text
GRAY_600 = "#636363"   # secondary label (light)
GRAY_800 = "#2A2A2A"   # primary text (light)
GRAY_900 = "#1A1A1A"   # window background (dark)
GRAY_850 = "#222222"   # card surface (dark)
GRAY_800D= "#2C2C2C"   # sidebar (dark)
GRAY_700D= "#3A3A3A"   # border (dark)

# ── BMW M Tricolor (use sparingly — status & brand only) ─────────────
M_BLUE_LIGHT = "#6CAEDF"   # info / link hover
M_BLUE_DARK  = "#1F4E9E"   # primary action
M_RED        = "#C0002E"   # destructive / error / badge

# ── System Semantic ──────────────────────────────────────────────────
SUCCESS = "#34C759"   # macOS green
WARNING = "#FF9F0A"   # macOS orange
ERROR   = "#FF3B30"   # macOS red
INFO    = "#0A84FF"   # macOS blue
```

### 2.2 Semantic Tokens (Light / Dark)

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `BG_PAGE` | `#F2F2F7` | `#1A1A1A` | `page.bgcolor` |
| `BG_WINDOW` | `#FFFFFF` | `#222222` | Main content container |
| `BG_SIDEBAR` | `#F5F5F5` | `#2A2A2A` | NavigationRail / sidebar |
| `BG_CARD` | `#FFFFFF` | `#2C2C2C` | Cards, panels |
| `BG_INPUT` | `#FFFFFF` | `#333333` | TextField fill |
| `BORDER` | `#E0E0E0` | `#3A3A3A` | Container borders |
| `DIVIDER` | `#E8E8E8` | `#383838` | ft.Divider color |
| `TEXT_PRIMARY` | `#1A1A1A` | `#F0F0F0` | Headings, body copy |
| `TEXT_SECONDARY` | `#636363` | `#9A9A9A` | Subtitles, captions |
| `TEXT_DISABLED` | `#ADADAD` | `#555555` | Greyed-out labels |
| `ACCENT` | `#1F4E9E` | `#6CAEDF` | Buttons, links, focus rings |
| `ACCENT_HOVER` | `#17397A` | `#89C0E8` | Hovered primary button |
| `DESTRUCTIVE` | `#C0002E` | `#FF4558` | Delete, error actions |
| `SHADOW` | `#00000018` | `#00000055` | `ft.BoxShadow` color |

### 2.3 Implementing Tokens in Flet

```python
import flet as ft

# ── Detect theme mode at runtime ──────────────────────────────────────
def is_dark(page: ft.Page) -> bool:
    return page.theme_mode == ft.ThemeMode.DARK

def token(page: ft.Page, light_val: str, dark_val: str) -> str:
    return dark_val if is_dark(page) else light_val

# Usage example:
# bgcolor=token(page, "#FFFFFF", "#2C2C2C")
```

---

## 3 · Typography Scale

Always set `page.fonts` once at startup (or use system-ui fallback).

```python
# Font weights — follow BMW M's 700/300 editorial contrast
WEIGHT_DISPLAY  = ft.FontWeight.BOLD          # 700 — headlines
WEIGHT_LABEL    = ft.FontWeight.W_500         # 500 — button labels, nav items
WEIGHT_BODY     = ft.FontWeight.NORMAL        # 400 — body text
WEIGHT_CAPTION  = ft.FontWeight.W_300         # 300 — captions, secondary
```

| Role | `size` | `weight` | `color` token | Flet usage |
|------|--------|----------|---------------|------------|
| Large Title | 28 | BOLD | TEXT_PRIMARY | Page / section hero |
| Title 1 | 22 | BOLD | TEXT_PRIMARY | Card header, modal title |
| Title 2 | 17 | W_500 | TEXT_PRIMARY | Sub-section header |
| Body | 14 | NORMAL | TEXT_PRIMARY | Paragraphs, list items |
| Label | 13 | W_500 | TEXT_PRIMARY | Button text, tab label |
| Caption | 12 | W_300 | TEXT_SECONDARY | Timestamps, hints |
| Footnote | 11 | NORMAL | TEXT_SECONDARY | Legal, metadata |

```python
def text_large_title(label: str, page: ft.Page) -> ft.Text:
    return ft.Text(label, size=28, weight=ft.FontWeight.BOLD,
                   color=token(page, "#1A1A1A", "#F0F0F0"))

def text_title(label: str, page: ft.Page) -> ft.Text:
    return ft.Text(label, size=22, weight=ft.FontWeight.BOLD,
                   color=token(page, "#1A1A1A", "#F0F0F0"))

def text_subtitle(label: str, page: ft.Page) -> ft.Text:
    return ft.Text(label, size=17, weight=ft.FontWeight.W_500,
                   color=token(page, "#1A1A1A", "#F0F0F0"))

def text_body(label: str, page: ft.Page) -> ft.Text:
    return ft.Text(label, size=14, weight=ft.FontWeight.NORMAL,
                   color=token(page, "#1A1A1A", "#F0F0F0"))

def text_caption(label: str, page: ft.Page) -> ft.Text:
    return ft.Text(label, size=12, weight=ft.FontWeight.W_300,
                   color=token(page, "#636363", "#9A9A9A"))
```

---

## 4 · Spacing & Layout System

Use an **8-point grid** throughout — all spacing values are multiples of 4 or 8.

```python
SPACE_XS  = 4    # tight internal gaps (icon → label)
SPACE_SM  = 8    # item gaps in rows
SPACE_MD  = 12   # default control padding
SPACE_LG  = 16   # card padding, section gaps
SPACE_XL  = 24   # between sections
SPACE_2XL = 32   # page-level top/bottom padding
SPACE_3XL = 48   # hero sections

# Border radii
RADIUS_SM = 6    # inputs, small chips
RADIUS_MD = 10   # cards, panels, modals
RADIUS_LG = 14   # sheets, drawers
RADIUS_PILL = 999  # pills, badges
```

---

## 5 · Page Setup (Do This First, Every Time)

```python
import flet as ft

def setup_page(page: ft.Page, title: str = "App"):
    page.title = title
    page.fonts = {
        # SF Pro substitute — uses system font stack
        "SF": "https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2"
    }
    page.theme = ft.Theme(
        font_family="SF",
        color_scheme_seed="#1F4E9E",          # M Blue Dark as seed
        color_scheme=ft.ColorScheme(
            primary="#1F4E9E",
            on_primary="#FFFFFF",
            secondary="#6CAEDF",
            surface="#FFFFFF",
            on_surface="#1A1A1A",
            background="#F2F2F7",
            on_background="#1A1A1A",
            error="#FF3B30",
        ),
        visual_density=ft.ThemeVisualDensity.COMPACT,
    )
    page.dark_theme = ft.Theme(
        font_family="SF",
        color_scheme_seed="#6CAEDF",          # M Blue Light for dark
        color_scheme=ft.ColorScheme(
            primary="#6CAEDF",
            on_primary="#000000",
            secondary="#1F4E9E",
            surface="#222222",
            on_surface="#F0F0F0",
            background="#1A1A1A",
            on_background="#F0F0F0",
            error="#FF4558",
        ),
        visual_density=ft.ThemeVisualDensity.COMPACT,
    )
    page.theme_mode = ft.ThemeMode.LIGHT
    page.bgcolor = "#F2F2F7"
    page.padding = 0
    page.spacing = 0
```

---

## 6 · Component Recipes

### 6.1 Card

```python
def card(content: ft.Control, page: ft.Page,
         padding: int = 16, radius: int = 10) -> ft.Container:
    return ft.Container(
        content=content,
        bgcolor=token(page, "#FFFFFF", "#2C2C2C"),
        border=ft.border.all(1, token(page, "#E0E0E0", "#3A3A3A")),
        border_radius=radius,
        padding=padding,
        shadow=ft.BoxShadow(
            spread_radius=0,
            blur_radius=8,
            color=token(page, "#00000012", "#00000050"),
            offset=ft.Offset(0, 2),
        ),
    )
```

### 6.2 Primary Button (BMW M accent, macOS sizing)

```python
def btn_primary(label: str, on_click, page: ft.Page,
                icon: str | None = None) -> ft.ElevatedButton:
    return ft.ElevatedButton(
        text=label,
        icon=icon,
        on_click=on_click,
        style=ft.ButtonStyle(
            color={
                ft.ControlState.DEFAULT: "#FFFFFF",
                ft.ControlState.DISABLED: "#AAAAAA",
            },
            bgcolor={
                ft.ControlState.DEFAULT: token(page, "#1F4E9E", "#6CAEDF"),
                ft.ControlState.HOVERED: token(page, "#17397A", "#89C0E8"),
                ft.ControlState.PRESSED: token(page, "#122D60", "#5BA8D8"),
                ft.ControlState.DISABLED: token(page, "#D0D0D0", "#3A3A3A"),
            },
            shape=ft.RoundedRectangleBorder(radius=6),
            padding=ft.padding.symmetric(horizontal=20, vertical=10),
            elevation={"default": 0, "hovered": 2},
        ),
    )
```

### 6.3 Secondary / Ghost Button

```python
def btn_secondary(label: str, on_click, page: ft.Page) -> ft.OutlinedButton:
    return ft.OutlinedButton(
        text=label,
        on_click=on_click,
        style=ft.ButtonStyle(
            color={ft.ControlState.DEFAULT: token(page, "#1F4E9E", "#6CAEDF")},
            side={
                ft.ControlState.DEFAULT: ft.BorderSide(
                    1, token(page, "#1F4E9E", "#6CAEDF")
                ),
                ft.ControlState.HOVERED: ft.BorderSide(
                    1, token(page, "#17397A", "#89C0E8")
                ),
            },
            shape=ft.RoundedRectangleBorder(radius=6),
            padding=ft.padding.symmetric(horizontal=20, vertical=10),
        ),
    )
```

### 6.4 Destructive Button

```python
def btn_destructive(label: str, on_click, page: ft.Page) -> ft.ElevatedButton:
    return ft.ElevatedButton(
        text=label,
        on_click=on_click,
        style=ft.ButtonStyle(
            color={ft.ControlState.DEFAULT: "#FFFFFF"},
            bgcolor={
                ft.ControlState.DEFAULT: token(page, "#C0002E", "#FF4558"),
                ft.ControlState.HOVERED: token(page, "#990025", "#E03040"),
            },
            shape=ft.RoundedRectangleBorder(radius=6),
            padding=ft.padding.symmetric(horizontal=20, vertical=10),
            elevation={"default": 0},
        ),
    )
```

### 6.5 Text Field

```python
def text_field(label: str, hint: str = "", password: bool = False,
               page: ft.Page | None = None) -> ft.TextField:
    return ft.TextField(
        label=label,
        hint_text=hint,
        password=password,
        can_reveal_password=password,
        border=ft.InputBorder.OUTLINE,
        border_radius=6,
        border_color=token(page, "#D0D0D0", "#3A3A3A") if page else "#D0D0D0",
        focused_border_color=token(page, "#1F4E9E", "#6CAEDF") if page else "#1F4E9E",
        focused_border_width=2,
        fill_color=token(page, "#FFFFFF", "#333333") if page else "#FFFFFF",
        filled=True,
        label_style=ft.TextStyle(size=13, color="#636363"),
        text_style=ft.TextStyle(size=14),
        content_padding=ft.padding.symmetric(horizontal=12, vertical=10),
    )
```

### 6.6 Sidebar / NavigationRail

```python
def sidebar(destinations: list[ft.NavigationRailDestination],
            selected_index: int, on_change, page: ft.Page) -> ft.NavigationRail:
    return ft.NavigationRail(
        destinations=destinations,
        selected_index=selected_index,
        on_change=on_change,
        bgcolor=token(page, "#F5F5F5", "#2A2A2A"),
        indicator_color=token(page, "#E0EAF5", "#1F3A5C"),
        selected_label_text_style=ft.TextStyle(
            size=12, weight=ft.FontWeight.W_500,
            color=token(page, "#1F4E9E", "#6CAEDF"),
        ),
        unselected_label_text_style=ft.TextStyle(
            size=12, color=token(page, "#636363", "#9A9A9A"),
        ),
        leading=ft.Container(height=8),  # top gap
        group_alignment=-1.0,
        label_type=ft.NavigationRailLabelType.ALL,
        min_width=72,
        min_extended_width=200,
    )
```

### 6.7 Toolbar / AppBar

```python
def app_bar(title: str, page: ft.Page,
            actions: list[ft.Control] | None = None) -> ft.AppBar:
    return ft.AppBar(
        title=ft.Text(title, size=17, weight=ft.FontWeight.W_500,
                      color=token(page, "#1A1A1A", "#F0F0F0")),
        center_title=False,
        bgcolor=token(page, "#F5F5F5", "#2A2A2A"),
        elevation=0,
        actions=actions or [],
        shadow_color="transparent",
        surface_tint_color="transparent",
    )
```

### 6.8 Status Badge / Chip

```python
def badge(label: str, variant: str = "info", page: ft.Page | None = None) -> ft.Container:
    """variant: 'info' | 'success' | 'warning' | 'error'"""
    colors = {
        "info":    ("#E0EAF5", "#1F4E9E", "#1A3A6A", "#6CAEDF"),
        "success": ("#E3F5EA", "#1A7A3A", "#1A4A2A", "#34C759"),
        "warning": ("#FFF4E0", "#A05A00", "#6A3A00", "#FF9F0A"),
        "error":   ("#FDEAEA", "#B00020", "#7A0015", "#FF4558"),
    }
    bg_l, fg_l, bg_d_offset, fg_d = colors.get(variant, colors["info"])
    is_d = page and is_dark(page)
    return ft.Container(
        content=ft.Text(label, size=11, weight=ft.FontWeight.W_500,
                        color=fg_d if is_d else fg_l),
        bgcolor=bg_d_offset if is_d else bg_l,
        border_radius=999,
        padding=ft.padding.symmetric(horizontal=10, vertical=3),
    )
```

### 6.9 Divider

```python
def divider(page: ft.Page) -> ft.Divider:
    return ft.Divider(
        height=1,
        thickness=1,
        color=token(page, "#E8E8E8", "#383838"),
    )
```

### 6.10 List Tile (macOS-style row)

```python
def list_row(title: str, subtitle: str = "", leading: ft.Control | None = None,
             trailing: ft.Control | None = None, on_click=None,
             page: ft.Page | None = None) -> ft.ListTile:
    return ft.ListTile(
        title=ft.Text(title, size=14, weight=ft.FontWeight.NORMAL),
        subtitle=ft.Text(subtitle, size=12) if subtitle else None,
        leading=leading,
        trailing=trailing,
        on_click=on_click,
        hover_color=token(page, "#F0F0F0", "#333333") if page else "#F0F0F0",
        selected_color=token(page, "#E0EAF5", "#1F3A5C") if page else "#E0EAF5",
        min_leading_width=36,
        content_padding=ft.padding.symmetric(horizontal=16, vertical=4),
    )
```

### 6.11 Modal / Alert Dialog

```python
def modal(title: str, body: ft.Control,
          actions: list[ft.Control], page: ft.Page) -> ft.AlertDialog:
    return ft.AlertDialog(
        modal=True,
        title=ft.Text(title, size=17, weight=ft.FontWeight.BOLD,
                      color=token(page, "#1A1A1A", "#F0F0F0")),
        content=body,
        actions=actions,
        actions_alignment=ft.MainAxisAlignment.END,
        bgcolor=token(page, "#FFFFFF", "#2C2C2C"),
        shape=ft.RoundedRectangleBorder(radius=12),
    )
```

### 6.12 Theme Toggle Switch (macOS-style)

```python
def theme_toggle(page: ft.Page) -> ft.IconButton:
    def toggle(e):
        if page.theme_mode == ft.ThemeMode.LIGHT:
            page.theme_mode = ft.ThemeMode.DARK
            page.bgcolor = "#1A1A1A"
        else:
            page.theme_mode = ft.ThemeMode.LIGHT
            page.bgcolor = "#F2F2F7"
        page.update()

    return ft.IconButton(
        icon=ft.Icons.DARK_MODE_OUTLINED,
        selected_icon=ft.Icons.LIGHT_MODE_OUTLINED,
        on_click=toggle,
        tooltip="Toggle theme",
        icon_color=token(page, "#636363", "#9A9A9A"),
    )
```

---

## 7 · Layout Patterns

### 7.1 Master–Detail (macOS standard)

```
Row(expand=True)
├── NavigationRail  (width ~72–200 px)   ← sidebar()
├── VerticalDivider (1 px)
└── Column(expand=True)
    ├── AppBar                           ← app_bar()
    └── content area (scroll=AUTO)
```

```python
page.add(
    ft.Row(
        controls=[
            sidebar(..., page=page),
            ft.VerticalDivider(width=1, color=token(page, "#E0E0E0", "#3A3A3A")),
            ft.Column(
                controls=[
                    app_bar("Dashboard", page),
                    ft.Container(
                        content=main_content,
                        expand=True,
                        padding=24,
                    ),
                ],
                expand=True,
                spacing=0,
            ),
        ],
        expand=True,
        spacing=0,
    )
)
```

### 7.2 Settings Panel (stacked groups)

```python
def settings_group(title: str, items: list[ft.Control],
                   page: ft.Page) -> ft.Column:
    return ft.Column([
        ft.Text(title.upper(), size=11, weight=ft.FontWeight.W_500,
                color=token(page, "#636363", "#9A9A9A"),
                letter_spacing=0.8),
        ft.Container(height=4),
        card(ft.Column(items, spacing=0), page, padding=0),
        ft.Container(height=16),
    ], spacing=0)
```

### 7.3 Dashboard Grid

```python
ft.GridView(
    controls=[card(...) for item in items],
    runs_count=3,          # columns
    max_extent=320,        # max card width
    spacing=16,
    run_spacing=16,
    padding=24,
)
```

---

## 8 · M Tricolor Accent Rules

The BMW M tricolor (`M_BLUE_LIGHT → M_BLUE_DARK → M_RED`) is **a precision tool, not decoration**.

```
✅ USE for:
  - Primary action button background (M_BLUE_DARK / M_BLUE_LIGHT)
  - Focused input ring (M_BLUE_DARK)
  - NavigationRail selected indicator (M_BLUE_DARK tint)
  - Status badges for info states (M_BLUE_LIGHT)
  - Destructive / error states (M_RED)
  - Thin accent stripe on hero card top border (3 px LinearGradient)

❌ NEVER use for:
  - Page background
  - Card backgrounds
  - Typography (except active nav label)
  - Decorative patterns or borders
  - More than ONE tricolor element per visible screen area
```

Hero accent stripe example (top-border gradient on a featured card):

```python
ft.Container(
    content=your_card_content,
    border=ft.border.all(0),
    border_radius=10,
    # Gradient top border simulated with a Column:
    # Stack a 3px tall LinearGradient strip above the card content
)

# Use a Stack or Column approach:
ft.Column([
    ft.Container(
        height=3,
        border_radius=ft.border_radius.only(top_left=10, top_right=10),
        gradient=ft.LinearGradient(
            begin=ft.Alignment(-1, 0),
            end=ft.Alignment(1, 0),
            colors=["#6CAEDF", "#1F4E9E", "#C0002E"],
        ),
    ),
    ft.Container(
        content=card_body,
        bgcolor=token(page, "#FFFFFF", "#2C2C2C"),
        padding=16,
        border_radius=ft.border_radius.only(bottom_left=10, bottom_right=10),
    ),
], spacing=0)
```

---

## 9 · Shadows & Elevation

macOS uses **subtle, soft shadows** — never harsh drop shadows.

```python
# Level 0 — flat (for items on paper surface)
shadow_none = []

# Level 1 — card resting on page
shadow_card = ft.BoxShadow(
    spread_radius=0, blur_radius=8,
    color="#00000015", offset=ft.Offset(0, 2)
)

# Level 2 — popover / dropdown
shadow_popover = ft.BoxShadow(
    spread_radius=0, blur_radius=20,
    color="#00000025", offset=ft.Offset(0, 6)
)

# Level 3 — modal sheet
shadow_modal = ft.BoxShadow(
    spread_radius=0, blur_radius=40,
    color="#00000035", offset=ft.Offset(0, 12)
)
```

---

## 10 · Animation & Transition

Flet 0.25 supports `ft.AnimatedSwitcher` and `animate_*` container properties.

```python
# Standard easing duration for state transitions
DURATION_FAST   = 120   # ms — hover states
DURATION_NORMAL = 200   # ms — panel open, card flip
DURATION_SLOW   = 350   # ms — page/route transitions

# Animated container example (hover highlight)
ft.Container(
    ...
    animate=ft.Animation(DURATION_FAST, ft.AnimationCurve.EASE_IN_OUT),
)
```

---

## 11 · Anti-Patterns (Never Do These)

| ❌ Bad | ✅ Good |
|--------|---------|
| Hardcoded `bgcolor="grey"` everywhere | Use token() with light/dark values |
| `padding=ft.padding.all(5)` (odd numbers) | Use 4/8/12/16/24 from spacing system |
| All text the same size (14) | Use the 7-level type scale |
| Colorful backgrounds on every card | White/near-black cards, color only on accent |
| Borders on everything | Borders only where surface-to-surface contrast is insufficient |
| `ft.ElevatedButton` default style | Always override with `style=ft.ButtonStyle(...)` |
| `page.padding = 20` globally | Set padding on individual containers |
| No `shadow` on cards | Add `shadow_card` to every card container |
| Mixing `ft.colors` strings and hex | Pick one — use hex for precision throughout |
| Wide full-bleed text lines | Max content width 800 px; use `max_width` on Column |

---

## 12 · Full App Bootstrap Example

```python
import flet as ft

# ── paste token() and is_dark() helpers here ──────────────────────────

def main(page: ft.Page):
    setup_page(page, "MyApp")

    def on_nav_change(e):
        page.update()

    nav = sidebar(
        destinations=[
            ft.NavigationRailDestination(icon=ft.Icons.HOME_OUTLINED,
                                         selected_icon=ft.Icons.HOME,
                                         label="Home"),
            ft.NavigationRailDestination(icon=ft.Icons.SETTINGS_OUTLINED,
                                         selected_icon=ft.Icons.SETTINGS,
                                         label="Settings"),
        ],
        selected_index=0,
        on_change=on_nav_change,
        page=page,
    )

    content = ft.Column([
        text_large_title("Dashboard", page),
        ft.Container(height=8),
        ft.GridView(
            controls=[
                card(ft.Column([
                    text_subtitle("Revenue", page),
                    text_large_title("$124k", page),
                    text_caption("↑ 12% vs last month", page),
                ]), page),
            ],
            runs_count=3, max_extent=300,
            spacing=16, run_spacing=16,
        ),
    ], spacing=0, scroll=ft.ScrollMode.AUTO)

    bar = app_bar("Dashboard", page, actions=[theme_toggle(page)])

    page.add(
        ft.Column([
            bar,
            ft.Row([
                nav,
                ft.VerticalDivider(width=1,
                                   color=token(page, "#E0E0E0", "#3A3A3A")),
                ft.Container(content=content, expand=True, padding=24),
            ], expand=True, spacing=0),
        ], spacing=0, expand=True)
    )

ft.app(target=main)
```

---

## 13 · Checklist Before Submitting Code

- [ ] `setup_page()` called before any controls are added
- [ ] Every `bgcolor` uses `token(page, light, dark)` — never hardcoded single color
- [ ] All spacing values are multiples of 4
- [ ] Cards have `shadow_card` shadow
- [ ] Buttons override the default `style` — no plain `ft.ElevatedButton("text")`
- [ ] Text uses the type scale — no ad-hoc sizes
- [ ] M tricolor used ≤1 element per screen section
- [ ] Theme toggle is accessible from the AppBar
- [ ] Content column has `scroll=ft.ScrollMode.AUTO` for overflow safety
- [ ] `page.update()` is called after any state change in event handlers

---

## 14 · Troubleshooting Guide

This section documents the most common Flet UI issues, their root causes, and exact fixes. Check here before assuming a Flet bug — 90% of problems are caused by one of the patterns below.

---

### 14.1 Visual / Rendering Issues

---

#### ❌ Theme toggle switches mode but colors don't update

**Symptom:** Clicking the dark/light toggle changes `page.theme_mode` but containers keep their old color.

**Root cause:** Hard-coded hex colors in `bgcolor`, `border`, `color` — they don't re-evaluate when the theme changes.

**Fix:** Always use the `token()` helper AND call `page.update()` inside the toggle handler. For controls that were built once at startup, you must **rebuild** them or use `ft.Colors.*` semantic references instead of hex.

```python
# ❌ Wrong — static color, never re-evaluates
container = ft.Container(bgcolor="#FFFFFF")

# ✅ Right — rebuild on theme change
def build_ui(page):
    return ft.Container(bgcolor=token(page, "#FFFFFF", "#2C2C2C"))

def toggle_theme(e):
    page.theme_mode = (
        ft.ThemeMode.DARK
        if page.theme_mode == ft.ThemeMode.LIGHT
        else ft.ThemeMode.LIGHT
    )
    page.bgcolor = token(page, "#F2F2F7", "#1A1A1A")
    page.controls.clear()
    page.add(build_ui(page))   # rebuild with fresh token values
    page.update()
```

---

#### ❌ Card background is white in dark mode (or black in light mode)

**Symptom:** Cards look correct in one theme but ignore the other.

**Root cause:** `bgcolor` was set once at construction time with a literal color, not a `token()` call.

**Fix:** Pass `page` into every factory function and call `token()` at construction time. If the UI is rebuilt on theme toggle (recommended), this resolves automatically.

---

#### ❌ `ft.BoxShadow` color string like `"#00000018"` has no effect

**Symptom:** Shadow is invisible even with high blur radius.

**Root cause:** Flet expects `#AARRGGBB` format (alpha first), but some versions silently ignore invalid color strings.

**Fix:** Use the `ft.Colors.with_opacity()` method or ensure the hex string is exactly 8 characters with alpha prefix:

```python
# ❌ May be ignored depending on Flet version
color="#00000018"

# ✅ Reliable cross-version approach
color=ft.Colors.with_opacity(0.09, "#000000")
# or use a valid 8-char hex:
color="#18000000"   # ARGB order: alpha=0x18, R=0, G=0, B=0
```

---

#### ❌ Text color doesn't respect theme — always shows dark/light regardless

**Symptom:** `ft.Text` with a hardcoded `color=` stays that color in both modes.

**Root cause:** Same as card bgcolor — static value.

**Fix:** Use the text factory functions from §3, or wrap `ft.Text` color in `token()`. Alternatively, omit `color=` entirely — Flet will inherit from the theme's `on_surface` / `on_background` color automatically.

```python
# ✅ Let the theme handle it (inherits on_surface)
ft.Text("Hello", size=14)

# ✅ Or explicit with token
ft.Text("Hello", size=14, color=token(page, "#1A1A1A", "#F0F0F0"))
```

---

#### ❌ `NavigationRail` indicator / selected color looks wrong

**Symptom:** Selected nav item shows a default purple/teal indicator instead of the M Blue.

**Root cause:** `indicator_color` and label text styles aren't set; Flet uses Material 3 defaults.

**Fix:** Set all four style properties explicitly in the `sidebar()` factory (already done in §6.6). If building `NavigationRail` manually, add:

```python
ft.NavigationRail(
    indicator_color="#1F4E9E",  # or token()
    selected_label_text_style=ft.TextStyle(color="#1F4E9E", weight=ft.FontWeight.W_500),
    unselected_label_text_style=ft.TextStyle(color="#636363"),
    ...
)
```

---

#### ❌ `ft.AppBar` shows a coloured elevation tint / surface tint

**Symptom:** AppBar has an unexpected blue or coloured overlay in Material 3.

**Root cause:** Material 3 applies `surface_tint_color` by default to elevated surfaces.

**Fix:** Explicitly disable it:

```python
ft.AppBar(
    ...
    elevation=0,
    surface_tint_color="transparent",
    shadow_color="transparent",
)
```

---

#### ❌ `ft.ElevatedButton` default style looks generic / doesn't match design

**Symptom:** Button has a white background with no custom color, or ignores `bgcolor`.

**Root cause:** In Flet 0.21+, `bgcolor` as a plain string only sets the default state. Hover/pressed states still use Material defaults.

**Fix:** Always use `style=ft.ButtonStyle(bgcolor={ft.ControlState.DEFAULT: ..., ft.ControlState.HOVERED: ...})`. See §6.2 for the full pattern.

---

#### ❌ Rounded corners clip child content / content bleeds outside border radius

**Symptom:** Content inside a `Container` with `border_radius` renders outside the rounded corners.

**Root cause:** `clip_behavior` defaults to `NONE` when there is no border radius set explicitly by Flet.

**Fix:** Set `clip_behavior` explicitly:

```python
ft.Container(
    border_radius=10,
    clip_behavior=ft.ClipBehavior.ANTI_ALIAS,
    content=...,
)
```

---

### 14.2 Layout Issues

---

#### ❌ Content overflows vertically / page scrolls erratically

**Symptom:** Content gets cut off at the bottom, or scrolling is broken/jumpy.

**Root cause:** `ft.Column` without `scroll=` on the right container, or `expand=True` missing on parent containers.

**Fix:**

```python
# ✅ Content column — always scroll on the innermost content Column
ft.Column(
    controls=[...],
    scroll=ft.ScrollMode.AUTO,
    expand=True,
)

# ✅ Layout Row/Column wrappers — always expand
ft.Row(controls=[sidebar, content_col], expand=True, spacing=0)
ft.Column(controls=[appbar, body_row], expand=True, spacing=0)
```

---

#### ❌ `ft.Row` children overflow horizontally / get squished

**Symptom:** Items in a Row are too narrow or hidden; content clips at the right edge.

**Root cause:** Missing `expand=True` on the growing child, or Row has no `wrap`.

**Fix:**

```python
# Give the main content column all remaining space
ft.Row([
    sidebar_widget,                          # fixed width
    ft.VerticalDivider(width=1),
    ft.Container(content=main, expand=True), # ← expand takes remaining
])
```

---

#### ❌ `ft.GridView` cards are all the same wrong size / only shows 1 column

**Symptom:** GridView cards render in a single column, or all have a tiny fixed size.

**Root cause:** `runs_count` and `max_extent` conflict — when both are set, `max_extent` wins. Also, the GridView parent must have a bounded height.

**Fix:** Use only one of `runs_count` OR `max_extent`, and wrap the GridView in an `expand=True` Container:

```python
ft.Container(
    content=ft.GridView(
        controls=[...],
        max_extent=320,   # auto-computes column count from available width
        spacing=16,
        run_spacing=16,
        padding=24,
    ),
    expand=True,
)
```

---

#### ❌ `ft.AlertDialog` / modal doesn't appear centered or clips content

**Symptom:** Dialog appears in the corner, is too small, or content is clipped.

**Root cause:** Dialog content is not wrapped in a sized container; Flet tries to intrinsic-size it.

**Fix:** Wrap the dialog `content` in a `Container` with an explicit `width`:

```python
ft.AlertDialog(
    content=ft.Container(
        content=your_body_widget,
        width=400,
        padding=8,
    ),
    ...
)
```

---

#### ❌ Sidebar and content area gap / unwanted white line between them

**Symptom:** A visible gap or default `spacing` appears between the NavigationRail and content.

**Root cause:** `ft.Row` default `spacing` is not zero.

**Fix:**

```python
ft.Row([nav, divider, content], spacing=0, expand=True)
#                                ^^^^^^^^
```

---

### 14.3 State & Update Issues

---

#### ❌ UI doesn't update after changing a variable

**Symptom:** You update a Python variable (e.g. list item, counter) but the UI stays unchanged.

**Root cause:** Flet is imperative — changing a Python value doesn't trigger a re-render. You must call `page.update()` or `control.update()` explicitly.

**Fix:**

```python
def on_button_click(e):
    my_label.value = "Updated!"
    my_label.update()    # update just this control (faster)
    # OR
    page.update()        # update the entire page
```

---

#### ❌ `page.update()` called but nothing changes

**Symptom:** `update()` runs without error but the UI is still stale.

**Root cause 1:** The control being modified is not part of `page.controls` tree — it may be a local variable that was never added to the page.

**Root cause 2:** You're rebuilding a new control object but the old reference is still in the tree.

**Fix:** Modify the control's properties **in-place** rather than creating a new object, then call `.update()`:

```python
# ❌ Creates a new object — old one in tree is unchanged
my_container = ft.Container(bgcolor="red")

# ✅ Mutate the existing object that's in the tree
my_container.bgcolor = "red"
my_container.update()
```

---

#### ❌ Event handler throws `RuntimeError: Event loop is closed`

**Symptom:** App crashes with this error when closing the window or after an async event.

**Root cause:** Python < 3.12 asyncio cleanup bug, or mixing `async` and sync handlers incorrectly.

**Fix:** Upgrade Python to 3.12+. If that's not possible, wrap the app entry point:

```python
import asyncio, flet as ft

async def main(page: ft.Page):
    ...

if __name__ == "__main__":
    ft.app(target=main)
```

---

#### ❌ `on_click` fires but `e.control` is the wrong control

**Symptom:** Clicking different items in a loop all trigger the same handler with the same data.

**Root cause:** Classic Python closure-in-loop bug — the loop variable is captured by reference.

**Fix:** Use a default argument to capture the value at definition time:

```python
# ❌ All buttons capture the same final value of `item`
for item in items:
    ft.ElevatedButton(item.name, on_click=lambda e: handle(item))

# ✅ Capture value at loop iteration with default arg
for item in items:
    ft.ElevatedButton(item.name, on_click=lambda e, i=item: handle(i))
```

---

### 14.4 Font & Typography Issues

---

#### ❌ Custom font doesn't load / falls back to system default

**Symptom:** Text renders in the OS default font instead of the custom one.

**Root cause:** `page.fonts` dictionary key doesn't match the `font_family` string used in `ft.Theme`, or the URL is unreachable.

**Fix:** Ensure the key matches exactly (case-sensitive) and the font is fully loaded before `page.update()`:

```python
page.fonts = {"SF": "path/to/Inter.ttf"}   # key = "SF"
page.theme = ft.Theme(font_family="SF")     # must match exactly
```

For bundled assets, place the `.ttf` in `assets/fonts/` and reference as `"fonts/Inter.ttf"`.

---

#### ❌ `ft.FontWeight.W_300` renders as regular weight

**Symptom:** Light-weight text appears the same as normal weight.

**Root cause:** The loaded font file doesn't include a 300-weight variant — Flet can't synthesize thin weights.

**Fix:** Use a variable font (e.g. Inter Variable) or load separate font files per weight:

```python
page.fonts = {
    "Inter-Light":   "fonts/Inter-Light.ttf",     # weight 300
    "Inter-Regular": "fonts/Inter-Regular.ttf",   # weight 400
    "Inter-Bold":    "fonts/Inter-Bold.ttf",       # weight 700
}
# Then reference per text:
ft.Text("Caption", font_family="Inter-Light", size=12)
```

---

### 14.5 Performance Issues

---

#### ❌ App feels sluggish when updating many controls at once

**Symptom:** UI freezes or stutters when updating a list/grid with 50+ items.

**Root cause:** Calling `page.update()` after every individual change triggers a full re-render each time.

**Fix:** Batch all mutations before calling `update()` once:

```python
# ❌ Slow — re-renders N times
for item in new_items:
    my_list.controls.append(ft.Text(item))
    page.update()

# ✅ Fast — renders once
for item in new_items:
    my_list.controls.append(ft.Text(item))
page.update()   # single update after all mutations
```

---

#### ❌ `ft.GridView` / `ft.ListView` with many items is slow to scroll

**Symptom:** Scrolling through a large list causes frame drops.

**Root cause:** All controls are rendered simultaneously even if offscreen.

**Fix:** Enable item caching and set `item_extent` for ListViews (allows Flet to skip off-screen renders):

```python
ft.ListView(
    controls=[...],
    item_extent=60,          # fixed row height enables virtual scrolling
    first_item_prototype=True,
)
```

For GridView, keep card complexity low — avoid deeply nested controls inside grid cells.

---

### 14.6 Quick Diagnostic Checklist

When something looks or behaves wrong, run through this before digging deeper:

```
1. Did I call page.update() after the change?
2. Is the control actually in the page.controls tree?
3. Did I use token() for all colors, or are some hardcoded?
4. Is expand=True set on the correct containers?
5. Is scroll=ft.ScrollMode.AUTO set on the content Column?
6. Is spacing=0 set on layout Row/Column (not content ones)?
7. Am I mutating an existing control or creating a new unreferenced one?
8. Is the font key in page.fonts matching font_family exactly?
9. Is clip_behavior=ANTI_ALIAS set on rounded containers?
10. Are lambda closures in loops using default arg capture (i=item)?
```
