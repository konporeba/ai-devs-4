/**
 * OKO Editor Agent — AI Devs 4, S04E01
 *
 * ARCHITEKTURA: Pojedynczy agent z narzędziami (wzorzec ReAct)
 * ─────────────────────────────────────────────────────────────
 * Zamiast wieloagentowego systemu, wybraliśmy jednego agenta z zestawem
 * narzędzi. To właściwy wybór, bo zadanie jest SEKWENCYJNE:
 *   1. Poznaj API → 2. Zbierz ID z panelu → 3. Edytuj przez API → 4. Done
 * Każdy krok zależy od poprzedniego, więc równoległe agenty nie dałyby
 * tu żadnych korzyści. Prostsza architektura = mniej błędów.
 *
 * NARZĘDZIA AGENTA:
 *   • login_oko          – loguje się do panelu OKO i zapamiętuje sesję
 *   • fetch_oko_page     – pobiera stronę OKO (tylko do odczytu!)
 *   • call_centrala_api  – wywołuje API Centrali (hub.ag3nts.org/verify)
 *
 * PĘTLA AGENTA (ReAct):
 *   LLM → [myśl] → [wybierz narzędzie] → [wywołaj] → [obserwuj wynik] → powtarzaj
 *   aż LLM uzna zadanie za zakończone i odpowie bez wywołania narzędzia.
 */

import dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// ═══════════════════════════════════════════════════════
//  KONFIGURACJA
// ═══════════════════════════════════════════════════════

const CONFIG = {
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  aiDevsApiKey: process.env.AI_DEVS_API_KEY ?? "",

  // Centrala AI Devs 4 (uwaga: NIE centrala.ag3nts.org — to był stary S3!)
  centralaUrl: "https://hub.ag3nts.org/verify",

  okoBaseUrl: "https://oko.ag3nts.org",
  okoLogin: "Zofia",
  okoPassword: "Zofia2026!",

  // Model przez OpenRouter — claude-haiku jest tańszy, ale radzi sobie z tym zadaniem
  // Alternatywy: "anthropic/claude-sonnet-4-5" (droższy, lepszy), "openai/gpt-4o-mini"
  model: "anthropic/claude-sonnet-4-5",

  // Zabezpieczenie przed nieskończoną pętlą
  maxIterations: 25,

  logFile: "agent.log",
} as const;

// ═══════════════════════════════════════════════════════
//  LOGOWANIE — kluczowe dla debugowania agentów!
//  Każde wywołanie narzędzia i odpowiedź LLM są zapisywane.
// ═══════════════════════════════════════════════════════

const logStream = fs.createWriteStream(CONFIG.logFile, { flags: "a" });

type LogLevel = "INFO" | "TOOL" | "LLM" | "ERROR";

function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;
  const dataStr = data !== undefined ? "\n" + JSON.stringify(data, null, 2) : "";
  const line = `${prefix} ${message}${dataStr}\n`;

  process.stdout.write(line);
  logStream.write(line);
}

// ═══════════════════════════════════════════════════════
//  ZARZĄDZANIE SESJĄ OKO
//  OKO używa cookies. Zapamiętujemy cookie po logowaniu
//  i dołączamy je do każdego kolejnego żądania.
// ═══════════════════════════════════════════════════════

let okoSession: string | null = null;

/**
 * Loguje się do panelu OKO i zapamiętuje cookie sesji.
 * WAŻNE: nigdy nie wolno używać /edit/ ani /delete/ — to blokuje sesję!
 */
