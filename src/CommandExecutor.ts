import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync } from 'node:fs';
import ProcessTracker from './ProcessTracker.js';
import TtyOutputReader from './TtyOutputReader.js';

/**
 * CommandExecutor handles sending commands to iTerm2 via AppleScript.
 * 
 * This includes special handling for multiline text to prevent AppleScript syntax errors
 * when dealing with newlines in command strings. The approach uses AppleScript string 
 * concatenation with explicit line breaks rather than trying to embed newlines directly
 * in the AppleScript string.
 */

const execPromise = promisify(exec);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class CommandExecutor {
  private _execPromise: typeof execPromise;

  constructor(execPromiseOverride?: typeof execPromise) {
    this._execPromise = execPromiseOverride || execPromise;
  }

  /**
   * Wraps a promise with a timeout
   * @param promise The promise to wrap
   * @param timeoutMs Timeout in milliseconds
   * @param errorMessage Error message for timeout
   * @returns Promise that rejects on timeout or resolves with the original promise
   */
  private async withTimeout<T>(
    promise: Promise<T>, 
    timeoutMs: number, 
    errorMessage: string
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * Executes a command in the iTerm2 terminal.
   * 
   * This method handles both single-line and multiline commands by:
   * 1. Properly escaping the command string for AppleScript
   * 2. Using different AppleScript approaches based on whether the command contains newlines
   * 3. Waiting for the command to complete execution with optional timeout
   * 4. Retrieving the terminal output after command execution
   * 
   * @param windowId The iTerm2 window ID to target
   * @param command The command to execute (can contain newlines)
   * @param timeoutSeconds Maximum time to wait for command completion (default: 30)
   * @param returnOutputLines Number of lines to return from terminal output (default: 0, disabled)
   * @param tabIndex Optional tab index to target (0-based, defaults to current session)
   * @returns A promise that resolves to execution metadata and optionally terminal output
   */
  async executeCommand(windowId: string, command: string, timeoutSeconds = 30, returnOutputLines = 0, tabIndex?: number): Promise<{newLines: number, executionTime: number, output?: string | null}> {
    const escapedCommand = this.escapeForAppleScript(command);
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    
    try {
      // Get buffer state before command execution to calculate new lines
      const beforeCommandBuffer = await TtyOutputReader.retrieveBuffer(windowId, undefined, tabIndex);
      const beforeCommandBufferLines = beforeCommandBuffer.split("\n").length;
      
      // Build the session target based on whether we're targeting a specific tab
      const sessionTarget = tabIndex !== undefined 
        ? `tell tab ${tabIndex + 1} to tell current session`
        : `tell current session`;
      
      // Check if this is a multiline command (which would have been processed differently)
      if (command.includes('\n')) {
        // For multiline text, we use parentheses around our prepared string expression
        // This allows AppleScript to evaluate the string concatenation expression
        await this._execPromise(`/usr/bin/osascript -e 'tell application "iTerm2" to tell window id "${windowId}" to ${sessionTarget} to write text (${escapedCommand}) newline YES'`);
      } else {
        // For single line commands, we can use the standard approach with quoted strings
        await this._execPromise(`/usr/bin/osascript -e 'tell application "iTerm2" to tell window id "${windowId}" to ${sessionTarget} to write text "${escapedCommand}" newline YES'`);
      }
      
      // Phase 1: Wait for processing to complete (25% of timeout)
      const processingTimeout = timeoutMs * 0.25;
      await this.withTimeout(
        this.waitForProcessingComplete(windowId, tabIndex),
        processingTimeout,
        `Command timed out waiting for processing to complete (${processingTimeout/1000}s)`
      );
      
      // Phase 2: Wait for user input ready (70% of remaining timeout)
      const elapsedTime = Date.now() - startTime;
      const remainingTime = Math.max(timeoutMs - elapsedTime, 1000); // At least 1 second
      const inputTimeout = Math.min(remainingTime * 0.93, timeoutMs * 0.7);
      
      const ttyPath = await this.retrieveTtyPath(windowId, tabIndex);
      await this.withTimeout(
        this.waitForUserInputReady(windowId, ttyPath),
        inputTimeout,
        `Command timed out waiting for completion (${timeoutSeconds}s total timeout exceeded)`
      );

      // Phase 3: Give a small delay for output to settle
      await sleep(200);
      
      // Get buffer state after command execution
      const afterCommandBuffer = await TtyOutputReader.retrieveBuffer(windowId, undefined, tabIndex);
      const afterCommandBufferLines = afterCommandBuffer.split("\n").length;
      const newLines = afterCommandBufferLines - beforeCommandBufferLines;
      
      const executionTime = Date.now() - startTime;
      
      // Capture output lines if requested
      let output: string | null | undefined;
      if (returnOutputLines > 0) {
        try {
          const lines = afterCommandBuffer.split('\n');
          output = lines.slice(-returnOutputLines - 1).join('\n');
        } catch (error: unknown) {
          // If output reading fails, log warning but don't fail the entire command
          console.warn(`Failed to capture output lines: ${(error as Error).message}`);
          output = null;
        }
      }
      
      return {
        newLines,
        executionTime,
        ...(output !== undefined && { output })
      };
    } catch (error: unknown) {
      throw new Error(`Failed to execute command: ${(error as Error).message}`);
    }
  }

  /**
   * Wait for iTerm2 processing to complete
   * @param windowId The iTerm2 window ID
   * @param tabIndex Optional tab index to target
   */
  private async waitForProcessingComplete(windowId: string, tabIndex?: number): Promise<void> {
    while (await this.isProcessing(windowId, tabIndex)) {
      await sleep(100);
    }
  }

  /**
   * Wait for user input to be ready (command completion)
   * @param windowId The iTerm2 window ID
   * @param ttyPath TTY path for the session
   */
  private async waitForUserInputReady(windowId: string, ttyPath: string): Promise<void> {
    while (await this.isWaitingForUserInput(ttyPath) === false) {
      await sleep(100);
    }
  }

  async isWaitingForUserInput(ttyPath: string): Promise<boolean> {
    let fd;
    try {
      // Open the TTY file descriptor in non-blocking mode
      fd = openSync(ttyPath, 'r');
      const tracker = new ProcessTracker();
      let belowThresholdTime = 0;
      
      while (true) {
        try {
          const activeProcess = await tracker.getActiveProcess(ttyPath);
          
          if (!activeProcess) return true;

          if (activeProcess.metrics.totalCPUPercent < 1) {
            belowThresholdTime += 350;
            if (belowThresholdTime >= 1000) return true;
          } else {
            belowThresholdTime = 0;
          }

        } catch {
          return true;
        }

        await sleep(350);
      }
    } catch (error: unknown) {
      return true;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
      return true;
    }
  }

  /**
   * Escapes a string for use in an AppleScript command.
   * 
   * This method handles two scenarios:
   * 1. For multiline text (containing newlines), it uses a special AppleScript
   *    string concatenation approach to properly handle line breaks
   * 2. For single-line text, it escapes special characters for AppleScript compatibility
   * 
   * @param str The string to escape
   * @returns A properly escaped string ready for AppleScript execution
   */
  private escapeForAppleScript(str: string): string {
    // Check if the string contains newlines
    if (str.includes('\n')) {
      // For multiline text, we need to use a different AppleScript approach
      // that properly handles newlines in AppleScript
      return this.prepareMultilineCommand(str);
    }
    
    // First, escape any backslashes
    str = str.replace(/\\/g, '\\\\');
    
    // Escape double quotes
    str = str.replace(/"/g, '\\"');
    
    // Handle single quotes by breaking out of the quote, escaping the quote, and going back in
    str = str.replace(/'/g, "'\\''");
    
    // Handle special characters (except newlines which are handled separately)
    str = str.replace(/[^\x20-\x7E]/g, (char) => {
      return '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
    });
    
    return str;
  }
  
  /**
   * Prepares a multiline string for use in AppleScript.
   * 
   * This method handles multiline text by splitting it into separate lines
   * and creating an AppleScript expression that concatenates these lines
   * with explicit 'return' statements between them. This approach avoids
   * syntax errors that occur when trying to directly include newlines in
   * AppleScript strings.
   * 
   * @param str The multiline string to prepare
   * @returns An AppleScript-compatible string expression that preserves line breaks
   */
  private prepareMultilineCommand(str: string): string {
    // Split the input by newlines and prepare each line separately
    const lines = str.split('\n');
    
    // Create an AppleScript string that concatenates all lines with proper line breaks
    let applescriptString = '"' + this.escapeAppleScriptString(lines[0]) + '"';
    
    for (let i = 1; i < lines.length; i++) {
      // For each subsequent line, use AppleScript's string concatenation with line feed
      // The 'return' keyword in AppleScript adds a newline character
      applescriptString += ' & return & "' + this.escapeAppleScriptString(lines[i]) + '"'; 
    }
    
    return applescriptString;
  }
  
  /**
   * Escapes a single line of text for use in an AppleScript string.
   * 
   * Handles special characters that would otherwise cause syntax errors
   * in AppleScript strings:
   * - Backslashes are doubled to avoid escape sequence interpretation
   * - Double quotes are escaped to avoid prematurely terminating the string
   * - Tabs are replaced with their escape sequence
   * 
   * @param str The string to escape (should not contain newlines)
   * @returns The escaped string
   */
  private escapeAppleScriptString(str: string): string {
    // Escape quotes and backslashes for AppleScript string
    return str
      .replace(/\\/g, '\\\\')  // Double backslashes
      .replace(/"/g, '\\"')    // Escape double quotes
      .replace(/\t/g, '\\t');  // Handle tabs
  }

  private async retrieveTtyPath(windowId: string, tabIndex?: number): Promise<string> {
    try {
      const sessionTarget = tabIndex !== undefined 
        ? `tell tab ${tabIndex + 1} to tell current session`
        : `tell current session`;
      
      const { stdout } = await this._execPromise(`/usr/bin/osascript -e 'tell application "iTerm2" to tell window id "${windowId}" to ${sessionTarget} to get tty'`);
      return stdout.trim();
    } catch (error: unknown) {
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('Invalid key form') || errorMessage.includes('doesn\'t understand')) {
        throw new Error(`Invalid window ID ${windowId}: window may have been closed or doesn't exist`);
      } else if (errorMessage.includes('iTerm2 got an error')) {
        throw new Error(`iTerm2 AppleScript error: ${errorMessage}`);
      }
      throw new Error(`Failed to retrieve TTY path: ${errorMessage}`);
    }
  }

  private async isProcessing(windowId: string, tabIndex?: number): Promise<boolean> {
    try {
      const sessionTarget = tabIndex !== undefined 
        ? `tell tab ${tabIndex + 1} to tell current session`
        : `tell current session`;
      
      const { stdout } = await this._execPromise(`/usr/bin/osascript -e 'tell application "iTerm2" to tell window id "${windowId}" to ${sessionTarget} to get is processing'`);
      return stdout.trim() === 'true';
    } catch (error: unknown) {
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('Invalid key form') || errorMessage.includes('doesn\'t understand')) {
        throw new Error(`Invalid window ID ${windowId}: window may have been closed or doesn't exist`);
      } else if (errorMessage.includes('iTerm2 got an error')) {
        throw new Error(`iTerm2 AppleScript error: ${errorMessage}`);
      }
      throw new Error(`Failed to check processing status: ${errorMessage}`);
    }
  }
}

export default CommandExecutor;