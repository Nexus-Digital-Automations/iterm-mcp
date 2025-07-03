# Enhanced focus_terminal Tool Usage

The `focus_terminal` tool now supports path-based session management, allowing you to maintain separate terminal sessions for different projects.

## Basic Usage (Backward Compatible)

```json
{
  "tool": "focus_terminal"
}
```
This focuses the default terminal session, maintaining backward compatibility.

## Path-Based Session Management

```json
{
  "tool": "focus_terminal",
  "session_root_path": "/Users/myuser/projects/my-app"
}
```

### Features

1. **Automatic Session Creation**: If no session exists for the specified path, a new iTerm2 window is created and associated with that directory path.

2. **Session Reuse**: If a session already exists for the path, it validates the window and focuses it instead of creating a new one.

3. **Path Normalization**: Different path formats that resolve to the same directory will use the same session:
   - `/Users/myuser/projects/my-app`
   - `/Users/myuser/projects/my-app/`
   - `/Users/myuser/projects/my-app/../my-app`

4. **Stale Session Recovery**: If a window was manually closed, the system detects this and creates a new session automatically.

5. **Multi-Project Support**: Each unique path gets its own dedicated terminal session:
   ```json
   // Project A session
   {"tool": "focus_terminal", "session_root_path": "/Users/myuser/projects/project-a"}
   
   // Project B session  
   {"tool": "focus_terminal", "session_root_path": "/Users/myuser/projects/project-b"}
   
   // Project C session
   {"tool": "focus_terminal", "session_root_path": "/Users/myuser/projects/project-c"}
   ```

## Implementation Details

- **Client ID Generation**: Uses MD5 hash of normalized path for consistent identification
- **Path Association**: Associates sessions with directory paths for tracking (no automatic cd)
- **Session Validation**: Checks if iTerm2 windows still exist before focusing
- **Fallback Mechanism**: Falls back to active window if session creation fails

## Example Workflow

1. **First Call**: `focus_terminal` with `/Users/myuser/projects/my-app`
   - Creates new iTerm2 window
   - Associates window with `/Users/myuser/projects/my-app` path
   - Returns window ID and focuses it

2. **Subsequent Calls**: Same path
   - Validates existing window still exists
   - Focuses the existing window (no new window created)

3. **Different Path**: `focus_terminal` with `/Users/myuser/projects/other-app`
   - Creates separate iTerm2 window for the new project
   - Both sessions remain independent and accessible

This enhancement transforms the terminal from a single shared instance into an intelligent project-aware session manager.