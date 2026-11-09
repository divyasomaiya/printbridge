import { PrinterCapability, DocumentFormat, PrintSettings } from './types.js';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const LEASE_DURATION_SECONDS = 120; // 2 minutes lease per claim
export const JOB_EXPIRATION_HOURS = 24;

/**
 * HP LaserJet Professional M1136 MFP capability profile.
 * Physical hardware characteristics:
 * - Monochrome laser printer (Grayscale only)
 * - Single-sided printing only (No auto-duplex hardware)
 * - Supported paper: A4, Letter, Legal
 * - Max copies: 99
 * - Manual duplex requires physical human paper re-insertion and is NOT unattended.
 * Note: Configurable UNC share path, defaulting to standard shared office printer name.
 */
export const HP_LASERJET_M1136_CAPABILITY: PrinterCapability = {
  id: 'hp-laserjet-m1136',
  name: 'HP LaserJet Professional M1136 MFP',
  host: 'OFFICE-HOST',
  shareName: 'HP LaserJet Professional M1136 MFP',
  fullUncPath: '\\\\OFFICE-HOST\\HP LaserJet Professional M1136 MFP',
  isOnline: true,
  supportsColor: false,
  supportsAutoDuplex: false,
  supportsManualDuplex: true,
  supportedPaperSizes: ['a4', 'letter', 'legal'],
  maxCopies: 99,
  description: 'Shared monochrome office laser printer on office host'
};

export const MOCK_PRINTER_CAPABILITY: PrinterCapability = {
  id: 'mock-printer-test',
  name: 'PrintBridge Mock Diagnostic Printer',
  host: 'GATEWAY-LOCAL',
  shareName: 'MockPrinter',
  fullUncPath: 'MockPrinter',
  isOnline: true,
  supportsColor: true,
  supportsAutoDuplex: true,
  supportsManualDuplex: true,
  supportedPaperSizes: ['a4', 'letter', 'legal'],
  maxCopies: 99,
  description: 'In-memory diagnostic mock printer for testing and dry runs'
};

export const SUPPORTED_EXTENSIONS_MAP: Record<string, DocumentFormat> = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.rtf': 'rtf',
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.csv': 'csv',
  '.ppt': 'ppt',
  '.pptx': 'pptx',
  '.jpg': 'jpg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.bmp': 'bmp',
  '.webp': 'webp',
  '.tif': 'tif',
  '.tiff': 'tiff',
  '.txt': 'txt',
  '.htm': 'html',
  '.html': 'html'
};

export const MIME_TYPE_MAP: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  html: 'text/html'
};

/**
 * Validates print settings against target printer capabilities.
 * Returns null if valid, or a descriptive error message.
 */
export function validatePrintSettings(settings: PrintSettings, printer: PrinterCapability): { isValid: boolean; error?: string; warning?: string } {
  if (settings.copies < 1 || settings.copies > printer.maxCopies) {
    return { isValid: false, error: `Copies must be between 1 and ${printer.maxCopies}.` };
  }

  if (settings.colorMode === 'color' && !printer.supportsColor) {
    return { isValid: false, error: `Printer '${printer.name}' does not support color printing. Only grayscale is available.` };
  }

  if (settings.duplex !== 'simplex') {
    if ((settings.duplex === 'duplex_long_edge' || settings.duplex === 'duplex_short_edge') && !printer.supportsAutoDuplex) {
      return { isValid: false, error: `Printer '${printer.name}' does not support automatic duplex. Only single-sided printing is unattended.` };
    }
  }

  if (!printer.supportedPaperSizes.includes(settings.paperSize)) {
    return { isValid: false, error: `Paper size '${settings.paperSize.toUpperCase()}' is not supported by printer '${printer.name}'.` };
  }

  let warning: string | undefined;
  if (settings.duplex === 'manual_duplex') {
    warning = 'Manual duplex requires human intervention at the printer to flip pages. It will not be printed unattended.';
  }

  return { isValid: true, warning };
}

/**
 * Parses page ranges such as "1-3, 5, 8-10" and handles 'all', 'odd', 'even'
 * Returns an array of 1-based page indices to print, or null if invalid.
 */
