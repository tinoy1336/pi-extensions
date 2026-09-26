> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-nf

Nerd Font glyph reference: search glyph names, render a contact sheet, and audit source files for unassigned or malformed glyph escapes.

```bash
pi install npm:@tinoy/pi-nf
```

## What it needs at call time

`search` and `audit` need nothing beyond the package: the glyph dataset (`data/nf.json`, 10,995
glyphs) ships inside it and is resolved relative to the module. The `sheet` action needs `python3`
with Pillow (PIL) and the Nerd Font file at
`/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf`; an absent one is a refusal naming the
missing piece and the fix, never a load failure.

## Registers

`nf`

## Vision models

`sheet` returns an image, so it is only rendered for a session whose model can read images; other
sessions get the same glyphs as text. The built-in list is the ids this release ships with; add
your own with the `PI_VISION_MODELS` setting (comma- or space-separated, each a bare id or
`provider/model-id`).

## Dataset

`data/nf.json` maps glyph name → codepoint hex, derived from the Nerd Fonts cheat-sheet data
(`nerd-fonts`, MIT). Repo policy keeps this table out of application bundles: an app spells a glyph
as a literal escape plus a name comment (`"\ue73c" // dev-python`), and `nf audit` is the check
that catches an unassigned PUA codepoint or a malformed unbraced escape.

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. The
dataset and the vision list are its own payload and its own setting.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
