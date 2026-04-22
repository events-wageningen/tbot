/** Convert an event name + year into a URL-safe event ID. */
export function toEventId(name: string, year: number): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // strip diacritics (é → e, etc.)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") +
    "-" +
    year
  );
}
