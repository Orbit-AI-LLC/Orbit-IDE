// Orbit family mark renderer.
//
// The Orbit apps' marks share one idea: the app's own object (a spark, an
// envelope, a calendar page, a speech bubble, the code sign, a rocket,
// a planet, a globe) in white on its own colour, with a tilted
// orbit round it and a moon riding the orbit at the top right. The orbit
// passes behind the object above and in front of it below, with a clear gap
// wherever the two cross, so every mark reads as something in orbit. Orbit
// IDE's and Orbit Browser's objects are drawn in line, and the orbit is part
// of them: the code sign's slash, the globe's equator. Orbit IDE's is drawn
// in bright cyan and violet on a dark editor's tile rather than in white.
// Orbit Pass keeps its own mark (the flat ring, moon and keyhole on
// black), which this file doesn't draw; Orbit Authenticator, its companion,
// takes Pass's flat ring and moon instead of the tilted orbit: the ring is the
// code's countdown, a quarter gone, round a shield with a check, on the app's
// strong blue.
//
// This one file is the same in every Orbit repository that ships one of
// these marks (Orbit AI, Orbit Browser, Orbit Chat, Orbit IDE, Orbit Mail,
// Orbit Mission Control, Orbit Pass for Orbit Authenticator, and the Orbit
// Website), so the family is designed in one place. Each repository's
// scripts/build_icon.py compiles it and writes that app's icons. Edit the
// geometry or the colours here, copy the file to the other repositories, and
// re-run their build_icon.py; never edit the outputs.
//
// Build (the toolchain compiler is enough, no Xcode licence needed):
//
//   TC=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin
//   SDK=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
//   $TC/swiftc -sdk $SDK -O -o /tmp/orbitmark scripts/orbitmark.swift
//
// Usage:
//
//   orbitmark png <mark> <out.png> <width>[x<height>] <layout> [small|tiny] [opaque]
//   orbitmark svg <mark> <layout> <width>[x<height>] [small|tiny]   an SVG document, on stdout
//   orbitmark path <mark> <box> <fill> [small|tiny]                 bare path data in a box-unit square
//   orbitmark colour <mark>                                         the mark's one flat colour
//
//   mark     ai | mail | calendar | chat | ide | control | orbit | browser | authenticator
//   layout   bleed    the colour square, edge to edge (iOS app icons, touch icons)
//            mac      the macOS icon grid: an 824/1024 tile with 185/1024 corners
//            tile     a rounded tile over the whole canvas (favicons, in-app marks)
//            colour   the bare mark in its own colours, no tile (logos on pages)
//            black | white | current   the bare mark in one ink (current is
//                     currentColor, SVG only)
//            dark     iOS's dark icon: the mark in its colours on nothing
//            tinted   iOS's tinted icon: the mark in white on nothing
//   small    bolder: a thicker orbit, a bigger moon, fewer details (48 px and under)
//   tiny     the object alone, without its orbit (16 px)
//   opaque   no alpha channel (the App Store icon)
//
// A bare layout given only a width gets the mark's own proportions.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

typealias P = CGPoint
let D = CGFloat.pi / 180
let cs = CGColorSpace(name: CGColorSpace.sRGB)!

// MARK: - Shapes, in a 1024 box with y running down (as in SVG)

func disc(_ c: P, _ r: CGFloat) -> CGPath { CGPath(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r), transform: nil) }
func rrect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> CGPath {
    CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil)
}
func line(_ pts: [P]) -> CGPath { let p = CGMutablePath(); p.addLines(between: pts); return p }
func stroked(_ p: CGPath, _ w: CGFloat) -> CGPath { p.copy(strokingWithWidth: w, lineCap: .round, lineJoin: .round, miterLimit: 4) }
func grown(_ p: CGPath, _ g: CGFloat) -> CGPath { p.union(stroked(p, 2 * g)) }
func dist(_ a: P, _ b: P) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }
func moved(_ p: CGPath, _ t: CGAffineTransform) -> CGPath { var t = t; return p.copy(using: &t)! }
func turned(_ p: CGPath, about c: P, by deg: CGFloat) -> CGPath {
    moved(p, CGAffineTransform(translationX: c.x, y: c.y).rotated(by: deg * D).translatedBy(x: -c.x, y: -c.y))
}

