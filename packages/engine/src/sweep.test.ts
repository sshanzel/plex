import { describe, it, expect } from 'vitest';
import { headAdvanced, isDebounced, jobDue } from './sweep';
import { CLOSED_TARGET, isDeadTarget } from './sweep-helpers';

// Pure decision helpers of the maintenance worker (ADR-43). The jobs themselves open Kùzu/git and are
// covered by the integration scenario + the node E2E; these pin the idempotency-critical gates that
// keep a sweep from re-doing work (and so from duplicating incidents).

describe('headAdvanced — the per-target reconcile cursor (no-op when head unchanged)', () => {
  it('is true on the first sweep (no cursor yet)', () => {
    expect(headAdvanced(undefined, 'abc')).toBe(true);
  });
  it('is false when the head equals the cursor (already swept this head → skip)', () => {
    expect(headAdvanced('abc', 'abc')).toBe(false);
  });
  it('is true when the head moved past the cursor', () => {
    expect(headAdvanced('abc', 'def')).toBe(true);
  });
  it('is false when the head cannot be resolved (nothing to do)', () => {
    expect(headAdvanced('abc', undefined)).toBe(false);
    expect(headAdvanced(undefined, undefined)).toBe(false);
  });
});

describe('isDeadTarget — a closed PR is skipped before the gh probe (no forever-reshell)', () => {
  it('is true only for the CLOSED_TARGET sentinel cursor', () => {
    expect(isDeadTarget(CLOSED_TARGET)).toBe(true);
    expect(isDeadTarget('abc123')).toBe(false); // a normal sha cursor
    expect(isDeadTarget(undefined)).toBe(false); // never swept yet
  });
  it('the sentinel never reads as head-advanced (so a dead target stays dead)', () => {
    // A closed PR resolves head '' → headAdvanced false; the sentinel guard skips it earlier anyway.
    expect(headAdvanced(CLOSED_TARGET, '')).toBe(false);
  });
});

describe('isDebounced — at most one sweep per interval per data dir', () => {
  const NOW = 1_000_000;
  const TEN_MIN = 10 * 60 * 1000;
  it('is not debounced when there is no marker yet', () => {
    expect(isDebounced(undefined, NOW, TEN_MIN)).toBe(false);
  });
  it('debounces (skips) when the marker is younger than the interval', () => {
    expect(isDebounced(NOW - 60_000, NOW, TEN_MIN)).toBe(true);
  });
  it('does not debounce once the interval has elapsed', () => {
    expect(isDebounced(NOW - TEN_MIN - 1, NOW, TEN_MIN)).toBe(false);
    expect(isDebounced(NOW - TEN_MIN, NOW, TEN_MIN)).toBe(false); // exactly elapsed → run
  });
});

describe('jobDue — cadence gate for the cheap/heavy periodic jobs (consolidate, analyze)', () => {
  const NOW = Date.parse('2026-06-01T12:00:00.000Z');
  const SIX_H = 6 * 60 * 60 * 1000;
  it('is due when it has never run', () => {
    expect(jobDue(undefined, NOW, SIX_H)).toBe(true);
  });
  it('is due when it ran longer ago than the interval', () => {
    expect(jobDue(new Date(NOW - SIX_H - 1).toISOString(), NOW, SIX_H)).toBe(true);
  });
  it('is NOT due when it ran within the interval (idempotency — no thrashing)', () => {
    expect(jobDue(new Date(NOW - 60_000).toISOString(), NOW, SIX_H)).toBe(false);
  });
  it('is due when the stored timestamp is unparseable (fail toward running once)', () => {
    expect(jobDue('not-a-date', NOW, SIX_H)).toBe(true);
  });
});
