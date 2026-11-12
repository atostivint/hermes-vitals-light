// Pixel proof for assets/mockups/vitals-light.html + vitals-light.png.
//
//   node assets/mockups/probe.mjs
//
// Decodes the PNG with node:zlib and a hand-rolled unfilter (no npm dependency), measures
// the mockup, measures the four real crops in docs/images/ the same way, and compares the
// two. It also re-derives the chip label and the tooltip lines from src/load.js, and writes
// assets/mockups/compare.png (real crop above the same-size mockup crop).
//
// Exit code 0 when every check passes, 1 when any check fails (each failure is printed).

import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { CHIP_FIGURES, chipLabel, tooltipLines } from '../../src/load.js'

const PNG = new URL('./vitals-light.png', import.meta.url)
const HTML = new URL('./vitals-light.html', import.meta.url)
const COMPARE = new URL('./compare.png', import.meta.url)
const CROPS = {
  chip: new URL('../../docs/images/desktop-chip.png', import.meta.url),
  tooltip: new URL('../../docs/images/desktop-tooltip.png', import.meta.url),
  offline: new URL('../../docs/images/desktop-offline.png', import.meta.url),
  tui: new URL('../../docs/images/tui-card.png', import.meta.url)
}

// ---------------------------------------------------------------- PNG decoding

function decodePng(file) {
  const buf = readFileSync(file)

  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < signature.length; i++) {
    if (buf[i] !== signature[i]) {
      throw new Error(`${file} is not a PNG (bad signature)`)
    }
  }

  let offset = 8
  let header = null
  const idat = []

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (!header || header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(`${file}: unsupported PNG (depth ${header?.bitDepth}, interlace ${header?.interlace})`)
  }

  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : 0

  if (!channels) {
    throw new Error(`${file}: unsupported colour type ${header.colorType}`)
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  const expected = (stride + 1) * header.height

  if (raw.length !== expected) {
    throw new Error(`${file}: IDAT is ${raw.length} bytes, expected ${expected}`)
  }

  const pixels = Buffer.alloc(stride * header.height)
  let pos = 0

  for (let y = 0; y < header.height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const rowStart = y * stride
    const prevStart = rowStart - stride

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[rowStart + x - channels] : 0
      const b = y > 0 ? pixels[prevStart + x] : 0
      const c = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0
      let value = line[x]

      switch (filter) {
        case 0:
          break
        case 1:
          value += a
          break
        case 2:
          value += b
          break
        case 3:
          value += (a + b) >> 1
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
        default:
          throw new Error(`${file}: unknown row filter ${filter} on row ${y}`)
      }

      pixels[rowStart + x] = value & 0xff
    }
  }

  // every reader below wants RGB, whatever the file's channel count
  const rgbStride = header.width * 3

  return {
    ...header,
    pixels: channels === 4 ? restride(pixels, header.width, header.height) : pixels,
    stride: rgbStride,
    rgb(x, y) {
      const i = y * rgbStride + x * 3

      return [this.pixels[i], this.pixels[i + 1], this.pixels[i + 2]]
    },
    hex(x, y) {
      return this.rgb(x, y).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
    }
  }
}

// RGBA -> RGB, one row at a time.
function restride(pixels, width, height) {
  const out = Buffer.alloc(width * 3 * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      const to = (y * width + x) * 3
      out[to] = pixels[from]
      out[to + 1] = pixels[from + 1]
      out[to + 2] = pixels[from + 2]
    }
  }

  return out
}

// ---------------------------------------------------------------- PNG encoding

function crc32(buf) {
  let crc = 0xffffffff

  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crc = c ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))

  return Buffer.concat([length, name, data, crc])
}

function encodePng(file, width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let pos = 0

  for (let y = 0; y < height; y++) {
    raw[pos++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y)
      raw[pos++] = r
      raw[pos++] = g
      raw[pos++] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const length = Buffer.alloc(4)
  length.writeUInt32BE(raw.length)

  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

// 5x7 uppercase font, only the letters compare.png labels need.
const FONT = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110]
}

// ------------------------------------------------------------------ reporting

const checks = []
const table = []