enum Detail { case full, small, tiny }

// MARK: - The orbit: a tilted ellipse with a moon riding it

struct Orbit {
    var c = P(x: 512, y: 512)
    var rx: CGFloat = 380, ry: CGFloat = 116
    var tilt: CGFloat = -22      // degrees; negative rises to the right
    var w: CGFloat = 40          // ring width
    var moonAt: CGFloat = -12    // where the moon sits: 0 is the right end, negative the far side
    var moonR: CGFloat = 46
    var gap: CGFloat = 22        // the clearance the ring keeps from the moon and the object

    func at(_ t: CGFloat) -> P {
        let x = rx * cos(t * D), y = ry * sin(t * D), a = tilt * D
        return P(x: c.x + x * cos(a) - y * sin(a), y: c.y + x * sin(a) + y * cos(a))
    }
    var moon: P { at(moonAt) }
    /// The ring's centre line, from just past the moon all the way round to just before it.
    var centreline: CGPath {
        let clear = moonR + gap + w / 2
        var t0 = moonAt; while dist(at(t0), moon) < clear { t0 += 0.05 }
        var t1 = moonAt + 360; while dist(at(t1), moon) < clear { t1 -= 0.05 }
        // A unit circle's arc, squashed and tilted, so the path keeps true curves.
        let p = CGMutablePath()
        p.addArc(center: .zero, radius: 1, startAngle: t0 * D, endAngle: t1 * D, clockwise: false,
                 transform: CGAffineTransform(translationX: c.x, y: c.y).rotated(by: tilt * D).scaledBy(x: rx, y: ry))
        return p
    }
    /// The near half of the orbit's plane, which passes in front of the object.
    var near: CGPath {
        moved(CGPath(rect: CGRect(x: -2000, y: 0, width: 4000, height: 2000), transform: nil),
              CGAffineTransform(translationX: c.x, y: c.y).rotated(by: tilt * D))
    }
    /// Bolder, for small sizes.
    func bolder() -> Orbit { var o = self; o.w *= 1.5; o.moonR *= 1.25; o.gap *= 1.3; return o }
}

/// The object with the orbit round it.
/// What hides the orbit's far side is the object itself, or `behind` for an
/// object drawn in line (a globe's disc).
func orbiting(_ body: CGPath, _ o: Orbit?, behind: CGPath? = nil) -> CGPath {
    guard let o else { return body }
    let hides = behind ?? body
    let ring = stroked(o.centreline, o.w)
    let front = ring.intersection(o.near)
    // Behind the object. A sliver left between the object and the moon would
    // read as a stray dash, so pieces that short are dropped.
    let back = ring.subtracting(o.near).subtracting(grown(hides, o.gap)).componentsSeparated()
        .filter { max($0.boundingBoxOfPath.width, $0.boundingBoxOfPath.height) > o.w * 2.5 }
    var g = body.subtracting(grown(front, o.gap)).union(front)
    for piece in back { g = g.union(piece) }
    return g.union(disc(o.moon, o.moonR).subtracting(grown(hides, o.gap)))
}

// MARK: - The objects

/// Orbit AI: a four-point spark.
func spark(_ c: P, _ r: CGFloat) -> CGPath {
    let p = CGMutablePath(), k = r * 0.2, h = r * 0.82
    p.move(to: P(x: c.x, y: c.y - r))
    p.addQuadCurve(to: P(x: c.x + h, y: c.y), control: P(x: c.x + k, y: c.y - k))
    p.addQuadCurve(to: P(x: c.x, y: c.y + r), control: P(x: c.x + k, y: c.y + k))
    p.addQuadCurve(to: P(x: c.x - h, y: c.y), control: P(x: c.x - k, y: c.y + k))
    p.addQuadCurve(to: P(x: c.x, y: c.y - r), control: P(x: c.x - k, y: c.y - k))
    p.closeSubpath()
    return p
}

