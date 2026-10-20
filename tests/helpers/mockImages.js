import crypto from "crypto";

// 1. Create a minimal valid 100x100 PNG with a tEXt chunk
export function createMockPngWithMetadata() {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    
    // IHDR chunk: 100x100, 8-bit RGBA
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(100, 0); // width
    ihdrData.writeUInt32BE(100, 4); // height
    ihdrData.writeUInt8(8, 8);      // bit depth
    ihdrData.writeUInt8(6, 9);      // color type RGBA
    ihdrData.writeUInt8(0, 10);     // compression
    ihdrData.writeUInt8(0, 11);     // filter
    ihdrData.writeUInt8(0, 12);     // interlace
    const ihdrChunk = createPngChunk("IHDR", ihdrData);

    // tEXt chunk (EXIF / GPS / comment)
    const textData = Buffer.from("Location\0Lat=28.6139,Lon=77.2090", "latin1");
    const textChunk = createPngChunk("tEXt", textData);

    // IDAT chunk (minimal empty scanline)
    const idatData = Buffer.from([0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
    const idatChunk = createPngChunk("IDAT", idatData);

    // IEND chunk
    const iendChunk = createPngChunk("IEND", Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, textChunk, idatChunk, iendChunk]);
}

function createPngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    // Simple CRC placeholder (sufficient for parser testing)
    const crc = Buffer.alloc(4);
    return Buffer.concat([length, typeBuf, data, crc]);
}

// 2. Create a minimal valid JPEG with APP1 (EXIF) segment
export function createMockJpegWithExif() {
    const soi = Buffer.from([0xFF, 0xD8]);
    
    // APP1 segment with GPS data
    const app1Data = Buffer.from("Exif\0\0GPSLatitude=28.6139", "ascii");
    const app1Len = Buffer.alloc(2);
    app1Len.writeUInt16BE(app1Data.length + 2, 0);
    const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1]), app1Len, app1Data]);

    // SOF0 segment: 100x100
    const sof0Data = Buffer.from([
        0x08, // precision
        0x00, 0x64, // height 100
        0x00, 0x64, // width 100
        0x03, // 3 components
        0x01, 0x11, 0x00,
        0x02, 0x11, 0x01,
        0x03, 0x11, 0x01
    ]);
    const sof0Len = Buffer.alloc(2);
    sof0Len.writeUInt16BE(sof0Data.length + 2, 0);
    const sof0 = Buffer.concat([Buffer.from([0xFF, 0xC0]), sof0Len, sof0Data]);

    // SOS + EOI
    const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x00]);
    const eoi = Buffer.from([0xFF, 0xD9]);

    return Buffer.concat([soi, app1, sof0, sos, eoi]);
}

// 3. Create a minimal valid WebP (VP8X extended format) with EXIF chunk containing GPS
export function createMockWebPWithExif() {
    const riffHeader = Buffer.from("RIFF\0\0\0\0WEBP", "ascii");

    // VP8X chunk (10 bytes payload)
    const vp8xTag = Buffer.from("VP8X", "ascii");
    const vp8xLen = Buffer.alloc(4);
    vp8xLen.writeUInt32LE(10, 0);
    const vp8xData = Buffer.alloc(10);
    vp8xData.writeUInt8(0x08, 0); // EXIF flag bit set (bit 3: 0x08)
    // Width-1 (100-1 = 99): 24-bit uint LE
    vp8xData.writeUInt8(99 & 0xFF, 4);
    vp8xData.writeUInt8((99 >> 8) & 0xFF, 5);
    vp8xData.writeUInt8((99 >> 16) & 0xFF, 6);
    // Height-1 (100-1 = 99): 24-bit uint LE
    vp8xData.writeUInt8(99 & 0xFF, 7);
    vp8xData.writeUInt8((99 >> 8) & 0xFF, 8);
    vp8xData.writeUInt8((99 >> 16) & 0xFF, 9);
    const vp8xChunk = Buffer.concat([vp8xTag, vp8xLen, vp8xData]);

    // EXIF chunk with GPS data
    const exifTag = Buffer.from("EXIF", "ascii");
    const exifPayload = Buffer.from("Exif\0\0GPSLatitude=28.6139", "ascii");
    const exifLen = Buffer.alloc(4);
    exifLen.writeUInt32LE(exifPayload.length, 0);
    const exifPadding = exifPayload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    const exifChunk = Buffer.concat([exifTag, exifLen, exifPayload, exifPadding]);

    // Lossy VP8 chunk (minimal valid frame: 100x100)
    const vp8Tag = Buffer.from("VP8 ", "ascii");
    const vp8Data = Buffer.from([
        0x00, 0x00, 0x00, // frame tag
        0x9d, 0x01, 0x2a, // start code
        0x64, 0x00,       // width 100
        0x64, 0x00        // height 100
    ]);
    const vp8Len = Buffer.alloc(4);
    vp8Len.writeUInt32LE(vp8Data.length, 0);
    const vp8Padding = vp8Data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    const vp8Chunk = Buffer.concat([vp8Tag, vp8Len, vp8Data, vp8Padding]);

    const full = Buffer.concat([riffHeader, vp8xChunk, exifChunk, vp8Chunk]);
    full.writeUInt32LE(full.length - 8, 4);
    return full;
}
