import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execPromise = promisify(exec);

export default class TtyOutputReader {
  static async call(windowId: string, linesOfOutput?: number, tabIndex?: number) {
    const buffer = await this.retrieveBuffer(windowId, linesOfOutput, tabIndex);
    if (!linesOfOutput) {
      return buffer;
    }
    const lines = buffer.split('\n');
    return lines.slice(-linesOfOutput - 1).join('\n');
  }

  static async retrieveBuffer(windowId: string, linesOfOutput?: number, tabIndex?: number): Promise<string> {
    const sessionTarget = tabIndex !== undefined 
      ? `tell tab ${tabIndex + 1} to tell current session`
      : `tell current session`;
    
    const ascript = `tell application "iTerm2" to tell window id "${windowId}" to ${sessionTarget} to get contents`;
    
    const { stdout: finalContent } = await execPromise(`osascript -e '${ascript}'`);
    return finalContent.trim();
  }
}