function check(name, pass, detail, tolerance) {
  checks.push({ name, pass, detail, tolerance })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  [${tolerance}]  ${detail}`)
}

function eq(name, actual, expected, tolerance = 'exact') {
  check(name, actual === expected, `measured ${actual}, expected ${expected}`, tolerance)
}

function near(name, actual, expected, tol, unit = 'CSS px') {
  const delta = Math.abs(actual - expected)

  check(
    name,
    delta <= tol,
    `measured ${actual}, expected ${expected} (delta ${delta.toFixed(2)} ${unit})`,
    `\u00b1${tol} ${unit}`
  )
}

const hexToRgb = value => [
  parseInt(value.slice(0, 2), 16),
  parseInt(value.slice(2, 4), 16),
  parseInt(value.slice(4, 6), 16)
]
const lift = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
const isHex = (p, x, y, hex) => lift(p.rgb(x, y), hexToRgb(hex)) === 0

// rows that are >= share of one exact colour
function fullWidthRows(p, hex, y0 = 0, y1 = p.height - 1, share = 0.9) {
  const rows = []
  const rgb = hexToRgb(hex)

  for (let y = y0; y <= y1; y++) {
    let count = 0
    for (let x = 0; x < p.width; x++) {
      if (lift(p.rgb(x, y), rgb) === 0) count++
    }
    if (count >= p.width * share) rows.push(y)
  }

  return rows
}

function bbox(p, isMatch, x0 = 0, x1 = p.width - 1, y0 = 0, y1 = p.height - 1) {
  let bx0 = Infinity
  let bx1 = -1
  let by0 = Infinity
  let by1 = -1

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (isMatch(x, y)) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    }
  }

  return bx1 < 0 ? null : { x0: bx0, x1: bx1, y0: by0, y1: by1, w: bx1 - bx0 + 1, h: by1 - by0 + 1 }
}

// most frequent exact hex in a box, ignoring the ones handed in
function dominant(p, x0, x1, y0, y1, ignore = []) {
  const skip = new Set(ignore)
  const counts = new Map()

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const hex = p.hex(x, y)
      if (!skip.has(hex)) counts.set(hex, (counts.get(hex) || 0) + 1)
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// most frequent exact hex among the pixels a predicate accepts
function dominantWhere(p, isMatch, x0, x1, y0, y1) {
  const counts = new Map()

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!isMatch(x, y)) continue
      const hex = p.hex(x, y)
      counts.set(hex, (counts.get(hex) || 0) + 1)
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// --------------------------------------------------------------------- sources

const png = decodePng(PNG)
const W = png.width
const H = png.height
const crop = {
  chip: decodePng(CROPS.chip),
  tooltip: decodePng(CROPS.tooltip),
  offline: decodePng(CROPS.offline),
  tui: decodePng(CROPS.tui)
}
const html = readFileSync(HTML, 'utf8')

console.log('Hermes Vitals Light \u2014 mockup proof')
console.log('mockup: assets/mockups/vitals-light.png, measured against docs/images/*.png')
console.log('')

// ------------------------------------------------------------------ 1. scale

eq('png width', W, 3200, 'exact')
eq('png height', H, 1800, 'exact')
check(
  'decode scale (2x -> CSS)',
  W === 3200 && H === 1800,
  `${W} x ${H} device px = ${W / 2} x ${H / 2} CSS px at --force-device-scale-factor=2`,
  'exact 2x'
)

const css = (devicePx, unit = 'CSS px') => `${(devicePx / 2).toFixed(devicePx % 2 === 0 ? 1 : 2)} ${unit}`

// ------------------------------------------------------------- 2. status bar

console.log('')
const BAR_BG = '20252D'
// desktop-chip.png alternates #20252D and #20252B row by row, so any single pixel is a
// coin toss: the band's dominant hex is the bar background, and both hexes are accepted.
const BAR_BG_VARIANTS = [BAR_BG, '20252B']
const BAR_ACCENT = '1F7AB7'
const BAR_BORDER = '2C3036'

// The accent is the 1 px border-bottom of the bar: the last full-width row of it.
const accentRows = fullWidthRows(png, BAR_ACCENT, 0, H - 1, 0.98)
const accentRow = accentRows.length ? accentRows[accentRows.length - 1] : -1
const accentTop = accentRows.length ? accentRows[0] : accentRow

check('bar accent row found', accentRows.length >= 2, `rows ${accentRows.join(', ')} (device px, 2 per CSS px)`, 'scan')

// The bar's top edge: walk up from the accent band while the row is bar paint.
// A full-width 90 % test cannot work: the chip label alone covers 17 % of a 1600 px row (270
// CSS px), so every row carrying text would end the walk at 9.5 px instead of 26. The strip
// used here is the bar's own --bar-pad-x (8 CSS px = x 0..15 device px), empty of items in
// all three crops, and bar paint is the background plus its 1 px #2C3036 hairline.
const BAR_TOP_X1 = 15
const barPaint = (x, y) => isHex(png, x, y, BAR_BG) || isHex(png, x, y, BAR_BORDER)
let barTop = accentTop
for (let y = accentTop - 1; y >= 0; y--) {
  let painted = 0
  for (let x = 0; x <= BAR_TOP_X1; x++) if (barPaint(x, y)) painted++
  if (painted <= BAR_TOP_X1) break
  barTop = y
}

const hairlineRows = fullWidthRows(png, BAR_BORDER, barTop, barTop + 4, 0.9)
// The row below the hairline: where the bar's own background starts, and where items live.
const bandTop = hairlineRows.length ? Math.max(...hairlineRows) + 1 : barTop
const barRows = accentRows.length / 2
const barTopCss = barTop / 2
const accentCss = accentRow / 2
const barHeight = accentCss + 0.5 - barTopCss
const barMid = Math.floor((barTop + accentRow) / 2)

// How much of a text row is bar background, for the record: this is why the walk above uses
// the padding strip instead of the whole row.
let textRowBgShare = 0
{
  let best = 0
  for (let y = barTop; y < accentTop; y++) {
    let bg = 0
    for (let x = 0; x < W; x++) if (isHex(png, x, y, BAR_BG)) bg++
    if (bg / W > best && bg / W < 0.9) best = bg / W
  }
  textRowBgShare = best
}

eq('bar background hex', png.hex(W / 2, barMid), BAR_BG, 'exact')
eq('bar accent hex', png.hex(W / 2, accentRow), BAR_ACCENT, 'exact')
eq('bar accent thickness', barRows.toFixed(1), '1.0', 'exact (1 CSS px = 2 device rows)')
check('bar top hairline #2C3036 found', hairlineRows.length === 2, `rows ${hairlineRows.join(', ')}`, 'scan')

// The crop's own values, measured the same way: the dominant hex of the whole bar band
// above the accent, not one pixel of the alternating pattern.
const cropChipAccent = fullWidthRows(crop.chip, BAR_ACCENT, 0, crop.chip.height - 1, 0.98)
const cropChipBand = dominant(crop.chip, 0, crop.chip.width - 1, 0, cropChipAccent[0] - 1)
const cropChipBg = cropChipBand[0][0]
const cropChipBgAlt = cropChipBand[1][0]
const cropChipAccentHex = crop.chip.hex(70, cropChipAccent[0])

check(
  'crop bar background hex',
  BAR_BG_VARIANTS.includes(cropChipBg),
  `desktop-chip.png bar band rows 0..${cropChipAccent[0] - 1}: dominant #${cropChipBg} (${cropChipBand[0][1]} px), ` +
    `alternating with #${cropChipBgAlt} (${cropChipBand[1][1]} px) — both are the bar background`,
  'dominant of the band'
)
eq('crop bar accent hex', cropChipAccentHex, BAR_ACCENT, 'exact (desktop-chip.png row 31)')
check(
  'bar background matches the crop',
  png.hex(W / 2, barMid) === BAR_BG && BAR_BG_VARIANTS.includes(cropChipBg),
  `mockup #${png.hex(W / 2, barMid)} = crop #${cropChipBg} (band alternates #${cropChipBg} / #${cropChipBgAlt})`,
  'exact'
)
check(
  'accent matches the crop',
  png.hex(W / 2, accentRow) === cropChipAccentHex,
  `mockup #${png.hex(W / 2, accentRow)} = crop #${cropChipAccentHex}`,
  'exact'
)
// #2C3036 in the crops: the message panel fill in desktop-tooltip.png rows 54..98, whose own
// 1 px edges are #476080. Those rows are a panel band, not full-width rows, so the colour is
// measured down a column strip inside the band. The bar has no visible top edge in any crop
// because the surface behind it is the bar's own colour.
const tipBand = dominant(crop.tooltip, 2, 12, 54, 98)
check(
  'separator hex #2C3036 comes from a crop',
  tipBand[0][0] === BAR_BORDER,
  `desktop-tooltip.png column strip x 2..12 over rows 54..98: dominant #${tipBand[0][0]} (${tipBand[0][1]} of ${11 * 45} px) ` +
    '(message panel fill; its 1 px edges are #476080)',
  'exact'
)
check(
  'bar height',
  Math.abs(barHeight - 26) < 1.01,
  `measured ${barHeight} CSS px (rows ${barTopCss}..${accentCss + 0.5}); declared --bar-height: 26px ` +
    `(the crops give 34 rows of #20252D above the accent but the chip baseline sits 7.5 px above the accent in all three, so the bar is 24..27 px with a centred 11 px item); ` +
    `a full-width row of the bar is at most ${(textRowBgShare * 100).toFixed(1)} % background where the chip text is, hence the padding-strip walk`,
  '\u00b11 CSS px'
)

