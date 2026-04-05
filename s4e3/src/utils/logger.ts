/**
 * NARZĘDZIE: Logger — centralny system logowania operacji
 *
 * Logi są zapisywane jednocześnie w dwóch miejscach:
 *   1. Konsola — z kolorami ANSI, czytelna dla człowieka w czasie rzeczywistym
 *   2. Plik    — w katalogu logs/, nazwany timestampem (np. operation-2026-04-04T21-30-13.log)
 *
 * Każdy wpis zawiera: timestamp, tag agenta, poziom, wiadomość i opcjonalne dane.
 *
 * Wzorzec Singleton: jedna instancja loggera współdzielona przez cały proces.
 * Dzięki temu wszystkie agenty (MAP_ANALYST, STRATEGIST, EXECUTOR) piszą
 * do tego samego pliku logu i tej samej konsoli.
 *
 * Kolory w konsoli pomagają odróżnić agenty i poziomy ważności na pierwszy rzut oka:
 *   MAP_ANALYST  → cyan
 *   STRATEGIST   → magenta
 *   EXECUTOR     → żółty
 *   ORCHESTRATOR → niebieski
 */

import * as fs from "fs";
import * as path from "path";

// ── Typy ──────────────────────────────────────────────────────────────────────

/**
 * Identyfikatory agentów — używane jako tagi w logach.
 * Ograniczamy do znanych wartości (union type), żeby uniknąć literówek.
 */
export type AgentTag = "MAP_ANALYST" | "STRATEGIST" | "EXECUTOR" | "ORCHESTRATOR";

/**
 * Poziomy logowania — analogiczne do popularnych bibliotek (Winston, Pino).
 * LLM_CALL i API_CALL to poziomy specyficzne dla tego projektu.
 */
export type LogLevel = "INFO" | "LLM_CALL" | "API_CALL" | "SUCCESS" | "WARN" | "ERROR";

/** Jeden ustrukturyzowany wpis w logu. */
interface LogEntry {
  timestamp: string;
  agent: AgentTag;
  level: LogLevel;
  message: string;
  data?: unknown; // opcjonalne dane — dowolny JSON
}

// ── Kody kolorów ANSI ─────────────────────────────────────────────────────────
//
// ANSI escape codes to sekwencje znaków, które terminal interpretuje jako kolory.
// Format: \x1b[<kod>m ... \x1b[0m (reset)
// Działają w większości terminali Unix/Linux/macOS i Windows Terminal.

/** Kolory tagów agentów — identyfikacja wizualna w konsoli. */
const COLOURS: Record<AgentTag, string> = {
  MAP_ANALYST:  "\x1b[36m", // cyan
  STRATEGIST:   "\x1b[35m", // magenta
  EXECUTOR:     "\x1b[33m", // żółty
  ORCHESTRATOR: "\x1b[34m", // niebieski
};

/** Kolory poziomów ważności — np. ERROR zawsze czerwony. */
const LEVEL_COLOURS: Record<LogLevel, string> = {
  INFO:     "\x1b[37m", // biały
  LLM_CALL: "\x1b[96m", // jasny cyan — wywołania LLM wyróżnione
  API_CALL: "\x1b[94m", // jasny niebieski — wywołania API gry
  SUCCESS:  "\x1b[92m", // jasny zielony
  WARN:     "\x1b[93m", // jasny żółty
  ERROR:    "\x1b[91m", // jasny czerwony
};

const RESET = "\x1b[0m"; // wyłącza wszelkie formatowanie
const BOLD  = "\x1b[1m"; // pogrubienie

// ── Klasa Logger ──────────────────────────────────────────────────────────────

class Logger {
  private logFilePath: string;
  /** Strumień zapisu do pliku — otwarty na starcie, zamykany przez close(). */
  private writeStream: fs.WriteStream;

  constructor() {
    // Tworzymy katalog logs/ jeśli nie istnieje
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Nazwa pliku: operation-<ISO timestamp bez dwukropków>.log
    // Dwukropki są zastępowane myślnikami, bo Windows nie pozwala na : w nazwach plików
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.logFilePath = path.join(logDir, `operation-${timestamp}.log`);

    // Otwieramy strumień w trybie "append" — gdyby plik istniał, dopisujemy (nie nadpisujemy)
    this.writeStream = fs.createWriteStream(this.logFilePath, { flags: "a" });

    // Nagłówek sesji w pliku logu
    const header = `${"=".repeat(80)}\nOPERATION DOMATOWO — Session started at ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`;
    this.writeStream.write(header);

    console.log(`${BOLD}${COLOURS.ORCHESTRATOR}[LOGGER]${RESET} Log file: ${this.logFilePath}`);
  }

  /**
   * Centralny zapis logu — każda metoda convenience (info, warn, error...) trafia tutaj.
   * Buduje ustrukturyzowany LogEntry i wysyła go do konsoli i pliku.
   */
  log(agent: AgentTag, level: LogLevel, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      agent,
      level,
      message,
      data,
    };

