/** Escaped JSON string size in UTF-8, stopping as soon as the byte budget is exceeded. */
export function jsonStringSize(text: string, budget: number): number {
  if (text.length + 2 > budget) return budget + 1;
  let bytes = 2;
  for (let index = 0; index < text.length && bytes <= budget; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit < 0x20)
      bytes += unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 2 : 6;
    else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
