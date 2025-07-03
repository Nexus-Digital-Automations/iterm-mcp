import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import TabManager from './TabManager.js';

const execPromise = promisify(exec);

export interface SessionTabInfo {
  windowId: string;
  tabIndex: number;
  tabName?: string;
}

/**
 * Manages iTerm2 windows as isolated sessions for each client.
 * Each client gets their own dedicated iTerm2 window to prevent conflicts
 * and enable true parallel operation. Now supports multi-tab management.
 */
export default class SessionManager {
  // Maps a client's unique ID to their iTerm2 window ID.
  private sessionWindowMap = new Map<string, string>();
  // Maps a client's unique ID to their working directory path.
  private sessionPathMap = new Map<string, string>();
  // Maps a client's unique ID to their tab information.
  private sessionTabMap = new Map<string, SessionTabInfo>();
  private _execPromise: typeof execPromise;
  private tabManager: TabManager;

  constructor(execPromiseOverride?: typeof execPromise) {
    this._execPromise = execPromiseOverride || execPromise;
    this.tabManager = new TabManager(execPromiseOverride);
  }

  /**
   * Generates a consistent client ID from a directory path.
   * @param path The directory path to generate an ID for.
   * @returns A unique client ID for the path.
   */
  public getClientIdFromPath(path: string): string {
    const normalizedPath = resolve(path);
    const hash = createHash('md5').update(normalizedPath).digest('hex').substring(0, 8);
    return `path_${hash}`;
  }

  /**
   * Creates a new iTerm2 window for a client session.
   * @param clientId The unique ID for the client.
   * @param workingDir Optional working directory path to associate with the session (for tracking only).
   * @returns The iTerm2 window ID for the newly created session.
   */
  public async createSession(clientId: string, workingDir?: string): Promise<string> {
    const ascript = `
      tell application "iTerm2"
        create window with default profile
        tell the current window
          return id as string
        end tell
      end tell
    `;

    try {
      const { stdout } = await this._execPromise(`osascript -e '${ascript}'`);
      const windowId = stdout.trim();
      if (!windowId) {
        throw new Error('Failed to get new window ID from iTerm2.');
      }
      
      this.sessionWindowMap.set(clientId, windowId);
      
      // If working directory is specified, store the association for tracking
      if (workingDir) {
        const normalizedPath = resolve(workingDir);
        this.sessionPathMap.set(clientId, normalizedPath);
        console.log(`Created session for client ${clientId} in window ${windowId} associated with path ${normalizedPath}`);
      } else {
        console.log(`Created session for client ${clientId} in window ${windowId}`);
      }
      
      return windowId;
    } catch (error: unknown) {
      throw new Error(`Failed to create iTerm2 window: ${(error as Error).message}`);
    }
  }

  /**
   * Closes the iTerm2 window associated with a client session.
   * @param clientId The unique ID for the client.
   */
  public async endSession(clientId: string): Promise<void> {
    const windowId = this.sessionWindowMap.get(clientId);
    if (!windowId) {
      console.log(`No session found for client ${clientId}.`);
      return;
    }

    const ascript = `tell application "iTerm2" to tell window id "${windowId}" to close`;

    try {
      await this._execPromise(`osascript -e '${ascript}'`);
      this.sessionWindowMap.delete(clientId);
      this.sessionPathMap.delete(clientId);
      this.sessionTabMap.delete(clientId);
      console.log(`Ended session for client ${clientId}, closed window ${windowId}`);
    } catch (error: unknown) {
      // It's possible the user closed the window manually.
      // We can ignore the error and still clean up the session maps.
      console.error(`Could not close window for client ${clientId}: ${(error as Error).message}`);
      this.sessionWindowMap.delete(clientId);
      this.sessionPathMap.delete(clientId);
      this.sessionTabMap.delete(clientId);
    }
  }

  /**
   * Retrieves the window ID for a given client.
   * @param clientId The unique ID for the client.
   * @returns The iTerm2 window ID or undefined if no session exists.
   */
  public getWindowId(clientId: string): string | undefined {
    return this.sessionWindowMap.get(clientId);
  }

  /**
   * Gets all active client sessions.
   * @returns Array of client IDs with active sessions.
   */
  public getActiveClients(): string[] {
    return Array.from(this.sessionWindowMap.keys());
  }

