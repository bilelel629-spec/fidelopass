import type { APIRoute } from 'astro';
import JsBarcode from 'jsbarcode';
import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom';

const SUPPORTED_FORMATS = new Set(['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF14', 'MSI', 'pharmacode']);

export const GET: APIRoute = async ({ url }) => {
  const data = (url.searchParams.get('data') ?? '').trim();
  const format = (url.searchParams.get('format') ?? 'CODE128').toUpperCase();

  if (!data || data.length > 200) {
    return new Response('Code invalide', { status: 400 });
  }

  const barcodeFormat = SUPPORTED_FORMATS.has(format) ? format : 'CODE128';

  try {
    const document = new DOMImplementation().createDocument('http://www.w3.org/1999/xhtml', 'html', null);
    const svgNode = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    JsBarcode(svgNode, data, {
      format: barcodeFormat,
      width: 2,
      height: 80,
      displayValue: false,
      margin: 8,
      lineColor: '#0f172a',
      background: '#ffffff',
      xmlDocument: document as unknown as XMLDocument,
    });

    const serializer = new XMLSerializer();
    const svg = serializer.serializeToString(svgNode);

    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response('Erreur de génération du code-barres', { status: 500 });
  }
};
