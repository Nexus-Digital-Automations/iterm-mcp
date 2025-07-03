import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execPromise = promisify(exec);

/**
 * Represents a single key input with optional modifiers and timing
 */
interface KeyInput {
  type: 'key' | 'text';
  key?: string;
  text?: string;
  modifiers?: string[];
  delay?: number;
}

/**
 * Parsed key information
 */
interface ParsedKey {
  keyCode?: number;
  asciiCode?: number;
  modifiers: string[];
  useKeyCode: boolean;
}

/**
 * Universal keystroke sender for iTerm2 that can send any combination of keys,
 * modifiers, and sequences. Supports complete interaction with Claude Code and
 * any terminal application.
 */
class KeySender {
  // Comprehensive key code mapping for AppleScript
  private static readonly KEY_CODES: Record<string, number> = {
    // Arrow Keys
    'up': 126, 'down': 125, 'left': 123, 'right': 124,
    
    // Function Keys
    'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96,
    'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109,
    'f11': 103, 'f12': 111, 'f13': 105, 'f14': 107, 'f15': 113,
    'f16': 106, 'f17': 64, 'f18': 79, 'f19': 80, 'f20': 90,
    
    // Navigation Keys
    'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
    'tab': 48, 'enter': 36, 'return': 36, 'space': 49,
    'backspace': 51, 'delete': 117, 'escape': 53, 'esc': 53,
    
    // Number Keys (top row)
    '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
    '6': 22, '7': 26, '8': 28, '9': 25,
    
    // Letter Keys
    'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3,
    'g': 5, 'h': 4, 'i': 34, 'j': 38, 'k': 40, 'l': 37,
    'm': 46, 'n': 45, 'o': 35, 'p': 31, 'q': 12, 'r': 15,
    's': 1, 't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7,
    'y': 16, 'z': 6,
    
    // Special Characters
    'semicolon': 41, 'quote': 39, 'comma': 43, 'period': 47,
    'slash': 44, 'backslash': 42, 'minus': 27, 'equal': 24,
    'leftbracket': 33, 'rightbracket': 30, 'grave': 50,
    
    // Keypad
    'keypad0': 82, 'keypad1': 83, 'keypad2': 84, 'keypad3': 85,
    'keypad4': 86, 'keypad5': 87, 'keypad6': 88, 'keypad7': 89,
    'keypad8': 91, 'keypad9': 92, 'keypadclear': 71, 'keypadequals': 81,
    'keypaddivide': 75, 'keypadmultiply': 67, 'keypadminus': 78,
    'keypadplus': 69, 'keypadenter': 76, 'keypaddecimal': 65
  };

  // Control character mappings (for backward compatibility)
  private static readonly CONTROL_CHARS: Record<string, number> = {
    'a': 1, 'b': 2, 'c': 3, 'd': 4, 'e': 5, 'f': 6, 'g': 7,
    'h': 8, 'i': 9, 'j': 10, 'k': 11, 'l': 12, 'm': 13, 'n': 14,
    'o': 15, 'p': 16, 'q': 17, 'r': 18, 's': 19, 't': 20,
    'u': 21, 'v': 22, 'w': 23, 'x': 24, 'y': 25, 'z': 26,
    'esc': 27, 'escape': 27, ']': 29
  };

  // Modifier mappings
  private static readonly MODIFIERS: Record<string, string> = {
    'cmd': 'command down',
    'command': 'command down',
    'ctrl': 'control down',
    'control': 'control down',
    'opt': 'option down',
    'option': 'option down',
    'shift': 'shift down',
    'alt': 'option down' // alias for option
  };

  // Claude Code specific patterns
  private static readonly CLAUDE_CODE_PATTERNS: Record<string, string[] | KeyInput[]> = {
    // Mode switching
    'enter_plan_mode': ['shift+tab', 'shift+tab'],
    'cycle_mode': ['shift+tab'],
    'exit_mode': ['shift+tab'],
    
    // Commands (using KeyInput format for text)
    'clear_conversation': [
      { type: 'text', text: '/clear' },
      { type: 'key', key: 'enter' }
    ],
    'compact_context': [
      { type: 'text', text: '/compact' },
      { type: 'key', key: 'enter' }
    ],
    'switch_model': [
      { type: 'text', text: '/model' },
      { type: 'key', key: 'enter' }
    ],
    'help': [
      { type: 'text', text: '/help' },
      { type: 'key', key: 'enter' }
    ],
    'init_project': [
      { type: 'text', text: '/init' },
      { type: 'key', key: 'enter' }
    ],
    
    // Navigation
    'interrupt': ['escape'],
    'hard_interrupt': ['escape', 'escape'],
    'exit_session': ['ctrl+d'],
    
    // Multi-line input (after /terminal-setup)
    'new_line': ['shift+enter'],
    'universal_new_line': ['backslash', 'enter'],
    
    // Quick shortcuts
    'paste_image': ['ctrl+v'], // Note: Ctrl+V not Cmd+V for Claude Code
    'autocomplete': ['tab']
  };

