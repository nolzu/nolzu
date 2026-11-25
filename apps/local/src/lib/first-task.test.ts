import { describe, expect, it } from 'vitest';
import { nextKeys } from './first-task.ts';

describe('the keys the first task screen shows', () => {
  it('gives the next three keys from the number the counter gives next', () => {
    expect(nextKeys('RECI', 1)).toEqual(['RECI-1', 'RECI-2', 'RECI-3']);
    expect(nextKeys('APP', 7)).toEqual(['APP-7', 'APP-8', 'APP-9']);
  });
});
