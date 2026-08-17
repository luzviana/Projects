#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const imageRoot = resolve(scriptRoot, "../theme/ngenious-go/login/resources/img");
const sourcePath = resolve(imageRoot, "ngenious-logo.png");
const outputPath = resolve(imageRoot, "favicon.ico");
const iconSizes = [16, 32, 48, 64];

const source = decodeRgbaPng(await readFile(sourcePath));
const crop = findFirstOpaqueComponent(source);
const images = iconSizes.map((size) => encodeRgbaPng(scaleIntoSquare(source, crop, size)));
await writeFile(outputPath, encodeIco(images, iconSizes));

console.log(`Created ${outputPath}`);
console.log(`Robot-head crop: ${crop.x},${crop.y} ${crop.width}x${crop.height}`);

function decodeRgbaPng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("Source is not a PNG");

  let offset = 8;
  let width;
  let height;
  const compressed = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error("Expected a non-interlaced 8-bit RGBA PNG");
      }
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }

  const encoded = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let encodedOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[encodedOffset];
    encodedOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[encodedOffset + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      pixels[y * stride + x] = unfilter(raw, filter, left, up, upLeft);
    }
    encodedOffset += stride;
  }
  return { width, height, pixels };
}

function unfilter(raw, filter, left, up, upLeft) {
  if (filter === 0) return raw;
  if (filter === 1) return (raw + left) & 255;
  if (filter === 2) return (raw + up) & 255;
  if (filter === 3) return (raw + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (raw + paeth(left, up, upLeft)) & 255;
  throw new Error(`Unsupported PNG filter ${filter}`);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upLeft;
}

function findFirstOpaqueComponent(image) {
  const hasInk = Array.from({ length: image.width }, (_, x) => {
    for (let y = 0; y < image.height; y += 1) {
      if (alphaAt(image, x, y) > 8) return true;
    }
    return false;
  });
  const startX = hasInk.findIndex(Boolean);
  if (startX < 0) throw new Error("Logo contains no visible pixels");

  let endX = image.width - 1;
  let emptyRun = 0;
  for (let x = startX; x < image.width; x += 1) {
    if (hasInk[x]) emptyRun = 0;
    else {
      emptyRun += 1;
      if (emptyRun >= 3) {
        endX = x - emptyRun;
        break;
      }
    }
  }

  let startY = image.height;
  let endY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      if (alphaAt(image, x, y) > 8) {
        startY = Math.min(startY, y);
        endY = Math.max(endY, y);
      }
    }
  }
  return { x: startX, y: startY, width: endX - startX + 1, height: endY - startY + 1 };
}

function alphaAt(image, x, y) {
  return image.pixels[(y * image.width + x) * 4 + 3];
}

function scaleIntoSquare(sourceImage, crop, size) {
  const output = { width: size, height: size, pixels: Buffer.alloc(size * size * 4) };
  const scale = Math.min((size * 0.88) / crop.width, (size * 0.72) / crop.height);
  const targetWidth = crop.width * scale;
  const targetHeight = crop.height * scale;
  const targetX = (size - targetWidth) / 2;
  const targetY = (size - targetHeight) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = crop.x + (x + 0.5 - targetX) / scale - 0.5;
      const sourceY = crop.y + (y + 0.5 - targetY) / scale - 0.5;
      if (sourceX < crop.x || sourceY < crop.y || sourceX >= crop.x + crop.width || sourceY >= crop.y + crop.height) continue;
      sampleBilinear(sourceImage, sourceX, sourceY).copy(output.pixels, (y * size + x) * 4);
    }
  }
  return output;
}

function sampleBilinear(image, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const horizontal = x - x0;
  const vertical = y - y0;
  const result = Buffer.alloc(4);
  for (let channel = 0; channel < 4; channel += 1) {
    const top = channelAt(image, x0, y0, channel) * (1 - horizontal) + channelAt(image, x1, y0, channel) * horizontal;
    const bottom = channelAt(image, x0, y1, channel) * (1 - horizontal) + channelAt(image, x1, y1, channel) * horizontal;
    result[channel] = Math.round(top * (1 - vertical) + bottom * vertical);
  }
  return result;
}

function channelAt(image, x, y, channel) {
  return image.pixels[(y * image.width + x) * 4 + channel];
}

function encodeRgbaPng(image) {
  const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowOffset = y * (image.width * 4 + 1);
    raw[rowOffset] = 0;
    image.pixels.copy(raw, rowOffset + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return chunk;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeIco(images, sizes) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let imageOffset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = sizes[index];
    header[entry + 1] = sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(imageOffset, entry + 12);
    imageOffset += image.length;
  });
  return Buffer.concat([header, ...images]);
}
