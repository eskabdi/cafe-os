---
name: Modern Chronos
colors:
  surface: '#f9f9ff'
  surface-dim: '#d3daef'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f1f3ff'
  surface-container: '#e9edff'
  surface-container-high: '#e1e8fd'
  surface-container-highest: '#dce2f7'
  on-surface: '#141b2b'
  on-surface-variant: '#464555'
  inverse-surface: '#293040'
  inverse-on-surface: '#edf0ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4d44e3'
  primary: '#3525cd'
  on-primary: '#ffffff'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#c3c0ff'
  secondary: '#006591'
  on-secondary: '#ffffff'
  secondary-container: '#39b8fd'
  on-secondary-container: '#004666'
  tertiary: '#7e3000'
  on-tertiary: '#ffffff'
  tertiary-container: '#a44100'
  on-tertiary-container: '#ffd2be'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#c9e6ff'
  secondary-fixed-dim: '#89ceff'
  on-secondary-fixed: '#001e2f'
  on-secondary-fixed-variant: '#004c6e'
  tertiary-fixed: '#ffdbcc'
  tertiary-fixed-dim: '#ffb695'
  on-tertiary-fixed: '#351000'
  on-tertiary-fixed-variant: '#7b2f00'
  background: '#f9f9ff'
  on-background: '#141b2b'
  surface-variant: '#dce2f7'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  container-margin: 32px
  gutter: 16px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
  calendar-cell-min-height: 120px
---

## Brand & Style

The design system is centered on clarity, cognitive ease, and a sense of calm productivity. It targets professionals and teams who require a high-functioning tool that feels like a quiet workspace rather than a cluttered dashboard. 

The aesthetic is **Minimalist / Modern**, characterized by an "Airy" interface that prioritizes white space to reduce visual noise. By moving away from heavy stylistic trends like Neumorphism, this design system relies on precise alignment, high-quality typography, and a sophisticated use of pastel accents to categorize information without overwhelming the user. The emotional response should be one of "structured freedom"—the feeling that one’s schedule is organized and manageable.

## Colors

The palette is anchored by a deep **Charcoal (#111827)** for typography to ensure maximum legibility against **Soft White (#FFFFFF)** surfaces. The primary interactive color is a vibrant **Indigo**, used sparingly for call-to-actions and active states to maintain the minimalist vibe.

Backgrounds utilize a very light **Cool Gray (#F9FAFB)** to create a subtle distinction between the application frame and the content canvas. Event categorization is handled through a suite of high-chroma yet desaturated **Pastels**. These are used for event blocks, providing a clear visual distinction between different types of appointments (e.g., Mint for personal, Lavender for deep work, Peach for meetings) while keeping the overall UI bright and low-stress.

## Typography

This design system employs a dual-font strategy. **Plus Jakarta Sans** is used for headlines and display text; its soft, geometric curves provide a friendly and modern character to the application's most prominent elements. 

For the functional "workhorse" text—calendar dates, event descriptions, and UI labels—**Inter** is utilized. Inter’s tall x-height and exceptional legibility make it ideal for data-dense calendar views where clarity is paramount. Weight is used strategically to establish hierarchy: heavy weights for section headers and medium weights for interactive labels, while keeping body text at a standard regular weight to preserve the "airy" feel.

## Layout & Spacing

The layout follows a **Fluid Grid** model with strict adherence to an 8px base unit. 

- **Desktop:** A 12-column grid is used for dashboard views. Calendar grids themselves should maximize horizontal space, using a 7-column layout (for week views) with thin 1px dividers.
- **Margins:** Generous 32px outer margins ensure the content never feels cramped against the edge of the viewport.
- **Rhythm:** Vertical spacing relies on "Stack" units. Use `stack-lg` to separate major sections (e.g., Navigation vs. Calendar) and `stack-sm` for internal component elements (e.g., Icon and Label within a button).
- **Mobile:** The layout reflows to a single column. The calendar shifts from a grid to a vertical agenda list to maintain accessibility on small screens.

## Elevation & Depth

Hierarchy in this design system is achieved through **Tonal Layering** and **Low-Contrast Outlines** rather than aggressive shadows.

1.  **Level 0 (Base):** The `background_hex` surface.
2.  **Level 1 (Cards/Sidebar):** Pure white surfaces with a 1px border of `#E5E7EB`. This is used for the main calendar canvas and navigation panels.
3.  **Level 2 (Dropdowns/Modals):** Elements that sit above the main UI use a soft, diffused ambient shadow: `0px 10px 15px -3px rgba(0, 0, 0, 0.05)`. This provides just enough lift to signify interactivity without breaking the minimalist aesthetic.
4.  **Interaction:** Buttons use a subtle "pressed" state where the shadow is removed and the background color darkens by 5%, simulating physical depth.

## Shapes

The shape language is **Rounded**, using an 8px (0.5rem) corner radius as the standard. This strikes a balance between the precision of a professional tool and the approachability of a modern lifestyle app.

- **Standard Elements:** 8px radius (Buttons, Input fields, Event cards).
- **Large Containers:** 16px radius (Main calendar containers, Modals).
- **Full Rounding:** Used exclusively for notification badges, avatars, and "Today" indicator circles to create a distinct visual contrast with the rectangular grid of the calendar.

## Components

### Buttons
Primary buttons are solid Indigo with white text. Secondary buttons use a "Ghost" style: a 1px gray border with charcoal text, turning into a light gray fill on hover.

### Calendar Events
Event blocks are the heart of the UI. They should use a subtle 2px left-border of a highly saturated color, with the rest of the block filled with its corresponding pastel variant. Typography inside events should be `body-sm` with high-contrast charcoal for readability.

### Input Fields
Inputs are minimalist: a simple 1px border that turns Indigo on focus. Labels are positioned above the field in `label-sm` (uppercase) to maintain a professional, structured look.

### Chips & Tags
Used for filtering calendars. These should be pill-shaped with a light gray background and a "remove" icon that only appears on hover to keep the interface clean.

### Cards
Cards are used for "Upcoming Event" previews or "Task" lists. They feature the Level 1 elevation (border only) and generous internal padding (16px) to maintain the airy feel of the design system.