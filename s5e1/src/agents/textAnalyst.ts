import axios from 'axios';
import { ExtractedInfo } from '../types';
import { logger } from '../logger';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-haiku-4-5';

const SYSTEM_PROMPT = `Jesteś ekspertem analizy wywiadowczej. Ekstrahujesz konkretne informacje z przechwyconych komunikatów radiowych dotyczących tajnego miasta nazywanego "Syjon".

"Syjon" to KRYPTONIM konkretnego miasta. Szukaj w tekście WYRAŹNYCH wskazówek, które miasto kryje się pod tą nazwą:
- frazy: "[miasto] to Syjon", "mówią na [miasto] Syjon", "[miasto] jest jak raj biblijny / jak Syjon"
- kontekst: miasto opisane jako "biblijny raj", "raj", "obiecana ziemia" → to właśnie Syjon

Wyekstrahuj następujące dane (TYLKO jeśli są WYRAŹNIE obecne — nie zgaduj):
- cityName: prawdziwa nazwa miasta zwanego "Syjonem". WAŻNE: zawsze zwracaj formę MIANOWNIKOWĄ (słownikową), np. "Skarszewy" a NIE "Skarszewach" ani "Skarszewami". Sprawdź nominatyw polskich nazw.
- cityArea: powierzchnia miasta w km² jako liczba (format "12.34")
- warehousesCount: AKTUALNA liczba magazynów. "mamy X magazynów" = X. "planujemy wybudować X. magazyn" lub "planujemy wybudować X magazyn (kolejny)" = aktualnie mają X-1 (budują X-ty). Zawsze podaj ile TERAZ mają, nie ile planują.
- phoneNumber: numer telefonu osoby kontaktowej — WYŁĄCZNIE jeśli to wyraźnie telefon, MINIMUM 7 cyfr. Ciąg cyfr z szumu radiowego ("cztery-siedem-dwa", "472") to NIE jest numer telefonu.

Odpowiedz WYŁĄCZNIE w formacie JSON — bez żadnego tekstu poza JSON:
{
  "cityName": "NazwaMiasta",
  "cityArea": "12.34",
  "warehousesCount": 123,
  "phoneNumber": "123456789"
}

Dla nieobecnych lub niepewnych danych użyj null. Nie wymyślaj danych.`;

export async function analyzeText(transcription: string): Promise<ExtractedInfo> {
  logger.debug('TextAnalyst: analyzing', { length: transcription.length, content: transcription });

  try {
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: transcription },
        ],
        temperature: 0,
        max_tokens:  256,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    );

    const content: string = res.data.choices[0]?.message?.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('TextAnalyst: no JSON in response', { content });
      return {};
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const info: ExtractedInfo = {};

    if (parsed.cityName)
      info.cityName = String(parsed.cityName);
    if (parsed.cityArea != null)
      info.cityArea = String(parsed.cityArea);
    if (parsed.warehousesCount != null)
      info.warehousesCount = Number(parsed.warehousesCount);
    if (parsed.phoneNumber != null)
      info.phoneNumber = String(parsed.phoneNumber).replace(/\D/g, '');

    logger.info('TextAnalyst extracted', info);
    return info;
  } catch (err) {
    logger.error('TextAnalyst failed', { error: String(err) });
    return {};
  }
}