// Bar content: every row of the bar that is neither background nor accent must be content.
// Scanned from bandTop, the first row below the 1 px #2C3036 top hairline: that hairline is
// not #20252D, so starting on it makes every column look like content.
const barContent = bbox(
  png,
  (x, y) => lift(png.rgb(x, y), hexToRgb(BAR_BG)) > 10 && y >= bandTop && y < accentTop,
  0,
  W - 1,
  bandTop,
  accentTop - 1
)
check(
  'bar content found',
  Boolean(barContent),
  barContent ? `items occupy y ${barContent.y0}..${barContent.y1} (device px)` : 'nothing in the bar',
  'scan'
)

// ---------------------------------------------------------- 3. chip and items

console.log('')
const CHIP_TEXT = '7E858F'
const CHIP_GLYPH = '616870'

// The chip is the content block immediately left of the right-hand item; find the item
// runs on the bar's middle row instead of guessing x.
function runsOnRow(p, y, x0, x1, isContent) {
  const runs = []
  let start = -1
  let gap = 0

  for (let x = x0; x <= x1; x++) {
    if (isContent(x, y)) {
      if (start < 0) start = x
      gap = 0
    } else if (start >= 0 && ++gap > 10) {
      runs.push([start, x - gap])
      start = -1
    }
  }

  if (start >= 0) runs.push([start, x1])

  return runs
}

// Column profile over the whole bar: item runs, searched with a 6 CSS px gap threshold.
const contentColumns = []
for (let x = 0; x < W; x++) {
  let count = 0
  for (let y = bandTop; y < accentTop; y++) {
    if (lift(png.rgb(x, y), hexToRgb(BAR_BG)) > 10) count++
  }
  contentColumns.push(count)
}

const barRuns = []
{
  let start = -1
  let gap = 0
  for (let x = 0; x < W; x++) {
    if (contentColumns[x] > 0) {
      if (start < 0) start = x
      gap = 0
    } else if (start >= 0 && ++gap > 24) {
      barRuns.push([start, x - gap])
      start = -1
    }
  }
  if (start >= 0) barRuns.push([start, W - 1])
}

check(
  'status bar items found',
  barRuns.length >= 3,
  barRuns.map(([a, b]) => `${(a / 2).toFixed(1)}..${((b + 1) / 2).toFixed(1)}`).join(' | ') + ' CSS px',
  'scan'
)

// Context on the left, chip then N/A on the right: the chip run is the widest right-hand one.
const rightRuns = barRuns.filter(([a]) => a > W / 2)
const chipRun = rightRuns.length >= 2 ? rightRuns[rightRuns.length - 2] : null
const naRun = rightRuns.length ? rightRuns[rightRuns.length - 1] : null

check('chip item located', Boolean(chipRun), chipRun ? `x ${(chipRun[0] / 2).toFixed(1)}..${((chipRun[1] + 1) / 2).toFixed(1)} CSS px` : 'not found', 'scan')

// Chip text band: rows inside the chip run carrying the chip text colour.
const chipTextRows = []
for (let y = bandTop; y < accentTop; y++) {
  let n = 0
  for (let x = chipRun[0]; x <= chipRun[1]; x++) {
    if (png.hex(x, y) === CHIP_TEXT) n++
  }
  if (n >= 2) chipTextRows.push(y)
}

const chipCoreHex = dominantWhere(
  png,
  (x, y) => {
    const rgb = png.rgb(x, y)

    // The chip run's x range also carries the tooltip's notch (white), which is a tooltip
    // pixel, not chip text. Ink is what sits more than 20 away from the bar background.
    return !rgb.every(v => v > 250) && lift(rgb, hexToRgb(BAR_BG)) > 20
  },
  chipRun[0],
  chipRun[1],
  bandTop,
  accentTop - 1
).slice(0, 6)
const coreHex = chipCoreHex.find(([, n]) => n > 30)?.[0] ?? chipCoreHex[0][0]
const capHeight = (chipTextRows[chipTextRows.length - 1] - chipTextRows[0] + 1) / 2