/// Orbit Mail: a closed envelope, its flap cut in as a V.
func envelope(_ c: P, _ w: CGFloat, _ h: CGFloat, cut: CGFloat) -> CGPath {
    let x0 = c.x - w / 2, y0 = c.y - h / 2
    let v = line([P(x: x0 + w * 0.15, y: y0 + h * 0.2), P(x: c.x, y: y0 + h * 0.56), P(x: x0 + w * 0.85, y: y0 + h * 0.2)])
    return rrect(x0, y0, w, h, h * 0.17).subtracting(stroked(v, cut))
}

/// Orbit Calendar: a page with its header band and two binder rings.
func calendarPage(_ c: P, _ w: CGFloat, _ h: CGFloat, band: CGFloat) -> CGPath {
    let x0 = c.x - w / 2, y0 = c.y - h / 2
    var page = rrect(x0, y0, w, h, w * 0.16)
    page = page.subtracting(CGPath(rect: CGRect(x: x0 - 10, y: y0 + h * 0.27, width: w + 20, height: h * band), transform: nil))
    let tw = w * 0.115, th = h * 0.3
    let rings = rrect(x0 + w * 0.3 - tw / 2, y0 - th * 0.42, tw, th, tw / 2).union(rrect(x0 + w * 0.7 - tw / 2, y0 - th * 0.42, tw, th, tw / 2))
    return page.subtracting(grown(rings, w * 0.045)).union(rings)
}

/// Orbit Chat: a round speech bubble, its tail at the bottom right, someone typing.
func bubble(_ c: P, _ r: CGFloat, dots: CGFloat) -> CGPath {
    func at(_ deg: CGFloat, _ k: CGFloat) -> P { P(x: c.x + r * k * cos(deg * D), y: c.y + r * k * sin(deg * D)) }
    let tail = CGMutablePath()
    tail.move(to: at(84, 0.9))
    tail.addQuadCurve(to: at(53, 1.36), control: at(68, 1.12))
    tail.addQuadCurve(to: at(20, 0.9), control: at(44, 1.08))
    tail.addLine(to: c)
    tail.closeSubpath()
    var b = disc(c, r).union(tail)
    if dots > 0 {
        for dx: CGFloat in [-1, 0, 1] { b = b.subtracting(disc(P(x: c.x + dx * r * 0.42, y: c.y), r * dots)) }
    }
    return b
}

/// Orbit IDE: the code sign, </>, whose slash is an orbit, steep and wide
/// enough to read as one, round a small planet, with the moon at its top. At
/// 16 px a plain slash reads better.
func codeSign(_ d: Detail) -> CGPath {
    let bold = d != .full
    let weight: CGFloat = bold ? 80 : 66
    let gap: CGFloat = 240, h: CGFloat = 165, reach: CGFloat = 118
    let left = line([P(x: 512 - gap, y: 512 - h), P(x: 512 - gap - reach, y: 512), P(x: 512 - gap, y: 512 + h)])
    let right = line([P(x: 512 + gap, y: 512 - h), P(x: 512 + gap + reach, y: 512), P(x: 512 + gap, y: 512 + h)])
    let brackets = stroked(left, weight).union(stroked(right, weight))
    if d == .tiny {
        return brackets.union(stroked(line([P(x: 560, y: 330), P(x: 464, y: 694)]), weight))
    }
    var slash = Orbit()
    slash.rx = 330; slash.ry = 112; slash.tilt = -66; slash.w = 48; slash.moonR = 54; slash.moonAt = -10; slash.gap = 24
    if bold { slash.w = 64; slash.moonR = 64; slash.gap = 28 }
    return orbiting(brackets.union(disc(centre, bold ? 66 : 60)), slash)
}