  protected async executeCommand(command: string, windowId: string): Promise<void> {
    await execPromise(command);
  }

  /**
   * Send a single keystroke or key combination to the specified iTerm2 window
   * @param windowId The iTerm2 window ID
   * @param keyInput Key to send (e.g., 'up', 'f1', 'cmd+c', 'shift+tab')
   */
  async sendKey(windowId: string, keyInput: string): Promise<void> {
    const parsed = this.parseKeyInput(keyInput);
    
    if (parsed.useKeyCode && parsed.keyCode !== undefined) {
      await this.sendKeyCode(windowId, parsed.keyCode, parsed.modifiers);
    } else if (parsed.asciiCode !== undefined) {
      await this.sendAsciiCharacter(windowId, parsed.asciiCode);
    } else {
      throw new Error(`Invalid key input: ${keyInput}`);
    }
  }

  /**
   * Send a sequence of keystrokes with optional timing
   * @param windowId The iTerm2 window ID
   * @param sequence Array of keys or KeyInput objects
   */
  async sendKeySequence(windowId: string, sequence: (string | KeyInput)[]): Promise<void> {
    for (const input of sequence) {
      if (typeof input === 'string') {
        await this.sendKey(windowId, input);
      } else {
        if (input.type === 'key' && input.key) {
          await this.sendKey(windowId, input.key);
        } else if (input.type === 'text' && input.text) {
          await this.typeText(windowId, input.text);
        }
        
        if (input.delay) {
          await this.sleep(input.delay);
        }
      }
    }
  }