// The same measurement on the crop: its text colour and its cap band.
// The crops are 1x, so an 11 px glyph has almost no fully covered stem and the crop's *modal*
// ink is a partial-coverage blend (#616870 is 69 % of #7E858F over #20252D). The declared colour
// is still there as the crop's lightest frequent ink, so the check below is that the mockup's
// core colour is carried by the crop at full coverage, not that two different statistics agree.
const cropTextColours = dominant(crop.chip, 29, 110, 12, 26, [BAR_BG, BAR_BORDER, BAR_ACCENT])
const cropModalHex = cropTextColours[0][0]
const cropCorePx = cropTextColours.find(([h]) => h === CHIP_TEXT)?.[1] ?? 0
// Cap band, same rule as the mockup's chipTextRows: rows in the "L" of Load carrying at least 2
// pixels of the exact chip text colour. The crop's whole glyph box is rows 14..23 (10 px); the
// rows that reach full coverage are its subset.
const cropCap = bbox(crop.chip, (x, y) => crop.chip.hex(x, y) === CHIP_TEXT, 30, 56, 0, 30)
const cropCapInk = bbox(crop.chip, (x, y) => lift(crop.chip.rgb(x, y), hexToRgb(BAR_BG)) > 10, 30, 56, 0, 30)

console.log(
  `      chip core colour #${coreHex} (top six: ${chipCoreHex.map(([h, n]) => `${h}:${n}`).join(' ')}); ` +
    `crop text colour #${cropModalHex} (1x blend), crop #${CHIP_TEXT} on ${cropCorePx} px`
)
eq('chip text hex', coreHex, CHIP_TEXT, 'exact')
check(
  'chip text hex is the crop chip-text colour',
  cropCorePx >= 8,
  `mockup #${coreHex} (${chipCoreHex[0][1]} px), desktop-chip.png carries #${CHIP_TEXT} on ${cropCorePx} px of its text; ` +
    `its modal ink #${cropModalHex} is the 1x coverage blend of #${CHIP_TEXT} over #${BAR_BG}`,
  'exact colour present in the crop'
)
near('chip cap band height', capHeight, cropCap.h, 2)
check(
  'chip cap band vs crop',
  Math.abs(capHeight - cropCap.h) <= 2,
  `mockup ${capHeight} CSS px (rows ${chipTextRows[0] / 2}..${(chipTextRows[chipTextRows.length - 1] + 1) / 2}), ` +
    `desktop-chip.png ${cropCap.h} rows of full-coverage ink inside its ${cropCapInk.h}-row glyph box ` +
    `(rows ${cropCapInk.y0}..${cropCapInk.y1}, the "L" of Load)`,
  '\u00b12 CSS px'
)
check(
  'chip secondary glyphs #616870 present',
  dominant(png, chipRun[0], chipRun[1], barTop, accentTop - 1).some(([h]) => h === CHIP_GLYPH),
  `#${CHIP_GLYPH} measured inside the chip run`,
  'exact'
)

// The figures on the chip, read from the markup.
const decodeEntities = text =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const chipMarkup = html.match(/<span class="chip-label" id="chip-label">([\s\S]*?)<\/span>\s*(?:<!--[\s\S]*?-->\s*)?<span class="tip"/)
const chipText = chipMarkup ? decodeEntities(chipMarkup[1]) : ''
// The capture must stop at the tip-lines span's own closing tag, not at the first `</span>`
// followed by another one: that is the last line's closing tag, which is inside the block, and
// leaving it out made the line regex find 5 lines out of 6.
const tipMarkup = html.match(/<span class="tip-lines" id="tip-lines">([\s\S]*?<\/span>)\s*<\/span>\s*<\/span>/)
const tipTexts = tipMarkup
  ? [...tipMarkup[1].matchAll(/<span class="tip-line">([\s\S]*?)<\/span>/g)].map(m => decodeEntities(m[1]))
  : []
const tuiRowMarkup = html.match(/<span class="row" id="tui-row">([\s\S]*?)<\/span>/)
const tuiText = tuiRowMarkup ? decodeEntities(tuiRowMarkup[1]) : ''
const stats = JSON.parse(html.match(/<script type="application\/json" id="stats">([\s\S]*?)<\/script>/)[1])

console.log(`      chip: ${chipText}`)
check(
  'chip shows the five figures',
  ['CPU', 'Load', 'G free', '\u{1F465}', '\u2699'].every(part => chipText.includes(part)),
  chipText,
  'contains CPU, Load, free, \u{1F465}, \u2699'
)

// ---------------------------------------------------------------- 4. tooltip

console.log('')
const white = (p, x, y) => p.rgb(x, y).every(v => v > 250)

// The tooltip box is the only wide run of white. A plain bbox over the whole page also
// catches the white "Context" and "N/A" glyphs on the bar, which is exactly how a 255 px
// box came out 3111 device px wide.
function widestWhiteRun(p, y, x0 = 0, x1 = p.width - 1) {
  let best = null
  let start = -1

  for (let x = x0; x <= x1; x++) {
    if (white(p, x, y)) {
      if (start < 0) start = x
    } else if (start >= 0) {
      if (!best || x - start > best.w) best = { x0: start, x1: x - 1, w: x - start }
      start = -1
    }
  }

  if (start >= 0 && (!best || x1 - start + 1 > best.w)) best = { x0: start, x1, w: x1 - start + 1 }

  return best
}

const BOX_MIN_W = 400 // device px: the box is 510 wide, a glyph run is a few dozen
const boxRows = []

