# AI Devs 4

Solutions for the [AI Devs 4](https://aidevs.pl) course — a Polish hands-on AI engineering program focused on building autonomous agents, multi-agent systems, and LLM-powered tools.

Each exercise lives in its own folder (`s{season}e{exercise}/`) with the task description and implementation.

## Tech stack

- **TypeScript** (primary) · **Python** (select exercises)
- **OpenRouter** — unified API gateway for Claude, GPT, and other LLMs
- **OpenAI SDK** — used against OpenRouter's compatible endpoint

## Seasons

### Season 1 — Foundations
Introduction to LLM APIs, prompt engineering basics, and first API integrations.

### Season 2 — Prompt Engineering & Tool Use
| Exercise | Topic |
|----------|-------|
| s2e1 | Classify goods as dangerous/neutral within a strict 100-token prompt limit |
| s2e2 | Solve an electrical grid puzzle by rotating tiles to connect three power plants |
| s2e3 | Condense massive system logs to only failure-relevant events |
| s2e4 | Search a compromised mailbox via API to extract intelligence |
| s2e5 | Drone navigation mission to intercept a planned attack |

### Season 3 — Agents & Reasoning
| Exercise | Topic |
|----------|-------|
| s3e1 | Anomaly detection in sensor data streams |
| s3e2 | Repair broken firmware in a restricted Linux VM |
| s3e3 | Navigate a transport robot around a reactor grid |
| s3e4 | Build tools to find cities with required trade goods |
| s3e5 | **Multi-agent system (ReAct + CoT)** — plan an optimal route to Skolwin |

### Season 4 — Autonomous Agents
| Exercise | Topic |
|----------|-------|
| s4e1 | Manipulate the OKO Operations Center via a backdoor API |
| s4e2 | Schedule a wind turbine using weather forecast analysis |
| s4e3 | Search-and-rescue operation in a ruined city (multi-agent) |
| s4e4 | Organise intelligence notes into a structured virtual filesystem |
| s4e5 | Autonomous warehouse agent that assembles supply orders for multiple cities |

### Season 5 — Advanced Multi-Agent Systems
| Exercise | Topic |
|----------|-------|
| s5e1 | Radio surveillance intercept — parse mixed text/binary transmissions |
| s5e2 | Voice call agent that extracts road intelligence from an operator |
| s5e3 | Shell agent — mine server logs to locate a person in time and space |
| s5e4 | Rocket navigation with real-time radar detection and deactivation |
| s5e5 | Time-machine agent — coordinate multi-hop time jumps to reach a target date |

## Setup

Each exercise reads secrets from environment variables. Copy the `.env` file in the relevant folder and fill in your keys:

```
OPENROUTER_API_KEY=sk-or-v1-...
TASK_API_KEY=<your AI Devs API key>
```

Run a TypeScript exercise:

```bash
cd s3e5
npm install
npx ts-node agent_v2.ts
```