/// Orbit Mission Control: a rocket climbing to the right.
func rocket(_ c: P, _ s: CGFloat, window: Bool) -> CGPath {
    let bw = s * 0.38, top = c.y - s * 0.62, shoulder = c.y - s * 0.1, base = c.y + s * 0.34
    let body = CGMutablePath()
    body.move(to: P(x: c.x, y: top))
    body.addCurve(to: P(x: c.x + bw / 2, y: shoulder), control1: P(x: c.x + bw * 0.42, y: top + s * 0.12), control2: P(x: c.x + bw / 2, y: shoulder - s * 0.2))
    body.addLine(to: P(x: c.x + bw / 2, y: base - s * 0.06))
    body.addQuadCurve(to: P(x: c.x + bw / 2 - s * 0.06, y: base), control: P(x: c.x + bw / 2, y: base))
    body.addLine(to: P(x: c.x - bw / 2 + s * 0.06, y: base))
    body.addQuadCurve(to: P(x: c.x - bw / 2, y: base - s * 0.06), control: P(x: c.x - bw / 2, y: base))
    body.addLine(to: P(x: c.x - bw / 2, y: shoulder))
    body.addCurve(to: P(x: c.x, y: top), control1: P(x: c.x - bw / 2, y: shoulder - s * 0.2), control2: P(x: c.x - bw * 0.42, y: top + s * 0.12))
    body.closeSubpath()
    var fins = CGMutablePath() as CGPath
    for k: CGFloat in [-1, 1] {
        let fin = line([P(x: c.x + k * bw * 0.3, y: c.y + s * 0.02), P(x: c.x + k * bw * 1.02, y: base + s * 0.08),
                        P(x: c.x + k * bw * 1.02, y: base + s * 0.17), P(x: c.x + k * bw * 0.3, y: base - s * 0.02)])
        fins = fins.union(stroked(fin, s * 0.06)).union(fin)
    }
    var r = fins.subtracting(grown(body, s * 0.035)).union(body)
    if window { r = r.subtracting(disc(P(x: c.x, y: c.y - s * 0.2), bw * 0.24)) }
    let flame = CGMutablePath()
    flame.move(to: P(x: c.x - bw * 0.26, y: base + s * 0.05))
    flame.addQuadCurve(to: P(x: c.x, y: base + s * 0.36), control: P(x: c.x - bw * 0.26, y: base + s * 0.24))
    flame.addQuadCurve(to: P(x: c.x + bw * 0.26, y: base + s * 0.05), control: P(x: c.x + bw * 0.26, y: base + s * 0.24))
    flame.closeSubpath()
    return turned(r.union(flame), about: c, by: 38)
}

/// Orbit Browser: a globe, drawn in line: its rim and one meridian, the
/// meridian `meridian` of the globe's width. The orbit is its equator; at
/// 16 px, without the orbit, it draws an equator of its own.
func globe(_ c: P, _ r: CGFloat, line w: CGFloat, meridian: CGFloat, equator: Bool) -> CGPath {
    let inner = r - w / 2
    func upright(_ rx: CGFloat) -> CGPath {
        stroked(CGPath(ellipseIn: CGRect(x: c.x - rx, y: c.y - inner, width: 2 * rx, height: 2 * inner), transform: nil), w)
    }
    let g = upright(inner).union(upright(inner * meridian))
    return equator ? g.union(stroked(line([P(x: c.x - inner, y: c.y), P(x: c.x + inner, y: c.y)]), w)) : g
}

/// Orbit Authenticator: a shield with a check cut in.
func shieldCheck(_ c: P, _ w: CGFloat, _ h: CGFloat, cut: CGFloat) -> CGPath {
    let x0 = c.x - w / 2, x1 = c.x + w / 2, y0 = c.y - h / 2, y1 = c.y + h / 2, r = w * 0.16
    let p = CGMutablePath()
    p.move(to: P(x: x0 + r, y: y0))
    p.addQuadCurve(to: P(x: c.x, y: y0 - h * 0.035), control: P(x: c.x - w * 0.25, y: y0 - h * 0.005))
    p.addQuadCurve(to: P(x: x1 - r, y: y0), control: P(x: c.x + w * 0.25, y: y0 - h * 0.005))
    p.addQuadCurve(to: P(x: x1, y: y0 + r), control: P(x: x1, y: y0))
    p.addLine(to: P(x: x1, y: y0 + h * 0.42))
    p.addCurve(to: P(x: c.x, y: y1), control1: P(x: x1, y: y0 + h * 0.74), control2: P(x: c.x + w * 0.24, y: y1 - h * 0.08))
    p.addCurve(to: P(x: x0, y: y0 + h * 0.42), control1: P(x: c.x - w * 0.24, y: y1 - h * 0.08), control2: P(x: x0, y: y0 + h * 0.74))
    p.addLine(to: P(x: x0, y: y0 + r))
    p.addQuadCurve(to: P(x: x0 + r, y: y0), control: P(x: x0, y: y0))
    p.closeSubpath()
    let tick = line([P(x: c.x - w * 0.26, y: c.y - h * 0.02), P(x: c.x - w * 0.06, y: c.y + h * 0.17), P(x: c.x + w * 0.27, y: c.y - h * 0.2)])
    return p.subtracting(stroked(tick, cut))
}

