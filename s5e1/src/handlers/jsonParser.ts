import { CityData, ExtractedInfo } from '../types';
import { logger } from '../logger';

export function parseJsonBinary(buffer: Buffer): ExtractedInfo {
  let text: string;
  try {
    text = buffer.toString('utf8');
  } catch {
    logger.warn('JsonParser: buffer is not valid UTF-8');
    return {};
  }

  logger.debug('JsonParser: parsing', { content: text });

  // Try JSON first
  try {
    const parsed = JSON.parse(text);
    return extractFromObject(parsed);
  } catch { /* not JSON */ }

  // Try XML / free-form text
  if (text.trimStart().startsWith('<')) {
    return extractFromXml(text);
  }

  return extractFromText(text);
}

// --- JSON: array of city objects ---

function extractFromObject(obj: unknown): ExtractedInfo {
  const info: ExtractedInfo = {};

  if (Array.isArray(obj)) {
    const cityList: CityData[] = [];
    for (const item of obj) {
      if (typeof item !== 'object' || item === null) continue;
      const it = item as Record<string, unknown>;

      const name = String(it.name ?? it.miasto ?? it.city ?? '').trim();
      const areaRaw = it.occupiedArea ?? it.area ?? it.powierzchnia ?? it.km2;
      if (!name || areaRaw == null) continue;

      const area = parseFloat(String(areaRaw));
      if (isNaN(area) || area <= 0) continue;

      const city: CityData = { name, area: area.toFixed(2) };

      // Capture optional warehouses field under various names
      const wRaw = it.warehouses ?? it.warehouseCount ?? it.magazyny
        ?? it.magazynow ?? it.liczba_magazynow ?? it.storage ?? it.storageUnits;
      if (wRaw != null) {
        const w = parseInt(String(wRaw));
        if (!isNaN(w)) city.warehouses = w;
      }

      // Capture optional phone field
      const pRaw = it.phone ?? it.telefon ?? it.contact ?? it.contactPhone;
      if (pRaw != null) {
        const digits = String(pRaw).replace(/\D/g, '');
        if (digits.length >= 7) city.phone = digits;
      }

      cityList.push(city);
    }

    if (cityList.length > 0) {
      logger.info(`JsonParser: city list (${cityList.length} cities)`, cityList.slice(0, 5));
      info.cityList = cityList;
    }
  }

  // Flat key scan for other fields
  const flat = flattenObject(obj);
  for (const [key, value] of Object.entries(flat)) {
    if (value == null) continue;
    const k = key.toLowerCase();
    const v = String(value).trim();

    if (!info.cityArea && !info.cityList && (k.includes('area') || k.includes('powierzch'))) {
      const num = parseFloat(v.replace(',', '.'));
      if (!isNaN(num) && num > 0) info.cityArea = num.toFixed(2);
    }
    if (info.warehousesCount == null
      && (k.includes('warehouse') || k.includes('magazyn') || k.includes('storage'))) {
      const num = parseInt(v);
      if (!isNaN(num)) info.warehousesCount = num;
    }
    if (!info.phoneNumber && (k.includes('phone') || k.includes('telefon') || k.includes('tel'))) {
      const digits = v.replace(/\D/g, '');
      if (digits.length >= 7) info.phoneNumber = digits;
    }
  }

  const { cityList, ...rest } = info;
  logger.info('JsonParser (JSON) extracted', { cities: cityList?.length, ...rest });
  return info;
}

// --- XML: regex-based extraction ---

function extractFromXml(text: string): ExtractedInfo {
  const info: ExtractedInfo = {};

  // Helper to find any tag value
  const tag = (name: string): string | null => {
    const m = text.match(new RegExp(`<${name}[^>]*>([^<]+)</${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };

  // Warehouse count: <warehouses>12</warehouses> or <magazyny>12</magazyny>
  const wTag = tag('warehouses') ?? tag('warehouseCount') ?? tag('magazyny')
    ?? tag('magazynow') ?? tag('liczba_magazynow') ?? tag('storageUnits') ?? tag('storage');
  if (wTag) {
    const n = parseInt(wTag);
    if (!isNaN(n)) info.warehousesCount = n;
  }

  // Phone
  const pTag = tag('phone') ?? tag('telefon') ?? tag('contactPhone') ?? tag('tel');
  if (pTag) {
    const digits = pTag.replace(/\D/g, '');
    if (digits.length >= 7) info.phoneNumber = digits;
  }

  // Area
  const aTag = tag('area') ?? tag('occupiedArea') ?? tag('powierzchnia');
  if (aTag) {
    const n = parseFloat(aTag.replace(',', '.'));
    if (!isNaN(n) && n > 0) info.cityArea = n.toFixed(2);
  }

  // NOTE: cityName NOT extracted from XML — requires LLM context (which city = Syjon)

  logger.info('JsonParser (XML) extracted', info);
  return info;
}

// --- Free-text: regex extraction ---

function extractFromText(text: string): ExtractedInfo {
  const info: ExtractedInfo = {};

  const phoneMatch =
    text.match(/(?:tel(?:efon)?|phone|contact)[^\d]{0,10}(\+?\d[\d\s\-]{6,14}\d)/i) ??
    text.match(/\b(\d{9})\b/) ??
    text.match(/\b(\+\d{11,13})\b/);
  if (phoneMatch) info.phoneNumber = phoneMatch[1].replace(/\D/g, '');

  const areaMatch =
    text.match(/(\d+[.,]\d+)\s*km[²2]/i) ??
    text.match(/powierzchni[a-z]*\s*[:\-]?\s*(\d+[.,]\d+)/i);
  if (areaMatch) info.cityArea = parseFloat(areaMatch[1].replace(',', '.')).toFixed(2);

  // Warehouse: look for "X magazynów" / "magazyny: X" but NOT "wybudować X" (future plan)
  // "mamy X magazyn" = have X warehouses (current count)
  const haveMatch = text.match(/mamy\s+(\d+)\s+magazyn/i)
    ?? text.match(/(\d+)\s+magazyn[óo]w/i)
    ?? text.match(/magazyn[a-z]*\s*[:\-]\s*(\d+)/i);
  if (haveMatch) info.warehousesCount = parseInt(haveMatch[1]);

  logger.info('JsonParser (text) extracted', info);
  return info;
}

// --- Helper ---

function flattenObject(obj: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof obj !== 'object' || obj === null) {
    if (prefix) result[prefix] = obj;
    return result;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}
