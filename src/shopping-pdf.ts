import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatQuantity, unitLabels } from './domain';
import type { ShoppingItem, ShoppingList } from './shopping';
import { loadPdfMake, shoppingPdfText } from './shopping-pdf-fonts';
import type { GeneratedFile } from './share';

function groceries(title: string, items: ShoppingItem[]): Content[] {
  return [
    { text: title, style: 'section' },
    items.length
      ? {
          table: {
            widths: [16, '*', 'auto'],
            headerRows: 1,
            body: [
              [
                '',
                { text: 'Item', bold: true },
                { text: 'Quantity', bold: true },
              ],
              ...items.map((item) => [
                {
                  canvas: [
                    {
                      type: 'rect' as const,
                      x: 0,
                      y: 2,
                      w: 10,
                      h: 10,
                      lineWidth: 0.75,
                    },
                  ],
                },
                shoppingPdfText(item.name),
                `${formatQuantity(item.quantity)} ${unitLabels[item.unit]}`,
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
        }
      : { text: 'No items.', color: '#555555' },
  ];
}

/** Generates the shopping list as a PDF, ready to save or share. */
export async function createShoppingPdf(
  list: ShoppingList,
): Promise<GeneratedFile> {
  const pdfMake = await loadPdfMake([
    ...[...list.items, ...list.manualItems].map((item) => item.name),
    ...list.contributions.map((source) => source.recipeName),
  ]);
  const document: TDocumentDefinitions = {
    info: { title: 'Forkcast shopping list', author: 'Forkcast' },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 12 },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 12] },
      section: { fontSize: 15, bold: true, margin: [0, 20, 0, 10] },
    },
    footer: (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: 'center',
      fontSize: 10,
      margin: [0, 16, 0, 0],
    }),
    content: [
      { text: 'Forkcast shopping list', style: 'title' },
      `Cooking period: ${list.startDate} through ${list.endDate} (inclusive).`,
      ...groceries('Generated requirements', list.items),
      ...groceries('Manual shopping items', list.manualItems),
      { text: 'Recipe contributions', style: 'section' },
      ...list.contributions.map((source) => ({
        text: [
          shoppingPdfText(source.recipeName),
          ` — ${source.cookingDate}, ${source.portions} portions`,
        ],
        margin: [0, 0, 0, 6] as [number, number, number, number],
      })),
      ...(list.contributions.length
        ? []
        : [{ text: 'No recipe contributions.' }]),
    ],
  };
  return {
    name: `forkcast-shopping-${list.startDate}-to-${list.endDate}.pdf`,
    bytes: await pdfMake.createPdf(document).getBuffer(),
    type: 'application/pdf',
    title: `Shopping list ${list.startDate} to ${list.endDate}`,
  };
}
