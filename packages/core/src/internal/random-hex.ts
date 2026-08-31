/** Random bytes as lowercase hex, available on HTTP origins as well as secure contexts. */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let hex = '';
  for (const byte of arr) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