  /**
   * Checks if a client has an active session.
   * @param clientId The unique ID for the client.
   * @returns True if the client has an active session.
   */
  public hasSession(clientId: string): boolean {
    return this.sessionWindowMap.has(clientId);
  }

  /**
   * Validates that a window ID still exists and is accessible in iTerm2.
   * @param windowId The iTerm2 window ID to validate.
   * @returns True if the window exists and is accessible.
   */
  public async validateWindow(windowId: string): Promise<boolean> {
    const ascript = `tell application "iTerm2" to tell window id "${windowId}" to get exists`;
    
    try {
      const { stdout } = await this._execPromise(`osascript -e '${ascript}'`);
      return stdout.trim() === 'true';
    } catch (error: unknown) {
      // If we get an error, the window likely doesn't exist
      return false;
    }
  }

  /**
   * Gets the ID of the active (frontmost) iTerm2 window.
   * @returns The window ID of the active window, or null if no windows exist.
   */
  public async getActiveWindowId(): Promise<string | null> {
    const ascript = `tell application "iTerm2" to tell current window to get id as string`;
    
    try {
      const { stdout } = await this._execPromise(`osascript -e '${ascript}'`);
      const windowId = stdout.trim();
      return windowId || null;
    } catch (error: unknown) {
      // No active window available
      return null;
    }
  }

  /**
   * Finds an existing session by working directory path.
   * @param path The directory path to search for.
   * @returns The client ID if found, null otherwise.
   */
  public findSessionByPath(path: string): string | null {
    const normalizedPath = resolve(path);
    
    for (const [clientId, sessionPath] of this.sessionPathMap.entries()) {
      if (sessionPath === normalizedPath) {
        return clientId;
      }
    }
    
    return null;
  }

  /**
   * Gets the working directory path for a session.
   * @param clientId The unique ID for the client.
   * @returns The working directory path or undefined if not set.
   */
  public getSessionPath(clientId: string): string | undefined {
    return this.sessionPathMap.get(clientId);
  }

  /**
   * Focuses or creates a session for a specific directory path.
   * @param path The directory path for the session.
   * @returns The window ID of the focused or created session.
   */
  public async focusOrCreateSessionForPath(path: string): Promise<string> {
    const normalizedPath = resolve(path);
    
    // First, check if we already have a session for this path
    const existingClientId = this.findSessionByPath(normalizedPath);
    
    if (existingClientId) {
      const existingWindowId = this.sessionWindowMap.get(existingClientId);
      
      if (existingWindowId) {
        // Validate the window still exists
        const isValid = await this.validateWindow(existingWindowId);
        
        if (isValid) {
          console.log(`Found existing session for path ${normalizedPath}, focusing window ${existingWindowId}`);
          return existingWindowId;
        } else {
          // Window is stale, clean it up
          this.sessionWindowMap.delete(existingClientId);
          this.sessionPathMap.delete(existingClientId);
          console.log(`Existing session for path ${normalizedPath} is stale, will create new session`);
        }
      }
    }
    
    // No valid existing session, create a new one
    const clientId = this.getClientIdFromPath(normalizedPath);
    console.log(`Creating new session for path ${normalizedPath} with client ID ${clientId}`);
    return await this.createSession(clientId, normalizedPath);
  }

  /**
   * Ends a session by its working directory path.
   * @param path The directory path of the session to end.
   * @returns Object with success status and descriptive message.
   */
  public async endSessionByPath(path: string): Promise<{success: boolean, message: string}> {
    const normalizedPath = resolve(path);
    
    // Find the session by path
    const clientId = this.findSessionByPath(normalizedPath);
    
    if (!clientId) {
      return {
        success: false,
        message: `No active session found for path: ${normalizedPath}`
      };
    }
    
    // Get window ID for logging purposes
    const windowId = this.sessionWindowMap.get(clientId);
    
    try {
      await this.endSession(clientId);
      return {
        success: true,
        message: `Successfully closed session for path: ${normalizedPath}${windowId ? ` (window ${windowId})` : ''}`
      };
    } catch (error: unknown) {
      return {
        success: false,
        message: `Failed to close session for path ${normalizedPath}: ${(error as Error).message}`
      };
    }
  }

