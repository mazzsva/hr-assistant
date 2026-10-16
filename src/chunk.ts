const MAX_CHARACTERS = 1200;

export function chunkMarkdown(markdown: string): string[] {
  const sections = markdown
    .split(/\n(?=#{1,3} )/g)
    .map((section) => section.trim())
    .filter(Boolean)
    // A heading-only section retrieves on title words and wastes a top-k slot.
    .filter((section) => section.split("\n").some((line) => !line.startsWith("#")));

  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= MAX_CHARACTERS) {
      chunks.push(section);
      continue;
    }
    // Every part repeats the heading, so a cited part still names its section.
    const heading = section.split("\n", 1)[0] ?? "";
    const body = section.slice(heading.length).trim();
    for (const part of packParagraphs(body, MAX_CHARACTERS - heading.length - 2)) {
      chunks.push(`${heading}\n\n${part}`);
    }
  }
  return chunks;
}

// A single paragraph longer than the limit stays whole, so the limit is soft.
function packParagraphs(text: string, limit: number): string[] {
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
