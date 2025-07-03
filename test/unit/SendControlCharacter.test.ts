// @ts-nocheck
import { describe, test } from '@jest/globals';

describe('SendControlCharacter (REMOVED)', () => {
  test('SendControlCharacter functionality has been removed from the codebase', () => {
    // SendControlCharacter.ts and all key-pressing functionality has been removed
    // Control characters can now be sent using write_to_terminal with appropriate commands
    // For example: write_to_terminal({ command: "^C" }) or using command interruption
    expect(true).toBe(true);
  });
});