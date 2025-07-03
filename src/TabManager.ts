import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execPromise = promisify(exec);

export interface TabInfo {
  index: number;
  name: string;
  sessionId: string;
  tty: string;
  alias?: string;
}

/**
 * Manages iTerm2 tabs within windows using AppleScript.
 * Provides methods to create, select, list, and manage tabs.
 */
export default class TabManager {
  private _execPromise: typeof execPromise;
  private tabAliases = new Map<string, Map<number, string>>();

  constructor(execPromiseOverride?: typeof execPromise) {
    this._execPromise = execPromiseOverride || execPromise;
  }

  /**
   * Creates a new tab in the specified window.
   * @param windowId The iTerm2 window ID
   * @param profileName Optional profile name (uses default if not specified)
   * @param tabName Optional name for the new tab
   * @returns The index of the newly created tab
   */
  async createTab(windowId: string, profileName?: string, tabName?: string): Promise<number> {
    const profileClause = profileName ? `with profile "${profileName}"` : 'with default profile';
    
    const ascript = `
      tell application "iTerm2"
        tell window id "${windowId}"
          create tab ${profileClause}
          set tabIndex to (count of tabs) - 1
          ${tabName ? `tell tab (tabIndex + 1) to tell current session to set name to "${tabName}"` : ''}
          return tabIndex
        end tell
      end tell
    `;

    try {
      const { stdout } = await this._execPromise(`osascript -e '${ascript}'`);
      const tabIndex = parseInt(stdout.trim(), 10);
      if (isNaN(tabIndex)) {
        throw new Error('Failed to get new tab index from iTerm2');
      }
      return tabIndex;
    } catch (error: unknown) {
      throw new Error(`Failed to create tab: ${(error as Error).message}`);
    }
  }

  /**
   * Selects (focuses) a specific tab in the window.
   * @param windowId The iTerm2 window ID
   * @param tabIndex The index of the tab to select (0-based)
   */
  async selectTab(windowId: string, tabIndex: number): Promise<void> {
    const ascript = `tell application "iTerm2" to tell window id "${windowId}" to tell tab ${tabIndex + 1} to select`;

    try {
      await this._execPromise(`osascript -e '${ascript}'`);
    } catch (error: unknown) {
      throw new Error(`Failed to select tab ${tabIndex}: ${(error as Error).message}`);
    }
  }

  /**
   * Lists all tabs in the specified window with their information.
   * @param windowId The iTerm2 window ID
   * @returns Array of tab information objects
   */
  async listTabs(windowId: string): Promise<TabInfo[]> {
    const ascript = `
      tell application "iTerm2"
        tell window id "${windowId}"
          set tabList to {}
          repeat with i from 1 to count of tabs
            tell tab i
              tell current session
                set tabName to name
                set sessionId to id
                set ttyPath to tty
                set end of tabList to ((i - 1) as string) & "|" & tabName & "|" & sessionId & "|" & ttyPath
              end tell
            end tell
          end repeat
          return tabList as string
        end tell
      end tell
    `;

    try {
      const { stdout } = await this._execPromise(`osascript -e '${ascript}'`);
      const tabData = stdout.trim();
      
      if (!tabData) {
        return [];
      }

      // Parse the returned data
      const tabStrings = tabData.split(', ');
      const tabs: TabInfo[] = [];

      for (const tabString of tabStrings) {
        const [indexStr, name, sessionId, tty] = tabString.split('|');
        const tabIndex = parseInt(indexStr, 10);
        const alias = this.getTabAlias(windowId, tabIndex);
        tabs.push({
          index: tabIndex,
          name: name || `Tab ${tabIndex + 1}`,
          sessionId,
          tty,
          alias
        });
      }

      return tabs;
    } catch (error: unknown) {
      throw new Error(`Failed to list tabs: ${(error as Error).message}`);
    }
  }

  /**
   * Finds a tab by name and returns its index.
   * @param windowId The iTerm2 window ID
   * @param tabName The name of the tab to find
   * @returns The tab index if found, null otherwise
   */
  async getTabIndex(windowId: string, tabName: string): Promise<number | null> {
    const tabs = await this.listTabs(windowId);
    const tab = tabs.find(t => t.name === tabName);
    return tab ? tab.index : null;
  }

