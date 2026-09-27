/**
 * The colour themes, as data. A theme is a small palette — four surfaces, four
 * text lanes, eight accents — and everything else the stylesheet needs
 * (hairlines, washes, glows, tints, project hues, the terminal's ANSI colours)
 * is derived from it here. Adding a theme is adding one entry to THEMES.
 *
 * The two Triage themes are the exception: their tokens are hand-tuned in
 * styles.css (`:root` and `[data-theme="light"]`), so they carry a palette only
 * for the preview swatch and keep their own terminal colours. Every other theme
 * is compiled to a `:root[data-theme="<id>"]` block and injected once as a
 * <style> element (see appearance.ts), so switching is a single attribute write.
 *
 * Palette colours must be 6-digit hex: the terminal derives `#rrggbbaa`
 * selection colours from them, and xterm paints to a canvas that cannot read
 * CSS variables or color-mix().
 */
import type { ITheme } from '@xterm/xterm'

export type ThemeScheme = 'dark' | 'light'

export type ThemePalette = {
  /** The page. */
  canvas: string
  /** Panels and inset cards. */
  card: string
  /** Hover/selected chips, menus — one step away from card. */
  elev: string
  /** Code blocks and the terminal — the deepest well. */
  deep: string
  /** Headline text and the primary button fill. */
  ink: string
  /** Secondary text. */
  mute: string
  /** Hints and meta. */
  ash: string
  /** The faintest text; borders on diagrams. */
  stone: string
  red: string
  orange: string
  yellow: string
  green: string
  blue: string
  purple: string
  pink: string
  cyan: string
}

export type Theme = {
  /** Stable id: the `data-theme` value and what localStorage remembers. */
  id: string
  name: string
  scheme: ThemeScheme
  palette: ThemePalette
  /** Tokens live in styles.css rather than being compiled from the palette. */
  handTuned?: true
  /** Exact terminal colours, when the derived ones are not good enough. */
  terminal?: ITheme
}

