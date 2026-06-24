export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Removes lone surrogates — characters that can't be encoded as UTF-8 and
// cause Telegram's sendMessage to return 400.
export function sanitizeText(str: string): string {
  return str.replace(/[\uD800-\uDFFF]/g, (ch, i: number, s: string) => {
    const code = ch.charCodeAt(0);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) return ch;
    } else {
      const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
      if (prev >= 0xD800 && prev <= 0xDBFF) return ch;
    }
    return "";
  });
}

// Truncates at Unicode code-point boundaries (not UTF-16 code units), so
// emoji at the cut point are never split into lone surrogates.
export function truncateText(str: string, maxCodePoints: number): string {
  const points = [...str];
  if (points.length <= maxCodePoints) return str;
  return points.slice(0, maxCodePoints).join("") + "…";
}