async function toolLoginOko(): Promise<string> {
  log("TOOL", "Logowanie do OKO...");

  const body = new URLSearchParams({
    action: "login",
    login: CONFIG.okoLogin,
    password: CONFIG.okoPassword,
    access_key: CONFIG.aiDevsApiKey,
  });

  const response = await fetch(`${CONFIG.okoBaseUrl}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual", // Nie podążaj za przekierowaniem — potrzebujemy nagłówków
  });

  // Node 18+ ma getSetCookie(), starsze wersje — parsujemy ręcznie
  let cookies: string[];
  if (typeof response.headers.getSetCookie === "function") {
    cookies = response.headers.getSetCookie();
  } else {
    const raw = response.headers.get("set-cookie") ?? "";
    cookies = raw.split(",").map((c) => c.trim());
  }

  const sessionCookies = cookies
    .filter((c) => c.startsWith("oko_session="))
    .map((c) => c.split(";")[0]);

  if (sessionCookies.length === 0) {
    return "BŁĄD: Logowanie nie powiodło się — brak cookie sesji.";
  }

  // Serwer ustawia dwa cookies o tej samej nazwie — używamy ostatniego
  okoSession = sessionCookies[sessionCookies.length - 1];
  log("TOOL", "Logowanie udane", { session: okoSession });
  return "Logowanie udane. Sesja aktywna.";
}

/**
 * Pobiera stronę z panelu OKO i zwraca czytelną treść (bez HTML).
 * Automatycznie wyodrębnia linki z ID — agent potrzebuje ich do edycji.
 */
async function toolFetchOkoPage(path: string): Promise<string> {
  // Ochrona przed przypadkowym wywołaniem edit/delete przez LLM
  if (path.includes("/edit/") || path.includes("/delete/")) {
    return "ZABRONIONE: Ścieżki /edit/ i /delete/ blokują sesję. Używaj tylko /verify przez call_centrala_api.";
  }

  if (!okoSession) {
    return "BŁĄD: Brak sesji. Najpierw wywołaj login_oko.";
  }

  log("TOOL", `Pobieranie strony OKO: ${path}`);

  const response = await fetch(`${CONFIG.okoBaseUrl}${path}`, {
    headers: {
      Cookie: okoSession,
      "User-Agent": "Mozilla/5.0 OKO-Agent/1.0",
    },
  });

  const html = await response.text();

  // Wykryj blokadę bezpieczeństwa
  if (html.includes("naruszenie bezpiecze")) {
    okoSession = null;
    return "BŁĄD BEZPIECZEŃSTWA: Sesja zablokowana! Musisz zalogować się ponownie.";
  }

  // ── Wyodrębnij linki (to najważniejsze — zawierają ID) ──
  const linkPattern = /href="([^"]+)"[^>]*>\s*([^<]{1,80})/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1].trim();
    const text = match[2].replace(/\s+/g, " ").trim();
    if (href.startsWith("/") && text.length > 2) {
      links.push(`  ${href}  →  ${text}`);
    }
  }

  // ── Wyodrębnij czysty tekst ──
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);

  const result = [
    "=== LINKI NA STRONIE ===",
    ...links.slice(0, 30),
    "",
    "=== TREŚĆ ===",
    text,
  ].join("\n");

  log("TOOL", `Strona pobrana (${result.length} znaków)`);
  return result;
}

/**
 * Wywołuje API Centrali (hub.ag3nts.org/verify) z zadaniem "okoeditor".
 * To jedyny sposób na modyfikację danych — nie używaj /edit/ z OKO!
 */
async function toolCallCentralaApi(params: {
  action: "help" | "update" | "done";
  page?: "incydenty" | "notatki" | "zadania";
  id?: string;
  title?: string;
  content?: string;
  done?: "YES" | "NO";
}): Promise<string> {
  log("TOOL", "Wywołanie API Centrali", params);

  // Budujemy pole "answer" zgodnie z dokumentacją API
  const answer: Record<string, string> = { action: params.action };
  if (params.page) answer.page = params.page;
  if (params.id) answer.id = params.id;
  if (params.title) answer.title = params.title;
  if (params.content) answer.content = params.content;
  if (params.done) answer.done = params.done;

  const payload = {
    apikey: CONFIG.aiDevsApiKey,
    task: "okoeditor",
    answer,
  };

  const response = await fetch(CONFIG.centralaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  log("TOOL", "Odpowiedź Centrali", result);
  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════════════════════
//  DEFINICJE NARZĘDZI DLA LLM (format OpenAI function calling)
//  LLM "widzi" narzędzia przez te schematy i decyduje kiedy ich użyć.
// ═══════════════════════════════════════════════════════

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "login_oko",
      description:
        "Loguje się do panelu operatora OKO. Musi być wywołane przed fetch_oko_page. Dane logowania są wbudowane.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_oko_page",
      description:
        "Pobiera stronę z panelu OKO (tylko do odczytu). Użyj do zbierania ID incydentów i zadań. " +
        "Dostępne ścieżki: '/' (lista incydentów), '/zadania' (zadania), '/notatki' (notatki), " +
        "'/incydenty/{id}' (szczegóły). NIGDY nie używaj /edit/ ani /delete/.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Ścieżka URL np. '/', '/zadania', '/incydenty/abc123'",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "call_centrala_api",
      description:
        "Wywołuje API Centrali OKO Editor. JEDYNA metoda modyfikacji danych. " +
        "action='help' → dokumentacja API. " +
        "action='update' → edytuje wpis (wymaga page + id + min. title lub content). " +
        "action='done' → weryfikuje zmiany i zwraca flagę.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["help", "update", "done"],
            description: "Akcja do wykonania",
          },
          page: {
            type: "string",
            enum: ["incydenty", "notatki", "zadania"],
            description: "Sekcja systemu (wymagane dla action='update')",
          },
          id: {
            type: "string",
            description: "32-znakowy hex ID wpisu (wymagane dla action='update')",
          },
          title: {
            type: "string",
            description: "Nowy tytuł wpisu (opcjonalne przy update)",
          },
          content: {
            type: "string",
            description: "Nowa treść wpisu (opcjonalne przy update)",
          },
          done: {
            type: "string",
            enum: ["YES", "NO"],
            description: "Status wykonania — tylko dla page='zadania'",
          },
        },
        required: ["action"],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════
//  TYPY DLA OpenAI CHAT API
// ═══════════════════════════════════════════════════════

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

interface LlmResponse {
  content: string | null;
  tool_calls?: ToolCall[];
}

// ═══════════════════════════════════════════════════════
//  KLIENT LLM — OpenRouter (kompatybilny z OpenAI API)
// ═══════════════════════════════════════════════════════

async function callLlm(messages: Message[]): Promise<LlmResponse> {
  log("LLM", `Wysyłanie do LLM (${messages.length} wiadomości)...`);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://aidevs.pl",
      "X-Title": "AI Devs 4 S04E01 OKO Editor Agent",
    },
    body: JSON.stringify({
      model: CONFIG.model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: 4096,
      temperature: 0.1, // Niższe = bardziej deterministyczne = lepsze dla zadań
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter błąd HTTP ${response.status}: ${err}`);
  }

  const rawBody = await response.text();
  let data: {
    choices: [{ message: { content: string | null; tool_calls?: ToolCall[] } }];
    usage?: { prompt_tokens: number; completion_tokens: number };
    error?: { message: string };
  };
  try {
    data = JSON.parse(rawBody) as typeof data;
  } catch {
    throw new Error(`OpenRouter zwrócił nieprawidłowy JSON: ${rawBody.slice(0, 500)}`);
  }

  if (data.error) {
    throw new Error(`OpenRouter błąd API: ${data.error.message}`);
  }

  const msg = data.choices[0].message;
  log("LLM", "Odpowiedź LLM", {
    hasContent: !!msg.content,
    toolCalls: msg.tool_calls?.map((t) => t.function.name) ?? [],
    usage: data.usage,
  });

  return { content: msg.content, tool_calls: msg.tool_calls };
}

