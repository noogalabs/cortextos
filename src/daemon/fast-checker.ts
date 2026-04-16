import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs';
import { exec, execFile } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { checkInbox, ackInbox, sendMessage } from '../bus/message.js';
import { updateApproval } from '../bus/approval.js';
import { AgentProcess } from './agent-process.js';
import type { TelegramAPI } from '../telegram/api.js';
import { SlackAPI, type SlackMessage } from '../slack/api.js';
import { KEYS } from '../pty/inject.js';
import { stripControlChars } from '../utils/validate.js';

type LogFn = (msg: string) => void;

/**
 * Fast message checker for a single agent.
 * Replaces fast-checker.sh: polls Telegram and inbox, injects into PTY.
 */
export class FastChecker {
  private agent: AgentProcess;
  private paths: BusPaths;
  private running: boolean = false;
  private pollInterval: number;
  private log: LogFn;
  private typingLastSent: number = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  private lastMessageInjectedAt: number = 0;
  // Track outbound message log size to detect when agent sends a reply
  private outboundLogSize: number = 0;
  // Track stdout log size to detect when agent is actively producing output
  private stdoutLogSize: number = -1;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserId?: number;

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];

  // Persistent dedup: message hashes to prevent duplicate delivery
  private seenHashes: Set<string> = new Set();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollCycleWatchdog: NodeJS.Timeout | null = null;

  // Gmail watch state
  private gmailWatch?: { query: string; intervalMs: number };
  private gmailLastCheckedAt: number = 0;
  private gmailLastCheckedPath: string = '';
  // Delivered-message-ID set with 2h TTL: id → delivery timestamp (ms)
  private gmailDeliveredIds: Map<string, number> = new Map();
  private gmailDeliveredIdsPath: string = '';
  private readonly GMAIL_DELIVERED_TTL_MS = 2 * 60 * 60 * 1000; // 2h

  // Slack watch state
  private slackWatch?: { channel: string; intervalMs: number };
  private slackApi?: SlackAPI;
  private slackLastTs: string = '0';
  private slackLastCheckedAt: number = 0;
  private readonly SLACK_DEFAULT_INTERVAL_MS = 60 * 1000;

  // Usage rate-limit guard state
  private usageLastCheckedAt: number = 0;
  private usageTier: 0 | 1 | 2 = 0; // 0=normal, 1=high(≥85%), 2=critical(≥95%)
  private usageTierFile: string = '';
  private readonly USAGE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

  // Context-exhaustion + frozen-stdout watchdog state
  private bootstrappedAt: number = 0;
  private lastPollCycleCompletedAt: number = 0;
  private readonly POLL_CYCLE_TIMEOUT_MS = 30_000;
  // Circuit breaker state — track recent auto-restarts and pause the
  // watchdog if it keeps firing (upstream is down, restarting won't help)
  private watchdogRestarts: number[] = [];
  private watchdogCircuitBroken: boolean = false;
  private watchdogCircuitBrokenAt: number = 0;
  private readonly WATCHDOG_MAX_RESTARTS = 3;
  private readonly WATCHDOG_WINDOW_MS = 15 * 60 * 1000; // 15 min
  private readonly WATCHDOG_CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30 min
  private lastHardRestartAt: number = 0;
  private stdoutLastSize: number = 0;
  private stdoutLastChangeAt: number = 0;
  private watchdogTriggered: boolean = false;
  private readonly BOOTSTRAP_GRACE_MS = 10 * 60 * 1000;
  private readonly HARD_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
  private readonly STDOUT_FROZEN_MS = 30 * 60 * 1000;
  // Context-threshold graceful restart state (Signal 3)
  private ctxThresholdPct: number = 70;
  private ctxThresholdTriggeredAt: number = 0;
  private readonly CTX_THRESHOLD_COOLDOWN_MS = 10 * 60 * 1000;   // 10 min — no re-inject
  private readonly CTX_THRESHOLD_FALLBACK_MS = 15 * 60 * 1000;  // 15 min — hard-restart if ignored

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: {
      pollInterval?: number;
      log?: LogFn;
      telegramApi?: TelegramAPI;
      chatId?: string;
      allowedUserId?: number;
      gmailWatch?: { query: string; intervalMs: number };
      slackWatch?: { channel: string; intervalMs: number; token: string };
      ctxRestartThreshold?: number;
    } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;
    this.ctxThresholdPct = options.ctxRestartThreshold ?? 70;

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();

    // Initialize Gmail watch
    if (options.gmailWatch) {
      this.gmailWatch = options.gmailWatch;
      this.gmailLastCheckedPath = join(paths.stateDir, 'gmail-last-checked.txt');
      this.gmailDeliveredIdsPath = join(paths.stateDir, 'gmail-delivered-ids.json');
      this.loadGmailLastCheckedAt();
      this.loadGmailDeliveredIds();
    }

    if (options.slackWatch) {
      this.slackWatch = { channel: options.slackWatch.channel, intervalMs: options.slackWatch.intervalMs };
      this.slackApi = new SlackAPI(options.slackWatch.token);
      this.slackLastTs = (Date.now() / 1000).toFixed(6);
    }

    // Initialize usage tier state
    this.usageTierFile = join(paths.stateDir, 'usage-tier.json');
    this.loadUsageTier();
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.log('Starting. Waiting for bootstrap...');

    // Register SIGUSR1 handler for immediate wake
    const sigusr1Handler = () => {
      this.log('SIGUSR1 received - waking immediately');
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', sigusr1Handler);
    }

    // Wait for bootstrap
    await this.waitForBootstrap();
    this.log('Bootstrap complete. Beginning poll loop.');
    this.bootstrappedAt = Date.now();
    this.stdoutLastChangeAt = Date.now();

    // Idle-session heartbeat watchdog: fires every 50 min regardless of REPL state
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
    const agentName = this.agent.name;
    this.heartbeatTimer = setInterval(() => {
      const ts = new Date().toISOString();
      exec(`cortextos bus update-heartbeat "[watchdog] ${agentName} alive — idle session ${ts}"`, (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    // Poll-cycle watchdog: if pollCycle hasn't completed in 90s, force-restart
    // the agent PTY. Runs on its own setInterval so it can't get stuck inside
    // the poll loop. Gives the hung operation 30s (pollCycle timeout) + 60s
    // buffer before deciding the session is truly wedged.
    this.lastPollCycleCompletedAt = Date.now();
    const WATCHDOG_INTERVAL_MS = 30 * 1000;
    const STALL_THRESHOLD_MS = 90 * 1000;
    this.pollCycleWatchdog = setInterval(() => {
      const now = Date.now();
      if (this.bootstrappedAt === 0) return;
      if (now - this.bootstrappedAt < STALL_THRESHOLD_MS) return;

      // Auto-reset circuit breaker after 30 min of quiet
      if (
        this.watchdogCircuitBroken &&
        now - this.watchdogCircuitBrokenAt > this.WATCHDOG_CIRCUIT_RESET_MS
      ) {
        this.watchdogCircuitBroken = false;
        this.watchdogRestarts = [];
        this.log('Watchdog circuit breaker reset after 30min quiet window');
      }
      if (this.watchdogCircuitBroken) return;

      const stallMs = now - this.lastPollCycleCompletedAt;
      if (stallMs <= STALL_THRESHOLD_MS) return;

      // Prune restart history older than the window
      this.watchdogRestarts = this.watchdogRestarts.filter(
        t => now - t < this.WATCHDOG_WINDOW_MS,
      );

      // Circuit break: too many restarts mean restart isn't fixing it
      if (this.watchdogRestarts.length >= this.WATCHDOG_MAX_RESTARTS) {
        this.watchdogCircuitBroken = true;
        this.watchdogCircuitBrokenAt = now;
        const winMin = this.WATCHDOG_WINDOW_MS / 60_000;
        const resetMin = this.WATCHDOG_CIRCUIT_RESET_MS / 60_000;
        this.log(
          `Watchdog circuit breaker TRIPPED: ${this.watchdogRestarts.length} restarts in ${winMin}min. ` +
            `Halting auto-restart for ${resetMin}min — likely upstream issue (Telegram/Anthropic down). ` +
            `Check manually with: pm2 logs cortextos-daemon`,
        );
        if (this.telegramApi && this.chatId) {
          const agentName = this.agent.name;
          this.telegramApi
            .sendMessage(
              this.chatId,
              `⚠️ ${agentName} watchdog tripped — ${this.watchdogRestarts.length} auto-restarts in ${winMin}min. Restart loop paused ${resetMin}min. Likely upstream issue. Manual fix: pm2 restart cortextos-daemon`,
            )
            .catch(() => {});
        }
        this.lastPollCycleCompletedAt = now;
        return;
      }

      this.watchdogRestarts.push(now);
      this.log(
        `pollCycle stalled for ${Math.round(stallMs / 1000)}s — triggering hard-restart ` +
          `(${this.watchdogRestarts.length}/${this.WATCHDOG_MAX_RESTARTS} in ${this.WATCHDOG_WINDOW_MS / 60_000}min window)`,
      );
      this.agent.hardRestartSelf(`pollCycle stalled for ${Math.round(stallMs / 1000)}s`).catch(err => {
        this.log(`Force-restart error: ${err}`);
      });
      this.lastPollCycleCompletedAt = now;
    }, WATCHDOG_INTERVAL_MS);

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        // Race pollCycle against a timeout so a hung operation (e.g. stuck
        // fetch, slow execFile) can't freeze the loop indefinitely. If the
        // timeout fires, the underlying operation is abandoned (may still
        // resolve in the background) and the loop continues on the next tick.
        await Promise.race([
          this.pollCycle(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`pollCycle timeout after ${this.POLL_CYCLE_TIMEOUT_MS}ms`)),
              this.POLL_CYCLE_TIMEOUT_MS,
            ),
          ),
        ]);
        this.lastPollCycleCompletedAt = Date.now();
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      await this.sleepInterruptible(this.pollInterval);
    }

    if (process.platform !== 'win32') {
      process.removeListener('SIGUSR1', sigusr1Handler);
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollCycleWatchdog !== null) {
      clearInterval(this.pollCycleWatchdog);
      this.pollCycleWatchdog = null;
    }
  }

  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted: string): void {
    this.telegramMessages.push({ formatted, ackIds: [] });
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages
    let hasTelegramMessage = false;
    while (this.telegramMessages.length > 0) {
      const msg = this.telegramMessages.shift()!;
      messageBlock += msg.formatted;
      hasTelegramMessage = true;
    }

    // Check agent inbox
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }

    // Inject if there's anything
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      if (injected) {
        // ACK inbox messages
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        // Only update typing timestamp for Telegram messages, not inbox/cron.
        // Inbox messages (agent-to-agent, session continuations) must not
        // restart the typing indicator after Stop has cleared it.
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
        }
        // Cooldown after injection
        await sleep(5000);
      }
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }

    // Watchdog: detect ctx-exhaustion survey + frozen stdout
    this.watchdogCheck();

    // Gmail watch: check on configured interval (default 15 min)
    await this.checkGmailWatch();

    // Slack watch: check on configured interval (default 60 sec)
    await this.checkSlackWatch();

    // Usage rate-limit guard: check every 15 min
    await this.checkUsageTier();
  }

  /**
   * Detect stuck agent and trigger hard-restart.
   * Ported from CRM fast-checker.sh (FROZEN_RESTART + context-threshold logic).
   *
   * Two signals:
   *   1. Claude Code's "How is Claude doing this session?" survey prompt — fires
   *      when context is exhausted and the session needs to end. If it appears
   *      in stdout, the agent is cooked.
   *   2. stdout log unchanged for 30+ min while the agent is "active" (has a
   *      pending message and no idle flag) — passively frozen.
   */
  private watchdogCheck(): void {
    if (this.watchdogTriggered) return;
    const now = Date.now();
    if (this.bootstrappedAt === 0 || now - this.bootstrappedAt < this.BOOTSTRAP_GRACE_MS) return;
    if (this.lastHardRestartAt > 0 && now - this.lastHardRestartAt < this.HARD_RESTART_COOLDOWN_MS) return;

    const stdoutPath = join(this.paths.logDir, 'stdout.log');
    if (!existsSync(stdoutPath)) return;

    let size: number;
    try { size = statSync(stdoutPath).size; } catch { return; }

    if (size !== this.stdoutLastSize) {
      this.stdoutLastSize = size;
      this.stdoutLastChangeAt = now;
    }

    // Read tail once — shared by Signal 1 and Signal 3
    let tail = '';
    try {
      const tailBytes = Math.min(20000, size);
      if (tailBytes > 0) {
        const fd = openSync(stdoutPath, 'r');
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        closeSync(fd);
        tail = buf.toString('utf-8');
      }
    } catch { /* non-critical */ }

    // Signal 1: session-survey prompt → immediate hard restart
    if (tail && /How is Claude doing this session\?/.test(tail)) {
      this.log('WATCHDOG: ctx-exhaustion survey prompt detected — hard-restarting');
      this.triggerHardRestart('ctx exhaustion: session survey prompt in stdout');
      return;
    }

    // Signal 3: context-threshold → proactive graceful restart
    if (tail && this.ctxThresholdPct > 0) {
      // Strip ANSI escape codes before applying the pattern
      const stripped = tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const pctMatch = stripped.match(/\[(?:Sonnet|Opus|Haiku)[^\]]*\][^\d]*(\d+)%/);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1], 10);
        if (pct >= this.ctxThresholdPct) {
          if (this.ctxThresholdTriggeredAt === 0 ||
              now - this.ctxThresholdTriggeredAt > this.CTX_THRESHOLD_COOLDOWN_MS) {
            // First trigger (or cooldown expired): inject graceful restart request
            this.ctxThresholdTriggeredAt = now;
            const msg = `Context window at ${pct}%. Please write your session memory and observations now, then run: cortextos bus hard-restart --reason "proactive context reset at ${pct}%"`;
            this.agent.injectMessage(msg);
            this.log(`WATCHDOG: ctx at ${pct}% >= threshold ${this.ctxThresholdPct}% — injected graceful restart request`);
          } else if (now - this.ctxThresholdTriggeredAt > this.CTX_THRESHOLD_FALLBACK_MS) {
            // Agent ignored the injection for 15 min — fallback hard restart
            const minAgo = Math.round((now - this.ctxThresholdTriggeredAt) / 60000);
            this.log(`WATCHDOG: ctx threshold fallback — agent ignored restart request for ${minAgo}min`);
            this.triggerHardRestart(`ctx threshold fallback: agent at ${pct}% ignored graceful restart for ${minAgo}min`);
            return;
          }
        }
      }
    }

    // Signal 2: stdout frozen for 30+ min while agent is active.
    if (
      this.lastMessageInjectedAt > 0 &&
      now - this.stdoutLastChangeAt > this.STDOUT_FROZEN_MS &&
      this.isAgentActive()
    ) {
      const stalledSec = Math.round((now - this.stdoutLastChangeAt) / 1000);
      this.log(`WATCHDOG: stdout frozen for ${stalledSec}s while active — hard-restarting`);
      this.triggerHardRestart(`frozen: stdout unchanged ${stalledSec}s while active`);
    }
  }

  private triggerHardRestart(reason: string): void {
    this.watchdogTriggered = true;
    this.lastHardRestartAt = Date.now();
    if (this.telegramApi && this.chatId) {
      this.telegramApi
        .sendMessage(this.chatId, `Got stuck (${reason}). Hard-restarting now.`)
        .catch(() => { /* non-critical */ });
    }
    this.agent.hardRestartSelf(reason).catch(e => this.log(`hardRestartSelf failed: ${e}`));
  }

  /**
   * Poll Gmail for unread messages matching the configured query.
   *
   * Runs on the configured interval (default 15 min). Uses the `gws` CLI
   * (https://github.com/google-workspace-utilities/gws) which reads OAuth
   * credentials from ~/.config/gws/. Requires `gws` to be authenticated.
   *
   * If unread messages are found: writes an inbox message so Claude wakes
   * and processes them. If nothing matches: does nothing (zero Claude cost).
   * Claude is responsible for marking messages read after processing.
   */
  private async checkGmailWatch(): Promise<void> {
    if (!this.gmailWatch) return;
    const now = Date.now();
    if (now - this.gmailLastCheckedAt < this.gmailWatch.intervalMs) return;
    this.gmailLastCheckedAt = now;
    this.saveGmailLastCheckedAt();

    // Fetch unread message list
    let listOutput = '';
    try {
      listOutput = await new Promise<string>((resolve, reject) => {
        execFile('gws', ['gmail', 'users', 'messages', 'list',
          '--params', JSON.stringify({ userId: 'me', q: this.gmailWatch!.query }),
          '--format', 'json',
        ], (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      this.log(`Gmail watch list failed: ${err}`);
      return;
    }

    let messageIds: string[] = [];
    try {
      const data = JSON.parse(listOutput);
      messageIds = (data?.messages ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    } catch {
      this.log('Gmail watch: could not parse list response');
      return;
    }

    if (messageIds.length === 0) return; // nothing to do

    // Filter out already-delivered IDs (2h TTL dedup)
    this.pruneGmailDeliveredIds();
    const newIds = messageIds.filter(id => !this.gmailDeliveredIds.has(id));
    if (newIds.length === 0) {
      this.log('Gmail watch: all messages already delivered — skipping');
      return;
    }

    // Fetch snippet + subject for each new message (metadata format only)
    const summaries: string[] = [];
    for (const id of newIds.slice(0, 20)) { // cap at 20 to avoid runaway fetches
      try {
        const getOutput = await new Promise<string>((resolve, reject) => {
          execFile('gws', ['gmail', 'users', 'messages', 'get',
            '--params', JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From'] }),
            '--format', 'json',
          ], (err, stdout) => {
            if (err) { reject(err); return; }
            resolve(stdout);
          });
        });
        const msg = JSON.parse(getOutput);
        const headers: Array<{ name: string; value: string }> = msg?.payload?.headers ?? [];
        const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value ?? '(unknown)';
        const snippet = msg?.snippet ?? '';
        summaries.push(`ID: ${id}\n   Subject: ${subject}\n   From: ${from}\n   Snippet: ${snippet.slice(0, 200)}`);
      } catch {
        summaries.push(`ID: ${id} (could not fetch details)`);
      }
    }

    const total = newIds.length;
    const shown = summaries.length;
    const header = `=== GMAIL WATCH: ${total} unread message${total !== 1 ? 's' : ''} ===\n` +
      `Query: ${this.gmailWatch.query}\n\n`;
    const body = summaries.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
    const footer = total > shown ? `\n\n(${total - shown} more not shown)` : '';
    const hint = `\n\nProcess: gws gmail users messages get --params '{"userId":"me","id":"<ID>","format":"full"}' --format json` +
      `\nMark read: gws gmail users messages modify --params '{"userId":"me","id":"<ID>"}' --json '{"removeLabelIds":["UNREAD"]}' --format json`;

    const inboxText = header + body + footer + hint;
    this.log(`Gmail watch: ${total} new unread message(s) — writing inbox`);

    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'normal', inboxText);
      // Record delivered IDs
      for (const id of newIds.slice(0, 20)) {
        this.gmailDeliveredIds.set(id, now);
      }
      this.saveGmailDeliveredIds();
    } catch (err) {
      this.log(`Gmail watch inbox write failed: ${err}`);
    }
  }

  private loadGmailLastCheckedAt(): void {
    try {
      if (existsSync(this.gmailLastCheckedPath)) {
        const raw = readFileSync(this.gmailLastCheckedPath, 'utf-8').trim();
        const epoch = parseInt(raw, 10);
        if (!isNaN(epoch)) this.gmailLastCheckedAt = epoch;
      }
    } catch (err) {
      this.log(`Gmail watch: could not load last-checked timestamp (restart dedup disabled): ${err}`);
    }
  }

  private saveGmailLastCheckedAt(): void {
    try {
      writeFileSync(this.gmailLastCheckedPath, String(this.gmailLastCheckedAt) + '\n', 'utf-8');
    } catch (err) {
      this.log(`Gmail watch: could not persist last-checked timestamp: ${err}`);
    }
  }

  private loadGmailDeliveredIds(): void {
    try {
      if (existsSync(this.gmailDeliveredIdsPath)) {
        const raw = JSON.parse(readFileSync(this.gmailDeliveredIdsPath, 'utf-8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [id, ts] of Object.entries(raw)) {
            if (typeof ts === 'number') this.gmailDeliveredIds.set(id, ts);
          }
        }
      }
    } catch (err) {
      this.log(`Gmail watch: could not load delivered IDs (message dedup disabled): ${err}`);
    }
  }

  private saveGmailDeliveredIds(): void {
    try {
      const obj: Record<string, number> = {};
      for (const [id, ts] of this.gmailDeliveredIds) {
        obj[id] = ts;
      }
      writeFileSync(this.gmailDeliveredIdsPath, JSON.stringify(obj) + '\n', 'utf-8');
    } catch (err) {
      this.log(`Gmail watch: could not persist delivered IDs: ${err}`);
    }
  }

  private pruneGmailDeliveredIds(): void {
    const cutoff = Date.now() - this.GMAIL_DELIVERED_TTL_MS;
    for (const [id, ts] of this.gmailDeliveredIds) {
      if (ts < cutoff) this.gmailDeliveredIds.delete(id);
    }
  }

  private async checkSlackWatch(): Promise<void> {
    if (!this.slackWatch || !this.slackApi) return;
    const now = Date.now();
    if (now - this.slackLastCheckedAt < this.slackWatch.intervalMs) return;
    this.slackLastCheckedAt = now;

    let messages: SlackMessage[] = [];
    try {
      messages = await this.slackApi.getHistory(this.slackWatch.channel, this.slackLastTs);
    } catch (err) {
      this.log(`Slack watch poll failed: ${err}`);
      return;
    }

    // Filter out bot's own messages to prevent self-wake loops
    messages = messages.filter(m => m.subtype !== 'bot_message');
    if (messages.length === 0) return;

    const newest = messages[messages.length - 1];
    this.slackLastTs = newest.ts;

    const formatted: string[] = [];
    for (const msg of messages.slice(0, 10)) {
      let displayName = msg.username ?? msg.user ?? 'unknown';
      if (msg.user && !msg.username && this.slackApi) {
        displayName = await this.slackApi.getUserName(msg.user).catch(() => msg.user ?? 'unknown');
      }
      formatted.push(
        `=== SLACK from ${displayName} (channel:${this.slackWatch.channel} ts:${msg.ts}) ===\n` +
        `${msg.text}\n` +
        `Reply using: cortextos bus send-slack ${this.slackWatch.channel} "<reply>"`,
      );
    }

    const remaining = messages.length - formatted.length;
    const trailer = remaining > 0 ? `\n\n(${remaining} more messages not shown)` : '';
    const inboxText = formatted.join('\n\n---\n\n') + trailer;

    this.log(`Slack watch: ${messages.length} new message(s) in ${this.slackWatch.channel} — writing inbox`);
    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'normal', inboxText);
    } catch (err) {
      this.log(`Slack watch inbox write failed: ${err}`);
    }
  }

  /**
   * Check Claude Max API utilization and send tier-transition alerts.
   *
   * Runs every 15 minutes. Calls `cortextos bus check-usage-api` and reads
   * the JSON output. Computes tier (0=normal, 1=high≥85%, 2=critical≥95%).
   * On tier change: sends a Telegram alert directly (no Claude wake) and
   * writes an inbox message so Claude acts on it next time it is awake.
   * Tier state persists across restarts in usage-tier.json.
   */
  private async checkUsageTier(): Promise<void> {
    const now = Date.now();
    if (now - this.usageLastCheckedAt < this.USAGE_CHECK_INTERVAL_MS) return;
    this.usageLastCheckedAt = now;

    let rawJson = '';
    try {
      rawJson = await new Promise<string>((resolve, reject) => {
        // Request JSON output — the CLI command doesn't accept the old shell
        // script's --warn-* flags. Alerting is handled here on tier transitions.
        execFile('cortextos', ['bus', 'check-usage-api', '--json'], (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      this.log(`Usage check failed: ${err}`);
      return;
    }

    let utilization = -1;
    try {
      const data = JSON.parse(rawJson);
      // Support both formats: new CLI flat 0-1 floats (five_hour_utilization)
      // and legacy nested percentage (five_hour.utilization). Percentages assumed
      // if value > 1.
      const rawFiveH = data?.five_hour_utilization ?? data?.five_hour?.utilization;
      const rawSevenD = data?.seven_day_utilization ?? data?.seven_day?.utilization;
      const toPct = (v: unknown): number =>
        typeof v === 'number' ? (v <= 1 ? v * 100 : v) : -1;
      const fiveH = toPct(rawFiveH);
      const sevenD = toPct(rawSevenD);
      utilization = Math.max(fiveH, sevenD);
    } catch {
      this.log('Usage check: could not parse response');
      return;
    }

    if (utilization < 0) return;

    const newTier: 0 | 1 | 2 = utilization >= 95 ? 2 : utilization >= 85 ? 1 : 0;
    const prevTier = this.usageTier;

    if (newTier === prevTier) return; // no transition — stay quiet

    this.usageTier = newTier;
    this.saveUsageTier();

    const pct = Math.round(utilization);
    const msg = newTier === 0
      ? `Rate limit recovered. Utilization at ${pct}%. Resuming normal operations.`
      : newTier === 1
        ? `Rate limit at ${pct}%. Tier 1 wind-down: finish current task, no new autonomous work.`
        : `Rate limit at ${pct}%. Critical threshold reached. Going dark — do not start new work. Will notify on reset.`;

    this.log(`Usage tier transition: ${prevTier} → ${newTier} (${pct}%)`);

    // 1. Send Telegram alert directly (no Claude wake needed)
    if (this.telegramApi && this.chatId) {
      this.telegramApi.sendMessage(this.chatId, msg).catch(() => { /* non-critical */ });
    }

    // 2. Write inbox message so Claude acts on it next time it is awake
    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'urgent', msg);
    } catch (err) {
      this.log(`Usage tier inbox write failed: ${err}`);
    }
  }

  /**
   * Load usage tier from persistent file.
   */
  private loadUsageTier(): void {
    try {
      if (existsSync(this.usageTierFile)) {
        const data = JSON.parse(readFileSync(this.usageTierFile, 'utf-8'));
        if (data.tier === 0 || data.tier === 1 || data.tier === 2) {
          this.usageTier = data.tier;
        }
      }
    } catch {
      this.usageTier = 0;
    }
  }

  /**
   * Persist current usage tier to file.
   */
  private saveUsageTier(): void {
    try {
      writeFileSync(this.usageTierFile, JSON.stringify({ tier: this.usageTier, checkedAt: Date.now() }) + '\n', 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    return `=== AGENT MESSAGE from ${msg.from}${replyNote} [msg_id: ${msg.id}] ===
\`\`\`
${msg.text}
\`\`\`
Reply using: cortextos bus send-message ${msg.from} normal '<your reply>' ${msg.id}

`;
  }

  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(
    from: string,
    chatId: string | number,
    text: string,
    frameworkRoot: string,
    replyToText?: string,
    lastSentText?: string,
  ): string {
    let replyCx = '';
    if (replyToText) {
      replyCx = `[Replying to: "${replyToText.slice(0, 500)}"]\n`;
    }

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${lastSentText.slice(0, 500)}"]\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
    const body = isSlashCommand
      ? text.trim()
      : `\`\`\`\n${text}\n\`\`\``;
    return `=== TELEGRAM from [USER: ${from}] (chat_id:${chatId}) ===
${replyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    imagePath: string,
  ): string {
    return `=== TELEGRAM PHOTO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
  ): string {
    return `=== TELEGRAM DOCUMENT from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VOICE from ${from} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    duration: number | undefined,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VIDEO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
duration: ${dur}s
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Wait for the agent to finish bootstrapping.
   */
  private async waitForBootstrap(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return;
      }
      await sleep(2000);
    }
    this.log('Bootstrap timeout - proceeding anyway');
  }

  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  private async sendTyping(api: TelegramAPI, chatId: string): Promise<void> {
    const now = Date.now();
    if (now - this.typingLastSent >= 4000) {
      try {
        await api.sendChatAction(chatId, 'typing');
      } catch {
        // Ignore typing indicator failures (matches bash: || true)
      }
      this.typingLastSent = now;
    }
  }

  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(stateDir: string, chatId: string | number): string | null {
    const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      if (!content) return null;
      return content.slice(0, 500);
    } catch {
      return null;
    }
  }

  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query: TelegramCallbackQuery, activityApi: TelegramAPI): Promise<void> {
    const data = stripControlChars(query.data || '');
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Identical
    // check to handleCallback — approval clicks are as sensitive as
    // permission clicks and the same gate applies.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: activity-channel callback from unauthorized user ${fromUserId} - rejecting`);
        try { await activityApi.answerCallbackQuery(callbackQueryId, 'Not authorized'); } catch { /* ignore */ }
        return;
      }
    }

    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (!apprMatch) {
      this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
      try { await activityApi.answerCallbackQuery(callbackQueryId, 'Unknown button'); } catch { /* ignore */ }
      return;
    }

    await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, activityApi);
  }

  /**
   * Shared approval-callback resolution path. Called by both handleCallback
   * (agent's own bot) and handleActivityCallback (activity-channel bot).
   *
   * Resolves the approval via updateApproval (which moves the file from
   * pending/ to resolved/ and notifies the requesting agent via inbox),
   * answers the Telegram callback so the spinner stops, and edits the
   * original message to show who approved/denied for the audit trail.
   *
   * `api` is the TelegramAPI that owns the bot the callback came from —
   * answerCallbackQuery and editMessageText must target the same bot.
   */
  private async routeApprovalCallback(
    decision: 'allow' | 'deny',
    approvalId: string,
    query: TelegramCallbackQuery,
    api: TelegramAPI | undefined,
  ): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    const status = decision === 'allow' ? 'approved' : 'rejected';

    // Build a friendly audit-trail suffix: "by Alice (@alice)" or just
    // "by Alice" if no username. Falls back to the Telegram user id if
    // both are missing (shouldn't happen in practice but guards edge).
    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username
      ? `${firstName} (@${username})`
      : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? 'unknown'}`);
    const auditNote = `via Telegram activity channel by ${auditWho}`;

    try {
      updateApproval(this.paths, approvalId, status, auditNote);
    } catch (err) {
      this.log(`Approval callback: updateApproval failed for ${approvalId}: ${err}`);
      if (api) {
        try { await api.answerCallbackQuery(callbackQueryId, 'Approval not found or already resolved'); } catch { /* ignore */ }
      }
      return;
    }

    if (api) {
      try { await api.answerCallbackQuery(callbackQueryId, decision === 'allow' ? 'Approved' : 'Denied'); } catch { /* ignore */ }
      if (chatId && messageId) {
        const label = decision === 'allow' ? `✅ Approved by ${auditWho}` : `❌ Denied by ${auditWho}`;
        try { await api.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
      }
    }
    this.log(`Approval callback: ${decision} for ${approvalId} by ${auditWho}`);
  }

  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const data = stripControlChars(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Without this,
    // anyone who sees a button (forwarded message, group, etc.) could click it.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: callback from unauthorized user ${fromUserId} - rejecting`);
        return;
      }
    }

    // Approval callbacks: appr_(allow|deny)_{approvalId}
    // These originate from the org's activity channel bot (see
    // handleActivityCallback) but may also arrive here if an operator
    // ever routes an approval button through the agent's own bot. The
    // prefix check is cheap and routing-agnostic.
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (apprMatch) {
      await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, this.telegramApi);
      return;
    }

    // Permission callbacks: perm_(allow|deny|continue)_{hexId}
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === 'continue' ? 'deny' : decision;
      const responseFile = join(this.paths.stateDir, `hook-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const labelMap: Record<string, string> = { allow: 'Approved', deny: 'Denied', continue: 'Continue in Chat' };
          try { await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision); } catch { /* ignore */ }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }

    // Restart callbacks: restart_(allow|deny)_{hexId}
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = join(this.paths.stateDir, `restart-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const label = decision === 'allow' ? 'Restart Approved' : 'Restart Denied';
          try { await this.telegramApi.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }

    // AskUserQuestion single-select: askopt_{questionIdx}_{optionIdx}
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Answered'); } catch { /* ignore */ }
        }
      }

      // Navigate TUI: Down * oIdx, then Enter
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep(50);
      }
      await sleep(100);
      this.agent.write(KEYS.ENTER);

      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);

      // Check for more questions
      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // AskUserQuestion multi-select toggle: asktoggle_{questionIdx}_{optionIdx}
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Toggled'); } catch { /* ignore */ }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          if (!state.multi_select_chosen) state.multi_select_chosen = [];

          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Update Telegram message with current selections
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a: number, b: number) => a - b);
            const chosenDisplay = chosen.map((i: number) => i + 1).join(', ');
            const question = state.questions?.[qIdx];
            const options: string[] = question?.options || [];

            // Build keyboard with toggle buttons + submit
            const keyboard: Array<Array<{ text: string; callback_data: string }>> = options.map((opt: string, i: number) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`,
            }]);
            keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${qIdx}` }]);

            const text = chosenDisplay
              ? `Selected: ${chosenDisplay}\nTap more options or Submit`
              : 'Tap options to toggle, then tap Submit';

            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }

    // AskUserQuestion multi-select submit: asksubmit_{questionIdx}
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Submitted'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Submitted'); } catch { /* ignore */ }
        }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const chosenIndices: number[] = [...(state.multi_select_chosen || [])].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;

          // Navigate TUI: for each chosen index, move Down from current position, press Space
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep(50);
            currentPos = idx;
          }

          // Navigate to Submit button (past all options + 1 for "Other")
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep(50);
          }
          await sleep(100);
          this.agent.write(KEYS.ENTER);

          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);

          // Reset multi_select_chosen
          state.multi_select_chosen = [];
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Check for more questions
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    this.log(`Unhandled callback data: ${data}`);
  }

  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx: number): Promise<void> {
    if (!this.telegramApi || !this.chatId) {
      this.log('sendNextQuestion: no Telegram API or chatId configured');
      return;
    }

    const askStatePath = join(this.paths.stateDir, 'ask-state.json');
    if (!existsSync(askStatePath)) {
      this.log('sendNextQuestion: state file not found');
      return;
    }

    try {
      const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }

      const qText = question.question || 'Question';
      const qHeader = question.header || '';
      const qMulti = question.multiSelect === true;
      const qOptions: string[] = question.options || [];

      // Build message text
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `\n${qHeader}`;
      msg += `\n${qText}\n`;
      if (qMulti) {
        msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `\n${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }

      // Build inline keyboard
      let keyboard: Array<Array<{ text: string; callback_data: string }>>;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`,
        }]);
        keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`,
        }]);
      }

      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }

  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Check for .urgent-signal file and process it.
   */
  private checkUrgentSignal(): void {
    const urgentPath = join(this.paths.stateDir, '.urgent-signal');
    if (existsSync(urgentPath)) {
      try {
        const content = readFileSync(urgentPath, 'utf-8').trim();
        this.log(`Urgent signal detected: ${content}`);
        unlinkSync(urgentPath);

        // Inject the urgent message
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n\`\`\`\n${content}\n\`\`\`\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file.
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const hashes = content.trim().split('\n').filter(Boolean);
        // Keep only last 1000 hashes to prevent file bloat
        const recent = hashes.slice(-1000);
        this.seenHashes = new Set(recent);
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Set();
    }
  }

  /**
   * Save dedup hashes to persistent file.
   */
  private saveDedupHashes(): void {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1000);
      writeFileSync(this.dedupFilePath, hashes.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive(): boolean {
    // Hook-based approach only. Claude Code writes ANSI escape codes (spinner,
    // cursor movement) to stdout constantly even when idle, so stdout.log always
    // grows — using file size as an activity signal produces a permanent "typing"
    // indicator. Instead, rely solely on:
    //   - lastMessageInjectedAt: when fast-checker last pushed a message in
    //   - last_idle.flag: written by the Stop hook when Claude finishes a turn
    // This gives accurate per-turn typing with no false positives.

    if (this.lastMessageInjectedAt === 0) return false;

    const now = Date.now();
    const tenMinMs = 10 * 60 * 1000;
    if (now - this.lastMessageInjectedAt > tenMinMs) return false;

    // Clear typing immediately when the agent sends a reply.
    // outbound-messages.jsonl grows each time the agent calls send-telegram.
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    try {
      if (existsSync(outboundPath)) {
        const { size } = require('fs').statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          // First check: seed baseline, don't trigger yet
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          // New reply sent — clear typing state
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          return false;
        }
      }
    } catch { /* non-critical */ }

    // Read last_idle.flag written by the Stop hook
    const flagPath = join(this.paths.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) {
        // No idle flag yet — hook hasn't fired, so still working
        return true;
      }
      const idleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      // Typing if injection happened AFTER the last idle signal
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true; // Can't read flag — assume still active
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
