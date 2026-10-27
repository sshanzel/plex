import { describe, it, expect } from 'vitest';
import { RepoBusyError } from '@plex/core';
import { failureResponse } from './server';

describe('failureResponse', () => {
  it('a busy repo is a retryable 503', () => {
    expect(failureResponse(new RepoBusyError('/repos/app'))).toEqual({
      status: 503,
      body: { error: 'repo busy — a review is using it; retry', retry: true },
    });
  });

  it('any other error is a generic 500 that leaks neither message nor stack', () => {
    const err = new Error('ENOENT: /Users/someone/.plex/repos/abc/graph.kuzu');
    const failure = failureResponse(err);
    const payload = JSON.stringify(failure.body);
    expect(failure.status).toBe(500);
    expect(payload).not.toContain('/Users/someone');
    expect(payload).not.toContain('ENOENT');
    expect(payload).not.toContain('server.test.ts');
  });

  it('a thrown non-Error value is not echoed back either', () => {
    const failure = failureResponse('secret-token-123');
    expect(failure.status).toBe(500);
    expect(JSON.stringify(failure.body)).not.toContain('secret-token-123');
  });
});
