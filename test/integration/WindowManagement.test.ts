// @ts-nocheck
const mockExecPromiseFn = jest.fn();

jest.mock('node:util', () => ({
  promisify: jest.fn().mockReturnValue(mockExecPromiseFn)
}));
jest.mock('node:child_process', () => ({
  exec: jest.fn()
}));
jest.mock('node:fs', () => ({
  openSync: jest.fn().mockReturnValue(1),
  closeSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true)
}));

import { jest, describe, expect, test, beforeEach } from '@jest/globals';

describe('Window Management Integration', () => {
  let SessionManager;
  let CommandExecutor;
  let KeySender;
  let sessionManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Import classes
    SessionManager = (await import('../../src/SessionManager.js')).default;
    CommandExecutor = (await import('../../src/CommandExecutor.js')).default;
    KeySender = (await import('../../src/KeySender.js')).default;
    
    sessionManager = new SessionManager();
  });

  describe('Error Handling with Invalid Windows', () => {
    test('CommandExecutor should handle invalid window ID gracefully', async () => {
      // Setup mock to simulate "Invalid key form" error
      mockExecPromiseFn.mockRejectedValue(new Error('execution error of osascript: iTerm got an error: Invalid key form. (-10002)'));
      
      const executor = new CommandExecutor(mockExecPromiseFn);
      
      await expect(
        executor.executeCommand('invalid-window-123', 'echo test')
      ).rejects.toThrow('Invalid window ID invalid-window-123: window may have been closed or doesn\'t exist');
    });

    test('KeySender should handle invalid window ID gracefully', async () => {
      // Setup mock to simulate window reference error
      mockExecPromiseFn.mockRejectedValue(new Error('iTerm2 got an error: Can\'t get window id "invalid-window". Invalid key form. (-10002)'));
      
      const keySender = new KeySender();
      // Override executeCommand to use our mock
      keySender.executeCommand = jest.fn().mockRejectedValue(new Error('iTerm2 got an error: Can\'t get window id "invalid-window". Invalid key form. (-10002)'));
      
      await expect(
        keySender.sendKey('invalid-window', 'down')
      ).rejects.toThrow('Invalid window ID invalid-window: window may have been closed or doesn\'t exist');
    });

    test('should recover from stale window using session refresh', async () => {
      const staleWindowId = '12345';
      const newWindowId = '67890';
      
      // Create initial session
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: `${staleWindowId}\n`, stderr: '' });
      await sessionManager.createSession('client1');
      
      // Window validation fails (stale), then create new session
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // validation fails
        .mockResolvedValueOnce({ stdout: `${newWindowId}\n`, stderr: '' }); // new session
      
      const refreshedWindowId = await sessionManager.refreshSession('client1');
      
      expect(refreshedWindowId).toBe(newWindowId);
      expect(refreshedWindowId).not.toBe(staleWindowId);
    });
  });

  describe('Fallback Mechanisms', () => {
    test('should use active window when session creation fails', async () => {
      const activeWindowId = '99999';
      
      // Session creation fails, then get active window
      mockExecPromiseFn
        .mockRejectedValueOnce(new Error('Failed to create window')) // session creation fails
        .mockResolvedValueOnce({ stdout: `${activeWindowId}\n`, stderr: '' }); // get active window
      
      // This simulates the fallback logic from index.ts
      let windowId;
      try {
        windowId = await sessionManager.refreshSession('client1');
      } catch (error) {
        windowId = await sessionManager.getActiveWindowId();
      }
      
      expect(windowId).toBe(activeWindowId);
    });

    test('should handle complete iTerm2 unavailability', async () => {
      // All operations fail
      mockExecPromiseFn.mockRejectedValue(new Error('iTerm2 not running'));
      
      await expect(sessionManager.createSession('client1')).rejects.toThrow('Failed to create iTerm2 window');
      
      const activeWindowId = await sessionManager.getActiveWindowId();
      expect(activeWindowId).toBeNull();
      
      const isValid = await sessionManager.validateWindow('any-window');
      expect(isValid).toBe(false);
    });
  });

  describe('Window Lifecycle Management', () => {
    test('should properly manage window lifecycle', async () => {
      const windowId = '12345';
      
      // Create session
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: `${windowId}\n`, stderr: '' });
      const createdWindowId = await sessionManager.createSession('client1');
      expect(createdWindowId).toBe(windowId);
      
      // Validate window exists
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
      const isValid = await sessionManager.validateWindow(windowId);
      expect(isValid).toBe(true);
      
      // Close session
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await sessionManager.endSession('client1');
      expect(sessionManager.hasSession('client1')).toBe(false);
    });

    test('should handle rapid session operations', async () => {
      const windowIds = ['111', '222', '333'];
      
      // Create multiple sessions rapidly
      for (let i = 0; i < windowIds.length; i++) {
        mockExecPromiseFn.mockResolvedValueOnce({ stdout: `${windowIds[i]}\n`, stderr: '' });
      }
      
      const promises = [
        sessionManager.createSession('client1'),
        sessionManager.createSession('client2'),
        sessionManager.createSession('client3')
      ];
      
      const results = await Promise.all(promises);
      
      expect(results).toEqual(windowIds);
      expect(sessionManager.getActiveClients()).toHaveLength(3);
    });
  });

  describe('Error Recovery Scenarios', () => {
    test('should recover from temporary iTerm2 communication issues', async () => {
      const windowId = '12345';
      
      // First attempt fails, second succeeds
      mockExecPromiseFn
        .mockRejectedValueOnce(new Error('Temporary communication error'))
        .mockResolvedValueOnce({ stdout: `${windowId}\n`, stderr: '' });
      
      // This simulates retry logic that could be implemented
      let result;
      try {
        result = await sessionManager.createSession('client1');
      } catch (error) {
        // Retry once
        result = await sessionManager.createSession('client1');
      }
      
      expect(result).toBe(windowId);
    });

    test('should handle window validation during active operations', async () => {
      const oldWindowId = '111';
      const newWindowId = '222';
      
      // Create session
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: `${oldWindowId}\n`, stderr: '' });
      await sessionManager.createSession('client1');
      
      // Simulate window becoming invalid during operation
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // validation fails
        .mockResolvedValueOnce({ stdout: `${newWindowId}\n`, stderr: '' }); // create new
      
      const refreshedWindowId = await sessionManager.refreshSession('client1');
      expect(refreshedWindowId).toBe(newWindowId);
    });
  });

  describe('AppleScript Error Specificity', () => {
    test('should correctly identify different types of AppleScript errors', async () => {
      const testCases = [
        {
          error: 'iTerm got an error: Invalid key form. (-10002)',
          expectedPattern: 'Invalid window ID'
        },
        {
          error: 'iTerm2 got an error: Window doesn\'t understand the "get" message.',
          expectedPattern: 'Invalid window ID'
        },
        {
          error: 'iTerm2 got an error: Some other error occurred',
          expectedPattern: 'iTerm2 AppleScript error'
        },
        {
          error: 'Some unrelated error',
          expectedPattern: 'Failed to'
        }
      ];
      
      for (const testCase of testCases) {
        mockExecPromiseFn.mockRejectedValueOnce(new Error(testCase.error));
        
        const executor = new CommandExecutor(mockExecPromiseFn);
        
        try {
          await executor.executeCommand('test-window', 'echo test');
          fail('Expected error to be thrown');
        } catch (error) {
          expect(error.message).toContain(testCase.expectedPattern);
        }
      }
    });
  });
});