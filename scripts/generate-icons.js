const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUT = path.join(__dirname, "..", "public", "icons");
const BG = "#12110F";
const FG = "#f5efe6";

const GLYPH = {
  d: "M248-182.20Q248-162 239.10-145.80Q230.20-129.60 213.90-119.10Q197.60-108.60 175-104.60Q171-104 166.80-103.50Q162.60-103 158.20-102.70Q153.80-102.40 149.20-102.40Q133.40-102.40 121.70-104.40Q110-106.40 101.10-110.30Q92.20-114.20 85-120L86.80-123Q93.60-117.40 101.20-114.20Q108.80-111 117.20-109.60Q125.60-108.20 134.60-108.20Q160.40-108.20 176-125.80Q191.60-143.40 191.60-179.60Q191.60-207.60 181.30-229.40Q171-251.20 153.40-263.70Q135.80-276.20 113.60-276.20L96-276.20L96-13.40Q96-9.60 97.80-7.80Q99.60-6 103.80-5.20L120-2.80Q121.20-2.60 121.80-2.30Q122.40-2 122.40-1.20Q122.40 0 120.40 0L15.60 0Q14.60 0 14.10-0.40Q13.60-0.80 13.60-1.20Q13.60-2.40 16-2.80L32.20-5.20Q36.40-6 38.20-7.80Q40-9.60 40-13.40L40-269.20Q40-271.60 38.10-272.90Q36.20-274.20 32.20-274.80L16-277.20Q13.60-277.60 13.60-278.80Q13.60-279.20 14.10-279.60Q14.60-280 15.60-280L113.40-280Q155.60-280 185.70-267.90Q215.80-255.80 231.90-233.80Q248-211.80 248-182.20M187.20-18.20L136.40-106L188.60-112L246.40-15.60Q250.60-9 255.30-6.60Q260-4.20 266-2.80Q267.20-2.40 267.80-2.20Q268.40-2 268.40-1.20Q268.40-0.80 267.90-0.40Q267.40 0 266.40 0L174.60 0Q172.80 0 172.80-1.20Q172.80-2 173.40-2.20Q174-2.40 175.20-2.80L183.60-4.40Q188.60-6 189.70-9Q190.80-12 187.20-18.20",
  x1: 13.6,
  y1: -280,
  x2: 268.4,
  y2: 0,
};

const VB = 512;

function glyphTransform() {
  const target = 300;
  const scale = target / (GLYPH.y2 - GLYPH.y1);
  const tx = VB / 2 - ((GLYPH.x1 + GLYPH.x2) / 2) * scale;
  const ty = VB / 2 - ((GLYPH.y1 + GLYPH.y2) / 2) * scale;
  return `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(5)})`;
}

function iconSvg({ radius = 128, background = BG, glyph = FG } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VB}" height="${VB}" viewBox="0 0 ${VB} ${VB}">
<rect width="${VB}" height="${VB}" rx="${radius}" fill="${background}"/>
<g transform="${glyphTransform()}"><path d="${GLYPH.d}" fill="${glyph}"/></g>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  fs.writeFileSync(path.join(OUT, "favicon.svg"), iconSvg() + "\n");

  const png = (name, size, svg) =>
    sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(OUT, name));

  await png("favicon-32.png", 32, iconSvg());
  await png("apple-touch-icon.png", 180, iconSvg({ radius: 0 }));
  await png("icon-192.png", 192, iconSvg());
  await png("icon-512.png", 512, iconSvg());
  await png("maskable-512.png", 512, iconSvg({ radius: 0 }));

  console.log("Icons written to", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
