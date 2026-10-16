import type { ContentText } from 'pdfmake/interfaces';
import unifontUrl from './assets/fonts/unifont-18.0.01.otf.gz?url';
import upperUrl from './assets/fonts/unifont_upper-18.0.01.otf.gz?url';

export function shoppingPdfText(value: string): ContentText {
  const runs: { text: string; font: string }[] = [];
  for (const character of value) {
    const code = character.codePointAt(0)!;
    // Keep Roboto's Latin repertoire; use Unifont for BMP and upper-plane glyphs.
    const font =
      code <= 0x024f ? 'Roboto' : code <= 0xffff ? 'Unifont' : 'UnifontUpper';
    const last = runs.at(-1);
    if (last?.font === font) last.text += character;
    else runs.push({ text: character, font });
  }
  return { text: runs };
}

async function fontData(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The PDF font could not be loaded.');
  let buffer = await response.arrayBuffer();
  const header = new Uint8Array(buffer, 0, 2);
  // Static hosts may already decode a .gz asset through Content-Encoding.
  if (header[0] === 0x1f && header[1] === 0x8b)
    buffer = await new Response(
      new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(chunks.join(''));
}

export async function shoppingPdfFallbackFonts(): Promise<
  Record<string, string>
> {
  const [unifont, upper] = await Promise.all([
    fontData(unifontUrl),
    fontData(upperUrl),
  ]);
  return { 'Unifont.otf': unifont, 'UnifontUpper.otf': upper };
}