export function resolvePageNumbers(
  rangeType: PrintSettings['pageRangeType'],
  customRanges: string | undefined,
  totalPages: number
): { success: boolean; pages: number[]; error?: string } {
  if (totalPages <= 0) {
    return { success: false, pages: [], error: 'Document has no pages.' };
  }

  if (rangeType === 'all') {
    const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    return { success: true, pages };
  }

  if (rangeType === 'odd') {
    const pages: number[] = [];
    for (let i = 1; i <= totalPages; i += 2) pages.push(i);
    return { success: true, pages };
  }

  if (rangeType === 'even') {
    const pages: number[] = [];
    for (let i = 2; i <= totalPages; i += 2) pages.push(i);
    if (pages.length === 0) {
      return { success: false, pages: [], error: 'Document has only 1 page; no even pages exist.' };
    }
    return { success: true, pages };
  }

  if (rangeType === 'custom') {
    if (!customRanges || customRanges.trim() === '') {
      return { success: false, pages: [], error: 'Custom page range cannot be empty.' };
    }

    const pagesSet = new Set<number>();
    const parts = customRanges.split(',').map(p => p.trim()).filter(Boolean);

    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        const pageNum = parseInt(part, 10);
        if (pageNum < 1 || pageNum > totalPages) {
          return { success: false, pages: [], error: `Page ${pageNum} is out of document bounds (1-${totalPages}).` };
        }
        pagesSet.add(pageNum);
      } else if (/^\d+\s*-\s*\d+$/.test(part)) {
        const [startStr, endStr] = part.split('-').map(s => s.trim());
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (start > end) {
          return { success: false, pages: [], error: `Invalid range '${part}': start page must be <= end page.` };
        }
        if (start < 1 || end > totalPages) {
          return { success: false, pages: [], error: `Range '${part}' exceeds document bounds (1-${totalPages}).` };
        }
        for (let i = start; i <= end; i++) {
          pagesSet.add(i);
        }
      } else {
        return { success: false, pages: [], error: `Invalid page range syntax: '${part}'. Use numbers or ranges like 1-5.` };
      }
    }

    const sortedPages = Array.from(pagesSet).sort((a, b) => a - b);
    if (sortedPages.length === 0) {
      return { success: false, pages: [], error: 'No valid pages selected.' };
    }

    return { success: true, pages: sortedPages };
  }

  return { success: false, pages: [], error: 'Unknown page range type.' };
}

/**
 * Validates file extension, magic bytes, and size.
 */
export function validateUploadedFile(
  filename: string,
  sizeBytes: number,
  headerBytes?: Uint8Array
): { isValid: boolean; format?: DocumentFormat; error?: string } {
  if (sizeBytes <= 0) {
    return { isValid: false, error: 'File is empty.' };
  }

  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return { isValid: false, error: `File size exceeds maximum allowed limit (${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB).` };
  }

  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx === -1) {
    return { isValid: false, error: 'File has no extension.' };
  }

  const ext = filename.substring(dotIdx).toLowerCase();
  const format = SUPPORTED_EXTENSIONS_MAP[ext];
  if (!format) {
    return { isValid: false, error: `Unsupported file extension '${ext}'. Supported extensions: ${Object.keys(SUPPORTED_EXTENSIONS_MAP).join(', ')}` };
  }

  // Validate magic bytes if provided
  if (headerBytes && headerBytes.length >= 4) {
    if (format === 'pdf') {
      // %PDF- (0x25 0x50 0x44 0x46)
      if (headerBytes[0] !== 0x25 || headerBytes[1] !== 0x50 || headerBytes[2] !== 0x44 || headerBytes[3] !== 0x46) {
        return { isValid: false, error: 'File content does not match standard PDF header magic bytes.' };
      }
    } else if (format === 'png') {
      // 0x89 0x50 0x4E 0x47
      if (headerBytes[0] !== 0x89 || headerBytes[1] !== 0x50 || headerBytes[2] !== 0x4E || headerBytes[3] !== 0x47) {
        return { isValid: false, error: 'File content does not match PNG magic bytes.' };
      }
    } else if (format === 'jpg' || format === 'jpeg') {
      // 0xFF 0xD8 0xFF
      if (headerBytes[0] !== 0xFF || headerBytes[1] !== 0xD8 || headerBytes[2] !== 0xFF) {
        return { isValid: false, error: 'File content does not match JPEG magic bytes.' };
      }
    } else if (format === 'bmp') {
      // BM (0x42 0x4D)
      if (headerBytes[0] !== 0x42 || headerBytes[1] !== 0x4D) {
        return { isValid: false, error: 'File content does not match BMP magic bytes.' };
      }
    } else if (format === 'tif' || format === 'tiff') {
      // II (0x49 0x49 0x2A 0x00) or MM (0x4D 0x4D 0x00 0x2A)
      const isLittleEndian = headerBytes[0] === 0x49 && headerBytes[1] === 0x49 && headerBytes[2] === 0x2A;
      const isBigEndian = headerBytes[0] === 0x4D && headerBytes[1] === 0x4D && headerBytes[2] === 0x00 && headerBytes[3] === 0x2A;
      if (!isLittleEndian && !isBigEndian) {
        return { isValid: false, error: 'File content does not match TIFF magic bytes.' };
      }
    } else if (format === 'docx' || format === 'xlsx' || format === 'pptx') {
      // ZIP header PK (0x50 0x4B 0x03 0x04)
      if (headerBytes[0] !== 0x50 || headerBytes[1] !== 0x4B) {
        return { isValid: false, error: `File content for OpenXML format ${format.toUpperCase()} does not match ZIP package header.` };
      }
    }
  }

  return { isValid: true, format };
}
