import axios from 'axios';
import { ExtractedInfo } from '../types';
import { logger } from '../logger';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.0-flash-001';

const SYSTEM_PROMPT = `Jesteś ekspertem analizy wywiadowczej. Analizujesz obrazy zawierające informacje o tajnym mieście zwanym "Syjon".

Wyekstrahuj następujące dane (tylko jeśli są widoczne na obrazie):
- cityName: prawdziwa nazwa miasta zwanego "Syjonem"
- cityArea: powierzchnia miasta w km² jako liczba dziesiętna (format "12.34")
- warehousesCount: liczba magazynów w mieście/na Syjonie (liczba całkowita)
- phoneNumber: numer telefonu osoby kontaktowej (same cyfry, bez spacji i myślników)

Odpowiedz WYŁĄCZNIE w formacie JSON — bez żadnego tekstu poza JSON:
{
  "cityName": "NazwaMiasta",
  "cityArea": "12.34",
  "warehousesCount": 123,
  "phoneNumber": "123456789",
  "description": "krótki opis zawartości obrazu"
}

Dla nieobecnych danych użyj null. Nie wymyślaj danych.`;

export async function analyzeImage(buffer: Buffer, mimeType: string): Promise<ExtractedInfo> {
  logger.debug('ImageAnalyst: analyzing', { mimeType, sizeBytes: buffer.length });

  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  try {
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text',      text: 'Przeanalizuj ten obraz i wyekstrahuj informacje o mieście Syjon.' },
            ],
          },
        ],
        temperature: 0,
        max_tokens:  512,
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
      logger.warn('ImageAnalyst: no JSON in response', { content });
      return {};
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.description) logger.info('Image description', { description: parsed.description });

    const info: ExtractedInfo = {};
    if (parsed.cityName)
      info.cityName = String(parsed.cityName);
    if (parsed.cityArea != null)
      info.cityArea = String(parsed.cityArea);
    if (parsed.warehousesCount != null)
      info.warehousesCount = Number(parsed.warehousesCount);
    if (parsed.phoneNumber != null)
      info.phoneNumber = String(parsed.phoneNumber).replace(/\D/g, '');

    logger.info('ImageAnalyst extracted', info);
    return info;
  } catch (err) {
    logger.error('ImageAnalyst failed', { error: String(err) });
    return {};
  }
}