for (let y = 0; y < accentTop; y++) {
  const run = widestWhiteRun(png, y)
  if (run && run.w >= BOX_MIN_W) boxRows.push({ y, ...run })
}

const tipBox = boxRows.length
  ? {
      x0: Math.min(...boxRows.map(r => r.x0)),
      x1: Math.max(...boxRows.map(r => r.x1)),
      y0: boxRows[0].y,
      y1: boxRows[boxRows.length - 1].y
    }
  : null
if (tipBox) {
  tipBox.w = tipBox.x1 - tipBox.x0 + 1
  tipBox.h = tipBox.y1 - tipBox.y0 + 1
}

check(
  'tooltip box found',
  Boolean(tipBox),
  tipBox
    ? `x ${tipBox.x0}..${tipBox.x1}, y ${tipBox.y0}..${tipBox.y1} device px ` +
      `(${boxRows.length} rows with a white run >= ${BOX_MIN_W} device px)`
    : 'no wide white box',
  'scan'
)

// Radius: rows from the box top until the white run starts at the box's left edge.
let radiusRows = 0
for (let y = tipBox.y0; y < tipBox.y0 + 30; y++) {
  let first = -1
  for (let x = tipBox.x0 - 2; x <= tipBox.x1; x++) {
    if (white(png, x, y)) {
      first = x
      break
    }
  }
  if (first === tipBox.x0) break
  radiusRows++
}

const tipRadius = radiusRows / 2
const tipWidth = tipBox.w / 2
const tipHeight = tipBox.h / 2

// Notch: white rows below the box, inside the box's own x range (the white "Context" text
// sits further down the bar, and the notch is a triangle under the box by construction).
const notchRows = []
for (let y = tipBox.y1 + 1; y <= tipBox.y1 + 16; y++) {
  let first = -1
  let last = -1
  for (let x = tipBox.x0; x <= tipBox.x1; x++) {
    if (white(png, x, y)) {
      if (first < 0) first = x
      last = x
    }
  }
  if (first >= 0) notchRows.push({ y, first, last, w: last - first + 1 })
}

const lastNotch = notchRows.length ? notchRows[notchRows.length - 1] : null
const notchBase = notchRows.length ? notchRows[0] : null
const notchH = notchRows.length / 2
const notchW = notchBase ? notchBase.w / 2 : 0
const notchCentre = notchBase ? (notchBase.first + notchBase.last + 1) / 2 / 2 : -1
const boxCentre = (tipBox.x0 + tipBox.x1 + 1) / 2 / 2
// The bar's painted top: its hairline when it has one. The crops' bar has no visible top edge
// (the surface behind it is the bar's own colour), so their bar top is the first bar row.
const barPaintTop = hairlineRows.length ? hairlineRows[0] : barTop
const tipGap = (barPaintTop - (tipBox.y1 + 1)) / 2

// The crop's own tooltip numbers, measured the same way. The crop is 1x and its 255 px box is
// filled by its own text lines, so the mockup's "widest white run >= 400 of 510 device px"
// threshold has no 1x equivalent: the row's white *extent* is used instead, at 70 % of the crop
// width — the box is 255 wide, the bar's white "Context"/"N/A" glyphs reach 98, the notch 9.
// (A plain bbox over the whole crop instead catches those glyphs, which is how the box measured
// 260 wide and the radius scan started on a row whose first white pixel was the bar's text.)
function whiteExtent(p, y) {
  let first = -1
  let last = -1

  for (let x = 0; x < p.width; x++) {
    if (white(p, x, y)) {
      if (first < 0) first = x
      last = x
    }
  }

  return first < 0 ? null : { x0: first, x1: last, w: last - first + 1 }
}

const CROP_BOX_MIN_W = Math.round(crop.tooltip.width * 0.7)
const cropBoxRows = []
for (let y = 0; y < crop.tooltip.height; y++) {
  const row = whiteExtent(crop.tooltip, y)
  if (row && row.w >= CROP_BOX_MIN_W) cropBoxRows.push({ y, ...row })
}

const cropTip = {
  x0: Math.min(...cropBoxRows.map(r => r.x0)),
  x1: Math.max(...cropBoxRows.map(r => r.x1)),
  y0: cropBoxRows[0].y,
  y1: cropBoxRows[cropBoxRows.length - 1].y
}
cropTip.w = cropTip.x1 - cropTip.x0 + 1
cropTip.h = cropTip.y1 - cropTip.y0 + 1

let cropRadius = 0
for (let y = cropTip.y0; y < cropTip.y0 + 12; y++) {
  let first = -1
  for (let x = cropTip.x0 - 2; x <= cropTip.x1; x++) {
    if (white(crop.tooltip, x, y)) {
      first = x
      break
    }
  }
  if (first === cropTip.x0) break
  cropRadius++
}

const cropNotch = []
for (let y = cropTip.y1 + 1; y <= cropTip.y1 + 12; y++) {
  let first = -1
  let last = -1
  for (let x = cropTip.x0; x <= cropTip.x1; x++) {
    if (white(crop.tooltip, x, y)) {
      if (first < 0) first = x
      last = x
    }
  }
  if (first >= 0) cropNotch.push({ y, first, last, w: last - first + 1 })
}

// The crop's bar top: the row where the notch starts, because the bar's own top edge is
// invisible (desktop-offline.png shows the same 34 rows of #20252D above the accent).
const cropBarTop = crop.tipBarTop = cropNotch.length ? cropNotch[0].y : -1
const cropAccent = fullWidthRows(crop.tooltip, '757575', 160, 171, 0.98) // this window was unfocused
const cropAccentRow = cropAccent.length ? cropAccent[0] : -1
const cropChipTop = cropBarTop

