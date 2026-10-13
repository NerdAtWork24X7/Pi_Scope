# Vendored pixel-art assets

Everything under this directory is copied verbatim from
[pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)
and is used here under its **MIT License**:

> MIT License — Copyright (c) 2026 Pablo De Lucca
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The six character sprites are themselves based on
[JIK-A-4, *Metro City* free top-down character pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack),
as credited by the upstream project.

## Sprite geometry (how `pixel.js` slices these sheets)

| Asset | File | Slice |
|---|---|---|
| Floor pattern | `floors/floor_<n>.png` | one 16×16 tile; grayscale, tinted at load time |
| Wall set | `walls/wall_0.png` | 64×128 sheet → 16 pieces of **16×32**, `mask` at col `mask % 4`, row `floor(mask / 4)` |
| Character | `characters/char_<n>.png` | 112×96 sheet → 7 frames of **16×32** per row; row 0 = `down`, 1 = `up`, 2 = `right` (`left` is `right` flipped). Frames `0,1,2,1` = walk · `3,4` = typing · `5,6` = reading |
| Furniture | `furniture/<ID>/*.png` | one sprite per file at the `width`/`height` in that folder's `manifest.json` |

Wall bitmask convention (upstream `wallTiles.ts`): **N=1, E=2, S=4, W=8**; a
neighbour that is not a wall clears its bit.

The `manifest.json` files are kept as the authoritative record of each
furniture sprite's size and tile footprint; `pixel.js` reads the sizes it needs
from this table, not from the manifests.
