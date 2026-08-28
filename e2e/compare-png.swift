import AppKit
import Foundation

guard CommandLine.arguments.count == 4 else {
  fputs("usage: compare-png.swift <expected.png> <actual.png> <diff.png>\n", stderr)
  exit(2)
}

func pixels(_ path: String) -> (width: Int, height: Int, bytes: [UInt8])? {
  guard
    let image = NSImage(contentsOfFile: path),
    let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else { return nil }
  let width = cg.width
  let height = cg.height
  var bytes = [UInt8](repeating: 0, count: width * height * 4)
  guard let context = CGContext(
    data: &bytes,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
  return (width, height, bytes)
}

let expectedPath = CommandLine.arguments[1]
let actualPath = CommandLine.arguments[2]
let diffPath = CommandLine.arguments[3]
guard let expected = pixels(expectedPath), let actual = pixels(actualPath) else {
  fputs("Could not decode one of the PNGs.\n", stderr)
  exit(2)
}
guard expected.width == actual.width && expected.height == actual.height else {
  fputs("Image dimensions differ: expected \(expected.width)x\(expected.height), actual \(actual.width)x\(actual.height).\n", stderr)
  exit(1)
}

var diff = [UInt8](repeating: 0, count: expected.bytes.count)
var changed = 0
for offset in stride(from: 0, to: expected.bytes.count, by: 4) {
  let different = (0..<4).contains { channel in
    abs(Int(expected.bytes[offset + channel]) - Int(actual.bytes[offset + channel])) > 2
  }
  if different {
    changed += 1
    diff[offset] = 255
    diff[offset + 1] = 0
    diff[offset + 2] = 150
    diff[offset + 3] = 255
  } else {
    let gray = UInt8((Int(actual.bytes[offset]) + Int(actual.bytes[offset + 1]) + Int(actual.bytes[offset + 2])) / 6)
    diff[offset] = gray
    diff[offset + 1] = gray
    diff[offset + 2] = gray
    diff[offset + 3] = 255
  }
}

if changed > 0 {
  let representation = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: expected.width,
    pixelsHigh: expected.height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: expected.width * 4,
    bitsPerPixel: 32
  )!
  diff.withUnsafeBytes { source in
    representation.bitmapData!.update(from: source.bindMemory(to: UInt8.self).baseAddress!, count: diff.count)
  }
  try representation.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: diffPath))
  fputs("\(changed) pixels differ; diff written to \(diffPath).\n", stderr)
  exit(1)
}

print("Pixel-identical: \(expected.width)x\(expected.height)")