/// Orbit Pass's flat ring, as Orbit Authenticator borrows it: the arc from
/// `from` to `to` degrees (0 at three o'clock, counter-clockwise), round-capped.
func flatArc(_ c: P, r: CGFloat, w: CGFloat, from a0: CGFloat, to a1: CGFloat) -> CGPath {
    let p = CGMutablePath()
    // y runs down here, so counter-clockwise on screen is clockwise to CoreGraphics.
    p.addArc(center: c, radius: r, startAngle: -a0 * D, endAngle: -a1 * D, clockwise: true)
    return stroked(p, w)
}

/// Orbit Authenticator's mark: Orbit Pass's ring and moon, mirrored, the ring
/// a countdown with its top-left quarter gone and the moon in the gap, round a
/// shield with a check.
func authenticatorGlyph(_ d: Detail) -> CGPath {
    let bold = d != .full
    let c = P(x: 512, y: 512), r: CGFloat = 330
    let gapFrom: CGFloat = 98, gapTo: CGFloat = 172
    let moon = (gapFrom + gapTo) / 2 * D
    let ring = flatArc(c, r: r, w: bold ? 118 : 104, from: gapTo, to: gapFrom + 360)
        .union(disc(P(x: c.x + r * cos(moon), y: c.y - r * sin(moon)), bold ? 80 : 70))
    let w: CGFloat = bold ? 336 : 320, h: CGFloat = bold ? 386 : 370
    return ring.union(shieldCheck(P(x: 512, y: 524), w, h, cut: bold ? 58 : 46))
}

// MARK: - The marks

typealias RGB = (r: CGFloat, g: CGFloat, b: CGFloat)
func hex(_ s: String) -> RGB {
    let v = Int(s.dropFirst(), radix: 16)!
    return (CGFloat((v >> 16) & 255) / 255, CGFloat((v >> 8) & 255) / 255, CGFloat(v & 255) / 255)
}
func hexString(_ c: RGB) -> String {
    String(format: "#%02x%02x%02x", Int((c.r * 255).rounded()), Int((c.g * 255).rounded()), Int((c.b * 255).rounded()))
}

struct Mark {
    let label: String
    let what: String
    let tile: (top: RGB, bottom: RGB)   // the tile behind the white mark
    let ink: (top: RGB, bottom: RGB)    // the bare mark: light enough for dark pages, deep enough for light ones
    let solid: RGB                      // one flat colour, where a gradient can't go
    var onTile: (top: RGB, bottom: RGB)? = nil  // the mark's own colours on its tile, if it isn't white
    var size: CGFloat = 1                       // how much of the usual space it takes on a tile
    let glyph: (Detail) -> CGPath
}

/// The family orbit, adjusted for one mark, at a level of detail (none at all when tiny).
func orbit(_ detail: Detail, _ adjust: (inout Orbit) -> Void = { _ in }) -> Orbit? {
    var o = Orbit(); adjust(&o)
    switch detail { case .full: return o; case .small: return o.bolder(); case .tiny: return nil }
}
let centre = P(x: 512, y: 512)

