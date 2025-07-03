#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import CommandExecutor from "./CommandExecutor.js";
import TtyOutputReader from "./TtyOutputReader.js";
import SessionManager from "./SessionManager.js";
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const execPromise = promisify(exec);

// Instantiate the session manager
const sessionManager = new SessionManager();

const server = new Server(
  {
    name: "iterm-mcp",
    version: "0.2.0", // Bump version for multi-session architecture
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "write_to_terminal",
        description: "Writes text to the active iTerm terminal and automatically presses enter to execute commands, with configurable timeout for command completion",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command to run or text to write to the terminal"
            },
            timeout: {
              type: "number",
              description: "Maximum time to wait for command completion in seconds (default: 30, max: 120)",
              minimum: 1,
              maximum: 120
            },
            return_output_lines: {
              type: "number",
              description: "Number of output lines to automatically return after command execution (default: 0, disabled)",
              minimum: 0
            },
            tab: {
              type: ["string", "number"],
              description: "Optional: Target specific tab by name (string) or index (number). If not provided, uses the current tab."
            },
            tab_alias: {
              type: "string",
              description: "Optional: Set an alias for the current/specified tab that can be used as an identifier"
            }
          },
          required: ["command"]
        }
      },
      {
        name: "read_terminal_output",
        description: "Reads the output from the active iTerm terminal with optional search and filtering capabilities",
        inputSchema: {
          type: "object",
          properties: {
            linesOfOutput: {
              type: "integer",
              description: "The number of lines of output to read."
            },
            search_term: {
              type: "string",
              description: "Optional: Filter output to lines containing this keyword/phrase"
            },
            regex_pattern: {
              type: "string", 
              description: "Optional: Filter output using regex pattern (takes precedence over search_term)"
            },
            case_sensitive: {
              type: "boolean",
              description: "Optional: Whether search should be case sensitive (default: false)"
            },
            include_line_numbers: {
              type: "boolean",
              description: "Optional: Include line numbers in the output (default: false)"
            },
            tab: {
              type: ["string", "number"],
              description: "Optional: Target specific tab by name (string) or index (number). If not provided, uses the current tab."
            }
          },
          required: ["linesOfOutput"]
        }
      },
      {
        name: "focus_terminal_window",
        description: "Brings the iTerm terminal window to focus and optionally manages tabs. Can focus or create sessions for specific project directories and tabs.",
        inputSchema: {
          type: "object",
          properties: {
            session_root_path: {
              type: "string",
              description: "Optional: The root directory path for the project session. If provided, will focus or create a terminal session in this directory."
            },
            tab: {
              type: ["string", "number"],
              description: "Optional: Target specific tab by name (string) or index (number). If tab name doesn't exist, creates a new tab with that name."
            }
          },
          required: []
        }
      },
      {
        name: "close_tabs",
        description: "Closes specific tabs by aliases/IDs or closes entire window. Pass 'all' (case-insensitive) to close the entire window.",
        inputSchema: {
          type: "object",
          properties: {
            session_root_path: {
              type: "string",
              description: "The root directory path of the project session to identify which window"
            },
            tabs: {
              type: ["string", "array"],
              items: {
                type: "string"
              },
              description: "Tab identifier(s) to close (alias, name, or index), or 'all' to close entire window"
            }
          },
          required: ["session_root_path", "tabs"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // For focus_terminal_window with session_root_path, we handle session management differently
  if (request.params.name === "focus_terminal_window") {
    const sessionRootPath = request.params.arguments?.session_root_path as string;
    const tabIdentifier = request.params.arguments?.tab as string | number;
    
    let windowId: string;
    let clientId: string;
    
    if (sessionRootPath) {
      // Path-based session management
      try {
        windowId = await sessionManager.focusOrCreateSessionForPath(sessionRootPath);
        clientId = sessionManager.getClientIdFromPath(sessionRootPath);
      } catch (error: unknown) {
        throw new Error(`Failed to focus or create session for path ${sessionRootPath}: ${(error as Error).message}`);
      }
    } else {
      // Default session behavior (backward compatibility)
      clientId = "default";
      try {
        windowId = await sessionManager.refreshSession(clientId);
      } catch (error: unknown) {
        // If session creation fails, try falling back to active window
        const activeWindowId = await sessionManager.getActiveWindowId();
        if (activeWindowId) {
          windowId = activeWindowId;
          console.log(`Using active window ${activeWindowId} as fallback for client ${clientId}`);
        } else {
          throw new Error(`Failed to create or find valid iTerm2 window: ${(error as Error).message}`);
        }
      }
    }
    
    let responseText = '';
    
    // Handle tab management if specified
    if (tabIdentifier !== undefined) {
      try {
        const tabIndex = await sessionManager.focusOrCreateTab(clientId, tabIdentifier);
        const tabInfo = typeof tabIdentifier === 'string' ? `"${tabIdentifier}"` : `index ${tabIdentifier}`;
        responseText = `Focused iTerm window ${windowId}, tab ${tabInfo} (index ${tabIndex})`;
      } catch (error: unknown) {
        return {
          content: [{
            type: "text",
            text: `Failed to focus or create tab: ${(error as Error).message}`
          }]
        };
      }
    } else {
      // Just list available tabs when no specific tab requested
      try {
        const tabs = await sessionManager.listSessionTabs(clientId);
        const tabList = tabs.map(tab => {
          const aliasInfo = tab.alias ? ` (alias: ${tab.alias})` : '';
          return `${tab.index}: ${tab.name}${aliasInfo}`;
        }).join(', ');
        responseText = `Focused iTerm window ${windowId}. Available tabs: [${tabList}]`;
      } catch (error: unknown) {
        responseText = `Focused iTerm window ${windowId}`;
      }
    }
    
    // Focus the window
    const ascript = `tell application "iTerm2" to tell window id ${windowId} to select`;
    try {
      await execPromise(`osascript -e '${ascript}'`);
      const pathInfo = sessionRootPath ? ` for path ${sessionRootPath}` : '';
      return {
        content: [{
          type: "text", 
          text: responseText + pathInfo
        }]
      };
    } catch (error: unknown) {
      return {
        content: [{
          type: "text",
          text: `Failed to focus window: ${(error as Error).message}`
        }]
      };
    }
  }
  
  // For all other tools, use the default session management
  const defaultClientId = "default";
  
  // Ensure we have a valid session for the default client (with window validation and fallback)
  let windowId: string;
  try {
    windowId = await sessionManager.refreshSession(defaultClientId);
  } catch (error: unknown) {
    // If session creation fails, try falling back to active window
    const activeWindowId = await sessionManager.getActiveWindowId();
    if (activeWindowId) {
      windowId = activeWindowId;
      console.log(`Using active window ${activeWindowId} as fallback for client ${defaultClientId}`);
    } else {
      throw new Error(`Failed to create or find valid iTerm2 window: ${(error as Error).message}`);
    }
  }

  switch (request.params.name) {
    case "write_to_terminal": {
      let executor = new CommandExecutor();
      const command = String(request.params.arguments?.command);
      const timeout = Math.min(Math.max(Number(request.params.arguments?.timeout) || 30, 1), 120);
      const returnOutputLines = Math.max(Number(request.params.arguments?.return_output_lines) || 0, 0);
      const tabIdentifier = request.params.arguments?.tab as string | number;
      const tabAlias = request.params.arguments?.tab_alias as string;
      
      let tabIndex: number | undefined;
      
      // Handle tab targeting
      if (tabIdentifier !== undefined) {
        try {
          tabIndex = await sessionManager.focusOrCreateTab(defaultClientId, tabIdentifier);
        } catch (error: unknown) {
          return {
            content: [{
              type: "text",
              text: `Failed to focus or create tab: ${(error as Error).message}`
            }]
          };
        }
      }
      
      try {
        const result = await executor.executeCommand(windowId, command, timeout, returnOutputLines, tabIndex);
        
        let responseText = `Command completed within ${timeout}s timeout. ${result.newLines} lines were output after sending the command to the terminal.`;
        
        if (tabIdentifier !== undefined) {
          const tabInfo = typeof tabIdentifier === 'string' ? `"${tabIdentifier}"` : `index ${tabIdentifier}`;
          responseText += ` (executed in tab ${tabInfo})`;
        }
        
        if (result.output !== undefined) {
          if (result.output === null) {
            responseText += " Output capture was requested but failed.";
          } else {
            responseText += `\n\nCaptured output (last ${returnOutputLines} lines):\n${result.output}`;
          }
        } else {
          responseText += " Read the last lines of terminal contents to orient yourself.";
        }
        
        responseText += " Never assume that the command was executed or that it was successful.";

        // Set tab alias if provided
        if (tabAlias) {
          try {
            const currentTabIndex = tabIndex !== undefined ? tabIndex : 0;
            await sessionManager.setTabAlias(defaultClientId, currentTabIndex, tabAlias);
            responseText += ` Tab alias "${tabAlias}" set for current tab.`;
          } catch (error: unknown) {
            responseText += ` Warning: Failed to set tab alias "${tabAlias}": ${(error as Error).message}`;
          }
        }

        return {
          content: [{
            type: "text",
            text: responseText
          }]
        };
      } catch (error: unknown) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes('timed out')) {
          return {
            content: [{
              type: "text",
              text: `Command timed out after ${timeout} seconds. The command may still be running in the background. Use read_terminal_output to check the current terminal state.`
            }]
          };
        }
        throw error;
      }
    }
    case "read_terminal_output": {
      const linesOfOutput = Number(request.params.arguments?.linesOfOutput) || 25;
      const searchTerm = request.params.arguments?.search_term as string;
      const regexPattern = request.params.arguments?.regex_pattern as string;
      const caseSensitive = Boolean(request.params.arguments?.case_sensitive);
      const includeLineNumbers = Boolean(request.params.arguments?.include_line_numbers);
      const tabIdentifier = request.params.arguments?.tab as string | number;
      
      let tabIndex: number | undefined;
      
      // Handle tab targeting
      if (tabIdentifier !== undefined) {
        try {
          tabIndex = await sessionManager.focusOrCreateTab(defaultClientId, tabIdentifier);
        } catch (error: unknown) {
          return {
            content: [{
              type: "text",
              text: `Failed to focus or create tab: ${(error as Error).message}`
            }]
          };
        }
      }
      
      let output = await TtyOutputReader.call(windowId, linesOfOutput, tabIndex);
      
      // Apply search filtering if requested
      if (regexPattern || searchTerm) {
        const lines = output.split('\n');
        let filteredLines: string[];
        
        if (regexPattern) {
          try {
            const regex = new RegExp(regexPattern, caseSensitive ? 'g' : 'gi');
            filteredLines = lines.filter(line => regex.test(line));
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error in regex pattern: ${(error as Error).message}`
              }]
            };
          }
        } else if (searchTerm) {
          const term = caseSensitive ? searchTerm : searchTerm.toLowerCase();
          filteredLines = lines.filter(line => {
            const lineToCheck = caseSensitive ? line : line.toLowerCase();
            return lineToCheck.includes(term);
          });
        } else {
          filteredLines = lines;
        }
        
        // Add line numbers if requested
        if (includeLineNumbers) {
          filteredLines = filteredLines.map((line, index) => `${index + 1}: ${line}`);
        }
        
        output = filteredLines.join('\n');
        
        // Add search summary
        const searchInfo = regexPattern ? `regex: ${regexPattern}` : `term: "${searchTerm}"`;
        const tabInfo = tabIdentifier !== undefined ? ` in tab ${typeof tabIdentifier === 'string' ? `"${tabIdentifier}"` : `index ${tabIdentifier}`}` : '';
        const summary = `\n\n[Found ${filteredLines.length} matching lines for ${searchInfo}${tabInfo}]`;
        output += summary;
      } else if (includeLineNumbers) {
        // Just add line numbers without search
        const lines = output.split('\n');
        const numberedLines = lines.map((line, index) => `${index + 1}: ${line}`);
        output = numberedLines.join('\n');
      }

      // Add tab info to output if specific tab was targeted
      if (tabIdentifier !== undefined && !output.includes('[Found')) {
        const tabInfo = typeof tabIdentifier === 'string' ? `"${tabIdentifier}"` : `index ${tabIdentifier}`;
        output += `\n\n[Reading from tab ${tabInfo}]`;
      }

      return {
        content: [{
          type: "text",
          text: output
        }]
      };
    }
    case "close_tabs": {
      const sessionRootPath = request.params.arguments?.session_root_path as string;
      const tabs = request.params.arguments?.tabs as string | string[];
      
      if (!sessionRootPath) {
        return {
          content: [{
            type: "text",
            text: "Error: session_root_path parameter is required for close_tabs"
          }]
        };
      }

      if (!tabs) {
        return {
          content: [{
            type: "text",
            text: "Error: tabs parameter is required for close_tabs"
          }]
        };
      }
      
      // Validate and normalize the path
      let normalizedPath: string;
      try {
        normalizedPath = resolve(sessionRootPath);
      } catch (error: unknown) {
        return {
          content: [{
            type: "text",
            text: `Error: Invalid path format: ${sessionRootPath}`
          }]
        };
      }
      
      // Check if path exists (optional - we can still close sessions for deleted directories)
      if (!existsSync(normalizedPath)) {
        console.warn(`Warning: Path ${normalizedPath} does not exist, but proceeding to close tabs if session exists`);
      }
      
      try {
        const result = await sessionManager.closeTabsByPath(normalizedPath, tabs);
        
        return {
          content: [{
            type: "text",
            text: result.message
          }]
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: "text",
            text: `Error closing tabs: ${(error as Error).message}`
          }]
        };
      }
    }
    default:
      throw new Error("Unknown tool");
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Cleanup sessions on exit
process.on('SIGINT', async () => {
  console.log('Shutting down and cleaning up sessions...');
  for (const clientId of sessionManager.getActiveClients()) {
    await sessionManager.endSession(clientId);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down and cleaning up sessions...');
  for (const clientId of sessionManager.getActiveClients()) {
    await sessionManager.endSession(clientId);
  }
  process.exit(0);
});

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