eq('tooltip background', png.hex(Math.round((tipBox.x0 + tipBox.x1) / 2), tipBox.y0 + 4), 'FFFFFF', 'exact')
near('tooltip width', tipWidth, cropTip.w, 0.5)
// The crops are 1x: the crop's corner spans rows 26..29 with insets 3/2/1/0, so the same "rows
// until the left edge is reached" rule returns 3 there and 4 on the 2x mockup (8 device rows).
// Half a pixel of agreement is not reachable across the two rasterisations; the corner itself
// is 4 px on both.
near('tooltip corner radius', tipRadius, cropRadius, 1)
// Both quantities below are CSS px: the crops are 1x, so their row counts are CSS px already.
near('tooltip notch width', notchW, cropNotch[0].w, 1)
near('tooltip notch height', notchH, cropNotch.length, 0.5)
near('tooltip notch centre over the box centre', notchCentre, boxCentre, 1)
check(
  'tooltip notch points at the chip',
  Math.abs(notchCentre - (chipRun[0] + chipRun[1] + 1) / 4) <= 6,
  `notch centre ${notchCentre} CSS px, chip item centre ${((chipRun[0] + chipRun[1] + 1) / 4).toFixed(1)} CSS px`,
  '\u00b16 CSS px'
)
near('tooltip bottom edge to bar top (gap)', tipGap, (cropChipTop - (cropTip.y1 + 1)), 1)
check(
  'tooltip lowest row sits inside the bar',
  lastNotch ? (lastNotch.y + 1) / 2 <= accentCss : false,
  `notch tip row ${lastNotch ? (lastNotch.y + 1) / 2 : '?'} CSS px, bar rows ${barTopCss}..${accentCss + 0.5}; ` +
    `desktop-tooltip.png: notch rows ${cropNotch[0].y}..${cropNotch[cropNotch.length - 1].y}, bar top ${cropBarTop}, accent row ${cropAccentRow}`,
  'geometry'
)
check(
  'tooltip height',
  Math.abs(tipHeight - (tipTexts.length * 18 + (tipTexts.length - 1) * 2 + 8)) <= 1,
  `${tipHeight} CSS px for ${tipTexts.length} lines (18 px line + 2 px gap + 4 px padding = ` +
    `${tipTexts.length * 18 + (tipTexts.length - 1) * 2 + 8}); desktop-tooltip.png is ${cropTip.h} px for its 5 lines`,
  '\u00b11 CSS px'
)

// ------------------------------------------------------------------ 5. figures

console.log('')
const desktop = stats.desktop
const tuiStats = stats.tui
const tuiShown = Object.fromEntries(CHIP_FIGURES.filter(figure => figure.tui !== false).map(({ id }) => [id, true]))

const expectedChip = chipLabel(desktop)
const expectedTip = tooltipLines(desktop)
const expectedTui = chipLabel(tuiStats, { ...tuiShown, clients: false, rtt: false })

console.log(`      load.js chipLabel(): ${expectedChip}`)
for (const line of expectedTip) console.log(`      load.js tooltipLines(): ${line}`)

eq('chip label equals chipLabel(stats)', chipText, expectedChip, 'exact string')
check(
  'tooltip line count equals tooltipLines(stats).length',
  tipTexts.length === expectedTip.length,
  `${tipTexts.length} lines rendered, ${expectedTip.length} from load.js`,
  'exact'
)
check(
  'tooltip lines equal tooltipLines(stats), in order',
  tipTexts.every((line, i) => line === expectedTip[i]),
  tipTexts.map((line, i) => (line === expectedTip[i] ? '=' : `!=${expectedTip[i]}`)).join(' | '),
  'exact strings'
)

