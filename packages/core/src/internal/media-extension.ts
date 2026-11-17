import { mediaTypeEssence } from './media-type';

const MIME_EXT = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.m4a'],
]);

/** A known media type's file extension; callers own their unknown-type fallback. */
export function mediaExtension(contentType: string): string | undefined {
  return MIME_EXT.get(mediaTypeEssence(contentType));
}
