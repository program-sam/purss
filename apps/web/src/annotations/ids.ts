/** Annotation ids are made on the device so a highlight can be created offline: `ann_` + 10 time and 16 random characters, like every product id. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newAnnotationId(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `ann_${time}${rand}`;
}
