# Component specs

Look: dark, flat, dense. No blur, no gradients on chrome, one small shadow (menus only). Icons are Lucide (ISC), 16px in toolbars, 1.5px stroke, `currentColor`. Font: Inter, bundled as a subset (Latin, 400/500/600/700). Every label and message is written fresh. Colour comes from tokens only.

Common to all: focus-visible shows a 2px `accent` ring offset 1px; disabled is 45% opacity and not focusable; hit targets at least 28px; everything reachable by keyboard.

Button
  variants  primary (accent bg, on-accent text), secondary (surface-2, text), ghost (transparent), danger
  sizes     sm 24px, md 28px, lg 36px (export button)
  states    default, hover (lighten 6%), active, focus-visible, disabled, busy (spinner, label kept)
  a11y      real <button>, icon-only buttons need aria-label and a title tooltip
  used on   S01, S02, S03, S09, S11

IconButton / toolbar toggle
  variants  momentary, toggle (aria-pressed)
  sizes     28px square
  states    default, hover, pressed/on (accent text on surface-2), disabled
  used on   S03 toolbar, S08 timeline toolbar, S06 transport

Slider
  variants  plain, with numeric field, with reset
  states    default, hover, dragging, focus, disabled
  tokens    track border, fill accent, thumb text, 12px thumb
  a11y      role=slider, arrow keys step, Shift = 10x, double-click resets
  used on   S07

NumberField / Stepper
  states    default, focus, invalid (danger border + message), disabled
  a11y      label always present, arrow keys, scrub by dragging label
  used on   S02, S07, S09

Select / Dropdown
  states    default, open, disabled
  a11y      native <select> styled, keeps OS keyboard behaviour (lightest option)
  used on   S02, S09, S10

Tabs
  variants  left panel (icon + label), right panel (text)
  states    default, hover, selected (accent underline 2px)
  a11y      role=tablist, arrow keys move, Home/End

ThumbnailTile
  variants  media, transition, filter, effect, sticker, sound
  states    default, hover (scrub preview for video), selected, dragging (ghost), offline (diagonal hatch + warning icon)
  a11y      role=option in a listbox, Enter adds to timeline

Timeline (canvas component)
  parts     ruler (24px), playhead (playhead colour, 1px line + 10px head), tracks (44px), clips, snap guide, marquee
  states    empty (drop hint text), filled, zoomed, playing (auto-scroll), drag/trim/split active
  rules     draw only visible clips; redraw on dirty rect; no DOM per clip; device-pixel-ratio aware
  a11y      a hidden live region announces selection and edits; all edits have keyboard commands
  used on   S08

TimelineClip
  variants  video (track-video), audio (track-audio, waveform), text (track-text), image
  states    default, hover, selected (accent 2px outline), trimming, dragging, offline (hatched), muted (dimmed)
  detail    name at left, 10px trim handles on hover, fade handles for audio, transition badge at joins

Track header
  contents  name, lock, mute, hide toggles
  states    default, selected, locked

Playhead and transport
  controls  go to start, previous frame, play/pause, next frame, go to end, timecode (mono), loop, preview quality, zoom
  keys      Space play, Left/Right frame, Shift+arrows 1 s, Home/End

PreviewCanvas
  states    empty, playing, paused, buffering (small spinner), low-quality notice
  overlay   transform handles (8 scale, 1 rotate), safe-area toggle, crop mode
  a11y      canvas has a label; transform values editable in S07 as numbers

CurveEditor (speed curve, colour curves)
  states    idle, dragging point, point selected
  a11y      points focusable, arrow keys nudge, Delete removes

ColourControls (wheel, HSL, curves)
  states    default, adjusting; double-click resets

ProgressBar
  variants  determinate (export), indeterminate (import)
  a11y      role=progressbar with value, text percentage and time left

Modal
  variants  confirm, error, relink media, export-complete
  states    open (focus trapped, Esc closes unless busy)
  a11y      role=dialog, aria-modal, focus returns to trigger

ContextMenu
  states    open, item hover, item disabled; shows shortcut hints
  a11y      role=menu, arrow keys, type-ahead

Toast
  variants  info, success, error (persist until dismissed)
  a11y      role=status, role=alert for errors

Tooltip
  delay 400 ms, shows shortcut

Empty states (original wording, to be written at build time)
  S01 no projects, S04 no media (with drop hint), S08 empty timeline, S05 category with no items
