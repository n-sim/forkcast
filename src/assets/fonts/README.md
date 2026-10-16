# Shopping PDF fallback fonts

The gzip files contain unmodified GNU Unifont 18.0.01 OpenType fonts. They provide
fallback glyphs for grocery and recipe names outside the bundled Roboto font's
Latin coverage, including Chinese text and supplementary characters such as emoji.
They are loaded during PDF export when needed and included in the offline cache.

Original downloads:

- [unifont-18.0.01.otf](https://unifoundry.com/pub/unifont/unifont-18.0.01/font-builds/unifont-18.0.01.otf)
- [unifont_upper-18.0.01.otf](https://unifoundry.com/pub/unifont/unifont-18.0.01/font-builds/unifont_upper-18.0.01.otf)

The font files are dual licensed; Forkcast distributes them under the SIL Open Font
License 1.1. The original copyright and license metadata remain embedded. The full
upstream license is also distributed in [UNIFONT-LICENSE.txt](../../../public/fonts/UNIFONT-LICENSE.txt).
Unifont is a fallback font; complex-script shaping and combined emoji sequences
remain limited by its glyph designs.

To reproduce the compressed assets, gzip each original OpenType file at level 9
without changing the font contents. No font subsetting or other modification is
applied to these bundled source assets; PDF generation embeds the glyphs it uses.