  /**
   * Type literal text (not keystrokes)
   * @param windowId The iTerm2 window ID
   * @param text Text to type
   */
  async typeText(windowId: string, text: string): Promise<void> {
    const escapedText = this.escapeForAppleScript(text);
    // Use single-line AppleScript with numeric window ID for reliability
    const ascript = `tell application "iTerm2" to tell window id ${windowId} to tell current session to type text "${escapedText}"`;

    try {
      await this.executeCommand(`osascript -e '${ascript}'`, windowId);
    } catch (error: unknown) {
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('Invalid key form') || errorMessage.includes('doesn\'t understand')) {
        throw new Error(`Invalid window ID ${windowId}: window may have been closed or doesn't exist`);
      } else if (errorMessage.includes('iTerm2 got an error')) {
        throw new Error(`iTerm2 AppleScript error while typing text: ${errorMessage}`);
      }
      throw new Error(`Failed to type text: ${errorMessage}`);
    }
  }

  /**
   * Execute a predefined Claude Code pattern
   * @param windowId The iTerm2 window ID
   * @param patternName Name of the pattern to execute
   */
  async executeClaudeCodePattern(windowId: string, patternName: string): Promise<void> {
    const pattern = KeySender.CLAUDE_CODE_PATTERNS[patternName];
    if (!pattern) {
      throw new Error(`Unknown Claude Code pattern: ${patternName}`);
    }

    await this.sendKeySequence(windowId, pattern);
  }

  /**
   * Include a file using Claude Code @filename syntax
   * @param windowId The iTerm2 window ID
   * @param filename File path to include
   */
  async includeFile(windowId: string, filename: string): Promise<void> {
    await this.typeText(windowId, `@${filename}`);
    await this.sendKey(windowId, 'enter');
  }

  /**
   * Include a directory using Claude Code @directory/ syntax
   * @param windowId The iTerm2 window ID
   * @param dirname Directory path to include
   */
  async includeDirectory(windowId: string, dirname: string): Promise<void> {
    await this.typeText(windowId, `@${dirname}/`);
    await this.sendKey(windowId, 'enter');
  }

  /**
   * Add content to memory using Claude Code # syntax
   * @param windowId The iTerm2 window ID
   * @param content Content to add to memory
   */
  async addToMemory(windowId: string, content: string): Promise<void> {
    await this.typeText(windowId, `#${content}`);
    await this.sendKey(windowId, 'enter');
  }

  /**
   * Parse key input string into structured format
   * @param input Key input string (e.g., 'cmd+c', 'f1', 'ctrl+shift+z')
   */
  private parseKeyInput(input: string): ParsedKey {
    const parts = input.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const modifierParts = parts.slice(0, -1);

    // Validate and convert modifiers
    const modifiers: string[] = [];
    for (const modifier of modifierParts) {
      if (KeySender.MODIFIERS[modifier]) {
        modifiers.push(KeySender.MODIFIERS[modifier]);
      } else {
        throw new Error(`Invalid modifier: ${modifier}`);
      }
    }

    // Check if it's a control character (for backward compatibility)
    if (modifierParts.includes('ctrl') && modifierParts.length === 1 && KeySender.CONTROL_CHARS[key]) {
      return {
        asciiCode: KeySender.CONTROL_CHARS[key],
        modifiers: [],
        useKeyCode: false
      };
    }

    // Check if it's a regular key code
    if (KeySender.KEY_CODES[key] !== undefined) {
      return {
        keyCode: KeySender.KEY_CODES[key],
        modifiers,
        useKeyCode: true
      };
    }

    // Check if it's a control character without ctrl prefix
    if (KeySender.CONTROL_CHARS[key] && modifiers.length === 0) {
      return {
        asciiCode: KeySender.CONTROL_CHARS[key],
        modifiers: [],
        useKeyCode: false
      };
    }

    throw new Error(`Unknown key: ${key}`);
  }

  /**
   * Send a key using AppleScript key code method
   * @param windowId The iTerm2 window ID
   * @param keyCode The key code to send
   * @param modifiers Array of modifier strings
   */
  private async sendKeyCode(windowId: string, keyCode: number, modifiers: string[]): Promise<void> {
    // For basic keys without modifiers, use ASCII character method which works reliably
    if (modifiers.length === 0) {
      // Map common key codes to ASCII characters
      const asciiMap: Record<number, number> = {
        36: 13, // enter/return -> ASCII 13 (CR)
        48: 9,  // tab -> ASCII 9
        53: 27, // escape -> ASCII 27
        51: 8,  // backspace -> ASCII 8
        49: 32, // space -> ASCII 32
      };
      
      if (asciiMap[keyCode]) {
        await this.sendAsciiCharacter(windowId, asciiMap[keyCode]);
        return;
      }
    }
    
    // For other keys or keys with modifiers, we need a different approach
    // Note: iTerm2's AppleScript doesn't support key code directly
    // For now, throw an error for unsupported combinations
    throw new Error(`Key code ${keyCode} with modifiers ${modifiers.join(', ')} is not supported by iTerm2's AppleScript interface`);
  }

  /**
   * Send a control character using ASCII code method
   * @param windowId The iTerm2 window ID
   * @param asciiCode The ASCII code to send
   */
  private async sendAsciiCharacter(windowId: string, asciiCode: number): Promise<void> {
    // Use single-line AppleScript with numeric window ID for reliability
    const ascript = `tell application "iTerm2" to tell window id ${windowId} to tell current session to write text (ASCII character ${asciiCode})`;

    try {
      await this.executeCommand(`osascript -e '${ascript}'`, windowId);
    } catch (error: unknown) {
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('Invalid key form') || errorMessage.includes('doesn\'t understand')) {
        throw new Error(`Invalid window ID ${windowId}: window may have been closed or doesn't exist`);
      } else if (errorMessage.includes('iTerm2 got an error')) {
        throw new Error(`iTerm2 AppleScript error while sending ASCII character ${asciiCode}: ${errorMessage}`);
      }
      throw new Error(`Failed to send ASCII character: ${errorMessage}`);
    }
  }

  /**
   * Escape text for AppleScript string literals
   * @param text Text to escape
   */
  private escapeForAppleScript(text: string): string {
    return text
      .replace(/\\/g, '\\\\')  // Escape backslashes
      .replace(/"/g, '\\"')    // Escape double quotes
      .replace(/\t/g, '\\t')   // Handle tabs
      .replace(/\r/g, '\\r')   // Handle carriage returns
      .replace(/\n/g, '\\n');  // Handle newlines
  }

  /**
   * Sleep for specified milliseconds
   * @param ms Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get list of available Claude Code patterns
   */
  static getAvailablePatterns(): string[] {
    return Object.keys(KeySender.CLAUDE_CODE_PATTERNS);
  }

  /**
   * Get list of supported keys
   */
  static getSupportedKeys(): string[] {
    return Object.keys(KeySender.KEY_CODES);
  }

  /**
   * Get list of supported modifiers
   */
  static getSupportedModifiers(): string[] {
    return Object.keys(KeySender.MODIFIERS);
  }
}

export default KeySender;