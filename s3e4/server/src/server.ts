/**
 * S3E4 Negotiations - Item Search Tool Server
 *
 * Architecture: Single-tool API server that accepts natural language queries
 * about items and returns cities that sell those items.
 *
 * The agent (run by the central system) calls our endpoint for each item it needs,
 * then computes the intersection of cities to find where ALL items are available.
 *
 * Key design decisions:
 * 1. Single tool is enough: agent calls it 3 times (once per item), then deduces intersection
 * 2. LLM-based fuzzy matching: agent may send "I need a 10m cable" → we find exact item
 * 3. Keyword pre-filter: narrow ~1200 items to top candidates before sending to LLM
 * 4. Response capped at 500 bytes as per task constraints
 */

import express, { Request, Response } from 'express';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

const app = express();
app.use(express.json());

// ─── Configuration ──────────────────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
const PORT = process.env.PORT ?? '3000';
const DATA_BASE_URL = 'https://hub.ag3nts.org/dane/s03e04_csv';

// ─── Data Types ─────────────────────────────────────────────────────────────
interface City { name: string; code: string; }
interface Item { name: string; code: string; }
interface Connection { itemCode: string; cityCode: string; }

// ─── In-Memory Data Store ────────────────────────────────────────────────────
let items: Item[] = [];
const citiesByCode = new Map<string, string>();     // cityCode → cityName
const connectionsByItemCode = new Map<string, Set<string>>(); // itemCode → Set<cityCode>

// ─── CSV Loader ──────────────────────────────────────────────────────────────
async function fetchCSV<T>(filename: string): Promise<T[]> {
  const url = `${DATA_BASE_URL}/${filename}`;
  console.log(`Fetching ${url}...`);
  const response = await axios.get<string>(url, { responseType: 'text' });
  return parse(response.data, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as T[];
}

async function loadData(): Promise<void> {
  const [cities, loadedItems, connections] = await Promise.all([
    fetchCSV<City>('cities.csv'),
    fetchCSV<Item>('items.csv'),
    fetchCSV<Connection>('connections.csv'),
  ]);

  items = loadedItems;

  for (const city of cities) {
    citiesByCode.set(city.code, city.name);
  }

  for (const conn of connections) {
    if (!connectionsByItemCode.has(conn.itemCode)) {
      connectionsByItemCode.set(conn.itemCode, new Set());
    }
    connectionsByItemCode.get(conn.itemCode)!.add(conn.cityCode);
  }

  console.log(
    `Data loaded: ${cities.length} cities, ${items.length} items, ${connections.length} connections`
  );
}

// ─── Item Matching via LLM ───────────────────────────────────────────────────
/**
 * Pre-filter items using keyword matching before sending to LLM.
 * This keeps the LLM prompt small and cheap.
 */
function preFilterItems(query: string): Item[] {
  const queryLower = query.toLowerCase();
  // Extract meaningful words (3+ chars), skip common Polish stop words
  const stopWords = new Set(['dla', 'lub', 'jak', 'ten', 'tego', 'nie', 'ale', 'sie', 'jest']);
  const queryWords = queryLower
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  if (queryWords.length === 0) return items.slice(0, 100);

  // Score each item by how many query words appear in its name
  const scored = items.map(item => {
    const nameLower = item.name.toLowerCase();
    const score = queryWords.reduce((s, word) => s + (nameLower.includes(word) ? 1 : 0), 0);
    return { item, score };
  });

  const withMatches = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  // Return top 80 keyword matches; if no keyword match, return ALL items so LLM has full list
  return withMatches.length > 0
    ? withMatches.slice(0, 80).map(x => x.item)
    : items;
}

/**
 * Use an LLM to pick the best matching item code from a candidate list.
 * Returns the item code string or null if matching fails.
 */
async function findItemCodeWithLLM(query: string, candidates: Item[]): Promise<string | null> {
  const itemList = candidates.map(i => `${i.code}|${i.name}`).join('\n');

  const systemPrompt = `You are an inventory lookup system. You receive a query and a list of items.
You MUST respond with EXACTLY ONE item code (6 characters, uppercase letters and digits).
Do NOT write any explanation, punctuation, or other text. ONLY the code.
Example valid response: BWST28
Example invalid response: The best match is BWST28`;

  const userPrompt = `Query: ${query}

Items (format CODE|name):
${itemList}

Which item code best matches the query? Respond with the code only.`;

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'google/gemini-2.5-flash-lite',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 15,
      temperature: 0,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content: string = response.data.choices?.[0]?.message?.content?.trim() ?? '';
  console.log(`LLM response for "${query}": "${content}"`);

  // Extract a 6-char alphanumeric code (case-insensitive, then uppercase)
  const match = content.toUpperCase().match(/[A-Z0-9]{6}/);
  return match ? match[0] : null;
}

// ─── API Endpoint ─────────────────────────────────────────────────────────────
/**
 * POST /api/search
 *
 * Accepts natural language item description, returns comma-separated city names.
 *
 * Request:  { "params": "natural language description of item" }
 * Response: { "output": "CityA,CityB,CityC" }
 *
 * Constraints: response body ≤ 500 bytes, ≥ 4 bytes
 */
app.post('/api/search', async (req: Request, res: Response) => {
  const { params } = req.body as { params?: unknown };

  if (!params || typeof params !== 'string') {
    return res.json({ output: 'Error: params must be a string' });
  }

  console.log(`\n[REQUEST] params: "${params}"`);

  try {
    // Step 1: Narrow down candidates using keyword matching
    const candidates = preFilterItems(params);
    console.log(`  Pre-filtered to ${candidates.length} candidates`);

    // Step 2: Use LLM to pick the best item from candidates
    const itemCode = await findItemCodeWithLLM(params, candidates);

    if (!itemCode) {
      console.log('  No item code returned by LLM');
      return res.json({ output: 'No matching item found' });
    }

    // Step 3: Look up cities for that item code
    const cityCodes = connectionsByItemCode.get(itemCode);
    if (!cityCodes || cityCodes.size === 0) {
      console.log(`  Item ${itemCode} not found in connections`);
      return res.json({ output: 'No cities found for this item' });
    }

    const cityNames = [...cityCodes]
      .map(code => citiesByCode.get(code))
      .filter((name): name is string => name !== undefined);

    console.log(`  Item: ${itemCode}, Cities: ${cityNames.join(', ')}`);

    // Step 4: Build response respecting 500-byte limit
    let output = cityNames.join(',');
    while (Buffer.byteLength(output, 'utf8') > 490 && cityNames.length > 1) {
      cityNames.pop();
      output = cityNames.join(',');
    }

    return res.json({ output });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Error: ${message}`);
    return res.json({ output: 'Error: ' + message.slice(0, 100) });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    itemsLoaded: items.length,
    citiesLoaded: citiesByCode.size,
    connectionsLoaded: connectionsByItemCode.size,
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!OPENROUTER_API_KEY) {
    console.error('ERROR: OPENROUTER_API_KEY environment variable is not set');
    process.exit(1);
  }

  console.log('Loading CSV data...');
  await loadData();

  app.listen(PORT, () => {
    console.log(`\nServer running on http://localhost:${PORT}`);
    console.log(`Tool endpoint: POST http://localhost:${PORT}/api/search`);
    console.log(`Health check:  GET  http://localhost:${PORT}/health`);
    console.log('\nNow run: ngrok http ' + PORT);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