let MARKS: [String: Mark] = [
    "ai": Mark(label: "Orbit AI", what: "a four-point spark in orbit",
               tile: (hex("#b07cff"), hex("#5b2ee6")), ink: (hex("#a46bff"), hex("#6236f0")), solid: hex("#7c4dff")) { d in
        orbiting(spark(centre, d == .full ? 310 : 330), orbit(d) { $0.c.y = 470 })
    },
    "mail": Mark(label: "Orbit Mail", what: "an envelope in orbit",
                 tile: (hex("#45b3ff"), hex("#1f5fe8")), ink: (hex("#3fa6ff"), hex("#1f63ea")), solid: hex("#2b7ff5")) { d in
        orbiting(envelope(centre, d == .full ? 500 : 540, d == .full ? 360 : 390, cut: d == .full ? 38 : 56), orbit(d) { $0.c.y = 500 })
    },
    "calendar": Mark(label: "Orbit Calendar", what: "a calendar page in orbit",
                     tile: (hex("#ff7d6b"), hex("#e8344a")), ink: (hex("#ff6f5e"), hex("#e3344b")), solid: hex("#f04a4f")) { d in
        orbiting(calendarPage(P(x: 512, y: 540), d == .full ? 450 : 480, d == .full ? 410 : 440, band: d == .full ? 0.065 : 0.09),
                 orbit(d) { $0.c.y = 560 })
    },
    "chat": Mark(label: "Orbit Chat", what: "a speech bubble in orbit",
                 tile: (hex("#4be38f"), hex("#0fa35a")), ink: (hex("#2fd27a"), hex("#0e9e57")), solid: hex("#16b765")) { d in
        orbiting(bubble(P(x: 512, y: 490), d == .full ? 250 : 270, dots: d == .tiny ? 0 : (d == .full ? 0.13 : 0.16)), orbit(d) { $0.c.y = 500 })
    },
    "ide": Mark(label: "Orbit IDE", what: "the code sign, its slash an orbit",
                tile: (hex("#26335f"), hex("#0b1020")), ink: (hex("#38c4ea"), hex("#7466f2")), solid: hex("#5b8def"),
                onTile: (hex("#6ee7f9"), hex("#8b7cf8")), glyph: codeSign),
    "control": Mark(label: "Orbit Mission Control", what: "a rocket in orbit",
                    tile: (hex("#3b4fc4"), hex("#141b4d")), ink: (hex("#6f7dff"), hex("#3a45d1")), solid: hex("#3d4fd6")) { d in
        orbiting(rocket(P(x: 512, y: 520), d == .full ? 530 : 560, window: d == .full), orbit(d) { $0.c.y = 540 })
    },
    "browser": Mark(label: "Orbit Browser", what: "a globe, its equator an orbit",
                    tile: (hex("#3fe0cf"), hex("#0a7f8c")), ink: (hex("#24cdbf"), hex("#0b8592")), solid: hex("#12a3a6")) { d in
        // The orbit sits low enough to cover the meridian's last loop, so the
        // globe's foot below it is one clean piece.
        let at = P(x: 512, y: 500), r: CGFloat = 258
        let body = globe(at, r, line: d == .full ? 56 : (d == .small ? 76 : 90), meridian: 0.46, equator: d == .tiny)
        return orbiting(body, orbit(d) { $0.c.y = 555 }, behind: disc(at, r))
    },
    "authenticator": Mark(label: "Orbit Authenticator", what: "a shield in Orbit Pass's ring, its countdown",
                          tile: (hex("#3d8eff"), hex("#0047d6")), ink: (hex("#3d8eff"), hex("#0057e6")), solid: hex("#006fff"),
                          size: 0.79, glyph: authenticatorGlyph),
    "orbit": Mark(label: "Orbit", what: "a planet and its moon",
                  tile: (hex("#1a56c9"), hex("#0b2a5b")), ink: (hex("#4a86ff"), hex("#1f56d6")), solid: hex("#1a56c9")) { d in
        // The planet keeps its ring even at the smallest size: without it, it's a dot.
        orbiting(disc(centre, d == .full ? 240 : 260), d == .full ? Orbit() : Orbit().bolder())
    },
]

// MARK: - Layout

enum Layout: String { case bleed, mac, tile, colour, black, white, current, dark, tinted }
let bareLayouts: Set<Layout> = [.colour, .black, .white, .current]

/// The tile behind the mark, if the layout has one, on a `w` by `h` canvas.
func tilePath(_ l: Layout, _ w: CGFloat, _ h: CGFloat) -> CGPath? {
    switch l {
    case .bleed: return CGPath(rect: CGRect(x: 0, y: 0, width: w, height: h), transform: nil)
    case .mac: return rrect(w * 100 / 1024, h * 100 / 1024, w * 824 / 1024, h * 824 / 1024, w * 185 / 1024)
    case .tile: return rrect(0, 0, w, h, min(w, h) * 0.225)
    default: return nil
    }
}