// ═══════════════════════════════════════════════════════
//  EXECUTOR NARZĘDZI — wywołuje właściwą funkcję
// ═══════════════════════════════════════════════════════

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "login_oko":
        return await toolLoginOko();

      case "fetch_oko_page":
        return await toolFetchOkoPage(args.path as string);

      case "call_centrala_api":
        return await toolCallCentralaApi(
          args as Parameters<typeof toolCallCentralaApi>[0]
        );

      default:
        return `BŁĄD: Nieznane narzędzie "${name}"`;
    }
  } catch (error) {
    const msg = `BŁĄD wykonania narzędzia ${name}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    log("ERROR", msg);
    return msg;
  }
}

// ═══════════════════════════════════════════════════════
//  PROMPT SYSTEMOWY
//  Definiuje "osobowość" agenta i zakres zadania.
//  Dobry prompt systemowy to połowa sukcesu w agentach.
// ═══════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Jesteś agentem AI działającym w imieniu ruchu oporu. Twoim zadaniem jest wprowadzenie zmian w systemie OKO (Centrum Operacyjne OKO) przez API Centrali, aby ukryć ślady aktywności w mieście Skolwin.

ZADANIA DO WYKONANIA (w tej kolejności):
1. Pobierz dokumentację API (call_centrala_api z action='help')
2. Zaloguj się do panelu OKO (login_oko)
3. Przeglądaj OKO TYLKO do odczytu — zbierz ID incydentów i zadań
4. Zmień klasyfikację incydentu Skolwin: tytuł musi zaczynać się od "MOVE04" zamiast "MOVE03" (MOVE04 = zwierzęta, nie pojazd+człowiek)
5. Oznacz zadanie Skolwin jako wykonane (done=YES) i wpisz w treści, że widziano zwierzęta (np. bobry)
6. Zadbaj o to, aby na liście incydentów pojawił się raport o ruchu LUDZI w okolicach Komarowo (tytuł zaczyna się od "MOVE01", bo MOVE01 = człowiek)
7. Wywołaj action='done' — jeśli wszystko ok, dostaniesz flagę

KODY INCYDENTÓW (z notatek systemu):
  MOVE01 = człowiek
  MOVE02 = pojazd
  MOVE03 = pojazd + człowiek
  MOVE04 = zwierzęta

KRYTYCZNE ZASADY BEZPIECZEŃSTWA:
- Nigdy NIE używaj /edit/ ani /delete/ z fetch_oko_page — to natychmiast blokuje sesję!
- Wszelkie modyfikacje tylko przez call_centrala_api
- API nie ma akcji 'add' — aby dodać nowy incydent o Komarowie, zaktualizuj istniejący wpis

Zacznij od pobrania dokumentacji API, potem zaloguj się i zbierz potrzebne ID.`;

// ═══════════════════════════════════════════════════════
//  GŁÓWNA PĘTLA AGENTA (ReAct: Reason → Act → Observe)
// ═══════════════════════════════════════════════════════

async function runAgent(): Promise<void> {
  log("INFO", "══════════════════════════════════════");
  log("INFO", "  OKO Editor Agent — Start");
  log("INFO", "══════════════════════════════════════");

  if (!CONFIG.openRouterApiKey || !CONFIG.aiDevsApiKey) {
    throw new Error("Brak kluczy API w pliku .env! Sprawdź OPENROUTER_API_KEY i AI_DEVS_API_KEY.");
  }

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: "Wykonaj wszystkie wymagane zmiany w systemie OKO i podaj uzyskaną flagę.",
    },
  ];

  for (let i = 0; i < CONFIG.maxIterations; i++) {
    log("INFO", `─── Iteracja ${i + 1}/${CONFIG.maxIterations} ───`);

    const llmResponse = await callLlm(messages);

    // Dodaj odpowiedź asystenta do historii
    const assistantMsg: Message = {
      role: "assistant",
      content: llmResponse.content ?? "",
      ...(llmResponse.tool_calls ? { tool_calls: llmResponse.tool_calls } : {}),
    };
    messages.push(assistantMsg);

    // Brak wywołań narzędzi = agent zakończył pracę
    if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
      log("INFO", "══ Agent zakończył zadanie ══");
      console.log("\n╔══════════════════════════════╗");
      console.log("║  ODPOWIEDŹ KOŃCOWA AGENTA    ║");
      console.log("╚══════════════════════════════╝");
      console.log(llmResponse.content ?? "(brak treści)");
      return;
    }

    // Wykonaj wszystkie wywołania narzędzi
    let taskComplete = false;
    for (const toolCall of llmResponse.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      log("TOOL", `▶ Wywołanie: ${toolCall.function.name}`, args);

      const result = await executeTool(toolCall.function.name, args);

      // Wynik narzędzia wraca do LLM jako wiadomość "tool"
      messages.push({
        role: "tool",
        content: result,
        tool_call_id: toolCall.id,
      });

      // Jeśli akcja "done" zwróciła flagę — koniec zadania
      if (
        toolCall.function.name === "call_centrala_api" &&
        (args as { action?: string }).action === "done" &&
        result.includes("FLG:")
      ) {
        const flagMatch = result.match(/\{FLG:[^}]+\}/);
        const flag = flagMatch ? flagMatch[0] : result;
        log("INFO", "══ Flaga uzyskana! Zadanie zakończone. ══");
        console.log("\n╔══════════════════════════════╗");
        console.log("║  FLAGA UZYSKANA              ║");
        console.log("╚══════════════════════════════╝");
        console.log(flag);
        taskComplete = true;
      }
    }

    if (taskComplete) return;
  }

  log("ERROR", `Osiągnięto limit ${CONFIG.maxIterations} iteracji bez zakończenia!`);
  throw new Error("Agent przekroczył limit iteracji.");
}

// ═══════════════════════════════════════════════════════
//  PUNKT WEJŚCIA
// ═══════════════════════════════════════════════════════

runAgent().catch((error: unknown) => {
  const msg = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : JSON.stringify(error);
  log("ERROR", "Agent zakończył się błędem", msg);
  process.exit(1);
});
