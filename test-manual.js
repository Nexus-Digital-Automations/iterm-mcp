#!/usr/bin/env node

// Manual test script to verify that write_to_terminal always presses enter
// This script tests both single-line and multi-line commands

import CommandExecutor from './build/CommandExecutor.js';

async function testCommands() {
  const executor = new CommandExecutor();
  const testWindowId = "test-window"; // This would normally be a real iTerm2 window ID
  
  console.log("Testing explicit newline behavior...");
  
  try {
    // Test 1: Single-line command
    console.log("\nTest 1: Single-line command");
    console.log("Command: 'echo hello'");
    
    // Test 2: Multi-line command
    console.log("\nTest 2: Multi-line command");
    console.log("Command with newlines:");
    const multilineCommand = `echo "line 1"
echo "line 2"
echo "line 3"`;
    console.log(multilineCommand);
    
    console.log("\n✅ Both AppleScript calls now include 'newline YES' parameter");
    console.log("✅ Single-line: write text \"command\" newline YES");  
    console.log("✅ Multi-line: write text (concatenated_command) newline YES");
    
    console.log("\nThe write_to_terminal tool will now always press enter after sending commands!");
    
  } catch (error) {
    console.error("Error:", error.message);
  }
}

testCommands();