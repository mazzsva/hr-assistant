const MAX_CHARACTERS = 1200;

export function chunkMarkdown(markdown: string): string[] {
  const sections = markdown
    .split(/\n(?=#{1,3} )/g)
    .map((section) => section.trim())
    .filter(Boolean)
    // A document title with no body of its own splits into a heading-only
    // section. It retrieves on title words and wastes a top-k slot.
    .filter((section) => section.split("\n").some((line) => !line.startsWith("#")));

  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= MAX_CHARACTERS) {
      chunks.push(section);
      continue;
    }
    // Keep the heading on every split so a chunk still names its own policy.
    const heading = section.split("\n", 1)[0] ?? "";
    const body = section.slice(heading.length).trim();
    for (const part of splitByLength(body, MAX_CHARACTERS - heading.length - 1)) {
      chunks.push(`${heading}\n${part}`);
    }
  }
  return chunks;
}

function splitByLength(text: string, limit: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const parts: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > limit) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}
