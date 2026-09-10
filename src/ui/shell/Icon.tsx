// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — shared icon component
// ───────────────────────────────────────────────────────────────────────────
// Every icon in the app should render through THIS component, not an ad hoc
// unicode/emoji glyph. Backed by Google's Material Symbols — a self-hosted
// variable icon font (`material-symbols` npm package, `./icon.css` bundles
// its CSS + `.woff2` files through Vite; there is no runtime dependency on
// fonts.googleapis.com or any other CDN).
//
// Material Symbols is a ligature font: the element's TEXT CONTENT is the
// icon's name (e.g. "layers", "settings", "close") and the font substitutes
// the glyph. `name` below is exactly that ligature string — see
// https://fonts.google.com/icons for the full catalog.
//
// `variant` defaults to "outlined" per this phase's icon direction; reach for
// "rounded"/"sharp" only where that look is clearly better for a specific
// spot, not as a default choice — and when you do, also add that variant's
// `@import` to `./icon.css` (only "outlined" is imported today; see that
// file's comment for why the other two are deliberately left out until
// something actually uses them).
// ═══════════════════════════════════════════════════════════════════════════

import './icon.css';

export type IconVariant = 'outlined' | 'rounded' | 'sharp';

export interface IconProps {
  /** Material Symbols ligature name, e.g. "layers", "folder", "close". */
  name: string;
  variant?: IconVariant;
  className?: string;
  /** Set only when the icon is the sole content of an unlabeled control;
   *  leave unset (icon stays `aria-hidden`) when a parent already carries
   *  the accessible name (e.g. via `aria-label` on the wrapping button). */
  title?: string;
}

export function Icon({ name, variant = 'outlined', className, title }: IconProps) {
  const classes = ['sg-icon', `material-symbols-${variant}`, className].filter(Boolean).join(' ');
  return (
    <span className={classes} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} title={title}>
      {name}
    </span>
  );
}
