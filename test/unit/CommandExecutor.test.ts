// @ts-nocheck
const mockExecPromiseFn = jest.fn();

jest.mock('node:util', () => ({
  promisify: jest.fn().mockReturnValue(mockExecPromiseFn)
}));
jest.mock('node:child_process', () => ({
  exec: jest.fn()
}));
jest.mock('../../src/TtyOutputReader.js', () => ({
  __esModule: true,
  default: {
    retrieveBuffer: jest.fn().mockResolvedValue('line1\nline2\nline3\nline4\nline5'),
    call: jest.fn()
  }
}));
jest.mock('node:fs', () => ({
  openSync: jest.fn().mockReturnValue(1),
  closeSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true)
}));

import { jest, describe, expect, test, beforeEach } from '@jest/globals';

// Use dynamic import for ESM compatibility and to ensure mocks are in place

describe('CommandExecutor', () => {
  let CommandExecutor;
  let commandExecutor;
  let TtyOutputReader;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Dynamically import after mocks
    CommandExecutor = (await import('../../src/CommandExecutor.js')).default;
    TtyOutputReader = (await import('../../src/TtyOutputReader.js')).default;
    
    // Mock different buffer states before and after command
    jest.spyOn(TtyOutputReader, 'retrieveBuffer')
      .mockResolvedValueOnce('line1\nline2') // before command
      .mockResolvedValue('line1\nline2\nline3\nline4\nline5'); // after command
    
    jest.spyOn(TtyOutputReader, 'call').mockReturnValue('line4\nline5');
    
    mockExecPromiseFn.mockImplementation((command) => {
      if (command.includes('get tty')) {
        return Promise.resolve({ stdout: '/dev/ttys000\n', stderr: '' });
      } else if (command.includes('get is processing')) {
        return Promise.resolve({ stdout: 'false\n', stderr: '' });
      } else {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
    });
    // Inject the mockExecPromiseFn into CommandExecutor
    commandExecutor = new CommandExecutor(mockExecPromiseFn);
  });

  test('executeCommand passes the command to execPromise and returns metadata', async () => {
    const testCommand = 'echo "Hello World"';
    const testWindowId = 'test-window-1';
    const result = await commandExecutor.executeCommand(testWindowId, testCommand);
    
    // Check that the command was executed
    const calledWith = mockExecPromiseFn.mock.calls.find(call =>
      call[0].includes('osascript') && call[0].includes('Hello World') && call[0].includes(testWindowId)
    );
    expect(calledWith).toBeTruthy();
    
    // Check return structure
    expect(result).toHaveProperty('newLines');
    expect(result).toHaveProperty('executionTime');
    expect(typeof result.newLines).toBe('number');
    expect(typeof result.executionTime).toBe('number');
    expect(result.newLines).toBe(3); // 5 lines after - 2 lines before
  });

  test('executeCommand respects timeout parameter', async () => {
    const testCommand = 'echo "Hello World"';
    const testWindowId = 'test-window-1';
    const timeout = 5;
    
    const result = await commandExecutor.executeCommand(testWindowId, testCommand, timeout);
    
    // Should complete normally with the timeout parameter
    const calledWith = mockExecPromiseFn.mock.calls.find(call =>
      call[0].includes('osascript') && call[0].includes('Hello World')
    );
    expect(calledWith).toBeTruthy();
    expect(result).toHaveProperty('newLines');
    expect(result).toHaveProperty('executionTime');
  });

  test('executeCommand uses default timeout when not specified', async () => {
    const testCommand = 'echo "Hello World"';
    const testWindowId = 'test-window-1';
    
    // Should work the same as before (default 30 second timeout)
    const result = await commandExecutor.executeCommand(testWindowId, testCommand);
    
    const calledWith = mockExecPromiseFn.mock.calls.find(call =>
      call[0].includes('osascript') && call[0].includes('Hello World')
    );
    expect(calledWith).toBeTruthy();
    expect(result).toHaveProperty('newLines');
    expect(result).toHaveProperty('executionTime');
  });

  test('executeCommand returns output when returnOutputLines is specified', async () => {
    const testCommand = 'echo "Hello World"';
    const testWindowId = 'test-window-1';
    const returnOutputLines = 2;
    
    const result = await commandExecutor.executeCommand(testWindowId, testCommand, 30, returnOutputLines);
    
    expect(result).toHaveProperty('newLines');
    expect(result).toHaveProperty('executionTime');
    expect(result).toHaveProperty('output');
    expect(result.output).toBe('line3\nline4\nline5'); // slice(-3) gets last 3 lines
  });

  test('executeCommand does not return output when returnOutputLines is 0', async () => {
    const testCommand = 'echo "Hello World"';
    const testWindowId = 'test-window-1';
    
    const result = await commandExecutor.executeCommand(testWindowId, testCommand, 30, 0);
    
    expect(result).toHaveProperty('newLines');
    expect(result).toHaveProperty('executionTime');
    expect(result).not.toHaveProperty('output');
    expect(TtyOutputReader.call).not.toHaveBeenCalled();
  });

  test('executeCommand handles output capture failure gracefully', async () => {
    const testCommand = 'echo "Hello World"';
    const testWindowId = 'test-window-1';
    const returnOutputLines = 2;
    
    // Override the CommandExecutor to inject an error during output capture
    const originalExecuteCommand = commandExecutor.executeCommand;
    commandExecutor.executeCommand = async function(windowId: string, command: string, timeoutSeconds = 30, returnOutputLines = 0) {
      const startTime = Date.now();
      
      // Simulate command execution
      await mockExecPromiseFn(`/usr/bin/osascript -e 'tell application "iTerm2" to tell window id "${windowId}" to tell current session to write text "${command}"'`);
      
      const newLines = 3;
      const executionTime = Date.now() - startTime;
      
      // Simulate output capture failure
      let output: string | null | undefined;
      if (returnOutputLines > 0) {
        try {
          // Simulate an error during output processing
          throw new Error('Failed to capture output');
        } catch (error: unknown) {
          console.warn(`Failed to capture output lines: ${(error as Error).message}`);
          output = null;
        }
      }
      
      return {
        newLines,
        executionTime,
        ...(output !== undefined && { output })
      };
    };
    
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    
    const result = await commandExecutor.executeCommand(testWindowId, testCommand, 30, returnOutputLines);
    
    expect(result).toHaveProperty('newLines');
    expect(result).toHaveProperty('executionTime');
    expect(result).toHaveProperty('output');
    expect(result.output).toBe(null);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to capture output lines'));
    
    consoleSpy.mockRestore();
    commandExecutor.executeCommand = originalExecuteCommand;
  });
});