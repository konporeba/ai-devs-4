/**
 * AI Devs 4 — S3E2: Firmware Agent
 *
 * Architektura: Pojedynczy agent z dwoma narzędziami (function calling):
 *   1. execute_shell  — wykonuje polecenie na zdalnej VM przez API HTTP
 *   2. submit_answer  — wysyła znaleziony kod do Centrali
 *
 * Pętla agentowa: agent widzi historię konwersacji i może wielokrotnie
 * wywoływać narzędzia, aż znajdzie kod i go prześle.
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ─── Konfiguracja ────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
const AI_DEVS_API_KEY    = process.env.AI_DEVS_API_KEY ?? '';
const SHELL_API          = 'https://hub.ag3nts.org/api/shell';
const VERIFY_API         = 'https://hub.ag3nts.org/verify';
// Model z najlepszymi zdolnościami rozumowania — rekomendowany przez zadanie
const MODEL              = 'anthropic/claude-sonnet-4-6';

// ─── Typy ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ─── Definicje narzędzi (przekazywane do LLM) ────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'execute_shell',
      description:
        'Executes a single shell command on the remote virtual machine via HTTP API. ' +
        'Returns the raw JSON response from the API. ' +
        'The shell has a custom, limited set of commands — start with "help" to discover them. ' +
        'If you receive a rate-limit or ban error, wait before retrying.',
      parameters: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description: 'The shell command to execute on the remote VM',
          },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_answer',
      description:
        'Submits the discovered firmware code to the central hub for verification. ' +
        'Use this only after you have obtained a code matching the pattern ECCS-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The code in format ECCS-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          },
        },
        required: ['code'],
      },
    },
  },
];

// ─── Implementacje narzędzi ───────────────────────────────────────────────────

/**
 * Wysyła polecenie do API powłoki VM.
 * Obsługuje rate limiting (429), tymczasowe błędy serwera (503) i ban.
 */
async function executeShell(cmd: string): Promise<string> {
  console.log(`\n[SHELL >>>] ${cmd}`);

  // Przy rate-limitingu agent widzi czytelny komunikat i może poczekać
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const res = await fetch(SHELL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: AI_DEVS_API_KEY, cmd }),
      });

      const text = await res.text();

      if (res.status === 429) {
        const msg = `RATE_LIMIT (HTTP 429): ${text}. Wait a few seconds and retry.`;
        console.warn(`[SHELL] ${msg}`);
        await sleep(5000);
        return msg;
      }

      if (res.status === 503) {
        const msg = `SERVICE_UNAVAILABLE (HTTP 503): The shell API is temporarily unavailable. Wait and retry.`;
        console.warn(`[SHELL] ${msg}`);
        await sleep(3000);
        return msg;
      }

      if (!res.ok) {
        const msg = `HTTP_ERROR ${res.status}: ${text}`;
        console.warn(`[SHELL] ${msg}`);
        return msg;
      }

      // Ogranicz rozmiar odpowiedzi, aby nie przepełnić okna kontekstu LLM.
      // Pliki binarne lub bardzo długie outputy są skracane.
      const MAX_OUTPUT_CHARS = 3000;

      // Sprawdź, czy odpowiedź to JSON (może zawierać komunikat o banie)
      try {
        const json = JSON.parse(text);
        let output = JSON.stringify(json, null, 2);

        // Usuń ciągi null-byte'ów — to znak pliku binarnego
        const nullBytesCount = (output.match(/\\u0000/g) || []).length;
        if (nullBytesCount > 50) {
          output = `[BINARY FILE DETECTED — ${nullBytesCount} null bytes removed. Do NOT cat binary files.]`;
        } else if (output.length > MAX_OUTPUT_CHARS) {
          output = output.substring(0, MAX_OUTPUT_CHARS) + `\n... [TRUNCATED — output was ${output.length} chars]`;
        }

        console.log(`[SHELL <<<] ${output.substring(0, 500)}`);
        return output;
      } catch {
        let output = text;
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.substring(0, MAX_OUTPUT_CHARS) + `\n... [TRUNCATED]`;
        }
        console.log(`[SHELL <<<] ${output.substring(0, 500)}`);
        return output;
      }
    } catch (err: unknown) {
      const msg = `NETWORK_ERROR: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[SHELL] ${msg}`);
      return msg;
    }
  }
  return 'SHELL_ERROR: All retry attempts exhausted.';
}

/**
 * Wysyła znaleziony kod do Centrali i zwraca odpowiedź weryfikacji.
 */
async function submitAnswer(code: string): Promise<string> {
  console.log(`\n[SUBMIT] Submitting code: ${code}`);
  try {
    const res = await fetch(VERIFY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: AI_DEVS_API_KEY,
        task: 'firmware',
        answer: { confirmation: code },
      }),
    });
    const json = await res.json();
    console.log(`[SUBMIT] Verification response:`, JSON.stringify(json, null, 2));
    return JSON.stringify(json, null, 2);
  } catch (err: unknown) {
    const msg = `SUBMIT_ERROR: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[SUBMIT] ${msg}`);
    return msg;
  }
}

