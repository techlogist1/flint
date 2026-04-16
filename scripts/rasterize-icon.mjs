import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SRC = "src/assets/branding/flintgreenicon.svg";
const OUT = "docs/flint-icon-source.png";
const CANVAS = 1024;
const PAD = 154;
const INNER = CANVAS - 2 * PAD;

mkdirSync(dirname(OUT), { recursive: true });

await sharp(SRC, { density: 1200 })
  .resize({
    width: INNER,
    height: INNER,
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .extend({
    top: PAD,
    bottom: PAD,
    left: PAD,
    right: PAD,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toFile(OUT);

console.log(`wrote ${OUT} (${CANVAS}x${CANVAS}, inner ${INNER}px, pad ${PAD}px)`);
