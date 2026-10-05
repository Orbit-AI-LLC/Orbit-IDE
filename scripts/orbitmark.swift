// Orbit IDE mark renderer.
//
// The mark: the Orbit family's comet (one satellite, a trail tapering behind
// it round a single orbit, as in Orbit AI's mark) with a pair of code
// chevrons in the centre: the editor, in orbit. The orbit, trail and satellite
// are the same geometry as Orbit AI's and Orbit Chat's marks so the apps sit
// together as one family.
//
// Every raster of the mark is generated from this one piece of geometry by
// scripts/build_icon.py, which also asks this program for the SVG form.
//
// Build (the toolchain compiler is enough, no Xcode licence needed):
//
//   TC=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin
//   SDK=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
//   $TC/swiftc -sdk $SDK -O -o /tmp/orbitmark scripts/orbitmark.swift
//
// Usage:
//
//   orbitmark <out.png> <width> <height> <fg> <bg> <scale> [bold] [opaque]
//   orbitmark --svg <scale> [bold]
//
//   fg       black | white
//   bg       none | white | black | tile-white | tile-black | mac-black
//   scale    fraction of the canvas width the mark's bounding box spans
//   bold     thicker trail and chevrons, for favicon sizes
//   opaque   no alpha channel
//   --svg    print the mark as SVG elements in a 1024x1024 box; the chevrons
//            are stroked with the colour token __INK__ for the caller to fill in
import CoreGraphics; import Foundation; import ImageIO; import UniformTypeIdentifiers
let args = CommandLine.arguments
let svgMode = args.count > 1 && args[1] == "--svg"
let bold = args.contains("bold"); let opaque = args.contains("opaque")
func envD(_ k: String, _ d: Double) -> Double { ProcessInfo.processInfo.environment[k].flatMap(Double.init) ?? d }
let cs = CGColorSpace(name: CGColorSpace.sRGB)!

// Geometry, orbit diameter = 1.0, as in Orbit AI's mark.
let orbitR = 0.5
let headT = envD("ORB_HEAD", 40.0) * .pi / 180
let sweep = envD("ORB_SWEEP", 315.0) * .pi / 180
let wMax = bold ? envD("ORB_W", 0.12) + 0.03 : envD("ORB_W", 0.12)
let wMin = envD("ORB_WMIN", 0.008)
let headR = bold ? envD("ORB_HEADR", 0.085) + 0.02 : envD("ORB_HEADR", 0.085)
// The chevrons: "<" and ">" centred, each an open polyline with round caps.
let chevH = envD("ORB_CHEVH", 0.13)      // half height
let chevW = envD("ORB_CHEVW", 0.115)     // horizontal depth of each chevron
let chevGap = envD("ORB_CHEVGAP", 0.055) // half of the gap between their points
let chevStroke = bold ? envD("ORB_CHEVS", 0.075) + 0.02 : envD("ORB_CHEVS", 0.075)

let L = 2400; let unit = Double(L) * 0.72
let c = CGPoint(x: Double(L) / 2, y: Double(L) / 2)
func P(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: c.x + x * unit, y: c.y + y * unit) }
func op(_ t: Double, _ r: Double) -> CGPoint { P(r * cos(t), r * sin(t)) }

func trailPoints(_ n: Int) -> (outer: [CGPoint], inner: [CGPoint], endT: Double) {
    let t0 = headT - sweep, t1 = headT
    var outer: [CGPoint] = [], inner: [CGPoint] = []
    for i in 0...n {
        let f = Double(i) / Double(n)
        let t = t0 + (t1 - t0) * f
        let w = wMin + (wMax - wMin) * pow(f, envD("ORB_EASE", 0.75))
        outer.append(op(t, orbitR + w / 2)); inner.append(op(t, orbitR - w / 2))
    }
    return (outer, inner, t1)
}
func trailPath() -> CGPath {
    let p = CGMutablePath()
    let pts = trailPoints(600)
    p.move(to: pts.outer[0]); for q in pts.outer.dropFirst() { p.addLine(to: q) }
    let cEnd = op(pts.endT, orbitR)
    p.addArc(center: cEnd, radius: wMax / 2 * unit, startAngle: pts.endT, endAngle: pts.endT + .pi, clockwise: true)
    for q in pts.inner.reversed() { p.addLine(to: q) }
    p.closeSubpath()
    return p
}
func disc(_ p: CGPoint, _ r: Double) -> CGPath { CGPath(ellipseIn: CGRect(x: p.x - r * unit, y: p.y - r * unit, width: 2 * r * unit, height: 2 * r * unit), transform: nil) }
// Each chevron as three points in unit space; left points left, right points right.
func chevron(_ dir: Double) -> [CGPoint] {
    let tip = dir * (chevGap + chevW), back = dir * chevGap
    return [P(back, chevH), P(tip, 0), P(back, -chevH)]
}
func chevronPath(_ dir: Double) -> CGPath {
    let p = CGMutablePath(); let pts = chevron(dir)
    p.move(to: pts[0]); p.addLine(to: pts[1]); p.addLine(to: pts[2])
    return p.copy(strokingWithWidth: chevStroke * unit, lineCap: .round, lineJoin: .round, miterLimit: 10)
}

