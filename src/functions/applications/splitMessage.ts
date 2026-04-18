export function splitMessage(content: string, maxLength = 2000): string[] {
  if (content.length <= maxLength) return [content];

  const parts: string[] = [];
  let remaining = content;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }
    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}
