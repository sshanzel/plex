const TRIVIAL =
  /^(lgtm|nit|ship\s*it|done|thanks?|ty|\+1|👍|🚀|💯|nice|good catch|same|agreed?|ok(ay)?|sounds good|wfm)\b/i;

/** Keep substantive review comments, drop the noise (LGTM, one-word approvals, emoji). */
export function isSubstantive(body: string): boolean {
  const t = body.trim();
  if (t.length < 15) return false;
  if (TRIVIAL.test(t)) return false;
  if (t.split(/\s+/).length < 3) return false;
  return true;
}

const CATEGORIES: [string, RegExp][] = [
  ['security', /\b(auth|token|secret|password|inject|xss|csrf|sql|sanitiz|escap|vulnerab|permission|tenant|acl)\b/i],
  ['performance', /\b(perf|slow|n\+1|memo|cache|index(es|ing)?|throttle|debounce|bottleneck|latency|allocat)\b/i],
  ['error-handling', /\b(error|catch|throw|reject|unhandled|null|undefined|exception|fallback|retry|swallow)\b/i],
  ['concurrency', /\b(race condition|deadlock|mutex|atomic|concurren|lock\b)/i],
  ['testing', /\b(test|spec|mock|coverage|assert|flaky|fixture)\b/i],
  ['types', /\b(type|: any\b|generic|interface|cast|enum|nullable)\b/i],
  ['api-design', /\b(api|endpoint|contract|response|status code|payload|dto|schema|naming)\b/i],
];

/** Coarse category from comment text (seeds the pitfall's category). */
export function categorize(text: string): string {
  for (const [name, re] of CATEGORIES) if (re.test(text)) return name;
  return 'general';
}
