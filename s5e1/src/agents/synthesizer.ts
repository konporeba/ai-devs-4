import axios from 'axios';
import { ExtractedInfo } from '../types';
import { logger } from '../logger';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-haiku-4-5';

/**
 * Targeted synthesis: given all raw text and the list of fields to determine,
 * asks the LLM to provide the best answer. Can be called with rejection feedback.
 */
export async function synthesizeMissingFields(
  rawTexts: string[],
  known: ExtractedInfo,
  missingFields: string[],
  rejectedValues?: Partial<Record<string, unknown>>,
): Promise<ExtractedInfo> {
  const combined = rawTexts.join('\n\n---\n\n').slice(0, 12000); // token budget guard

  const fieldDescriptions: Record<string, string> = {
    cityName:        'prawdziwa nazwa miasta zwanego "Syjonem" (mianownik, bez polskich znaków diakrytycznych)',
    cityArea:        'powierzchnia Syjonu w km² (format "12.34")',
    warehousesCount: 'AKTUALNA liczba magazynów na Syjonie (liczba całkowita). "mamy X magazynów" = X. "planujemy wybudować X. magazyn" LUB "planujemy wybudować X magazyn (kolejny)" = aktualnie mają X-1 (budują X-ty). Np. "planujemy wybudować 12 magazyn" = MAJĄ 11. Zawsze podaj ile TERAZ jest, nie ile planują.',
    phoneNumber:     'numer telefonu kontaktowego do Syjonu (9+ cyfr, NIE ciągi z szumu radiowego)',
  };

  const requestedFields = missingFields
    .map(f => `- ${f}: ${fieldDescriptions[f] ?? f}`)
    .join('\n');

  const knownInfo = Object.entries(known)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k} = ${v}`)
    .join(', ');

  const rejectionNote = rejectedValues && Object.keys(rejectedValues).length > 0
    ? `\nODRZUCONE wartości (NIE używaj tych): ${JSON.stringify(rejectedValues)}\n`
    : '';

  const prompt = `Jesteś analitykiem wywiadu. Masz zestaw przechwyconych komunikatów radiowych z post-apokaliptycznego świata.

Znane już dane: ${knownInfo || 'brak'}
${rejectionNote}
ZADANIE: Na podstawie poniższych tekstów ustal WYŁĄCZNIE te pola:
${requestedFields}

WAŻNE zasady:
- "Syjon" to kryptonim konkretnego miasta — szukaj wskazówek które miasto to jest
- Miasto opisane jako "biblijny raj" → to właśnie Syjon
- cityName: TYLKO bez polskich znaków diakrytycznych (ą→a, ę→e, ó→o, ź→z, itp.)
- warehousesCount: "planujemy wybudować 12 magazyn" lub "planujemy wybudować 12. magazyn" = aktualnie mają 11 (budują 12-ty). Zawsze podaj ile TERAZ jest.
- Zwróć TYLKO JSON, bez komentarzy

Format odpowiedzi (null dla nieznanych):
{
  "cityName": null,
  "cityArea": null,
  "warehousesCount": null,
  "phoneNumber": null
}

--- ZEBRANE MATERIAŁY ---
${combined}`;

  try {
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 256,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 45_000,
      }
    );

    const content: string = res.data.choices[0]?.message?.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Synthesizer: no JSON in response', { content });
      return {};
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const info: ExtractedInfo = {};

    // Only populate fields that were requested
    if (missingFields.includes('cityName') && parsed.cityName)
      info.cityName = String(parsed.cityName);
    if (missingFields.includes('cityArea') && parsed.cityArea != null)
      info.cityArea = String(parsed.cityArea);
    if (missingFields.includes('warehousesCount') && parsed.warehousesCount != null)
      info.warehousesCount = Number(parsed.warehousesCount);
    if (missingFields.includes('phoneNumber') && parsed.phoneNumber != null) {
      const digits = String(parsed.phoneNumber).replace(/\D/g, '');
      if (digits.length >= 7) info.phoneNumber = digits;
    }

    logger.info('Synthesizer extracted', info);
    return info;
  } catch (err) {
    logger.error('Synthesizer failed', { error: String(err) });
    return {};
  }
}