  /**
   * Closes a specific tab in the window.
   * @param windowId The iTerm2 window ID
   * @param tabIndex The index of the tab to close (0-based)
   */
  async closeTab(windowId: string, tabIndex: number): Promise<void> {
    const ascript = `tell application "iTerm2" to tell window id "${windowId}" to tell tab ${tabIndex + 1} to close`;

    try {
      await this._execPromise(`osascript -e '${ascript}'`);
    } catch (error: unknown) {
      throw new Error(`Failed to close tab ${tabIndex}: ${(error as Error).message}`);
    }
  }

  /**
   * Gets the TTY path for a specific tab.
   * @param windowId The iTerm2 window ID
   * @param tabIndex The index of the tab (0-based)  
   * @returns The TTY path for the tab's current session
   */
  async getTabTty(windowId: string, tabIndex: number): Promise<string> {
    const ascript = `tell application "iTerm2" to tell window id "${windowId}" to tell tab ${tabIndex + 1} to tell current session to get tty`;

    try {
      const { stdout } = await this._execPromise(`osascript -e '${ascript}'`);
      return stdout.trim();
    } catch (error: unknown) {
      throw new Error(`Failed to get TTY for tab ${tabIndex}: ${(error as Error).message}`);
    }
  }

  /**
   * Resolves a tab identifier (name, alias, or index) to a numeric index.
   * @param windowId The iTerm2 window ID
   * @param tabIdentifier Tab name (string), alias (string), or index (number)
   * @returns The numeric tab index
   */
  async resolveTabIndex(windowId: string, tabIdentifier: string | number): Promise<number> {
    if (typeof tabIdentifier === 'number') {
      return tabIdentifier;
    }

    // Try to parse as number first
    const numericIndex = parseInt(tabIdentifier, 10);
    if (!isNaN(numericIndex)) {
      return numericIndex;
    }

    // Look up by alias first
    const aliasBased = this.getTabIndexByAlias(windowId, tabIdentifier);
    if (aliasBased !== null) {
      return aliasBased;
    }

    // Look up by name
    const tabIndex = await this.getTabIndex(windowId, tabIdentifier);
    if (tabIndex === null) {
      throw new Error(`Tab not found: ${tabIdentifier}`);
    }

    return tabIndex;
  }

  /**
   * Ensures a tab exists by name, creating it if necessary.
   * @param windowId The iTerm2 window ID
   * @param tabName The name of the tab
   * @param profileName Optional profile name for new tab
   * @returns The index of the existing or newly created tab
   */
  async ensureTab(windowId: string, tabName: string, profileName?: string): Promise<number> {
    const existingIndex = await this.getTabIndex(windowId, tabName);
    
    if (existingIndex !== null) {
      return existingIndex;
    }

    return await this.createTab(windowId, profileName, tabName);
  }

  /**
   * Sets an alias for a specific tab.
   * @param windowId The iTerm2 window ID
   * @param tabIndex The index of the tab (0-based)
   * @param alias The alias to set for the tab
   */
  setTabAlias(windowId: string, tabIndex: number, alias: string): void {
    if (!this.tabAliases.has(windowId)) {
      this.tabAliases.set(windowId, new Map());
    }
    this.tabAliases.get(windowId)!.set(tabIndex, alias);
  }

  /**
   * Gets the alias for a specific tab.
   * @param windowId The iTerm2 window ID
   * @param tabIndex The index of the tab (0-based)
   * @returns The tab alias if set, undefined otherwise
   */
  getTabAlias(windowId: string, tabIndex: number): string | undefined {
    return this.tabAliases.get(windowId)?.get(tabIndex);
  }

  /**
   * Removes an alias for a specific tab.
   * @param windowId The iTerm2 window ID
   * @param tabIndex The index of the tab (0-based)
   */
  removeTabAlias(windowId: string, tabIndex: number): void {
    this.tabAliases.get(windowId)?.delete(tabIndex);
  }

  /**
   * Finds a tab by alias and returns its index.
   * @param windowId The iTerm2 window ID
   * @param alias The alias to search for
   * @returns The tab index if found, null otherwise
   */
  getTabIndexByAlias(windowId: string, alias: string): number | null {
    const windowAliases = this.tabAliases.get(windowId);
    if (!windowAliases) return null;

    for (const [tabIndex, tabAlias] of windowAliases.entries()) {
      if (tabAlias === alias) {
        return tabIndex;
      }
    }
    return null;
  }

  /**
   * Clears all aliases for a window.
   * @param windowId The iTerm2 window ID  
   */
  clearWindowAliases(windowId: string): void {
    this.tabAliases.delete(windowId);
  }
}