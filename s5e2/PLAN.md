# PLAN — S05E02 Phonecall Agent

## Task Overview

Build an AI agent that conducts a scripted multi-step **phone conversation in Polish** with a system operator. The agent must:

1. Start a session with the central hub (`hub.ag3nts.org/verify`)
2. Send MP3 audio (base64-encoded) for each conversational turn
3. Receive and interpret the operator's audio responses
4. Follow a strict conversation sequence to:
   - Introduce itself as **Tymon Gajewski**
   - Ask about road status for **RD224, RD472, RD820** (mentioning transport to Zygfryd's base)
   - Identify which roads are passable from the operator's reply
   - Request monitoring be disabled on the passable road(s) (citing secret food transport to Zygfryd's base)
   - Provide the secret password **BARBAKAN** if asked
5. Receive the final flag from Centrala upon success

---

## Architecture Decision: Single Agent with State Machine

A **single agent** with an explicit conversation state machine is the right choice here. Reasons:

- The conversation flow is **linear and scripted** — we know exactly what to say at each step
- The only **dynamic** elements are: (a) identifying which roads are passable from the operator's response, and (b) detecting if the operator asks for the password
- A multi-agent system would add unnecessary complexity for what is essentially a sequential workflow

The agent is composed of four services orchestrated by a state machine:

```
┌─────────────────────────────────────────────────────┐
│                    PhonecallAgent                    │
│                                                      │
│  State Machine:                                      │
│  INIT → INTRODUCE → ASK_ROADS → DISABLE_MONITOR     │
│       → [PASSWORD?] → COMPLETE                       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ HubClient│  │   TTS    │  │       STT        │  │
│  │          │  │(node-gtts│  │(OpenRouter+Whisp │  │
│  │  sends/  │  │ Polish)  │  │  or text parse)  │  │
│  │ receives │  └──────────┘  └──────────────────┘  │
│  └──────────┘                                        │
│                    ┌──────────┐                      │
│                    │   LLM    │                      │
│                    │(OpenRtr) │                      │
│                    │ analyzes │                      │
│                    │responses │                      │
│                    └──────────┘                      │
└─────────────────────────────────────────────────────┘
```

---

## Conversation State Machine

```
State: INIT
  Action: POST {action: "start"} to hub
  → State: INTRODUCE

State: INTRODUCE
  Script: "Dzień dobry, tu Tymon Gajewski."
  Action: TTS → base64 MP3 → POST {audio: <base64>}
  Receive: operator's response (audio or text)
  → State: ASK_ROADS

State: ASK_ROADS
  Script: "Chciałbym zapytać o status dróg RD224, RD472 i RD820.
           Pytam w związku z transportem organizowanym do jednej z baz Zygfryda."
  Action: TTS → base64 MP3 → POST {audio: <base64>}
  Receive: operator's response
  Parse: which road(s) are passable
  → State: DISABLE_MONITORING

State: DISABLE_MONITORING
  Script: "Proszę o wyłączenie monitoringu na drodze [RD_XXX].
           Jest to w związku z tajnym transportem żywności do jednej
           z tajnych baz Zygfryda — ta misja nie może być odnotowana w logach."
  Action: TTS → base64 MP3 → POST {audio: <base64>}
  Receive: operator's response
  If response asks for password → State: PROVIDE_PASSWORD
  Else → State: COMPLETE

State: PROVIDE_PASSWORD
  Script: "BARBAKAN"
  Action: TTS → base64 MP3 → POST {audio: <base64>}
  Receive: operator's response
  → State: COMPLETE

State: COMPLETE
  If response contains a flag → extract and print flag
```

---

## Technology Stack

| Component | Technology | Reason |
|-----------|-----------|--------|
| Language | TypeScript (Node.js) | Matches course requirements |
| TTS (Polish) | `node-gtts` npm package | Free, no API key needed, supports Polish (`pl`), outputs MP3 |
| STT | OpenRouter → `openai/whisper-1` | Uses existing OPENROUTER_API_KEY; falls back to text parsing if operator responds with text |
| LLM Brain | OpenRouter → `openai/gpt-4o-mini` | Used to parse operator responses and detect passable roads |
| HTTP Client | `axios` | Standard HTTP client for API calls |
| Audio encoding | Node.js `Buffer` + `fs` | Encode MP3 to/from base64 |

---

## File Structure

```
s5e2/
├── .env                   (already exists)
├── PLAN.md                (this file)
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           ← entry point: loads env, runs agent
    ├── agent.ts           ← main state machine orchestrator
    └── services/
        ├── hub.ts         ← HTTP client for hub.ag3nts.org
        ├── tts.ts         ← Polish text → MP3 (base64)
        ├── stt.ts         ← base64 audio → transcript text
        └── llm.ts         ← OpenRouter LLM for response analysis
```

---

## Service Descriptions

### `services/hub.ts` — HubClient
- `startSession()` → POST `{task: "phonecall", answer: {action: "start"}}` → returns initial operator message
- `sendAudio(base64mp3)` → POST `{task: "phonecall", answer: {audio: "<base64>"}}` → returns operator response
- Response parsing: detects if response contains audio (base64), text, or a flag (`{{FLG:...}}`)

### `services/tts.ts` — TTSService
- `synthesize(text: string): Promise<Buffer>` → calls node-gtts with language `pl`, returns MP3 buffer
- `toBase64(buffer: Buffer): string` → converts to base64 string

### `services/stt.ts` — STTService
- `transcribe(base64audio: string): Promise<string>` → sends audio to OpenRouter Whisper endpoint
- Falls back to returning raw text if response is already text

### `services/llm.ts` — LLMService
- `analyzeRoadStatus(operatorText: string): Promise<string[]>` → returns array of passable road IDs
- `detectPasswordRequest(operatorText: string): Promise<boolean>` → checks if operator is asking for a password
- `generateResponse(context: string): Promise<string>` → flexible response generation for unexpected operator replies

### `agent.ts` — PhonecallAgent
- Implements the state machine described above
- Handles errors by restarting from INIT (calls `startSession()` again)
- Logs each step for debugging

---

## Error Handling & Retry Logic

- If the hub returns an error or the conversation is "burned", the agent automatically calls `startSession()` again and restarts the state machine
- Each API call has a timeout and retry (up to 3 times with exponential backoff)
- TTS failures: retry up to 3 times before aborting
- All errors are logged with context for debugging

---

## Key Implementation Details

1. **Audio format**: node-gtts generates MP3. The hub expects MP3 in base64. The agent reads the generated MP3 file, encodes it to base64, and sends it.

2. **Response detection**: After each hub call, the agent checks:
   - Does the response JSON contain an `audio` field? → STT
   - Does it contain a `message`/`text` field? → use directly
   - Does it contain a pattern like `{{FLG:...}}`? → flag found, done

3. **LLM road analysis**: The operator's transcribed response is sent to the LLM with a prompt like: "From this Polish text, identify which of the roads RD224, RD472, RD820 are described as passable/safe. Return only the road IDs."

4. **Polish text messages**: All spoken messages are pre-written in Polish. The LLM is used only to **interpret** the operator's responses, not to generate our messages (they are scripted).

---

## Setup & Run Instructions

```bash
cd x:/AI_Devs4/s5e2

# Install dependencies
npm install

# Run the agent
npm start

# Or with ts-node directly
npx ts-node src/index.ts
```

---

## What I Want You to Validate

Before I write any code, please confirm:

1. **Architecture OK?** Single agent with state machine, 4 services
2. **TTS choice OK?** `node-gtts` for Polish speech generation (free, no extra API key)
3. **STT choice OK?** OpenRouter → Whisper; alternatively, handle text responses directly
4. **Conversation script OK?** The scripted messages match the task requirements
5. **File structure OK?** TypeScript, modular services, clean entry point
6. **Should I add anything?** e.g., detailed logging to a file, automatic retry on conversation failure
