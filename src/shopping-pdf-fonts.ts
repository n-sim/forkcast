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

/** Text outside Roboto's Latin repertoire needs the Unifont fallback fonts. */
function needsFallbackFonts(texts: Iterable<string>): boolean {
  for (const text of texts) if (/[^\u0000-ɏ]/u.test(text)) return true;
  return false;
}

/**
 * Loads pdfmake with Roboto, adding the Unifont fallback fonts only when some
 * of the given texts need them (they are large, so they load on demand).
 */
export async function loadPdfMake(texts: Iterable<string>) {
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  pdfMake.addVirtualFileSystem(fonts);
  if (needsFallbackFonts(texts)) {
    pdfMake.addVirtualFileSystem(await shoppingPdfFallbackFonts());
    // Unifont has one face; bold or italic text (such as a title) uses it too.
    const face = (file: string) => ({
      normal: file,
      bold: file,
      italics: file,
      bolditalics: file,
    });
    pdfMake.addFonts({
      Unifont: face('Unifont.otf'),
      UnifontUpper: face('UnifontUpper.otf'),
    });
  }
  return pdfMake;
}
