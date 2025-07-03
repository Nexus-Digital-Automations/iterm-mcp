#!/usr/bin/env node

// Demo script to test the new KeySender functionality
import KeySender from './build/KeySender.js';

async function demonstrateKeystrokes() {
  const keySender = new KeySender();
  
  console.log('🎹 KeySender Demonstration\n');
  
  // This would normally target an actual iTerm2 window
  // For demo purposes, we'll just show what keys are supported
  
  console.log('📋 Supported Keys:');
  const supportedKeys = KeySender.getSupportedKeys();
  console.log(`  Arrow Keys: ${supportedKeys.filter(k => ['up', 'down', 'left', 'right'].includes(k)).join(', ')}`);
  console.log(`  Function Keys: ${supportedKeys.filter(k => k.startsWith('f')).slice(0, 12).join(', ')}`);
  console.log(`  Navigation: ${supportedKeys.filter(k => ['home', 'end', 'pageup', 'pagedown'].includes(k)).join(', ')}`);
  console.log(`  Letters: ${supportedKeys.filter(k => /^[a-z]$/.test(k)).join(', ')}`);
  
  console.log('\n🔧 Supported Modifiers:');
  const modifiers = KeySender.getSupportedModifiers();
  console.log(`  ${modifiers.join(', ')}`);
  
  console.log('\n🤖 Claude Code Patterns:');
  const patterns = KeySender.getAvailablePatterns();
  console.log(`  ${patterns.join(', ')}`);
  
  console.log('\n✨ Example Usage:');
  console.log('  • Dropdown navigation: send_key_sequence(["down", "down", "enter"])');
  console.log('  • Claude Code plan mode: send_keystroke("shift+tab") (twice)');
  console.log('  • File inclusion: claude_code_include_file("src/app.js")');
  console.log('  • Command execution: claude_code_action("clear_conversation")');
  console.log('  • Complex shortcuts: send_keystroke("cmd+shift+p")');
  console.log('  • Text typing: type_text("hello world")');
  
  console.log('\n🎮 Dropdown Menu Examples:');
  console.log('  1. Basic navigation: ["down", "down", "enter"]');
  console.log('  2. With escape: ["down", "down", "escape"]');
  console.log('  3. With delays: [{"key": "down", "delay": 100}, "enter"]');
  
  console.log('\n🚀 Your iTerm MCP server now supports COMPLETE keyboard control!');
  console.log('   All keys, modifiers, sequences, and Claude Code interactions are available.');
}

demonstrateKeystrokes().catch(console.error);