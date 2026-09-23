# @tinoy/pi-image-read

Read an image with token-cost control: downscale or crop it, return it inline, and report the token estimate.

```bash
pi install npm:@tinoy/pi-image-read
```

## What it needs at call time

the `magick` binary (ImageMagick) at call time. An absent or failing binary is a refusal naming
it, never a load failure. The crop cache lives under `$TMPDIR`, so it needs nothing else.

## Registers

`image_read`

## Vision models

`image_read` is registered for every session and is narrowed out of the tool set when the session
model cannot read images. The built-in list is the ids this release ships with; add your own with
the `PI_VISION_MODELS` setting — a comma- or space-separated list of model ids, each either a bare
id (`my-model`) or `provider/model-id`:

```bash
PI_VISION_MODELS="my-model,other-provider/other-model"
```

The list is read when the gate runs, not at load, so no configuration has to exist for the
extension to load.

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. It
narrows the active tool set only through its own tool name (`getActiveTools()` → drop
`image_read`), so a session whose tool set another package owns keeps that package's decision.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