  /**
   * Refreshes a client's session by validating their window and creating a new one if needed.
   * @param clientId The unique ID for the client.
   * @returns The window ID (existing if valid, or new if created).
   */
  public async refreshSession(clientId: string): Promise<string> {
    const existingWindowId = this.sessionWindowMap.get(clientId);
    const existingWorkingDir = this.sessionPathMap.get(clientId);
    
    if (existingWindowId) {
      // Check if the existing window is still valid
      const isValid = await this.validateWindow(existingWindowId);
      if (isValid) {
        return existingWindowId;
      }
      
      // Window is stale, remove it from our maps
      this.sessionWindowMap.delete(clientId);
      this.sessionPathMap.delete(clientId);
      this.sessionTabMap.delete(clientId);
      console.log(`Window ${existingWindowId} for client ${clientId} is no longer valid, creating new session`);
    }
    
    // Create a new session, preserving working directory association if it was set
    return await this.createSession(clientId, existingWorkingDir);
  }

  /**
   * Gets the tab information for a client session.
   * @param clientId The unique ID for the client.
   * @returns The tab information or undefined if not set.
   */
  public getSessionTabInfo(clientId: string): SessionTabInfo | undefined {
    return this.sessionTabMap.get(clientId);
  }

  /**
   * Sets the tab information for a client session.
   * @param clientId The unique ID for the client.
   * @param tabInfo The tab information to set.
   */
  public setSessionTabInfo(clientId: string, tabInfo: SessionTabInfo): void {
    this.sessionTabMap.set(clientId, tabInfo);
  }

  /**
   * Focuses or creates a tab for a specific session.
   * @param clientId The unique ID for the client.
   * @param tabIdentifier Optional tab name or index. If not provided, uses default tab (0).
   * @returns The tab index of the focused or created tab.
   */
  public async focusOrCreateTab(clientId: string, tabIdentifier?: string | number): Promise<number> {
    const windowId = this.getWindowId(clientId);
    if (!windowId) {
      throw new Error(`No session found for client ${clientId}`);
    }

    // If no tab specified, default to tab 0 (backwards compatibility)
    if (tabIdentifier === undefined) {
      const currentTabInfo = this.sessionTabMap.get(clientId);
      if (currentTabInfo) {
        await this.tabManager.selectTab(windowId, currentTabInfo.tabIndex);
        return currentTabInfo.tabIndex;
      }
      
      // Default to first tab
      await this.tabManager.selectTab(windowId, 0);
      this.sessionTabMap.set(clientId, { windowId, tabIndex: 0 });
      return 0;
    }

    let tabIndex: number;
    let tabName: string | undefined;

    if (typeof tabIdentifier === 'string') {
      // Check if it's a numeric string
      const numericIndex = parseInt(tabIdentifier, 10);
      if (!isNaN(numericIndex)) {
        tabIndex = numericIndex;
      } else {
        // It's a tab name - ensure it exists
        tabName = tabIdentifier;
        tabIndex = await this.tabManager.ensureTab(windowId, tabName);
      }
    } else {
      tabIndex = tabIdentifier;
    }

    // Focus the tab
    await this.tabManager.selectTab(windowId, tabIndex);
    
    // Update session tab tracking
    this.sessionTabMap.set(clientId, { windowId, tabIndex, tabName });
    
    return tabIndex;
  }

  /**
   * Lists all tabs for a client's session window.
   * @param clientId The unique ID for the client.
   * @returns Array of tab information.
   */
  public async listSessionTabs(clientId: string) {
    const windowId = this.getWindowId(clientId);
    if (!windowId) {
      throw new Error(`No session found for client ${clientId}`);
    }

    return await this.tabManager.listTabs(windowId);
  }

  /**
   * Closes a specific tab in a client's session.
   * @param clientId The unique ID for the client.
   * @param tabIdentifier Tab name or index to close.
   */
  public async closeSessionTab(clientId: string, tabIdentifier: string | number): Promise<void> {
    const windowId = this.getWindowId(clientId);
    if (!windowId) {
      throw new Error(`No session found for client ${clientId}`);
    }

    const tabIndex = await this.tabManager.resolveTabIndex(windowId, tabIdentifier);
    await this.tabManager.closeTab(windowId, tabIndex);
    
    // Update session tab tracking if this was the tracked tab
    const currentTabInfo = this.sessionTabMap.get(clientId);
    if (currentTabInfo && currentTabInfo.tabIndex === tabIndex) {
      // Reset to tab 0 or remove if no tabs left
      try {
        const tabs = await this.tabManager.listTabs(windowId);
        if (tabs.length > 0) {
          this.sessionTabMap.set(clientId, { windowId, tabIndex: 0 });
        } else {
          this.sessionTabMap.delete(clientId);
        }
      } catch {
        this.sessionTabMap.delete(clientId);
      }
    }
  }

