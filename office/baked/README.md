# The baked look

What `?look=baked` does is in the manual: [The baked look](../../docs/manual/how-it-works.html#baked-look).
This file is only for baking again.

Bake again when a part of the room that the bake covers changes: a new desk, a moved wall, a new
colour. Until then the page finds fewer parts than the bake knows, and the browser test in
`relay/test/browser/look.test.js` fails, because a part that left the room would still show in the
baked copy.

## What you need

- `npm ci`, and a Chrome: Playwright's (`npx playwright-core install chromium`) or your own.
- Blender's Python module, with NumPy and Pillow: `pip install bpy numpy pillow`. The bpy wheel needs
  the Python version it was built for (Blender 5.3: Python 3.13).

## Bake

```
node office/baked/export.js /tmp/bake [path to Chrome]
python3 office/baked/bake.py /tmp/bake office/baked
```

The first opens the room at evening, picks the parts `office/look.js` bakes, and writes them with
their textures to `/tmp/bake`. The second bakes in Blender with Cycles on the CPU and writes
`room.glb`, `light-evening.png`, `light-day.png`, `light-night.png`, `ao.png` and `bake.json` here. Each
time of day's light, and how bright its sun, sky and lamps are, is in `TIMES` at the top of `bake.py`.
It took about twenty minutes on two CPU cores at the default size, 2048. `--size 1024 --samples 32` is
faster and blurrier, and `--times evening` bakes one time only.

Then open `/office/?look=baked&time=day` (and `evening`, `night`) and compare each with the live look.
