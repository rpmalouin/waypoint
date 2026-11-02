/**
 * The theme inspector: a panel that lives *inside* the sidebar, between its header
 * and its tile list, the way the workspace switcher and the container picker do.
 *
 * It is in flow and not a popover on purpose — the sidebar is a native view with a
 * hard 280px rectangle, so anything positioned outside it is not clipped, it is
 * invisible. It also never paints the theme itself: it sends what the user changed,
 * main coerces it once, and the broadcast that comes back seeds these controls.
 * That round trip is what keeps the sliders, the canvas and the chrome agreeing.
 */

import { HARMONY_MODES, generatePalette, isHexColor } from '../../shared/color.ts'
import { resolveTheme } from '../../shared/theme.ts'
import type { HarmonyMode, PaletteMode } from '../../shared/color.ts'
import type { WorkspaceTheme } from '../../shared/theme.ts'

const bridge = window.overlayBridge

const HARMONY_LABELS: Record<HarmonyMode, string> = {
  free: 'Free',
  complement: 'Complement',
  analogous: 'Analogous',
  triad: 'Triad',
  split: 'Split',
}

interface SliderSpec {
  key: 'baseHue' | 'vivid' | 'grain' | 'angle'
  label: string
  max: number
}

const SLIDERS: readonly SliderSpec[] = [
  { key: 'baseHue', label: 'Hue', max: 360 },
  { key: 'vivid', label: 'Vivid', max: 100 },
  { key: 'grain', label: 'Grain', max: 100 },
  { key: 'angle', label: 'Angle', max: 360 },
]

export interface ThemeInspector {
  setOpen(open: boolean): void
  isOpen(): boolean
}