/// How much of the canvas the mark spans, along whichever side binds first.
func span(_ l: Layout, _ d: Detail) -> CGFloat {
    switch l {
    case .bleed, .dark, .tinted: return 0.74
    case .mac: return 0.61
    case .tile: return d == .full ? 0.76 : (d == .small ? 0.84 : 0.66)
    default: return 0.98
    }
}

/// The mark fitted, centred on its bounding box, into a `w` by `h` canvas.
func placed(_ g: CGPath, _ w: CGFloat, _ h: CGFloat, _ fill: CGFloat) -> CGPath {
    let b = g.boundingBoxOfPath
    let k = min(w * fill / b.width, h * fill / b.height, min(w, h) * fill / max(b.width, b.height))
    return moved(g, CGAffineTransform(translationX: w / 2, y: h / 2).scaledBy(x: k, y: k).translatedBy(x: -b.midX, y: -b.midY))
}

/// The bare mark's canvas height at a width: its own proportions.
func bareHeight(_ m: Mark, _ d: Detail, width: Int) -> Int {
    let b = m.glyph(d).boundingBoxOfPath
    return Int((CGFloat(width) * b.height / b.width).rounded())
}

func colour(_ c: RGB) -> CGColor { CGColor(colorSpace: cs, components: [c.r, c.g, c.b, 1])! }

// MARK: - PNG