  /**
   * Gets the TTY path for a client's current tab.
   * @param clientId The unique ID for the client.
   * @returns The TTY path for the client's current tab.
   */
  public async getSessionTabTty(clientId: string): Promise<string> {
    const tabInfo = this.sessionTabMap.get(clientId);
    if (!tabInfo) {
      // Fall back to window's current session
      const windowId = this.getWindowId(clientId);
      if (!windowId) {
        throw new Error(`No session found for client ${clientId}`);
      }
      
      const ascript = `tell application "iTerm2" to tell window id "${windowId}" to tell current session to get tty`;
      const { stdout } = await this._execPromise(`osascript -e '${ascript}'`);
      return stdout.trim();
    }

    return await this.tabManager.getTabTty(tabInfo.windowId, tabInfo.tabIndex);
  }

  /**
   * Sets an alias for a tab in a client's session.
   * @param clientId The unique ID for the client.
   * @param tabIdentifier The tab to set alias for (name, index, or current alias)
   * @param alias The alias to set
   */
  async setTabAlias(clientId: string, tabIdentifier: string | number, alias: string): Promise<void> {
    const windowId = this.getWindowId(clientId);
    if (!windowId) {
      throw new Error(`No session found for client ${clientId}`);
    }

    const tabIndex = await this.tabManager.resolveTabIndex(windowId, tabIdentifier);
    this.tabManager.setTabAlias(windowId, tabIndex, alias);
  }

  /**
   * Closes specific tabs by identifiers or closes entire window if "all" specified.
   * @param clientId The unique ID for the client.
   * @param tabs Tab identifiers to close, or "all" to close entire window
   * @returns Object with success status and message
   */
  async closeTabs(clientId: string, tabs: string | string[]): Promise<{success: boolean, message: string}> {
    const windowId = this.getWindowId(clientId);
    if (!windowId) {
      return {
        success: false,
        message: `No session found for client ${clientId}`
      };
    }

    // Handle "all" case (case-insensitive)
    if (typeof tabs === 'string' && tabs.toLowerCase() === 'all') {
      try {
        await this.endSession(clientId);
        return {
          success: true,
          message: `Successfully closed entire window for client ${clientId}`
        };
      } catch (error: unknown) {
        return {
          success: false,
          message: `Failed to close window: ${(error as Error).message}`
        };
      }
    }

    // Handle individual tab closures
    const tabList = Array.isArray(tabs) ? tabs : [tabs];
    const closedTabs: string[] = [];
    const failedTabs: string[] = [];

    for (const tabIdentifier of tabList) {
      try {
        await this.closeSessionTab(clientId, tabIdentifier);
        closedTabs.push(tabIdentifier);
      } catch (error: unknown) {
        failedTabs.push(`${tabIdentifier}: ${(error as Error).message}`);
      }
    }

    const successMessage = closedTabs.length > 0 ? `Closed tabs: ${closedTabs.join(', ')}` : '';
    const failureMessage = failedTabs.length > 0 ? `Failed to close: ${failedTabs.join('; ')}` : '';
    
    const message = [successMessage, failureMessage].filter(Boolean).join('. ');
    
    return {
      success: closedTabs.length > 0,
      message: message || 'No tabs were processed'
    };
  }

  /**
   * Closes tabs by session path.
   * @param path The directory path of the session.
   * @param tabs Tab identifiers to close, or "all" to close entire window
   * @returns Object with success status and message
   */
  async closeTabsByPath(path: string, tabs: string | string[]): Promise<{success: boolean, message: string}> {
    const normalizedPath = resolve(path);
    const clientId = this.findSessionByPath(normalizedPath);
    
    if (!clientId) {
      return {
        success: false,
        message: `No active session found for path: ${normalizedPath}`
      };
    }

    return await this.closeTabs(clientId, tabs);
  }
}