export function mountThemeInspector(host: HTMLElement): ThemeInspector {
  host.innerHTML = `
    <section class="theme-panel" data-role="theme-panel" hidden aria-label="Theme">
      <p class="tp-title">Theme</p>
      <div class="tp-seg" data-role="tp-harmony" role="group" aria-label="Harmony"></div>
      <div class="tp-seg" data-role="tp-mode" role="group" aria-label="Mode">
        <button class="tp-seg-btn" data-mode="day" type="button">Day</button>
        <button class="tp-seg-btn" data-mode="night" type="button">Night</button>
      </div>
      ${SLIDERS.map(
        (spec) => `
        <label class="tp-slider">
          <span class="tp-label">${spec.label}</span>
          <input class="tp-range" data-theme="${spec.key}" type="range" min="0" max="${spec.max}" step="1" />
          <output class="tp-out" data-out="${spec.key}">0</output>
        </label>`,
      ).join('')}
      <div class="tp-swatches" data-role="tp-swatches" aria-label="Palette stops"></div>
      <p class="tp-hint" data-role="tp-hint"></p>
    </section>
  `

  const panel = host.querySelector<HTMLElement>('[data-role="theme-panel"]')!
  const harmonyEl = host.querySelector<HTMLElement>('[data-role="tp-harmony"]')!
  const modeEl = host.querySelector<HTMLElement>('[data-role="tp-mode"]')!
  const swatchesEl = host.querySelector<HTMLElement>('[data-role="tp-swatches"]')!
  const hintEl = host.querySelector<HTMLElement>('[data-role="tp-hint"]')!
  const ranges = new Map<string, HTMLInputElement>()
  for (const spec of SLIDERS) {
    ranges.set(spec.key, host.querySelector<HTMLInputElement>(`[data-theme="${spec.key}"]`)!)
  }

  harmonyEl.innerHTML = HARMONY_MODES.map(
    (mode) => `<button class="tp-seg-btn" data-harmony="${mode}" type="button">${HARMONY_LABELS[mode]}</button>`,
  ).join('')

  let theme: WorkspaceTheme = resolveTheme(undefined)
  let open = false
  /** Rebuild the swatch row only when it would actually look different. */
  let swatchKey = ''

  /**
   * A harmony's colours are derived, so the panel regenerates them on every change.
   * `free` derives nothing — those are the user's own stops — so its list is carried
   * through untouched.
   */
  const derive = (): WorkspaceTheme => {
    if (theme.harmony === 'free') return { ...theme, colors: [...theme.colors] }
    const colors = generatePalette(theme.harmony, theme.baseHue, theme.vivid, theme.mode)
    return colors.length >= 2 ? { ...theme, colors } : { ...theme, colors: [...theme.colors] }
  }

  const paint = (): void => {
    for (const button of harmonyEl.querySelectorAll<HTMLElement>('[data-harmony]')) {
      button.classList.toggle('on', button.dataset.harmony === theme.harmony)
    }
    for (const button of modeEl.querySelectorAll<HTMLElement>('[data-mode]')) {
      button.classList.toggle('on', button.dataset.mode === theme.mode)
    }
    for (const spec of SLIDERS) {
      const range = ranges.get(spec.key)!
      range.value = String(theme[spec.key])
      // Hue and vivid drive the generated palette, so outside `free` they are the
      // controls that matter; inside it they would move nothing, and a slider that
      // does nothing is a lie about the model.
      const inert = theme.harmony === 'free' && (spec.key === 'baseHue' || spec.key === 'vivid')
      range.disabled = inert
      range.title = inert ? 'Free mode keeps your own stops — this drives a generated palette' : ''
      const out = host.querySelector<HTMLOutputElement>(`[data-out="${spec.key}"]`)
      if (out) out.textContent = String(theme[spec.key])
    }
    hintEl.textContent =
      theme.harmony === 'free'
        ? 'Free: edit any stop. Stops are kept as typed.'
        : `Derived from hue ${theme.baseHue}° · vivid ${theme.vivid}%`
    buildSwatches()
  }

  const setColor = (index: number, value: string): void => {
    if (!isHexColor(value)) return
    const colors = [...theme.colors]
    colors[index] = value.toLowerCase()
    // A hand-typed stop is by definition no longer the harmony's palette.
    theme = { ...theme, harmony: 'free', colors }
    commit()
  }

  const buildSwatches = (): void => {
    const key = `${theme.harmony}|${theme.colors.join(',')}`
    if (key === swatchKey) return
    swatchKey = key
    swatchesEl.textContent = ''
    theme.colors.forEach((color, index) => {
      const cell = document.createElement('div')
      cell.className = 'tp-swatch'
      cell.dataset.index = String(index)
      if (theme.harmony === 'free') {
        const picker = document.createElement('input')
        picker.type = 'color'
        picker.className = 'tp-color'
        picker.value = color
        picker.dataset.index = String(index)
        picker.title = 'Pick a stop colour'
        picker.addEventListener('input', () => setColor(index, picker.value))

        const hex = document.createElement('input')
        hex.type = 'text'
        hex.className = 'tp-hex'
        hex.value = color
        hex.spellcheck = false
        hex.dataset.index = String(index)
        // Committed on change, not on input: a half-typed hex is not a colour, and
        // rewriting the field mid-word would fight the typist.
        hex.addEventListener('change', () => {
          if (!isHexColor(hex.value)) {
            hex.value = theme.colors[index] ?? ''
            return
          }
          setColor(index, hex.value)
        })
        cell.append(picker, hex)
      } else {
        const chip = document.createElement('span')
        chip.className = 'tp-chip'
        chip.style.background = color
        chip.title = color
        cell.append(chip)
      }
      swatchesEl.append(cell)
    })
  }

  const commit = (): void => {
    theme = derive()
    paint()
    // Fire-and-forget like a pan delta: main coerces and broadcasts, and the echo
    // seeds these very controls, so what is shown is what was actually accepted.
    bridge.updateTheme(theme)
  }

  harmonyEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-harmony]')
    const next = button?.dataset.harmony as HarmonyMode | undefined
    if (!next || !HARMONY_MODES.includes(next) || next === theme.harmony) return
    theme = { ...theme, harmony: next }
    commit()
  })

  modeEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-mode]')
    const next = button?.dataset.mode as PaletteMode | undefined
    if (!next || next === theme.mode) return
    theme = { ...theme, mode: next }
    commit()
  })

  for (const spec of SLIDERS) {
    const range = ranges.get(spec.key)!
    range.addEventListener('input', () => {
      const value = Math.round(Number(range.value))
      if (!Number.isFinite(value)) return
      theme = { ...theme, [spec.key]: value }
      commit()
    })
  }

  // Main's broadcast is the only source: it is coerced, so a stop typed here can be
  // corrected (or dropped) before it ever reaches a CSS property.
  bridge.onTheme((next) => {
    theme = next
    paint()
  })

  paint()

  return {
    isOpen: () => open,
    setOpen: (next: boolean) => {
      open = next
      panel.hidden = !next
      if (next) paint()
    },
  }
}