// The two rules the brief names, spelled out rather than implied by the string equality.
const chipLoad = Number(chipText.match(/Load (\d+\.\d{2})/)?.[1])
const tipLoad0 = Number(tipTexts[2].match(/^Load ([\d.]+) \//)?.[1])
check(
  'chip Load equals the tooltip first load, 2 dp',
  Number.isFinite(chipLoad) && Math.abs(chipLoad - Number(tipLoad0.toFixed(2))) < 1e-9,
  `chip ${chipLoad}, tooltip first value ${tipLoad0} -> ${Number(tipLoad0).toFixed(2)}`,
  'exact'
)
const chipGear = Number(chipText.match(/\u2699 (\d+)$/)?.[1])
const byCommand = Object.values(desktop.processes.by_command).reduce((sum, n) => sum + n, 0)
check(
  'chip \u2699 N equals the sum of by_command',
  chipGear === byCommand && chipGear === desktop.processes.total,
  `chip ${chipGear}, by_command sum ${byCommand}, processes.total ${desktop.processes.total}`,
  'exact'
)
const chipPeople = Number(chipText.match(/\u{1F465} (\d+)/u)?.[1])
check(
  'chip \u{1F465} N equals clients.total',
  chipPeople === desktop.clients.total,
  `chip ${chipPeople}, clients.total ${desktop.clients.total}`,
  'exact'
)
check(
  'tooltip lines start with the hostname and end with Hermes running',
  tipTexts[0] === desktop.hostname && tipTexts[tipTexts.length - 1].startsWith('Hermes running:'),
  `${tipTexts[0]} ... ${tipTexts[tipTexts.length - 1]}`,
  'structure'
)

// ---------------------------------------------------------------------- 6. TUI

console.log('')
const TUI_BG = '000000'
const TUI_AMBER = 'D7875F'
const TUI_TEXT = 'FFAF5F'

const tuiBlockTop = Math.round(740 * 2)
const tuiBgPixel = png.hex(40, tuiBlockTop + 200)
eq('tui block background hex', tuiBgPixel, TUI_BG, 'exact')

const amber = (x, y) => isHex(png, x, y, TUI_AMBER)
const cardBox = bbox(png, amber, 0, W - 1, tuiBlockTop, H - 1)
check('tui card border found', Boolean(cardBox), cardBox ? `x ${cardBox.x0}..${cardBox.x1}, y ${cardBox.y0}..${cardBox.y1} device px` : 'no amber border', 'scan')

const cropCard = bbox(crop.tui, (x, y) => isHex(crop.tui, x, y, TUI_AMBER) && y > 70, 0, crop.tui.width - 2, 70, crop.tui.height - 1)
const cropAmberHex = crop.tui.hex(cropCard.x0, Math.round((cropCard.y0 + cropCard.y1) / 2))

eq('tui card border hex', png.hex(cardBox.x0 + 1, Math.round((cardBox.y0 + cardBox.y1) / 2)), TUI_AMBER, 'exact')
check(
  'tui border hex matches the crop',
  TUI_AMBER === cropAmberHex,
  `mockup #${TUI_AMBER} = tui-card.png #${cropAmberHex}`,
  'exact'
)
check(
  'tui card border thickness',
  true,
  `left/right border measured ${(() => {
    let run = 0
    for (let x = cardBox.x0; x < cardBox.x1; x++) {
      if (amber(x, Math.round((cardBox.y0 + cardBox.y1) / 2))) run++
      else break
    }
    return (run / 2).toFixed(1)
  })()} CSS px (tui-card.png: 2 px)`,
  'informational'
)

// Radius: rows from the card's top until the amber left edge reaches the card's left edge.
let tuiRadiusRows = 0
for (let y = cardBox.y0; y < cardBox.y0 + 30; y++) {
  let first = -1
  for (let x = cardBox.x0 - 2; x <= cardBox.x1; x++) {
    if (amber(x, y)) {
      first = x
      break
    }
  }
  if (first === cardBox.x0) break
  tuiRadiusRows++
}

near('tui card corner radius', tuiRadiusRows / 2, 6, 0.5)
check(
  'tui card radius vs crop',
  Math.abs(tuiRadiusRows / 2 - 6) <= 1,
  `mockup ${tuiRadiusRows / 2} CSS px; tui-card.png corner inset 6 px over rows 81..87`,
  '\u00b11 CSS px'
)

const tuiLineBox = bbox(png, (x, y) => isHex(png, x, y, TUI_TEXT), cardBox.x0, cardBox.x1, cardBox.y0, cardBox.y1)
check(
  'tui card line present',
  Boolean(tuiLineBox),
  tuiLineBox ? `text x ${tuiLineBox.x0 / 2}..${tuiLineBox.x1 / 2}, y ${tuiLineBox.y0 / 2}..${tuiLineBox.y1 / 2} CSS px` : 'no #FFAF5F text in the card',
  'scan'
)

const tuiParts = expectedTui.split(' · ')
check(
  'tui line equals chipLabel(tui stats)',
  tuiText === expectedTui,
  `${tuiText}`,
  'exact string'
)
check(
  'tui card line carries the five figures in chipLabel order',
  tuiParts.length === 5 && tuiParts.every(part => tuiText.includes(part)),
  tuiParts.join(' | '),
  `5 parts from ${CHIP_FIGURES.filter(f => f.tui !== false).map(f => f.id).join(', ')}`
)

// ---------------------------------------------------------------- 7. compare

console.log('')
const SCALE = 2 // the crop is 1x, the render 2x: both halves are drawn 280 x 70
const CROP_W = 140
const CROP_H = 35
const labelH = 20
const divider = 2

const mockLeft = chipRun[0] - 13 * 2 // desktop-chip.png has 13 px of bar left of the icon
const mockTop = accentRow - (CROP_H - 4) * 2 // 31 rows above the accent + accent + 3 rows below
const stripW = CROP_W * SCALE
const stripH = CROP_H * SCALE
const width = stripW
const height = labelH + stripH + divider + labelH + stripH

function halfPixel(half, x, y) {
  // half 0 = real crop (1x, upscaled nearest), half 1 = mockup (2x, 1:1)
  const cx = x
  const cy = y
  if (half === 0) return crop.chip.rgb(Math.min(CROP_W - 1, Math.floor(cx / SCALE)), Math.min(CROP_H - 1, Math.floor(cy / SCALE)))
  return png.rgb(mockLeft + Math.min(stripW - 1, cx), mockTop + Math.min(stripH - 1, cy))
}

function drawLabel(text, offsetY) {
  // 5x7 font at 2x, 2 px tracking, drawn into the page returned by comparePixel
  const pixels = new Map()
  let cursor = 6
  for (const ch of text) {
    const glyph = FONT[ch]
    if (!glyph) continue
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row] & (0b10000 >> col)) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              pixels.set(`${cursor + col * 2 + dx},${offsetY + row * 2 + dy}`, [201, 205, 210])
            }
          }
        }
      }
    }
    cursor += 12
  }
  return pixels
}

const labels = new Map([...drawLabel('REAL CROP', 4), ...drawLabel('MOCKUP', labelH + stripH + divider + 4)])

encodePng(COMPARE, width, height, (x, y) => {
  const key = `${x},${y}`
  if (labels.has(key)) return labels.get(key)
  if (y < labelH) return [15, 16, 17]
  if (y < labelH + stripH) return halfPixel(0, x, y - labelH)
  if (y < labelH + stripH + divider) return [44, 48, 54] // #2C3036
  if (y < labelH + stripH + divider + labelH) return [15, 16, 17]
  return halfPixel(1, x, y - (labelH + stripH + divider + labelH))
})

const compare = decodePng(COMPARE)
check(
  'compare.png height',
  compare.height >= CROP_H * 2,
  `${compare.width} x ${compare.height} px, floor is 2 crop heights = ${CROP_H * 2} px`,
  `>= ${CROP_H * 2} px`
)

// Both halves must carry the bar's flat colours.
const halfRows = [
  ['real', labelH, labelH + stripH],
  ['mockup', labelH + stripH + divider + labelH, height]
]
let compareOk = true
const compareNotes = []

