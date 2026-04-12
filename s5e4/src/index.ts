/**
 * s5e4 — "Going There" Rocket Navigation Agent System
 *
 * Entry point. Validates the environment, then hands off to the Navigation
 * Orchestrator which coordinates the full multi-agent game loop.
 *
 * Architecture overview:
 *   NavigationOrchestrator  — main game loop, auto-restart on crash
 *     ├── RadarAgent        — OKO frequency scanner + SHA1 disarm
 *     ├── ScoutAgent        — radio hint interpreter (LLM-powered)
 *     └── DecisionMaker     — deterministic movement selection
 *
 * Run with: npm start
 */

import { runNavigationSystem } from "./agents/navigationOrchestrator";

// Catch any unhandled promise rejections at the process level
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

// Start the navigation system
runNavigationSystem().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
