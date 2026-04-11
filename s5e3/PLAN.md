# PLAN — S5E3: Shell Access Agent (`shellaccess`)

## Task Summary

We need to find information hidden in log files on a remote Linux server:
- **When** Rafał was found (date)
- **Where** (city + GPS coordinates)
- Then submit a JSON answer that is **one day before** the found date

The server is accessible only by sending shell commands via HTTP POST to `https://hub.ag3nts.org/verify`.

---

## Architecture Decision: Single ReAct Agent

**Why a single agent?**

The task is inherently sequential:
1. Explore the server file system
2. Search through log files for Rafał-related data
3. Extract date, city, coordinates
4. Calculate day-before date
5. Submit the final JSON answer

A multi-agent system would add unnecessary complexity here. A **single ReAct agent** (Reason → Act → Observe loop) is optimal because:
- Each shell command builds on what we learned from the previous one
- The search strategy is adaptive — we may need to pivot based on what we find
- There is no parallelism benefit since we are bottlenecked by sequential HTTP calls to the remote server

---

## Agent Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     ReAct Agent Loop                     │
│                                                         │
│  System Prompt (task context + tool description)        │
│  ↓                                                      │
│  [THINK] Reason about next step                         │
│  [ACT]   Call executeShellCommand tool                  │
│  [OBSERVE] Read server response                         │
│  ↓                                                      │
│  Repeat until answer found                              │
│  ↓                                                      │
│  [FINAL] Build JSON, submit via final shell command     │
└─────────────────────────────────────────────────────────┘
         │
         ▼ Tool: executeShellCommand
┌─────────────────────────────────────────────────────────┐
│  POST https://hub.ag3nts.org/verify                     │
│  Body: { apikey, task: "shellaccess", answer: { cmd } } │
│  Returns: server stdout / flag                          │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Step 1 — Project Setup
- Initialize a new Node.js / TypeScript project in `x:\AI_Devs4\s5e3\`
- Install dependencies: `typescript`, `ts-node`, `dotenv`, `openai` (for OpenRouter)
- Create `tsconfig.json`, `package.json`

### Step 2 — Core Module: `shellTool.ts`
A standalone function `executeShellCommand(cmd: string)` that:
- Sends an HTTP POST to `https://hub.ag3nts.org/verify`
- Payload: `{ apikey, task: "shellaccess", answer: { cmd } }`
- Returns the server's text response (stdout or flag)
- Handles HTTP errors with clear messages

### Step 3 — Agent Module: `agent.ts`
Implements the ReAct loop using OpenRouter (via OpenAI-compatible SDK):

**System Prompt** tells the agent:
- It is exploring a remote Linux server
- Its goal: find when/where Rafał was found, subtract 1 day, return JSON
- It has one tool: `executeShellCommand`
- Expected final JSON format: `{ date, city, longitude, latitude }`

**Tool Definition** (OpenAI function calling):
```
name: executeShellCommand
description: Execute a Linux shell command on the remote server
parameters: { cmd: string }
```

**ReAct Loop**:
1. Start with `ls /data` to see what files exist
2. Agent reasons about which files to inspect
3. Agent uses `grep`, `cat`, `find`, `head`, `wc` etc. to search through logs
4. Agent extracts the relevant facts
5. Agent builds the final `echo` command that outputs the answer JSON
6. The server detects the correct JSON and returns the flag

**Loop Control**:
- Max iterations: 20 (safety cap)
- Stop condition: server response contains `{{FLG:` pattern (indicates flag found)

### Step 4 — Logging
- Each iteration logs: iteration number, command sent, response received
- Stored both to console and to `agent.log` file
- Makes it easy to trace the agent's reasoning

### Step 5 — Entry Point: `index.ts`
- Loads `.env`
- Calls `runAgent()`
- Prints final flag or error

---

## Expected Agent Exploration Strategy

The agent will likely follow this pattern (autonomously decided, not hardcoded):

```
1. ls /data                          → see what files/dirs exist
2. ls /data/*.log  (or find /data)   → list specific log files
3. wc -l /data/<file>                → gauge file size
4. grep -i "rafał" /data/<file>      → find Rafał references
5. grep -i "znaleziono" /data/<file> → find "found" references
6. grep -B5 -A5 "rafał" ...          → get context around matches
7. grep -i "współrzędne\|miasto\|lat\|lon" ... → get location data
8. cat /data/<relevant-file>         → read full relevant section
9. echo '{"date":"YYYY-MM-DD",...}'  → output final JSON answer
```

---

## File Structure

```
x:\AI_Devs4\s5e3\
├── .env                    # API keys (already exists)
├── initial_prompt.md       # Course context
├── lesson_content.md       # Lesson material
├── task.md                 # Task specification
├── PLAN.md                 # This file
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # Entry point
│   ├── agent.ts            # ReAct agent loop
│   └── shellTool.ts        # HTTP tool: sends shell cmds to server
└── agent.log               # Runtime log (generated on execution)
```

---

## Key Development Practices

| Practice | Implementation |
|---|---|
| **Single Responsibility** | `shellTool.ts` only handles HTTP; `agent.ts` only handles reasoning |
| **Error Handling** | HTTP errors + JSON parse errors caught and logged; agent gets error text so it can try a different command |
| **Safety Cap** | Max 20 iterations prevents infinite loops and runaway API costs |
| **Observability** | Structured logging shows every command and response |
| **Environment Config** | All secrets in `.env`, never hardcoded |
| **Typed Interfaces** | TypeScript interfaces for API request/response shapes |
| **Adaptive Strategy** | Agent decides its own exploration path — no hardcoded grep patterns |

---

## Model Choice

**Primary model**: `google/gemini-2.5-flash-preview` via OpenRouter  
**Rationale**: Strong reasoning, good at command-line tasks, fast, cost-effective for an iterative loop

**Fallback**: `anthropic/claude-3.5-haiku` if the primary fails

---

## Questions / Risks

1. **File size**: The "time archive" may be very large. The agent should use `grep` and targeted searches rather than `cat`-ing whole files.
2. **Encoding**: Polish characters (ł, ó, ą etc.) in log files — grep patterns need to handle UTF-8 or use ASCII-safe alternatives.
3. **Date arithmetic**: The agent must subtract 1 day from the found date. It can either reason about this itself or use `date -d "YYYY-MM-DD - 1 day" +%F` on the remote server.
4. **Coordinate format**: The task expects float precision (6 decimal places) — the agent must extract exact values.

---

## How to Run (after implementation)

```bash
cd x:\AI_Devs4\s5e3
npm install
npm run start

# To inspect the log:
cat agent.log
```

---

*Please review this plan and confirm before I proceed with implementation.*