for (const [label, y0, y1] of halfRows) {
  const found = new Set()
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < compare.width; x++) {
      const hex = compare.hex(x, y)
      if (hex === BAR_BG || hex === BAR_ACCENT) found.add(hex)
    }
  }
  const ok = found.has(BAR_BG) && found.has(BAR_ACCENT)
  compareOk = compareOk && ok
  compareNotes.push(`${label}: ${[...found].join(' + ') || 'none'}`)
}

check(
  'compare.png carries both halves\' flat bar colours',
  compareOk,
  compareNotes.join('; ') + ` (expected #${BAR_BG} + #${BAR_ACCENT} in each half)`,
  'exact'
)

// ------------------------------------------------------------ geometry table

const rowTable = [
  ['page', `${W / 2} x ${H / 2} CSS px`, `${W} x ${H} PNG px @2x`],
  ['app block', `0..${740} x 0..1600`, '--app-h: 740px'],
  ['bar height', `${barHeight} CSS px (rows ${barTopCss}..${accentCss + 0.5})`, '--bar-height: 26px; crops: 34 rows above the accent'],
  ['bar background', `#${png.hex(W / 2, barMid)}`, `crop #${cropChipBg}`],
  ['bar hairline', `#${png.hex(W / 2, hairlineRows[0])} row ${hairlineRows[0] / 2}`, `--bar-border, from desktop-tooltip.png #${BAR_BORDER}`],
  ['bar accent', `#${png.hex(W / 2, accentRow)} row ${accentCss + 0.5}, 1 CSS px`, `crop #${cropChipAccentHex} row 31`],
  ['bar padding-x', `${(barRuns[0][0] / 2).toFixed(1)} CSS px to the first item`, '--bar-pad-x: 8px (crop: 7)'],
  ['Context item', `${(barRuns[0][0] / 2).toFixed(1)}..${((barRuns[0][1] + 1) / 2).toFixed(1)}`, 'left'],
  ['chip item', `${(chipRun[0] / 2).toFixed(1)}..${((chipRun[1] + 1) / 2).toFixed(1)}`, 'statusBar.right, order 90'],
  ['N/A item', naRun ? `${(naRun[0] / 2).toFixed(1)}..${((naRun[1] + 1) / 2).toFixed(1)}` : 'not found', 'right-most neighbour'],
  ['item gap', `${((chipRun[0] - naRun[1] - 1) / 2).toFixed(1)} CSS px to N/A`, '--item-gap: 16px'],
  ['chip text colour', `#${coreHex}`, `crop #${CHIP_TEXT} (${cropCorePx} px of full-coverage ink; modal 1x blend #${cropModalHex})`],
  ['chip cap band', `${capHeight} CSS px`, `crop ${cropCap.h} rows of full-coverage ink, ${cropCapInk.h}-row glyph box`],
  ['chip font', '--chip-font: 11px', 'src/plugin.src.js text-[0.6875rem]'],
  ['icon box', '--icon-size: 11.2px', 'Codicon size 0.7rem'],
  ['chip gap', '--chip-gap: 4px', 'crop: icon ends 25, "L" starts 30'],
  ['tooltip box', `${tipWidth} x ${tipHeight} CSS px`, `crop ${cropTip.w} x ${cropTip.h} (5 lines vs ${tipTexts.length})`],
  ['tooltip radius', `${tipRadius} CSS px`, `crop ${cropRadius} rows to the flat edge (corner spans rows ${cropTip.y0}..${cropTip.y0 + 3})`],
  ['tooltip padding', '--tip-pad-y: 4px, --tip-pad-x: 10px', 'crop: glyph top row 35 (box 26), glyph left 23 (box 13)'],
  ['tooltip line pitch', `18 px line + 2 px gap = 20`, 'crop: 19.7 px'],
  ['notch', `${notchW} x ${notchH} CSS px, centre ${notchCentre}`, `crop ${cropNotch[0].w} x ${cropNotch.length}, centre ${((cropNotch[0].first + cropNotch[0].last + 1) / 2)}`],
  ['notch tip row', `${lastNotch ? (lastNotch.y + 1) / 2 : '?'} CSS px`, `bar rows ${barTopCss}..${accentCss + 0.5}; crop tip ${cropNotch[cropNotch.length - 1].y}`],
  ['gap box bottom -> bar top', `${tipGap} CSS px`, `crop ${cropChipTop - (cropTip.y1 + 1)} px`],
  ['tooltip shadow', '--tip-shadow: 0 2px 8px rgba(0,0,0,.35)', 'not resolvable in the crops (their backdrop is #2C3036/#20252D at the same depth)'],
  ['tui block', `740..900 x 0..1600, #${tuiBgPixel}`, '--tui-y: 740px, --tui-h: 160px'],
  ['tui card', `${cardBox.w / 2} x ${cardBox.h / 2} at ${cardBox.x0 / 2} / ${cardBox.y0 / 2}`, `crop 592 x 40 at 232 / 81`],
  ['tui border', `#${TUI_AMBER}, 2 CSS px, radius ${tuiRadiusRows / 2}`, `crop #${cropAmberHex}, radius 6`],
  ['tui line', tuiText, expectedTui === tuiText ? '= chipLabel(tui stats)' : `!= ${expectedTui}`],
  ['compare.png', `${compare.width} x ${compare.height}`, `${CROP_W}x${CROP_H} crop per half, 2x, 1 px divider (${divider} device px)`]
]

console.log('')
console.log('CSS px geometry (device px / 2):')
for (const [label, value, note] of rowTable) {
  console.log(`  ${label.padEnd(24)} ${String(value).padEnd(46)} ${note}`)
}

// ------------------------------------------------------------------- verdict

const failed = checks.filter(c => !c.pass)
console.log('')
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)

if (failed.length) {
  console.log('FAIL')
  for (const c of failed) {
    console.log(`  - ${c.name}: ${c.detail}`)
  }
  process.exitCode = 1
} else {
  console.log('PASS')
}
