export function normalizeKey(key: string): string {
  // O retry do incidente inclui um espaço de largura zero (U+200B), que trim não remove.
  return key.replace(/\u200B/g, "").trim().toLowerCase();
}