    this.writeToConsole(entry);
    this.writeToFile(entry);
  }

  // ── Metody convenience wg poziomu ─────────────────────────────────────────
  //
  // Zamiast pisać logger.log("EXECUTOR", "INFO", ...) piszemy logger.info("EXECUTOR", ...)
  // To zmniejsza boilerplate i czyni wywołania bardziej czytelne.

  /** Standardowe informacje o przebiegu operacji. */
  info(agent: AgentTag, message: string, data?: unknown): void {
    this.log(agent, "INFO", message, data);
  }

  /** Wywołania LLM — wyróżnione kolorem, żeby łatwo znaleźć je w logach. */
  llmCall(agent: AgentTag, message: string, data?: unknown): void {
    this.log(agent, "LLM_CALL", message, data);
  }

  /** Wywołania API gry — każdy request i response. */
  apiCall(agent: AgentTag, message: string, data?: unknown): void {
    this.log(agent, "API_CALL", message, data);
  }

  /** Potwierdzenie sukcesu (np. znalezienie partyzanta, odebranie flagi). */
  success(agent: AgentTag, message: string, data?: unknown): void {
    this.log(agent, "SUCCESS", message, data);
  }

  /** Ostrzeżenia — coś poszło nie tak, ale możemy kontynuować. */
  warn(agent: AgentTag, message: string, data?: unknown): void {
    this.log(agent, "WARN", message, data);
  }

  /** Błędy krytyczne — zazwyczaj poprzedzają wyjątek lub przerwanie operacji. */
  error(agent: AgentTag, message: string, data?: unknown): void {
    this.log(agent, "ERROR", message, data);
  }

  // ── Separator wizualny ────────────────────────────────────────────────────

  /**
   * Drukuje poziomą linię separatora z opcjonalnym tytułem.
   * Używane na początku/końcu każdego agenta i każdej misji — poprawia czytelność logów.
   */
  separator(title?: string): void {
    const line = title
      ? `\n${"─".repeat(30)} ${title} ${"─".repeat(30)}\n`
      : `\n${"─".repeat(80)}\n`;
    console.log(`\x1b[90m${line}${RESET}`);
    this.writeStream.write(line + "\n");
  }

  /**
   * Zamyka strumień zapisu do pliku.
   * MUSI być wywołane na końcu programu, inaczej ostatnie logi mogą się nie zapisać
   * (Node.js buforuje zapisy i może nie zdążyć ich flush'ować przed zakończeniem procesu).
   */
  close(): void {
    const footer = `\n${"=".repeat(80)}\nSession ended at ${new Date().toISOString()}\n${"=".repeat(80)}\n`;
    this.writeStream.write(footer);
    this.writeStream.end(); // kończy zapis i zwalnia deskryptor pliku
  }

  // ── Prywatne pomocniki formatowania ──────────────────────────────────────

  /** Formatuje i drukuje wpis do konsoli z kolorami ANSI. */
  private writeToConsole(entry: LogEntry): void {
    const agentColour = COLOURS[entry.agent];
    const levelColour = LEVEL_COLOURS[entry.level];

    const header = `${BOLD}${agentColour}[${entry.agent}]${RESET} ${levelColour}[${entry.level}]${RESET} ${entry.message}`;
    console.log(header);

    if (entry.data !== undefined) {
      const formatted = JSON.stringify(entry.data, null, 2);
      // Obcinamy bardzo długie bloki danych w konsoli (czytelność > kompletność)
      const lines = formatted.split("\n");
      const preview = lines.length > 30
        ? [...lines.slice(0, 30), `  ... (${lines.length - 30} more lines)`]
        : lines;
      // Wcięcie + szary kolor dla danych — odróżnienie od głównej wiadomości
      console.log(`\x1b[90m${preview.map(l => "  " + l).join("\n")}${RESET}`);
    }
  }

  /** Zapisuje wpis do pliku w formacie tekstowym (bez kolorów ANSI). */
  private writeToFile(entry: LogEntry): void {
    const ts = entry.timestamp;
    let line = `[${ts}] [${entry.agent}] [${entry.level}] ${entry.message}\n`;
    if (entry.data !== undefined) {
      // Wcięcie danych — poprawia czytelność w edytorze tekstu
      line += JSON.stringify(entry.data, null, 2)
        .split("\n")
        .map(l => "  " + l)
        .join("\n") + "\n";
    }
    line += "\n"; // pusta linia między wpisami
    this.writeStream.write(line);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * Jedna globalna instancja loggera — współdzielona przez cały proces.
 * Importuj ją w każdym pliku przez: import { logger } from "../utils/logger";
 *
 * Dlaczego singleton? Bo chcemy jeden plik logu i jedną spójną sekwencję wpisów,
 * nie oddzielne pliki dla każdego agenta.
 */
export const logger = new Logger();
