import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { log } from '@/utils/logger';
import type {
  ACPClientConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  ContentBlock,
  SessionUpdate,
  AgentCapabilities,
} from './types';

/**
 * Resolves the path to the claude-code-acp binary
 */
function resolveClaudeCodeBinary(): string {
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve(
      '@zed-industries/claude-code-acp/package.json',
    );
    const packageJson = require(packageJsonPath) as {
      bin?: string | Record<string, string>;
    };

    let binRelativePath: string;
    if (typeof packageJson.bin === 'string') {
      binRelativePath = packageJson.bin;
    } else if (
      typeof packageJson.bin === 'object' &&
      packageJson.bin['claude-code-acp']
    ) {
      binRelativePath = packageJson.bin['claude-code-acp'];
    } else {
      throw new Error(
        'Invalid bin field in @zed-industries/claude-code-acp package.json',
      );
    }

    const packageDir = dirname(packageJsonPath);
    return resolve(packageDir, binRelativePath);
  } catch (error) {
    throw new Error(
      `Claude Code ACP binary not found. Ensure @zed-industries/claude-code-acp is installed. Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * ACP Client for managing the Claude Code ACP adapter subprocess
 */
export class ACPClient {
  private childProcess: ChildProcess | null = null;
  private isShuttingDown = false;
  private messageBuffer = '';
  private requestId = 0;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private eventEmitter: EventEmitter = new EventEmitter();
  private sessionId: string | null = null;
  private isInitialized = false;
  private agentCapabilities: AgentCapabilities | null = null;
  private restartAttempts = 0;
  private readonly maxRestartAttempts = 3;
  private readonly baseRestartDelay = 2000;
  private readonly maxRestartDelay = 16000;
  private readonly requestTimeout = 30000;

  constructor(private config: ACPClientConfig) {
    log.debug(
      `ACPClient initialized with working directory: ${config.workingDirectory}`,
    );
  }

  /**
   * Connect to the ACP adapter by spawning the subprocess
   */
  async connect(): Promise<void> {
    if (this.childProcess) {
      log.debug('ACP process already running');
      return;
    }

    // Clear shutdown flag before spawning a new process
    this.isShuttingDown = false;

    const binaryPath = resolveClaudeCodeBinary();
    log.debug(`Resolved ACP binary path: ${binaryPath}`);

    try {
      const spawnArgs: string[] = [];
      const command =
        process.platform === 'win32' ? process.execPath : binaryPath;
      if (process.platform === 'win32') {
        spawnArgs.push(binaryPath);
      }

      this.childProcess = spawn(command, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...this.config.env,
        },
        cwd: this.config.workingDirectory,
      });

      const childProcess = this.childProcess;
      log.debug(`ACP process spawned with PID: ${childProcess.pid}`);

      // Set up stdout handler for JSON-RPC messages
      childProcess.stdout?.on('data', (chunk: Buffer) => {
        this.handleStdoutData(chunk);
      });

      // Set up stderr handler for error logging
      childProcess.stderr?.on('data', (chunk: Buffer) => {
        const errorOutput = chunk.toString().trim();
        log.error(`ACP stderr: ${errorOutput}`);
      });

      // Set up process exit handler
      childProcess.on('exit', (code, signal) => {
        this.handleProcessExit(code, signal);
      });

      // Set up process error handler
      childProcess.on('error', (error) => {
        log.error(`ACP process error: ${error.message}`);
        this.rejectAllPendingRequests(
          new Error(`ACP process error: ${error.message}`),
        );
        this.eventEmitter.emit('error', error);
      });

      log.debug('ACP process connected successfully');
    } catch (error) {
      throw new Error(
        `Failed to spawn Claude Code ACP process: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Handle incoming data from stdout
   */
  private handleStdoutData(chunk: Buffer): void {
    this.messageBuffer += chunk.toString();

    // Process complete messages (newline-delimited)
    const lines = this.messageBuffer.split('\n');
    this.messageBuffer = lines.pop() || '';

    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;

      try {
        const message = JSON.parse(clean) as
          | JSONRPCResponse
          | JSONRPCNotification;
        if (this.config.verbose) {
          log.debug(`ACP received: ${JSON.stringify(message)}`);
        }

        if ('id' in message) {
          this.handleResponse(message);
        } else {
          this.handleNotification(message);
        }
      } catch (error) {
        log.error(`Failed to parse JSON-RPC message: ${clean}`);
      }
    }
  }

  /**
   * Handle process exit event
   */
  private handleProcessExit(code: number | null, signal: string | null): void {
    log.debug(`ACP process exited with code: ${code}, signal: ${signal}`);
    this.childProcess = null;
    this.rejectAllPendingRequests(
      new Error(`ACP process exited with code: ${code}`),
    );
    this.eventEmitter.emit('process-exit', code, signal);

    // Trigger restart if not shutting down and exit was unexpected
    if (!this.isShuttingDown && (code !== 0 || signal !== null)) {
      if (this.restartAttempts < this.maxRestartAttempts) {
        // Calculate exponential backoff delay
        const delay = Math.min(
          this.baseRestartDelay * Math.pow(2, this.restartAttempts),
          this.maxRestartDelay,
        );
        log.warn(
          `ACP process crashed, attempting restart (${this.restartAttempts + 1}/${this.maxRestartAttempts}) after ${delay}ms`,
        );
        setTimeout(() => {
          this.restart().catch((error) => {
            log.error(`Failed to restart ACP process: ${error.message}`);
            this.eventEmitter.emit('fatal-error', error);
          });
        }, delay);
      } else {
        const error = new Error(
          'ACP process failed after maximum restart attempts',
        );
        log.error(error.message);
        this.eventEmitter.emit('fatal-error', error);
      }
    }
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.childProcess || !this.childProcess.stdin) {
      throw new Error('ACP process not connected');
    }

    this.requestId++;
    const id = this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const requestStr = JSON.stringify(request) + '\n';
    if (this.config.verbose) {
      log.debug(`ACP sending: ${requestStr.trim()}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.childProcess!.stdin!.write(requestStr);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Failed to write to ACP process: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /**
   * Handle JSON-RPC response
   */
  private handleResponse(message: JSONRPCResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      log.warn(`Received response for unknown request ID: ${message.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id);

    if (message.error) {
      const error = new Error(
        `ACP protocol error: ${message.error.message} (code: ${message.error.code})`,
      );
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  /**
   * Handle JSON-RPC notification
   */
  private handleNotification(message: JSONRPCNotification): void {
    if (message.method === 'session/update') {
      const update = message.params as SessionUpdate;
      if (this.config.verbose) {
        log.debug(
          `Session update received: ${JSON.stringify(update.update.sessionUpdate)}`,
        );
      }
      this.eventEmitter.emit('session-update', update);
    } else {
      if (this.config.verbose) {
        log.debug(`Unhandled notification: ${message.method}`);
      }
    }
  }

  /**
   * Reject all pending requests
   */
  private rejectAllPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Initialize the ACP protocol
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      log.debug('ACP already initialized');
      return;
    }

    const params: InitializeParams = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    };

    try {
      const result = (await this.sendRequest('initialize', params)) as InitializeResult;

      if (result.protocolVersion !== 1) {
        throw new Error(
          `Protocol version mismatch: expected 1, got ${result.protocolVersion}`,
        );
      }

      this.agentCapabilities = result.agentCapabilities;
      this.isInitialized = true;
      this.restartAttempts = 0; // Reset restart attempts on successful init

      log.debug(
        `ACP initialized with capabilities: ${JSON.stringify(result.agentCapabilities)}`,
      );
    } catch (error) {
      throw new Error(
        `Failed to initialize ACP: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create a new session
   */
  async createSession(cwd: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('ACP not initialized. Call initialize() first.');
    }

    if (!cwd || !isAbsolute(cwd)) {
      throw new Error('Invalid working directory path');
    }

    const params: SessionNewParams = {
      cwd,
      mcpServers: [],
    };

    try {
      const result = (await this.sendRequest('session/new', params)) as SessionNewResult;
      this.sessionId = result.sessionId;
      log.debug(`ACP session created: ${this.sessionId}`);
      return this.sessionId;
    } catch (error) {
      throw new Error(
        `Failed to create ACP session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Send a prompt to the current session
   */
  async sendPrompt(prompt: ContentBlock[]): Promise<SessionPromptResult> {
    if (!this.sessionId) {
      throw new Error('No active session. Call createSession() first.');
    }

    const params: SessionPromptParams = {
      sessionId: this.sessionId,
      prompt,
    };

    try {
      log.debug(`Sending prompt to session ${this.sessionId}`);
      const result = (await this.sendRequest('session/prompt', params)) as SessionPromptResult;
      log.debug(`Prompt completed with stop reason: ${result.stopReason}`);
      return result;
    } catch (error) {
      throw new Error(
        `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Restart the ACP process
   */
  async restart(): Promise<void> {
    log.debug('Restarting ACP process');
    this.restartAttempts++;

    if (this.childProcess) {
      await this.shutdown();
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    await this.connect();

    if (this.isInitialized) {
      await this.initialize();
    }

    if (this.sessionId) {
      // Re-create session after restart
      const oldSessionId = this.sessionId;
      this.sessionId = null;
      try {
        await this.createSession(this.config.workingDirectory);
        log.debug(
          `Session re-created after restart (old: ${oldSessionId}, new: ${this.sessionId})`,
        );
      } catch (error) {
        log.error(
          `Failed to re-create session after restart: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Gracefully shutdown the ACP process
   */
  async shutdown(): Promise<void> {
    if (!this.childProcess || this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    log.debug('Shutting down ACP client');

    return new Promise((resolve) => {
      if (!this.childProcess) {
        this.cleanup();
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        if (this.childProcess && !this.childProcess.killed) {
          log.debug('Force killing ACP process with SIGKILL');
          this.childProcess.kill('SIGKILL');
        }
      }, 5000);

      this.childProcess.on('exit', () => {
        clearTimeout(timeout);
        this.childProcess = null;
        this.cleanup();
        this.isShuttingDown = false;
        log.debug('ACP client shut down');
        resolve();
      });

      if (!this.childProcess.killed) {
        log.debug('Sending SIGTERM to ACP process');
        this.childProcess.kill('SIGTERM');
      }
    });
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.rejectAllPendingRequests(new Error('ACP client shutting down'));
    this.eventEmitter.removeAllListeners();
    this.isInitialized = false;
    this.sessionId = null;
  }

  /**
   * Register event handler
   */
  on(event: string, handler: (...args: unknown[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  /**
   * Unregister event handler
   */
  off(event: string, handler: (...args: unknown[]) => void): void {
    this.eventEmitter.off(event, handler);
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if ACP is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.childProcess !== null;
  }

  /**
   * Get agent capabilities
   */
  getCapabilities(): AgentCapabilities | null {
    return this.agentCapabilities;
  }
}

export default ACPClient;