/**
 * Dispatcher — wywołuje właściwe narzędzie na podstawie nazwy.
 */
async function executeTool(name: string, args: Record<string, string>): Promise<string> {
  switch (name) {
    case 'execute_shell':
      return executeShell(args.cmd);
    case 'submit_answer':
      return submitAnswer(args.code);
    default:
      return `ERROR: Unknown tool "${name}"`;
  }
}

// ─── Wywołanie LLM ────────────────────────────────────────────────────────────

async function callLLM(messages: Message[]): Promise<Message> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.1, // Niskie temperature = deterministyczne, mniej "kreatywne" błędy
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: Message }>;
  };
  return data.choices[0].message;
}

// ─── Pętla agentowa ───────────────────────────────────────────────────────────

async function runAgent(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  AI Devs 4 — S3E2 Firmware Agent');
  console.log('='.repeat(60));

  /**
   * Prompt systemowy definiuje kontekst zadania, zasady bezpieczeństwa,
   * oraz strategię działania. Im precyzyjniej zdefiniujemy zakres, tym
   * mniejsza szansa na błąd agenta (np. wejście do zakazanych katalogów).
   */
  const systemPrompt = `You are a specialized agent working on a Linux virtual machine via a shell API.

Your mission:
1. Run the firmware binary located at: /opt/firmware/cooler/cooler.bin
2. The binary requires a password — find it by searching the filesystem
3. You may need to edit settings.ini to fix the firmware configuration
4. Once the binary runs successfully, it will display a code matching: ECCS-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
5. Submit that code using the submit_answer tool

SECURITY RULES (strictly enforced — violations cause a timed ban):
- Do NOT access /etc, /root, or /proc/
- If you find a .gitignore file in any directory, read it and avoid those listed files/dirs
- You operate as a regular user (no sudo)

SHELL API NOTES:
- This is a custom, limited shell — not all standard Linux commands work
- Always start with the "help" command to discover available commands
- File editing works differently than in a standard system — check "help" output
- Each tool call = one HTTP request, so plan your actions carefully
- If you get a rate-limit error, acknowledge it and retry after a moment
- If you get a ban, wait the specified number of seconds

IMPORTANT WARNINGS:
- NEVER use "cat" on .bin files or any file you suspect is binary — it will overflow context with null bytes
- The "help" output may be truncated; focus on key commands shown
- cooler-is-blocked.lock may be blocking the binary — consider removing it
- settings.ini has key config: SAFETY_CHECK is commented out, cooling is disabled

STRATEGY:
1. Run "help" first to learn ALL available commands (especially run/exec command)
2. Check the full help text and the settings.ini structure
3. Fix settings.ini:
   - Uncomment "#SAFETY_CHECK=pass" → "SAFETY_CHECK=pass" (use editline)
   - Enable cooling: change "enabled=false" to "enabled=true" in [cooling]
   - Disable test_mode: change "enabled=true" to "enabled=false" in [test_mode]
4. Remove the cooler-is-blocked.lock file (use rm command)
5. Find the password — search home directory (~), /opt/firmware/, and similar locations
6. Run the binary with the path and password parameter
7. Once you have the ECCS-... code, immediately submit it with submit_answer`;

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        'Begin the task. Start by running "help" to understand the available shell commands on this VM.',
    },
  ];

  const MAX_ITERATIONS = 40; // Zabezpieczenie przed nieskończoną pętlą
  let taskComplete = false;

  for (let i = 1; i <= MAX_ITERATIONS && !taskComplete; i++) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  Iteration ${i}/${MAX_ITERATIONS}`);
    console.log('─'.repeat(60));

    // Wywołaj model
    let assistantMessage: Message;
    try {
      assistantMessage = await callLLM(messages);
    } catch (err: unknown) {
      console.error('[LLM ERROR]', err instanceof Error ? err.message : String(err));
      break;
    }

    // Dodaj odpowiedź asystenta do historii
    messages.push(assistantMessage);

    if (assistantMessage.content) {
      console.log(`\n[AGENT] ${assistantMessage.content}`);
    }

    // Jeśli brak wywołań narzędzi, agent zakończył pracę
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log('\n[AGENT] No tool calls — task complete or agent is stuck.');
      break;
    }

    // Wykonaj każde wywołanie narzędzia sekwencyjnie (shell API wymaga kolejnych kroków)
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, string>;

      try {
        toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, string>;
      } catch {
        toolArgs = {};
      }

      const result = await executeTool(toolName, toolArgs);

      // Dodaj wynik narzędzia do historii konwersacji
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });

      // Jeśli agent wysłał odpowiedź do Centrali — zakończ
      if (toolName === 'submit_answer') {
        console.log('\n[AGENT] Answer submitted. Task complete!');
        taskComplete = true;
      }
    }

    // Krótka przerwa między iteracjami, aby nie przeciążyć API
    if (!taskComplete) {
      await sleep(1500);
    }
  }

  if (!taskComplete) {
    console.log('\n[AGENT] Reached iteration limit without completing the task.');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

runAgent().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
