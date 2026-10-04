export type ParsedPage = {
  pageNumber: number;
  markdown: string;
  imageRefs: string[];
};

export type ParsedDocument = {
  markdown: string;
  pages: ParsedPage[];
  metadata: Record<string, unknown>;
};

/**
 * Canonical document parsing boundary. Implementations may read an existing
 * PDF text layer, perform OCR, reconstruct layout, or call a hosted parser.
 * Downstream jobs consume only ParsedDocument and should not care which path
 * produced it.
 */
export interface DocumentParser {
  readonly name: string;
  parseDocument(input: { filename: string; bytes: Buffer }): Promise<ParsedDocument>;
}

/**
 * @deprecated Historical name retained while provider configuration and admin
 * surfaces still use `OCR_PROVIDER`. New pipeline code should say
 * DocumentParser/parser rather than assuming every parse operation performs
 * OCR.
 */
export type OcrProvider = DocumentParser;