export const THEMES: ReadonlyArray<Theme> = [
  {
    id: 'dark',
    name: 'Triage Dark',
    scheme: 'dark',
    handTuned: true,
    palette: {
      canvas: '#000000', card: '#0a0a0c', elev: '#101012', deep: '#06060a',
      ink: '#fcfdff', mute: '#a1a4a5', ash: '#888e90', stone: '#464a4d',
      red: '#ff2047', orange: '#ff801f', yellow: '#ffc53d', green: '#11ff99',
      blue: '#3b9eff', purple: '#a78bfa', pink: '#f472b6', cyan: '#2dd4bf',
    },
    terminal: {
      background: '#06060a',
      foreground: 'rgba(252,253,255,0.86)',
      cursor: '#fcfdff',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255,255,255,0.18)',
      black: '#0a0a0c',
      red: '#ff2047',
      green: '#11ff99',
      yellow: '#ffc53d',
      blue: '#3b9eff',
      magenta: '#c084fc',
      cyan: '#2dd4bf',
      white: '#a1a4a5',
      brightBlack: '#464a4d',
      brightRed: '#ff6b85',
      brightGreen: '#5dffb8',
      brightYellow: '#ffd76b',
      brightBlue: '#6db6ff',
      brightMagenta: '#d8b4fe',
      brightCyan: '#5eead4',
      brightWhite: '#fcfdff',
    },
  },
  {
    id: 'light',
    name: 'Triage Light',
    scheme: 'light',
    handTuned: true,
    palette: {
      canvas: '#f6f8fa', card: '#ffffff', elev: '#eceef2', deep: '#e6e9ee',
      ink: '#0b0c0e', mute: '#5c6166', ash: '#71767b', stone: '#b3b8bd',
      red: '#d61f3c', orange: '#c85a00', yellow: '#8a6d1f', green: '#0f9d58',
      blue: '#1f6feb', purple: '#7c3aed', pink: '#db2777', cyan: '#0f8b80',
    },
    terminal: {
      background: '#e6e9ee',
      foreground: 'rgba(11,12,14,0.84)',
      cursor: '#0b0c0e',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(31,111,235,0.22)',
      black: '#1b1e22',
      red: '#c01530',
      green: '#0a7a44',
      yellow: '#8a6d1f',
      blue: '#1256c7',
      magenta: '#8b3fd6',
      cyan: '#0e7f78',
      white: '#5c6166',
      brightBlack: '#8a9095',
      brightRed: '#d61f3c',
      brightGreen: '#0f9d58',
      brightYellow: '#a97a00',
      brightBlue: '#1f6feb',
      brightMagenta: '#9333ea',
      brightCyan: '#0f8b80',
      brightWhite: '#0b0c0e',
    },
  },

  // --- dark -----------------------------------------------------------------
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    scheme: 'dark',
    palette: {
      canvas: '#16161e', card: '#1a1b26', elev: '#24283b', deep: '#13131a',
      ink: '#c0caf5', mute: '#a9b1d6', ash: '#787fa6', stone: '#3b4261',
      red: '#f7768e', orange: '#ff9e64', yellow: '#e0af68', green: '#9ece6a',
      blue: '#7aa2f7', purple: '#bb9af7', pink: '#ff79c6', cyan: '#7dcfff',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    scheme: 'dark',
    palette: {
      canvas: '#181825', card: '#1e1e2e', elev: '#313244', deep: '#11111b',
      ink: '#cdd6f4', mute: '#a6adc8', ash: '#7f849c', stone: '#45475a',
      red: '#f38ba8', orange: '#fab387', yellow: '#f9e2af', green: '#a6e3a1',
      blue: '#89b4fa', purple: '#cba6f7', pink: '#f5c2e7', cyan: '#94e2d5',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    scheme: 'dark',
    palette: {
      canvas: '#21222c', card: '#282a36', elev: '#343746', deep: '#191a21',
      ink: '#f8f8f2', mute: '#c3c5d4', ash: '#8b93c4', stone: '#4d5372',
      red: '#ff5555', orange: '#ffb86c', yellow: '#f1fa8c', green: '#50fa7b',
      blue: '#6c9bf5', purple: '#bd93f9', pink: '#ff79c6', cyan: '#8be9fd',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    scheme: 'dark',
    palette: {
      canvas: '#2b303b', card: '#2e3440', elev: '#3b4252', deep: '#272c36',
      ink: '#eceff4', mute: '#c2c9d6', ash: '#8f99ad', stone: '#4c566a',
      red: '#bf616a', orange: '#d08770', yellow: '#ebcb8b', green: '#a3be8c',
      blue: '#81a1c1', purple: '#b48ead', pink: '#c895bf', cyan: '#88c0d0',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    scheme: 'dark',
    palette: {
      canvas: '#1d2021', card: '#282828', elev: '#3c3836', deep: '#181a1b',
      ink: '#ebdbb2', mute: '#bdae93', ash: '#a89984', stone: '#665c54',
      red: '#fb4934', orange: '#fe8019', yellow: '#fabd2f', green: '#b8bb26',
      blue: '#83a598', purple: '#d3869b', pink: '#e396a8', cyan: '#8ec07c',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    scheme: 'dark',
    palette: {
      canvas: '#21252b', card: '#282c34', elev: '#323842', deep: '#1b1f24',
      ink: '#dcdfe4', mute: '#abb2bf', ash: '#7f848e', stone: '#4b5263',
      red: '#e06c75', orange: '#d19a66', yellow: '#e5c07b', green: '#98c379',
      blue: '#61afef', purple: '#c678dd', pink: '#e882b4', cyan: '#56b6c2',
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    scheme: 'dark',
    palette: {
      canvas: '#191724', card: '#1f1d2e', elev: '#26233a', deep: '#16141f',
      ink: '#e0def4', mute: '#aeaac6', ash: '#858199', stone: '#524f67',
      red: '#eb6f92', orange: '#ea9a97', yellow: '#f6c177', green: '#9ccfd8',
      blue: '#3e8fb0', purple: '#c4a7e7', pink: '#ebbcba', cyan: '#8fc4cc',
    },
  },

  // --- light ----------------------------------------------------------------
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    scheme: 'light',
    palette: {
      canvas: '#e6e9ef', card: '#eff1f5', elev: '#dce0e8', deep: '#d6dae3',
      ink: '#4c4f69', mute: '#5c5f77', ash: '#7c7f93', stone: '#acb0be',
      red: '#d20f39', orange: '#fe640b', yellow: '#df8e1d', green: '#40a02b',
      blue: '#1e66f5', purple: '#8839ef', pink: '#ea76cb', cyan: '#179299',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    scheme: 'light',
    palette: {
      canvas: '#eee8d5', card: '#fdf6e3', elev: '#e8e1cb', deep: '#e4ddc8',
      ink: '#073642', mute: '#586e75', ash: '#657b83', stone: '#93a1a1',
      red: '#dc322f', orange: '#cb4b16', yellow: '#b58900', green: '#859900',
      blue: '#268bd2', purple: '#6c71c4', pink: '#d33682', cyan: '#2aa198',
    },
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    scheme: 'light',
    palette: {
      canvas: '#faf4ed', card: '#fffaf3', elev: '#f2e9e1', deep: '#f4ede8',
      ink: '#575279', mute: '#797593', ash: '#86819a', stone: '#cecacd',
      red: '#b4637a', orange: '#d7827e', yellow: '#ea9d34', green: '#56949f',
      blue: '#286983', purple: '#907aa9', pink: '#d7827e', cyan: '#56949f',
    },
  },
]

export const DEFAULT_THEME: Record<ThemeScheme, string> = { dark: 'dark', light: 'light' }

const byId = new Map(THEMES.map((t) => [t.id, t]))

export const findTheme = (id: string): Theme | undefined => byId.get(id)

/** The theme to use for `scheme`: `id` if it names one of that scheme, else the default. */
export function themeFor(scheme: ThemeScheme, id: string | null | undefined): Theme {
  const t = id ? byId.get(id) : undefined
  return t && t.scheme === scheme ? t : byId.get(DEFAULT_THEME[scheme])!
}

// ---------------------------------------------------------------------------
// Compiling a palette to the stylesheet's token layer. The names and the
// dark/light weights mirror the hand-tuned blocks in styles.css.
// ---------------------------------------------------------------------------

const mix = (color: string, pct: number, other = 'transparent') => `color-mix(in srgb, ${color} ${pct}%, ${other})`

function tokens({ scheme, palette: p }: Theme): Record<string, string> {
  const dark = scheme === 'dark'
  const w = (d: number, l: number) => (dark ? d : l)
  return {
    '--canvas': p.canvas,
    '--card': p.card,
    '--elev': p.elev,
    '--deep': p.deep,

    '--hair': mix(p.ink, w(8, 11)),
    '--hair-strong': mix(p.ink, w(15, 17)),
    '--hair-soft': mix(p.ink, w(5, 7)),
    '--hair-bright': mix(p.ink, w(30, 32)),

    '--ink': p.ink,
    '--body': mix(p.ink, w(88, 88)),
    '--charcoal': mix(p.ink, w(72, 72)),
    '--mute': p.mute,
    '--ash': p.ash,
    '--stone': p.stone,

    '--orange': p.orange,
    '--yellow': p.yellow,
    '--blue': p.blue,
    '--green': p.green,
    '--red': p.red,
    '--glow-orange': mix(p.orange, w(22, 14)),
    '--glow-yellow': mix(p.yellow, w(16, 12)),
    '--glow-blue': mix(p.blue, w(30, 16)),
    '--glow-green': mix(p.green, w(18, 14)),
    '--glow-red': mix(p.red, w(30, 16)),
    '--tint-red': mix(p.red, w(12, 9)),
    '--tint-green': mix(p.green, w(10, 11)),
    '--tint-yellow': mix(p.yellow, w(11, 13)),
    '--tint-blue': mix(p.blue, w(12, 11)),

    '--on-primary': dark ? p.canvas : p.card,
    '--wash-1': mix(p.ink, w(3, 3)),
    '--wash-2': mix(p.ink, w(5, 5)),
    '--wash-3': mix(p.ink, w(8, 8)),
    '--select': dark ? mix(p.ink, 20) : mix(p.blue, 20),
    '--primary-hover': mix(p.ink, 86, p.card),

    '--ring': dark ? 'rgba(0, 0, 0, 0.45)' : mix(p.ink, 16),
    '--drop': dark ? 'rgba(0, 0, 0, 0.5)' : mix(p.ink, 16),
    '--scrim': dark ? 'rgba(0, 0, 0, 0.55)' : mix(p.ink, 32),
    '--scroll-thumb': mix(p.ink, w(14, 20)),
    '--scroll-thumb-hover': mix(p.ink, w(24, 32)),

    '--link-hover': dark ? mix(p.blue, 65, p.ink) : mix(p.blue, 75, '#000'),
    '--red-ink': dark ? mix(p.red, 75, p.ink) : mix(p.red, 85, '#000'),

    '--hue-0': p.blue,
    '--hue-1': p.green,
    '--hue-2': p.yellow,
    '--hue-3': p.orange,
    '--hue-4': p.red,
    '--hue-5': p.purple,
    '--hue-6': p.pink,
    '--hue-7': p.cyan,

    '--accent': 'var(--ink)',
  }
}

/** Every compiled theme as one stylesheet — hand-tuned ones are skipped. */
export function themeStylesheet(): string {
  return THEMES.filter((t) => !t.handTuned)
    .map((t) => {
      const body = Object.entries(tokens(t))
        .map(([k, v]) => `  ${k}: ${v};`)
        .join('\n')
      return `:root[data-theme="${t.id}"] {\n  color-scheme: ${t.scheme};\n${body}\n}`
    })
    .join('\n\n')
}

/** xterm's palette for a theme: its own if it has one, else derived. */
export function terminalTheme(t: Theme): ITheme {
  if (t.terminal) return t.terminal
  const p = t.palette
  const dark = t.scheme === 'dark'
  const ansi = {
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.purple,
    cyan: p.cyan,
  }
  return {
    background: p.deep,
    foreground: p.ink,
    cursor: p.ink,
    cursorAccent: p.canvas,
    selectionBackground: `${dark ? p.ink : p.blue}38`,
    black: dark ? p.elev : p.ink,
    white: p.mute,
    brightBlack: dark ? p.stone : p.ash,
    brightWhite: p.ink,
    ...ansi,
    brightRed: p.red,
    brightGreen: p.green,
    brightYellow: p.yellow,
    brightBlue: p.blue,
    brightMagenta: p.pink,
    brightCyan: p.cyan,
  }
}
