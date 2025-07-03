// @ts-nocheck
const mockExecPromiseFn = jest.fn();

jest.mock('node:util', () => ({
  promisify: jest.fn().mockReturnValue(mockExecPromiseFn)
}));
jest.mock('node:child_process', () => ({
  exec: jest.fn()
}));

import { jest, describe, expect, test, beforeEach } from '@jest/globals';

describe('SessionManager', () => {
  let SessionManager;
  let sessionManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Set up default mock behavior
    mockExecPromiseFn.mockImplementation((command) => {
      if (command.includes('create window')) {
        return Promise.resolve({ stdout: '12345\n', stderr: '' });
      } else if (command.includes('get exists')) {
        return Promise.resolve({ stdout: 'true\n', stderr: '' });
      } else if (command.includes('current window to get id')) {
        return Promise.resolve({ stdout: '99999\n', stderr: '' });
      } else if (command.includes('close')) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    
    // Dynamically import after mocks
    SessionManager = (await import('../../src/SessionManager.js')).default;
    sessionManager = new SessionManager(mockExecPromiseFn);
  });

  describe('Session Creation and Management', () => {
    test('should create new session and return window ID', async () => {
      const mockWindowId = '12345';
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: `${mockWindowId}\n`, stderr: '' });

      const windowId = await sessionManager.createSession('client1');

      expect(windowId).toBe(mockWindowId);
      expect(sessionManager.hasSession('client1')).toBe(true);
      expect(sessionManager.getWindowId('client1')).toBe(mockWindowId);
    });

    test('should handle session creation failure', async () => {
      mockExecPromiseFn.mockRejectedValue(new Error('iTerm2 not running'));

      await expect(sessionManager.createSession('client1')).rejects.toThrow('Failed to create iTerm2 window');
    });

    test('should end session and clean up', async () => {
      const mockWindowId = '12345';
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: `${mockWindowId}\n`, stderr: '' }) // create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // close

      await sessionManager.createSession('client1');
      await sessionManager.endSession('client1');

      expect(sessionManager.hasSession('client1')).toBe(false);
      expect(sessionManager.getWindowId('client1')).toBeUndefined();
    });

    test('should handle ending non-existent session gracefully', async () => {
      await expect(sessionManager.endSession('nonexistent')).resolves.not.toThrow();
    });

    test('should track multiple active clients', async () => {
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: '12345\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '67890\n', stderr: '' });

      await sessionManager.createSession('client1');
      await sessionManager.createSession('client2');

      const activeClients = sessionManager.getActiveClients();
      expect(activeClients).toContain('client1');
      expect(activeClients).toContain('client2');
      expect(activeClients).toHaveLength(2);
    });
  });

  describe('Window Validation', () => {
    test('should validate existing window', async () => {
      mockExecPromiseFn.mockResolvedValue({ stdout: 'true\n', stderr: '' });

      const isValid = await sessionManager.validateWindow('12345');

      expect(isValid).toBe(true);
      expect(mockExecPromiseFn).toHaveBeenCalledWith(
        expect.stringContaining('tell window id "12345" to get exists')
      );
    });

    test('should detect invalid window', async () => {
      mockExecPromiseFn.mockResolvedValue({ stdout: 'false\n', stderr: '' });

      const isValid = await sessionManager.validateWindow('invalid');

      expect(isValid).toBe(false);
    });

    test('should handle validation errors gracefully', async () => {
      mockExecPromiseFn.mockRejectedValue(new Error('Invalid key form'));

      const isValid = await sessionManager.validateWindow('invalid');

      expect(isValid).toBe(false);
    });
  });

  describe('Active Window Retrieval', () => {
    test('should get active window ID', async () => {
      const mockWindowId = '54321';
      mockExecPromiseFn.mockResolvedValue({ stdout: `${mockWindowId}\n`, stderr: '' });

      const activeWindowId = await sessionManager.getActiveWindowId();

      expect(activeWindowId).toBe(mockWindowId);
      expect(mockExecPromiseFn).toHaveBeenCalledWith(
        expect.stringContaining('tell current window to get id as string')
      );
    });

    test('should return null when no active window', async () => {
      mockExecPromiseFn.mockRejectedValue(new Error('No windows available'));

      const activeWindowId = await sessionManager.getActiveWindowId();

      expect(activeWindowId).toBeNull();
    });

    test('should handle empty response gracefully', async () => {
      mockExecPromiseFn.mockResolvedValue({ stdout: '\n', stderr: '' });

      const activeWindowId = await sessionManager.getActiveWindowId();

      expect(activeWindowId).toBeNull();
    });
  });

  describe('Session Refresh and Recovery', () => {
    test('should return existing valid window', async () => {
      const mockWindowId = '12345';
      // Create session then validate
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: `${mockWindowId}\n`, stderr: '' }) // create
        .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' }); // validate

      await sessionManager.createSession('client1');
      const refreshedWindowId = await sessionManager.refreshSession('client1');

      expect(refreshedWindowId).toBe(mockWindowId);
    }, 10000);

    test('should create new session when existing window is invalid', async () => {
      const oldWindowId = '12345';
      const newWindowId = '67890';

      // Create, validate fail, create new
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: `${oldWindowId}\n`, stderr: '' }) // create initial
        .mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // validation fails
        .mockResolvedValueOnce({ stdout: `${newWindowId}\n`, stderr: '' }); // create new

      await sessionManager.createSession('client1');
      const refreshedWindowId = await sessionManager.refreshSession('client1');

      expect(refreshedWindowId).toBe(newWindowId);
    }, 10000);

    test('should create session for new client', async () => {
      const mockWindowId = '12345';
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: `${mockWindowId}\n`, stderr: '' });

      const windowId = await sessionManager.refreshSession('newclient');

      expect(windowId).toBe(mockWindowId);
      expect(sessionManager.hasSession('newclient')).toBe(true);
    }, 10000);
  });

  describe('Error Handling Edge Cases', () => {
    test('should handle empty window ID from iTerm2', async () => {
      mockExecPromiseFn.mockResolvedValue({ stdout: '\n', stderr: '' });

      await expect(sessionManager.createSession('client1')).rejects.toThrow('Failed to get new window ID');
    });

    test('should clean up session map even if window close fails', async () => {
      const mockWindowId = '12345';
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: `${mockWindowId}\n`, stderr: '' }) // create
        .mockRejectedValueOnce(new Error('Window already closed')); // close fails

      await sessionManager.createSession('client1');
      await sessionManager.endSession('client1');

      // Should still clean up the session map
      expect(sessionManager.hasSession('client1')).toBe(false);
    });
  });
});