func renderPNG(_ m: Mark, w: Int, h: Int, layout: Layout, detail: Detail, opaque: Bool) -> CGImage {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: info)!
    let W = CGFloat(w), H = CGFloat(h)
    ctx.translateBy(x: 0, y: H); ctx.scaleBy(x: 1, y: -1)
    func gradient(_ pair: (top: RGB, bottom: RGB), over b: CGRect) {
        let g = CGGradient(colorsSpace: cs, colors: [colour(pair.top), colour(pair.bottom)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(g, start: P(x: b.minX + b.width * 0.25, y: b.minY), end: P(x: b.minX + b.width * 0.75, y: b.maxY),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
    let glyph = placed(m.glyph(detail), W, H, span(layout, detail) * m.size)
    if let tile = tilePath(layout, W, H) {
        ctx.saveGState(); ctx.addPath(tile); ctx.clip(); gradient(m.tile, over: tile.boundingBox); ctx.restoreGState()
        if let pair = m.onTile {
            ctx.saveGState(); ctx.addPath(glyph); ctx.clip(); gradient(pair, over: glyph.boundingBox); ctx.restoreGState()
        } else {
            ctx.addPath(glyph); ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fillPath()
        }
    } else if layout == .colour || layout == .dark {
        ctx.saveGState(); ctx.addPath(glyph); ctx.clip(); gradient(m.ink, over: glyph.boundingBox); ctx.restoreGState()
    } else {
        ctx.addPath(glyph)
        ctx.setFillColor(layout == .black ? CGColor(srgbRed: 0.067, green: 0.067, blue: 0.067, alpha: 1) : CGColor(gray: 1, alpha: 1))
        ctx.fillPath()
    }
    return ctx.makeImage()!
}

func savePNG(_ img: CGImage, _ path: String) {
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { exit(1) }
}

// MARK: - SVG

func num(_ v: CGFloat, _ places: Int) -> String {
    var s = String(format: "%.\(places)f", Double(v))
    if s.contains(".") { while s.hasSuffix("0") { s.removeLast() }; if s.hasSuffix(".") { s.removeLast() } }
    return s == "-0" ? "0" : s
}

func pathData(_ p: CGPath, places: Int) -> String {
    var d = ""
    func pt(_ q: P) -> String { num(q.x, places) + " " + num(q.y, places) }
    p.applyWithBlock { e in
        let q = e.pointee.points
        switch e.pointee.type {
        case .moveToPoint: d += "M" + pt(q[0])
        case .addLineToPoint: d += "L" + pt(q[0])
        case .addQuadCurveToPoint: d += "Q" + pt(q[0]) + " " + pt(q[1])
        case .addCurveToPoint: d += "C" + pt(q[0]) + " " + pt(q[1]) + " " + pt(q[2])
        case .closeSubpath: d += "Z"
        @unknown default: break
        }
    }
    return d
}

func svgGradient(_ id: String, _ pair: (top: RGB, bottom: RGB)) -> String {
    "<defs><linearGradient id=\"\(id)\" x1=\"0.25\" y1=\"0\" x2=\"0.75\" y2=\"1\">"
        + "<stop offset=\"0\" stop-color=\"\(hexString(pair.top))\"/><stop offset=\"1\" stop-color=\"\(hexString(pair.bottom))\"/>"
        + "</linearGradient></defs>"
}

func svgDocument(_ key: String, _ m: Mark, layout: Layout, w: Int, h: Int, detail: Detail) -> String {
    // Drawn in a 1024-unit box along the width, whatever size it is shown at.
    let W: CGFloat = 1024, H = (1024 * CGFloat(h) / CGFloat(w)).rounded()
    let d = pathData(placed(m.glyph(detail), W, H, span(layout, detail) * m.size), places: 1)
    var body = ""
    switch layout {
    case .bleed, .mac, .tile:
        let id = "orbit-\(key)-tile"
        body += svgGradient(id, m.tile)
        switch layout {
        case .bleed: body += "<rect width=\"\(num(W, 1))\" height=\"\(num(H, 1))\" fill=\"url(#\(id))\"/>"
        case .mac: body += "<rect x=\"100\" y=\"100\" width=\"824\" height=\"824\" rx=\"185\" fill=\"url(#\(id))\"/>"
        default: body += "<rect width=\"\(num(W, 1))\" height=\"\(num(H, 1))\" rx=\"\(num(min(W, H) * 0.225, 1))\" fill=\"url(#\(id))\"/>"
        }
        if let pair = m.onTile {
            body += svgGradient("orbit-\(key)-mark", pair) + "<path fill=\"url(#orbit-\(key)-mark)\" d=\"\(d)\"/>"
        } else {
            body += "<path fill=\"#fff\" d=\"\(d)\"/>"
        }
    case .colour:
        let id = "orbit-\(key)-ink"
        body += svgGradient(id, m.ink) + "<path fill=\"url(#\(id))\" d=\"\(d)\"/>"
    default:
        body += "<path fill=\"\(layout == .white ? "#fff" : (layout == .black ? "#000" : "currentColor"))\" d=\"\(d)\"/>"
    }
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 \(num(W, 1)) \(num(H, 1))\" width=\"\(w)\" height=\"\(h)\" role=\"img\" aria-label=\"\(m.label)\">\n"
        + "<!-- \(m.label): \(m.what). Generated from scripts/orbitmark.swift; edit that, not this. -->\n"
        + body + "\n</svg>\n"
}

// MARK: - Command line

func size(_ s: String) -> (Int, Int?) {
    let parts = s.split(separator: "x").map { Int($0)! }
    return (parts[0], parts.count > 1 ? parts[1] : nil)
}

let a = CommandLine.arguments
guard a.count >= 3, let m = MARKS[a[2]] else {
    FileHandle.standardError.write("usage: orbitmark png|svg|path|colour <mark> ... (see the top of orbitmark.swift)\n".data(using: .utf8)!)
    exit(2)
}
let detail: Detail = a.contains("tiny") ? .tiny : (a.contains("small") ? .small : .full)
switch a[1] {
case "png":
    let layout = Layout(rawValue: a[5])!
    let (w, h) = size(a[4])
    savePNG(renderPNG(m, w: w, h: h ?? (bareLayouts.contains(layout) ? bareHeight(m, detail, width: w) : w),
                      layout: layout, detail: detail, opaque: a.contains("opaque")), a[3])
case "svg":
    let layout = Layout(rawValue: a[3])!
    let (w, h) = size(a[4])
    print(svgDocument(a[2], m, layout: layout, w: w, h: h ?? (bareLayouts.contains(layout) ? bareHeight(m, detail, width: w) : w), detail: detail),
          terminator: "")
case "path":
    let box = CGFloat(Double(a[3])!), fill = CGFloat(Double(a[4])!)
    print(pathData(placed(m.glyph(detail), box, box, fill), places: 2))
case "colour":
    print(hexString(m.solid))
default:
    exit(2)
}
