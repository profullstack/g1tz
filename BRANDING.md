# Brand assets

The g1tz identity combines a Git commit graph, a charcoal terminal tile, and a mint lowercase wordmark. All four assets have transparent backgrounds.

| Asset | Use |
| --- | --- |
| `logo.svg` | Scalable README banner; wordmark drawn with paths, no font dependency |
| `logo.png` | Generated raster logo with alpha preserved |
| `favicon.svg` | Scalable standalone commit-graph mark |
| `favicon.png` | Generated square raster icon with alpha preserved |

The PNGs were generated on 2026-09-13 using the built-in OpenAI image generation tool. The favicon was a separate edit using the generated logo as its reference. The SVG companions were authored as editable geometric paths and gradients to match the generated identity; they contain no embedded raster images or external assets. PNG originals were copied unchanged into this repository.

## Logo generation prompt

```text
Use case: logo-brand
Asset type: README banner logo.png for the open source terminal Git client g1tz.
Primary request: Create a polished, distinctive horizontal brand lockup: a minimal Git commit graph symbol beside the exact lowercase wordmark "g1tz" (g, digit one, t, z).
Scene/backdrop: truly transparent background, preserve alpha.
Subject: the symbol is a dark charcoal rounded-square terminal tile with a single clean turquoise-to-mint commit graph, a vertical line and one diagonal branching arm, with three circular commit nodes. The terminal tile is compact and balanced.
Style/medium: crisp flat geometric design, vector-friendly, strong optical alignment, developer-tool identity. The wordmark uses heavy rounded monospaced letterforms in the same bright mint; restrained and precise.
Composition/framing: wide horizontal lockup, approximately 3:1 canvas, generous even clearspace. Icon left, wordmark right, the two form one compact balanced unit.
Text (verbatim): "g1tz"
Constraints: letters must be exactly g, numeral 1, t, z in lowercase, no tagline, no additional text, no tiny details, no photorealism, no 3D, no perspective, no mockup, no checkerboard drawn into the art, no background panel around the overall logo. Mint wordmark must remain readable against both light and dark README themes by using a subtle dark charcoal outline. Do not imitate the official Git logo.
```

The generated logo uses four commit nodes. That approved configuration is preserved in the favicon and both SVG companions.

## Favicon edit prompt

```text
Use case: precise-object-edit
Asset type: square favicon.png for g1tz, a terminal Git client.
Input images: Image 1 is the approved g1tz logo, the edit target and exact identity reference.
Primary request: Extract the rounded-square dark charcoal Git graph tile from the left side of the reference as a standalone square favicon. Remove the entire wordmark and its space. Center the tile on a square canvas with small even transparent padding.
Constraints: preserve the identity of the existing icon: dark charcoal rounded-square tile, turquoise-to-mint vertical line and one diagonal branching arm, four filled circular commit nodes in exactly the reference configuration. Keep the same colors and proportions. Clean flat graphic; crisp edges; readable at small sizes. The area outside the rounded square must be genuinely transparent with preserved alpha. No text, no new details, no shadow outside the tile, no watermark, no checkerboard drawn into the art.
Output: a square PNG, suitable as the source favicon image.
```

