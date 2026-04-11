import { ApiResponse, BinarySubtype, DataType, RoutedData } from './types';
import { logger } from './logger';

const MAX_BINARY_SIZE = 5 * 1024 * 1024; // 5 MB — skip LLM for very large binaries
const MIN_TEXT_LENGTH = 10;               // shorter transcriptions are treated as noise

// --- MIME detection from the API's `meta` field (primary, zero-cost) ---

function detectFromMeta(meta: string): { subtype: BinarySubtype; mime: string } | null {
  const m = meta.toLowerCase();
  if (m.startsWith('image/'))            return { subtype: BinarySubtype.IMAGE,     mime: meta };
  if (m.startsWith('audio/'))            return { subtype: BinarySubtype.AUDIO,     mime: meta };
  if (m === 'application/json'
   || m === 'text/json')                 return { subtype: BinarySubtype.JSON,      mime: meta };
  if (m.startsWith('text/'))             return { subtype: BinarySubtype.TEXT_FILE, mime: meta };
  if (m === 'application/pdf')           return { subtype: BinarySubtype.PDF,       mime: meta };
  return null;
}

// --- MIME detection from magic bytes (fallback) ---

function detectFromMagicBytes(buf: Buffer): { subtype: BinarySubtype; mime: string } {
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
    return { subtype: BinarySubtype.IMAGE, mime: 'image/jpeg' };

  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { subtype: BinarySubtype.IMAGE, mime: 'image/png' };

  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return { subtype: BinarySubtype.IMAGE, mime: 'image/gif' };

  // WebP: RIFF????WEBP
  if (buf.length >= 12
   && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
   && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
    return { subtype: BinarySubtype.IMAGE, mime: 'image/webp' };

  // MP3 with ID3 tag
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
    return { subtype: BinarySubtype.AUDIO, mime: 'audio/mpeg' };

  // MP3 sync frame (FF FB / FF FA / FF F3)
  if (buf[0] === 0xFF && (buf[1] === 0xFB || buf[1] === 0xFA || buf[1] === 0xF3))
    return { subtype: BinarySubtype.AUDIO, mime: 'audio/mpeg' };

  // WAV: RIFF????WAVE
  if (buf.length >= 12
   && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
   && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45)
    return { subtype: BinarySubtype.AUDIO, mime: 'audio/wav' };

  // OGG: OggS
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53)
    return { subtype: BinarySubtype.AUDIO, mime: 'audio/ogg' };

  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
    return { subtype: BinarySubtype.PDF, mime: 'application/pdf' };

  // JSON / plain text: check first 64 bytes
  try {
    const head = buf.slice(0, 64).toString('utf8');
    const trimmed = head.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('['))
      return { subtype: BinarySubtype.JSON,      mime: 'application/json' };
    if (/^[\x20-\x7E\r\n\t]+$/.test(head))
      return { subtype: BinarySubtype.TEXT_FILE,  mime: 'text/plain' };
  } catch { /* binary data, not text */ }

  return { subtype: BinarySubtype.UNKNOWN, mime: 'application/octet-stream' };
}

// --- Public router ---

export function routeData(response: ApiResponse): RoutedData {
  // TEXT path — field `transcription` present
  if (response.transcription !== undefined) {
    const text = response.transcription.trim();
    if (text.length < MIN_TEXT_LENGTH) {
      logger.debug('Short transcription → noise', { text });
      return { type: DataType.NOISE };
    }
    return { type: DataType.TEXT, transcription: text };
  }

  // BINARY path — field `attachment` present
  if (response.attachment !== undefined) {
    if (response.filesize && response.filesize > MAX_BINARY_SIZE) {
      logger.warn('Binary too large, skipping', { filesize: response.filesize });
      return { type: DataType.NOISE };
    }

    // 1. Try the `meta` field first (free, no decoding needed)
    if (response.meta) {
      const fromMeta = detectFromMeta(response.meta);
      if (fromMeta) {
        logger.debug('MIME from meta', { mime: fromMeta.mime, subtype: fromMeta.subtype });
        const buf = Buffer.from(response.attachment, 'base64');
        return {
          type:         DataType.BINARY,
          subtype:      fromMeta.subtype,
          binaryBuffer: buf,
          mimeType:     fromMeta.mime,
          filesize:     response.filesize,
        };
      }
    }

    // 2. Fallback: magic bytes after decoding
    const buf = Buffer.from(response.attachment, 'base64');
    const fromMagic = detectFromMagicBytes(buf);
    logger.debug('MIME from magic bytes', { mime: fromMagic.mime, subtype: fromMagic.subtype });
    return {
      type:         DataType.BINARY,
      subtype:      fromMagic.subtype,
      binaryBuffer: buf,
      mimeType:     fromMagic.mime,
      filesize:     response.filesize,
    };
  }

  // NOISE path — no useful payload
  logger.debug('No payload → noise', { code: response.code, message: response.message });
  return { type: DataType.NOISE };
}