let layer = CGContext(data: nil, width: L, height: L, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
layer.setShouldAntialias(true)
let ink = CGColor(srgbRed: 0.067, green: 0.067, blue: 0.067, alpha: 1); let paper = CGColor(gray: 1, alpha: 1)
layer.setFillColor(paper)
layer.addPath(trailPath()); layer.fillPath()
layer.addPath(disc(op(headT, orbitR), headR)); layer.fillPath()
layer.addPath(chevronPath(-1)); layer.fillPath()
layer.addPath(chevronPath(1)); layer.fillPath()
let data = layer.data!.assumingMemoryBound(to: UInt8.self); let bpr = layer.bytesPerRow
var minX = L, minY = L, maxX = -1, maxY = -1
for y in 0..<L { for x in 0..<L where data[y * bpr + x * 4 + 3] > 8 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } }
let bw = Double(maxX - minX + 1), bh = Double(maxY - minY + 1)

if svgMode {
    let scale = Double(args[2])!
    let W = 1024.0
    let tw = W * scale, th = tw * bh / bw
    let k = tw / bw
    let ox = (W - tw) / 2 - Double(minX) * k
    func sx(_ p: CGPoint) -> String { String(format: "%.1f", p.x * k + ox) }
    func sy(_ p: CGPoint) -> String { String(format: "%.1f", (W - th) / 2 + (Double(maxY) - p.y) * k) }
    func pt(_ p: CGPoint) -> String { sx(p) + " " + sy(p) }
    var out = ""
    let pts = trailPoints(120)
    var d = "M" + pt(pts.outer[0])
    for q in pts.outer.dropFirst() { d += " L" + pt(q) }
    let rr = String(format: "%.1f", wMax / 2 * unit * k)
    d += " A\(rr) \(rr) 0 0 1 " + pt(pts.inner.last!)
    for q in pts.inner.reversed().dropFirst() { d += " L" + pt(q) }
    d += " Z"
    let head = op(headT, orbitR)
    out += "<path d=\"\(d)\"/>\n"
    out += "<circle cx=\"\(sx(head))\" cy=\"\(sy(head))\" r=\"\(String(format: "%.1f", headR * unit * k))\"/>\n"
    let sw = String(format: "%.1f", chevStroke * unit * k)
    for dir in [-1.0, 1.0] {
        let ch = chevron(dir)
        out += "<path d=\"M\(pt(ch[0])) L\(pt(ch[1])) L\(pt(ch[2]))\" fill=\"none\" stroke=\"__INK__\" stroke-width=\"\(sw)\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n"
    }
    print(out, terminator: "")
    exit(0)
}

let outPath = args[1]; let width = Int(args[2])!; let height = Int(args[3])!
let fgName = args[4]; let bgName = args[5]; let scale = Double(args[6])!
let fg: CGColor = fgName == "white" ? paper : ink
let tile = bgName.hasPrefix("tile-"), mac = bgName.hasPrefix("mac-")
let bg: CGColor? = bgName.hasSuffix("white") ? paper : (bgName.hasSuffix("black") ? ink : nil)

let mark = layer.makeImage()!.cropping(to: CGRect(x: minX, y: minY, width: Int(bw), height: Int(bh)))!
let ss = 4; let W = width * ss, H = height * ss
let big = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
big.interpolationQuality = .high
if let bg = bg {
    big.setFillColor(bg)
    if tile {
        let r = Double(min(W, H)) * 0.22
        big.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: W, height: H), cornerWidth: r, cornerHeight: r, transform: nil)); big.fillPath()
    } else if mac {
        let inset = Double(W) * 100 / 1024, r = Double(W) * 185 / 1024
        big.addPath(CGPath(roundedRect: CGRect(x: inset, y: inset, width: Double(W) - 2 * inset, height: Double(H) - 2 * inset), cornerWidth: r, cornerHeight: r, transform: nil)); big.fillPath()
    } else {
        big.fill(CGRect(x: 0, y: 0, width: W, height: H))
    }
}
let tw = Double(W) * scale, th = tw * bh / bw
let markRect = CGRect(x: (Double(W) - tw) / 2, y: (Double(H) - th) / 2, width: tw, height: th)
big.saveGState()
big.clip(to: markRect, mask: mark)
big.setFillColor(fg)
big.fill(markRect)
big.restoreGState()
let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
let out = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: info)!
if opaque, let bg = bg { out.setFillColor(bg); out.fill(CGRect(x: 0, y: 0, width: width, height: height)) }
out.interpolationQuality = .high; out.draw(big.makeImage()!, in: CGRect(x: 0, y: 0, width: width, height: height))
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, out.makeImage()!, nil); guard CGImageDestinationFinalize(dest) else { exit(1) }
