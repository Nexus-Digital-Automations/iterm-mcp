// @ts-nocheck
const mockExecPromiseFn = jest.fn();

jest.mock('node:util', () => ({
  promisify: jest.fn().mockReturnValue(mockExecPromiseFn)
}));
jest.mock('node:child_process', () => ({
  exec: jest.fn()
}));

import { jest, describe, expect, test, beforeEach } from '@jest/globals';

describe('SessionManager Path-Based Functionality', () => {
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

  describe('Path-to-ClientId Mapping', () => {
    test('should generate consistent client ID from path', () => {
      const path1 = '/Users/test/project';
      const path2 = '/Users/test/project/';
      const path3 = '/Users/test/project/../project';
      
      const clientId1 = sessionManager.getClientIdFromPath(path1);
      const clientId2 = sessionManager.getClientIdFromPath(path2);
      const clientId3 = sessionManager.getClientIdFromPath(path3);
      
      // All should resolve to same normalized path and same client ID
      expect(clientId1).toBe(clientId2);
      expect(clientId1).toBe(clientId3);
      expect(clientId1).toMatch(/^path_[a-f0-9]{8}$/);
    });

    test('should generate different client IDs for different paths', () => {
      const path1 = '/Users/test/project1';
      const path2 = '/Users/test/project2';
      
      const clientId1 = sessionManager.getClientIdFromPath(path1);
      const clientId2 = sessionManager.getClientIdFromPath(path2);
      
      expect(clientId1).not.toBe(clientId2);
    });
  });

  describe('Session Creation with Working Directory', () => {
    test('should create session with working directory', async () => {
      const clientId = 'test-client';
      const workingDir = '/Users/test/project';
      
      const windowId = await sessionManager.createSession(clientId, workingDir);
      
      expect(windowId).toBe('12345');
      expect(sessionManager.getSessionPath(clientId)).toBe(workingDir);
      
      // Verify no cd command was executed (cd functionality removed)
      expect(mockExecPromiseFn).not.toHaveBeenCalledWith(
        expect.stringContaining('write text "cd')
      );
    });

    test('should create session without working directory', async () => {
      const clientId = 'test-client';
      
      const windowId = await sessionManager.createSession(clientId);
      
      expect(windowId).toBe('12345');
      expect(sessionManager.getSessionPath(clientId)).toBeUndefined();
      
      // Verify no cd command was executed
      expect(mockExecPromiseFn).not.toHaveBeenCalledWith(
        expect.stringContaining('write text "cd')
      );
    });
  });

  describe('Session Lookup by Path', () => {
    test('should find existing session by path', async () => {
      const path = '/Users/test/project';
      const clientId = sessionManager.getClientIdFromPath(path);
      
      // Create session
      await sessionManager.createSession(clientId, path);
      
      // Find it by path
      const foundClientId = sessionManager.findSessionByPath(path);
      expect(foundClientId).toBe(clientId);
    });

    test('should return null for non-existent path', () => {
      const path = '/Users/test/nonexistent';
      const foundClientId = sessionManager.findSessionByPath(path);
      expect(foundClientId).toBeNull();
    });

    test('should normalize paths when searching', async () => {
      const basePath = '/Users/test/project';
      const pathVariations = [
        '/Users/test/project/',
        '/Users/test/project/../project',
        '/Users/test/project/.'
      ];
      
      const clientId = sessionManager.getClientIdFromPath(basePath);
      await sessionManager.createSession(clientId, basePath);
      
      // All variations should find the same session
      pathVariations.forEach(path => {
        const foundClientId = sessionManager.findSessionByPath(path);
        expect(foundClientId).toBe(clientId);
      });
    });
  });

  describe('Focus or Create Session for Path', () => {
    test('should create new session for path', async () => {
      const path = '/Users/test/newproject';
      
      const windowId = await sessionManager.focusOrCreateSessionForPath(path);
      
      expect(windowId).toBe('12345');
      const clientId = sessionManager.getClientIdFromPath(path);
      expect(sessionManager.getSessionPath(clientId)).toBe(path);
    });

    test('should reuse existing valid session for path', async () => {
      const path = '/Users/test/project';
      const clientId = sessionManager.getClientIdFromPath(path);
      
      // Create initial session
      const windowId1 = await sessionManager.createSession(clientId, path);
      
      // Mock validation to return true
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
      
      // Should reuse existing session
      const windowId2 = await sessionManager.focusOrCreateSessionForPath(path);
      
      expect(windowId2).toBe(windowId1);
    });

    test('should create new session if existing is stale', async () => {
      const path = '/Users/test/project';
      const clientId = sessionManager.getClientIdFromPath(path);
      
      // Create initial session
      await sessionManager.createSession(clientId, path);
      
      // Mock validation to return false (stale)
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // validation fails
        .mockResolvedValueOnce({ stdout: '67890\n', stderr: '' }); // new window creation
      
      // Should create new session
      const newWindowId = await sessionManager.focusOrCreateSessionForPath(path);
      
      expect(newWindowId).toBe('67890');
      expect(sessionManager.getSessionPath(clientId)).toBe(path);
    });
  });

  describe('Enhanced Session Management', () => {
    test('should clean up path mapping when ending session', async () => {
      const clientId = 'test-client';
      const path = '/Users/test/project';
      
      await sessionManager.createSession(clientId, path);
      expect(sessionManager.getSessionPath(clientId)).toBe(path);
      
      await sessionManager.endSession(clientId);
      expect(sessionManager.getSessionPath(clientId)).toBeUndefined();
    });

    test('should preserve working directory when refreshing session', async () => {
      const clientId = 'test-client';
      const path = '/Users/test/project';
      
      // Create session with path
      await sessionManager.createSession(clientId, path);
      
      // Mock validation to fail, then new session creation
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // validation fails
        .mockResolvedValueOnce({ stdout: '67890\n', stderr: '' }); // new window
      
      const newWindowId = await sessionManager.refreshSession(clientId);
      
      expect(newWindowId).toBe('67890');
      expect(sessionManager.getSessionPath(clientId)).toBe(path);
      
      // Verify no cd command was executed (cd functionality removed)
      expect(mockExecPromiseFn).not.toHaveBeenCalledWith(
        expect.stringContaining('write text "cd')
      );
    });

    test('should handle refresh session without working directory', async () => {
      const clientId = 'test-client';
      
      // Create session without path
      await sessionManager.createSession(clientId);
      
      // Mock validation to fail, then new session creation
      mockExecPromiseFn
        .mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // validation fails
        .mockResolvedValueOnce({ stdout: '67890\n', stderr: '' }); // new window
      
      const newWindowId = await sessionManager.refreshSession(clientId);
      
      expect(newWindowId).toBe('67890');
      expect(sessionManager.getSessionPath(clientId)).toBeUndefined();
    });
  });

  describe('End Session by Path', () => {
    test('should successfully end existing session by path', async () => {
      const path = '/Users/test/project';
      const clientId = sessionManager.getClientIdFromPath(path);
      
      // Create session first
      await sessionManager.createSession(clientId, path);
      expect(sessionManager.findSessionByPath(path)).toBe(clientId);
      
      // End session by path
      const result = await sessionManager.endSessionByPath(path);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully closed session for path');
      expect(result.message).toContain(path);
      expect(sessionManager.findSessionByPath(path)).toBeNull();
      expect(sessionManager.getSessionPath(clientId)).toBeUndefined();
    });

    test('should handle ending non-existent session gracefully', async () => {
      const path = '/Users/test/nonexistent';
      
      const result = await sessionManager.endSessionByPath(path);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('No active session found for path');
      expect(result.message).toContain(path);
    });

    test('should normalize paths when ending sessions', async () => {
      const basePath = '/Users/test/project';
      const pathVariations = [
        '/Users/test/project/',
        '/Users/test/project/../project',
        '/Users/test/project/.'
      ];
      
      const clientId = sessionManager.getClientIdFromPath(basePath);
      await sessionManager.createSession(clientId, basePath);
      
      // Any path variation should be able to end the session
      const result = await sessionManager.endSessionByPath(pathVariations[0]);
      
      expect(result.success).toBe(true);
      expect(sessionManager.findSessionByPath(basePath)).toBeNull();
    });

    test('should handle window close failure gracefully', async () => {
      const path = '/Users/test/project';
      const clientId = sessionManager.getClientIdFromPath(path);
      
      // Create session
      await sessionManager.createSession(clientId, path);
      
      // Mock window close failure
      mockExecPromiseFn.mockRejectedValueOnce(new Error('Window already closed'));
      
      const result = await sessionManager.endSessionByPath(path);
      
      expect(result.success).toBe(true); // Should still succeed due to error handling in endSession
      expect(sessionManager.findSessionByPath(path)).toBeNull(); // Should clean up maps
    });
  });

  describe('Session Lifecycle Integration', () => {
    test('should handle complete session lifecycle', async () => {
      const path = '/Users/test/lifecycle-project';
      
      // 1. Create session using focusOrCreateSessionForPath
      const windowId1 = await sessionManager.focusOrCreateSessionForPath(path);
      expect(windowId1).toBe('12345');
      
      const clientId = sessionManager.getClientIdFromPath(path);
      expect(sessionManager.findSessionByPath(path)).toBe(clientId);
      expect(sessionManager.getSessionPath(clientId)).toBe(path);
      
      // 2. End session by path
      const endResult = await sessionManager.endSessionByPath(path);
      expect(endResult.success).toBe(true);
      expect(sessionManager.findSessionByPath(path)).toBeNull();
      
      // 3. Create session again (should work normally)
      mockExecPromiseFn.mockResolvedValueOnce({ stdout: '67890\n', stderr: '' });
      
      const windowId2 = await sessionManager.focusOrCreateSessionForPath(path);
      expect(windowId2).toBe('67890');
      expect(sessionManager.findSessionByPath(path)).toBe(clientId);
    });

    test('should handle multiple concurrent sessions', async () => {
      const paths = [
        '/Users/test/project-a',
        '/Users/test/project-b', 
        '/Users/test/project-c'
      ];
      
      // Create all sessions
      const sessions = [];
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        mockExecPromiseFn
          .mockResolvedValueOnce({ stdout: `window_${i}\n`, stderr: '' });
        
        const windowId = await sessionManager.focusOrCreateSessionForPath(path);
        sessions.push({ path, windowId });
      }
      
      // Verify all sessions exist
      sessions.forEach(session => {
        expect(sessionManager.findSessionByPath(session.path)).toBeTruthy();
      });
      
      // End middle session
      const endResult = await sessionManager.endSessionByPath(paths[1]);
      expect(endResult.success).toBe(true);
      
      // Verify only middle session is gone
      expect(sessionManager.findSessionByPath(paths[0])).toBeTruthy();
      expect(sessionManager.findSessionByPath(paths[1])).toBeNull();
      expect(sessionManager.findSessionByPath(paths[2])).toBeTruthy();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle path with special characters', async () => {
      const path = '/Users/test/my project with spaces & symbols!';
      const clientId = sessionManager.getClientIdFromPath(path);
      
      const windowId = await sessionManager.createSession(clientId, path);
      
      expect(windowId).toBe('12345');
      expect(sessionManager.getSessionPath(clientId)).toBe(path);
      
      // Verify no cd command was executed (cd functionality removed)
      expect(mockExecPromiseFn).not.toHaveBeenCalledWith(
        expect.stringContaining('write text "cd')
      );
    });

    test('should handle focusOrCreateSessionForPath failure', async () => {
      const path = '/Users/test/project';
      mockExecPromiseFn.mockRejectedValue(new Error('iTerm2 not running'));
      
      await expect(sessionManager.focusOrCreateSessionForPath(path))
        .rejects.toThrow('Failed to create iTerm2 window');
    });

    test('should handle multiple sessions with different paths', async () => {
      const paths = [
        '/Users/test/project1',
        '/Users/test/project2',
        '/Users/test/project3'
      ];
      
      // Create sessions for each path
      const sessions = [];
      for (const path of paths) {
        const clientId = sessionManager.getClientIdFromPath(path);
        mockExecPromiseFn
          .mockResolvedValueOnce({ stdout: `${Math.random().toString(36).substr(2, 9)}\n`, stderr: '' }); // unique window ID
        
        const windowId = await sessionManager.createSession(clientId, path);
        sessions.push({ clientId, windowId, path });
      }
      
      // Verify all sessions exist independently
      sessions.forEach(session => {
        expect(sessionManager.getSessionPath(session.clientId)).toBe(session.path);
        expect(sessionManager.findSessionByPath(session.path)).toBe(session.clientId);
      });
    });
  });
});